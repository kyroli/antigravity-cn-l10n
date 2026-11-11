const fs = require('fs');
const path = require('path');
const asar = require('./src/asar');
const utils = require('./src/utils');
const unpacker = require('./src/inspector/unpacker');
const extractor = require('./src/inspector/extractor');
const auditor = require('./src/inspector/auditor');

const SNAPSHOT_DIR = path.join(__dirname, '_inspect_app');
const SNAPSHOT_LS_ASSETS = path.join(SNAPSHOT_DIR, 'ls_assets_combined.txt');
const SNAPSHOT_MCP = path.join(SNAPSHOT_DIR, 'mcp_marketplace_snapshot.json');
const SNAPSHOT_BUILTIN_SKILLS = path.join(SNAPSHOT_DIR, 'builtin_skills_snapshot.json');
const SNAPSHOT_BUILTIN_SIDECARS = path.join(SNAPSHOT_DIR, 'builtin_sidecars_snapshot.json');

const addCandidate = (map, str, src) => { if (!map.has(str)) map.set(str, []); map.get(str).push(src); };
const readJsonSafe = (fp, fb) => { try { return fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, 'utf-8')) : fb; } catch (e) { return fb; } };

function listLocalDistJs(dir) {
    const out = new Set();
    if (!fs.existsSync(dir)) return out;
    for (const ent of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
        if (!ent.isFile()) continue;
        const rel = path.relative(dir, path.join(ent.parentPath || ent.path, ent.name)).replace(/\\/g, '/');
        if (!rel.startsWith('__mocks__/') && !rel.startsWith('test/') && rel !== 'l10nFramePreload.js' && rel.endsWith('.js') && !rel.endsWith('.test.js')) {
            out.add(rel);
        }
    }
    return out;
}

function writeBaselineSnapshot(ver, pkgRaw, newFilesMap, lsExt, mcpData, skillsData, sidecarsData) {
    const snapDistDir = path.join(SNAPSHOT_DIR, 'dist');
    fs.mkdirSync(snapDistDir, { recursive: true });
    for (const [subRel, content] of newFilesMap.entries()) {
        const tp = path.join(snapDistDir, subRel);
        fs.mkdirSync(path.dirname(tp), { recursive: true });
        fs.writeFileSync(tp, content, 'utf-8');
    }
    if (pkgRaw) fs.writeFileSync(path.join(SNAPSHOT_DIR, 'package.json'), pkgRaw, 'utf-8');
    if (lsExt.combined) fs.writeFileSync(SNAPSHOT_LS_ASSETS, lsExt.combined, 'utf-8');
    if (mcpData.plugins.length > 0 || mcpData.buildWithGoogle.length > 0 || mcpData.marketplace) {
        fs.writeFileSync(SNAPSHOT_MCP, JSON.stringify(mcpData, null, 2), 'utf-8');
    }
    if (Object.keys(skillsData).length > 0) fs.writeFileSync(SNAPSHOT_BUILTIN_SKILLS, JSON.stringify(skillsData, null, 2), 'utf-8');
    if (Object.keys(sidecarsData).length > 0) fs.writeFileSync(SNAPSHOT_BUILTIN_SIDECARS, JSON.stringify(sidecarsData, null, 2), 'utf-8');

    const state = utils.loadState();
    state.targetVersion = ver;
    utils.saveState(state);
}

async function main() {
    const args = new Set(process.argv.slice(2));
    const isAuditOnly = args.has('--audit');
    const isPrune = !isAuditOnly && args.has('--prune');
    const forceUpdateSnapshot = !isAuditOnly && args.has('--update-snapshot');

    console.log('====== Antigravity 汉化词典同步与审查工具 ======\n');
    const installDir = utils.detectInstallationDir();
    const resourcesDir = installDir ? utils.getResourcesDir(installDir) : null;
    if (!resourcesDir || !fs.existsSync(resourcesDir)) {
        console.error('\x1b[31m[错误] 无法探测 Antigravity 安装/资源目录！\x1b[0m');
        process.exit(1);
    }

    const asarPath = path.join(resourcesDir, 'app.asar'), bakPath = path.join(resourcesDir, 'app.asar.bak');
    const sourcePkg = fs.existsSync(bakPath) ? bakPath : asarPath;
    if (!fs.existsSync(sourcePkg)) {
        console.error(`\x1b[31m[错误] 找不到 app.asar 或 app.asar.bak: ${asarPath}\x1b[0m`);
        process.exit(1);
    }

    const oldVersion = readJsonSafe(path.join(SNAPSHOT_DIR, 'package.json'), {}).version || '未知';
    const parsedAsar = asar.parseAsar(fs.readFileSync(sourcePkg));
    const pkgRaw = parsedAsar.readFile('package.json');
    const newVersion = asar.getAsarVersion(sourcePkg) || '未知';
    console.log(`[探测] 安装路径: ${installDir}\n[版本] 旧版快照 ${oldVersion} -> 当前版本 ${newVersion}\n`);

    const loaded = auditor.loadExistingTranslations();
    const allNewStrings = new Map(), currentGlobalCorpus = new Set(), oldGlobalCorpus = new Set();

    // 1. Electron 壳层代码扫描
    console.log('═══ 1. Electron 壳层代码扫描 ═══');
    const oldDistDir = path.join(SNAPSHOT_DIR, 'dist');
    const oldFiles = listLocalDistJs(oldDistDir);
    const newFilesMap = asar.walkDistJs(parsedAsar, { stripPrefix: true, clean: true, exclude: new Set(['dist/l10nFramePreload.js']) });
    let added = 0, modified = 0, unchanged = 0;

    for (const [f, newClean] of newFilesMap.entries()) {
        const fileStrings = extractor.extractStringsFromJs(newClean);
        for (const s of fileStrings) currentGlobalCorpus.add(s);
        if (isAuditOnly) {
            for (const [s, srcs] of extractor.extractHighConfidenceUiStrings(newClean)) {
                addCandidate(allNewStrings, s, `壳层 UI (${Array.from(srcs).join(',')}): ${f}`);
            }
        }
        if (!oldFiles.has(f)) {
            added++;
            for (const s of fileStrings) addCandidate(allNewStrings, s, `壳层新增: ${f}`);
        } else {
            const oldClean = utils.cleanInjectedPatches(fs.readFileSync(path.join(oldDistDir, f), 'utf-8'));
            const oldStrings = extractor.extractStringsFromJs(oldClean);
            for (const s of oldStrings) oldGlobalCorpus.add(s);
            if (oldClean !== newClean) {
                modified++;
                for (const s of fileStrings) if (!oldStrings.has(s)) addCandidate(allNewStrings, s, `壳层变动: ${f}`);
            } else unchanged++;
        }
    }
    for (const f of oldFiles) {
        if (!newFilesMap.has(f)) {
            const oldClean = utils.cleanInjectedPatches(fs.readFileSync(path.join(oldDistDir, f), 'utf-8'));
            for (const s of extractor.extractStringsFromJs(oldClean)) oldGlobalCorpus.add(s);
        }
    }
    console.log(`  未变动: ${unchanged} | 新增: ${added} | 修改: ${modified}\n`);

    // 2. language_server.exe 内嵌 Web 资产扫描（按扩展名分流 JS / HTML）
    console.log('═══ 2. language_server.exe 内嵌资产扫描 ═══');
    const lsExePath = path.join(resourcesDir, 'bin', 'language_server.exe');
    let lsExtracted = { combined: '', zipFiles: [] };
    if (fs.existsSync(lsExePath)) {
        lsExtracted = unpacker.extractEmbeddedAssetsFromBinary(fs.readFileSync(lsExePath));
        const newLsStrings = new Set();
        for (const entry of lsExtracted.zipFiles) {
            if (entry.ext === '.html' || entry.ext === '.htm') {
                for (const s of unpacker.extractStringsFromHtml(entry.content)) newLsStrings.add(s);
            } else if (entry.ext === '.js' || entry.ext === '.mjs') {
                for (const s of extractor.extractStringsFromJs(entry.content)) newLsStrings.add(s);
                if (isAuditOnly) {
                    for (const [s, srcs] of extractor.extractHighConfidenceUiStrings(entry.content)) {
                        addCandidate(allNewStrings, s, `Web UI (${Array.from(srcs).join(',')})`);
                    }
                }
            }
        }
        for (const s of newLsStrings) currentGlobalCorpus.add(s);
        let lsAdded = 0;
        if (fs.existsSync(SNAPSHOT_LS_ASSETS)) {
            const oldLsStrings = extractor.extractStringsFromJs(fs.readFileSync(SNAPSHOT_LS_ASSETS, 'utf-8'));
            for (const s of oldLsStrings) oldGlobalCorpus.add(s);
            for (const s of newLsStrings) if (!oldLsStrings.has(s)) { addCandidate(allNewStrings, s, 'Web 内嵌资产新增'); lsAdded++; }
        }
        console.log(`  已解压 ${lsExtracted.zipFiles.length} 个资产包，提取 ${newLsStrings.size} 条文案 (+${lsAdded} 增量)\n`);
    } else console.log('  [!] 未找到 language_server.exe，跳过。\n');

    // 3. Connect-RPC 插件市场扫描
    console.log('═══ 3. Connect-RPC 插件市场扫描 ═══');
    const liveMcp = unpacker.fetchLiveMcpMarketplace();
    const currentMcpData = { plugins: [], buildWithGoogle: [], marketplace: null };
    const snapMcp = readJsonSafe(SNAPSHOT_MCP, null);
    const oldMcpStrings = snapMcp ? unpacker.extractMcpStrings(snapMcp) : new Set();

    if (liveMcp) {
        try {
            const [cascadePlugins, buildWithGoogle, marketplace] = await Promise.all([
                liveMcp.callRpc('/exa.language_server_pb.LanguageServerService/GetAvailableCascadePlugins', { os: 'windows', searchQuery: '' }),
                liveMcp.callRpc('/exa.language_server_pb.LanguageServerService/GetBuildWithGooglePlugins', {}),
                liveMcp.callRpc('/exa.language_server_pb.LanguageServerService/SearchMarketplace', { query: '', groupId: '', pageToken: '' })
            ]);
            if (cascadePlugins?.plugins) currentMcpData.plugins = cascadePlugins.plugins;
            if (buildWithGoogle?.plugins) currentMcpData.buildWithGoogle = buildWithGoogle.plugins;
            if (marketplace) currentMcpData.marketplace = marketplace;
            const curMcpStrings = unpacker.extractMcpStrings(currentMcpData);
            for (const s of curMcpStrings) currentGlobalCorpus.add(s);
            for (const s of oldMcpStrings) oldGlobalCorpus.add(s);
            for (const s of curMcpStrings) {
                if (s.trim().length >= 2 && (!oldMcpStrings.has(s) || !loaded.translated.has(s.toLowerCase()))) addCandidate(allNewStrings, s, '插件市场');
            }
            console.log(`  [√] 在线抓取 ${curMcpStrings.size} 条词条\n`);
        } catch (e) { console.log(`  [!] 实时 RPC 失败: ${e.message}\n`); }
    } else {
        for (const s of oldMcpStrings) { currentGlobalCorpus.add(s); oldGlobalCorpus.add(s); }
        console.log(`  [提示] Language Server 未运行，沿用本地快照 (${oldMcpStrings.size} 条)。\n`);
    }

    // 4. 内置技能与 Sidecar 扫描（仅在本地 builtin 目录存在时纳入版本对比语料）
    console.log('═══ 4. 内置技能与 Sidecar 扫描 ═══');
    const builtinBase = path.join(process.env.USERPROFILE || '', '.gemini', 'antigravity', 'builtin');
    const skillsDir = path.join(builtinBase, 'skills'), pluginsDir = path.join(builtinBase, 'plugins');
    const currentSkillsData = unpacker.scanBuiltinSkills(skillsDir);
    const currentSidecarsData = unpacker.scanBuiltinSidecars(pluginsDir);

    if (fs.existsSync(skillsDir)) {
        const oldSkills = readJsonSafe(SNAPSHOT_BUILTIN_SKILLS, {});
        for (const [n, d] of Object.entries(oldSkills)) {
            if (n) oldGlobalCorpus.add(utils.normalizeText(n));
            if (d.description) oldGlobalCorpus.add(utils.normalizeText(d.description));
        }
        for (const [sName, sData] of Object.entries(currentSkillsData)) {
            const old = oldSkills[sName];
            for (const [val, label, oldVal] of [[sData.name, '内置技能名称', old?.name], [sData.description, '内置技能描述', old?.description]]) {
                const norm = utils.normalizeText(val);
                if (!norm || norm.length < 2) continue;
                currentGlobalCorpus.add(norm);
                if (norm !== utils.normalizeText(oldVal || '') || !loaded.translated.has(norm.toLowerCase())) addCandidate(allNewStrings, norm, label);
            }
        }
    }
    if (fs.existsSync(pluginsDir)) {
        const oldSidecars = readJsonSafe(SNAPSHOT_BUILTIN_SIDECARS, {});
        const oldSidecarMap = new Map();
        for (const [k, sc] of Object.entries(oldSidecars)) {
            const set = new Set((sc.strings || []).map(utils.normalizeText).filter(Boolean));
            for (const s of set) oldGlobalCorpus.add(s);
            oldSidecarMap.set(k, set);
        }
        for (const [scKey, scData] of Object.entries(currentSidecarsData)) {
            const oldSet = oldSidecarMap.get(scKey);
            for (const s of scData.strings || []) {
                const norm = utils.normalizeText(s);
                if (!norm || norm.length < 2) continue;
                currentGlobalCorpus.add(norm);
                if (!oldSet || !oldSet.has(norm) || !loaded.translated.has(norm.toLowerCase())) addCandidate(allNewStrings, norm, `内置 Sidecar (${scKey})`);
            }
        }
    }
    console.log(`  技能: ${Object.keys(currentSkillsData).length} 个 | Sidecar: ${Object.keys(currentSidecarsData).length} 个\n`);

    // 5. 词典审计与总结
    console.log('═══ 5. 词典审计与总结 ═══');
    auditor.auditAndCleanDictionaries(currentGlobalCorpus, oldGlobalCorpus, { prune: isPrune, loaded });
    const untranslated = new Map();
    for (const [str, sources] of allNewStrings) {
        const normStr = utils.normalizeText(str);
        if (!normStr || loaded.translated.has(normStr.toLowerCase()) || loaded.rules.some(re => re.test(normStr))) continue;
        untranslated.set(str, sources);
    }

    console.log(`  提取语料规模: ${currentGlobalCorpus.size} | 候选: ${allNewStrings.size} | 未覆盖: ${untranslated.size}`);
    if (isAuditOnly) {
        if (untranslated.size > 0) {
            console.log('  [审计未覆盖示例 (前 15 条)]:');
            for (const [k, srcs] of Array.from(untranslated.entries()).slice(0, 15)) console.log(`      - "${k}" (${srcs[0]})`);
        }
        console.log('\n\x1b[32m[√] 只读审计完成（未改动 dicts/ 与 _inspect_app/）。\x1b[0m');
        return;
    }

    const outputPath = path.join(utils.DICTS_DIR, 'new_to_translate.json');
    if (untranslated.size > 0) {
        const outJson = {};
        for (const key of Array.from(untranslated.keys()).sort()) outJson[key] = '';
        fs.writeFileSync(outputPath, JSON.stringify(outJson, null, 4).replace(/\n/g, '\r\n') + '\r\n', 'utf-8');
        console.log(`\n\x1b[32m[√] 已写入 ${untranslated.size} 条待翻译词条: dicts/new_to_translate.json\x1b[0m`);
    } else {
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        console.log('\n\x1b[32m[√] 所有新增词条均已覆盖。\x1b[0m');
    }

    if (newVersion !== '未知' && (untranslated.size === 0 || forceUpdateSnapshot)) {
        writeBaselineSnapshot(newVersion, pkgRaw, newFilesMap, lsExtracted, currentMcpData, currentSkillsData, currentSidecarsData);
        console.log(`\x1b[32m[√] 基线快照与目标版本号已更新至 v${newVersion}。\x1b[0m`);
    } else if (untranslated.size > 0) {
        console.log('\x1b[33m[提示] 存在未翻译增量，已保留当前基线快照（翻译完成后请再次 sync 或传 --update-snapshot）。\x1b[0m');
    }
}

if (require.main === module) {
    main().catch(err => { console.error(err); process.exit(1); });
}
