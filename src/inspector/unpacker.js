const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const https = require('https');
const readline = require('readline');
const zlib = require('zlib');
const utils = require('../utils');
const extractor = require('./extractor');

const SKIP_DIRS = new Set(['node_modules', '__mocks__', 'test', 'tests']);
const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ', middot: '·', rarr: '→', larr: '←', mdash: '—', ndash: '–' };
const PK_SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function extractEmbeddedAssetsFromBinary(buf) {
    let combined = '';
    const zipFiles = [];
    for (let idx = 0; (idx = buf.indexOf(PK_SIG, idx)) !== -1; idx += 4) {
        if (idx + 30 > buf.length) break;
        const fnLen = buf.readUInt16LE(idx + 26);
        const extraLen = buf.readUInt16LE(idx + 28);
        const compSize = buf.readUInt32LE(idx + 18);
        const method = buf.readUInt16LE(idx + 8);
        const dataStart = idx + 30 + fnLen + extraLen;
        if (fnLen <= 0 || fnLen >= 256 || dataStart >= buf.length) continue;

        const filename = buf.subarray(idx + 30, idx + 30 + fnLen).toString('utf-8');
        const normName = filename.replace(/\\/g, '/');
        const ext = path.extname(filename).toLowerCase();
        if (!['.js', '.mjs', '.html', '.htm', '.json'].includes(ext) ||
            /(?:^|\/)(?:workers|prism)\//i.test(normName) ||
            /(?:^|\/)(?:prism_bundle\.js|page_agent_bundle\.js|page_facade_bundle\.js|diff_worker\.js)$/i.test(normName) ||
            normName.includes('pdf.worker') || normName.includes('pdf.min')) continue;

        let data = null;
        if (method === 8) {
            try {
                const slice = compSize > 0 && dataStart + compSize <= buf.length ? buf.subarray(dataStart, dataStart + compSize) : buf.subarray(dataStart);
                data = zlib.inflateRawSync(slice);
            } catch (e) {}
        } else if (method === 0 && compSize > 0 && dataStart + compSize <= buf.length) {
            data = buf.subarray(dataStart, dataStart + compSize);
        }
        if (data) {
            const content = data.toString('utf-8');
            combined += content + '\n';
            zipFiles.push({ filename, ext, content });
        }
    }
    return { combined, zipFiles };
}

function extractMcpStrings(mcpData, { includeItemTitles = true } = {}) {
    const strings = new Set();
    if (!mcpData) return strings;
    const addPairs = (list, k1, k2, unwrap) => {
        for (const raw of list || []) {
            const item = unwrap ? (raw.plugin || raw) : raw;
            if (k1 && item[k1]) strings.add(utils.normalizeText(item[k1]));
            if (k2 && item[k2]) strings.add(utils.normalizeText(item[k2]));
        }
    };
    addPairs(mcpData.plugins, includeItemTitles ? 'title' : null, 'description');
    addPairs(mcpData.buildWithGoogle, includeItemTitles ? 'name' : null, 'description', true);
    addPairs(mcpData.marketplace?.groups, 'displayName', 'description');
    addPairs(mcpData.marketplace?.customizations, includeItemTitles ? 'displayName' : null, 'description');
    return strings;
}

const extractMcpAuditStrings = mcpData => extractMcpStrings(mcpData, { includeItemTitles: false });

async function openEphemeralMarketplace(resourcesDir, ideVersion, startupTimeoutMs = 15000) {
    const lsBin = resourcesDir ? path.join(resourcesDir, 'bin', 'language_server.exe') : '';
    if (!lsBin || !fs.existsSync(lsBin)) return null;

    const csrf = crypto.randomUUID();
    const args = [
        '--standalone', '--exit_on_stdin_close',
        '--override_ide_name', 'antigravity',
        '--subclient_type', 'hub',
        '--override_ide_version', ideVersion && ideVersion !== '未知' ? ideVersion : '0.0.0',
        '--override_user_agent_name', 'antigravity',
        '--https_server_port', '0',
        '--app_data_dir', 'antigravity',
        '--api_server_url', 'https://generativelanguage.googleapis.com',
        '--cloud_code_endpoint', 'https://daily-cloudcode-pa.googleapis.com'
    ];

    const child = cp.spawn(lsBin, args, {
        stdio: ['pipe', 'ignore', 'pipe'],
        env: { ...process.env, ANTIGRAVITY_SERVER_CSRF_TOKEN: csrf },
        windowsHide: true
    });
    child.stdin.on('error', () => {});
    const onExit = () => { try { child.kill(); } catch (e) {} };
    process.once('exit', onExit);

    const exited = new Promise(r => child.once('exit', r).once('error', r));
    const close = async () => {
        process.off('exit', onExit);
        if (child.exitCode !== null) return;
        try { child.stdin.end(); } catch (e) {}
        await Promise.race([exited, new Promise(r => setTimeout(r, 1500))]);
        if (child.exitCode === null) try { child.kill(); } catch (e) {}
    };

    const livePort = await new Promise(resolve => {
        let port = null;
        const rl = readline.createInterface({ input: child.stderr });
        const done = val => { clearTimeout(timer); rl.close(); resolve(val); };
        const timer = setTimeout(() => done(null), startupTimeoutMs);
        rl.on('line', line => {
            if (!port) port = parseInt(/listening on \w+ port at (\d+) for HTTPS\b/i.exec(line)?.[1] || '', 10) || null;
            if (port && /initialized server successfully/i.test(line)) done(port);
        });
        exited.then(() => done(null));
    });

    if (!livePort) { await close(); return null; }

    const agent = new https.Agent({ rejectUnauthorized: false });
    const callRpc = (pathUrl, reqBody, timeoutMs = 25000) => new Promise((resolve, reject) => {
        const req = https.request({
            hostname: '127.0.0.1', port: livePort, path: pathUrl, method: 'POST', agent, timeout: timeoutMs,
            headers: { 'x-codeium-csrf-token': csrf, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }
        }, res => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 160)}`));
                try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`JSON 解析失败: ${e.message}`)); }
            });
        });
        req.on('error', e => reject(new Error(`请求失败: ${e.message}`)));
        req.on('timeout', () => { req.destroy(); reject(new Error(`请求超时 (${timeoutMs}ms)`)); });
        req.end(JSON.stringify(reqBody));
    });

    return { livePort, callRpc, close };
}

function scanBuiltinSkills(builtinSkillsDir) {
    const out = {};
    if (!fs.existsSync(builtinSkillsDir)) return out;
    for (const sf of fs.readdirSync(builtinSkillsDir)) {
        const skillFile = path.join(builtinSkillsDir, sf, 'SKILL.md');
        if (!fs.existsSync(skillFile)) continue;
        const raw = fs.readFileSync(skillFile, 'utf-8');
        const name = (raw.match(/name:\s*([^\r\n]+)/)?.[1] || sf).trim();
        const descMatch = raw.match(/description:\s*(?:>-\s*)?([\s\S]*?)(?:\r?\n---|\r?\n#[^\r\n]*|\r?\n[a-z_-]+:)/i);
        out[name] = { name, description: descMatch ? descMatch[1].replace(/\r?\n\s*/g, ' ').trim() : '' };
    }
    return out;
}

function decodeBasicHtmlEntities(text) {
    if (!text || !text.includes('&')) return text || '';
    return text.replace(/&(amp|lt|gt|quot|#39|apos|nbsp|middot|rarr|larr|mdash|ndash|#(\d+)|#x([0-9a-fA-F]+));/gi, (m, k, dec, hex) => {
        if (dec) return String.fromCodePoint(Number(dec));
        if (hex) return String.fromCodePoint(parseInt(hex, 16));
        return HTML_ENTITIES[k.toLowerCase()] || m;
    });
}

function extractStringsFromHtml(htmlText) {
    const out = new Set();
    if (!htmlText || typeof htmlText !== 'string') return out;
    const cleaned = htmlText.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
    const push = raw => {
        const norm = utils.normalizeText(decodeBasicHtmlEntities(raw));
        if (norm && extractor.isLikelyUserFacingText(norm)) out.add(norm);
    };
    let m;
    for (const re = />([^<]+)</g; (m = re.exec(cleaned)) !== null;) push(m[1]);
    for (const re = /\b(?:title|placeholder|aria-label|alt)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi; (m = re.exec(cleaned)) !== null;) push(m[1] ?? m[2] ?? '');
    return out;
}

function walkSidecarFiles(dir, onFile) {
    for (const ent of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
        if (!ent.isFile()) continue;
        const full = path.join(ent.parentPath || ent.path, ent.name);
        const rel = path.relative(dir, full).replace(/\\/g, '/');
        const ext = path.extname(ent.name).toLowerCase();
        if (rel.split('/').some(s => SKIP_DIRS.has(s)) || !['.js', '.mjs', '.html', '.htm'].includes(ext)) continue;
        onFile(full, rel, ext, fs.readFileSync(full, 'utf-8'));
    }
}

function readBuiltinSidecarRaw(pluginsDir) {
    let raw = '';
    if (!pluginsDir || !fs.existsSync(pluginsDir)) return raw;
    for (const pEnt of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
        const scRoot = pEnt.isDirectory() ? path.join(pluginsDir, pEnt.name, 'sidecars') : null;
        if (scRoot && fs.existsSync(scRoot)) walkSidecarFiles(scRoot, (_full, _rel, _ext, content) => { raw += content + '\n'; });
    }
    return raw;
}

function scanBuiltinSidecars(pluginsDir) {
    const sidecars = {};
    if (!pluginsDir || !fs.existsSync(pluginsDir)) return sidecars;
    for (const pEnt of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
        const scRoot = pEnt.isDirectory() ? path.join(pluginsDir, pEnt.name, 'sidecars') : null;
        if (!scRoot || !fs.existsSync(scRoot)) continue;
        for (const scEnt of fs.readdirSync(scRoot, { withFileTypes: true })) {
            if (!scEnt.isDirectory()) continue;
            const key = `${pEnt.name}/${scEnt.name}`, dir = path.join(scRoot, scEnt.name);
            const files = {}, union = new Set();
            walkSidecarFiles(dir, (_full, rel, ext, content) => {
                const strs = (ext === '.html' || ext === '.htm') ? extractStringsFromHtml(content) : extractor.extractStringsFromJs(content);
                files[rel] = Array.from(strs).sort(utils.naturalCompare);
                for (const s of strs) union.add(s);
            });
            if (Object.keys(files).length > 0) sidecars[key] = { files, strings: Array.from(union).sort(utils.naturalCompare) };
        }
    }
    return sidecars;
}

module.exports = {
    extractEmbeddedAssetsFromBinary,
    extractMcpStrings,
    extractMcpAuditStrings,
    openEphemeralMarketplace,
    scanBuiltinSkills,
    extractStringsFromHtml,
    readBuiltinSidecarRaw,
    scanBuiltinSidecars
};
