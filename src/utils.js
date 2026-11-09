const fs = require('fs');
const path = require('path');
const child_process = require('child_process');
const crypto = require('crypto');
const { normalizeText } = require('./runtime/translator');

const DICTS_DIR = path.join(__dirname, '..', 'dicts');
const STATE_PATH = path.join(DICTS_DIR, 'state.json');

const DICT_FILES = [
    'common.json',
    'menus.json',
    'agents.json',
    'knowledge.json',
    'marketplace.json',
    'settings.json',
    'workspaces.json'
];

const SIGNATURE_START = "/* --- ANTIGRAVITY CHINESE LOCALIZATION START --- */";
const SIGNATURE_END = "/* --- ANTIGRAVITY CHINESE LOCALIZATION END --- */";

const CONFIG_SCHEMA = {
    blockedTags: 'array',
    blockedClasses: 'array',
    blockedClassSubstrings: 'array',
    blockedTestIds: 'array',
    blockedTestIdSubstrings: 'array',
    blockedDataAttrs: 'array',
    bypassClasses: 'array',
    bypassRoles: 'array',
    protectedFiles: 'array',
    codeEditorKeywords: 'array',
    lowerWordsExclude: 'array',
    conversationRowAllowedTexts: 'array',
    toolStatVerbs: 'object',
    toolStatNouns: 'object',
    fragmentPatterns: 'array'
};

function validateConfigSchema(cfg) {
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
        throw new Error('dicts/config.json 必须为 JSON 对象');
    }
    for (const key of Object.keys(cfg)) {
        const expected = CONFIG_SCHEMA[key];
        if (!expected) {
            throw new Error(`dicts/config.json 包含未知配置键: "${key}"`);
        }
        const val = cfg[key];
        const actual = Array.isArray(val) ? 'array' : typeof val;
        if (actual !== expected) {
            throw new Error(`dicts/config.json 配置键 "${key}" 类型错误: 期望 ${expected}，实际为 ${actual}`);
        }
    }
    return cfg;
}

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getFileHash(filePath) {
    if (!fs.existsSync(filePath)) return null;
    try {
        const fileBuffer = fs.readFileSync(filePath);
        return crypto.createHash('sha256').update(fileBuffer).digest('hex');
    } catch (e) {
        return null;
    }
}

function loadState() {
    if (fs.existsSync(STATE_PATH)) {
        try {
            return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
        } catch (e) {}
    }
    return {};
}

function saveState(state) {
    try {
        if (!fs.existsSync(DICTS_DIR)) {
            fs.mkdirSync(DICTS_DIR, { recursive: true });
        }
        fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 4), 'utf-8');
    } catch (e) {}
}

function getTargetVersion(state) {
    const s = state || loadState();
    if (s && s.targetVersion) return s.targetVersion;
    const snapPkgPath = path.join(__dirname, '..', '_inspect_app', 'package.json');
    if (fs.existsSync(snapPkgPath)) {
        try {
            return JSON.parse(fs.readFileSync(snapPkgPath, 'utf-8')).version || null;
        } catch (e) {}
    }
    return null;
}

function getDictsHash() {
    if (!fs.existsSync(DICTS_DIR)) return "";
    try {
        const hashSum = crypto.createHash('sha256');
        const trackedDictFiles = [...DICT_FILES, 'config.json', 'rules.json'].sort();
        for (const file of trackedDictFiles) {
            const fp = path.join(DICTS_DIR, file);
            if (fs.existsSync(fp)) {
                hashSum.update(file);
                hashSum.update(fs.readFileSync(fp, 'utf-8'));
            }
        }
        const srcFiles = [
            'patcher.js',
            'asar.js',
            'utils.js',
            path.join('runtime', 'translator.js'),
            path.join('runtime', 'main.js'),
            path.join('runtime', 'dom.js')
        ];
        for (const sf of srcFiles) {
            const sp = path.join(__dirname, sf);
            if (fs.existsSync(sp)) {
                hashSum.update(sf);
                hashSum.update(fs.readFileSync(sp, 'utf-8'));
            }
        }
        return hashSum.digest('hex');
    } catch (e) {
        return "";
    }
}

function loadConfig() {
    const configPath = path.join(DICTS_DIR, 'config.json');
    if (!fs.existsSync(configPath)) {
        throw new Error(`缺少核心配置文件: ${configPath}`);
    }
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return validateConfigSchema(raw);
}

function loadRules() {
    const rulesPath = path.join(DICTS_DIR, 'rules.json');
    if (fs.existsSync(rulesPath)) {
        try {
            return JSON.parse(fs.readFileSync(rulesPath, 'utf-8'));
        } catch (e) {}
    }
    return [];
}

function loadDictionary() {
    const totalMap = {};
    if (fs.existsSync(DICTS_DIR)) {
        for (const file of DICT_FILES) {
            const dictPath = path.join(DICTS_DIR, file);
            if (!fs.existsSync(dictPath)) continue;
            try {
                const data = JSON.parse(fs.readFileSync(dictPath, 'utf-8'));
                for (const [k, v] of Object.entries(data)) {
                    const normK = normalizeText(k);
                    if (!normK) continue;
                    if (totalMap[normK] && totalMap[normK] !== v) {
                        console.warn(`\x1b[33m[警告] 词条冲突: "${normK}" 在 ${file} 中的译文 "${v}" 覆盖了已有译文 "${totalMap[normK]}"\x1b[0m`);
                    }
                    totalMap[normK] = v;
                }
            } catch (e) {}
        }
    }
    return totalMap;
}

function sleepSync(ms) {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) {}
}

function isAppRunning() {
    try {
        const out = child_process.execSync('tasklist /nh', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        return /^\s*"?(?:antigravity|language_server)\.exe"?\b/im.test(out);
    } catch (e) {
        return false;
    }
}

function closeAntigravityProcesses() {
    if (!isAppRunning()) return true;
    console.log("[进程] 检测到客户端正在运行，正在请求安全退出以保存会话数据...");
    try { child_process.execSync('taskkill /im Antigravity.exe >nul 2>nul'); } catch (e) {}

    const waitUntilExit = (timeoutMs) => {
        const end = Date.now() + timeoutMs;
        while (Date.now() < end) {
            sleepSync(250);
            if (!isAppRunning()) {
                sleepSync(200);
                return true;
            }
        }
        return false;
    };

    if (waitUntilExit(6000)) return true;

    try { child_process.execSync('taskkill /im language_server.exe >nul 2>nul'); } catch (e) {}
    if (waitUntilExit(2000)) return true;

    console.log("\x1b[33m[等待] 客户端仍在运行（为避免会话数据库损坏，已禁用强制终止进程）。请手动关闭 Antigravity（含系统托盘图标）后自动继续...\x1b[0m");
    if (waitUntilExit(120000)) return true;

    console.error("\x1b[31m[错误] 等待客户端退出超时，已中止本次操作。\x1b[0m");
    return false;
}

function detectInstallationDir(manualDir) {
    if (manualDir) {
        if (fs.existsSync(manualDir)) {
            let resolved = path.resolve(manualDir);
            if (fs.statSync(resolved).isFile() && resolved.endsWith('app.asar')) {
                resolved = path.dirname(resolved);
            }
            return resolved;
        }
        return null;
    }

    const candidates = [];
    const seenCandidates = new Set();
    const addCandidate = (candidate) => {
        if (!candidate) return;
        const normalized = path.resolve(candidate);
        const key = normalized.toLowerCase();
        if (!seenCandidates.has(key)) {
            candidates.push(normalized);
            seenCandidates.add(key);
        }
    };
    const hasAntigravityResources = (candidate) => {
        return fs.existsSync(path.join(candidate, "resources", "app.asar")) ||
            fs.existsSync(path.join(candidate, "app.asar"));
    };

    addCandidate(process.env.ANTIGRAVITY_INSTALL_DIR);
    addCandidate(process.env.ANTIGRAVITY_HOME);

    const registryRoots = [
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
        'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
        'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
    ];
    for (const root of registryRoots) {
        try {
            const output = child_process.execSync(`reg query "${root}" /s /f Antigravity /d`, { encoding: 'utf-8', stdio: 'pipe' });
            for (const line of output.split(/\r?\n/)) {
                const match = line.match(/^\s*(InstallLocation|DisplayIcon)\s+REG_\w+\s+(.+)$/i);
                if (!match) continue;
                let value = match[2].trim().replace(/^"|"$/g, '');
                if (/Antigravity\.exe/i.test(value)) value = path.dirname(value);
                addCandidate(value);
            }
        } catch (e) {}
    }

    for (const drive of ['C', 'D', 'E', 'F']) {
        addCandidate(`${drive}:\\Programs\\Antigravity`);
        addCandidate(`${drive}:\\Antigravity`);
    }
    addCandidate("C:\\Program Files\\Antigravity");
    if (process.env.LOCALAPPDATA) {
        addCandidate(path.join(process.env.LOCALAPPDATA, 'Programs', 'antigravity'));
    }

    for (const p of candidates) {
        if (fs.existsSync(p) && hasAntigravityResources(p)) {
            return path.resolve(p);
        }
    }
    return null;
}

function getResourcesDir(manualDir) {
    const installDir = detectInstallationDir(manualDir);
    if (!installDir) return null;
    const resourcesCandidate = path.join(installDir, "resources");
    if (fs.existsSync(path.join(resourcesCandidate, "app.asar"))) return resourcesCandidate;
    if (fs.existsSync(path.join(installDir, "app.asar"))) return installDir;
    return resourcesCandidate;
}

function isInvokedByClient() {
    return !!(process.env.ANTIGRAVITY_AGENT || process.env.ANTIGRAVITY_PROJECT_ID || process.env.ANTIGRAVITY_TRAJECTORY_ID);
}

function getSortKey(str) {
    const stripped = str.replace(/^[^a-zA-Z0-9]+/, '');
    return (stripped || str).toLowerCase();
}

function naturalCompare(a, b) {
    const keyA = getSortKey(a);
    const keyB = getSortKey(b);
    const cmp = keyA.localeCompare(keyB, 'en', { numeric: true, sensitivity: 'base' });
    if (cmp !== 0) return cmp;
    const cmpFullLower = a.toLowerCase().localeCompare(b.toLowerCase(), 'en', { numeric: true });
    if (cmpFullLower !== 0) return cmpFullLower;
    return a.localeCompare(b);
}

module.exports = {
    SIGNATURE_START,
    SIGNATURE_END,
    DICTS_DIR,
    STATE_PATH,
    DICT_FILES,
    validateConfigSchema,
    escapeRegExp,
    getFileHash,
    loadState,
    saveState,
    getTargetVersion,
    getDictsHash,
    normalizeText,
    loadConfig,
    loadRules,
    loadDictionary,
    isAppRunning,
    closeAntigravityProcesses,
    detectInstallationDir,
    getResourcesDir,
    isInvokedByClient,
    naturalCompare
};
