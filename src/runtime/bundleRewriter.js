const UI_PROP_KEYS = new Set([
    'title', 'placeholder', 'aria-label', 'ariaLabel', 'label', 'tooltip',
    'description', 'emptyMessage', 'buttonLabel', 'subtitle', 'heading',
    'message', 'detail', 'confirmText', 'cancelText', 'confirmLabel', 'cancelLabel',
    'helperText', 'emptyText'
]);
const OBJ_UI_PROP_KEYS = new Set([
    'label', 'title', 'aria-label', 'description', 'tooltip', 'placeholder',
    'subtitle', 'heading', 'emptyMessage', 'buttonLabel', 'helperText', 'emptyText'
]);
const OBJ_STRICT_KEYS = new Set(['aria-label', 'placeholder', 'tooltip']);
const SKIP_TAGS = new Set(['script', 'style', 'path', 'svg', 'code', 'pre', 'symbol', 'defs', 'lineargradient', 'stop']);
const SCHEMA_SIBLING_KEYS = new Set(['settings', 'prefix', 'hasSections']);
const TEXT_SLOT_PREFIX = 'AGSLOT';
const NUMERIC_PROBE_BASE = 99100;
const NUMERIC_PROBE_GUARD = '9910';
const RAW_SLOT_PROBES = ['Settings', 'Privacy Policy'];
const REGEX_PRECEDERS = new Set([
    '', '(', '[', '{', ',', ';', ':', '?', '=', '!', '&', '|', '^', '~', '+', '-', '*', '%', '<', '>',
    '&&', '||', '??', '==', '!=', '===', '!==', '=>',
    'return', 'case', 'throw', 'typeof', 'void', 'delete', 'in', 'of', 'instanceof', 'await', 'yield', 'else', 'do'
]);

const isIdentifierStart = ch => (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$';
const isIdentifierChar = ch => isIdentifierStart(ch) || (ch >= '0' && ch <= '9');
const serializeJsString = str => JSON.stringify(str).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const escapeTemplateQuasi = str => String(str)
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

function detectReactIdent(source) {
    if (!source || typeof source !== 'string') return null;
    const counts = new Map();
    const exclude = new Set(['document', '_document', 'doc', 'mainDocument', 'ownerDocument', 'treeAdapter']);
    for (const match of source.matchAll(/\b([A-Za-z_$][\w$]*)\.createElement\(/g)) {
        if (!exclude.has(match[1])) counts.set(match[1], (counts.get(match[1]) || 0) + 1);
    }
    let bestName = null;
    let bestCount = 0;
    for (const [name, count] of counts.entries()) {
        if (count > bestCount) {
            bestName = name;
            bestCount = count;
        }
    }
    return bestCount >= 50 ? bestName : null;
}

function skipStringLiteral(source, startIndex, length) {
    let index = startIndex;
    const quote = source[index++];
    while (index < length) {
        const ch = source[index++];
        if (ch === '\\') {
            index += (source[index] === '\r' && source[index + 1] === '\n') ? 2 : 1;
            continue;
        }
        if (ch === quote) return index;
    }
    return length;
}

function skipRegexLiteral(source, startIndex, length) {
    let index = startIndex + 1;
    let inCharClass = false;
    while (index < length) {
        const ch = source[index++];
        if (ch === '\\') {
            index++;
            continue;
        }
        if (ch === '[' && !inCharClass) inCharClass = true;
        else if (ch === ']' && inCharClass) inCharClass = false;
        else if ((ch === '/' && !inCharClass) || ch === '\n') break;
    }
    while (index < length && ((source[index] >= 'a' && source[index] <= 'z') || (source[index] >= 'A' && source[index] <= 'Z'))) {
        index++;
    }
    return index;
}

function skipWhitespaceAndComments(source, startIndex, length) {
    let index = startIndex;
    while (index < length) {
        const ch = source[index];
        if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
            index++;
            continue;
        }
        if (ch === '/' && source[index + 1] === '/') {
            index += 2;
            while (index < length && source[index] !== '\n') index++;
            continue;
        }
        if (ch === '/' && source[index + 1] === '*') {
            index += 2;
            while (index < length && !(source[index] === '*' && source[index + 1] === '/')) index++;
            index += 2;
            continue;
        }
        break;
    }
    return index;
}

function readOperatorOrPunctuator(source, index) {
    const threeChar = source.slice(index, index + 3);
    if (threeChar === '===' || threeChar === '!==') return [threeChar, index + 3];
    const twoChar = source.slice(index, index + 2);
    if (twoChar === '&&' || twoChar === '||' || twoChar === '??' || twoChar === '==' || twoChar === '!=' || twoChar === '=>') {
        return [twoChar, index + 2];
    }
    return [source[index] || '', index + 1];
}

function decodeJsStringBody(inner) {
    if (!inner || !inner.includes('\\')) return inner;
    return inner
        .replace(/\\(?:\r\n|\r|\n)/g, '')
        .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/g, (_, uHex, xHex) => String.fromCharCode(parseInt(uHex || xHex, 16)))
        .replace(/\\(.)/g, (_, ch) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' }[ch] || ch));
}

function decodeJsString(raw) {
    return raw && raw.length >= 2 ? decodeJsStringBody(raw.slice(1, -1)) : null;
}

function parseTemplateLiteral(source, startIndex, length, collect = false) {
    let index = startIndex + 1;
    let chunkStart = index;
    const quasis = collect ? [] : null;
    const exprs = collect ? [] : null;
    while (index < length) {
        const ch = source[index];
        if (ch === '\\') {
            index += (source[index + 1] === '\r' && source[index + 2] === '\n') ? 3 : 2;
            continue;
        }
        if (ch === '`') {
            if (collect) quasis.push(decodeJsStringBody(source.slice(chunkStart, index)));
            return { end: index + 1, quasis, exprs };
        }
        if (ch === '$' && source[index + 1] === '{') {
            if (collect) quasis.push(decodeJsStringBody(source.slice(chunkStart, index)));
            const exprStart = index;
            index += 2;
            let depth = 1;
            let prev = '{';
            while (index < length && depth > 0) {
                index = skipWhitespaceAndComments(source, index, length);
                if (index >= length) break;
                const tokenChar = source[index];
                if (tokenChar === '"' || tokenChar === "'") {
                    index = skipStringLiteral(source, index, length);
                    prev = 'STR';
                } else if (tokenChar === '`') {
                    index = parseTemplateLiteral(source, index, length, false).end;
                    prev = 'STR';
                } else if (tokenChar === '/' && REGEX_PRECEDERS.has(prev)) {
                    index = skipRegexLiteral(source, index, length);
                    prev = 'REG';
                } else if (isIdentifierStart(tokenChar)) {
                    const tokenStart = index++;
                    while (index < length && isIdentifierChar(source[index])) index++;
                    prev = source.slice(tokenStart, index);
                } else if (tokenChar >= '0' && tokenChar <= '9') {
                    while (index < length && /[0-9a-zA-Z_.]/.test(source[index])) index++;
                    prev = 'NUM';
                } else if (tokenChar === '{') {
                    depth++;
                    prev = '{';
                    index++;
                } else if (tokenChar === '}') {
                    depth--;
                    prev = '}';
                    index++;
                } else {
                    [prev, index] = readOperatorOrPunctuator(source, index);
                }
            }
            if (collect) exprs.push({ start: exprStart, end: index });
            chunkStart = index;
            continue;
        }
        index++;
    }
    return { end: length, quasis, exprs };
}

function peekNextToken(source, startIndex, length) {
    const nextIndex = skipWhitespaceAndComments(source, startIndex, length);
    return nextIndex < length ? readOperatorOrPunctuator(source, nextIndex)[0] : '';
}

function extractAllJsTemplates(source) {
    const out = [];
    const length = source.length;
    let index = 0;
    let prevToken = '';
    while (index < length) {
        index = skipWhitespaceAndComments(source, index, length);
        if (index >= length) break;
        const ch = source[index];
        if (ch === '"' || ch === "'") {
            index = skipStringLiteral(source, index, length);
            prevToken = 'STR';
            continue;
        }
        if (ch === '`') {
            const start = index;
            const parsedTpl = parseTemplateLiteral(source, index, length, true);
            index = parsedTpl.end;
            prevToken = 'STR';
            if (parsedTpl.exprs && parsedTpl.exprs.length > 0 && parsedTpl.exprs.length <= 6 && index - start <= 800) {
                out.push({ start, end: index, quasis: parsedTpl.quasis, exprs: parsedTpl.exprs });
            }
            continue;
        }
        if (ch === '/' && REGEX_PRECEDERS.has(prevToken)) {
            index = skipRegexLiteral(source, index, length);
            prevToken = 'REG';
            continue;
        }
        if (isIdentifierStart(ch)) {
            const tokenStart = index++;
            while (index < length && isIdentifierChar(source[index])) index++;
            prevToken = source.slice(tokenStart, index);
            continue;
        }
        if (ch >= '0' && ch <= '9') {
            while (index < length && /[0-9a-zA-Z_.]/.test(source[index])) index++;
            prevToken = 'NUM';
            continue;
        }
        [prevToken, index] = readOperatorOrPunctuator(source, index);
    }
    return out;
}

function classifyStringSite(frame, prevToken, nextCh) {
    if (!frame || frame.inSkippedSubtree) return null;
    if (frame.type === 'ce' && frame.argIdx >= 2 && /^[,?:]$|^(&&|\|\||\?\?)$/.test(prevToken) && /^[,):]$/.test(nextCh)) {
        return { kind: 'ce-child', key: null, targetCe: frame };
    }
    if (frame.type === 'paren' && frame.inCeChild && /^[(?:]$|^(&&|\|\||\?\?)$/.test(prevToken) && (nextCh === ')' || nextCh === ':')) {
        return { kind: 'ce-child', key: null, targetCe: frame.ceOwner };
    }
    if (frame.type === 'bracket' && frame.inCeChild && /^[[?:,]$/.test(prevToken) && /^[,:\]]$/.test(nextCh)) {
        return { kind: 'ce-child', key: null, targetCe: frame.ceOwner };
    }
    if (frame.type === 'brace' && frame.curKey && /^[:?]$|^(&&|\|\||\?\?)$/.test(prevToken) && /^[,}:]$/.test(nextCh)) {
        if (frame.isCeProps && UI_PROP_KEYS.has(frame.curKey)) return { kind: 'ce-prop', key: frame.curKey, targetCe: null };
        if (!frame.isCeProps && OBJ_UI_PROP_KEYS.has(frame.curKey)) return { kind: 'obj-prop', key: frame.curKey, targetCe: null };
    }
    return null;
}

function scanUiSites(source, reactIdent) {
    const length = source.length;
    const sites = [];
    const templateSites = [];
    const elementFrames = [];
    const objPropCandidates = [];
    const objTplCandidates = [];
    const comparedLiterals = new Set();
    const stack = [];
    let index = 0;
    let prevToken = '';
    let lastIdent = '';
    let afterDot = false;

    const top = () => (stack.length ? stack[stack.length - 1] : null);
    const stepToken = (token, nextIndex, nextIdent = '') => {
        prevToken = token;
        lastIdent = nextIdent;
        afterDot = false;
        index = nextIndex;
    };
    const finalizeCeArg = frame => {
        if (frame && frame.type === 'ce' && frame.argIdx >= 2 && !frame.curArgHasSlot) {
            frame.curArgHasSlot = true;
            frame.hasExprSlot = true;
            frame.childParts.push({ type: 'slot', text: '1' });
        }
    };
    const pushLiteralSite = (frame, siteClass, start, end, val) => {
        const site = { start, end, val, kind: siteClass.kind, key: siteClass.key };
        if (siteClass.kind === 'obj-prop') {
            frame.pendingObjProps.push(site);
            return;
        }
        sites.push(site);
        if (siteClass.kind === 'ce-child' && siteClass.targetCe) {
            siteClass.targetCe.hasLiteral = true;
            siteClass.targetCe.curArgHasSlot = true;
            siteClass.targetCe.childParts.push({ type: 'lit', site });
        }
    };

    while (index < length) {
        index = skipWhitespaceAndComments(source, index, length);
        if (index >= length) break;
        const ch = source[index];

        if (ch === '"' || ch === "'") {
            const start = index;
            const end = skipStringLiteral(source, index, length);
            const raw = source.slice(start, end);
            const nextToken = peekNextToken(source, end, length);
            const nextCh = nextToken[0] || '';
            if (/^(?:===?|!==?|case)$/.test(prevToken) || /^(?:===?|!==?)$/.test(nextToken)) {
                const comparedVal = decodeJsString(raw);
                if (comparedVal !== null) comparedLiterals.add(comparedVal);
            }
            const frame = top();
            if (frame && frame.type === 'brace' && nextCh === ':' && (prevToken === '{' || prevToken === ',')) {
                const key = decodeJsString(raw);
                if (key !== null) {
                    frame.curKey = key;
                    frame.siblingKeys?.add(key);
                }
            } else if (frame && frame.type === 'ce' && frame.argIdx === 0 && !frame.tagSet) {
                const tag = (decodeJsString(raw) || '').toLowerCase();
                if (tag && SKIP_TAGS.has(tag)) {
                    frame.inSkippedSubtree = true;
                    if (tag === 'code') frame.collectFlatOnly = true;
                }
                frame.tagSet = true;
            } else if (frame && !frame.inSkippedSubtree) {
                const siteClass = classifyStringSite(frame, prevToken, nextCh);
                const val = siteClass ? decodeJsString(raw) : null;
                if (val) pushLiteralSite(frame, siteClass, start, end, val);
            } else if (frame && frame.type === 'ce' && frame.collectFlatOnly && frame.argIdx >= 2 &&
                (prevToken === ',' || prevToken === '?' || prevToken === ':') && (nextCh === ',' || nextCh === ')')) {
                const val = decodeJsString(raw);
                if (val) {
                    frame.curArgHasSlot = true;
                    frame.childParts.push({ type: 'slot', text: val });
                }
            }
            stepToken('STR', end);
            continue;
        }
        if (ch === '`') {
            const start = index;
            const frame = top();
            const isTagged = prevToken === ')' || prevToken === ']' || isIdentifierStart(prevToken[0] || '');
            const mayCollect = Boolean(!isTagged && frame && !frame.inSkippedSubtree && !(frame.type === 'ce' && frame.argIdx === 0));
            const parsedTpl = parseTemplateLiteral(source, index, length, mayCollect);
            if (mayCollect) {
                const nextToken = peekNextToken(source, parsedTpl.end, length);
                const nextCh = nextToken[0] || '';
                if (parsedTpl.exprs.length === 0) {
                    const val = parsedTpl.quasis[0] || '';
                    if (/^(?:===?|!==?|case)$/.test(prevToken) || /^(?:===?|!==?)$/.test(nextToken)) comparedLiterals.add(val);
                    const siteClass = val ? classifyStringSite(frame, prevToken, nextCh) : null;
                    if (siteClass) pushLiteralSite(frame, siteClass, start, parsedTpl.end, val);
                } else {
                    const siteClass = classifyStringSite(frame, prevToken, nextCh);
                    if (siteClass) {
                        const templateSite = {
                            start,
                            end: parsedTpl.end,
                            kind: siteClass.kind,
                            key: siteClass.key,
                            quasis: parsedTpl.quasis,
                            exprs: parsedTpl.exprs
                        };
                        if (siteClass.kind === 'obj-prop') {
                            frame.pendingObjTpls.push(templateSite);
                        } else {
                            templateSites.push(templateSite);
                            if (siteClass.kind === 'ce-child' && siteClass.targetCe) {
                                siteClass.targetCe.curArgHasSlot = true;
                                siteClass.targetCe.hasExprSlot = true;
                                siteClass.targetCe.childParts.push({ type: 'slot', text: parsedTpl.quasis.join('1') || '1' });
                            }
                        }
                    }
                }
            }
            stepToken('STR', parsedTpl.end);
            continue;
        }
        if (ch === '/' && REGEX_PRECEDERS.has(prevToken)) {
            stepToken('REG', skipRegexLiteral(source, index, length));
            continue;
        }
        if (isIdentifierStart(ch)) {
            const tokenStart = index++;
            while (index < length && isIdentifierChar(source[index])) index++;
            const ident = source.slice(tokenStart, index);
            const frame = top();
            if (frame && frame.type === 'brace' && (prevToken === '{' || prevToken === ',') && peekNextToken(source, index, length) === ':') {
                frame.curKey = ident;
                frame.siblingKeys?.add(ident);
            }
            stepToken(ident, index, afterDot ? `${lastIdent}.${ident}` : ident);
            continue;
        }
        if (ch >= '0' && ch <= '9') {
            while (index < length && /[0-9a-zA-Z_.]/.test(source[index])) index++;
            stepToken('NUM', index);
            continue;
        }
        if (ch === '.') {
            afterDot = true;
            prevToken = '.';
            index++;
            continue;
        }

        if (ch === '(') {
            const parentFrame = top();
            const inSkippedSubtree = Boolean(parentFrame?.inSkippedSubtree);
            const isCe = Boolean(reactIdent && lastIdent === `${reactIdent}.createElement`);
            if (isCe) {
                stack.push({
                    type: 'ce',
                    argIdx: 0,
                    tagSet: false,
                    inSkippedSubtree,
                    collectFlatOnly: false,
                    childParts: [],
                    hasExprSlot: false,
                    hasLiteral: false,
                    curArgHasSlot: false,
                    flatText: ''
                });
            } else if (prevToken === ')' || prevToken === ']' || isIdentifierStart(prevToken[0] || '')) {
                stack.push({ type: 'call', inSkippedSubtree, inCeChild: false, ceOwner: null });
            } else {
                const inCeChild = Boolean(
                    parentFrame && ((parentFrame.type === 'ce' && parentFrame.argIdx >= 2) || parentFrame.inCeChild) && !inSkippedSubtree
                );
                stack.push({
                    type: 'paren',
                    inSkippedSubtree,
                    inCeChild,
                    ceOwner: parentFrame?.type === 'ce' ? parentFrame : parentFrame?.ceOwner || null
                });
            }
            stepToken('(', index + 1);
            continue;
        }
        if (ch === ')') {
            const frame = top();
            if (frame && (frame.type === 'ce' || frame.type === 'call' || frame.type === 'paren')) {
                if (frame.type === 'ce') finalizeCeArg(frame);
                stack.pop();
                if (frame.type === 'ce') {
                    frame.flatText = frame.childParts.map(part => (part.type === 'lit' ? part.site.val : part.text)).join('');
                    if (frame.hasExprSlot) {
                        frame.childParts.forEach(part => {
                            if (part.type === 'lit') part.site.inMultiChild = true;
                        });
                    }
                    if (!frame.inSkippedSubtree && frame.childParts.length >= 2 && (frame.hasExprSlot || frame.argIdx >= 3) && frame.hasLiteral) {
                        elementFrames.push(frame);
                    }
                    const outer = top();
                    if (outer && outer.type === 'ce' && outer.argIdx >= 2 && !outer.curArgHasSlot) {
                        outer.curArgHasSlot = true;
                        outer.hasExprSlot = true;
                        outer.childParts.push({ type: 'slot', text: frame.flatText || '1', childCe: frame });
                    }
                }
            }
            stepToken(')', index + 1);
            continue;
        }
        if (ch === '{') {
            const parentFrame = top();
            const isCeProps = Boolean(parentFrame && parentFrame.type === 'ce' && parentFrame.argIdx === 1 && !parentFrame.inSkippedSubtree);
            stack.push({
                type: 'brace',
                isCeProps,
                inSkippedSubtree: Boolean(parentFrame?.inSkippedSubtree),
                curKey: null,
                siblingKeys: isCeProps ? null : new Set(),
                pendingObjProps: isCeProps ? null : [],
                pendingObjTpls: isCeProps ? null : []
            });
            stepToken('{', index + 1);
            continue;
        }
        if (ch === '}') {
            const frame = top();
            if (frame && frame.type === 'brace') {
                stack.pop();
                if (!frame.isCeProps && (frame.pendingObjProps.length > 0 || frame.pendingObjTpls.length > 0)) {
                    const isSchema = Array.from(SCHEMA_SIBLING_KEYS).some(key => frame.siblingKeys.has(key));
                    for (const site of frame.pendingObjProps) {
                        if (!(isSchema && site.key === 'title')) objPropCandidates.push(site);
                    }
                    for (const templateSite of frame.pendingObjTpls) {
                        if (!(isSchema && templateSite.key === 'title')) objTplCandidates.push(templateSite);
                    }
                }
            }
            stepToken('}', index + 1);
            continue;
        }
        if (ch === '[') {
            const parentFrame = top();
            const inSkippedSubtree = Boolean(parentFrame?.inSkippedSubtree);
            const inCeChild = Boolean(
                parentFrame && ((parentFrame.type === 'ce' && parentFrame.argIdx >= 2) || parentFrame.inCeChild) && !inSkippedSubtree
            );
            stack.push({
                type: 'bracket',
                inSkippedSubtree,
                inCeChild,
                ceOwner: parentFrame?.type === 'ce' ? parentFrame : parentFrame?.ceOwner || null
            });
            stepToken('[', index + 1);
            continue;
        }
        if (ch === ']') {
            if (top()?.type === 'bracket') stack.pop();
            stepToken(']', index + 1);
            continue;
        }
        if (ch === ',') {
            const frame = top();
            if (frame?.type === 'ce') {
                finalizeCeArg(frame);
                frame.argIdx++;
                frame.curArgHasSlot = false;
            }
            if (frame?.type === 'brace') frame.curKey = null;
            stepToken(',', index + 1);
            continue;
        }
        const [token, nextIndex] = readOperatorOrPunctuator(source, index);
        stepToken(token, nextIndex);
    }

    for (const site of objPropCandidates) {
        if (!comparedLiterals.has(site.val)) sites.push(site);
    }
    for (const templateSite of objTplCandidates) templateSites.push(templateSite);
    sites.sort((a, b) => a.start - b.start);
    templateSites.sort((a, b) => a.start - b.start);
    return { sites, tplSites: templateSites, ceFrames: elementFrames, comparedLiterals };
}

function isTechnicalTemplate(quasis) {
    const joined = quasis.join(' ');
    if (!/[a-zA-Z]{2,}/.test(joined)) return true;
    if (/(?:^|\s):root\b|\bvar\(--|calc\(|data-[a-z-]+=|[{}]|^(?:https?|file|vscode|plugin):\/\/|^CRON_TZ=/i.test(joined)) return true;
    if (/^[!a-z0-9_]+\(\$\{\}/i.test(quasis.join('${}').trim())) return true;
    return false;
}

function isEnglishPluralSuffixPair(pair) {
    if (!pair) return false;
    const [first, second] = pair;
    return (first === '' && (second === 's' || second === 'es')) || (second === '' && (first === 's' || first === 'es'));
}

function countResidualAsciiWords(templateCode) {
    if (typeof templateCode !== 'string') return Infinity;
    const inner = templateCode.slice(1, -1).replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, ' ');
    return (inner.match(/[A-Za-z]{2,}/g) || []).length;
}

function interpolateTranslatedTemplate(translated, slotTokens, exprSources) {
    const placements = [];
    for (let k = 0; k < slotTokens.length; k++) {
        const token = slotTokens[k];
        const pos = translated.indexOf(token);
        if (pos === -1 || translated.indexOf(token, pos + token.length) !== -1) return null;
        placements.push({ pos, len: token.length, rawExpr: exprSources[k] });
    }
    placements.sort((a, b) => a.pos - b.pos);
    for (let k = 1; k < placements.length; k++) {
        if (placements[k].pos < placements[k - 1].pos + placements[k - 1].len) return null;
    }
    let output = '`';
    let cursor = 0;
    for (const placement of placements) {
        output += escapeTemplateQuasi(translated.slice(cursor, placement.pos)) + placement.rawExpr;
        cursor = placement.pos + placement.len;
    }
    return output + escapeTemplateQuasi(translated.slice(cursor)) + '`';
}

function rewriteTemplateSite(templateSite, source, translator) {
    if (isTechnicalTemplate(templateSite.quasis)) return null;
    const exprSources = templateSite.exprs.map(expr => source.slice(expr.start, expr.end));
    const canUseNumericProbe = !templateSite.quasis.some(quasi => quasi.includes(NUMERIC_PROBE_GUARD));

    // 当 pluralPairs 非空时同时探测单复数两分支并要求译文一致，以安全折叠多余的英文复数后缀三元表达式
    const probeTemplate = (keptIndices, pluralPairs, makeToken, checkRaw) => {
        const tokens = keptIndices.map((_, j) => makeToken(j));
        const tokenByOrigIdx = new Map();
        keptIndices.forEach((origIdx, j) => tokenByOrigIdx.set(origIdx, tokens[j]));

        const buildKey = (branchIdx, probePos = -1, probeVal = '') => {
            let key = '';
            for (let idx = 0; idx < templateSite.quasis.length; idx++) {
                key += templateSite.quasis[idx];
                if (idx < templateSite.exprs.length) {
                    if (pluralPairs && pluralPairs[idx]) key += pluralPairs[idx][branchIdx];
                    else if (probePos !== -1 && keptIndices[probePos] === idx) key += probeVal;
                    else key += tokenByOrigIdx.get(idx);
                }
            }
            return key;
        };

        const key0 = buildKey(0);
        const trans0 = translator.translateString(key0);
        if (!trans0 || trans0 === key0) return null;
        if (pluralPairs) {
            const key1 = buildKey(1);
            const trans1 = translator.translateString(key1);
            if (!trans1 || trans1 === key1 || trans0 !== trans1) return null;
        }
        if (checkRaw) {
            for (let j = 0; j < keptIndices.length; j++) {
                for (const probe of RAW_SLOT_PROBES) {
                    const probeKey = buildKey(0, j, probe);
                    const probeTrans = translator.translateString(probeKey);
                    if (probeTrans && probeTrans !== probeKey && !probeTrans.includes(probe)) return false;
                }
            }
        }
        return interpolateTranslatedTemplate(trans0, tokens, keptIndices.map(idx => exprSources[idx]));
    };

    const lead = (templateSite.quasis[0] || '').match(/^\s*/)[0];
    const trail = (templateSite.quasis[templateSite.quasis.length - 1] || '').match(/\s*$/)[0];
    const applyTrim = code => (
        code && (lead || trail)
            ? '`' + escapeTemplateQuasi(lead) + code.slice(1, -1) + escapeTemplateQuasi(trail) + '`'
            : code
    );

    const pluralPairs = exprSources.map(exprCode => {
        const pair = expandStringTernaryExpr(exprCode);
        return isEnglishPluralSuffixPair(pair) ? pair : null;
    });
    if (pluralPairs.some(Boolean)) {
        const keptIndices = [];
        for (let idx = 0; idx < templateSite.exprs.length; idx++) {
            if (!pluralPairs[idx]) keptIndices.push(idx);
        }
        const numericFolded = canUseNumericProbe
            ? probeTemplate(keptIndices, pluralPairs, j => String(NUMERIC_PROBE_BASE + j), false)
            : null;
        if (typeof numericFolded === 'string') return applyTrim(numericFolded);
        const slotFolded = probeTemplate(keptIndices, pluralPairs, j => `${TEXT_SLOT_PREFIX}${j}`, true);
        if (slotFolded === false) return null;
        if (typeof slotFolded === 'string') return applyTrim(slotFolded);
    }

    const allIndices = templateSite.exprs.map((_, idx) => idx);
    const slotResult = probeTemplate(allIndices, null, i => `${TEXT_SLOT_PREFIX}${i}`, true);
    if (slotResult === false) return null;
    const numericResult = canUseNumericProbe
        ? probeTemplate(allIndices, null, i => String(NUMERIC_PROBE_BASE + i), false)
        : null;

    let hit = null;
    if (typeof slotResult === 'string' && typeof numericResult === 'string') {
        hit = countResidualAsciiWords(numericResult) < countResidualAsciiWords(slotResult) ? numericResult : slotResult;
    } else {
        hit = typeof slotResult === 'string' ? slotResult : (typeof numericResult === 'string' ? numericResult : null);
    }
    return applyTrim(hit);
}

function applyFragmentNodeReplacement(val, rule, translator) {
    for (const replacement of rule.replacements) {
        const match = val.match(replacement.matchRe);
        if (!match) continue;
        if (replacement.normalizeEllipsis) {
            return replacement.replace.replace('$1', (val.includes('...') || val.includes('…')) ? '...' : '');
        }
        let output = replacement.replace;
        for (let groupIndex = match.length - 1; groupIndex >= 1; groupIndex--) {
            let groupVal = match[groupIndex] ?? '';
            if (groupVal && (replacement.formatAll || replacement.formatGroupSet?.has(groupIndex)) && typeof translator.formatDuration === 'function') {
                groupVal = translator.formatDuration(groupVal) || groupVal;
            }
            output = output.split('$' + groupIndex).join(groupVal);
        }
        return output;
    }
    return null;
}

function collectElementLiteralSites(ceFrame, includeNested = false, out = []) {
    for (const part of ceFrame.childParts) {
        if (part.type === 'lit') {
            out.push(part.site);
        } else if (includeNested && part.childCe && !part.childCe.inSkippedSubtree) {
            collectElementLiteralSites(part.childCe, true, out);
        }
    }
    return out;
}

function rewriteBundleSource(source, translator, config = {}) {
    const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const reactIdent = detectReactIdent(source);
    if (!reactIdent || !translator) {
        return {
            code: source,
            stats: { reactIdent: reactIdent || null, rewrittenSites: 0, fragmentSites: 0, templateSites: 0, uniqueOriginals: 0, elapsedMs: 0 }
        };
    }

    const { sites, tplSites: templateSites, ceFrames: elementFrames } = scanUiSites(source, reactIdent);
    const normalize = typeof translator.norm === 'function'
        ? translator.norm
        : (str => String(str || '').replace(/[\s\u00A0\u2009\u202F]+/g, ' ').trim());
    const lowerExclude = new Set((config?.lowerWordsExclude || []).map(word => String(word).toLowerCase()));
    const fragmentRules = (config?.fragmentPatterns || [])
        .filter(rule => rule && !rule.containerSelector && rule.containerPattern)
        .map(rule => ({
            containerRe: new RegExp(rule.containerPattern, 'i'),
            matchNested: Boolean(rule.matchNested),
            replacements: (rule.nodeReplacements || []).map(replacement => ({
                matchRe: new RegExp(replacement.match, 'i'),
                replace: replacement.replace,
                normalizeEllipsis: Boolean(replacement.normalizeEllipsis),
                formatAll: replacement.formatGroups === true,
                formatGroupSet: Array.isArray(replacement.formatGroups) ? new Set(replacement.formatGroups) : null
            }))
        }));

    let fragmentSites = 0;
    let rewrittenTemplateSites = 0;
    if (fragmentRules.length > 0) {
        for (const ceFrame of elementFrames) {
            const simText = normalize(ceFrame.flatText);
            const strippedSim = normalize(ceFrame.flatText.replace(/^1+(?=[A-Za-z])/, ''));
            const matchingRules = simText
                ? fragmentRules.filter(rule => rule.containerRe.test(simText) || (strippedSim !== simText && rule.containerRe.test(strippedSim)))
                : [];
            if (matchingRules.length === 0) continue;

            let directLiterals = null;
            let nestedLiterals = null;
            for (const rule of matchingRules) {
                const targets = rule.matchNested
                    ? (nestedLiterals || (nestedLiterals = collectElementLiteralSites(ceFrame, true)))
                    : (directLiterals || (directLiterals = collectElementLiteralSites(ceFrame, false)));
                for (const site of targets) {
                    if (site.handledByFragment) continue;
                    const replacedVal = applyFragmentNodeReplacement(site.val, rule, translator);
                    if (replacedVal !== null && replacedVal !== site.val) {
                        site.fragmentReplacement = replacedVal;
                        site.handledByFragment = true;
                        fragmentSites++;
                    }
                }
            }
        }
    }

    const edits = [];
    const uniqueOriginals = new Set();
    for (const site of sites) {
        let replacementText = null;
        if (site.handledByFragment) {
            replacementText = site.fragmentReplacement;
        } else if (/[a-zA-Z]/.test(site.val)) {
            if (site.key === 'aria-label' && site.val.trim() === 'Cancel') continue;
            if (site.kind === 'obj-prop') {
                const trimmed = site.val.trim();
                if (lowerExclude.has(trimmed.toLowerCase()) || (!OBJ_STRICT_KEYS.has(site.key) && /^[a-z0-9_-]+$/.test(trimmed))) continue;
            }
            const translated = translator.translateString(site.val);
            if (translated && translated !== site.val) {
                replacementText = site.val.match(/^\s*/)[0] + translated + site.val.match(/\s*$/)[0];
            }
        }
        if (replacementText !== null && replacementText !== site.val) {
            edits.push([site.start, site.end, serializeJsString(replacementText)]);
            uniqueOriginals.add(site.val);
        }
    }
    for (const templateSite of templateSites) {
        const rewrittenTemplate = rewriteTemplateSite(templateSite, source, translator);
        if (rewrittenTemplate) {
            edits.push([templateSite.start, templateSite.end, rewrittenTemplate]);
            uniqueOriginals.add(templateSite.quasis.join('${}'));
            rewrittenTemplateSites++;
        }
    }
    edits.sort((a, b) => a[0] - b[0]);

    const parts = [];
    let cursor = 0;
    for (const [start, end, replacement] of edits) {
        if (start < cursor) continue;
        parts.push(source.slice(cursor, start), replacement);
        cursor = end;
    }
    parts.push(
        source.slice(cursor),
        '\n;try{if(typeof document!=="undefined"&&document.documentElement)document.documentElement.dataset.agL10nBundle="1";}catch(e){}\n'
    );

    const endTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return {
        code: parts.join(''),
        stats: {
            reactIdent,
            rewrittenSites: edits.length,
            fragmentSites,
            templateSites: rewrittenTemplateSites,
            uniqueOriginals: uniqueOriginals.size,
            elapsedMs: Math.round((endTime - startTime) * 10) / 10
        }
    };
}

function isPartialMultiChildFragment(str) {
    if (!str || /^[a-z.,?!;:—–·)\]]/.test(str) || /[(\-,]$/.test(str)) return true;
    if (!/[:.?!)]$/.test(str)) {
        if (str.split(/\s+/).length <= 2) return true;
        if (/(?:\b(?:to|by|with|of|for|in|on|at|from|as|and|or|the|a|an|our|your|their|its|is|are|was|were)|#)$/i.test(str)) return true;
    }
    return false;
}

function extractReactUiStrings(source, normalizeFn, filterFn) {
    const out = new Map();
    const reactIdent = detectReactIdent(source);
    if (!reactIdent) return out;
    const normalize = typeof normalizeFn === 'function' ? normalizeFn : (str => String(str || '').trim());
    for (const site of scanUiSites(source, reactIdent).sites) {
        const norm = normalize(site.val);
        if (!norm || (site.kind === 'ce-child' && site.inMultiChild && isPartialMultiChildFragment(norm))) continue;
        if (typeof filterFn === 'function' && !filterFn(norm)) continue;
        let tags = out.get(norm);
        if (!tags) {
            tags = new Set();
            out.set(norm, tags);
        }
        tags.add(site.kind === 'ce-child' ? 'ce:child' : (site.kind === 'ce-prop' ? `ce:prop:${site.key}` : `obj:prop:${site.key}`));
    }
    return out;
}

function expandStringTernaryExpr(exprCode) {
    const match = exprCode.match(/^\$\{(?:[^?]|\?\.)+\?\s*(["'])((?:\\.|(?!\1)[^\\])*)\1\s*:\s*(["'])((?:\\.|(?!\3)[^\\])*)\3\s*\}$/);
    if (!match) return null;
    return [decodeJsStringBody(match[2]), decodeJsStringBody(match[4])];
}

function extractReactUiTemplates(source, normalizeFn) {
    const out = new Map();
    const reactIdent = detectReactIdent(source);
    if (!reactIdent) return [];
    const normalize = typeof normalizeFn === 'function' ? normalizeFn : (str => String(str || '').trim());
    for (const templateSite of scanUiSites(source, reactIdent).tplSites) {
        if (isTechnicalTemplate(templateSite.quasis)) continue;
        const exprSources = templateSite.exprs.map(expr => source.slice(expr.start, expr.end));
        const raw = templateSite.quasis.map((quasi, idx) => (idx < exprSources.length ? `${quasi}${exprSources[idx]}` : quasi)).join('');
        const templateKey = normalize(
            templateSite.quasis.map((quasi, idx) => (idx < templateSite.exprs.length ? `${quasi}\${${idx}}` : quasi)).join('')
        );
        if (!templateKey || out.has(templateKey)) continue;

        let variants = [''];
        for (let idx = 0; idx < templateSite.quasis.length; idx++) {
            const quasi = templateSite.quasis[idx];
            if (idx < exprSources.length) {
                const ternaryChoices = expandStringTernaryExpr(exprSources[idx]);
                const choices = ternaryChoices || ['SampleName', '5'];
                const next = [];
                for (const prefix of variants) {
                    for (const choice of choices) next.push(prefix + quasi + choice);
                    if (next.length > 16) break;
                }
                variants = next;
            } else {
                variants = variants.map(variant => variant + quasi);
            }
        }
        const sims = Array.from(new Set(variants.map(normalize).filter(Boolean)));
        out.set(templateKey, {
            templateKey,
            sims,
            kind: templateSite.kind,
            key: templateSite.key || '',
            raw
        });
    }
    return Array.from(out.values());
}

function extractReactUiMultiChild(source, normalizeFn) {
    const reactIdent = detectReactIdent(source);
    if (!reactIdent) return [];
    const normalize = typeof normalizeFn === 'function' ? normalizeFn : (str => String(str || '').trim());
    const out = [];
    const seen = new Set();
    for (const ceFrame of scanUiSites(source, reactIdent).ceFrames) {
        const flat = normalize(ceFrame.flatText);
        if (!flat || !/[a-zA-Z]{2,}/.test(flat)) continue;
        const lits = ceFrame.childParts.filter(part => part.type === 'lit').map(part => part.site.val);
        const alphaJoined = normalize(lits.join(' '));
        const words = alphaJoined.split(/\s+/).filter(Boolean);
        if (words.length < 2 && lits.length === 1 && !/[()/:?!.]/.test(alphaJoined)) continue;
        const slotView = normalize(ceFrame.childParts.map(part => (part.type === 'lit' ? part.site.val : '{x}')).join(''));
        if (seen.has(slotView)) continue;
        seen.add(slotView);
        out.push({
            flat,
            slotView,
            lits,
            nestedLits: collectElementLiteralSites(ceFrame, true).map(site => site.val)
        });
    }
    return out;
}

module.exports = {
    detectReactIdent,
    extractAllJsTemplates,
    expandStringTernaryExpr,
    rewriteBundleSource,
    extractReactUiStrings,
    extractReactUiTemplates,
    extractReactUiMultiChild
};
