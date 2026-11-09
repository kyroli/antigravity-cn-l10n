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
    const map = new Map(Object.entries(rawDict || {}));
    const lowerMap = new Map();
    const lowerExclude = new Set((cfg.lowerWordsExclude || []).map(w => w.toLowerCase()));
    const enableLongPrefixLookup = cfg.enableLongPrefixLookup !== false;

    const longEntries = [];
    for (const [k, v] of map.entries()) {
        const lowerK = k.toLowerCase();
        if (!(lowerExclude.has(lowerK) && k !== lowerK)) {
            lowerMap.set(lowerK, v);
        }
        if (enableLongPrefixLookup && k.length > 15) {
            longEntries.push([k, lowerK, v]);
        }
    }
    if (longEntries.length > 1) {
        longEntries.sort((a, b) => b[0].length - a[0].length);
    }

    const rules = (rawRules || []).map(r => ({
        regex: new RegExp(r.pattern, 'i'),
        replacement: r.replacement
    }));

    const protectedFileSet = new Set((cfg.protectedFiles || []).map(f => f.trim()));

    // 双代缓存，避免单 Map 满载时全量清空
    let hotCache = new Map();
    let coldCache = new Map();
    const MAX_GEN_SIZE = 2048;

    const DURATION_RE = /^\d+\s*(?:days?|d|hours?|h(?:r)?|minutes?|m(?:in)?|seconds?|s(?:ec)?|ms)\b(?:\s*,?\s*\d+\s*(?:days?|d|hours?|h(?:r)?|minutes?|m(?:in)?|seconds?|s(?:ec)?|ms)\b)*$/i;
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
        if (!s || !DURATION_RE.test(s.trim())) return null;
        return s.trim()
            .replace(/(\d+)\s*(?:days?|d)\b/gi, '$1 天')
            .replace(/(\d+)\s*(?:hours?|h(?:r)?)\b/gi, '$1 小时')
            .replace(/(\d+)\s*(?:minutes?|m(?:in)?)\b/gi, '$1 分钟')
            .replace(/(\d+)\s*(?:seconds?|s(?:ec)?)\b/gi, '$1 秒')
            .replace(/(\d+)\s*ms\b/gi, '$1 毫秒')
            .replace(/,\s*/g, ' ')
            .replace(/\s{2,}/g, ' ');
    }

    function lookupStatic(normStr) {
        if (map.has(normStr)) return map.get(normStr);
        const lower = normStr.toLowerCase();
        if (lowerMap.has(lower)) return lowerMap.get(lower);
        return null;
    }

    function translateCore(valNorm) {
        // 1. 过滤受保护工程文件名与路径/协议（显式存在于字典中的词条放行）
        if (!map.has(valNorm)) {
            if (protectedFileSet.has(valNorm) || protectedFileSet.has(valNorm.toUpperCase())) return null;
            if (valNorm.startsWith('file://') || valNorm.startsWith('vscode://')) return null;
            if (valNorm.length >= 3 && valNorm[1] === ':' && (valNorm[2] === '/' || valNorm[2] === '\\')) return null;
            if (valNorm.length >= 4 && valNorm[0] === '/' && valNorm[2] === ':' && (valNorm[3] === '/' || valNorm[3] === '\\')) return null;
            if (!valNorm.includes(' ') && FILE_EXT_RE.test(valNorm)) return null;
        }

        // 2. 精确静态字典与大小写兜底匹配
        const direct = lookupStatic(valNorm);
        if (direct !== null) return direct;

        // 3. 快捷键后缀剥离匹配: 如 "Settings (Ctrl+,)"
        const scMatch = valNorm.match(SHORTCUT_RE);
        if (scMatch) {
            const prefTrans = lookupStatic(normalizeText(scMatch[1]));
            if (prefTrans !== null) {
                return prefTrans + ' (' + scMatch[2] + (scMatch[3] ? '+' + scMatch[3] : '') + ')';
            }
        }

        // 4. 动态正则规则匹配（支持捕获组递归查表与局部时长转换）
        for (let k = 0; k < rules.length; k++) {
            const rule = rules[k];
            const match = valNorm.match(rule.regex);
            if (match) {
                let out = rule.replacement;
                for (let g = 1; g < match.length; g++) {
                    const rawGroup = match[g];
                    let gVal = '';
                    if (rawGroup !== undefined) {
                        const gNorm = normalizeText(rawGroup);
                        gVal = lookupStatic(gNorm) || formatDuration(gNorm) || rawGroup;
                    }
                    out = out.split('$' + g).join(gVal);
                }
                return out.replace(/\s{2,}/g, ' ').replace(/\s+后/g, '后');
            }
        }

        // 5. 复合工具操作统计: 如 "Explored 2 files, Ran 1 command"
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

        // 6. 截断长文本前缀反查（仅对 "..." 结尾且长度 >= 20 的 UI 截断项惰性触发）
        if (enableLongPrefixLookup && valNorm.length >= 20 && valNorm.endsWith('...')) {
            const prefix = valNorm.slice(0, -3).trim();
            if (prefix.length >= 15) {
                const prefixLower = prefix.toLowerCase();
                for (let k = 0; k < longEntries.length; k++) {
                    const [key, keyLower, translated] = longEntries[k];
                    if (key.length > prefix.length && (key.startsWith(prefix) || keyLower.startsWith(prefixLower))) {
                        return translated;
                    }
                }
            }
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
            const cleanLabel = label.replace('&', '');
            const trans = translateString(cleanLabel);
            if (trans) return trans + '(&' + m[1].toUpperCase() + ')';
        }
        return translateString(label);
    }

    return {
        norm: normalizeText,
        translateString,
        translateMenuLabel
    };
}

module.exports = {
    normalizeText,
    createTranslator
};
