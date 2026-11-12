const fs = require('fs');
const path = require('path');
const child_process = require('child_process');
const crypto = require('crypto');
const { normalizeText } = require('./runtime/translator');

const DICTS_DIR = path.join(__dirname, '..', 'dicts');
const STATE_PATH = path.join(DICTS_DIR, 'state.json');
const DICT_FILES = ['menus.json', 'agents.json', 'common.json'];

const SIGNATURE_START = '/* --- ANTIGRAVITY CHINESE LOCALIZATION START --- */';
const SIGNATURE_END = '/* --- ANTIGRAVITY CHINESE LOCALIZATION END --- */';

function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const PATCH_BLOCK_RE = new RegExp(
    escapeRegExp(SIGNATURE_START) + '[\\s\\S]*?' + escapeRegExp(SIGNATURE_END) + '\\r?\\n?',
    'g'
);

function cleanInjectedPatches(content) {
    return content ? String(content).replace(PATCH_BLOCK_RE, '') : '';
}

function getFileHash(filePath) {
    if (!fs.existsSync(filePath)) return null;
    try { return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'); } catch (e) { return null; }
}

function loadState() {
    if (fs.existsSync(STATE_PATH)) {
        try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')); } catch (e) {}
    }
    return {};
}

function saveState(state) {
    try {
        if (!fs.existsSync(DICTS_DIR)) fs.mkdirSync(DICTS_DIR, { recursive: true });
        fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 4), 'utf-8');
    } catch (e) {}
}

function readAsarPackageVersion(asarPath) {
    if (!asarPath || !fs.existsSync(asarPath)) return null;
    try {
        const buf = fs.readFileSync(asarPath);
        if (buf.length < 16) return null;
        const headerPickleSize = buf.readUInt32LE(4);
        const jsonLen = buf.readUInt32LE(12);
        const header = JSON.parse(buf.toString('utf8', 16, 16 + jsonLen));
        const pkg = header && header.files && header.files['package.json'];
        if (!pkg || pkg.unpacked || pkg.offset === undefined) return null;
        const off = 8 + headerPickleSize + Number(pkg.offset);
        return JSON.parse(buf.toString('utf8', off, off + pkg.size)).version || null;
    } catch (e) { return null; }
}

function getTargetVersion(state, resourcesDir) {
    const dir = typeof state === 'string' ? state : resourcesDir;
    const asarVer = dir ? readAsarPackageVersion(path.join(dir, 'app.asar')) : null;
    if (asarVer) return asarVer;
    const s = (typeof state === 'object' && state) ? state : loadState();
    return (s && s.targetVersion) || null;
}

function getDictsHash() {
    if (!fs.existsSync(DICTS_DIR)) return '';
    try {
        const hashSum = crypto.createHash('sha256');
        const tracked = [
            ...[...DICT_FILES, 'config.json', 'rules.json'].sort().map(f => [f, path.join(DICTS_DIR, f)]),
            ...['patcher.js', 'asar.js', 'utils.js', path.join('runtime', 'translator.js'), path.join('runtime', 'main.js'), path.join('runtime', 'dom.js')]
                .map(sf => [sf, path.join(__dirname, sf)])
        ];
        for (const [name, fullPath] of tracked) {
            if (fs.existsSync(fullPath)) { hashSum.update(name); hashSum.update(fs.readFileSync(fullPath, 'utf-8')); }
        }
        return hashSum.digest('hex');
    } catch (e) { return ''; }
}

function loadConfig() {
    const configPath = path.join(DICTS_DIR, 'config.json');
    if (!fs.existsSync(configPath)) throw new Error(`缺少核心配置文件: ${configPath}`);
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

function loadRules() {
    const rulesPath = path.join(DICTS_DIR, 'rules.json');
    if (!fs.existsSync(rulesPath)) return [];
    return JSON.parse(fs.readFileSync(rulesPath, 'utf-8'));
}

function loadDictionariesByFile() {
    const byFile = {};
    if (!fs.existsSync(DICTS_DIR)) return byFile;
    for (const file of DICT_FILES) {
        const fp = path.join(DICTS_DIR, file);
        if (!fs.existsSync(fp)) continue;
        const normMap = {};
        for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(fp, 'utf-8')))) {
            const nk = normalizeText(k);
            if (nk) normMap[nk] = v;
        }
        byFile[file] = normMap;
    }
    return byFile;
}

function loadDictionary() {
    const totalMap = {};
    for (const [file, normMap] of Object.entries(loadDictionariesByFile())) {
        for (const [normK, v] of Object.entries(normMap)) {
            if (totalMap[normK] && totalMap[normK] !== v) {
                console.warn(`[警告] 词条冲突: "${normK}" 在 ${file} 中的译文 "${v}" 覆盖了已有译文 "${totalMap[normK]}"`);
            }
            totalMap[normK] = v;
        }
    }
    return totalMap;
}

const ELECTRON_CHILD_RE = /^--type=(?:renderer|gpu-process|utility|crashpad-handler|broker|ppapi|zygote)(?=\s|$)/i;
const SIDECAR_MARKER_RE = /(?:^|[\\/"'\s=])(?:sidecar_sdk|register_loader\.(?:mjs|cjs|js)|chrome-devtools-mcp\.js)(?:[\\/"'\s]|$)/i;
const NODE_FLAGS = new Set(['--import', '--experimental-loader', '--loader', '--require', '-r', '--eval', '-e', '--print', '-p', '--check', '-c', '--input-type', '--env-file', '--experimental-strip-types']);

const sleepSync = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) {} };
const isPidAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function getExpectedExeSet(targetDir) {
    const exes = new Set();
    if (!targetDir || typeof targetDir !== 'string') return exes;
    const resolved = path.win32.resolve(targetDir);
    const rootDir = path.win32.basename(resolved).toLowerCase() === 'resources' ? path.win32.dirname(resolved) : resolved;
    exes.add(path.win32.join(rootDir, 'Antigravity.exe').toLowerCase());
    try { if (fs.existsSync(rootDir)) exes.add(path.win32.join(path.win32.resolve(fs.realpathSync.native(rootDir)), 'Antigravity.exe').toLowerCase()); } catch (e) {}
    return exes;
}

function extractArgsTail(commandLine, exePath) {
    const trimmed = commandLine.trim();
    if (!trimmed) return '';
    if (trimmed[0] === '"') {
        const end = trimmed.indexOf('"', 1);
        if (end !== -1) return trimmed.slice(end + 1).trim();
    }
    if (exePath && trimmed.toLowerCase().startsWith(exePath.toLowerCase()) && (!trimmed[exePath.length] || /\s/.test(trimmed[exePath.length]))) {
        return trimmed.slice(exePath.length).trim();
    }
    const m = trimmed.match(/^.+?\.exe(?=\s|$)(?:\s+([\s\S]*))?$/i) || trimmed.match(/^\S+(?:\s+([\s\S]*))?$/);
    return m && m[1] ? m[1].trim() : '';
}

function isNodeSidecarArgs(argsTail) {
    if (SIDECAR_MARKER_RE.test(argsTail)) return true;
    for (const m of argsTail.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
        const tok = m[1] ?? m[2] ?? m[3];
        if (!tok) continue;
        const eqIdx = tok.indexOf('=');
        if (NODE_FLAGS.has(eqIdx > 0 ? tok.slice(0, eqIdx) : tok)) return true;
        if (tok[0] === '-' || tok[0] === '/' || tok.includes('://')) continue;
        return /\.(?:mjs|cjs|js)$/i.test(tok);
    }
    return false;
}

function filterBlockingAntigravity(processes, targetDir) {
    const expectedExes = getExpectedExeSet(targetDir);
    const result = [];
    for (const proc of processes || []) {
        const pid = Number(proc && (proc.pid ?? proc.ProcessId));
        if (!Number.isInteger(pid) || pid <= 0) continue;
        const exePath = proc.executablePath ?? proc.ExecutablePath ?? null;
        const name = String(proc.name || proc.Name || (exePath ? path.win32.basename(String(exePath)) : '')).toLowerCase();
        if (name && name !== 'antigravity.exe') continue;
        if (expectedExes.size > 0 && exePath && !expectedExes.has(path.win32.resolve(String(exePath)).toLowerCase())) continue;
        const cmdLine = proc.commandLine ?? proc.CommandLine;
        if (cmdLine == null) { result.push({ pid, isMain: true }); continue; }
        const argsTail = extractArgsTail(String(cmdLine), exePath ? String(exePath) : null);
        if (ELECTRON_CHILD_RE.test(argsTail)) result.push({ pid, isMain: false });
        else if (argsTail === '' || !isNodeSidecarArgs(argsTail)) result.push({ pid, isMain: true });
    }
    return result;
}

function listBlockingAntigravity(targetDir) {
    const ps = "$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;@(Get-CimInstance Win32_Process -Filter \"Name='Antigravity.exe'\"|Select-Object ProcessId,ExecutablePath,CommandLine)|ConvertTo-Json -Compress";
    try {
        const out = child_process.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 }).trim();
        if (!out) return [];
        const parsed = JSON.parse(out);
        return filterBlockingAntigravity(Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? [parsed] : []), targetDir);
    } catch (e) {}
    try {
        const csv = child_process.execFileSync('tasklist', ['/nh', '/fo', 'csv', '/fi', 'IMAGENAME eq Antigravity.exe'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
        return [...csv.matchAll(/^"Antigravity\.exe","(\d+)"/gim)].map(m => ({ pid: Number(m[1]), isMain: true }));
    } catch (e) { return []; }
}

function closeAntigravityProcesses(targetDir) {
    let blocking = listBlockingAntigravity(targetDir);
    if (blocking.length === 0) return 'idle';
    console.log('[进程] 检测到客户端正在运行，正在请求安全退出以保存会话数据...');
    for (const pid of new Set(blocking.filter(p => p.isMain).map(p => p.pid))) {
        try { child_process.execFileSync('taskkill', ['/pid', String(pid)], { stdio: 'ignore', timeout: 5000 }); } catch (e) {}
    }
    const waitUntilExit = (ms, onProgress) => {
        const start = Date.now();
        let lastProgress = start;
        while (Date.now() - start < ms) {
            sleepSync(400);
            blocking = blocking.filter(p => isPidAlive(p.pid));
            if (blocking.length === 0) {
                sleepSync(200);
                blocking = listBlockingAntigravity(targetDir);
                if (blocking.length === 0) return true;
            }
            if (onProgress && Date.now() - lastProgress >= 30000) {
                lastProgress = Date.now();
                onProgress(blocking, Math.floor((Date.now() - start) / 1000));
            }
        }
        return false;
    };
    const pids = list => list.map(p => p.pid).join(', ');
    if (waitUntilExit(8000)) return 'stopped';
    console.log(`[等待] 客户端仍在运行（为避免会话数据库损坏，已禁用强制终止进程）。阻塞 PID: ${pids(blocking)}。请手动关闭 Antigravity（含系统托盘图标）后自动继续...`);
    if (waitUntilExit(120000, (cur, sec) => console.log(`[等待] 仍在等待客户端退出（已等待 ${sec}s，阻塞 PID: ${pids(cur)}）...`))) return 'stopped';
    console.error(`[错误] 等待客户端退出超时，已中止本次操作（阻塞 PID: ${pids(blocking)}）。`);
    return false;
}

function detectInstallationDir(manualDir) {
    if (manualDir) {
        if (!fs.existsSync(manualDir)) return null;
        const resolved = path.resolve(manualDir);
        return (fs.statSync(resolved).isFile() && resolved.endsWith('app.asar')) ? path.dirname(resolved) : resolved;
    }
    const candidates = [], seen = new Set();
    const add = c => {
        if (!c) return;
        const norm = path.resolve(c), key = norm.toLowerCase();
        if (!seen.has(key)) { candidates.push(norm); seen.add(key); }
    };
    add(process.env.ANTIGRAVITY_INSTALL_DIR);
    add(process.env.ANTIGRAVITY_HOME);
    for (const root of ['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall']) {
        try {
            const output = child_process.execSync(`reg query "${root}" /s /f Antigravity /d`, { encoding: 'utf-8', stdio: 'pipe' });
            for (const line of output.split(/\r?\n/)) {
                const m = line.match(/^\s*(InstallLocation|DisplayIcon)\s+REG_\w+\s+(.+)$/i);
                if (!m) continue;
                const val = m[2].trim().replace(/^"|"$/g, '');
                add(/Antigravity\.exe/i.test(val) ? path.dirname(val) : val);
            }
        } catch (e) {}
    }
    for (const d of ['C', 'D', 'E', 'F']) { add(`${d}:\\Programs\\Antigravity`); add(`${d}:\\Antigravity`); }
    add('C:\\Program Files\\Antigravity');
    if (process.env.LOCALAPPDATA) add(path.join(process.env.LOCALAPPDATA, 'Programs', 'antigravity'));
    return candidates.find(p => fs.existsSync(p) && (fs.existsSync(path.join(p, 'resources', 'app.asar')) || fs.existsSync(path.join(p, 'app.asar')))) || null;
}

function getResourcesDir(manualDir) {
    const installDir = detectInstallationDir(manualDir);
    if (!installDir) return null;
    const resDir = path.join(installDir, 'resources');
    if (fs.existsSync(path.join(resDir, 'app.asar'))) return resDir;
    return fs.existsSync(path.join(installDir, 'app.asar')) ? installDir : resDir;
}

function isInvokedByClient() {
    return !!(process.env.ANTIGRAVITY_AGENT || process.env.ANTIGRAVITY_PROJECT_ID || process.env.ANTIGRAVITY_TRAJECTORY_ID);
}

function naturalCompare(a, b) {
    const key = s => (s.replace(/^[^a-zA-Z0-9]+/, '') || s).toLowerCase();
    const cmp = key(a).localeCompare(key(b), 'en', { numeric: true, sensitivity: 'base' });
    if (cmp !== 0) return cmp;
    return a.toLowerCase().localeCompare(b.toLowerCase(), 'en', { numeric: true }) || a.localeCompare(b);
}

module.exports = {
    SIGNATURE_START, SIGNATURE_END, cleanInjectedPatches,
    DICTS_DIR, DICT_FILES,
    getFileHash, loadState, saveState, getTargetVersion, getDictsHash,
    normalizeText, loadConfig, loadRules, loadDictionariesByFile, loadDictionary,
    closeAntigravityProcesses, filterBlockingAntigravity, detectInstallationDir,
    getResourcesDir, isInvokedByClient, naturalCompare
};
