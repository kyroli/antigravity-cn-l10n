const utils = require('../utils');

// 允许基础 ASCII 与标准西文排版/警示符号
const DISALLOWED_CHAR_RE = /[^\x20-\x7E\u00A0\u00A9\u00B0\u00B7\u2013\u2014\u2018-\u201D\u2022\u2026\u2190-\u2193\u2318\u2325\u21E7\u2303\u23CE\u26A0\uFE0F]/;
const TAILWIND_TOKEN_RE = /^(?:[a-z0-9_-]+:)*!?(?:flex|grid|bg|text|border|items|justify|p|px|py|pl|pr|pt|pb|m|mx|my|mt|mb|ml|mr|w|h|min-w|max-w|min-h|max-h|overflow|rounded|gap|shrink|grow|font|leading|tracking|opacity|shadow|ring|stroke|fill|transition|duration|animate|cursor|select|tabular|z|top|bottom|left|right|line|space|divide|col|row|aspect|object|o2)-(?:\d|px|auto|full|screen|min|max|fit|none|sm|md|lg|xl|2xl|center|start|end|between|around|evenly|col|row|wrap|nowrap|hidden|scroll|clip|ellipsis|solid|dashed|dotted|transparent|current|inherit|white|black|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|muted|primary|secondary|destructive|accent|ti|tile|wchip)/;
const CODE_SYNTAX_RE = /\b(?:const|let|var)\s+[a-zA-Z_$][\w$]*\s*=|\bfunction\s*[a-zA-Z_$]*\s*\(|\b(?:import\s+[\w*{'"]|export\s+(?:default|const|let|var|function|class|\*)\b)|\bswitch\s*\(|\bcase\s+['"\d]|=>|[&|]{2}|={2,3}|!==?/;
const REJECT_PATTERNS = [
    /^(?:use strict|utf-?8|true|false|null|undefined|NaN|Infinity)$/i,
    /[\{\}\\]/,
    /^['"]?[:;)\}=]/,
    /['"]\s*\+|\+\s*['"]/,
    /^(?:https?|file|vscode|plugin):\/\/\S+$/i,
    /^data:[a-z]+\/[a-z0-9.+-]+/i,
    /^mailto:\S+$/i,
    /^[\w@./\\-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|exe|log|app|png|svg|md|html|htm|css|map|wasm|dll)$/i,
    /^[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)+$/,
    /^[a-zA-Z0-9@_.-]+(?:\/[a-zA-Z0-9@_.-]+)+$/,
    /^[a-z0-9_-]+(?:,[a-z0-9_-]+)+$/i,
    /^[a-z0-9_-]+;[a-z0-9_= -]+/i,
    /^(?:CmdOrCtrl|Ctrl|Alt|Shift|Meta)(?:\+[A-Za-z0-9]+)+$/i,
    /^[a-zA-Z0-9$]+_[a-zA-Z0-9_$]+$/,
    /^use[A-Z][a-zA-Z0-9]*\s+must be used within/i,
    // 过滤 HTML/SVG 片段、CSP 策略指令与内联 CSS 样式噪点
    /<\/?[a-z!][^>]*>/i,
    /^(?:base-uri|frame-src|script-src|style-src|img-src|connect-src|font-src|object-src|media-src|manifest-src|worker-src|form-action|default-src)\s+/i,
    /^(?:background|margin|padding|font-size|display|position|cursor|border(?:-[a-z-]+)?|color|width|height|line-height|box-shadow|visibility|z-index|opacity|overflow)\s*:\s*[^:\s]/i,
    /var\(--[a-z0-9_-]+/i,
    CODE_SYNTAX_RE,
    TAILWIND_TOKEN_RE
];

const CSS_CLASS_ID_RE = /^[.#][a-z_-][a-z0-9_-]*$/i;
const CSS_IDENT_PART_RE = /^[.#]?[a-z_-][a-z0-9_-]*$/i;
const CSS_TAG_RE = /^(?:\*|[a-z][a-z0-9_-]*)$/;
const CSS_ATTR_RE = /^\[[a-z][a-z0-9_-]*(?:[~|^$*]?=[^\]]*)?\]$/;
const CSS_STRONG_ATTR_RE = /^\[[a-z][a-z0-9_-]*(?:-[a-z0-9_-]+|[~|^$*]?=[^\]]+)\]$/;
const CSS_COMBINATOR_RE = /^\s*(?:[,>+~]|\s)\s*/;

function isCssSelectorNoise(str) {
    if (!str || (str[0] !== '.' && str[0] !== '#' && !str.includes('['))) return false;
    const parts = [];
    for (let i = 0; i < str.length;) {
        const start = i;
        while (i < str.length && !/[\s,>+~]/.test(str[i])) {
            if (str[i] === '[') {
                const close = str.indexOf(']', i + 1);
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
            i += sep[0].length;
        }
    }
    if (parts.length >= 2 && CSS_CLASS_ID_RE.test(parts[0]) &&
        parts.every((p, idx) => idx === 0 || CSS_IDENT_PART_RE.test(p) || /^\[[^\]]+\]$/.test(p))) {
        return true;
    }
    return parts.some(p => CSS_STRONG_ATTR_RE.test(p)) &&
        parts.every(p => CSS_TAG_RE.test(p) || CSS_CLASS_ID_RE.test(p) || CSS_ATTR_RE.test(p));
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
    if (tokens.length >= 2 &&
        tokens.every(t => /^(?:[a-z0-9_-]+:)*!?[a-z0-9_.-]+$/.test(t) && !/[.,!?]$/.test(t)) &&
        tokens.some(t => TAILWIND_TOKEN_RE.test(t) || /^[a-z0-9_-]+:/.test(t))) {
        return false;
    }
    return true;
}

function unescapeJsString(rawStr) {
    try {
        return rawStr
            .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
            .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
            .replace(/\\(.)/g, '$1');
    } catch (e) {
        return rawStr.replace(/\\(.)/g, '$1');
    }
}

function stripBundledNoiseBlocks(content) {
    if (!content) return '';
    return utils.cleanInjectedPatches(content)
        .replace(/\/\*[\s\S]{0,600}?Kiel University[\s\S]*?\.ELK\.default;/g, '')
        .replace(/"vscode:\/\/schemas\/workbench-colors"[\s\S]*?"vscode:\/\/schemas\/token-styling"[\s\S]{0,1500}?terminal\."\+[a-zA-Z0-9_$]+\);/g, '');
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
 * 提取常见 UI 属性中的字符串（用于 --audit 模式扫描未翻译文本）
 */
function extractHighConfidenceUiStrings(content) {
    const candidates = new Map();
    if (!content) return candidates;
    content = stripBundledNoiseBlocks(content);

    const uiPropRe = /(?:\b(label|title|placeholder|description|message|detail|buttonLabel|emptyMessage|tooltip|subtitle|heading)|"aria-label"|'aria-label')\s*:\s*(["'])((?:\\.|(?!\2)[^\\\r\n]){2,400})\2/g;
    let m;
    while ((m = uiPropRe.exec(content))) {
        const prop = m[1] || 'aria-label';
        const norm = utils.normalizeText(unescapeJsString(m[3]));
        if (isLikelyUserFacingText(norm)) {
            if (!candidates.has(norm)) candidates.set(norm, new Set());
            candidates.get(norm).add(`prop:${prop}`);
        }
    }
    return candidates;
}

module.exports = {
    isLikelyUserFacingText,
    extractStringsFromJs,
    extractHighConfidenceUiStrings,
    stripBundledNoiseBlocks
};
