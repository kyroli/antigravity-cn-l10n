const fs = require('fs');
const path = require('path');
const asar = require('./src/asar');
const utils = require('./src/utils');
const patcher = require('./src/patcher');
const unpacker = require('./src/inspector/unpacker');
const extractor = require('./src/inspector/extractor');
const auditor = require('./src/inspector/auditor');

const SNAPSHOT_DIR = path.join(__dirname, '_inspect_app');
const SNAPSHOT_LS_ASSETS = path.join(SNAPSHOT_DIR, 'ls_assets_combined.txt');
const SNAPSHOT_MCP = path.join(SNAPSHOT_DIR, 'mcp_marketplace_snapshot.json');
const SNAPSHOT_BUILTIN_SKILLS = path.join(SNAPSHOT_DIR, 'builtin_skills_snapshot.json');

async function main() {
    const isFullAudit = process.argv.includes('--audit');
    console.log("====== Antigravity 汉化词典同步与审查工具 ======\n");

    const installDir = utils.detectInstallationDir();
    if (!installDir) {
        console.error(`\x1b[31m[错误] 无法自动探测到 Antigravity 安装目录！\x1b[0m`);
        process.exit(1);
    }
    console.log(`[探测] 安装路径: ${installDir}`);

    const resourcesDir = utils.getResourcesDir(installDir);
    if (!resourcesDir || !fs.existsSync(resourcesDir)) {
        console.error(`\x1b[31m[错误] 资源目录不存在: ${resourcesDir}\x1b[0m`);
        process.exit(1);
    }

    const asarPath = path.join(resourcesDir, "app.asar");
    const bakPath = path.join(resourcesDir, "app.asar.bak");
    if (!fs.existsSync(asarPath) && !fs.existsSync(bakPath)) {
        console.error(`\x1b[31m[错误] 找不到 app.asar 或 app.asar.bak: ${asarPath}\x1b[0m`);
        process.exit(1);
    }

    const oldPkgPath = path.join(SNAPSHOT_DIR, 'package.json');
    let oldVersion = '未知';
    if (fs.existsSync(oldPkgPath)) {
        try {
            oldVersion = JSON.parse(fs.readFileSync(oldPkgPath, 'utf-8')).version || '未知';
        } catch (e) {}
    }
    console.log(`[旧版快照] ${oldVersion} (${SNAPSHOT_DIR})`);

    const sourcePkg = fs.existsSync(bakPath) ? bakPath : asarPath;
    console.log(`[读取] 正在解析 ${path.basename(sourcePkg)}...`);
    const asarBuffer = fs.readFileSync(sourcePkg);
    const parsedAsar = asar.parseAsar(asarBuffer);

    let newVersion = '未知';
    const pkgRaw = parsedAsar.readFile('package.json');
    if (pkgRaw) {
        try { newVersion = JSON.parse(pkgRaw).version || '未知'; } catch (e) {}
    }
    console.log(`[当前版本] ${newVersion}\n`);

    if (oldVersion === newVersion) {
        console.log(`[提示] 版本号未变更 (${oldVersion})，正在执行差集提取与词典审查...\n`);
    } else {
        console.log(`[版本变更] ${oldVersion} → ${newVersion}\n`);
    }

    const allNewStrings = new Map();
    const currentGlobalCorpus = new Set();
    const oldGlobalCorpus = new Set();

    // 1. Electron 壳层代码扫描
    console.log("═══════════════════════════════════════════");
    console.log("  1. Electron 壳层代码扫描");
    console.log("═══════════════════════════════════════════");

    const oldDistDir = path.join(SNAPSHOT_DIR, 'dist');
    const oldFiles = fs.existsSync(oldDistDir)
        ? new Set(unpacker.getRelativeFiles(oldDistDir, oldDistDir).filter(f => f.endsWith('.js') && !f.endsWith('.test.js')).map(f => f.replace(/\\/g, '/')))
        : new Set();

    const rawAsarFiles = unpacker.walkAsarJsFiles(parsedAsar);
    const newFilesMap = new Map();
    for (const [subRel, rawContent] of rawAsarFiles.entries()) {
        newFilesMap.set(subRel, patcher.cleanInjectedPatches(rawContent));
    }

    const addedFiles = [];
    const removedFiles = [];
    const modifiedFiles = [];
    const unchangedFiles = [];

    for (const [f, newClean] of newFilesMap.entries()) {
        const fileStrings = extractor.extractStringsFromJs(newClean);
        for (const s of fileStrings) currentGlobalCorpus.add(s);

        if (isFullAudit) {
            for (const [s, srcs] of extractor.extractHighConfidenceUiStrings(newClean)) {
                if (!allNewStrings.has(s)) allNewStrings.set(s, []);
                allNewStrings.get(s).push(`壳层 UI 属性 (${Array.from(srcs).join(',')}): ${f}`);
            }
        }

        if (!oldFiles.has(f)) {
            addedFiles.push(f);
            for (const s of fileStrings) {
                if (!allNewStrings.has(s)) allNewStrings.set(s, []);
                allNewStrings.get(s).push(`壳层新增文件: ${f}`);
            }
        } else {
            const oldRaw = fs.readFileSync(path.join(oldDistDir, f), 'utf-8');
            const oldClean = patcher.cleanInjectedPatches(oldRaw);
            const oldStrings = extractor.extractStringsFromJs(oldClean);
            for (const s of oldStrings) oldGlobalCorpus.add(s);

            if (oldClean !== newClean) {
                modifiedFiles.push(f);
                for (const s of fileStrings) {
                    if (!oldStrings.has(s)) {
                        if (!allNewStrings.has(s)) allNewStrings.set(s, []);
                        allNewStrings.get(s).push(`壳层变动: ${f}`);
                    }
                }
            } else {
                unchangedFiles.push(f);
            }
        }
    }

    for (const f of oldFiles) {
        if (!newFilesMap.has(f)) {
            removedFiles.push(f);
            const oldRaw = fs.readFileSync(path.join(oldDistDir, f), 'utf-8');
            const oldClean = patcher.cleanInjectedPatches(oldRaw);
            for (const s of extractor.extractStringsFromJs(oldClean)) oldGlobalCorpus.add(s);
        }
    }

    console.log(`  未变动: ${unchangedFiles.length} 个文件`);
    if (addedFiles.length > 0) {
        console.log(`\x1b[32m  新增:   ${addedFiles.length} 个文件\x1b[0m`);
        for (const f of addedFiles) console.log(`    + ${f}`);
    }
    if (modifiedFiles.length > 0) {
        console.log(`\x1b[33m  修改:   ${modifiedFiles.length} 个文件\x1b[0m`);
        for (const f of modifiedFiles) console.log(`    ~ ${f}`);
    }
    if (removedFiles.length > 0) {
        console.log(`\x1b[31m  删除:   ${removedFiles.length} 个文件\x1b[0m`);
        for (const f of removedFiles) console.log(`    - ${f}`);
    }
    if (addedFiles.length === 0 && modifiedFiles.length === 0 && removedFiles.length === 0) {
        console.log(`\x1b[32m  [√] Electron 壳层代码文件完全一致\x1b[0m`);
    }
    console.log("");

    // 2. language_server.exe 内嵌 Web 资产扫描
    console.log("═══════════════════════════════════════════");
    console.log("  2. language_server.exe 内嵌 Web 资产扫描");
    console.log("═══════════════════════════════════════════");
    const lsExePath = path.join(resourcesDir, "bin", "language_server.exe");
    let lsExtracted = { combined: '', zipFiles: [] };

    if (fs.existsSync(lsExePath)) {
        console.log(`  [读取] 正在解析 language_server.exe (${(fs.statSync(lsExePath).size / 1024 / 1024).toFixed(2)} MB)...`);
        const tLs0 = performance.now();
        const lsBuffer = fs.readFileSync(lsExePath);
        lsExtracted = unpacker.extractEmbeddedAssetsFromBinary(lsBuffer);
        const tLs1 = performance.now();
        console.log(`\x1b[32m  [√] 已解压 ${lsExtracted.zipFiles.length} 个内嵌 Web 资产包 (${(lsExtracted.combined.length / 1024 / 1024).toFixed(2)} MB 文本，耗时 ${(tLs1 - tLs0).toFixed(2)} ms)\x1b[0m`);

        const newLsStrings = extractor.extractStringsFromJs(lsExtracted.combined);
        for (const s of newLsStrings) currentGlobalCorpus.add(s);

        if (isFullAudit) {
            for (const [s, srcs] of extractor.extractHighConfidenceUiStrings(lsExtracted.combined)) {
                if (!allNewStrings.has(s)) allNewStrings.set(s, []);
                allNewStrings.get(s).push(`Web UI 属性 (${Array.from(srcs).join(',')})`);
            }
        }

        if (fs.existsSync(SNAPSHOT_LS_ASSETS)) {
            console.log(`  [比对] 正在与旧版 Web 资产快照进行差集比对...`);
            const oldLsText = fs.readFileSync(SNAPSHOT_LS_ASSETS, 'utf-8');
            const oldLsStrings = extractor.extractStringsFromJs(oldLsText);
            for (const s of oldLsStrings) oldGlobalCorpus.add(s);

            let lsAddedCount = 0;
            for (const s of newLsStrings) {
                if (!oldLsStrings.has(s)) {
                    if (!allNewStrings.has(s)) allNewStrings.set(s, []);
                    allNewStrings.get(s).push('Web 内嵌资产新增');
                    lsAddedCount++;
                }
            }
            console.log(`\x1b[32m  [√] Web 资产比对完成：+${lsAddedCount} 个新增候选词条\x1b[0m`);
        } else {
            console.log(`  [提示] 未找到旧版 Web 资产快照（首次建立或尚未保存快照）。`);
        }
    } else {
        console.log(`  [!] 未找到 language_server.exe，跳过二进制资源提取。`);
    }
    console.log("");

    // 3. Connect-RPC 插件市场扫描
    console.log("═══════════════════════════════════════════");
    console.log("  3. Connect-RPC 插件市场扫描");
    console.log("═══════════════════════════════════════════");
    const liveMcpFetcher = unpacker.fetchLiveMcpMarketplace();
    const currentMcpData = { plugins: [], buildWithGoogle: [], allPlugins: [], marketplace: null };

    if (liveMcpFetcher) {
        console.log(`  [探测] 正在连接运行中的 Language Server (端口: ${liveMcpFetcher.livePort}) 获取插件市场数据...`);
        try {
            const cascadePlugins = await liveMcpFetcher.callRpc('/exa.language_server_pb.LanguageServerService/GetAvailableCascadePlugins', { os: 'windows', searchQuery: '' });
            const buildWithGoogle = await liveMcpFetcher.callRpc('/exa.language_server_pb.LanguageServerService/GetBuildWithGooglePlugins', {});
            const allPlugins = await liveMcpFetcher.callRpc('/exa.language_server_pb.LanguageServerService/GetAllPlugins', {});
            const marketplace = await liveMcpFetcher.callRpc('/exa.language_server_pb.LanguageServerService/SearchMarketplace', { query: '', groupId: '', pageToken: '' });

            if (cascadePlugins && cascadePlugins.plugins) currentMcpData.plugins = cascadePlugins.plugins;
            if (buildWithGoogle && buildWithGoogle.plugins) currentMcpData.buildWithGoogle = buildWithGoogle.plugins;
            if (allPlugins && allPlugins.plugins) currentMcpData.allPlugins = allPlugins.plugins;
            if (marketplace) currentMcpData.marketplace = marketplace;

            const currentMcpStrings = unpacker.extractMcpStrings(currentMcpData);
            for (const s of currentMcpStrings) currentGlobalCorpus.add(s);

            let oldMcpStrings = new Set();
            if (fs.existsSync(SNAPSHOT_MCP)) {
                try {
                    const oldMcpData = JSON.parse(fs.readFileSync(SNAPSHOT_MCP, 'utf-8'));
                    oldMcpStrings = unpacker.extractMcpStrings(oldMcpData);
                    for (const s of oldMcpStrings) oldGlobalCorpus.add(s);
                } catch (e) {}
            }

            const { translated: existingTranslated } = auditor.loadExistingTranslations();
            for (const s of currentMcpStrings) {
                if (s && s.trim().length >= 2 && (!oldMcpStrings.has(s) || !existingTranslated.has(s.toLowerCase()))) {
                    if (!allNewStrings.has(s)) allNewStrings.set(s, []);
                    allNewStrings.get(s).push('插件市场');
                }
            }

            const totalMarketplaceCount = currentMcpData.plugins.length + currentMcpData.buildWithGoogle.length + (currentMcpData.marketplace?.customizations?.length || 0);
            console.log(`\x1b[32m  [√] 已获取 ${totalMarketplaceCount} 个插件与扩展条目 (${currentMcpStrings.size} 个词条)\x1b[0m`);
        } catch (e) {
            console.log(`  [!] 实时插件市场抓取跳过: ${e.message}`);
        }
    } else {
        console.log(`  [提示] Language Server 当前未运行，已跳过实时 RPC 请求（使用本地快照比对）。`);
        if (fs.existsSync(SNAPSHOT_MCP)) {
            try {
                const snapMcp = JSON.parse(fs.readFileSync(SNAPSHOT_MCP, 'utf-8'));
                for (const s of unpacker.extractMcpStrings(snapMcp)) {
                    currentGlobalCorpus.add(s);
                    oldGlobalCorpus.add(s);
                }
            } catch (e) {}
        }
    }
    console.log("");

    // 4. 内置技能 (Builtin Skills) 扫描
    console.log("═══════════════════════════════════════════");
    console.log("  4. 内置技能 (Builtin Skills) 扫描");
    console.log("═══════════════════════════════════════════");
    const builtinSkillsDir = path.join(process.env.USERPROFILE || '', '.gemini', 'antigravity', 'builtin', 'skills');
    let currentSkillsData = {};

    if (fs.existsSync(builtinSkillsDir)) {
        try {
            currentSkillsData = unpacker.scanBuiltinSkills(builtinSkillsDir);
            for (const sData of Object.values(currentSkillsData)) {
                if (sData.name) currentGlobalCorpus.add(utils.normalizeText(sData.name));
                if (sData.description) currentGlobalCorpus.add(utils.normalizeText(sData.description));
            }

            let oldSkillsData = {};
            if (fs.existsSync(SNAPSHOT_BUILTIN_SKILLS)) {
                try {
                    oldSkillsData = JSON.parse(fs.readFileSync(SNAPSHOT_BUILTIN_SKILLS, 'utf-8'));
                    for (const [oldName, oldData] of Object.entries(oldSkillsData)) {
                        if (oldName) oldGlobalCorpus.add(utils.normalizeText(oldName));
                        if (oldData.description) oldGlobalCorpus.add(utils.normalizeText(oldData.description));
                    }
                } catch (e) {}
            }

            const { translated: existingSkillTranslated } = auditor.loadExistingTranslations();
            for (const [sName, sData] of Object.entries(currentSkillsData)) {
                const wasInSnapshot = Boolean(oldSkillsData[sName]);
                if (sData.name && sData.name.trim().length >= 2) {
                    if (!wasInSnapshot || !existingSkillTranslated.has(sData.name.toLowerCase())) {
                        if (!allNewStrings.has(sData.name)) allNewStrings.set(sData.name, []);
                        allNewStrings.get(sData.name).push('内置技能名称');
                    }
                }
                if (sData.description && sData.description.trim().length >= 2) {
                    const normDesc = utils.normalizeText(sData.description);
                    const oldDesc = wasInSnapshot && oldSkillsData[sName].description ? utils.normalizeText(oldSkillsData[sName].description) : '';
                    if (normDesc !== oldDesc || !existingSkillTranslated.has(normDesc.toLowerCase())) {
                        if (!allNewStrings.has(normDesc)) allNewStrings.set(normDesc, []);
                        allNewStrings.get(normDesc).push('内置技能描述');
                    }
                }
            }
            console.log(`\x1b[32m  [√] 已扫描 ${Object.keys(currentSkillsData).length} 个内置技能\x1b[0m`);
        } catch (e) {
            console.log(`  [!] 内置技能扫描异常: ${e.message}`);
        }
    } else {
        console.log(`  [提示] 未检测到内置技能目录 (${builtinSkillsDir})。`);
    }
    console.log("");

    // 5. 注入入口文件检查
    console.log("═══════════════════════════════════════════");
    console.log("  5. 注入入口文件检查");
    console.log("═══════════════════════════════════════════");

    const entryChecks = [
        { file: 'dist/main.js', desc: '主进程入口 (dist/main.js)' },
        { file: 'dist/preload.js', desc: '主窗口预加载 (dist/preload.js)' },
        { file: 'dist/ideInstall/wizardPreload.js', desc: 'IDE 向导预加载 (dist/ideInstall/wizardPreload.js)' }
    ];

    for (const check of entryChecks) {
        const content = parsedAsar.readFile(check.file);
        if (content) {
            console.log(`\x1b[32m  [√] ${check.desc} -> 存在\x1b[0m`);
        } else {
            console.log(`\x1b[31m  [×] ${check.desc} -> 在 app.asar 中未找到\x1b[0m`);
        }
    }
    console.log("");

    // 6. 词典审查与清理
    console.log("═══════════════════════════════════════════");
    console.log("  6. 词典审查与清理");
    console.log("═══════════════════════════════════════════");

    auditor.auditAndCleanDictionaries(currentGlobalCorpus, oldGlobalCorpus);

    const { translated: latestTranslated, rules } = auditor.loadExistingTranslations();
    const untranslated = new Map();
    for (const [str, sources] of allNewStrings) {
        const normStr = utils.normalizeText(str);
        const lowerStr = normStr.toLowerCase();

        if (latestTranslated.has(lowerStr)) continue;

        let matchedRule = false;
        for (const ruleRegex of rules) {
            if (ruleRegex.test(normStr)) { matchedRule = true; break; }
        }
        if (matchedRule) continue;

        untranslated.set(str, sources);
    }

    console.log("");
    console.log("═══════════════════════════════════════════");
    console.log("  总结与报告");
    console.log("═══════════════════════════════════════════");
    console.log(`  候选词条总数:     ${allNewStrings.size} 个`);
    console.log(`  待翻译词条数:     ${untranslated.size} 个`);
    console.log(`  当前语料集规模:   ${currentGlobalCorpus.size} 个字符串`);

    const outputPath = path.join(utils.DICTS_DIR, 'new_to_translate.json');
    if (untranslated.size > 0) {
        const outputJson = {};
        const sortedKeys = Array.from(untranslated.keys()).sort();
        for (const key of sortedKeys) {
            outputJson[key] = "";
        }
        fs.writeFileSync(outputPath, JSON.stringify(outputJson, null, 4).replace(/\n/g, '\r\n') + '\r\n', 'utf-8');
        console.log(`\n\x1b[32m[√] 已写入 ${untranslated.size} 条待翻译词条: dicts/new_to_translate.json\x1b[0m`);
    } else {
        console.log(`\n\x1b[32m[√] 所有新增词条均已覆盖，无待翻译项。\x1b[0m`);
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    }

    if (newVersion && newVersion !== '未知') {
        console.log(`\n[快照] 正在更新基线快照 (v${newVersion})...`);

        if (!fs.existsSync(SNAPSHOT_DIR)) {
            fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
        }
        const snapDistDir = path.join(SNAPSHOT_DIR, 'dist');
        if (!fs.existsSync(snapDistDir)) fs.mkdirSync(snapDistDir, { recursive: true });

        for (const f of removedFiles) {
            const oldPath = path.join(snapDistDir, f);
            if (fs.existsSync(oldPath)) {
                try { fs.unlinkSync(oldPath); } catch (e) {}
            }
        }

        for (const [subRel, content] of newFilesMap.entries()) {
            const targetPath = path.join(snapDistDir, subRel);
            const parentDir = path.dirname(targetPath);
            if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
            fs.writeFileSync(targetPath, content, 'utf-8');
        }
        if (pkgRaw) {
            fs.writeFileSync(path.join(SNAPSHOT_DIR, 'package.json'), pkgRaw, 'utf-8');
        }
        if (lsExtracted.combined) {
            fs.writeFileSync(SNAPSHOT_LS_ASSETS, lsExtracted.combined, 'utf-8');
        }
        if (currentMcpData.plugins.length > 0 || currentMcpData.buildWithGoogle.length > 0 || currentMcpData.marketplace) {
            fs.writeFileSync(SNAPSHOT_MCP, JSON.stringify(currentMcpData, null, 2), 'utf-8');
        }
        if (Object.keys(currentSkillsData).length > 0) {
            fs.writeFileSync(SNAPSHOT_BUILTIN_SKILLS, JSON.stringify(currentSkillsData, null, 2), 'utf-8');
        }

        const state = utils.loadState();
        state.targetVersion = newVersion;
        utils.saveState(state);

        console.log(`\x1b[32m[√] 基线快照与适配版本号已更新至 v${newVersion}。\x1b[0m`);
    }
}

if (require.main === module) {
    main().catch(err => {
        console.error(err);
        process.exit(1);
    });
}
