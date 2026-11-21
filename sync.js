const fs = require('fs');
const path = require('path');
const asar = require('./src/asar');
const utils = require('./src/utils');
const unpacker = require('./src/inspector/unpacker');
const extractor = require('./src/inspector/extractor');
const auditor = require('./src/inspector/auditor');
const patcher = require('./src/patcher');
const bundleRewriter = require('./src/runtime/bundleRewriter');

const SNAPSHOT_DIR = path.join(__dirname, '_inspect_app');
const SNAPSHOT_LS_ASSETS = path.join(SNAPSHOT_DIR, 'ls_assets_combined.txt');
const SNAPSHOT_MCP = path.join(SNAPSHOT_DIR, 'mcp_marketplace_snapshot.json');
const SNAPSHOT_BUILTIN_SKILLS = path.join(SNAPSHOT_DIR, 'builtin_skills_snapshot.json');
const SNAPSHOT_BUILTIN_SIDECARS = path.join(SNAPSHOT_DIR, 'builtin_sidecars_snapshot.json');

async function fetchFullMarketplace(liveMcp) {
    const rpcPath = '/exa.language_server_pb.LanguageServerService/SearchMarketplace';
    const custMap = new Map();
    const groupMap = new Map();
    const visitedTokens = new Set();
    const absorb = page => {
        for (const c of page?.customizations || []) {
            const key = c?.id || c?.displayName;
            if (key) custMap.set(key, c);
        }
        for (const g of page?.groups || []) {
            if (!g?.id) continue;
            const prev = groupMap.get(g.id);
            const mergedIds = Array.from(new Set([...(prev?.memberIds || []), ...(g.memberIds || [])]));
            groupMap.set(g.id, { ...prev, ...g, memberIds: mergedIds, nextPageToken: g.nextPageToken || '' });
        }
    };

    let root = await liveMcp.callRpc(rpcPath, { query: '', groupId: '', pageToken: '' });
    absorb(root);
    let rootTok = root?.nextPageToken || '';
    for (let i = 0; i < 20 && rootTok && !visitedTokens.has(`root:${rootTok}`); i++) {
        visitedTokens.add(`root:${rootTok}`);
        const page = await liveMcp.callRpc(rpcPath, { query: '', groupId: '', pageToken: rootTok });
        absorb(page);
        rootTok = page?.nextPageToken || '';
    }

    for (const g of groupMap.values()) {
        let tok = g.nextPageToken || '';
        g.nextPageToken = '';
        for (let i = 0; i < 20 && tok && !visitedTokens.has(`${g.id}:${tok}`); i++) {
            visitedTokens.add(`${g.id}:${tok}`);
            const page = await liveMcp.callRpc(rpcPath, { query: '', groupId: g.id, pageToken: tok });
            absorb(page);
            const nextGroup = (page?.groups || []).find(x => x.id === g.id);
            tok = nextGroup?.nextPageToken || page?.nextPageToken || '';
            const cur = groupMap.get(g.id);
            if (cur) cur.nextPageToken = '';
        }
    }

    return { groups: Array.from(groupMap.values()), customizations: Array.from(custMap.values()) };
}

const MCP_ENDPOINTS = [
    {
        key: 'plugins',
        label: 'GetAvailableCascadePlugins',
        path: '/exa.language_server_pb.LanguageServerService/GetAvailableCascadePlugins',
        body: { os: 'windows', searchQuery: '' },
        extract: v => v?.plugins,
        hasData: s => Array.isArray(s) && s.length > 0,
    },
    {
        key: 'buildWithGoogle',
        label: 'GetBuildWithGooglePlugins',
        path: '/exa.language_server_pb.LanguageServerService/GetBuildWithGooglePlugins',
        body: {},
        extract: v => v?.plugins,
        hasData: s => Array.isArray(s) && s.length > 0,
    },
    {
        key: 'marketplace',
        label: 'SearchMarketplace',
        fetch: fetchFullMarketplace,
        extract: v => v,
        hasData: s => Boolean(s && ((Array.isArray(s.groups) && s.groups.length > 0) || (Array.isArray(s.customizations) && s.customizations.length > 0))),
    },
];

const addCandidate = (map, str, src) => { if (!map.has(str)) map.set(str, []); map.get(str).push(src); };
const readJsonSafe = (fp, fb) => { try { return fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, 'utf-8')) : fb; } catch (e) { return fb; } };

function assertRegex(pattern, label) {
    if (typeof pattern !== 'string' || pattern.length === 0) {
        throw new Error(`${label} 缺少有效正则`);
    }
    try {
        return new RegExp(pattern, 'i');
    } catch (e) {
        throw new Error(`${label} 编译失败 (${pattern}): ${e.message}`);
    }
}

function validateConfigPatterns(config) {
    const compiledFrameRules = auditor.validateRegexRules(config.frame?.rules ?? [], 'config.json frame.rules');
    const fragmentRules = [];
    for (const [label, list] of [['fragmentPatterns', config.fragmentPatterns || []], ['frame.fragmentPatterns', config.frame?.fragmentPatterns || []]]) {
        for (let i = 0; i < list.length; i++) {
            const fp = list[i];
            assertRegex(fp?.containerPattern, `config.json ${label}[${i}].containerPattern`);
            const reps = fp?.nodeReplacements || [];
            for (let j = 0; j < reps.length; j++) {
                fragmentRules.push(assertRegex(reps[j]?.match, `config.json ${label}[${i}].nodeReplacements[${j}].match`));
            }
        }
    }
    return { frameRules: compiledFrameRules.map(r => r.regex), fragmentRules };
}

function runMemoryPatchSmokeTest(sourceBuf, parsedAsar) {
    const allDict = utils.loadDictionary();
    const rules = utils.loadRules();
    const config = utils.loadConfig();
    const tplIssues = patcher.auditStaticTemplates(parsedAsar, allDict, rules, config);
    if (tplIssues.length > 0) {
        throw new Error(`内存补丁冒烟校验失败：静态模板靶点异常 (${tplIssues.length} 处)\n  - ${tplIssues.join('\n  - ')}`);
    }
    const patchMap = patcher.generatePatchMap(parsedAsar);
    if (!patchMap['dist/main.js'] || !patchMap['dist/preload.js']) {
        throw new Error('内存补丁冒烟校验失败：缺少 dist/main.js 或 dist/preload.js 补丁输出');
    }
    for (const tplFile of Object.keys(patcher.STATIC_TEMPLATES)) {
        const raw = parsedAsar.readFile(tplFile);
        if (raw && !raw.includes(utils.SIGNATURE_START) && !patchMap[tplFile]) {
            throw new Error(`内存补丁冒烟校验失败：静态模板 ${tplFile} 未能命中生成补丁`);
        }
    }
    const patchedBuf = asar.patchAsarInMemory(sourceBuf, reader => patcher.generatePatchMap(reader));
    asar.verifyPatchedAsar(patchedBuf);
    return { patchedCount: Object.keys(patchMap).length, outSize: patchedBuf.length };
}

function listLocalDistJs(dir) {
    const out = new Set();
    if (!fs.existsSync(dir)) return out;
    for (const ent of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
        if (!ent.isFile()) continue;
        const rel = path.relative(dir, path.join(ent.parentPath || ent.path, ent.name)).replace(/\\/g, '/');
        if (!rel.startsWith('l10n/') && !rel.startsWith('__mocks__/') && !rel.startsWith('test/') && rel.endsWith('.js') && !rel.endsWith('.test.js')) {
            out.add(rel);
        }
    }
    return out;
}

function writeBaselineSnapshot(ver, pkgRaw, newFilesMap, lsExt, mcpData, skillsData, sidecarsData) {
    const snapDistDir = path.join(SNAPSHOT_DIR, 'dist');
    fs.mkdirSync(snapDistDir, { recursive: true });
    for (const oldRel of listLocalDistJs(snapDistDir)) {
        if (!newFilesMap.has(oldRel)) {
            try { fs.unlinkSync(path.join(snapDistDir, oldRel)); } catch (e) {}
        }
    }
    for (const [subRel, content] of newFilesMap.entries()) {
        const tp = path.join(snapDistDir, subRel);
        fs.mkdirSync(path.dirname(tp), { recursive: true });
        fs.writeFileSync(tp, content, 'utf-8');
    }
    if (pkgRaw) fs.writeFileSync(path.join(SNAPSHOT_DIR, 'package.json'), pkgRaw, 'utf-8');
    if (lsExt.combined) fs.writeFileSync(SNAPSHOT_LS_ASSETS, lsExt.combined, 'utf-8');
    if (mcpData && MCP_ENDPOINTS.every(ep => ep.hasData(mcpData[ep.key]))) {
        const outMcp = {};
        for (const ep of MCP_ENDPOINTS) outMcp[ep.key] = mcpData[ep.key];
        fs.writeFileSync(SNAPSHOT_MCP, JSON.stringify(outMcp, null, 2), 'utf-8');
    }
    if (Object.keys(skillsData).length > 0) fs.writeFileSync(SNAPSHOT_BUILTIN_SKILLS, JSON.stringify(skillsData, null, 2), 'utf-8');
    if (Object.keys(sidecarsData).length > 0) fs.writeFileSync(SNAPSHOT_BUILTIN_SIDECARS, JSON.stringify(sidecarsData, null, 2), 'utf-8');

    const state = utils.loadState();
    state.targetVersion = ver;
    utils.saveState(state);

    const pkgPath = path.join(__dirname, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    if (pkg.targetVersion !== ver) {
        pkg.targetVersion = ver;
        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
    }
}

function buildFrameMatcher(config, frameRules) {
    const lowerExcludeSet = new Set((config.lowerWordsExclude || []).map(w => w.toLowerCase()));
    const frameDictExact = new Set();
    const frameDictLower = new Set();
    for (const k of Object.keys(config.frame?.dict || {})) {
        const normK = utils.normalizeText(k);
        if (!normK) continue;
        frameDictExact.add(normK);
        const lowerK = normK.toLowerCase();
        if (!lowerExcludeSet.has(lowerK)) frameDictLower.add(lowerK);
    }
    return normStr => frameDictExact.has(normStr) || frameDictLower.has(normStr.toLowerCase()) || frameRules.some(re => re.test(normStr));
}

function scanDistJs(parsedAsar, corpus, isAuditOnly) {
    console.log('[1/5] Electron 壳层代码扫描');
    const oldDistDir = path.join(SNAPSHOT_DIR, 'dist');
    const oldFiles = listLocalDistJs(oldDistDir);
    const newFilesMap = asar.walkDistJs(parsedAsar, { stripPrefix: true, clean: true });
    let added = 0, modified = 0, unchanged = 0;

    for (const [f, newClean] of newFilesMap.entries()) {
        const fileStrings = extractor.extractStringsFromJs(newClean);
        for (const s of fileStrings) corpus.current.add(s);
        if (isAuditOnly) {
            for (const [s, srcs] of extractor.extractHighConfidenceUiStrings(newClean)) {
                addCandidate(corpus.candidates, s, `壳层 UI (${Array.from(srcs).join(',')}): ${f}`);
            }
        }
        if (!oldFiles.has(f)) {
            added++;
            for (const s of fileStrings) addCandidate(corpus.candidates, s, `壳层新增: ${f}`);
            continue;
        }
        const oldClean = utils.cleanInjectedPatches(fs.readFileSync(path.join(oldDistDir, f), 'utf-8'));
        const oldStrings = extractor.extractStringsFromJs(oldClean);
        for (const s of oldStrings) corpus.old.add(s);
        if (oldClean !== newClean) {
            modified++;
            for (const s of fileStrings) if (!oldStrings.has(s)) addCandidate(corpus.candidates, s, `壳层变动: ${f}`);
        } else {
            unchanged++;
        }
    }
    for (const f of oldFiles) {
        if (newFilesMap.has(f)) continue;
        const oldClean = utils.cleanInjectedPatches(fs.readFileSync(path.join(oldDistDir, f), 'utf-8'));
        for (const s of extractor.extractStringsFromJs(oldClean)) corpus.old.add(s);
    }
    console.log(`  未变动: ${unchanged} | 新增: ${added} | 修改: ${modified}\n`);
    return newFilesMap;
}

function scanLanguageServer(resourcesDir, corpus, isAuditOnly) {
    console.log('[2/5] language_server.exe 内嵌资产扫描');
    const lsExePath = path.join(resourcesDir, 'bin', 'language_server.exe');
    if (!fs.existsSync(lsExePath)) {
        console.log('  [!] 未找到 language_server.exe，跳过。\n');
        return { combined: '', zipFiles: [], lsBuf: null };
    }
    const lsBuf = fs.readFileSync(lsExePath);
    const lsExtracted = unpacker.extractEmbeddedAssetsFromBinary(lsBuf);
    const newLsStrings = new Set();
    for (const entry of lsExtracted.zipFiles) {
        if (entry.ext === '.html' || entry.ext === '.htm') {
            for (const s of unpacker.extractStringsFromHtml(entry.content)) newLsStrings.add(s);
        } else if (entry.ext === '.js' || entry.ext === '.mjs') {
            for (const s of extractor.extractStringsFromJs(entry.content)) newLsStrings.add(s);
            if (isAuditOnly) {
                for (const [s, srcs] of extractor.extractHighConfidenceUiStrings(entry.content)) {
                    addCandidate(corpus.candidates, s, `Web UI (${Array.from(srcs).join(',')})`);
                }
            }
        }
    }
    for (const s of newLsStrings) corpus.current.add(s);

    let lsAdded = 0;
    if (fs.existsSync(SNAPSHOT_LS_ASSETS)) {
        const oldLsRaw = fs.readFileSync(SNAPSHOT_LS_ASSETS, 'utf-8');
        const oldLsStrings = extractor.extractStringsFromJs(oldLsRaw);
        for (const s of unpacker.extractStringsFromHtml(oldLsRaw)) oldLsStrings.add(s);
        for (const s of oldLsStrings) corpus.old.add(s);
        for (const s of newLsStrings) {
            if (!oldLsStrings.has(s)) { addCandidate(corpus.candidates, s, 'Web 内嵌资产新增'); lsAdded++; }
        }
    }
    console.log(`  已解压 ${lsExtracted.zipFiles.length} 个资产包，提取 ${newLsStrings.size} 条文案 (+${lsAdded} 增量)\n`);
    return { ...lsExtracted, lsBuf };
}

async function scanMarketplaceRpc(corpus, { resourcesDir, newVersion, isAuditOnly, isPrune, loaded }) {
    console.log('[3/5] Connect-RPC 插件市场扫描');
    const liveMcp = await unpacker.openEphemeralMarketplace(resourcesDir, newVersion);
    const snapMcp = readJsonSafe(SNAPSHOT_MCP, null);
    const oldMcpStrings = snapMcp ? unpacker.extractMcpStrings(snapMcp) : new Set();

    if (!liveMcp) {
        if (!snapMcp && isPrune) {
            throw new Error('Language Server 启动失败且缺少插件市场历史快照，已中止 --prune 以防误删词条');
        }
        for (const s of oldMcpStrings) { corpus.current.add(s); corpus.old.add(s); }
        console.log(`  [提示] 无法启动 Language Server，沿用本地快照 (${oldMcpStrings.size} 条)。\n`);
        return null;
    }

    let settled;
    try {
        settled = await Promise.allSettled(MCP_ENDPOINTS.map(ep => ep.fetch ? ep.fetch(liveMcp) : liveMcp.callRpc(ep.path, ep.body)));
    } finally {
        await liveMcp.close();
    }
    const mergedMcp = {};
    const warnings = [];
    const missingHistory = [];

    for (let i = 0; i < MCP_ENDPOINTS.length; i++) {
        const ep = MCP_ENDPOINTS[i];
        const res = settled[i];
        const liveSlice = res.status === 'fulfilled' ? ep.extract(res.value) : null;
        if (ep.hasData(liveSlice)) {
            mergedMcp[ep.key] = liveSlice;
            continue;
        }
        const reason = res.status === 'rejected'
            ? (res.reason?.message || String(res.reason))
            : (res.value?.message ? `${res.value.message} (无有效数据)` : '返回空数据');
        warnings.push(`${ep.label}: ${reason}`);

        const snapSlice = snapMcp?.[ep.key];
        if (ep.hasData(snapSlice)) {
            mergedMcp[ep.key] = snapSlice;
        } else {
            mergedMcp[ep.key] = ep.key === 'marketplace' ? null : [];
            missingHistory.push(ep.label);
        }
    }

    const curMcpStrings = unpacker.extractMcpStrings(mergedMcp);
    const curMcpAuditStrings = unpacker.extractMcpAuditStrings(mergedMcp);
    for (const s of curMcpStrings) corpus.current.add(s);
    for (const s of oldMcpStrings) corpus.old.add(s);
    for (const s of curMcpStrings) {
        if (s.trim().length >= 2 && (!oldMcpStrings.has(s) || (isAuditOnly && curMcpAuditStrings.has(s) && !loaded.translated.has(s.toLowerCase())))) {
            addCandidate(corpus.candidates, s, '插件市场');
        }
    }

    if (warnings.length > 0) {
        console.log(`  [!] 实时 RPC 不完整 (${warnings.join('; ')})`);
        if (missingHistory.length > 0 && isPrune) {
            throw new Error(`Connect-RPC 部分接口失败且缺少历史快照 (${missingHistory.join(', ')})，已中止 --prune 以防误删词条`);
        }
        console.log(`  [提示] 已用历史快照补全缺失分片并保留原快照文件，当前合并语料 ${curMcpStrings.size} 条。\n`);
        return null;
    }

    const mktCount = mergedMcp.marketplace.customizations?.length || mergedMcp.marketplace.groups?.length || 0;
    console.log(`  [√] 在线抓取 ${curMcpStrings.size} 条词条 (cascade=${mergedMcp.plugins.length}, buildWithGoogle=${mergedMcp.buildWithGoogle.length}, marketplace=${mktCount})\n`);
    return mergedMcp;
}

function scanBuiltinContent(corpus, { isAuditOnly, loaded }) {
    console.log('[4/5] 内置技能与 Sidecar 扫描');
    const builtinBase = path.join(process.env.USERPROFILE || '', '.gemini', 'antigravity', 'builtin');
    const skillsDir = path.join(builtinBase, 'skills'), pluginsDir = path.join(builtinBase, 'plugins');
    const currentSkillsData = unpacker.scanBuiltinSkills(skillsDir);
    const currentSidecarsData = unpacker.scanBuiltinSidecars(pluginsDir);

    if (fs.existsSync(skillsDir)) {
        const oldSkills = readJsonSafe(SNAPSHOT_BUILTIN_SKILLS, {});
        for (const d of Object.values(oldSkills)) {
            if (d?.description) corpus.old.add(utils.normalizeText(d.description));
        }
        for (const [sName, sData] of Object.entries(currentSkillsData)) {
            const norm = utils.normalizeText(sData.description);
            if (!norm || norm.length < 2) continue;
            corpus.current.add(norm);
            const isChanged = norm !== utils.normalizeText(oldSkills[sName]?.description || '');
            if (isChanged || (isAuditOnly && !loaded.translated.has(norm.toLowerCase()))) {
                addCandidate(corpus.candidates, norm, '内置技能描述');
            }
        }
    }
    if (fs.existsSync(pluginsDir)) {
        const oldSidecars = readJsonSafe(SNAPSHOT_BUILTIN_SIDECARS, {});
        const oldSidecarMap = new Map();
        for (const [k, sc] of Object.entries(oldSidecars)) {
            const set = new Set((sc.strings || []).map(utils.normalizeText).filter(Boolean));
            for (const s of set) corpus.old.add(s);
            oldSidecarMap.set(k, set);
        }
        for (const [scKey, scData] of Object.entries(currentSidecarsData)) {
            const oldSet = oldSidecarMap.get(scKey);
            for (const s of scData.strings || []) {
                const norm = utils.normalizeText(s);
                if (!norm || norm.length < 2) continue;
                corpus.current.add(norm);
                if (!oldSet || !oldSet.has(norm) || (isAuditOnly && !loaded.translated.has(norm.toLowerCase()))) {
                    addCandidate(corpus.candidates, norm, `内置 Sidecar (${scKey})`);
                }
            }
        }
    }
    console.log(`  技能: ${Object.keys(currentSkillsData).length} 个 | Sidecar: ${Object.keys(currentSidecarsData).length} 个\n`);
    return { currentSkillsData, currentSidecarsData };
}

function unescapeForLiveness(s) {
    if (!s) return '';
    return String(s)
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\\[nrt]/g, ' ')
        .replace(/\\(['"\\])/g, '$1')
        .replace(/['\u2018\u2019\u02bc]/g, "'")
        .replace(/["\u201c\u201d]/g, '"')
        .replace(/\u2026/g, '...')
        .replace(/[\s\u00A0\u2009\u202F]+/g, ' ')
        .toLowerCase();
}

function makeLinearTplMatcher(quasis, unescapeFn) {
    const qs = quasis.map((q, idx) => {
        let s = unescapeFn(q);
        if (idx === 0) s = s.trimStart();
        if (idx === quasis.length - 1) s = s.trimEnd();
        return s;
    });
    const first = qs[0] || '', last = qs[qs.length - 1] || '', mids = qs.slice(1, -1);
    if (!first && !last) return null;
    const anchorText = qs.join(' ').trim();
    const anchorAlpha = anchorText.replace(/[^a-z]/g, '').length;
    const anchorWords = anchorText.split(/[^a-z]+/).filter(Boolean);
    const dualAnchored = Boolean(first && last && (/[a-z]/.test(first) || /[a-z]/.test(last)));
    if (dualAnchored ? anchorAlpha < 6 : anchorAlpha < (anchorWords.length >= 2 ? 8 : 6)) return null;

    const allEmptyMids = mids.every(m => !m);
    return {
        key: qs.join('\0'),
        matcher: {
            test(low) {
                if (first && !low.startsWith(first)) return false;
                if (last && !low.endsWith(last)) return false;
                const limit = low.length - last.length;
                let pos = first.length;
                if (pos > limit) return false;
                const slots = [];
                for (let k = 0; k < mids.length; k++) {
                    const m = mids[k];
                    if (!m) continue;
                    const idx = low.indexOf(m, pos);
                    if (idx === -1 || idx + m.length > limit) return false;
                    slots.push(low.slice(pos, idx));
                    pos = idx + m.length;
                }
                slots.push(low.slice(pos, limit));
                if (!dualAnchored && allEmptyMids) {
                    const slot = slots[0] || '';
                    if (anchorWords.length === 1) {
                        if (anchorAlpha === 6) {
                            if (!/^[a-z]{3,16}$/.test(slot)) return false;
                        } else if (slot.length === 0 || slot.length > 20 || /[.,!?;:]/.test(slot) || (slot.match(/ /g) || []).length > 1) {
                            return false;
                        }
                    } else if (anchorAlpha < 30 && (slot.length > 50 || /[.!?]\s/.test(slot))) {
                        return false;
                    }
                } else if (anchorAlpha < 20 && slots.some(sl => /[.!?]\s/.test(sl))) {
                    return false;
                }
                return true;
            }
        }
    };
}

function buildLivenessCorpus({ newFilesMap, lsExtracted, mcpData, skillsData, pluginsDir, config }) {
    let distFolded = '';
    for (const content of newFilesMap.values()) distFolded += utils.foldAdjacentJsStrings(content) + '\n';
    const lsRaw = (lsExtracted.zipFiles || []).map(z => z.content).join('\n');
    const mcpObj = mcpData || readJsonSafe(SNAPSHOT_MCP, null);
    const sidecarRaw = unpacker.readBuiltinSidecarRaw(pluginsDir) || JSON.stringify(readJsonSafe(SNAPSHOT_BUILTIN_SIDECARS, {}));
    const decodedSources = [
        unescapeForLiveness(lsRaw),
        unescapeForLiveness(distFolded),
        unescapeForLiveness(mcpObj ? JSON.stringify(mcpObj) : ''),
        unescapeForLiveness(skillsData && Object.keys(skillsData).length ? JSON.stringify(skillsData) : ''),
        unescapeForLiveness(sidecarRaw)
    ].join('\n');

    const exactTplSet = new Set();
    const tplMatchers = [{ test: low => exactTplSet.has(low) }];
    const seenKey = new Set();
    for (const src of [lsRaw, distFolded, sidecarRaw]) {
        for (const tpl of bundleRewriter.extractAllJsTemplates(src)) {
            const terns = tpl.exprs.map(e => bundleRewriter.expandStringTernaryExpr(src.slice(e.start, e.end)));
            if (terns.every(Boolean)) {
                let variants = [unescapeForLiveness(tpl.quasis[0])];
                for (let k = 0; k < terns.length; k++) {
                    const next = [];
                    const qNext = unescapeForLiveness(tpl.quasis[k + 1]);
                    for (const p of variants) for (const c of terns[k]) next.push(p + unescapeForLiveness(c) + qNext);
                    variants = next;
                }
                for (const v of variants) exactTplSet.add(utils.normalizeText(v).toLowerCase());
                continue;
            }
            const res = makeLinearTplMatcher(tpl.quasis, unescapeForLiveness);
            if (res && !seenKey.has(res.key)) {
                seenKey.add(res.key);
                tplMatchers.push(res.matcher);
            }
        }
    }

    const cloudTextSet = new Set((config.audit?.cloudTexts || []).map(s => utils.normalizeText(s).toLowerCase()).filter(Boolean));
    const cloudRuleSet = new Set((config.audit?.cloudRulePatterns || []).filter(Boolean));
    return { decodedSources, tplMatchers, lsBinaryBuf: lsExtracted.lsBuf || null, cloudTextSet, cloudRuleSet };
}

async function main() {
    const args = new Set(process.argv.slice(2));
    const isAuditOnly = args.has('--audit');
    const isPrune = !isAuditOnly && args.has('--prune');
    const pruneDead = !isAuditOnly && args.has('--prune-dead');
    const forceUpdateSnapshot = !isAuditOnly && args.has('--update-snapshot');

    console.log('[Antigravity 汉化词典同步与审查]\n');
    const installDir = utils.detectInstallationDir();
    const resourcesDir = installDir ? utils.getResourcesDir(installDir) : null;
    if (!resourcesDir || !fs.existsSync(resourcesDir)) {
        console.error('[错误] 无法探测 Antigravity 安装/资源目录！');
        process.exit(1);
    }

    const asarPath = path.join(resourcesDir, 'app.asar'), bakPath = path.join(resourcesDir, 'app.asar.bak');
    const isAsarUnpatched = fs.existsSync(asarPath) && !fs.readFileSync(asarPath).includes(Buffer.from(utils.SIGNATURE_START, 'utf8'));
    const sourcePkg = isAsarUnpatched ? asarPath : (fs.existsSync(bakPath) ? bakPath : asarPath);
    if (!fs.existsSync(sourcePkg)) {
        console.error(`[错误] 找不到 app.asar 或 app.asar.bak: ${asarPath}`);
        process.exit(1);
    }

    const oldVersion = readJsonSafe(path.join(SNAPSHOT_DIR, 'package.json'), {}).version || '未知';
    const sourceBuf = fs.readFileSync(sourcePkg);
    const parsedAsar = asar.parseAsar(sourceBuf);
    const pkgRaw = parsedAsar.readFile('package.json');
    const newVersion = asar.getAsarVersion(sourcePkg) || '未知';
    console.log(`[探测] 安装路径: ${installDir}\n[版本] 旧版快照 ${oldVersion} -> 当前版本 ${newVersion}\n`);

    const loaded = auditor.loadExistingTranslations();
    const config = utils.loadConfig();
    const { frameRules, fragmentRules } = validateConfigPatterns(config);
    const isCoveredInFrame = buildFrameMatcher(config, frameRules);
    const corpus = { current: new Set(), old: new Set(), candidates: new Map() };

    const newFilesMap = scanDistJs(parsedAsar, corpus, isAuditOnly);
    const lsExtracted = scanLanguageServer(resourcesDir, corpus, isAuditOnly);
    const currentMcpData = await scanMarketplaceRpc(corpus, { resourcesDir, newVersion, isAuditOnly, isPrune, loaded });
    const { currentSkillsData, currentSidecarsData } = scanBuiltinContent(corpus, { isAuditOnly, loaded });

    console.log('[5/5] 词典审计与安全校验');
    const auditRes = auditor.auditAndCleanDictionaries(corpus.current, corpus.old, { prune: isPrune, loaded });
    const pluginsDir = path.join(process.env.USERPROFILE || '', '.gemini', 'antigravity', 'builtin', 'plugins');
    const liveness = buildLivenessCorpus({ newFilesMap, lsExtracted, mcpData: currentMcpData, skillsData: currentSkillsData, pluginsDir, config });
    const livenessRes = auditor.auditFullLiveness(liveness, { loaded, pruneDead });
    const preservedSet = new Set((config.audit?.preservedTerms || []).map(s => utils.normalizeText(s).toLowerCase()).filter(Boolean));
    const untranslated = new Map();
    const preservedSkipped = new Set();
    for (const [str, sources] of corpus.candidates) {
        const normStr = utils.normalizeText(str);
        if (!normStr || loaded.translated.has(normStr.toLowerCase()) || loaded.rules.some(re => re.test(normStr))) continue;
        if (fragmentRules.some(re => re.test(normStr) || re.test(' ' + normStr) || re.test(normStr + ' '))) continue;
        if (preservedSet.has(normStr.toLowerCase())) { preservedSkipped.add(normStr); continue; }
        const isFrameOnly = sources.length > 0 && sources.every(src => src.startsWith('内置 Sidecar'));
        if (isFrameOnly && isCoveredInFrame(normStr)) continue;
        untranslated.set(str, sources);
    }

    console.log(`  提取语料规模: ${corpus.current.size} | 候选: ${corpus.candidates.size} | 刻意保留术语: ${preservedSkipped.size} | 未覆盖: ${untranslated.size}`);
    if (untranslated.size > 0) {
        console.log(`  [未覆盖词条明细 (${untranslated.size} 条)]:`);
        for (const key of Array.from(untranslated.keys()).sort(utils.naturalCompare)) {
            console.log(`      - ${JSON.stringify(key)} [${untranslated.get(key).join(', ')}]`);
        }
    } else {
        console.log('  [√] 所有提取词条均已覆盖。');
    }

    console.log(`  [存活性] 静态死词条: ${livenessRes.deadStatic.length} | 失效正则: ${livenessRes.deadRules.length} | 重复正则: ${livenessRes.duplicateRules.length}`);
    if (livenessRes.pruned) {
        console.log(`  [√] 已清理 ${livenessRes.deadStatic.length} 条静态死词条与 ${livenessRes.deadRules.length} 条失效正则`);
    } else if (isAuditOnly) {
        if (livenessRes.deadStatic.length > 0) {
            console.log(`  [静态死词条明细 (${livenessRes.deadStatic.length} 条)]:`);
            for (const ds of livenessRes.deadStatic) console.log(`      - [${ds.file}] ${JSON.stringify(ds.key)}`);
        }
        if (livenessRes.deadRules.length > 0) {
            console.log(`  [失效正则明细 (${livenessRes.deadRules.length} 条)]:`);
            for (const dr of livenessRes.deadRules) console.log(`      - [${dr.index}] ${dr.pattern}`);
        }
        if (livenessRes.duplicateRules.length > 0) {
            console.log(`  [重复正则明细 (${livenessRes.duplicateRules.length} 条)]:`);
            for (const dup of livenessRes.duplicateRules) console.log(`      - [${dup.index}] 与 [${dup.prevIndex}] 重复: ${dup.pattern}`);
        }
    } else if (livenessRes.deadStatic.length > 0 || livenessRes.deadRules.length > 0) {
        console.log('  [提示] 存在历史未命中词条/正则，可运行 npm run audit 查看明细，或 npm run prune-dead 清理');
    }

    if (isAuditOnly) {
        const mainJs = (lsExtracted.zipFiles || []).find(z => z.filename === 'main.js')?.content || '';
        const ignoredTpls = new Set((config.audit?.ignoredTemplates || []).map(s => utils.normalizeText(s)));
        const ignoredMulti = new Set((config.audit?.ignoredMultiChild || []).map(s => utils.normalizeText(s)));
        const containerRes = (config.fragmentPatterns || []).filter(fp => fp?.containerPattern).map(fp => new RegExp(fp.containerPattern, 'i'));

        const uncoveredTemplates = bundleRewriter.extractReactUiTemplates(mainJs, utils.normalizeText).filter(t =>
            !ignoredTpls.has(t.templateKey) && !t.sims.some(s =>
                loaded.translated.has(s.toLowerCase()) || loaded.rules.some(re => re.test(s))
            )
        );
        const uncoveredMultiChild = bundleRewriter.extractReactUiMultiChild(mainJs, utils.normalizeText).filter(m => {
            if (ignoredMulti.has(m.slotView) || ignoredMulti.has(m.flat)) return false;
            const strippedFlat = utils.normalizeText(m.flat.replace(/^1+(?=[A-Za-z])/, ''));
            const strippedSlot = utils.normalizeText(m.slotView.replace(/^(?:\{x\})+/, ''));
            if (containerRes.some(re => re.test(m.flat) || re.test(strippedFlat) || re.test(m.slotView) || re.test(strippedSlot))) return false;
            if (loaded.rules.some(re => re.test(m.flat) || re.test(strippedFlat))) return false;
            return m.lits.some(lit => {
                const nt = utils.normalizeText(lit);
                return nt.length >= 3 && /[a-zA-Z]{2,}/.test(nt) &&
                    !loaded.translated.has(nt.toLowerCase()) && !loaded.rules.some(re => re.test(nt)) && !preservedSet.has(nt.toLowerCase());
            });
        });

        console.log(`  [深度审计] 未覆盖 UI 模板: ${uncoveredTemplates.length} | 未覆盖多子节点拼接句: ${uncoveredMultiChild.length}`);
        if (uncoveredTemplates.length > 0) {
            console.log(`  [未覆盖模板字符串 (${uncoveredTemplates.length} 条)]:`);
            for (const t of uncoveredTemplates) console.log(`      - ${JSON.stringify(t.raw)}  [${t.kind}${t.key ? ':' + t.key : ''}]`);
        }
        if (uncoveredMultiChild.length > 0) {
            console.log(`  [未覆盖多子节点拼接句 (${uncoveredMultiChild.length} 处)]:`);
            for (const m of uncoveredMultiChild) console.log(`      - ${JSON.stringify(m.slotView)}  (lits: ${JSON.stringify(m.lits)})`);
        }
    }

    if (auditRes.redundancies.length > 0 || auditRes.deadKeys.length > 0) {
        throw new Error(`词典安全校验未通过：重复 ${auditRes.redundancies.length} 条，死键 ${auditRes.deadKeys.length} 条`);
    }
    const smokeRes = runMemoryPatchSmokeTest(sourceBuf, parsedAsar);
    console.log(`  [√] 真实 ASAR 内存补丁冒烟校验通过 (合成 ${smokeRes.patchedCount} 个文件, 输出 ${smokeRes.outSize} 字节)`);

    if (isAuditOnly) {
        console.log('\n[√] 只读审计与校验完成（未改动 dicts/ 与 _inspect_app/）。');
        return;
    }

    if (newVersion !== '未知' && (untranslated.size === 0 || forceUpdateSnapshot)) {
        writeBaselineSnapshot(newVersion, pkgRaw, newFilesMap, lsExtracted, currentMcpData, currentSkillsData, currentSidecarsData);
        console.log(`\n[√] 基线快照与目标版本号已更新至 v${newVersion}。`);
    } else if (untranslated.size > 0) {
        console.log('\n[提示] 存在未覆盖增量，已保留当前基线快照（如确认仅保留英文，可传 --update-snapshot 推进快照）。');
    }
}

if (require.main === module) {
    main().catch(err => { console.error(`[失败] ${err.message || err}`); process.exit(1); });
}
