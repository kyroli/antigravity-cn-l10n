function normalizeText(text) {
    if (!text || typeof text !== 'string') return '';
    return text.replace(/[\s\u00A0\u2009\u202F]+/g, ' ')
               .replace(/['\u2018\u2019\u02bc]/g, "'")
               .replace(/["\u201c\u201d]/g, '"')
               .replace(/…/g, '...')
               .trim();
}

function createTranslator(rawDict, rawRules, config) {
    const cfg = config || {};
    const isMapObj = rawDict instanceof Map || Object.prototype.toString.call(rawDict) === '[object Map]';
    const map = isMapObj ? rawDict : new Map(Object.entries(rawDict || {}));
    const lowerMap = new Map();
    const lowerExclude = new Set((cfg.lowerWordsExclude || []).map(w => w.toLowerCase()));
    const enableLongPrefixLookup = cfg.enableLongPrefixLookup !== false;

    for (const [k, v] of map.entries()) {
        const lowerK = k.toLowerCase();
        if (!lowerExclude.has(lowerK)) {
            lowerMap.set(lowerK, v);
        }
    }

    const rules = Array.isArray(rawRules)
        ? rawRules.map((r, i) => ({
            idx: i,
            pattern: r.pattern,
            regex: new RegExp(r.pattern, r.caseSensitive ? '' : 'i'),
            replacement: r.replacement,
            rawAll: r.rawGroups === true,
            rawGroupSet: Array.isArray(r.rawGroups) ? new Set(r.rawGroups) : null,
            safeGroupSet: Array.isArray(r.safeGroups) ? new Set(r.safeGroups) : null
        }))
        : [];
    // 按首词、数字前缀与通配规则分桶并保留原始索引顺序，兼顾 O(1) 首词分流与 100% 优先级等价
    const wordBuckets = new Map();
    const digitRules = [];
    const wildRules = [];
    const WORD_PREFIX_RE = /^\^([a-zA-Z]+)(?:\\b|\\s|[ :/,.\-!'?])/;
    const DIGIT_PREFIX_RE = /^\^(?:\(\\d\+\)|\\d\+)/;
    for (let i = 0; i < rules.length; i++) {
        const r = rules[i];
        const wm = typeof r.pattern === 'string' ? r.pattern.match(WORD_PREFIX_RE) : null;
        if (wm) {
            const w = wm[1].toLowerCase();
            let bucket = wordBuckets.get(w);
            if (!bucket) {
                bucket = [];
                wordBuckets.set(w, bucket);
            }
            bucket.push(r);
        } else if (typeof r.pattern === 'string' && DIGIT_PREFIX_RE.test(r.pattern)) {
            digitRules.push(r);
        } else {
            wildRules.push(r);
        }
    }
    const digitPrefilter = digitRules.length > 0
        ? new RegExp(digitRules.map(r => '(?:' + r.regex.source + ')').join('|'), 'i')
        : null;
    const wildPrefilter = wildRules.length > 0
        ? new RegExp(wildRules.map(r => '(?:' + r.regex.source + ')').join('|'), 'i')
        : null;

    const protectedFileSet = new Set((cfg.protectedFiles || []).map(f => f.trim()));
    let longBuckets = null;

    // 双代缓存，避免单 Map 满载时全量清空
    let hotCache = new Map();
    let coldCache = new Map();
    const MAX_GEN_SIZE = 2048;

    const DURATION_UNIT_PAT = '(?:years?|yrs?|months?|mo|weeks?|wks?|w|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s|ms)';
    const DURATION_RE = new RegExp(`^\\d+\\s*${DURATION_UNIT_PAT}\\b(?:\\s*,?\\s*\\d+\\s*${DURATION_UNIT_PAT}\\b)*$`, 'i');
    const DURATION_ITEM_RE = new RegExp(`(\\d+)\\s*(${DURATION_UNIT_PAT})\\b`, 'gi');
    const DURATION_UNIT_MAP = {
        year: '年', years: '年', yr: '年', yrs: '年',
        month: '个月', months: '个月', mo: '个月',
        week: '周', weeks: '周', wk: '周', wks: '周', w: '周',
        day: '天', days: '天', d: '天',
        hour: '小时', hours: '小时', hr: '小时', hrs: '小时', h: '小时',
        minute: '分钟', minutes: '分钟', min: '分钟', mins: '分钟', m: '分钟',
        second: '秒', seconds: '秒', sec: '秒', secs: '秒', s: '秒',
        ms: '毫秒'
    };
    const SHORTCUT_RE = /^(.+?)\s*\((Ctrl|Cmd|Alt|Shift|⌘|⌥|⇧|⌃)\+?([^)]*)\)$/i;
    const FILE_EXT_RE = /\.[a-zA-Z0-9_\-]{1,8}$/;

    const verbMap = cfg.toolStatVerbs || {
        exploring: '正在探索', explored: '已探索', editing: '正在编辑',
        edited: '已编辑', running: '正在运行', ran: '已运行'
    };
    const nounMap = cfg.toolStatNouns || {
        file: '个文件', files: '个文件', folder: '个文件夹', folders: '个文件夹',
        search: '次搜索', searches: '次搜索', command: '个命令', commands: '个命令',
        task: '个任务', tasks: '个任务', page: '个网页', pages: '个网页',
        browser: '次浏览器操作', browsers: '次浏览器操作', image: '张图片', images: '张图片',
        action: '项操作', actions: '项操作', artifact: '个工件', artifacts: '个工件'
    };

    const verbKeys = Object.keys(verbMap).join('|');
    const nounKeys = Object.keys(nounMap).join('|');
    const toolStatItemRe = new RegExp(`^(?:(${verbKeys})\\s+)?(\\d+)\\s+(${nounKeys})$`, 'i');
    const toolStatFullRe = new RegExp(`^(?:(${verbKeys})\\s+)?(\\d+)\\s+(${nounKeys})(?:,\\s*(?:(${verbKeys})\\s+)?(\\d+)\\s+(${nounKeys}))*$`, 'i');

    function formatDuration(s) {
        if (!s) return null;
        const trimmed = s.trim();
        if (/^a few seconds$/i.test(trimmed)) return '几秒';
        if (!DURATION_RE.test(trimmed)) return null;
        return trimmed
            .replace(DURATION_ITEM_RE, (_, num, unit) => num + ' ' + DURATION_UNIT_MAP[unit.toLowerCase()])
            .replace(/,\s*/g, ' ')
            .replace(/\s{2,}/g, ' ');
    }

    function lookupStatic(normStr) {
        if (map.has(normStr)) return map.get(normStr);
        const lower = normStr.toLowerCase();
        return lowerMap.has(lower) ? lowerMap.get(lower) : null;
    }

    function isProtectedOrPath(valNorm) {
        if (protectedFileSet.has(valNorm) || protectedFileSet.has(valNorm.toUpperCase())) return true;
        if (valNorm.startsWith('file://') || valNorm.startsWith('vscode://')) return true;
        if (valNorm.length >= 3 && valNorm[1] === ':' && (valNorm[2] === '/' || valNorm[2] === '\\')) return true;
        if (valNorm.length >= 4 && valNorm[0] === '/' && valNorm[2] === ':' && (valNorm[3] === '/' || valNorm[3] === '\\')) return true;
        return !valNorm.includes(' ') && FILE_EXT_RE.test(valNorm);
    }

    function applyRuleMatch(rule, match, depth) {
        let out = rule.replacement;
        for (let g = match.length - 1; g >= 1; g--) {
            const rawGroup = match[g];
            let gVal = '';
            if (rawGroup !== undefined) {
                const isRaw = rule.rawAll || (rule.rawGroupSet && rule.rawGroupSet.has(g));
                if (isRaw) {
                    gVal = rawGroup;
                } else {
                    const isSafe = Boolean(rule.safeGroupSet && rule.safeGroupSet.has(g));
                    const gNorm = normalizeText(rawGroup);
                    // safeGroups 仅允许翻译含空格的 UI 短语，防止单单词实体名撞词典误译
                    const skipTextLookup = isSafe && (!gNorm.includes(' ') || isProtectedOrPath(gNorm));
                    gVal = skipTextLookup ? null : lookupStatic(gNorm);
                    if (gVal === null) gVal = formatDuration(gNorm);
                    if (gVal === null && depth < 2 && !skipTextLookup && !isProtectedOrPath(gNorm) && /[a-zA-Z]/.test(gNorm)) {
                        gVal = matchRules(gNorm, depth + 1);
                    }
                    if (gVal === null) gVal = rawGroup;
                }
            }
            out = out.split('$' + g).join(gVal);
        }
        return out
            .replace(/\s{2,}/g, ' ')
            .replace(/([\u4e00-\u9fff])\s+([前后])/g, '$1$2')
            .replace(/([。，：；！？])\s+(?=[\u4e00-\u9fff])/g, '$1')
            .trim();
    }

    function matchRules(valNorm, depth) {
        if (rules.length === 0 || !valNorm) return null;
        const c0 = valNorm.charCodeAt(0);
        let primary = null;
        if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) {
            let end = 1;
            while (end < valNorm.length) {
                const c = valNorm.charCodeAt(end);
                if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) break;
                end++;
            }
            primary = wordBuckets.get(valNorm.slice(0, end).toLowerCase()) || null;
        } else if (c0 >= 48 && c0 <= 57) {
            if (digitPrefilter && digitPrefilter.test(valNorm)) {
                primary = digitRules;
            }
        }
        let pRule = null;
        let pMatch = null;
        if (primary) {
            for (let i = 0; i < primary.length; i++) {
                const m = valNorm.match(primary[i].regex);
                if (m) {
                    pRule = primary[i];
                    pMatch = m;
                    break;
                }
            }
        }
        if (pRule && (wildRules.length === 0 || pRule.idx < wildRules[0].idx)) {
            return applyRuleMatch(pRule, pMatch, depth);
        }
        if (wildPrefilter && wildPrefilter.test(valNorm)) {
            const maxIdx = pRule ? pRule.idx : Infinity;
            for (let i = 0; i < wildRules.length; i++) {
                const r = wildRules[i];
                if (r.idx >= maxIdx) break;
                const m = valNorm.match(r.regex);
                if (m) return applyRuleMatch(r, m, depth);
            }
        }
        return pRule ? applyRuleMatch(pRule, pMatch, depth) : null;
    }

    function lookupLongPrefix(valNorm) {
        const prefix = valNorm.slice(0, -3).trim();
        if (prefix.length < 15) return null;
        if (!longBuckets) {
            longBuckets = new Map();
            for (const [k, v] of map.entries()) {
                if (k.length <= 15) continue;
                const lowerK = k.toLowerCase();
                const bKey = lowerK.slice(0, 4);
                let bucket = longBuckets.get(bKey);
                if (!bucket) {
                    bucket = [];
                    longBuckets.set(bKey, bucket);
                }
                bucket.push([k, lowerK, v]);
            }
            for (const bucket of longBuckets.values()) {
                if (bucket.length > 1) bucket.sort((a, b) => b[0].length - a[0].length);
            }
        }
        const prefixLower = prefix.toLowerCase();
        const bucket = longBuckets.get(prefixLower.slice(0, 4));
        if (!bucket) return null;
        for (let k = 0; k < bucket.length; k++) {
            const [key, keyLower, translated] = bucket[k];
            if (key.length > prefix.length && (key.startsWith(prefix) || keyLower.startsWith(prefixLower))) {
                return translated;
            }
        }
        return null;
    }

    function translateCore(valNorm) {
        if (!map.has(valNorm) && isProtectedOrPath(valNorm)) return null;

        const direct = lookupStatic(valNorm);
        if (direct !== null) return direct;

        const scMatch = valNorm.match(SHORTCUT_RE);
        if (scMatch) {
            const prefTrans = lookupStatic(normalizeText(scMatch[1]));
            if (prefTrans !== null) {
                return prefTrans + ' (' + scMatch[2] + (scMatch[3] ? '+' + scMatch[3] : '') + ')';
            }
        }

        const ruleHit = matchRules(valNorm, 0);
        if (ruleHit !== null) return ruleHit;

        if (toolStatFullRe.test(valNorm)) {
            const parts = valNorm.split(/\s*,\s*/);
            const transParts = [];
            for (let pi = 0; pi < parts.length; pi++) {
                const pm = parts[pi].match(toolStatItemRe);
                if (!pm) break;
                const v = pm[1] ? (verbMap[pm[1].toLowerCase()] || pm[1]) + ' ' : '';
                const n = nounMap[pm[3].toLowerCase()] || pm[3];
                transParts.push(v + pm[2] + ' ' + n);
            }
            if (transParts.length === parts.length) {
                return transParts.join('，');
            }
        }

        if (enableLongPrefixLookup && valNorm.length >= 20 && valNorm.endsWith('...')) {
            return lookupLongPrefix(valNorm);
        }

        return null;
    }

    function translateString(val) {
        if (!val || typeof val !== 'string' || !/[a-zA-Z]/.test(val)) return null;
        const valNorm = normalizeText(val);
        if (!valNorm) return null;
        const hasNl = typeof val === 'string' && val.includes('\n');
        const cacheKey = hasNl ? 'ML:' + val.trim() : valNorm;
        if (hotCache.has(cacheKey)) return hotCache.get(cacheKey);
        if (coldCache.has(cacheKey)) {
            const cached = coldCache.get(cacheKey);
            hotCache.set(cacheKey, cached);
            return cached;
        }
        let res = translateCore(valNorm);
        // 多行文本在整段未命中时按行回退翻译
        if (res === null && hasNl) {
            const lines = val.split('\n');
            if (lines.length >= 2 && lines.length <= 8) {
                let changed = false;
                const out = lines.map(l => {
                    const n = normalizeText(l);
                    const t = n && translateCore(n);
                    if (t && t !== n) {
                        changed = true;
                        return t;
                    }
                    return l;
                });
                if (changed) res = out.join('\n');
            }
        }
        if (hotCache.size >= MAX_GEN_SIZE) {
            coldCache = hotCache;
            hotCache = new Map();
        }
        hotCache.set(cacheKey, res);
        return res;
    }

    function translateMenuLabel(label) {
        if (!label || typeof label !== 'string') return null;
        const m = label.match(/&([a-zA-Z])/);
        if (m) {
            const trans = translateString(label.replace('&', ''));
            if (trans) return trans + '(&' + m[1].toUpperCase() + ')';
        }
        return translateString(label);
    }

    return {
        norm: normalizeText,
        translateString,
        translateMenuLabel,
        formatDuration
    };
}

module.exports = {
    normalizeText,
    createTranslator
};
