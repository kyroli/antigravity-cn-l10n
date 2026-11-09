const fs = require('fs');
const path = require('path');
const child_process = require('child_process');

const utils = require('./src/utils');
const asar = require('./src/asar');
const patcher = require('./src/patcher');

function parseArgs(argv = process.argv.slice(2)) {
    const options = {
        restore: false,
        installDir: '',
        noKill: false
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--restore') {
            options.restore = true;
        } else if (arg === '--install-dir' && i + 1 < argv.length) {
            options.installDir = argv[++i];
        } else if (arg === '--no-kill') {
            options.noKill = true;
        } else {
            console.warn(`\x1b[33m[提示] 忽略未识别的命令行参数: ${arg}\x1b[0m`);
        }
    }
    return options;
}

async function installPatch(resourcesDir, onBeforeWrite) {
    const asarPath = path.join(resourcesDir, "app.asar");
    const currentDictsHash = utils.getDictsHash();
    const state = utils.loadState();
    if (asar.isPatchUpToDate(asarPath, state, currentDictsHash)) {
        console.log(`\x1b[32m[完成] 当前汉化补丁已是最新状态，无需重复构建。\x1b[0m`);
        return 'skipped';
    }

    const sourceBuf = asar.prepareOfficialAsar(resourcesDir, state);
    if (!sourceBuf) return false;

    console.log(`[构建] 正在合成并校验汉化补丁...`);
    const t0 = performance.now();
    const patchedBuf = asar.patchAsarInMemory(sourceBuf, (asarReader) => {
        return patcher.generatePatchMap(asarReader);
    });
    const t1 = performance.now();

    if (onBeforeWrite && !onBeforeWrite()) return false;

    try {
        asar.writeAtomic(asarPath, patchedBuf);
        asar.verifyPatchedAsar(fs.readFileSync(asarPath));
    } catch (e) {
        console.error(`\x1b[31m[错误] 写入或校验 app.asar 失败（文件被占用或权限不足）: ${e.message}\x1b[0m`);
        return false;
    }

    const targetVer = utils.getTargetVersion(state);
    if (targetVer) state.targetVersion = targetVer;
    state.patchedHash = utils.getFileHash(asarPath);
    state.dictsHash = currentDictsHash;
    utils.saveState(state);

    console.log(`\x1b[32m[完成] 汉化补丁部署成功（耗时 ${(t1 - t0).toFixed(2)} ms）。\x1b[0m`);
    return true;
}

function restoreOfficial(resourcesDir, onBeforeWrite) {
    const state = utils.loadState();
    return asar.restoreOfficialAsar(resourcesDir, state, onBeforeWrite);
}

async function main() {
    const options = parseArgs();
    const manualDir = options.installDir;
    let noKill = options.noKill;

    const resourcesDir = utils.getResourcesDir(manualDir);
    if (!resourcesDir || !fs.existsSync(resourcesDir)) {
        console.error(`\x1b[31m[错误] 未找到有效的客户端资源目录 (resources)。\x1b[0m`);
        process.exit(1);
    }

    const state = utils.loadState();
    const targetVersion = utils.getTargetVersion(state) || '未知';
    const localVersion = asar.getAsarVersion(path.join(resourcesDir, "app.asar")) || '未知';

    if (!options.restore && targetVersion !== '未知' && localVersion !== '未知' && targetVersion !== localVersion) {
        console.log(`[版本] 适配版本: v${targetVersion} | 客户端版本: v${localVersion}`);
        console.warn(`\x1b[33m[警告] 客户端版本与当前汉化适配版本不一致，部分新增界面可能未完全汉化。\x1b[0m`);
    } else {
        console.log(`\x1b[32m[版本] 适配版本: v${targetVersion} | 客户端版本: v${localVersion}\x1b[0m`);
    }

    const invokedByClient = utils.isInvokedByClient();

    if (invokedByClient) {
        noKill = true;
        console.log(`\x1b[36m[模式] 检测到在客户端内置终端中运行，已跳过进程关闭步骤（重启客户端后生效）。\x1b[0m`);
    }

    let didStopApp = false;
    const onBeforeWrite = () => {
        if (noKill) {
            if (!invokedByClient) console.log("[进程] 已启用 --no-kill 参数，保持当前运行进程不关闭。");
            return true;
        }
        if (!utils.isAppRunning()) return true;
        didStopApp = true;
        return utils.closeAntigravityProcesses();
    };

    const res = options.restore ? restoreOfficial(resourcesDir, onBeforeWrite) : await installPatch(resourcesDir, onBeforeWrite);
    if (!res) process.exit(1);

    if (res === true && didStopApp && !invokedByClient) {
        console.log("[进程] 正在重新启动 Antigravity 客户端...");
        try {
            const rootDir = resourcesDir.endsWith('resources') ? path.dirname(resourcesDir) : resourcesDir;
            const exePath = path.join(rootDir, 'Antigravity.exe');
            if (fs.existsSync(exePath)) {
                child_process.spawn(exePath, [], { detached: true, stdio: 'ignore', cwd: rootDir }).unref();
                console.log(`\x1b[32m[进程] 客户端已启动。\x1b[0m`);
            }
        } catch (e) {
            console.warn(`\x1b[33m[警告] 自动启动客户端失败，请手动打开软件: ${e.message}\x1b[0m`);
        }
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    parseArgs,
    installPatch,
    restoreOfficial
};
