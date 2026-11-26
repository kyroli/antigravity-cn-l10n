const fs = require('fs');
const path = require('path');
const vm = require('vm');
const utils = require('../utils');
const bundleRewriter = require('../runtime/bundleRewriter');

const BACKREF_RE = /(?:^|[^\\])(?:\\\\)*\\[1-9]/;

const ALLOWED_TEMPLATE_TECH_WORDS = new Set([
    'api', 'cdn', 'cli', 'css', 'csv', 'dns', 'dom', 'gif', 'html', 'http', 'https', 'ipc', 'iso',
    'jpg', 'json', 'jwt', 'localhost', 'mfa', 'oauth', 'oidc', 'pat', 'pdf', 'png', 'rpc', 'sdk',
    'sql', 'ssh', 'ssl', 'sso', 'svg', 'tcp', 'tls', 'udp', 'uri', 'url', 'utc', 'xml', 'wsl',
    'acl', 'ai', 'app', 'bot', 'ci', 'cd', 'cpu', 'cron', 'dev', 'dll', 'env', 'exe', 'git', 'gpu',
    'hook', 'hooks', 'ide', 'id', 'io', 'kb', 'linux', 'llm', 'log', 'mac', 'macos', 'mb', 'gb', 'ms',
    'os', 'pr', 'pro', 'qr', 'ram', 'repo', 'root', 'tar', 'tz', 'ui', 'ux', 'vm', 'vps', 'vs', 'v2', 'v3',
    'web', 'windows', 'zip',
    'calc', 'cel', 'hex', 'hsl', 'rgb', 'var', 'latex', 'mermaid',
    'alt', 'cmd', 'ctrl', 'enter', 'escape', 'go', 'n', 'ok', 'shift', 'tab', 'to', 'faq',
    'adc', 'antigravity', 'chrome', 'cider', 'citc', 'claude', 'cloudtop', 'fig', 'g1', 'gemini',
    'github', 'google', 'google3', 'gpt', 'jetski', 'remote', 'desktop', 'voice',
    'agent', 'agents', 'amend', 'artifact', 'artifacts', 'best', 'of', 'branch', 'code', 'commit',
    'context', 'cookie', 'cookies', 'deadline', 'diff', 'exceeded', 'fatal', 'file', 'fork', 'host',
    'iframe', 'main', 'markdown', 'mcp', 'notebook', 'origin', 'patch', 'path', 'plugin', 'plugins',
    'port', 'prompt', 'prompts', 'push', 'sandbox', 'sidecar', 'skill', 'skills', 'stage', 'swarm',
    'timeout', 'token', 'tokens', 'tree', 'view', 'workflow', 'workflows', 'working', 'worktree', 'workspace',
    'd', 'h', 'm', 'mo', 's', 'w', 'x', 'yr'
]);

function loadRawDictionaries() {
    const rawByFile = {};
    for (const dictFile of utils.DICT_FILES) {
        const filePath = path.join(utils.DICTS_DIR, dictFile);
        if (!fs.existsSync(filePath)) continue;
        const raw = fs.readFileSync(filePath, 'utf8');
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (err) {
            throw new Error(`词典 ${dictFile} JSON 解析失败: ${err.message}`);
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error(`词典 ${dictFile} 必须为 JSON 对象`);
        }
        rawByFile[dictFile] = parsed;
    }
    return rawByFile;
}

function validateRegexRules(ruleList, sourceLabel = 'rules.json') {
    if (!Array.isArray(ruleList)) {
        throw new Error(`${sourceLabel} 必须为 JSON 数组`);
    }
    return ruleList.map((rule, index) => {
        if (!rule || typeof rule.pattern !== 'string' || rule.pattern.length === 0) {
            throw new Error(`${sourceLabel}[${index}] 缺少有效 pattern`);
        }
        if (BACKREF_RE.test(rule.pattern)) {
            throw new Error(`${sourceLabel}[${index}] 包含不支持的反向引用 (\\1-\\9): ${rule.pattern}`);
        }
        let regex;
        try {
            regex = new RegExp(rule.pattern, rule.caseSensitive ? '' : 'i');
        } catch (err) {
            throw new Error(`${sourceLabel}[${index}] 正则编译失败 (${rule.pattern}): ${err.message}`);
        }
        return {
            index,
            pattern: rule.pattern,
            replacement: rule.replacement,
            caseSensitive: Boolean(rule.caseSensitive),
            regex
        };
    });
}

function loadExistingTranslations() {
    const rawByFile = loadRawDictionaries();
    const translated = new Set();
    for (const dict of Object.values(rawByFile)) {
        for (const key of Object.keys(dict)) {
            const normKey = utils.normalizeText(key);
            if (normKey) translated.add(normKey.toLowerCase());
        }
    }
    const ruleEntries = validateRegexRules(utils.loadRules(), 'rules.json');
    return { rawByFile, translated, rules: ruleEntries.map(rule => rule.regex), ruleEntries };
}

function writeSortedDictFile(dictFile, dictObj) {
    const sorted = {};
    for (const key of Object.keys(dictObj).sort(utils.naturalCompare)) {
        sorted[key] = dictObj[key];
    }
    fs.writeFileSync(
        path.join(utils.DICTS_DIR, dictFile),
        JSON.stringify(sorted, null, 4).replace(/\n/g, '\r\n') + '\r\n',
        'utf8'
    );
}

function logAuditList(items, warnMsg, okMsg, formatItem) {
    if (items.length > 0) {
        console.log(`  [!] 发现 ${items.length} 个${warnMsg}:`);
        items.forEach(item => console.log(`      - ${formatItem(item)}`));
    } else if (okMsg) {
        console.log(`  [√] ${okMsg}`);
    }
}

function auditAndCleanDictionaries(currentGlobalCorpus, oldGlobalCorpus, options = {}) {
    const { prune = false, loaded = null } = options;
    const state = loaded || loadExistingTranslations();
    const dictData = state.rawByFile || loadRawDictionaries();

    const toLowerSet = collection => new Set(
        Array.from(collection || [], str => utils.normalizeText(str).toLowerCase()).filter(Boolean)
    );
    const currentLower = toLowerSet(currentGlobalCorpus);
    const oldLower = toLowerSet(oldGlobalCorpus);

    const globalLowerMap = new Map();
    const redundancies = [];
    const deadKeys = [];
    const dictHits = [];
    let totalEntries = 0;
    let coveredInCorpus = 0;

    for (const dictFile of utils.DICT_FILES) {
        if (!dictData[dictFile]) continue;
        for (const [key, val] of Object.entries(dictData[dictFile])) {
            totalEntries++;
            const lowerKey = utils.normalizeText(key).toLowerCase();
            if (!lowerKey) continue;

            if (typeof val === 'string' && val === key) deadKeys.push({ file: dictFile, key });
            if (globalLowerMap.has(lowerKey)) {
                const prev = globalLowerMap.get(lowerKey);
                redundancies.push({ file: dictFile, key, reason: `已在 ${prev.file} 中存在 "${prev.originalKey}"` });
            } else {
                globalLowerMap.set(lowerKey, { file: dictFile, originalKey: key });
            }

            if (currentLower.has(lowerKey)) {
                coveredInCorpus++;
            } else if (oldLower.has(lowerKey)) {
                dictHits.push({ file: dictFile, key, val, reason: '当前版本语料中已移除' });
            }
        }
    }

    logAuditList(redundancies, '大小写或跨文件重复词条', '词典无大小写或跨文件重复', item => `[${item.file}] "${item.key}" (${item.reason})`);
    logAuditList(deadKeys, '恒等空转死键 (key === value)', '词典无恒等死键', item => `[${item.file}] "${item.key}"`);
    console.log(`  [统计] 静态词条总数 ${totalEntries} 条（命中当前提取语料 ${coveredInCorpus} 条），正则规则 ${state.ruleEntries.length} 条`);

    let pruned = false;
    if (dictHits.length > 0) {
        logAuditList(dictHits, '疑似已废弃词条', '', hit => `[${hit.file}] "${hit.key}" (${hit.reason})`);
        if (prune) {
            const touched = new Set();
            for (const hit of dictHits) {
                if (dictData[hit.file] && Object.prototype.hasOwnProperty.call(dictData[hit.file], hit.key)) {
                    delete dictData[hit.file][hit.key];
                    touched.add(hit.file);
                }
            }
            for (const dictFile of touched) writeSortedDictFile(dictFile, dictData[dictFile]);
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
        .map(segment => segment.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '').trim())
        .filter(segment => segment.length >= 5 && /[a-zA-Z]{4,}/.test(segment));
}

function existsInBinary(buf, str) {
    if (!buf || !str) return false;
    const variants = Array.from(new Set([str, str.replace(/\.\.\./g, '\u2026'), str.replace(/'/g, '\u2019')]));
    return variants.some(variant => buf.includes(Buffer.from(variant, 'utf8')));
}

function auditFullLiveness(liveness, options = {}) {
    const { decodedSources = '', tplMatchers = [], lsBinaryBuf = null, cloudTextSet = null, cloudRuleSet = null } = liveness || {};
    const { loaded = null, pruneDead = false } = options;
    const state = loaded || loadExistingTranslations();
    const dictData = state.rawByFile || loadRawDictionaries();

    const deadStatic = [];
    for (const dictFile of utils.DICT_FILES) {
        if (!dictData[dictFile]) continue;
        for (const [key, val] of Object.entries(dictData[dictFile])) {
            const lowerKey = utils.normalizeText(key).toLowerCase();
            if (!lowerKey) continue;
            if (cloudTextSet && cloudTextSet.has(lowerKey)) continue;
            if (decodedSources.includes(lowerKey)) continue;
            if (tplMatchers.some(re => re.test(lowerKey))) continue;
            if (existsInBinary(lsBinaryBuf, key)) continue;
            deadStatic.push({ file: dictFile, key, val });
        }
    }

    const rawRules = utils.loadRules();
    const seenPatterns = new Map();
    const duplicateRules = [];
    const deadRules = [];
    const deadRuleIdx = new Set();

    for (let i = 0; i < rawRules.length; i++) {
        const rule = rawRules[i];
        const patternKey = `${rule.caseSensitive ? 'CS:' : 'CI:'}${rule.pattern}`;
        if (seenPatterns.has(patternKey)) {
            duplicateRules.push({ index: i, prevIndex: seenPatterns.get(patternKey), pattern: rule.pattern });
        } else {
            seenPatterns.set(patternKey, i);
        }

        if (cloudRuleSet && cloudRuleSet.has(rule.pattern)) continue;
        const chunks = extractRuleLiteralChunks(rule.pattern);
        if (chunks.length === 0) continue;
        const hitJs = chunks.some(chunk => decodedSources.includes(utils.normalizeText(chunk).toLowerCase()));
        if (hitJs) continue;
        if (chunks.some(chunk => existsInBinary(lsBinaryBuf, chunk))) continue;
        deadRules.push({ index: i, pattern: rule.pattern, replacement: rule.replacement });
        deadRuleIdx.add(i);
    }

    let pruned = false;
    if (pruneDead && (deadStatic.length > 0 || deadRules.length > 0)) {
        const touched = new Set();
        for (const entry of deadStatic) {
            if (dictData[entry.file] && Object.prototype.hasOwnProperty.call(dictData[entry.file], entry.key)) {
                delete dictData[entry.file][entry.key];
                touched.add(entry.file);
            }
        }
        for (const dictFile of touched) writeSortedDictFile(dictFile, dictData[dictFile]);
        if (deadRules.length > 0) {
            const nextRules = rawRules.filter((_, idx) => !deadRuleIdx.has(idx));
            fs.writeFileSync(
                path.join(utils.DICTS_DIR, 'rules.json'),
                JSON.stringify(nextRules, null, 4).replace(/\n/g, '\r\n') + '\r\n',
                'utf8'
            );
        }
        pruned = true;
    }

    return { deadStatic, deadRules, duplicateRules, pruned };
}

function auditBundleRewriteQuality({ mainJs, translator, config, fragmentEntries, fragments }) {
    const { code: rewrittenMain } = bundleRewriter.rewriteBundleSource(mainJs, translator, config);
    new vm.Script(rewrittenMain, { filename: 'main.js' });

    const mixedTemplates = [];
    for (const tpl of bundleRewriter.extractReactUiTemplates(rewrittenMain, utils.normalizeText)) {
        if (!/[\u4e00-\u9fff]/.test(tpl.raw)) continue;
        const staticPart = tpl.raw.replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, ' ');
        const residual = (staticPart.match(/\b[A-Za-z]{2,}\b/g) || [])
            .filter(word => !ALLOWED_TEMPLATE_TECH_WORDS.has(word.toLowerCase()));
        if (residual.length > 0) mixedTemplates.push({ raw: tpl.raw, residual });
    }

    const trackedRules = (fragmentEntries || []).map(entry => ({
        sourceKey: entry.sourceKey,
        containerRe: new RegExp(entry.rule.containerPattern, 'i'),
        matchNested: Boolean(entry.rule.matchNested),
        hits: 0,
        reps: (entry.rule.nodeReplacements || []).map(replacement => ({
            match: replacement.match,
            re: new RegExp(replacement.match, 'i'),
            optional: entry.optionalMatches.has(replacement.match),
            hits: 0
        }))
    }));
    const ruleByKey = new Map(trackedRules.map(rule => [rule.sourceKey, rule]));

    for (const ceFrame of bundleRewriter.extractReactUiMultiChild(mainJs, utils.normalizeText)) {
        const sim = utils.normalizeText(ceFrame.flat);
        const stripped = utils.normalizeText(ceFrame.flat.replace(/^1+(?=[A-Za-z])/, ''));
        for (const rule of trackedRules) {
            if (!rule.containerRe.test(sim) && (stripped === sim || !rule.containerRe.test(stripped))) continue;
            rule.hits++;
            const targets = rule.matchNested ? (ceFrame.nestedLits || ceFrame.lits) : ceFrame.lits;
            for (const lit of targets) {
                for (const rep of rule.reps) {
                    if (rep.re.test(lit)) rep.hits++;
                }
            }
        }
    }

    const deadSubRules = [];
    for (const rule of trackedRules) {
        if (rule.hits === 0) continue;
        for (const rep of rule.reps) {
            if (!rep.optional && rep.hits === 0) {
                deadSubRules.push({ sourceKey: rule.sourceKey, match: rep.match });
            }
        }
    }

    const idempotencyIssues = [];
    for (const [enTpl, rawSpec] of Object.entries(fragments || {})) {
        const zhTpl = typeof rawSpec === 'object' ? rawSpec.zh : rawSpec;
        const zhProbe = utils.normalizeText(zhTpl.replace(/\{\*\}/g, '').replace(/\{#?\d+\}/g, '5'));
        const rule = ruleByKey.get(enTpl);
        if (rule && !rule.containerRe.test(zhProbe)) {
            idempotencyIssues.push(`中文译态未命中容器正则: ${enTpl}`);
        }
    }

    return { mixedTemplates, deadSubRules, idempotencyIssues };
}

module.exports = {
    DICT_FILES: utils.DICT_FILES,
    validateRegexRules,
    loadExistingTranslations,
    auditAndCleanDictionaries,
    auditFullLiveness,
    auditBundleRewriteQuality
};
