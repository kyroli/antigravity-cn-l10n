const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const https = require('https');
const zlib = require('zlib');
const utils = require('../utils');
const extractor = require('./extractor');

const SKIP_DIRS = new Set(['node_modules', '__mocks__', 'test', 'tests']);
const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ', middot: '·', rarr: '→', larr: '←', mdash: '—', ndash: '–' };
const PK_SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const CSRF_TOKEN_RE = /--csrf_token\s+([a-f0-9-]+)/gi;

function extractLastCsrf(text) {
    let last = null;
    for (const m of text.matchAll(CSRF_TOKEN_RE)) last = m[1];
    return last;
}

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
        const ext = path.extname(filename).toLowerCase();
        if (!['.js', '.mjs', '.html', '.htm', '.json'].includes(ext) || filename.includes('pdf.worker') || filename.includes('pdf.min')) continue;

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

function extractMcpStrings(mcpData) {
    const strings = new Set();
    if (!mcpData) return strings;
    const addPairs = (list, k1, k2, unwrap) => {
        for (const raw of list || []) {
            const item = unwrap ? (raw.plugin || raw) : raw;
            if (item[k1]) strings.add(utils.normalizeText(item[k1]));
            if (item[k2]) strings.add(utils.normalizeText(item[k2]));
        }
    };
    addPairs(mcpData.plugins, 'title', 'description');
    addPairs(mcpData.buildWithGoogle, 'name', 'description', true);
    addPairs(mcpData.marketplace?.groups, 'displayName', 'description');
    addPairs(mcpData.marketplace?.customizations, 'displayName', 'description');
    return strings;
}

function fetchLiveMcpMarketplace() {
    let livePort = null, liveCsrf = null;
    try {
        const out = cp.execFileSync('powershell.exe', ['-NoProfile', '-Command',
            "Get-CimInstance Win32_Process -Filter \"Name LIKE 'language_server%.exe'\" | Select-Object -ExpandProperty CommandLine"
        ], { encoding: 'utf-8', timeout: 5000 });
        liveCsrf = extractLastCsrf(out);
    } catch (e) {}

    const logPath = path.join(process.env.APPDATA || '', 'antigravity', 'logs', 'main.log');
    if (fs.existsSync(logPath)) {
        try {
            const lines = fs.readFileSync(logPath, 'utf-8').split('\n');
            for (let i = lines.length - 1; i >= 0 && (!livePort || !liveCsrf); i--) {
                const line = lines[i];
                // main.log 同时记录非 RPC 的 http:// 桥接端口，仅取 https://127.0.0.1:
                if (!livePort && line.includes('https://127.0.0.1:')) {
                    const m = line.match(/https:\/\/127\.0\.0\.1:(\d+)/);
                    if (m) livePort = parseInt(m[1], 10);
                }
                if (!liveCsrf) {
                    const token = extractLastCsrf(line);
                    if (token) liveCsrf = token;
                }
            }
        } catch (e) {}
    }
    if (!livePort || !liveCsrf) return null;

    const agent = new https.Agent({ rejectUnauthorized: false });
    // 非 2xx 状态、JSON 解析失败、网络错误或超时均显式 reject，由调用方按需回退快照
    const callRpc = (pathUrl, reqBody, timeoutMs = 10000) => new Promise((resolve, reject) => {
        const req = https.request({
            hostname: '127.0.0.1', port: livePort, path: pathUrl, method: 'POST', agent, timeout: timeoutMs,
            headers: { 'x-codeium-csrf-token': liveCsrf, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }
        }, res => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 160)}`));
                }
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error(`JSON 解析失败: ${e.message}`));
                }
            });
        });
        req.on('error', e => reject(new Error(`请求失败: ${e.message}`)));
        req.on('timeout', () => { req.destroy(); reject(new Error(`请求超时 (${timeoutMs}ms)`)); });
        req.write(JSON.stringify(reqBody));
        req.end();
    });
    return { livePort, callRpc };
}

function scanBuiltinSkills(builtinSkillsDir) {
    const out = {};
    if (!fs.existsSync(builtinSkillsDir)) return out;
    for (const sf of fs.readdirSync(builtinSkillsDir)) {
        const skillFile = path.join(builtinSkillsDir, sf, 'SKILL.md');
        if (!fs.existsSync(skillFile)) continue;
        const raw = fs.readFileSync(skillFile, 'utf-8');
        const name = (raw.match(/name:\s*([^\r\n]+)/)?.[1] || sf).trim();
        const descMatch = raw.match(/description:\s*(?:>-\s*)?([\s\S]*?)(?:\n---|\n#[^\n]*|\n[a-z_]+:)/i);
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
            for (const ent of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
                if (!ent.isFile()) continue;
                const full = path.join(ent.parentPath || ent.path, ent.name);
                const rel = path.relative(dir, full).replace(/\\/g, '/');
                const ext = path.extname(ent.name).toLowerCase();
                if (rel.split('/').some(s => SKIP_DIRS.has(s)) || !['.js', '.mjs', '.html', '.htm'].includes(ext)) continue;
                const content = fs.readFileSync(full, 'utf-8');
                const strs = (ext === '.html' || ext === '.htm') ? extractStringsFromHtml(content) : extractor.extractStringsFromJs(content);
                files[rel] = Array.from(strs).sort(utils.naturalCompare);
                for (const s of strs) union.add(s);
            }
            if (Object.keys(files).length > 0) sidecars[key] = { files, strings: Array.from(union).sort(utils.naturalCompare) };
        }
    }
    return sidecars;
}

module.exports = {
    extractEmbeddedAssetsFromBinary,
    extractMcpStrings,
    fetchLiveMcpMarketplace,
    scanBuiltinSkills,
    extractStringsFromHtml,
    scanBuiltinSidecars
};
