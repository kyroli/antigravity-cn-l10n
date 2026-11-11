const fs = require('fs');
const path = require('path');
const utils = require('../utils');

function loadRawDictionaries() {
    const rawByFile = {};
    for (const df of utils.DICT_FILES) {
        const fp = path.join(utils.DICTS_DIR, df);
        if (!fs.existsSync(fp)) continue;
        try { rawByFile[df] = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) {}
    }
    return rawByFile;
}

function loadExistingTranslations() {
    const rawByFile = loadRawDictionaries();
    const translated = new Set();
    for (const dict of Object.values(rawByFile)) {
        for (const k of Object.keys(dict)) {
            const normK = utils.normalizeText(k);
            if (normK) translated.add(normK.toLowerCase());
        }
    }
    const ruleEntries = utils.loadRules().map((r, index) => {
        try { return { index, pattern: r.pattern, replacement: r.replacement, regex: new RegExp(r.pattern, 'i') }; }
        catch (e) { return null; }
    }).filter(Boolean);

    return { rawByFile, translated, rules: ruleEntries.map(r => r.regex), ruleEntries };
}

/**
 * 审计静态词典（重复、恒等死键、失效候选）；默认严格只读，仅在 prune: true 时写回清理。
 * 契约：允许静态词条精准覆盖通用正则，不将静态词条命中 rules.json 视为冲突。
 */
function auditAndCleanDictionaries(currentGlobalCorpus, oldGlobalCorpus, options = {}) {
    const { prune = false, loaded = null } = options;
    const state = loaded || loadExistingTranslations();
    const dictData = state.rawByFile || loadRawDictionaries();

    const toLowerSet = col => new Set(Array.from(col || [], s => utils.normalizeText(s).toLowerCase()).filter(Boolean));
    const currentLower = toLowerSet(currentGlobalCorpus);
    const oldLower = toLowerSet(oldGlobalCorpus);

    const globalLowerMap = new Map();
    const redundancies = [], deadKeys = [], dictHits = [];
    let totalEntries = 0, coveredInCorpus = 0;

    for (const df of utils.DICT_FILES) {
        if (!dictData[df]) continue;
        for (const [k, v] of Object.entries(dictData[df])) {
            totalEntries++;
            const lowerK = utils.normalizeText(k).toLowerCase();
            if (!lowerK) continue;

            if (typeof v === 'string' && v === k) deadKeys.push({ file: df, key: k });
            if (globalLowerMap.has(lowerK)) {
                const prev = globalLowerMap.get(lowerK);
                redundancies.push({ file: df, key: k, reason: `已在 ${prev.file} 中存在 "${prev.originalKey}"` });
            } else {
                globalLowerMap.set(lowerK, { file: df, originalKey: k });
            }

            if (currentLower.has(lowerK)) coveredInCorpus++;
            else if (oldLower.has(lowerK)) dictHits.push({ file: df, key: k, val: v, reason: '当前版本语料中已移除' });
        }
    }

    const logList = (items, warnMsg, okMsg, fmt) => {
        if (items.length > 0) {
            console.log(`\x1b[33m  [!] 发现 ${items.length} 个${warnMsg}:\x1b[0m`);
            items.slice(0, 15).forEach(item => console.log(`      - ${fmt(item)}`));
        } else {
            console.log(`\x1b[32m  [√] ${okMsg}\x1b[0m`);
        }
    };
    logList(redundancies, '大小写或跨文件重复词条', '词典无大小写或跨文件重复', r => `[${r.file}] "${r.key}" (${r.reason})`);
    logList(deadKeys, '恒等空转死键 (key === value)', '词典无恒等死键', d => `[${d.file}] "${d.key}"`);
    console.log(`  [统计] 静态词条总数 ${totalEntries} 条（命中当前提取语料 ${coveredInCorpus} 条），正则规则 ${state.ruleEntries.length} 条`);

    let pruned = false;
    if (dictHits.length > 0) {
        logList(dictHits, '疑似已废弃词条', '', dh => `[${dh.file}] "${dh.key}" (${dh.reason})`);
        if (prune) {
            const touched = new Set();
            for (const dh of dictHits) {
                if (dictData[dh.file] && Object.prototype.hasOwnProperty.call(dictData[dh.file], dh.key)) {
                    delete dictData[dh.file][dh.key];
                    touched.add(dh.file);
                }
            }
            for (const df of touched) {
                const sorted = {};
                Object.keys(dictData[df]).sort(utils.naturalCompare).forEach(k => { sorted[k] = dictData[df][k]; });
                fs.writeFileSync(path.join(utils.DICTS_DIR, df), JSON.stringify(sorted, null, 4).replace(/\n/g, '\r\n') + '\r\n', 'utf8');
            }
            pruned = touched.size > 0;
            console.log(`\x1b[32m  [√] 已清理 ${dictHits.length} 个废弃词条\x1b[0m`);
        } else {
            console.log(`  [提示] 默认只读模式未修改词典；如需删除请显式传入 --prune`);
        }
    } else {
        console.log(`\x1b[32m  [√] 未发现已废弃词条\x1b[0m`);
    }

    return { redundancies, deadKeys, dictHits, totalEntries, coveredInCorpus, pruned };
}

module.exports = {
    DICT_FILES: utils.DICT_FILES,
    loadExistingTranslations,
    auditAndCleanDictionaries
};
