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
        ? rawRules.map(r => ({
            regex: new RegExp(r.pattern, r.caseSensitive ? '' : 'i'),
            replacement: r.replacement,
            rawAll: r.rawGroups === true,
            rawGroupSet: Array.isArray(r.rawGroups) ? new Set(r.rawGroups) : null,
            safeGroupSet: Array.isArray(r.safeGroups) ? new Set(r.safeGroups) : null
        }))
        : [];
    // 全部规则拼接为单一预过滤正则，规则内不可使用 \1-\9 反向引用以免组号偏移失效
    const rulesPrefilter = rules.length > 0
        ? new RegExp(rules.map(r => '(?:' + r.regex.source + ')').join('|'), 'i')
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
            .replace(/([。，：；！？])\s+(?=[\u4e00-\u9fff])/g, '$1');
    }

    function matchRules(valNorm, depth) {
        if (rules.length === 0 || (rulesPrefilter && !rulesPrefilter.test(valNorm))) return null;
        for (let i = 0; i < rules.length; i++) {
            const rule = rules[i];
            const match = valNorm.match(rule.regex);
            if (match) return applyRuleMatch(rule, match, depth);
        }
        return null;
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
        const valNorm = normalizeText(val);
        if (!valNorm) return null;
        if (hotCache.has(valNorm)) return hotCache.get(valNorm);
        if (coldCache.has(valNorm)) {
            const cached = coldCache.get(valNorm);
            hotCache.set(valNorm, cached);
            return cached;
        }
        const res = translateCore(valNorm);
        if (hotCache.size >= MAX_GEN_SIZE) {
            coldCache = hotCache;
            hotCache = new Map();
        }
        hotCache.set(valNorm, res);
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
