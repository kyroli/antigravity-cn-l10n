const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const child_process = require('child_process');

const ROOT_DIR = path.join(__dirname, '..');
const REPO = 'kyroli/antigravity-cn-l10n';
const BRANCH = 'main';
const RAW_ORIGIN = `https://raw.githubusercontent.com/${REPO}`;
const INFO_REFS_URL = `https://github.com/${REPO}.git/info/refs?service=git-upload-pack`;
const MANIFEST_FILE = 'manifest.json';

const STATIC_MANAGED_FILES = [
    'package.json',
    'patch.js',
    'Antigravity-L10n.bat',
    'Antigravity-Restore.bat',
    'src/asar.js',
    'src/patcher.js',
    'src/updater.js',
    'src/utils.js'
];

const CRLF_PATH_RE = /^(?:dicts\/.*\.json|.*\.bat)$/;
const REQUEST_TIMEOUT_MS = 8000;

const normalizeLf = text => String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');

function sha256Normalized(input) {
    const str = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
    return crypto.createHash('sha256').update(normalizeLf(str), 'utf8').digest('hex');
}

function formatOutputBuffer(relPath, utf8Text) {
    const lf = normalizeLf(utf8Text);
    const out = CRLF_PATH_RE.test(relPath) ? lf.replace(/\n/g, '\r\n') : lf;
    return Buffer.from(out, 'utf8');
}

function isSafeRelPath(relPath) {
    if (!relPath || path.isAbsolute(relPath)) return false;
    const normalized = relPath.replace(/\\/g, '/');
    return !normalized.split('/').includes('..') && normalized !== 'dicts/state.json';
}

function writeAtomicFile(targetPath, buf) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const tmp = `${targetPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buf);
    try {
        fs.renameSync(tmp, targetPath);
    } catch (e) {
        fs.rmSync(tmp, { force: true });
        throw e;
    }
}

function collectManagedFiles(rootDir = ROOT_DIR) {
    const files = new Set();
    for (const rel of STATIC_MANAGED_FILES) {
        if (fs.existsSync(path.join(rootDir, rel))) files.add(rel);
    }
    const scanSubdir = (subDir, filterFn) => {
        const absDir = path.join(rootDir, subDir);
        if (!fs.existsSync(absDir)) return;
        for (const ent of fs.readdirSync(absDir, { withFileTypes: true })) {
            if (ent.isFile() && filterFn(ent.name)) files.add(`${subDir}/${ent.name}`);
        }
    };
    scanSubdir('dicts', name => name.endsWith('.json') && name !== 'state.json');
    scanSubdir('src/runtime', name => name.endsWith('.js'));
    return Array.from(files).sort();
}

function readTargetVersion(rootDir = ROOT_DIR) {
    const pkgPath = path.join(rootDir, 'package.json');
    if (!fs.existsSync(pkgPath)) return '';
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).targetVersion || '';
}

function buildManifest(rootDir = ROOT_DIR) {
    const files = {};
    for (const rel of collectManagedFiles(rootDir)) {
        const normalized = normalizeLf(fs.readFileSync(path.join(rootDir, rel), 'utf8'));
        files[rel] = {
            sha256: sha256Normalized(normalized),
            size: Buffer.byteLength(normalized, 'utf8')
        };
    }
    const targetVersion = readTargetVersion(rootDir);
    const revision = crypto.createHash('sha256')
        .update(JSON.stringify({ targetVersion, files }), 'utf8')
        .digest('hex')
        .slice(0, 12);

    return { schemaVersion: 1, repo: REPO, branch: BRANCH, targetVersion, revision, files };
}

function writeManifest(rootDir = ROOT_DIR) {
    const manifestPath = path.join(rootDir, MANIFEST_FILE);
    const nextManifest = buildManifest(rootDir);
    if (fs.existsSync(manifestPath)) {
        const prev = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (prev.revision === nextManifest.revision && prev.targetVersion === nextManifest.targetVersion) {
            return { changed: false, manifest: prev, path: manifestPath };
        }
    }
    writeAtomicFile(manifestPath, Buffer.from(JSON.stringify(nextManifest, null, 2) + '\n', 'utf8'));
    return { changed: true, manifest: nextManifest, path: manifestPath };
}

function hasWindowsSystemProxy() {
    if (process.platform !== 'win32') return false;
    try {
        const out = child_process.execFileSync(
            'reg',
            ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyEnable'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }
        );
        return /ProxyEnable\s+REG_DWORD\s+0x1/i.test(out);
    } catch (e) {
        return false;
    }
}

function fetchViaNodeHttps(url, timeoutMs = REQUEST_TIMEOUT_MS, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: {
                'User-Agent': 'antigravity-cn-l10n-updater',
                'Cache-Control': 'no-cache'
            },
            timeout: timeoutMs
        }, res => {
            const status = res.statusCode || 0;
            if ([301, 302, 307, 308].includes(status) && res.headers.location && redirectsLeft > 0) {
                res.resume();
                fetchViaNodeHttps(new URL(res.headers.location, url).toString(), timeoutMs, redirectsLeft - 1).then(resolve, reject);
                return;
            }
            if (status < 200 || status >= 300) {
                res.resume();
                reject(new Error(`HTTP ${status}`));
                return;
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('请求超时')));
        req.on('error', reject);
    });
}

function fetchViaPowerShell(url, timeoutMs = REQUEST_TIMEOUT_MS) {
    const timeoutSec = Math.max(3, Math.ceil(timeoutMs / 1000));
    const script = [
        "$ProgressPreference = 'SilentlyContinue'",
        'try {',
        '  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12',
        '  Add-Type -AssemblyName System.Net.Http',
        '  $client = New-Object System.Net.Http.HttpClient',
        `  $client.Timeout = [TimeSpan]::FromSeconds(${timeoutSec})`,
        "  $client.DefaultRequestHeaders.TryAddWithoutValidation('User-Agent', 'antigravity-cn-l10n-updater') | Out-Null",
        "  $client.DefaultRequestHeaders.TryAddWithoutValidation('Cache-Control', 'no-cache') | Out-Null",
        `  $resp = $client.GetAsync('${url.replace(/'/g, "''")}').GetAwaiter().GetResult()`,
        '  if (-not $resp.IsSuccessStatusCode) { throw ("HTTP " + [int]$resp.StatusCode) }',
        '  $bytes = $resp.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()',
        '  [Console]::Out.Write([Convert]::ToBase64String($bytes))',
        '} catch {',
        '  [Console]::Error.WriteLine($_.Exception.Message)',
        '  exit 1',
        '}'
    ].join('; ');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    return new Promise((resolve, reject) => {
        child_process.execFile(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
            { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs + 4000 },
            (err, stdout) => {
                if (err) return reject(new Error(err.message));
                resolve(Buffer.from(stdout.trim(), 'base64').toString('utf8'));
            }
        );
    });
}

async function fetchUrlText(url, { usePowerShellFirst = false, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const fetchers = process.platform === 'win32'
        ? (usePowerShellFirst ? [fetchViaPowerShell, fetchViaNodeHttps] : [fetchViaNodeHttps, fetchViaPowerShell])
        : [fetchViaNodeHttps];

    let lastErr;
    for (const fn of fetchers) {
        try {
            return await fn(url, timeoutMs);
        } catch (e) {
            lastErr = e;
        }
    }
    throw lastErr;
}

function parseMainShaFromInfoRefs(pktText, branch = BRANCH) {
    const targetRef = `refs/heads/${branch}`;
    let pos = 0;
    while (pos + 4 <= pktText.length) {
        const lenHex = pktText.slice(pos, pos + 4);
        if (!/^[0-9a-f]{4}$/i.test(lenHex)) break;
        const len = parseInt(lenHex, 16);
        if (len === 0) { pos += 4; continue; }
        if (len < 4 || pos + len > pktText.length) break;
        const line = pktText.slice(pos + 4, pos + len).replace(/\r?\n$/, '').split('\0', 1)[0];
        pos += len;
        const spIdx = line.indexOf(' ');
        if (spIdx === 40 && line.slice(spIdx + 1) === targetRef && /^[0-9a-f]{40}$/i.test(line.slice(0, 40))) {
            return line.slice(0, 40);
        }
    }
    return null;
}

async function resolveRemoteRef({ usePowerShellFirst = false, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    try {
        const pktText = await fetchUrlText(INFO_REFS_URL, { usePowerShellFirst, timeoutMs });
        return parseMainShaFromInfoRefs(pktText, BRANCH) || BRANCH;
    } catch (e) {
        return BRANCH;
    }
}

function fetchRemoteText(relPath, { ref = BRANCH, usePowerShellFirst = false, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const encodedPath = relPath.split('/').map(encodeURIComponent).join('/');
    return fetchUrlText(`${RAW_ORIGIN}/${ref}/${encodedPath}`, { usePowerShellFirst, timeoutMs });
}

function validateRemoteFile(relPath, text, entry) {
    if (!isSafeRelPath(relPath)) {
        throw new Error(`拒绝写入非法路径: ${relPath}`);
    }
    if (sha256Normalized(text) !== String(entry?.sha256 || '').toLowerCase()) {
        throw new Error(`文件校验失败 (${relPath}): 哈希不匹配`);
    }
}

function readLocalManifest(rootDir = ROOT_DIR) {
    const fp = path.join(rootDir, MANIFEST_FILE);
    return fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, 'utf8')) : null;
}

function runGit(rootDir, args, timeoutMs = 15000) {
    return child_process.execFileSync('git', args, {
        cwd: rootDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs
    }).trim();
}

function syncWithGit(rootDir) {
    try {
        if (runGit(rootDir, ['status', '--porcelain'], 5000)) {
            console.log('[更新] 检测到本地 Git 工作区存在未提交修改，已跳过自动更新。');
            return { updated: false, reason: 'dirty-git' };
        }
        const beforeHead = runGit(rootDir, ['rev-parse', 'HEAD'], 5000);
        runGit(rootDir, ['pull', '--ff-only'], 15000);
        const afterHead = runGit(rootDir, ['rev-parse', 'HEAD'], 5000);
        if (beforeHead !== afterHead) {
            console.log(`[更新] 已通过 Git 同步最新内容 (${beforeHead.slice(0, 7)} -> ${afterHead.slice(0, 7)})。`);
            return { updated: true, reason: 'git-pull' };
        }
        console.log('[更新] 当前仓库已是最新版本。');
        return { updated: false, reason: 'up-to-date' };
    } catch (e) {
        console.warn(`[提示] Git 检查更新失败，将使用本地文件继续: ${e.message}`);
        return { updated: false, reason: 'git-failed' };
    }
}

function diffManifestFiles(rootDir, manifestFiles, prevManifest) {
    const toDownload = [];
    for (const [relPath, entry] of Object.entries(manifestFiles)) {
        if (!isSafeRelPath(relPath)) continue;
        const localPath = path.join(rootDir, relPath);
        if (!fs.existsSync(localPath) || sha256Normalized(fs.readFileSync(localPath)) !== String(entry.sha256 || '').toLowerCase()) {
            toDownload.push([relPath, entry]);
        }
    }
    const toRemove = Object.keys(prevManifest?.files || {}).filter(
        oldRel => isSafeRelPath(oldRel) && !Object.hasOwn(manifestFiles, oldRel) && fs.existsSync(path.join(rootDir, oldRel))
    );
    return { toDownload, toRemove };
}

async function syncWithManifest(rootDir = ROOT_DIR, { bootstrap = false, fetcher = fetchRemoteText } = {}) {
    const usePowerShellFirst = hasWindowsSystemProxy();
    const prevManifest = readLocalManifest(rootDir);
    const isDefaultFetcher = fetcher === fetchRemoteText;
    const remoteRef = isDefaultFetcher ? await resolveRemoteRef({ usePowerShellFirst }) : BRANCH;
    const isCommitSha = /^[0-9a-f]{40}$/i.test(remoteRef);

    if (isDefaultFetcher && isCommitSha && prevManifest?.remoteCommit === remoteRef) {
        const localDiff = diffManifestFiles(rootDir, prevManifest.files, prevManifest);
        if (localDiff.toDownload.length === 0 && localDiff.toRemove.length === 0) {
            const verLabel = prevManifest.targetVersion ? `适配 v${prevManifest.targetVersion}` : `版本 ${prevManifest.revision}`;
            console.log(`[更新] 当前汉化补丁已是最新版本（${verLabel}）。`);
            return { updated: false, failed: false, reason: 'up-to-date', manifest: prevManifest };
        }
    }

    try {
        const remoteManifest = JSON.parse(await fetcher(MANIFEST_FILE, { ref: remoteRef, usePowerShellFirst }));
        if (!remoteManifest?.files || typeof remoteManifest.files !== 'object' || Array.isArray(remoteManifest.files)) {
            throw new Error('manifest.json 格式无效');
        }

        const { toDownload, toRemove } = diffManifestFiles(rootDir, remoteManifest.files, prevManifest);
        const localManifest = isCommitSha ? { ...remoteManifest, remoteCommit: remoteRef } : remoteManifest;
        const verLabel = remoteManifest.targetVersion ? `适配 v${remoteManifest.targetVersion}` : `版本 ${remoteManifest.revision}`;

        if (toDownload.length === 0 && toRemove.length === 0) {
            if (prevManifest?.revision !== remoteManifest.revision || (isCommitSha && prevManifest?.remoteCommit !== remoteRef)) {
                writeAtomicFile(path.join(rootDir, MANIFEST_FILE), Buffer.from(JSON.stringify(localManifest, null, 2) + '\n', 'utf8'));
            }
            console.log(`[更新] 当前汉化补丁已是最新版本（${verLabel}）。`);
            return { updated: false, failed: false, reason: 'up-to-date', manifest: remoteManifest };
        }

        console.log(`[更新] 检测到云端更新（${verLabel}），正在拉取 ${toDownload.length} 个文件...`);
        const staged = [];
        for (const [relPath, entry] of toDownload) {
            const text = await fetcher(relPath, { ref: remoteRef, usePowerShellFirst });
            validateRemoteFile(relPath, text, entry);
            staged.push([relPath, formatOutputBuffer(relPath, text)]);
        }

        for (const [relPath, buf] of staged) {
            writeAtomicFile(path.join(rootDir, relPath), buf);
        }
        for (const oldRel of toRemove) {
            fs.rmSync(path.join(rootDir, oldRel), { force: true });
        }
        writeAtomicFile(path.join(rootDir, MANIFEST_FILE), Buffer.from(JSON.stringify(localManifest, null, 2) + '\n', 'utf8'));

        console.log(`[更新] 已更新 ${staged.length} 个文件${toRemove.length ? `，清理 ${toRemove.length} 个旧文件` : ''}（${verLabel}）。`);
        return { updated: true, failed: false, count: staged.length, manifest: remoteManifest };
    } catch (e) {
        const msg = `云端更新失败（${e.message}）`;
        if (bootstrap) {
            console.error(`[错误] ${msg}，无法继续部署。`);
            return { updated: false, failed: true, reason: 'update-failed' };
        }
        console.warn(`[提示] ${msg}，将使用本地已有文件继续。`);
        return { updated: false, failed: false, reason: 'offline' };
    }
}

async function updateIfNeeded(options = {}) {
    const rootDir = options.rootDir || ROOT_DIR;
    const { bootstrap = false, fetcher } = options;
    if (!bootstrap && fs.existsSync(path.join(rootDir, '.git'))) {
        return syncWithGit(rootDir);
    }
    return syncWithManifest(rootDir, { bootstrap, fetcher });
}

async function main() {
    const args = new Set(process.argv.slice(2));
    if (args.has('--write-manifest')) {
        const res = writeManifest(ROOT_DIR);
        console.log(res.changed
            ? `[清单] 已生成 ${MANIFEST_FILE} (适配 v${res.manifest.targetVersion || '未知'}, rev=${res.manifest.revision}, ${Object.keys(res.manifest.files).length} 个文件)。`
            : `[清单] ${MANIFEST_FILE} 无变动，跳过写入。`);
        return;
    }

    const bootstrap = args.has('--bootstrap');
    const res = await updateIfNeeded({ rootDir: ROOT_DIR, bootstrap });
    if (res.failed) process.exit(1);
}

if (require.main === module) {
    main().catch(err => {
        console.error(`[错误] 更新器执行异常: ${err.message || err}`);
        process.exit(1);
    });
}

module.exports = {
    REPO,
    BRANCH,
    normalizeLf,
    sha256Normalized,
    formatOutputBuffer,
    collectManagedFiles,
    buildManifest,
    writeManifest,
    validateRemoteFile,
    parseMainShaFromInfoRefs,
    syncWithManifest,
    updateIfNeeded
};
