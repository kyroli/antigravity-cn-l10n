const utils = require('../utils');
const bundleRewriter = require('../runtime/bundleRewriter');

const DISALLOWED_CHAR_RE = /[^\x20-\x7E\u00A0\u00A9\u00B0\u00B7\u2013\u2014\u2018-\u201D\u2022\u2026\u2190-\u2193\u2195\u2197\u21BB\u2303\u2318\u2325\u21E7\u23CE\u26A0\u2713\uFE0F]/;
const TW_BRACKET_SRC = '\\[(?:[^\\[\\]]|\\[[^\\]]*\\])*\\]';
const TW_VARIANT_SRC = `(?:(?:${TW_BRACKET_SRC}|@?[a-z0-9_-]+(?:-${TW_BRACKET_SRC})?)(?:\\/[a-zA-Z0-9_-]+)?:)`;
const TAILWIND_TOKEN_RE = new RegExp(`^${TW_VARIANT_SRC}*!?-?(?:flex-shrink|flex|grid|bg|text|border|items|justify|p|px|py|pl|pr|pt|pb|m|mx|my|mt|mb|ml|mr|w|h|min-w|max-w|min-h|max-h|overflow|rounded|gap|shrink|grow|font|leading|tracking|opacity|shadow|ring|stroke|fill|transition|duration|animate|cursor|select|tabular|z|top|bottom|left|right|inset|line|space|divide|col|row|aspect|object|o2|agy|hv|pointer-events|whitespace|break|outline)-(?:\\d|px|auto|full|screen|min|max|fit|none|sm|md|lg|xl|2xl|base|xs|center|start|end|between|around|evenly|col|row|wrap|nowrap|normal|words|hidden|scroll|clip|ellipsis|solid|dashed|dotted|transparent|current|inherit|white|black|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|muted|primary|secondary|destructive|accent|success|warning|error|foreground|background|border|ti|tile|wchip|runnote|live|card|hover|fav|semibold|medium|bold|thin|extralight|extrabold|black|\\[)`);
const TW_UTILITY_TRIGGER_RE = new RegExp(`^(?:${TW_VARIANT_SRC}+|\\[[a-zA-Z-]+:[^\\]]+\\]$|(?:group|@container)\\/[a-z0-9_-]+$|^@container$|^truncate$|^hv-[a-z]$)`, 'i');
const TW_CLASS_TOKEN_RE = new RegExp(`^${TW_VARIANT_SRC}*!?-?(?:@?[a-zA-Z0-9_.\\-/+%]|${TW_BRACKET_SRC}|\\([^)]+\\))+$`);
const CODE_SYNTAX_RE = /\b(?:const|let|var)\s+[a-zA-Z_$][\w$]*\s*=|\bfunction\s*[a-zA-Z_$]*\s*\(|\b(?:import\s+[\w*{'"]|export\s+(?:default|const|let|var|function|class|\*)\b)|\bswitch\s*\(|\bcase\s+['"\d]|=>|[&|]{2}|={2,3}|!==?/;
const REJECT_PATTERNS = [
    /^(?:use strict|utf-?8|true|false|null|undefined|NaN|Infinity)$/i,
    /[\{\}\\]|^['"]?[:;)\}=]|^[,;:=\\|]|[;=\\/|]$|['"]\s*\+|\+\s*['"]/,
    /^(?:(?:https?|file|vscode|plugin):\/\/|mailto:)\S+$/i,
    /^data:[a-z]+\/[a-z0-9.+-]+/i,
    /^[\w@ ./\\-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|exe|log|app|png|svg|md|html|htm|css|map|wasm|dll)$/i,
    /^[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)+$|^[a-zA-Z0-9$]+_[a-zA-Z0-9_$]+$/,
    /^[a-z][a-z0-9]*[A-Z][a-zA-Z0-9_$]*:\s|[a-zA-Z_$][\w$]*\(\)|\([a-z]+$/,
    /^[a-zA-Z0-9@_.-]+(?:\/[a-zA-Z0-9@_.-]+)+$|^[a-z0-9_-]+(?:,[a-z0-9_-]+)+$|^[a-z0-9/_-]+;\s*[a-z0-9_= -]+$/i,
    /^(?:CmdOrCtrl|Ctrl|Alt|Shift|Meta)(?:\+[A-Za-z0-9]+)+$/i,
    /^use[A-Z][a-zA-Z0-9]*\s+must be used within/i,
    /<\/?[a-z!][^>]*>/i,
    /^(?:base-uri|frame-src|script-src|style-src|img-src|connect-src|font-src|object-src|media-src|manifest-src|worker-src|form-action|default-src)\s+/i,
    /^(?:background|margin|padding|font-size|display|position|cursor|border(?:-[a-z-]+)?|color|width|height|line-height|box-shadow|visibility|z-index|opacity|overflow|text-shadow|text-decoration)\s*:\s*[^:\s]/i,
    /var\(--[a-z0-9_-]+|^(?:calc|inset|rgb|rgba|hsl|hsla|clamp|minmax|repeat|translate|scale|rotate)\([^)]+\)$|^(?:linear|radial|conic)-gradient\(.+\)$/i,
    /^\(prefers-[a-z-]+:\s*[a-z-]+\)$/i,
    /^\[[a-z-]+="[^"]*"\]:[a-z-]+\(/i,
    /^button,\s*a$/,
    /^"[^"]+"\s+in\s+[a-z][a-z0-9_]*$/,
    /^\[(?:[A-Z_]+\]\s|AX snapshot truncated\b|&[_>a-z])/i,
    /^(?:private|public|no-cache|no-store)(?:,\s*[a-z0-9_=-]+)+$|^\(KHTML, like Gecko\)|^pane embedded$/i,
    /\bfailed:$|^Error (?:parsing|sending) |^Failed to (?:close SSH connections|refresh active search after in-place PDF reload|reload PDF in place|unload staged PDF document):$/,
    /^\.[a-z0-9]{1,10}(?:\s+\.[a-z0-9]{1,10}){2,}$/i,
    /^[a-z0-9_ /:.-]+(?:;[a-z0-9_ /:.-]+){3,}$/i,
    /^(?:opacity|transform|visibility|border-width)(?:,\s*(?:opacity|transform|visibility|border-width))+$/,
    /^(?:[a-zA-Z0-9 _-]+|'[a-zA-Z0-9 _-]+'|"[a-zA-Z0-9 _-]+")(?:,\s*(?:[a-zA-Z0-9 _-]+|'[a-zA-Z0-9 _-]+'|"[a-zA-Z0-9 _-]+"))*,\s*(?:sans-serif|serif|monospace|system-ui|cursive|fantasy|ui-sans-serif|ui-monospace|ui-serif)$/i,
    /^return\s+(?:-?\d+|true|false|null|undefined|this);?$/,
    /\bs\d+:e\d+\s+AX[A-Z]\w+|^macOS \d+(?:\.\d+){1,2}$/,
    /^(?:ACTION_FAILED|AGENT_(?:PAUSED|STOPPED)|USER_(?:STOP|TAKEOVER)|POINTER_BUSY|GEOMETRY_CHANGED|TARGET_CHANGED|SCRIPT_TIMEOUT|INTERRUPTED|PROTOCOL_VIOLATION|INVALID_SDP|NO_STREAMS|UNKNOWN_SESSION|CONFINEMENT_OUTDATED|ERR_[A-Z0-9_]+|AGY_[A-Z0-9_]+):\s|^AGY_[A-Z0-9_]+\s+must be\b/,
    /%s|^\$[a-zA-Z]\w*:|^[A-Z][a-zA-Z0-9]+\.[a-zA-Z_$][\w$]*:\s/,
    /^(?:BlockIdExtension|LexicalBuilder|LexicalNode|KeyboardShortcutMatch|Worker environment lockdown):\s|^Malformed Worker RPC\b|^Backward$/,
    /^(?:IndexedDB (?:open fail|tx (?:aborted|failed))|clear(?:AllWebviewData|WebviewCookiesForSite) resolved false|Selection change listeners are endlessly changing the selection\.|Failed to parse trailer frame:)$/,
    /^(?:set -[euo]+|mkdir -p |chmod [+\d]|trap\s+(?:'|-\s)|cat\s*>\s*|mv -f |echo\s+["'$])/,
    /^(?:fatal error:|panic serving|unexpected fault address|running GoogleExitFunction|gnome-control-center\s|systemsettings\s|xfce4-notifyd-config\b)/,
    /^'s\s[^:]*:$|\s'$|^(?:Enter passphrase for key '|Enter PIN for|Warning: the|differs from the key for the IP address|Accept updated hostkeys\?|to agent\?|Add key|Retype|any more|this time|checking other host|taking over|Could not load its window)$/,
    /^(?:bad (?:nonce|device key)|no device proof|the device key must be\b|busy: another pairing prompt is open)/,
    /^(?:done\.\w+|rpc \w+|modifiers)\s+must be\b|^(?:stderr|stdout line)\s+(?:exceeds|is not valid JSON)\b|^(?:script run aborted|user Stop|lease ended|actuator (?:client stopped|transport closed)|ActuatorService unimplemented|result exceeds limits|Browser did not answer Browser\.getVersion)$/,
    /^(?:Desktop Hub|Closed|Inactive|Agents pane Stop|live preview unavailable: agy-desktop-rtc is not installed|No open local browser host|Capture session failed|Session closed while opening|Unknown session|WebRTC SDP negotiation failed|WebRTC tab capture APIs unavailable|Remote-control command failed|RPC call failed|Method not found|Failed to stop agent browser|(?:Browser control action|Take control) failed|Navigation rejected|Open failed|[a-z][a-zA-Z0-9]*Service is not available|Limit the number of macro expansions to the specified number.+)$/,
    CODE_SYNTAX_RE,
    TAILWIND_TOKEN_RE
];

const CSS_PART_RE = /^(?:\*|[a-z][a-z0-9_-]*|[.#][a-zA-Z_-][a-zA-Z0-9_-]*|\[[a-z][a-z0-9_-]*(?:[~|^$*]?=[^\]]*)?\]|:[a-z-]+(?:\([^)]+\))?)+$/;
const CSS_STRONG_RE = /(?:^[.#][a-zA-Z_-]|\[[a-z][a-z0-9_-]*(?:-[a-z0-9_-]+|[~|^$*]?=[^\]]+)\]|:[a-z-]+(?:\([^)]+\))?)/;
const CSS_COMBINATOR_RE = /^\s*(?:[,>+~]|\s)\s*/;
const PROSE_JOINER_RE = /^(?:a|an|the|is|are|was|were|be|in|on|at|to|for|with|from|of|by|as|into|and|or|not|this|that|your|you|it|its|our|if|can)$/i;

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
    const isUtilityToken = t => TAILWIND_TOKEN_RE.test(t) || TW_UTILITY_TRIGGER_RE.test(t);
    if (tokens.some(isUtilityToken) &&
        tokens.every(t => TW_CLASS_TOKEN_RE.test(t) && !/[.,!?]$/.test(t))) {
        return false;
    }
    if (tokens.length >= 2 &&
        tokens.every(t => /^[a-z0-9_]+(?:[./+-][a-z0-9_]+)+$/i.test(t) || /^(?:cmd|ctrl|alt|shift|meta|enter|escape|tab|space|backspace|delete|up|down|left|right|\+)+$/i.test(t) || /^\.?[a-z0-9.,+-]+:[a-z0-9+-]+$/i.test(t))) {
        return false;
    }
    if (tokens.length >= 4 &&
        !tokens.some(t => /^[A-Z]/.test(t) || /^(?:is|are|was|were|not|in|on|at|to|for|with|from|the|this|that|your|an|or|and|by|of|into)$/.test(t)) &&
        tokens.every(t => /^[a-z_][a-zA-Z0-9_-]*$|^\.?[a-z0-9.,+-]+:[a-z0-9+-]+$/.test(t)) &&
        tokens.some(t => /^_[a-z0-9_]+$/.test(t) || /^[a-z]+(?:_[a-z0-9]+)+$/.test(t) || /^[a-z]+[A-Z][a-zA-Z0-9]*$/.test(t) || /^(?:aria|data)-[a-z0-9-]+$/.test(t) || /^\.?[a-z0-9.,+-]+:[a-z0-9+-]+$/.test(t))) {
        return false;
    }
    if (tokens.length >= 4 && tokens.every(t => /^[a-z][a-z0-9_]*$/.test(t))) {
        return false;
    }
    if (tokens.length >= 5 &&
        !tokens.some(t => PROSE_JOINER_RE.test(t)) &&
        (tokens.every(t => /^[a-z][a-z0-9_-]*$/.test(t)) ||
         (tokens.every(t => /^[a-zA-Z_$][\w$]*$/.test(t)) && tokens.filter(t => /^[a-z]+[A-Z]|^[A-Z][a-z]+[A-Z]|^[A-Z]{2,}[a-z]/.test(t)).length >= 3))) {
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

const INTERNAL_NOISE_RE = /(\bthrow new (?:Error|TypeError|RangeError)|(?<!\.)\b(?:console|main_\d+\.default)\.(?:log|warn|error|info|debug)|\b(?:opts\.log\?\.|this\.(?:log(?:Warn|Info|Debug)?|abandon|protocolViolation|killAndFail|failAll|resync|teardownWindow|tabGoneOrFailed|sendCommandWithAck)|logRejection|checkName|toFailure|stopAll|stopAllComputerAgents|errRes|failOffer|failFrame|failCmd|purge|must|die)|(?<!\.)\b(?:failure|fail)(?=\s*\()|\breject\s*\(\s*new Error|\bnew (?:CdpError|ConnectError))\s*\((?:[^()'"`]|'[^'\\\r\n]*(?:\\.[^'\\\r\n]*)*'|"[^"\\\r\n]*(?:\\.[^"\\\r\n]*)*"|`[^`\\\r\n]*(?:\\.[^`\\\r\n]*)*`|\([^()'"`]*\))*\)/g;

function stripBundledNoiseBlocks(content) {
    if (!content) return '';
    return utils.foldAdjacentJsStrings(utils.cleanInjectedPatches(content))
        .replace(/\/\*[\s\S]{0,600}?Kiel University[\s\S]*?\.ELK\.default;/g, '')
        .replace(/"vscode:\/\/schemas\/workbench-colors"[\s\S]*?"vscode:\/\/schemas\/token-styling"[\s\S]{0,1500}?terminal\."\+[a-zA-Z0-9_$]+\);/g, '')
        .replace(/\b[a-zA-Z0-9_$]+\(\s*[a-zA-Z0-9_$]+\s*,\s*"([A-Z][a-zA-Z]+)"\s*,\s*"([a-z][a-zA-Z]+)"\s*\)/g, (m, a, b) => a.toLowerCase() === b.toLowerCase() ? 'null' : m)
        .replace(/\|\|"the app"/g, '||""')
        .replace(INTERNAL_NOISE_RE, (_, head) => `${head}()`)
        .replace(/\bActuatorStatus\.[A-Z_]+,\s*detail:\s*(['"])(?:\\.|(?!\1)[^\\\r\n])*\1/g, 'ActuatorStatus.INTERNAL');
}

function extractStringsFromJs(content) {
    const strings = new Set();
    if (!content) return strings;
    content = stripBundledNoiseBlocks(content);

    const len = content.length;
    let index = 0;
    let inQuote = null;
    let strStart = -1;
    let inRegex = false;
    let inCharClass = false;
    let inLineComment = false;
    let inBlockComment = false;

    while (index < len) {
        const ch = content[index];
        if (ch === '\\' && (inQuote || inRegex)) {
            index += (content[index + 1] === '\r' && content[index + 2] === '\n') ? 3 : 2;
            continue;
        }
        if (inLineComment) {
            if (ch === '\n') inLineComment = false;
            index++;
            continue;
        }
        if (inBlockComment) {
            if (ch === '*' && content[index + 1] === '/') {
                inBlockComment = false;
                index += 2;
                continue;
            }
            index++;
            continue;
        }
        if (inQuote) {
            if (ch === inQuote) {
                const normStr = utils.normalizeText(unescapeJsString(content.slice(strStart, index)));
                if (isLikelyUserFacingText(normStr)) strings.add(normStr);
                inQuote = null;
            } else if (inQuote !== '`' && ch === '\n') {
                inQuote = null;
            }
            index++;
            continue;
        }
        if (inRegex) {
            if (ch === '[' && !inCharClass) inCharClass = true;
            else if (ch === ']' && inCharClass) inCharClass = false;
            else if (ch === '/' && !inCharClass) inRegex = false;
            else if (ch === '\n') {
                inRegex = false;
                inCharClass = false;
            }
            index++;
            continue;
        }
        if (ch === '/' && content[index + 1] === '/') {
            inLineComment = true;
            index += 2;
            continue;
        }
        if (ch === '/' && content[index + 1] === '*') {
            inBlockComment = true;
            index += 2;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
            inQuote = ch;
            strStart = index + 1;
            index++;
            continue;
        }
        if (ch === '/') {
            let prevIdx = index - 1;
            while (prevIdx >= 0 && /\s/.test(content[prevIdx])) prevIdx--;
            if (prevIdx >= 0) {
                const prevChar = content[prevIdx];
                let isRegexStart = '(=:[!&|?{};\n,+-*<>~^%'.includes(prevChar);
                if (!isRegexStart && /[a-zA-Z]/.test(prevChar)) {
                    let wordStart = prevIdx;
                    while (wordStart >= 0 && /[a-zA-Z]/.test(content[wordStart])) wordStart--;
                    if (/^(?:return|case|yield|await|typeof|void|delete|in|instanceof)$/.test(content.slice(wordStart + 1, prevIdx + 1))) {
                        isRegexStart = true;
                    }
                }
                if (isRegexStart) {
                    inRegex = true;
                    inCharClass = false;
                }
            }
        }
        index++;
    }
    return strings;
}

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

    const reactIdent = bundleRewriter.detectReactIdent(content);
    if (reactIdent) {
        for (const [norm, tags] of bundleRewriter.extractReactUiStrings(content, utils.normalizeText, isLikelyUserFacingText).entries()) {
            if (!candidates.has(norm)) candidates.set(norm, new Set());
            const set = candidates.get(norm);
            for (const t of tags) set.add(t);
        }
    } else {
        const jsxSoleTextRe = /\.createElement\((?:[a-zA-Z0-9_$.]+|"(?:span|div|p|button|label|a|strong|em|h[1-6]|li|td|th|option)")\s*,\s*(?:null|\{[^()]{0,300}\})\s*,\s*(["'])([A-Z](?:\\.|(?!\1)[^\\\r\n]){1,200})\1\s*\)/g;
        while ((m = jsxSoleTextRe.exec(content))) {
            recordCandidate(m[2], 'jsx:text');
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
