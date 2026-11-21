const fs = require('fs');
const path = require('path');
const utils = require('../utils');

const BACKREF_RE = /(?:^|[^\\])(?:\\\\)*\\[1-9]/;

function loadRawDictionaries() {
    const rawByFile = {};
    for (const df of utils.DICT_FILES) {
        const fp = path.join(utils.DICTS_DIR, df);
        if (!fs.existsSync(fp)) continue;
        const raw = fs.readFileSync(fp, 'utf8');
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (e) {
            throw new Error(`词典 ${df} JSON 解析失败: ${e.message}`);
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error(`词典 ${df} 必须为 JSON 对象`);
        }
        rawByFile[df] = parsed;
    }
    return rawByFile;
}

function validateRegexRules(ruleList, sourceLabel = 'rules.json') {
    if (!Array.isArray(ruleList)) {
        throw new Error(`${sourceLabel} 必须为 JSON 数组`);
    }
    return ruleList.map((r, index) => {
        if (!r || typeof r.pattern !== 'string' || r.pattern.length === 0) {
            throw new Error(`${sourceLabel}[${index}] 缺少有效 pattern`);
        }
        if (BACKREF_RE.test(r.pattern)) {
            throw new Error(`${sourceLabel}[${index}] 包含不支持的反向引用 (\\1-\\9): ${r.pattern}`);
        }
        let regex;
        try {
            regex = new RegExp(r.pattern, r.caseSensitive ? '' : 'i');
        } catch (e) {
            throw new Error(`${sourceLabel}[${index}] 正则编译失败 (${r.pattern}): ${e.message}`);
        }
        return { index, pattern: r.pattern, replacement: r.replacement, caseSensitive: Boolean(r.caseSensitive), regex };
    });
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
    const ruleEntries = validateRegexRules(utils.loadRules(), 'rules.json');
    return { rawByFile, translated, rules: ruleEntries.map(r => r.regex), ruleEntries };
}

function writeSortedDictFile(df, dictObj) {
    const sorted = {};
    Object.keys(dictObj).sort(utils.naturalCompare).forEach(k => { sorted[k] = dictObj[k]; });
    fs.writeFileSync(path.join(utils.DICTS_DIR, df), JSON.stringify(sorted, null, 4).replace(/\n/g, '\r\n') + '\r\n', 'utf8');
}

function logAuditList(items, warnMsg, okMsg, fmt) {
    if (items.length > 0) {
        console.log(`  [!] 发现 ${items.length} 个${warnMsg}:`);
        items.forEach(item => console.log(`      - ${fmt(item)}`));
    } else if (okMsg) {
        console.log(`  [√] ${okMsg}`);
    }
}

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

    logAuditList(redundancies, '大小写或跨文件重复词条', '词典无大小写或跨文件重复', r => `[${r.file}] "${r.key}" (${r.reason})`);
    logAuditList(deadKeys, '恒等空转死键 (key === value)', '词典无恒等死键', d => `[${d.file}] "${d.key}"`);
    console.log(`  [统计] 静态词条总数 ${totalEntries} 条（命中当前提取语料 ${coveredInCorpus} 条），正则规则 ${state.ruleEntries.length} 条`);

    let pruned = false;
    if (dictHits.length > 0) {
        logAuditList(dictHits, '疑似已废弃词条', '', dh => `[${dh.file}] "${dh.key}" (${dh.reason})`);
        if (prune) {
            const touched = new Set();
            for (const dh of dictHits) {
                if (dictData[dh.file] && Object.prototype.hasOwnProperty.call(dictData[dh.file], dh.key)) {
                    delete dictData[dh.file][dh.key];
                    touched.add(dh.file);
                }
            }
            for (const df of touched) writeSortedDictFile(df, dictData[df]);
            pruned = touched.size > 0;
            console.log(`  [√] 已清理 ${dictHits.length} 个废弃词条`);
        } else {
            console.log('  [提示] 默认只读模式未修改词典；如需删除请显式传入 --prune');
        }
    } else {
        console.log('  [√] 未发现已废弃词条');
    }

    return { redundancies, deadKeys, dictHits, totalEntries, coveredInCorpus, pruned };
}

function extractRuleLiteralChunks(pattern) {
    const cleaned = pattern
        .replace(/\\([.*+?^${}()|[\]\\/-])/g, '$1')
        .replace(/\(\?:|\(\?!|\(\?=|\(\?<=|\(\?<!/g, '|')
        .replace(/\[[^\]]+\]/g, '|')
        .replace(/\\[dswDSWbB]/g, '|')
        .replace(/[()^$+*?{}]/g, '|');
    return cleaned.split('|')
        .map(s => s.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '').trim())
        .filter(s => s.length >= 5 && /[a-zA-Z]{4,}/.test(s));
}

function existsInBinary(buf, str) {
    if (!buf || !str) return false;
    const variants = Array.from(new Set([str, str.replace(/\.\.\./g, '\u2026'), str.replace(/'/g, '\u2019')]));
    return variants.some(v => buf.includes(Buffer.from(v, 'utf8')));
}

function auditFullLiveness(liveness, options = {}) {
    const { decodedSources = '', tplMatchers = [], lsBinaryBuf = null, cloudTextSet = null, cloudRuleSet = null } = liveness || {};
    const { loaded = null, pruneDead = false } = options;
    const state = loaded || loadExistingTranslations();
    const dictData = state.rawByFile || loadRawDictionaries();

    const deadStatic = [];
    for (const df of utils.DICT_FILES) {
        if (!dictData[df]) continue;
        for (const [k, v] of Object.entries(dictData[df])) {
            const low = utils.normalizeText(k).toLowerCase();
            if (!low) continue;
            if (cloudTextSet && cloudTextSet.has(low)) continue;
            if (decodedSources.includes(low)) continue;
            if (tplMatchers.some(re => re.test(low))) continue;
            if (existsInBinary(lsBinaryBuf, k)) continue;
            deadStatic.push({ file: df, key: k, val: v });
        }
    }

    const rawRules = utils.loadRules();
    const seenPatterns = new Map();
    const duplicateRules = [];
    const deadRules = [];
    const deadRuleIdx = new Set();

    for (let i = 0; i < rawRules.length; i++) {
        const r = rawRules[i];
        const patKey = `${r.caseSensitive ? 'CS:' : 'CI:'}${r.pattern}`;
        if (seenPatterns.has(patKey)) duplicateRules.push({ index: i, prevIndex: seenPatterns.get(patKey), pattern: r.pattern });
        else seenPatterns.set(patKey, i);

        if (cloudRuleSet && cloudRuleSet.has(r.pattern)) continue;
        const chunks = extractRuleLiteralChunks(r.pattern);
        if (chunks.length === 0) continue;
        const hitJs = chunks.some(c => decodedSources.includes(utils.normalizeText(c).toLowerCase()));
        if (hitJs) continue;
        if (chunks.some(c => existsInBinary(lsBinaryBuf, c))) continue;
        deadRules.push({ index: i, pattern: r.pattern, replacement: r.replacement });
        deadRuleIdx.add(i);
    }

    let pruned = false;
    if (pruneDead && (deadStatic.length > 0 || deadRules.length > 0)) {
        const touched = new Set();
        for (const ds of deadStatic) {
            if (dictData[ds.file] && Object.prototype.hasOwnProperty.call(dictData[ds.file], ds.key)) {
                delete dictData[ds.file][ds.key];
                touched.add(ds.file);
            }
        }
        for (const df of touched) writeSortedDictFile(df, dictData[df]);
        if (deadRules.length > 0) {
            const nextRules = rawRules.filter((_, idx) => !deadRuleIdx.has(idx));
            fs.writeFileSync(path.join(utils.DICTS_DIR, 'rules.json'), JSON.stringify(nextRules, null, 4).replace(/\n/g, '\r\n') + '\r\n', 'utf8');
        }
        pruned = true;
    }

    return { deadStatic, deadRules, duplicateRules, pruned };
}

module.exports = {
    DICT_FILES: utils.DICT_FILES,
    validateRegexRules,
    loadExistingTranslations,
    auditAndCleanDictionaries,
    auditFullLiveness
};
