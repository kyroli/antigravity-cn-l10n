const utils = require('../utils');
const patcher = require('../patcher');

// 允许基础 ASCII 与标准西文排版标点（破折号 — –、圆点 • ·、箭头 → ←、快捷键符号 ⌘ ⌥ ⇧ ⌃、版权 ©、度数 ° 等）
const DISALLOWED_CHAR_RE = /[^\x20-\x7E\u00A0\u00A9\u00B0\u00B7\u2013\u2014\u2018-\u201D\u2022\u2026\u2190-\u2193\u2318\u2325\u21E7\u2303]/;

const TEXT_REJECT_RULES = [
    // 1. 代码符号、运算符、关键字与标识符
    /^(?:use strict|utf-8)$/i,
    /[\[\]\*\{\}\<\>\#\\\|\^`~]/,
    /[&|]{2}|={2,3}|!==?/,
    /\b(const|let|var|function|return|class|extends|throw|catch|async|await|require|typeof|instanceof)\b|\bimport\s+[\w*{'"]|\bexport\s+(?:default|const|let|var|function|class|\*)\b|\bswitch\s*\(|\bcase\s+['"\d]/,
    s => s.includes('__') || s.includes('$$') || s.includes('//') || s.includes('/*'),
    /^[a-zA-Z0-9_$]+$/,
    /^['"][a-zA-Z0-9_-]+['"]$/,
    /^['"]?[:;,\)\(]/,
    /^[A-Za-z0-9_\-\s]+:$/,
    /^[a-z0-9_]+-$/,
    s => s.startsWith('Symbol(') || (s.startsWith('create(') && s.endsWith(')')),

    // 2. 字符串拼接与模板截断碎片
    /(?:['"]\s*\+|\+\s*['"])|^['"]?\+|\+['"]?$/,
    /^(in\s+[a-zA-Z]|s\s+["']\+)/,
    /^(?:t|s|d|ll|re|ve)\s+[a-z]/i,
    /^(?:with\s+a|in\s+a|of\s+a|for\s+a)$/i,
    s => (s.includes('"') && (s.split('"').length - 1) % 2 !== 0),
    s => s.includes('),content:') || s.includes('.describe('),

    // 3. 属性访问、URL、路径、模块标识与 MIME/CSP
    /^[a-zA-Z]+\.[a-zA-Z]/,
    /^(http|https):\/\//,
    /^[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+/,
    /^[a-zA-Z0-9_/-]+\.(js|json|exe|log|app|ts|png|svg|md)$/i,
    /^[a-zA-Z0-9@_-]+\/[a-zA-Z0-9@_-]+$/,
    /^[a-zA-Z0-9@_.-]+(?:\/[a-zA-Z0-9@_.-]+){2,}$/,
    /^[a-zA-Z0-9_-]+\/$/,
    /^(?:video|audio|text|application)\/[a-z0-9._+-]*(?:;.*)?$/i,
    /^(?:(?:video|audio|text|application)\/[a-z0-9._+-]+(?:;[a-z0-9._+-=]+)?\s*)+$/i,
    /^(?:base-uri|frame-src|script-src|style-src|img-src|connect-src|font-src|object-src|media-src|manifest-src|worker-src|form-action|default-src)\s+/i,
    /^(?:clipboard-read|clipboard-write|microphone|camera|geolocation)(?:;\s*(?:clipboard-read|clipboard-write|microphone|camera|geolocation))*$/i,
    /^[a-z0-9_ -]+(?:;[a-z0-9_ -]+){2,}$/,
    /^[A-Za-z0-9_]+(;[A-Za-z0-9_ ]*)+;?$/,

    // 4. CSS 样式、选择器、函数与类名列表
    /^(?:[a-z0-9_\-\/]+:)*!?[a-z0-9]+(-+[a-z0-9.]+)+$/i,
    /^(?:font-size|width=|color:|display:|margin|padding|opacity|background:)/i,
    /^(?:color|rgba?|translate[XYZ23dD]?|rotate[XYZ]?|scale[XYZ]?|min|max|calc|var|repeat|(?:repeating-)?(?:linear|radial|conic)-gradient)\(/i,
    /^(?:tbody|thead|tfoot|table)\s+(?:tr|td|th)\b|^iframe,\s*webview$/i,
    /cubic-bezier\(|(?:\b\d+(\.\d+)?m?s\s+(?:linear|ease|cubic-bezier))/,
    /^(?:top|bottom|left|right|center)(?:\s+(?:top|bottom|left|right|center))+$/i,
    /,\s*(?:Menlo|Monaco|Consolas|SFMono-Regular|Liberation Mono|Courier New|monospace)\b/i,
    /@container\//,
    s => {
        if (!s.includes(' ')) return false;
        const tokens = s.trim().split(/\s+/);
        if (tokens.length >= 2 && tokens.every(t => /^!?[a-z0-9]+(?:-+[a-z0-9]+)+$/.test(t))) {
            return true;
        }
        if (tokens.length >= 2) {
            const hasCssTrait = tokens.some(t => /^(?:[a-z0-9_\-\/]+:)*!?(?:flex|bg-|text-|border|items-|justify-|p-|px-|py-|pl-|pr-|pt-|pb-|m-|mt-|mb-|ml-|mr-|w-|h-|overflow-|rounded|gap-|shrink-|relative|absolute|transition|animate|shadow|group|cursor-|font-|hover:|focus:|select-|tabular-|z-|top-|bottom-|left-|right-|line-|opacity-|duration-|bleed|truncate|break-|inline-|md-|table-|space-|ring-|stroke-|object-)/.test(t));
            const allTokenLike = tokens.every(t => /^(?:[a-z0-9_\-\/]+:)*!?[a-z0-9_\-\.\/]+$/i.test(t));
            if (hasCssTrait && allTokenLike) return true;
        }
        return false;
    },

    // 5. 快捷键、Shell 指令与底层类型标识
    /^(CmdOrCtrl|Ctrl|Alt|Shift)\+/i,
    /^[A-Za-z0-9]+(\+[A-Za-z0-9]+)+$/,
    /^(?:chmod|mv|rm|trap|cp|mkdir|touch)\s+|EXIT$/i,
    /\$(?:tmp|dir)\b/,
    /^(?:bigint|number)\s+\((?:int64|uint64|float32|float64|int32|uint32)\)$/,
    /^use[A-Z][a-zA-Z0-9]*\s+must be used within/i
];

function isLikelyUserFacingText(str) {
    if (!str) return false;
    const trimmed = str.trim();

    if (trimmed.length < 2 || trimmed.length > 250) return false;
    if (!/[a-zA-Z]/.test(trimmed)) return false;
    if (DISALLOWED_CHAR_RE.test(trimmed)) return false;
    if (/^[^a-zA-Z"'(•]/.test(trimmed)) return false;
    if (!/\b[a-zA-Z]{2,}\b/.test(trimmed)) return false;

    for (const rule of TEXT_REJECT_RULES) {
        if (typeof rule === 'function') {
            if (rule(trimmed)) return false;
        } else if (rule.test(trimmed)) {
            return false;
        }
    }

    return true;
}

function unescapeJsString(rawStr) {
    try {
        return rawStr
            .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
            .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
            .replace(/\\(.)/g, '$1');
    } catch (e) {
        return rawStr.replace(/\\(.)/g, '$1');
    }
}

function stripBundledNoiseBlocks(content) {
    if (!content) return '';
    content = patcher.cleanInjectedPatches(content);
    content = content.replace(/\/\*[\s\S]{0,600}?Kiel University[\s\S]*?\.ELK\.default;/g, '');
    content = content.replace(/"vscode:\/\/schemas\/workbench-colors"[\s\S]*?"vscode:\/\/schemas\/token-styling"[\s\S]{0,1500}?terminal\."\+[a-zA-Z0-9_$]+\);/g, '');
    return content;
}

function extractStringsFromJs(content) {
    const strings = new Set();
    if (!content) return strings;
    content = stripBundledNoiseBlocks(content);

    const len = content.length;
    let i = 0;
    let inQuote = null;
    let strStart = -1;
    let inRegex = false;
    let inCharClass = false;
    let inLineComment = false;
    let inBlockComment = false;

    while (i < len) {
        const ch = content[i];

        if (ch === '\\' && (inQuote || inRegex)) {
            if (content[i + 1] === '\r' && content[i + 2] === '\n') {
                i += 3;
            } else {
                i += 2;
            }
            continue;
        }

        if (inLineComment) {
            if (ch === '\n') inLineComment = false;
            i++;
            continue;
        }
        if (inBlockComment) {
            if (ch === '*' && content[i + 1] === '/') {
                inBlockComment = false;
                i += 2;
                continue;
            }
            i++;
            continue;
        }

        if (inQuote) {
            if (ch === inQuote) {
                const rawStr = unescapeJsString(content.slice(strStart, i));
                const normStr = utils.normalizeText(rawStr);
                if (isLikelyUserFacingText(normStr)) {
                    strings.add(normStr);
                }
                inQuote = null;
            } else if (inQuote !== '`' && ch === '\n') {
                inQuote = null;
            }
            i++;
            continue;
        }

        if (inRegex) {
            if (ch === '[' && !inCharClass) {
                inCharClass = true;
            } else if (ch === ']' && inCharClass) {
                inCharClass = false;
            } else if (ch === '/' && !inCharClass) {
                inRegex = false;
            } else if (ch === '\n') {
                inRegex = false;
                inCharClass = false;
            }
            i++;
            continue;
        }

        if (ch === '/' && content[i + 1] === '/') {
            inLineComment = true;
            i += 2;
            continue;
        }
        if (ch === '/' && content[i + 1] === '*') {
            inBlockComment = true;
            i += 2;
            continue;
        }

        if (ch === '"' || ch === "'" || ch === '`') {
            inQuote = ch;
            strStart = i + 1;
            i++;
            continue;
        }

        if (ch === '/') {
            let prevIdx = i - 1;
            while (prevIdx >= 0 && /\s/.test(content[prevIdx])) prevIdx--;
            if (prevIdx >= 0) {
                const prevChar = content[prevIdx];
                let isRegex = '(=:[!&|?{};\n,+-*<>~^%'.includes(prevChar);
                if (!isRegex && /[a-zA-Z]/.test(prevChar)) {
                    let wordStart = prevIdx;
                    while (wordStart >= 0 && /[a-zA-Z]/.test(content[wordStart])) wordStart--;
                    const word = content.slice(wordStart + 1, prevIdx + 1);
                    if (/^(?:return|case|yield|await|typeof|void|delete|in|instanceof)$/.test(word)) {
                        isRegex = true;
                    }
                }
                if (isRegex) {
                    inRegex = true;
                    inCharClass = false;
                    i++;
                    continue;
                }
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

    const uiPropRe = /\b(label|title|placeholder|description|message|detail|buttonLabel|emptyMessage|tooltip|subtitle|heading|"aria-label")\s*:\s*(["'])((?:\\.|(?!\2)[^\\\r\n]){2,220})\2/g;
    let m;
    while ((m = uiPropRe.exec(content))) {
        const prop = m[1].replace(/"/g, '');
        const raw = unescapeJsString(m[3]);
        const norm = utils.normalizeText(raw);
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
    extractHighConfidenceUiStrings
};
