const fs = require('fs');
const path = require('path');
const utils = require('../utils');
const { DICT_FILES } = utils;

function loadExistingTranslations() {
    const dict = utils.loadDictionary();
    const translated = new Set();
    for (const k of Object.keys(dict)) {
        const normK = utils.normalizeText(k);
        if (normK) translated.add(normK.toLowerCase());
    }

    const rawRules = utils.loadRules();
    const rules = rawRules.map((r, index) => {
        try {
            return { index, pattern: r.pattern, replacement: r.replacement, regex: new RegExp(r.pattern, 'i') };
        } catch (e) {
            return null;
        }
    }).filter(Boolean);

    return {
        translated,
        rules: rules.map(r => r.regex),
        ruleEntries: rules
    };
}

/**
 * 检查 rules.json 中的正则遮蔽冲突
 */
function auditDynamicRules(ruleEntries, currentGlobalCorpus) {
    const shadowedRules = [];
    const hitByRule = new Map();

    for (const entry of ruleEntries) {
        hitByRule.set(entry.index, { firstHits: 0, totalMatches: 0, shadowedBy: new Set() });
    }

    for (const str of currentGlobalCorpus) {
        let firstIdx = -1;
        for (let i = 0; i < ruleEntries.length; i++) {
            const entry = ruleEntries[i];
            if (entry.regex.test(str)) {
                const stat = hitByRule.get(entry.index);
                stat.totalMatches++;
                if (firstIdx === -1) {
                    firstIdx = entry.index;
                    stat.firstHits++;
                } else {
                    stat.shadowedBy.add(firstIdx);
                }
            }
        }
    }

    for (const entry of ruleEntries) {
        const stat = hitByRule.get(entry.index);
        if (stat.totalMatches > 0 && stat.firstHits === 0) {
            shadowedRules.push({
                index: entry.index,
                pattern: entry.pattern,
                shadowedBy: Array.from(stat.shadowedBy)
            });
        }
    }

    return { shadowedRules };
}

function auditAndCleanDictionaries(currentGlobalCorpus, oldGlobalCorpus) {
    const dictHits = [];
    const globalLowerMap = new Map();
    const redundancies = [];
    const dictData = {};

    for (const df of DICT_FILES) {
        const dictPath = path.join(utils.DICTS_DIR, df);
        if (!fs.existsSync(dictPath)) continue;
        try {
            dictData[df] = JSON.parse(fs.readFileSync(dictPath, 'utf8'));
        } catch (e) {}
    }

    const currentCorpusLower = new Set();
    for (const s of currentGlobalCorpus) {
        currentCorpusLower.add(s.toLowerCase());
    }

    const oldCorpusLower = new Set();
    for (const s of oldGlobalCorpus) {
        oldCorpusLower.add(s.toLowerCase());
    }

    // 仅当词条曾存在于旧版快照语料、且在当前版本语料中已不存在时，判定为废弃
    for (const df of DICT_FILES) {
        if (!dictData[df]) continue;
        for (const [k, v] of Object.entries(dictData[df])) {
            const normK = utils.normalizeText(k);
            const lowerK = normK.toLowerCase();
            if (currentCorpusLower.has(lowerK)) continue;
            if (oldCorpusLower.has(lowerK)) {
                dictHits.push({ file: df, key: k, val: v, reason: '当前版本语料中已移除' });
            }
        }
    }

    // 跨文件与大小写重复检查
    if (dictData['common.json']) {
        for (const [k] of Object.entries(dictData['common.json'])) {
            const normK = utils.normalizeText(k);
            const lowerK = normK.toLowerCase();
            if (globalLowerMap.has(lowerK)) {
                const prev = globalLowerMap.get(lowerK);
                redundancies.push({ file: 'common.json', key: k, reason: `与 "${prev.originalKey}" 重复` });
            } else {
                globalLowerMap.set(lowerK, { file: 'common.json', originalKey: k });
            }
        }
    }

    for (const df of DICT_FILES) {
        if (df === 'common.json' || !dictData[df]) continue;
        for (const [k] of Object.entries(dictData[df])) {
            const normK = utils.normalizeText(k);
            const lowerK = normK.toLowerCase();
            if (globalLowerMap.has(lowerK)) {
                const prev = globalLowerMap.get(lowerK);
                redundancies.push({ file: df, key: k, reason: `已在 ${prev.file} 中存在对应项 "${prev.originalKey}"` });
            } else {
                globalLowerMap.set(lowerK, { file: df, originalKey: k });
            }
        }
    }

    const { rules, ruleEntries } = loadExistingTranslations();
    const regexCovered = [];
    const encodingAnomalies = [];

    for (const df of DICT_FILES) {
        if (!dictData[df]) continue;
        for (const [k, v] of Object.entries(dictData[df])) {
            const normK = utils.normalizeText(k);
            for (const r of rules) {
                if (r.test(normK)) {
                    regexCovered.push({ file: df, key: k, pattern: r.toString() });
                    break;
                }
            }
            if (typeof v === 'string') {
                if (v.includes('??') || (v.includes('?') && !k.includes('?')) || v.includes('\ufffd') || v.includes('锟斤拷')) {
                    encodingAnomalies.push({ file: df, key: k, value: v });
                }
            }
        }
    }

    const sortingViolations = [];
    for (const df of DICT_FILES) {
        if (!dictData[df]) continue;
        const keys = Object.keys(dictData[df]);
        for (let i = 0; i < keys.length - 1; i++) {
            if (utils.naturalCompare(keys[i], keys[i + 1]) > 0) {
                sortingViolations.push({ file: df, keyA: keys[i], keyB: keys[i + 1] });
                break;
            }
        }
    }

    const { shadowedRules } = auditDynamicRules(ruleEntries, currentGlobalCorpus);

    if (encodingAnomalies.length > 0) {
        console.log(`\x1b[31m  [×] 发现 ${encodingAnomalies.length} 个疑似乱码或异常问号词条:\x1b[0m`);
        encodingAnomalies.forEach(ea => console.log(`      - [${ea.file}] "${ea.key}" -> "${ea.value}"`));
    } else {
        console.log(`\x1b[32m  [√] 词典编码检查通过\x1b[0m`);
    }

    if (sortingViolations.length > 0) {
        console.log(`\x1b[31m  [×] 发现 ${sortingViolations.length} 个词典文件存在键排序乱序:\x1b[0m`);
        sortingViolations.forEach(sv => console.log(`      - [${sv.file}] "${sv.keyA}" 应排在 "${sv.keyB}" 之后`));
    } else {
        console.log(`\x1b[32m  [√] 词典键严格排序检查通过\x1b[0m`);
    }

    if (redundancies.length > 0) {
        console.log(`\x1b[33m  [!] 发现 ${redundancies.length} 个大小写或跨文件重复词条:\x1b[0m`);
        redundancies.forEach(r => console.log(`      - [${r.file}] "${r.key}" (${r.reason})`));
    } else {
        console.log(`\x1b[32m  [√] 词典无大小写或跨文件重复\x1b[0m`);
    }

    if (regexCovered.length > 0) {
        console.log(`\x1b[33m  [!] 发现 ${regexCovered.length} 个已被 rules.json 覆盖的静态词条:\x1b[0m`);
        regexCovered.forEach(rc => console.log(`      - [${rc.file}] "${rc.key}" -> 匹配正则 ${rc.pattern}`));
    } else {
        console.log(`\x1b[32m  [√] 词典无被 rules.json 覆盖的冗余词条\x1b[0m`);
    }

    if (shadowedRules.length > 0) {
        console.log(`\x1b[33m  [!] 发现 ${shadowedRules.length} 条被前置规则遮蔽的正则规则:\x1b[0m`);
        shadowedRules.forEach(sr => console.log(`      - [rules.json #${sr.index}] ${sr.pattern} (被规则 #${sr.shadowedBy.join(', #')} 遮蔽)`));
    } else {
        console.log(`\x1b[32m  [√] rules.json 无规则遮蔽冲突\x1b[0m`);
    }

    if (dictHits.length > 0) {
        console.log(`\x1b[33m  [!] 发现 ${dictHits.length} 个已废弃词条:\x1b[0m`);
        dictHits.forEach(dh => console.log(`      - [${dh.file}] "${dh.key}" (${dh.reason})`));

        console.log(`\n  [清理] 正在移除已废弃词条...`);
        const touchedFiles = new Set();
        for (const dh of dictHits) {
            if (dictData[dh.file] && dictData[dh.file][dh.key]) {
                delete dictData[dh.file][dh.key];
                touchedFiles.add(dh.file);
            }
        }
        for (const df of touchedFiles) {
            const dictPath = path.join(utils.DICTS_DIR, df);
            const sorted = {};
            Object.keys(dictData[df]).sort(utils.naturalCompare).forEach(k => sorted[k] = dictData[df][k]);
            fs.writeFileSync(dictPath, JSON.stringify(sorted, null, 4).replace(/\n/g, '\r\n') + '\r\n', 'utf8');
        }
        console.log(`\x1b[32m  [√] 已清理 ${dictHits.length} 个废弃词条\x1b[0m`);
    } else {
        console.log(`\x1b[32m  [√] 未发现已废弃词条\x1b[0m`);
    }

    return {
        encodingAnomalies,
        redundancies,
        regexCovered,
        shadowedRules,
        dictHits,
        sortingViolations
    };
}

module.exports = {
    DICT_FILES,
    loadExistingTranslations,
    auditDynamicRules,
    auditAndCleanDictionaries
};
