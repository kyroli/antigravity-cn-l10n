const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const utils = require('./utils');
const { SIGNATURE_START } = utils;

function calcIntegrity(buf) {
    const blockSize = 4 * 1024 * 1024;
    const blocks = [];
    for (let i = 0; i < buf.length; i += blockSize) {
        blocks.push(crypto.createHash('sha256').update(buf.subarray(i, i + blockSize)).digest('hex'));
    }
    return {
        algorithm: 'SHA256',
        hash: crypto.createHash('sha256').update(buf).digest('hex'),
        blockSize,
        blocks
    };
}

function parseAsar(asarBuf) {
    if (!asarBuf || asarBuf.length < 16) {
        throw new Error('无效的 ASAR 字节流：体积过小');
    }
    const headerPickleSize = asarBuf.readUInt32LE(4);
    const jsonLen = asarBuf.readUInt32LE(12);
    const dataStart = 8 + headerPickleSize;
    const headerJson = asarBuf.toString('utf8', 16, 16 + jsonLen);
    const header = JSON.parse(headerJson);
    const oldData = asarBuf.subarray(dataStart);

    const getNode = (relPath) => {
        const parts = relPath.replace(/\\/g, '/').split('/').filter(Boolean);
        let cur = header;
        for (let i = 0; i < parts.length; i++) {
            const p = parts[i];
            if (!cur.files || !cur.files[p]) return null;
            cur = cur.files[p];
        }
        return cur;
    };

    const readFile = (relPath, encoding = 'utf8') => {
        const node = getNode(relPath);
        if (!node || node.unpacked || node.offset === undefined) return null;
        const off = Number(node.offset);
        const slice = oldData.subarray(off, off + node.size);
        return encoding ? slice.toString(encoding) : slice;
    };

    return {
        header,
        dataStart,
        oldData,
        getNode,
        readFile
    };
}

function patchAsarInMemory(asarBuf, patcherFn) {
    const parsed = parseAsar(asarBuf);
    const patches = typeof patcherFn === 'function' ? patcherFn(parsed) : patcherFn;
    if (!patches || Object.keys(patches).length === 0) {
        return asarBuf;
    }

    const appendedChunks = [parsed.oldData];
    let currentOffset = parsed.oldData.length;
    const expectedHashes = {};

    for (const [relPath, newContent] of Object.entries(patches)) {
        const node = parsed.getNode(relPath);
        if (!node) {
            throw new Error(`未找到 ASAR 内部文件: ${relPath}`);
        }
        const contentBuf = Buffer.isBuffer(newContent) ? newContent : Buffer.from(newContent, 'utf8');
        const integrity = calcIntegrity(contentBuf);
        node.offset = String(currentOffset);
        node.size = contentBuf.length;
        node.integrity = integrity;
        expectedHashes[relPath] = integrity.hash;
        appendedChunks.push(contentBuf);
        currentOffset += contentBuf.length;
    }

    const headerJsonBuf = Buffer.from(JSON.stringify(parsed.header), 'utf8');
    const alignedJsonLen = Math.ceil(headerJsonBuf.length / 4) * 4;
    const headerBuf = Buffer.alloc(16 + alignedJsonLen);
    headerBuf.writeUInt32LE(4, 0);
    headerBuf.writeUInt32LE(8 + alignedJsonLen, 4);
    headerBuf.writeUInt32LE(4 + alignedJsonLen, 8);
    headerBuf.writeUInt32LE(headerJsonBuf.length, 12);
    headerJsonBuf.copy(headerBuf, 16);

    const outBuf = Buffer.concat([headerBuf, ...appendedChunks]);
    verifyPatchedAsar(outBuf, expectedHashes);
    return outBuf;
}

/**
 * 写盘前/写盘后回读校验：重新解析生成的 ASAR Buffer，核对被注入文件的完整性哈希与 package.json 可读性
 */
function verifyPatchedAsar(asarBuf, expectedHashes = {}) {
    const reparsed = parseAsar(asarBuf);
    const pkg = reparsed.readFile('package.json', 'utf8');
    if (!pkg || !JSON.parse(pkg).name) {
        throw new Error('ASAR 回读校验失败：package.json 无法正常解析');
    }
    for (const [relPath, expectedHash] of Object.entries(expectedHashes)) {
        const node = reparsed.getNode(relPath);
        const fileBuf = reparsed.readFile(relPath, null);
        if (!node || !fileBuf) {
            throw new Error(`ASAR 回读校验失败：无法读取 ${relPath}`);
        }
        const actualHash = crypto.createHash('sha256').update(fileBuf).digest('hex');
        if (actualHash !== expectedHash || node.integrity?.hash !== expectedHash) {
            throw new Error(`ASAR 回读校验失败：${relPath} SHA256 校验不一致`);
        }
    }
    return true;
}

function readAsarFile(asarPathOrBuf, relPath, encoding = 'utf8') {
    try {
        const buf = Buffer.isBuffer(asarPathOrBuf) ? asarPathOrBuf : fs.readFileSync(asarPathOrBuf);
        const parsed = parseAsar(buf);
        return parsed.readFile(relPath, encoding);
    } catch (e) {
        return null;
    }
}

function getAsarVersion(asarPath) {
    if (!fs.existsSync(asarPath)) return null;
    try {
        const pkgStr = readAsarFile(asarPath, 'package.json', 'utf8');
        return pkgStr ? (JSON.parse(pkgStr).version || null) : null;
    } catch (e) {
        return null;
    }
}

function writeAtomic(targetPath, buf) {
    const tmp = `${targetPath}.tmp`;
    fs.writeFileSync(tmp, buf);
    try {
        fs.renameSync(tmp, targetPath);
    } catch (e) {
        fs.copyFileSync(tmp, targetPath);
        try { fs.unlinkSync(tmp); } catch (_) {}
    } finally {
        if (fs.existsSync(tmp)) {
            try { fs.unlinkSync(tmp); } catch (_) {}
        }
    }
}

function isPatchUpToDate(asarPath, state, currentDictsHash) {
    const currentAsarHash = utils.getFileHash(asarPath);
    return !!(state.patchedHash && currentAsarHash === state.patchedHash &&
              state.dictsHash && currentDictsHash === state.dictsHash);
}

function prepareOfficialAsar(resourcesDir, state) {
    const asarPath = path.join(resourcesDir, 'app.asar');
    const bakPath = path.join(resourcesDir, 'app.asar.bak');

    if (!fs.existsSync(asarPath)) {
        console.error(`\x1b[31m[错误] 资源目录中不存在 app.asar: ${resourcesDir}\x1b[0m`);
        return null;
    }

    const asarBuffer = fs.readFileSync(asarPath);
    const isAlreadyPatched = asarBuffer.includes(SIGNATURE_START);
    const hasBak = fs.existsSync(bakPath);

    if (hasBak) {
        const bakBuffer = fs.readFileSync(bakPath);
        if (bakBuffer.includes(SIGNATURE_START)) {
            console.error(`\x1b[31m[错误] 备份文件 app.asar.bak 已包含补丁数据，无法作为构建基线。\x1b[0m`);
            return null;
        }
        const bakHash = crypto.createHash('sha256').update(bakBuffer).digest('hex');
        const currentAsarHash = crypto.createHash('sha256').update(asarBuffer).digest('hex');

        if (!isAlreadyPatched && currentAsarHash !== bakHash) {
            writeAtomic(bakPath, asarBuffer);
            state.officialHash = currentAsarHash;
            utils.saveState(state);
            console.log(`\x1b[32m[备份] 检测到客户端版本更新，已同步更新官方基线备份 (app.asar.bak)。\x1b[0m`);
            return asarBuffer;
        }

        if (state.officialHash !== bakHash) {
            state.officialHash = bakHash;
            utils.saveState(state);
        }
        return bakBuffer;
    }

    if (isAlreadyPatched) {
        console.error(`\x1b[31m[错误] 缺少官方备份文件 app.asar.bak，且当前 app.asar 已包含补丁，无法建立初始基线。\x1b[0m`);
        return null;
    }

    writeAtomic(bakPath, asarBuffer);
    state.officialHash = crypto.createHash('sha256').update(asarBuffer).digest('hex');
    utils.saveState(state);
    console.log(`\x1b[32m[备份] 已创建官方原始文件备份 (app.asar.bak)。\x1b[0m`);
    return asarBuffer;
}

function restoreOfficialAsar(resourcesDir, state, onBeforeWrite) {
    const asarPath = path.join(resourcesDir, 'app.asar');
    const bakPath = path.join(resourcesDir, 'app.asar.bak');

    if (!fs.existsSync(bakPath)) {
        console.error('\x1b[31m[错误] 未找到官方备份文件 app.asar.bak，无法执行还原。\x1b[0m');
        return false;
    }

    const bakBuffer = fs.readFileSync(bakPath);
    if (bakBuffer.includes(SIGNATURE_START)) {
        console.error(`\x1b[31m[错误] 备份文件 app.asar.bak 已包含补丁数据，已中止还原。\x1b[0m`);
        return false;
    }

    if (onBeforeWrite && !onBeforeWrite()) return false;

    console.log('[还原] 正在从 app.asar.bak 恢复官方原始文件...');
    try {
        writeAtomic(asarPath, bakBuffer);
        fs.unlinkSync(bakPath);

        state.patchedHash = '';
        state.dictsHash = '';
        utils.saveState(state);

        console.log(`\x1b[32m[完成] 已恢复为官方原始版本。\x1b[0m`);
        return true;
    } catch (e) {
        console.error(`\x1b[31m[错误] 恢复官方文件失败: ${e.message}\x1b[0m`);
        return false;
    }
}

module.exports = {
    calcIntegrity,
    parseAsar,
    patchAsarInMemory,
    verifyPatchedAsar,
    readAsarFile,
    getAsarVersion,
    writeAtomic,
    isPatchUpToDate,
    prepareOfficialAsar,
    restoreOfficialAsar
};
