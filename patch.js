const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const utils = require('./src/utils');
const asar = require('./src/asar');
const patcher = require('./src/patcher');
const updater = require('./src/updater');

async function installPatch(resourcesDir, onBeforeWrite) {
    const asarPath = path.join(resourcesDir, 'app.asar');
    const currentDictsHash = utils.getDictsHash();
    const state = utils.loadState();
    if (asar.isPatchUpToDate(asarPath, state, currentDictsHash)) {
        console.log('[完成] 当前汉化补丁已是最新状态，无需重复构建。');
        return 'skipped';
    }

    const sourceBuf = asar.prepareOfficialAsar(resourcesDir, state);
    if (!sourceBuf) return false;

    console.log('[构建] 正在合成并校验汉化补丁...');
    const t0 = performance.now();
    const patchedBuf = asar.patchAsarInMemory(sourceBuf, reader => patcher.generatePatchMap(reader));
    const t1 = performance.now();

    if (onBeforeWrite && !onBeforeWrite()) return false;

    try {
        asar.writeAtomic(asarPath, patchedBuf);
    } catch (err) {
        console.error(`[错误] 写入 app.asar 失败（请先彻底关闭 Antigravity，或右键以管理员身份运行）: ${err.message}`);
        return false;
    }

    const targetVer = utils.getTargetVersion(state, resourcesDir);
    if (targetVer) state.targetVersion = targetVer;
    state.patchedHash = utils.getFileHash(asarPath);
    state.dictsHash = currentDictsHash;
    utils.saveState(state);

    console.log(`[完成] 汉化补丁部署成功（耗时 ${(t1 - t0).toFixed(2)} ms）。`);
    return true;
}

function restoreOfficial(resourcesDir, onBeforeWrite) {
    return asar.restoreOfficialAsar(resourcesDir, utils.loadState(), onBeforeWrite);
}

async function main() {
    const args = new Set(process.argv.slice(2));
    const isRestore = args.has('--restore');
    const skipUpdate = args.has('--no-update');

    if (!isRestore && !skipUpdate) {
        const updateRes = await updater.updateIfNeeded();
        if (updateRes && updateRes.updated) {
            console.log('[更新] 正在使用最新补丁代码继续执行...');
            const childRes = childProcess.spawnSync(
                process.execPath,
                [__filename, '--no-update'],
                { stdio: 'inherit', cwd: process.cwd() }
            );
            if (childRes.error) {
                console.error(`[错误] 重启补丁进程失败: ${childRes.error.message}`);
                process.exit(1);
            }
            process.exit(childRes.status ?? 1);
        }
    }

    const resourcesDir = utils.getResourcesDir();
    if (!resourcesDir || !fs.existsSync(resourcesDir)) {
        console.error('[错误] 未找到 Antigravity 安装目录，请确认已正确安装 Antigravity 客户端。');
        process.exit(1);
    }

    const targetVersion = utils.getTargetVersion(null, resourcesDir) || '未知';
    const localVersion = asar.getAsarVersion(path.join(resourcesDir, 'app.asar')) || '未知';
    console.log(`[版本] 适配版本: v${targetVersion} | 客户端版本: v${localVersion}`);
    if (!isRestore && targetVersion !== '未知' && localVersion !== '未知' && targetVersion !== localVersion) {
        console.warn('[警告] 客户端版本与当前汉化适配版本不一致，部分新增界面可能未完全汉化。');
    }

    const invokedByClient = utils.isInvokedByClient();
    if (invokedByClient) {
        console.log('[模式] 检测到在客户端内置终端中运行，已跳过进程关闭步骤（重启客户端后生效）。');
    }

    let didStopApp = false;
    const onBeforeWrite = () => {
        if (invokedByClient) return true;
        const stopRes = utils.closeAntigravityProcesses(resourcesDir);
        if (!stopRes) return false;
        if (stopRes === 'stopped') didStopApp = true;
        return true;
    };

    const res = isRestore ? restoreOfficial(resourcesDir, onBeforeWrite) : await installPatch(resourcesDir, onBeforeWrite);
    if (!res) process.exit(1);

    if (res === true && didStopApp && !invokedByClient) {
        console.log('[进程] 正在重新启动 Antigravity 客户端...');
        try {
            const rootDir = path.basename(resourcesDir).toLowerCase() === 'resources' ? path.dirname(resourcesDir) : resourcesDir;
            const exePath = path.join(rootDir, 'Antigravity.exe');
            if (fs.existsSync(exePath)) {
                childProcess.spawn(exePath, [], { detached: true, stdio: 'ignore', cwd: rootDir }).unref();
                console.log('[进程] 客户端已启动。');
            }
        } catch (err) {
            console.warn(`[警告] 自动启动客户端失败，请手动打开软件: ${err.message}`);
        }
    }
}

if (require.main === module) main();

module.exports = {
    installPatch,
    restoreOfficial
};
