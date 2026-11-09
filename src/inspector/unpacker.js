const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const https = require('https');
const zlib = require('zlib');
const utils = require('../utils');

function getRelativeFiles(dir, base) {
    base = base || dir;
    let results = [];
    if (!fs.existsSync(dir)) return results;
    const list = fs.readdirSync(dir);
    for (const file of list) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            if (file === 'node_modules' || file === '__mocks__' || file === 'test') continue;
            results = results.concat(getRelativeFiles(fullPath, base));
        } else {
            results.push(path.relative(base, fullPath));
        }
    }
    return results;
}

function walkAsarJsFiles(parsedAsar) {
    const filesMap = new Map();
    function walk(node, prefix = '') {
        if (!node || !node.files) return;
        for (const [name, child] of Object.entries(node.files)) {
            const rel = prefix ? `${prefix}/${name}` : name;
            if (rel === 'dist/__mocks__' || rel === 'dist/test') continue;
            if (child.files) {
                walk(child, rel);
            } else if (rel.startsWith('dist/') && rel.endsWith('.js') && !rel.endsWith('.test.js')) {
                const subRel = rel.slice(5);
                const content = parsedAsar.readFile(rel);
                if (content !== null) {
                    filesMap.set(subRel, content);
                }
            }
        }
    }
    walk(parsedAsar.header);
    return filesMap;
}

function extractEmbeddedAssetsFromBinary(buf) {
    let combined = '';
    const zipFiles = [];
    const PK_SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    let idx = 0;

    while ((idx = buf.indexOf(PK_SIG, idx)) !== -1) {
        if (idx + 30 > buf.length) break;
        try {
            const fnLen = buf.readUInt16LE(idx + 26);
            const extraLen = buf.readUInt16LE(idx + 28);
            const compSize = buf.readUInt32LE(idx + 18);
            const method = buf.readUInt16LE(idx + 8);
            const dataStart = idx + 30 + fnLen + extraLen;

            if (fnLen > 0 && fnLen < 256 && dataStart < buf.length) {
                const filename = buf.subarray(idx + 30, idx + 30 + fnLen).toString('utf-8');
                const ext = path.extname(filename).toLowerCase();
                if (['.js', '.mjs', '.html', '.htm', '.json'].includes(ext) &&
                    !filename.includes('pdf.worker') && !filename.includes('pdf.min')) {
                    let data = null;
                    if (method === 8) {
                        try {
                            const slice = compSize > 0 && dataStart + compSize <= buf.length
                                ? buf.subarray(dataStart, dataStart + compSize)
                                : buf.subarray(dataStart);
                            data = zlib.inflateRawSync(slice);
                        } catch (e) {}
                    } else if (method === 0 && compSize > 0 && dataStart + compSize <= buf.length) {
                        data = buf.subarray(dataStart, dataStart + compSize);
                    }
                    if (data) {
                        const content = data.toString('utf-8');
                        combined += content + '\n';
                        zipFiles.push({ filename, content });
                    }
                }
            }
        } catch (e) {}
        idx += 4;
    }
    return { combined, zipFiles };
}

function extractMcpStrings(mcpData) {
    const strings = new Set();
    if (!mcpData) return strings;
    if (Array.isArray(mcpData.plugins)) {
        for (const p of mcpData.plugins) {
            if (p.title) strings.add(utils.normalizeText(p.title));
            if (p.description) strings.add(utils.normalizeText(p.description));
        }
    }
    if (Array.isArray(mcpData.buildWithGoogle)) {
        for (const item of mcpData.buildWithGoogle) {
            const p = item.plugin || item;
            if (p.name) strings.add(utils.normalizeText(p.name));
            if (p.description) strings.add(utils.normalizeText(p.description));
        }
    }
    if (mcpData.marketplace) {
        if (Array.isArray(mcpData.marketplace.groups)) {
            for (const g of mcpData.marketplace.groups) {
                if (g.displayName) strings.add(utils.normalizeText(g.displayName));
                if (g.description) strings.add(utils.normalizeText(g.description));
            }
        }
        if (Array.isArray(mcpData.marketplace.customizations)) {
            for (const c of mcpData.marketplace.customizations) {
                if (c.displayName) strings.add(utils.normalizeText(c.displayName));
                if (c.description) strings.add(utils.normalizeText(c.description));
            }
        }
    }
    return strings;
}

function fetchLiveMcpMarketplace() {
    let livePort = null;
    let liveCsrf = null;

    try {
        const out = cp.execFileSync('powershell.exe', [
            '-NoProfile',
            '-Command',
            "Get-CimInstance Win32_Process | Where-Object Name -eq 'language_server.exe' | Select-Object -ExpandProperty CommandLine"
        ], { encoding: 'utf-8', timeout: 5000 });
        const m = out.match(/--csrf_token\s+([a-f0-9\-]+)/);
        if (m) liveCsrf = m[1];
    } catch (e) {}

    const logPath = path.join(process.env.APPDATA || '', 'antigravity', 'logs', 'main.log');
    if (fs.existsSync(logPath)) {
        try {
            const logLines = fs.readFileSync(logPath, 'utf-8').split('\n');
            for (let i = logLines.length - 1; i >= 0; i--) {
                const line = logLines[i];
                if (!livePort && line.includes('127.0.0.1')) {
                    const m = line.match(/https?:\/\/127\.0\.0\.1:(\d+)/);
                    if (m) livePort = parseInt(m[1], 10);
                }
                if (!liveCsrf && line.includes('--csrf_token')) {
                    const m = line.match(/--csrf_token\s+([a-f0-9\-]+)/);
                    if (m) liveCsrf = m[1];
                }
                if (livePort && liveCsrf) break;
            }
        } catch (e) {}
    }

    if (!livePort || !liveCsrf) return null;

    const agent = new https.Agent({ rejectUnauthorized: false });
    function callRpc(pathUrl, reqBody) {
        return new Promise((resolve) => {
            const bodyStr = JSON.stringify(reqBody);
            const req = https.request({
                hostname: '127.0.0.1',
                port: livePort,
                path: pathUrl,
                method: 'POST',
                agent: agent,
                timeout: 3000,
                headers: {
                    'x-codeium-csrf-token': liveCsrf,
                    'Content-Type': 'application/json',
                    'Connect-Protocol-Version': '1'
                }
            }, res => {
                let data = '';
                res.on('data', d => data += d);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
                });
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
            req.write(bodyStr);
            req.end();
        });
    }

    return { livePort, callRpc };
}

function scanBuiltinSkills(builtinSkillsDir) {
    const currentSkillsData = {};
    if (!fs.existsSync(builtinSkillsDir)) return currentSkillsData;
    const skillFolders = fs.readdirSync(builtinSkillsDir);
    for (const sf of skillFolders) {
        const skillFile = path.join(builtinSkillsDir, sf, 'SKILL.md');
        if (fs.existsSync(skillFile)) {
            const rawSkill = fs.readFileSync(skillFile, 'utf-8');
            const nameMatch = rawSkill.match(/name:\s*([^\r\n]+)/);
            const descMatch = rawSkill.match(/description:\s*(?:>-\s*)?([\s\S]*?)(?:\n---|\n#[^\n]*|\n[a-z_]+:)/i);
            const name = nameMatch ? nameMatch[1].trim() : sf;
            let desc = '';
            if (descMatch) desc = descMatch[1].replace(/\r?\n\s*/g, ' ').trim();
            currentSkillsData[name] = { name, description: desc };
        }
    }
    return currentSkillsData;
}

module.exports = {
    getRelativeFiles,
    walkAsarJsFiles,
    extractEmbeddedAssetsFromBinary,
    extractMcpStrings,
    fetchLiveMcpMarketplace,
    scanBuiltinSkills
};
