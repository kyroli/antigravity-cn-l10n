const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const utils = require('./utils');
const { SIGNATURE_START } = utils;

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

function calcIntegrity(buf) {
    const blockSize = 4 * 1024 * 1024;
    const blocks = [];
    for (let i = 0; i < buf.length; i += blockSize) blocks.push(sha256(buf.subarray(i, i + blockSize)));
    return { algorithm: 'SHA256', hash: sha256(buf), blockSize, blocks };
}

function parseAsar(asarBuf) {
    if (!asarBuf || asarBuf.length < 16) throw new Error('无效的 ASAR 字节流：体积过小');
    const headerPickleSize = asarBuf.readUInt32LE(4);
    const jsonLen = asarBuf.readUInt32LE(12);
    const dataStart = 8 + headerPickleSize;
    const header = JSON.parse(asarBuf.toString('utf8', 16, 16 + jsonLen));
    const oldData = asarBuf.subarray(dataStart);

    const getNode = (relPath) => {
        let cur = header;
        for (const p of relPath.replace(/\\/g, '/').split('/').filter(Boolean)) {
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

    return { header, dataStart, oldData, getNode, readFile };
}

/**
 * 统一遍历 ASAR 内 dist/ 目录下的 .js 文件。
 */
function walkDistJs(parsedAsar, options = {}) {
    const parsed = Buffer.isBuffer(parsedAsar) ? parseAsar(parsedAsar) : parsedAsar;
    const filesMap = new Map();
    const distNode = parsed && parsed.header && parsed.header.files && parsed.header.files.dist;
    if (!distNode || !distNode.files || typeof parsed.readFile !== 'function') return filesMap;

    const { stripPrefix = false, includeTests = false, clean = false, exclude = null } = options;
    const isExcluded = typeof exclude === 'function'
        ? exclude
        : (exclude ? (rel => (exclude instanceof Set ? exclude.has(rel) : exclude.includes(rel))) : null);

    const walk = (node, prefix) => {
        for (const [name, child] of Object.entries(node.files || {})) {
            const rel = `${prefix}/${name}`;
            if (!includeTests && (rel === 'dist/__mocks__' || rel === 'dist/test')) continue;
            if (child.files) { walk(child, rel); continue; }
            if (!rel.endsWith('.js') || (!includeTests && rel.endsWith('.test.js'))) continue;
            if (isExcluded && isExcluded(rel)) continue;
            const content = parsed.readFile(rel, 'utf8');
            if (content !== null) filesMap.set(stripPrefix ? rel.slice(5) : rel, clean ? utils.cleanInjectedPatches(content) : content);
        }
    };
    walk(distNode, 'dist');
    return filesMap;
}

/**
 * 定位或新建 ASAR header 中的文件节点，自动创建缺失的嵌套父目录并拒绝路径类型冲突。
 */
function ensureAsarFileNode(header, relPath) {
    const parts = String(relPath || '').replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length === 0) throw new Error(`无效 ASAR 路径: ${relPath}`);

    let cur = header;
    for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i];
        if (!cur.files || typeof cur.files !== 'object') throw new Error(`ASAR 路径冲突，父节点不是目录: ${parts.slice(0, i).join('/')}`);
        if (!cur.files[seg]) cur.files[seg] = { files: {} };
        else if (!cur.files[seg].files) throw new Error(`ASAR 路径冲突，文件被当作目录: ${parts.slice(0, i + 1).join('/')}`);
        cur = cur.files[seg];
    }

    const leaf = parts[parts.length - 1];
    if (!cur.files || typeof cur.files !== 'object') throw new Error(`ASAR 路径冲突，父节点不是目录: ${parts.slice(0, -1).join('/')}`);
    if (cur.files[leaf] && cur.files[leaf].files) throw new Error(`ASAR 路径冲突，目标路径已是目录: ${relPath}`);
    if (!cur.files[leaf]) cur.files[leaf] = {};
    delete cur.files[leaf].unpacked;
    return cur.files[leaf];
}

function patchAsarInMemory(asarBuf, patcherFn) {
    const parsed = parseAsar(asarBuf);
    const patches = typeof patcherFn === 'function' ? patcherFn(parsed) : patcherFn;
    if (!patches || Object.keys(patches).length === 0) return asarBuf;

    const appendedChunks = [parsed.oldData];
    let currentOffset = parsed.oldData.length;
    const expectedHashes = {};

    for (const [relPath, newContent] of Object.entries(patches)) {
        const existing = parsed.getNode(relPath);
        if (existing && existing.files) throw new Error(`ASAR 路径冲突，目标路径已是目录: ${relPath}`);
        if (existing) delete existing.unpacked;
        const node = existing || ensureAsarFileNode(parsed.header, relPath);
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
 * 写盘前/写盘后回读校验：重新解析生成的 ASAR Buffer，核对被注入文件的完整性哈希与 package.json 可读性。
 */
function verifyPatchedAsar(asarBuf, expectedHashes = {}) {
    const reparsed = parseAsar(asarBuf);
    const pkg = reparsed.readFile('package.json', 'utf8');
    if (!pkg || !JSON.parse(pkg).name) throw new Error('ASAR 回读校验失败：package.json 无法正常解析');
    for (const [relPath, expectedHash] of Object.entries(expectedHashes)) {
        const node = reparsed.getNode(relPath);
        const fileBuf = reparsed.readFile(relPath, null);
        if (!node || !fileBuf) throw new Error(`ASAR 回读校验失败：无法读取 ${relPath}`);
        if (sha256(fileBuf) !== expectedHash || node.integrity?.hash !== expectedHash) {
            throw new Error(`ASAR 回读校验失败：${relPath} SHA256 校验不一致`);
        }
    }
    return true;
}

function readAsarFile(asarPathOrBuf, relPath, encoding = 'utf8') {
    try {
        const buf = Buffer.isBuffer(asarPathOrBuf) ? asarPathOrBuf : fs.readFileSync(asarPathOrBuf);
        return parseAsar(buf).readFile(relPath, encoding);
    } catch (e) { return null; }
}

function getAsarVersion(asarPath) {
    if (!fs.existsSync(asarPath)) return null;
    try {
        const pkgStr = readAsarFile(asarPath, 'package.json', 'utf8');
        return pkgStr ? (JSON.parse(pkgStr).version || null) : null;
    } catch (e) { return null; }
}

function writeAtomic(targetPath, buf) {
    const tmp = `${targetPath}.tmp`;
    fs.writeFileSync(tmp, buf);
    try { fs.renameSync(tmp, targetPath); }
    catch (e) { fs.copyFileSync(tmp, targetPath); }
    finally { if (fs.existsSync(tmp)) try { fs.unlinkSync(tmp); } catch (_) {} }
}

function isPatchUpToDate(asarPath, state, currentDictsHash) {
    const currentAsarHash = utils.getFileHash(asarPath);
    return !!(state.patchedHash && currentAsarHash === state.patchedHash && state.dictsHash && currentDictsHash === state.dictsHash);
}

function readCleanBackup(bakPath, rejectMsg) {
    const bakBuffer = fs.readFileSync(bakPath);
    if (bakBuffer.includes(SIGNATURE_START)) {
        console.error(`[错误] 备份文件 app.asar.bak 已包含补丁数据，${rejectMsg}`);
        return null;
    }
    return bakBuffer;
}

function prepareOfficialAsar(resourcesDir, state) {
    const asarPath = path.join(resourcesDir, 'app.asar');
    const bakPath = path.join(resourcesDir, 'app.asar.bak');
    if (!fs.existsSync(asarPath)) {
        console.error(`[错误] 资源目录中不存在 app.asar: ${resourcesDir}`);
        return null;
    }
    const asarBuffer = fs.readFileSync(asarPath);
    const isAlreadyPatched = asarBuffer.includes(SIGNATURE_START);

    if (fs.existsSync(bakPath)) {
        const bakBuffer = readCleanBackup(bakPath, '无法作为构建基线。');
        if (!bakBuffer) return null;
        const bakHash = sha256(bakBuffer), currentAsarHash = sha256(asarBuffer);
        if (!isAlreadyPatched && currentAsarHash !== bakHash) {
            writeAtomic(bakPath, asarBuffer);
            state.officialHash = currentAsarHash;
            utils.saveState(state);
            console.log('[备份] 检测到客户端版本更新，已同步更新官方基线备份 (app.asar.bak)。');
            return asarBuffer;
        }
        if (state.officialHash !== bakHash) { state.officialHash = bakHash; utils.saveState(state); }
        return bakBuffer;
    }

    if (isAlreadyPatched) {
        console.error('[错误] 缺少官方备份文件 app.asar.bak，且当前 app.asar 已包含补丁，无法建立初始基线。');
        return null;
    }
    writeAtomic(bakPath, asarBuffer);
    state.officialHash = sha256(asarBuffer);
    utils.saveState(state);
    console.log('[备份] 已创建官方原始文件备份 (app.asar.bak)。');
    return asarBuffer;
}

function restoreOfficialAsar(resourcesDir, state, onBeforeWrite) {
    const asarPath = path.join(resourcesDir, 'app.asar');
    const bakPath = path.join(resourcesDir, 'app.asar.bak');
    if (!fs.existsSync(bakPath)) {
        console.error('[错误] 未找到官方备份文件 app.asar.bak，无法执行还原。');
        return false;
    }
    const bakBuffer = readCleanBackup(bakPath, '已中止还原。');
    if (!bakBuffer || (onBeforeWrite && !onBeforeWrite())) return false;

    console.log('[还原] 正在从 app.asar.bak 恢复官方原始文件...');
    try {
        writeAtomic(asarPath, bakBuffer);
        fs.unlinkSync(bakPath);
        state.patchedHash = '';
        state.dictsHash = '';
        utils.saveState(state);
        console.log('[完成] 已恢复为官方原始版本。');
        return true;
    } catch (e) {
        console.error(`[错误] 恢复官方文件失败: ${e.message}`);
        return false;
    }
}

module.exports = {
    parseAsar, walkDistJs, ensureAsarFileNode, patchAsarInMemory,
    verifyPatchedAsar, readAsarFile, getAsarVersion, writeAtomic,
    isPatchUpToDate, prepareOfficialAsar, restoreOfficialAsar
};
