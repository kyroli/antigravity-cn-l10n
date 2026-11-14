const utils = require('../utils');

// 允许基础 ASCII 与标准西文排版/警示符号
const DISALLOWED_CHAR_RE = /[^\x20-\x7E\u00A0\u00A9\u00B0\u00B7\u2013\u2014\u2018-\u201D\u2022\u2026\u2190-\u2193\u2195\u2197\u21BB\u2303\u2318\u2325\u21E7\u23CE\u26A0\u2713\uFE0F]/;
const TAILWIND_TOKEN_RE = /^(?:[a-z0-9_\-[\]=:/&.]+:)*!?-?(?:flex|grid|bg|text|border|items|justify|p|px|py|pl|pr|pt|pb|m|mx|my|mt|mb|ml|mr|w|h|min-w|max-w|min-h|max-h|overflow|rounded|gap|shrink|grow|font|leading|tracking|opacity|shadow|ring|stroke|fill|transition|duration|animate|cursor|select|tabular|z|top|bottom|left|right|inset|line|space|divide|col|row|aspect|object|o2|agy|pointer-events|whitespace|break|outline)-(?:\d|px|auto|full|screen|min|max|fit|none|sm|md|lg|xl|2xl|base|xs|center|start|end|between|around|evenly|col|row|wrap|nowrap|normal|words|hidden|scroll|clip|ellipsis|solid|dashed|dotted|transparent|current|inherit|white|black|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|muted|primary|secondary|destructive|accent|success|warning|error|foreground|background|border|ti|tile|wchip|runnote|live|card|hover|fav|\[)/;
const CODE_SYNTAX_RE = /\b(?:const|let|var)\s+[a-zA-Z_$][\w$]*\s*=|\bfunction\s*[a-zA-Z_$]*\s*\(|\b(?:import\s+[\w*{'"]|export\s+(?:default|const|let|var|function|class|\*)\b)|\bswitch\s*\(|\bcase\s+['"\d]|=>|[&|]{2}|={2,3}|!==?/;
const REJECT_PATTERNS = [
    // 过滤语法字面量、URL/文件路径、代码标识符与快捷键组合
    /^(?:use strict|utf-?8|true|false|null|undefined|NaN|Infinity)$/i,
    /[\{\}\\]|^['"]?[:;)\}=]|^[,;:=\\|]|[;=\\/|]$|['"]\s*\+|\+\s*['"]/,
    /^(?:(?:https?|file|vscode|plugin):\/\/|mailto:)\S+$/i,
    /^data:[a-z]+\/[a-z0-9.+-]+/i,
    /^[\w@./\\-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|exe|log|app|png|svg|md|html|htm|css|map|wasm|dll)$/i,
    /^[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)+$|^[a-zA-Z0-9$]+_[a-zA-Z0-9_$]+$/,
    /^[a-z][a-z0-9]*[A-Z][a-zA-Z0-9_$]*:\s|[a-zA-Z_$][\w$]*\(\)|\([a-z]+$/,
    /^[a-zA-Z0-9@_.-]+(?:\/[a-zA-Z0-9@_.-]+)+$|^[a-z0-9_-]+(?:,[a-z0-9_-]+)+$|^[a-z0-9/_-]+;\s*[a-z0-9_= -]+$/i,
    /^(?:CmdOrCtrl|Ctrl|Alt|Shift|Meta)(?:\+[A-Za-z0-9]+)+$/i,
    /^use[A-Z][a-zA-Z0-9]*\s+must be used within/i,
    // 过滤 HTML/SVG 片段、CSP 策略指令与内联 CSS 样式噪点
    /<\/?[a-z!][^>]*>/i,
    /^(?:base-uri|frame-src|script-src|style-src|img-src|connect-src|font-src|object-src|media-src|manifest-src|worker-src|form-action|default-src)\s+/i,
    /^(?:background|margin|padding|font-size|display|position|cursor|border(?:-[a-z-]+)?|color|width|height|line-height|box-shadow|visibility|z-index|opacity|overflow)\s*:\s*[^:\s]/i,
    /var\(--[a-z0-9_-]+|^(?:calc|inset|rgb|rgba|hsl|hsla|clamp|minmax|repeat|translate|scale|rotate)\([^)]+\)$/i,
    // 过滤日志前缀、缓存控制头与残缺错误前缀
    /^\[(?:[A-Z_]+\]\s|&[_>a-z])/i,
    /^(?:private|public|no-cache|no-store)(?:,\s*[a-z0-9_=-]+)+$|^\(KHTML, like Gecko\)|^pane embedded$/i,
    /\bfailed:$|^Error (?:parsing|sending) |^Failed to close SSH connections:$/,
    CODE_SYNTAX_RE,
    TAILWIND_TOKEN_RE
];

const CSS_PART_RE = /^(?:\*|[a-z][a-z0-9_-]*|[.#][a-zA-Z_-][a-zA-Z0-9_-]*|\[[a-z][a-z0-9_-]*(?:[~|^$*]?=[^\]]*)?\]|:[a-z-]+(?:\([^)]+\))?)+$/;
const CSS_STRONG_RE = /(?:^[.#][a-zA-Z_-]|\[[a-z][a-z0-9_-]*(?:-[a-z0-9_-]+|[~|^$*]?=[^\]]+)\]|:[a-z-]+(?:\([^)]+\))?)/;
const CSS_COMBINATOR_RE = /^\s*(?:[,>+~]|\s)\s*/;

function isCssSelectorNoise(str) {
    if (!str || (str[0] !== '.' && str[0] !== '#' && !str.includes('['))) return false;
    const parts = [];
    let hasCssOp = false;
    for (let i = 0; i < str.length;) {
        const start = i;
        while (i < str.length && !/[\s,>+~]/.test(str[i])) {
            if (str[i] === '[' || str[i] === '(') {
                const close = str.indexOf(str[i] === '[' ? ']' : ')', i + 1);
                if (close === -1) return false;
                i = close + 1;
            } else {
                i++;
            }
        }
        if (i === start) return false;
        parts.push(str.slice(start, i));
        if (i < str.length) {
            const sep = str.slice(i).match(CSS_COMBINATOR_RE);
            if (!sep || i + sep[0].length >= str.length) return false;
            if (/[,>+~]/.test(sep[0])) hasCssOp = true;
            i += sep[0].length;
        }
    }
    return parts.length >= 2 && parts.every(p => CSS_PART_RE.test(p)) &&
        (hasCssOp || parts[0][0] === '.' || parts[0][0] === '#' || parts.some(p => CSS_STRONG_RE.test(p)));
}

function isLikelyUserFacingText(str) {
    if (!str || typeof str !== 'string') return false;
    const s = str.trim();
    if (s.length < 2 || s.length > 500 || !/\b[a-zA-Z]{2,}\b/.test(s) || DISALLOWED_CHAR_RE.test(s)) return false;
    if (s.includes('__') || s.includes('$$') || s.includes('/*') || /(?:^|\s)\/\//.test(s)) return false;
    if (s.includes('),content:') || s.includes('.describe(')) return false;
    if (s.includes('"') && (s.split('"').length - 1) % 2 !== 0) return false;
    if (REJECT_PATTERNS.some(re => re.test(s)) || isCssSelectorNoise(s)) return false;

    if (!/\s/.test(s)) return /^(?:OK|[A-Z][a-z]+:?)$/.test(s);
    const tokens = s.split(/\s+/);
    const isUtilityToken = t => TAILWIND_TOKEN_RE.test(t)
        || /^\[[a-zA-Z-]+:[^\]]+\]$|^\[&_[^\]]+\]:|^(?:can-hover|group(?:-[a-z0-9-]+)*|peer(?:-[a-z0-9-]+)*):|^group\/[a-z0-9_-]+$/i.test(t)
        || /^[a-z0-9_-]+:/.test(t);
    if (tokens.some(isUtilityToken) &&
        tokens.every(t => /^(?:[a-z0-9_\-[\]=:/&.!]+:)*!?-?(?:[a-z0-9_.\-/+%]|\[[^\]]+\]|\([^)]+\))+$/.test(t) && !/[.,!?]$/.test(t))) {
        return false;
    }
    // 过滤路径段组合、按键名列表及纯小写代码标识符词串
    if (tokens.length >= 2 &&
        tokens.every(t => /^[a-z0-9_]+(?:[./+-][a-z0-9_]+)+$/i.test(t) || /^(?:cmd|ctrl|alt|shift|meta|enter|escape|tab|space|backspace|delete|up|down|left|right|\+)+$/i.test(t))) {
        return false;
    }
    if (tokens.length >= 4 &&
        !tokens.some(t => /^[A-Z]/.test(t) || /^(?:is|are|was|were|not|in|on|at|to|for|with|from|the|this|that|your|an|or|and|by|of|into)$/.test(t)) &&
        tokens.every(t => /^[a-z_][a-zA-Z0-9_-]*$|^[a-z0-9,+-]+:[a-z0-9+-]+$/.test(t)) &&
        tokens.some(t => /^_[a-z0-9_]+$/.test(t) || /^[a-z]+(?:_[a-z0-9]+)+$/.test(t) || /^[a-z]+[A-Z][a-zA-Z0-9]*$/.test(t) || /^(?:aria|data)-[a-z0-9-]+$/.test(t) || /^[a-z0-9,+-]+:[a-z0-9+-]+$/.test(t))) {
        return false;
    }
    if (tokens.length >= 4 && tokens.every(t => /^[a-z][a-z0-9_]*$/.test(t))) {
        return false;
    }
    return true;
}

function unescapeJsString(rawStr) {
    return String(rawStr || '')
        .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/g, (_, u, x) => String.fromCharCode(parseInt(u || x, 16)))
        .replace(/\\(.)/g, (_, ch) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' }[ch] || ch));
}

// 剔除抛错、控制台/内部日志及 reject(new Error(...)) 中的非 UI 参数，保留外层调用语法
const INTERNAL_NOISE_RE = /(\bthrow new (?:Error|TypeError|RangeError)|(?<!\.)\b(?:console|main_\d+\.default)\.(?:log|warn|error|info|debug)|\b(?:opts\.log\?\.|this\.log)|\breject\s*\(\s*new Error)\s*\((?:[^()'"`\r\n]|'[^'\\\r\n]*(?:\\.[^'\\\r\n]*)*'|"[^"\\\r\n]*(?:\\.[^"\\\r\n]*)*"|`[^`\\\r\n]*(?:\\.[^`\\\r\n]*)*`|\([^()'"`\r\n]*\))*\)/g;

function stripBundledNoiseBlocks(content) {
    if (!content) return '';
    return utils.foldAdjacentJsStrings(utils.cleanInjectedPatches(content))
        .replace(/\/\*[\s\S]{0,600}?Kiel University[\s\S]*?\.ELK\.default;/g, '')
        .replace(/"vscode:\/\/schemas\/workbench-colors"[\s\S]*?"vscode:\/\/schemas\/token-styling"[\s\S]{0,1500}?terminal\."\+[a-zA-Z0-9_$]+\);/g, '')
        .replace(INTERNAL_NOISE_RE, (_, head) => `${head}()`);
}

function extractStringsFromJs(content) {
    const strings = new Set();
    if (!content) return strings;
    content = stripBundledNoiseBlocks(content);

    const len = content.length;
    let i = 0, inQuote = null, strStart = -1, inRegex = false, inCharClass = false, inLineComment = false, inBlockComment = false;

    while (i < len) {
        const ch = content[i];
        if (ch === '\\' && (inQuote || inRegex)) { i += (content[i + 1] === '\r' && content[i + 2] === '\n') ? 3 : 2; continue; }
        if (inLineComment) { if (ch === '\n') inLineComment = false; i++; continue; }
        if (inBlockComment) { if (ch === '*' && content[i + 1] === '/') { inBlockComment = false; i += 2; continue; } i++; continue; }
        if (inQuote) {
            if (ch === inQuote) {
                const normStr = utils.normalizeText(unescapeJsString(content.slice(strStart, i)));
                if (isLikelyUserFacingText(normStr)) strings.add(normStr);
                inQuote = null;
            } else if (inQuote !== '`' && ch === '\n') {
                inQuote = null;
            }
            i++;
            continue;
        }
        if (inRegex) {
            if (ch === '[' && !inCharClass) inCharClass = true;
            else if (ch === ']' && inCharClass) inCharClass = false;
            else if (ch === '/' && !inCharClass) inRegex = false;
            else if (ch === '\n') { inRegex = false; inCharClass = false; }
            i++;
            continue;
        }
        if (ch === '/' && content[i + 1] === '/') { inLineComment = true; i += 2; continue; }
        if (ch === '/' && content[i + 1] === '*') { inBlockComment = true; i += 2; continue; }
        if (ch === '"' || ch === "'" || ch === '`') { inQuote = ch; strStart = i + 1; i++; continue; }
        if (ch === '/') {
            let p = i - 1;
            while (p >= 0 && /\s/.test(content[p])) p--;
            if (p >= 0) {
                const pc = content[p];
                let isRe = '(=:[!&|?{};\n,+-*<>~^%'.includes(pc);
                if (!isRe && /[a-zA-Z]/.test(pc)) {
                    let ws = p;
                    while (ws >= 0 && /[a-zA-Z]/.test(content[ws])) ws--;
                    if (/^(?:return|case|yield|await|typeof|void|delete|in|instanceof)$/.test(content.slice(ws + 1, p + 1))) isRe = true;
                }
                if (isRe) { inRegex = true; inCharClass = false; }
            }
        }
        i++;
    }
    return strings;
}

/**
 * 提取常见 UI 属性及独立 JSX 文本子节点中的字符串（用于 --audit 模式扫描未翻译文本）
 */
function extractHighConfidenceUiStrings(content) {
    const candidates = new Map();
    if (!content) return candidates;
    content = stripBundledNoiseBlocks(content);

    const recordCandidate = (raw, tag) => {
        const norm = utils.normalizeText(unescapeJsString(raw));
        if (isLikelyUserFacingText(norm)) {
            if (!candidates.has(norm)) candidates.set(norm, new Set());
            candidates.get(norm).add(tag);
        }
    };

    const uiPropRe = /(?:\b(label|title|placeholder|description|message|detail|buttonLabel|emptyMessage|tooltip|subtitle|heading)|"aria-label"|'aria-label')\s*:\s*(["'])((?:\\.|(?!\2)[^\\\r\n]){2,400})\2/g;
    let m;
    while ((m = uiPropRe.exec(content))) {
        recordCandidate(m[3], `prop:${m[1] || 'aria-label'}`);
    }

    // 补充扫描 createElement(..., "Text") 中的独立文本子节点（如仅以文本作为唯一子节点的菜单项）
    const jsxSoleTextRe = /\.createElement\((?:[a-zA-Z0-9_$.]+|"(?:span|div|p|button|label|a|strong|em|h[1-6]|li|td|th|option)")\s*,\s*(?:null|\{[^()]{0,300}\})\s*,\s*(["'])([A-Z](?:\\.|(?!\1)[^\\\r\n]){1,200})\1\s*\)/g;
    while ((m = jsxSoleTextRe.exec(content))) {
        recordCandidate(m[2], 'jsx:text');
    }
    return candidates;
}

module.exports = {
    isLikelyUserFacingText,
    extractStringsFromJs,
    extractHighConfidenceUiStrings,
    stripBundledNoiseBlocks
};
