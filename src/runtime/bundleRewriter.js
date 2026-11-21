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
const REGEX_PRECEDERS = new Set([
    '', '(', '[', '{', ',', ';', ':', '?', '=', '!', '&', '|', '^', '~', '+', '-', '*', '%', '<', '>',
    '&&', '||', '??', '==', '!=', '===', '!==', '=>',
    'return', 'case', 'throw', 'typeof', 'void', 'delete', 'in', 'of', 'instanceof', 'await', 'yield', 'else', 'do'
]);

const isIdStart = c => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$';
const isIdChar = c => isIdStart(c) || (c >= '0' && c <= '9');
const serializeJsString = s => JSON.stringify(s).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const escapeTplQuasi = s => String(s)
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
    for (const m of source.matchAll(/\b([A-Za-z_$][\w$]*)\.createElement\(/g)) {
        if (!exclude.has(m[1])) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
    }
    let bestName = null, bestCount = 0;
    for (const [name, cnt] of counts.entries()) {
        if (cnt > bestCount) { bestName = name; bestCount = cnt; }
    }
    return bestCount >= 50 ? bestName : null;
}

function skipStr(s, i, len) {
    const q = s[i++];
    while (i < len) {
        const c = s[i++];
        if (c === '\\') { i += (s[i] === '\r' && s[i + 1] === '\n') ? 2 : 1; continue; }
        if (c === q) return i;
    }
    return len;
}

function skipRe(s, i, len) {
    i++;
    for (let inCC = false; i < len;) {
        const c = s[i++];
        if (c === '\\') { i++; continue; }
        if (c === '[' && !inCC) inCC = true;
        else if (c === ']' && inCC) inCC = false;
        else if ((c === '/' && !inCC) || c === '\n') break;
    }
    while (i < len && ((s[i] >= 'a' && s[i] <= 'z') || (s[i] >= 'A' && s[i] <= 'Z'))) i++;
    return i;
}

function skipWsComment(s, i, len) {
    while (i < len) {
        const c = s[i];
        if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
        if (c === '/' && s[i + 1] === '/') { i += 2; while (i < len && s[i] !== '\n') i++; continue; }
        if (c === '/' && s[i + 1] === '*') { i += 2; while (i < len && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }
        break;
    }
    return i;
}

function readOpOrPunct(s, i) {
    const t3 = s.slice(i, i + 3);
    if (t3 === '===' || t3 === '!==') return [t3, i + 3];
    const t2 = s.slice(i, i + 2);
    if (t2 === '&&' || t2 === '||' || t2 === '??' || t2 === '==' || t2 === '!=' || t2 === '=>') return [t2, i + 2];
    return [s[i] || '', i + 1];
}

function decodeJsBody(inner) {
    if (!inner || !inner.includes('\\')) return inner;
    return inner
        .replace(/\\(?:\r\n|\r|\n)/g, '')
        .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/g, (_, u, x) => String.fromCharCode(parseInt(u || x, 16)))
        .replace(/\\(.)/g, (_, ch) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' }[ch] || ch));
}

function decodeJsString(raw) {
    return raw && raw.length >= 2 ? decodeJsBody(raw.slice(1, -1)) : null;
}

function parseTpl(s, i, len, collect = false) {
    i++;
    let chunkStart = i;
    const quasis = collect ? [] : null;
    const exprs = collect ? [] : null;
    while (i < len) {
        const c = s[i];
        if (c === '\\') { i += (s[i + 1] === '\r' && s[i + 2] === '\n') ? 3 : 2; continue; }
        if (c === '`') {
            if (collect) quasis.push(decodeJsBody(s.slice(chunkStart, i)));
            return { end: i + 1, quasis, exprs };
        }
        if (c === '$' && s[i + 1] === '{') {
            if (collect) quasis.push(decodeJsBody(s.slice(chunkStart, i)));
            const exprStart = i;
            i += 2;
            for (let depth = 1, prev = '{'; i < len && depth > 0;) {
                i = skipWsComment(s, i, len);
                if (i >= len) break;
                const tc = s[i];
                if (tc === '"' || tc === "'") { i = skipStr(s, i, len); prev = 'STR'; }
                else if (tc === '`') { i = parseTpl(s, i, len, false).end; prev = 'STR'; }
                else if (tc === '/' && REGEX_PRECEDERS.has(prev)) { i = skipRe(s, i, len); prev = 'REG'; }
                else if (isIdStart(tc)) { const st = i++; while (i < len && isIdChar(s[i])) i++; prev = s.slice(st, i); }
                else if (tc >= '0' && tc <= '9') { while (i < len && /[0-9a-zA-Z_.]/.test(s[i])) i++; prev = 'NUM'; }
                else if (tc === '{') { depth++; prev = '{'; i++; }
                else if (tc === '}') { depth--; prev = '}'; i++; }
                else { [prev, i] = readOpOrPunct(s, i); }
            }
            if (collect) exprs.push({ start: exprStart, end: i });
            chunkStart = i;
            continue;
        }
        i++;
    }
    return { end: len, quasis, exprs };
}

function peekNextToken(s, i, len) {
    i = skipWsComment(s, i, len);
    return i < len ? readOpOrPunct(s, i)[0] : '';
}

function extractAllJsTemplates(source) {
    const out = [];
    const len = source.length;
    for (let i = 0, prevTok = ''; i < len;) {
        i = skipWsComment(source, i, len);
        if (i >= len) break;
        const ch = source[i];
        if (ch === '"' || ch === "'") { i = skipStr(source, i, len); prevTok = 'STR'; continue; }
        if (ch === '`') {
            const start = i;
            const tpl = parseTpl(source, i, len, true);
            i = tpl.end;
            prevTok = 'STR';
            if (tpl.exprs && tpl.exprs.length > 0 && tpl.exprs.length <= 6 && i - start <= 800) {
                out.push({ start, end: i, quasis: tpl.quasis, exprs: tpl.exprs });
            }
            continue;
        }
        if (ch === '/' && REGEX_PRECEDERS.has(prevTok)) { i = skipRe(source, i, len); prevTok = 'REG'; continue; }
        if (isIdStart(ch)) { const st = i++; while (i < len && isIdChar(source[i])) i++; prevTok = source.slice(st, i); continue; }
        if (ch >= '0' && ch <= '9') { while (i < len && /[0-9a-zA-Z_.]/.test(source[i])) i++; prevTok = 'NUM'; continue; }
        [prevTok, i] = readOpOrPunct(source, i);
    }
    return out;
}

function classifyStringSite(frame, prevTok, nextCh) {
    if (!frame || frame.inSkippedSubtree) return null;
    if (frame.type === 'ce' && frame.argIdx >= 2 && /^[,?:]$|^(&&|\|\||\?\?)$/.test(prevTok) && /^[,):]$/.test(nextCh)) {
        return { kind: 'ce-child', key: null, targetCe: frame };
    }
    if (frame.type === 'paren' && frame.inCeChild && /^[(?:]$|^(&&|\|\||\?\?)$/.test(prevTok) && (nextCh === ')' || nextCh === ':')) {
        return { kind: 'ce-child', key: null, targetCe: frame.ceOwner };
    }
    if (frame.type === 'bracket' && frame.inCeChild && /^[[?:,]$/.test(prevTok) && /^[,:\]]$/.test(nextCh)) {
        return { kind: 'ce-child', key: null, targetCe: frame.ceOwner };
    }
    if (frame.type === 'brace' && frame.curKey && /^[:?]$|^(&&|\|\||\?\?)$/.test(prevTok) && /^[,}:]$/.test(nextCh)) {
        if (frame.isCeProps && UI_PROP_KEYS.has(frame.curKey)) return { kind: 'ce-prop', key: frame.curKey, targetCe: null };
        if (!frame.isCeProps && OBJ_UI_PROP_KEYS.has(frame.curKey)) return { kind: 'obj-prop', key: frame.curKey, targetCe: null };
    }
    return null;
}

function scanUiSites(source, reactIdent) {
    const len = source.length;
    const sites = [], tplSites = [], ceFrames = [], objPropCandidates = [], objTplCandidates = [], comparedLiterals = new Set(), stack = [];
    let i = 0, prevTok = '', lastIdent = '', afterDot = false;

    const top = () => (stack.length ? stack[stack.length - 1] : null);
    const stepTok = (tok, nextI, nextIdent = '') => { prevTok = tok; lastIdent = nextIdent; afterDot = false; i = nextI; };
    const finalizeCeArg = f => {
        if (f && f.type === 'ce' && f.argIdx >= 2 && !f.curArgHasSlot) {
            f.curArgHasSlot = true; f.hasExprSlot = true; f.childParts.push({ type: 'slot', text: '1' });
        }
    };
    const pushLiteralSite = (frame, cls, start, end, val) => {
        const site = { start, end, val, kind: cls.kind, key: cls.key };
        if (cls.kind === 'obj-prop') frame.pendingObjProps.push(site);
        else {
            sites.push(site);
            if (cls.kind === 'ce-child' && cls.targetCe) {
                cls.targetCe.hasLiteral = true; cls.targetCe.curArgHasSlot = true;
                cls.targetCe.childParts.push({ type: 'lit', site });
            }
        }
    };

    while (i < len) {
        i = skipWsComment(source, i, len);
        if (i >= len) break;
        const ch = source[i];

        if (ch === '"' || ch === "'") {
            const start = i, end = skipStr(source, i, len), raw = source.slice(start, end);
            const nextTok = peekNextToken(source, end, len), nextCh = nextTok[0] || '';
            if (/^(?:===?|!==?|case)$/.test(prevTok) || /^(?:===?|!==?)$/.test(nextTok)) {
                const cmpVal = decodeJsString(raw);
                if (cmpVal !== null) comparedLiterals.add(cmpVal);
            }
            const frame = top();
            if (frame && frame.type === 'brace' && nextCh === ':' && (prevTok === '{' || prevTok === ',')) {
                const key = decodeJsString(raw);
                if (key !== null) { frame.curKey = key; frame.siblingKeys?.add(key); }
            } else if (frame && frame.type === 'ce' && frame.argIdx === 0 && !frame.tagSet) {
                const tag = (decodeJsString(raw) || '').toLowerCase();
                if (tag && SKIP_TAGS.has(tag)) { frame.inSkippedSubtree = true; if (tag === 'code') frame.collectFlatOnly = true; }
                frame.tagSet = true;
            } else if (frame && !frame.inSkippedSubtree) {
                const cls = classifyStringSite(frame, prevTok, nextCh);
                const val = cls ? decodeJsString(raw) : null;
                if (val) pushLiteralSite(frame, cls, start, end, val);
            } else if (frame && frame.type === 'ce' && frame.collectFlatOnly && frame.argIdx >= 2 &&
                (prevTok === ',' || prevTok === '?' || prevTok === ':') && (nextCh === ',' || nextCh === ')')) {
                const val = decodeJsString(raw);
                if (val) { frame.curArgHasSlot = true; frame.childParts.push({ type: 'slot', text: val }); }
            }
            stepTok('STR', end); continue;
        }
        if (ch === '`') {
            const start = i, frame = top();
            const isTagged = prevTok === ')' || prevTok === ']' || isIdStart(prevTok[0] || '');
            const mayCollect = Boolean(!isTagged && frame && !frame.inSkippedSubtree && !(frame.type === 'ce' && frame.argIdx === 0));
            const tpl = parseTpl(source, i, len, mayCollect);
            if (mayCollect) {
                const nextTok = peekNextToken(source, tpl.end, len), nextCh = nextTok[0] || '';
                if (tpl.exprs.length === 0) {
                    const val = tpl.quasis[0] || '';
                    if (/^(?:===?|!==?|case)$/.test(prevTok) || /^(?:===?|!==?)$/.test(nextTok)) comparedLiterals.add(val);
                    const cls = val ? classifyStringSite(frame, prevTok, nextCh) : null;
                    if (cls) pushLiteralSite(frame, cls, start, tpl.end, val);
                } else {
                    const cls = classifyStringSite(frame, prevTok, nextCh);
                    if (cls) {
                        const tSite = { start, end: tpl.end, kind: cls.kind, key: cls.key, quasis: tpl.quasis, exprs: tpl.exprs };
                        if (cls.kind === 'obj-prop') frame.pendingObjTpls.push(tSite);
                        else {
                            tplSites.push(tSite);
                            if (cls.kind === 'ce-child' && cls.targetCe) {
                                cls.targetCe.curArgHasSlot = true; cls.targetCe.hasExprSlot = true;
                                cls.targetCe.childParts.push({ type: 'slot', text: tpl.quasis.join('1') || '1' });
                            }
                        }
                    }
                }
            }
            stepTok('STR', tpl.end); continue;
        }
        if (ch === '/' && REGEX_PRECEDERS.has(prevTok)) { stepTok('REG', skipRe(source, i, len)); continue; }
        if (isIdStart(ch)) {
            const st = i++;
            while (i < len && isIdChar(source[i])) i++;
            const id = source.slice(st, i), frame = top();
            if (frame && frame.type === 'brace' && (prevTok === '{' || prevTok === ',') && peekNextToken(source, i, len) === ':') {
                frame.curKey = id; frame.siblingKeys?.add(id);
            }
            stepTok(id, i, afterDot ? `${lastIdent}.${id}` : id); continue;
        }
        if (ch >= '0' && ch <= '9') {
            while (i < len && /[0-9a-zA-Z_.]/.test(source[i])) i++;
            stepTok('NUM', i); continue;
        }
        if (ch === '.') { afterDot = true; prevTok = '.'; i++; continue; }

        if (ch === '(') {
            const p = top(), pSkip = Boolean(p?.inSkippedSubtree);
            const isCe = Boolean(reactIdent && lastIdent === `${reactIdent}.createElement`);
            if (isCe) {
                stack.push({ type: 'ce', argIdx: 0, tagSet: false, inSkippedSubtree: pSkip, collectFlatOnly: false, childParts: [], hasExprSlot: false, hasLiteral: false, curArgHasSlot: false, flatText: '' });
            } else if (prevTok === ')' || prevTok === ']' || isIdStart(prevTok[0] || '')) {
                stack.push({ type: 'call', inSkippedSubtree: pSkip, inCeChild: false, ceOwner: null });
            } else {
                stack.push({ type: 'paren', inSkippedSubtree: pSkip, inCeChild: Boolean(p && ((p.type === 'ce' && p.argIdx >= 2) || p.inCeChild) && !pSkip), ceOwner: p?.type === 'ce' ? p : p?.ceOwner || null });
            }
            stepTok('(', i + 1); continue;
        }
        if (ch === ')') {
            const f = top();
            if (f && (f.type === 'ce' || f.type === 'call' || f.type === 'paren')) {
                if (f.type === 'ce') finalizeCeArg(f);
                stack.pop();
                if (f.type === 'ce') {
                    f.flatText = f.childParts.map(p => (p.type === 'lit' ? p.site.val : p.text)).join('');
                    if (f.hasExprSlot) f.childParts.forEach(p => { if (p.type === 'lit') p.site.inMultiChild = true; });
                    if (!f.inSkippedSubtree && f.childParts.length >= 2 && f.hasExprSlot && f.hasLiteral) ceFrames.push(f);
                    const outer = top();
                    if (outer && outer.type === 'ce' && outer.argIdx >= 2 && !outer.curArgHasSlot) {
                        outer.curArgHasSlot = true; outer.hasExprSlot = true;
                        outer.childParts.push({ type: 'slot', text: f.flatText || '1' });
                    }
                }
            }
            stepTok(')', i + 1); continue;
        }
        if (ch === '{') {
            const p = top(), isCeProps = Boolean(p && p.type === 'ce' && p.argIdx === 1 && !p.inSkippedSubtree);
            stack.push({
                type: 'brace', isCeProps, inSkippedSubtree: Boolean(p?.inSkippedSubtree), curKey: null,
                siblingKeys: isCeProps ? null : new Set(), pendingObjProps: isCeProps ? null : [], pendingObjTpls: isCeProps ? null : []
            });
            stepTok('{', i + 1); continue;
        }
        if (ch === '}') {
            const f = top();
            if (f && f.type === 'brace') {
                stack.pop();
                if (!f.isCeProps && (f.pendingObjProps.length > 0 || f.pendingObjTpls.length > 0)) {
                    const isSchema = Array.from(SCHEMA_SIBLING_KEYS).some(k => f.siblingKeys.has(k));
                    for (const site of f.pendingObjProps) if (!(isSchema && site.key === 'title')) objPropCandidates.push(site);
                    for (const tSite of f.pendingObjTpls) if (!(isSchema && tSite.key === 'title')) objTplCandidates.push(tSite);
                }
            }
            stepTok('}', i + 1); continue;
        }
        if (ch === '[') {
            const p = top(), pSkip = Boolean(p?.inSkippedSubtree);
            stack.push({ type: 'bracket', inSkippedSubtree: pSkip, inCeChild: Boolean(p && ((p.type === 'ce' && p.argIdx >= 2) || p.inCeChild) && !pSkip), ceOwner: p?.type === 'ce' ? p : p?.ceOwner || null });
            stepTok('[', i + 1); continue;
        }
        if (ch === ']') {
            if (top()?.type === 'bracket') stack.pop();
            stepTok(']', i + 1); continue;
        }
        if (ch === ',') {
            const f = top();
            if (f?.type === 'ce') { finalizeCeArg(f); f.argIdx++; f.curArgHasSlot = false; }
            if (f?.type === 'brace') f.curKey = null;
            stepTok(',', i + 1); continue;
        }
        const [tok, nextI] = readOpOrPunct(source, i);
        stepTok(tok, nextI);
    }

    for (const site of objPropCandidates) if (!comparedLiterals.has(site.val)) sites.push(site);
    for (const tSite of objTplCandidates) tplSites.push(tSite);
    sites.sort((a, b) => a.start - b.start);
    tplSites.sort((a, b) => a.start - b.start);
    return { sites, tplSites, ceFrames, comparedLiterals };
}

function isTechnicalTemplate(quasis) {
    const joined = quasis.join(' ');
    if (!/[a-zA-Z]{2,}/.test(joined)) return true;
    if (/(?:^|\s):root\b|\bvar\(--|calc\(|data-[a-z-]+=|[{}]|^(?:https?|file|vscode|plugin):\/\/|^CRON_TZ=/i.test(joined)) return true;
    if (/^[!a-z0-9_]+\(\$\{\}/i.test(quasis.join('${}').trim())) return true;
    return false;
}

function rewriteTemplateSite(tSite, source, translator) {
    if (isTechnicalTemplate(tSite.quasis)) return null;
    const tryBuild = (mkTok, checkRaw) => {
        const toks = tSite.exprs.map((_, idx) => mkTok(idx));
        const key = tSite.quasis.map((q, idx) => (idx < toks.length ? `${q}${toks[idx]}` : q)).join('');
        const t = translator.translateString(key);
        if (!t || t === key) return null;
        const placements = [];
        for (let k = 0; k < toks.length; k++) {
            const tok = toks[k];
            const pos = t.indexOf(tok);
            if (pos === -1 || t.indexOf(tok, pos + tok.length) !== -1) return null;
            placements.push({ pos, len: tok.length, rawExpr: source.slice(tSite.exprs[k].start, tSite.exprs[k].end) });
        }
        placements.sort((a, b) => a.pos - b.pos);
        for (let k = 1; k < placements.length; k++) {
            if (placements[k].pos < placements[k - 1].pos + placements[k - 1].len) return null;
        }
        if (checkRaw) {
            for (let k = 0; k < toks.length; k++) {
                for (const probe of ['Settings', 'Privacy Policy']) {
                    const kProbe = tSite.quasis.map((q, idx) => (idx < toks.length ? `${q}${idx === k ? probe : toks[idx]}` : q)).join('');
                    const tProbe = translator.translateString(kProbe);
                    if (tProbe && tProbe !== kProbe && !tProbe.includes(probe)) return false;
                }
            }
        }
        let out = '`', cur = 0;
        for (const p of placements) {
            out += escapeTplQuasi(t.slice(cur, p.pos)) + p.rawExpr;
            cur = p.pos + p.len;
        }
        return out + escapeTplQuasi(t.slice(cur)) + '`';
    };
    const lead = (tSite.quasis[0] || '').match(/^\s*/)[0];
    const trail = (tSite.quasis[tSite.quasis.length - 1] || '').match(/\s*$/)[0];
    const applyTrim = code => (code && (lead || trail) ? '`' + escapeTplQuasi(lead) + code.slice(1, -1) + escapeTplQuasi(trail) + '`' : code);
    const agRes = tryBuild(i => `AGSLOT${i}`, true);
    if (agRes === false) return null;
    const hit = agRes || (!tSite.quasis.some(q => q.includes('9910')) ? tryBuild(i => String(99100 + i), false) : null);
    return applyTrim(typeof hit === 'string' ? hit : null);
}

function applyFragmentNodeReplacement(val, rule, translator) {
    for (const rep of rule.replacements) {
        const m = val.match(rep.matchRe);
        if (!m) continue;
        if (rep.normalizeEllipsis) return rep.replace.replace('$1', (val.includes('...') || val.includes('…')) ? '...' : '');
        let out = rep.replace;
        for (let g = m.length - 1; g >= 1; g--) {
            let gVal = m[g] ?? '';
            if (gVal && (rep.formatAll || rep.formatGroupSet?.has(g)) && typeof translator.formatDuration === 'function') {
                gVal = translator.formatDuration(gVal) || gVal;
            }
            out = out.split('$' + g).join(gVal);
        }
        return out;
    }
    return null;
}

function rewriteBundleSource(source, translator, config = {}) {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const reactIdent = detectReactIdent(source);
    if (!reactIdent || !translator) {
        return { code: source, stats: { reactIdent: reactIdent || null, rewrittenSites: 0, fragmentSites: 0, templateSites: 0, uniqueOriginals: 0, elapsedMs: 0 } };
    }

    const { sites, tplSites, ceFrames } = scanUiSites(source, reactIdent);
    const normFn = typeof translator.norm === 'function' ? translator.norm : (s => String(s || '').replace(/[\s\u00A0\u2009\u202F]+/g, ' ').trim());
    const lowerExclude = new Set((config?.lowerWordsExclude || []).map(w => String(w).toLowerCase()));
    const fragmentRules = (config?.fragmentPatterns || [])
        .filter(fp => fp && !fp.containerSelector && fp.containerPattern)
        .map(fp => ({
            containerRe: new RegExp(fp.containerPattern, 'i'),
            replacements: (fp.nodeReplacements || []).map(nr => ({
                matchRe: new RegExp(nr.match, 'i'),
                replace: nr.replace,
                normalizeEllipsis: Boolean(nr.normalizeEllipsis),
                formatAll: nr.formatGroups === true,
                formatGroupSet: Array.isArray(nr.formatGroups) ? new Set(nr.formatGroups) : null
            }))
        }));

    let fragmentSites = 0, templateSites = 0;
    if (fragmentRules.length > 0) {
        for (const ce of ceFrames) {
            const simText = normFn(ce.flatText);
            const strippedSim = normFn(ce.flatText.replace(/^1+(?=[A-Za-z])/, ''));
            const matching = simText ? fragmentRules.filter(r => r.containerRe.test(simText) || (strippedSim !== simText && r.containerRe.test(strippedSim))) : [];
            if (matching.length === 0) continue;
            for (const part of ce.childParts) {
                if (part.type !== 'lit' || part.site.handledByFragment) continue;
                for (const rule of matching) {
                    const repVal = applyFragmentNodeReplacement(part.site.val, rule, translator);
                    if (repVal !== null && repVal !== part.site.val) {
                        part.site.fragmentReplacement = repVal;
                        part.site.handledByFragment = true;
                        fragmentSites++;
                        break;
                    }
                }
            }
        }
    }

    const edits = [], uniqueOriginals = new Set();
    for (const site of sites) {
        let repText = null;
        if (site.handledByFragment) {
            repText = site.fragmentReplacement;
        } else if (/[a-zA-Z]/.test(site.val)) {
            if (site.kind === 'obj-prop') {
                const trimmed = site.val.trim();
                if (lowerExclude.has(trimmed.toLowerCase()) || (!OBJ_STRICT_KEYS.has(site.key) && /^[a-z0-9_-]+$/.test(trimmed))) continue;
            }
            const trans = translator.translateString(site.val);
            if (trans && trans !== site.val) repText = site.val.match(/^\s*/)[0] + trans + site.val.match(/\s*$/)[0];
        }
        if (repText !== null && repText !== site.val) {
            edits.push([site.start, site.end, serializeJsString(repText)]);
            uniqueOriginals.add(site.val);
        }
    }
    for (const tSite of tplSites) {
        const repTpl = rewriteTemplateSite(tSite, source, translator);
        if (repTpl) {
            edits.push([tSite.start, tSite.end, repTpl]);
            uniqueOriginals.add(tSite.quasis.join('${}'));
            templateSites++;
        }
    }
    edits.sort((a, b) => a[0] - b[0]);

    const parts = [];
    let cursor = 0;
    for (const [start, end, rep] of edits) {
        if (start < cursor) continue;
        parts.push(source.slice(cursor, start), rep);
        cursor = end;
    }
    parts.push(source.slice(cursor), '\n;try{if(typeof document!=="undefined"&&document.documentElement)document.documentElement.dataset.agL10nBundle="1";}catch(e){}\n');

    const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return {
        code: parts.join(''),
        stats: { reactIdent, rewrittenSites: edits.length, fragmentSites, templateSites, uniqueOriginals: uniqueOriginals.size, elapsedMs: Math.round((t1 - t0) * 10) / 10 }
    };
}

function isPartialMultiChildFragment(s) {
    if (!s || /^[a-z.,?!;:—–·)\]]/.test(s) || /[(\-,]$/.test(s)) return true;
    if (!/[:.?!)]$/.test(s)) {
        if (s.split(/\s+/).length <= 2) return true;
        if (/(?:\b(?:to|by|with|of|for|in|on|at|from|as|and|or|the|a|an|our|your|their|its|is|are|was|were)|#)$/i.test(s)) return true;
    }
    return false;
}

function extractReactUiStrings(source, normalizeFn, filterFn) {
    const out = new Map();
    const reactIdent = detectReactIdent(source);
    if (!reactIdent) return out;
    const norm = typeof normalizeFn === 'function' ? normalizeFn : (s => String(s || '').trim());
    for (const site of scanUiSites(source, reactIdent).sites) {
        const s = norm(site.val);
        if (!s || (site.kind === 'ce-child' && site.inMultiChild && isPartialMultiChildFragment(s))) continue;
        if (typeof filterFn === 'function' && !filterFn(s)) continue;
        let tags = out.get(s);
        if (!tags) { tags = new Set(); out.set(s, tags); }
        tags.add(site.kind === 'ce-child' ? 'ce:child' : (site.kind === 'ce-prop' ? `ce:prop:${site.key}` : `obj:prop:${site.key}`));
    }
    return out;
}

function expandStringTernaryExpr(exprCode) {
    const m = exprCode.match(/^\$\{(?:[^?]|\?\.)+\?\s*(["'])((?:\\.|(?!\1)[^\\])*)\1\s*:\s*(["'])((?:\\.|(?!\3)[^\\])*)\3\s*\}$/);
    if (!m) return null;
    return [decodeJsBody(m[2]), decodeJsBody(m[4])];
}

function extractReactUiTemplates(source, normalizeFn) {
    const out = new Map();
    const reactIdent = detectReactIdent(source);
    if (!reactIdent) return [];
    const norm = typeof normalizeFn === 'function' ? normalizeFn : (s => String(s || '').trim());
    for (const t of scanUiSites(source, reactIdent).tplSites) {
        if (isTechnicalTemplate(t.quasis)) continue;
        const exprSources = t.exprs.map(e => source.slice(e.start, e.end));
        const raw = t.quasis.map((q, idx) => (idx < exprSources.length ? `${q}${exprSources[idx]}` : q)).join('');
        const templateKey = norm(t.quasis.map((q, idx) => (idx < t.exprs.length ? `${q}\${${idx}}` : q)).join(''));
        if (!templateKey || out.has(templateKey)) continue;

        let variants = [''];
        for (let idx = 0; idx < t.quasis.length; idx++) {
            const q = t.quasis[idx];
            if (idx < exprSources.length) {
                const tern = expandStringTernaryExpr(exprSources[idx]);
                const choices = tern || ['SampleName', '5'];
                const next = [];
                for (const prefix of variants) {
                    for (const ch of choices) next.push(prefix + q + ch);
                    if (next.length > 16) break;
                }
                variants = next;
            } else {
                variants = variants.map(v => v + q);
            }
        }
        const sims = Array.from(new Set(variants.map(norm).filter(Boolean)));
        out.set(templateKey, {
            templateKey,
            sims,
            kind: t.kind,
            key: t.key || '',
            raw
        });
    }
    return Array.from(out.values());
}

function extractReactUiMultiChild(source, normalizeFn) {
    const reactIdent = detectReactIdent(source);
    if (!reactIdent) return [];
    const norm = typeof normalizeFn === 'function' ? normalizeFn : (s => String(s || '').trim());
    const out = [], seen = new Set();
    for (const ce of scanUiSites(source, reactIdent).ceFrames) {
        const flat = norm(ce.flatText);
        if (!flat || !/[a-zA-Z]{2,}/.test(flat)) continue;
        const lits = ce.childParts.filter(p => p.type === 'lit').map(p => p.site.val);
        const alphaJoined = norm(lits.join(' '));
        const words = alphaJoined.split(/\s+/).filter(Boolean);
        if (words.length < 2 && lits.length === 1 && !/[()/:?!.]/.test(alphaJoined)) continue;
        const slotView = norm(ce.childParts.map(p => (p.type === 'lit' ? p.site.val : '{x}')).join(''));
        if (seen.has(slotView)) continue;
        seen.add(slotView);
        out.push({ flat, slotView, lits });
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
