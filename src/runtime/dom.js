function installDomTranslator(translator, config) {
    if (typeof document === 'undefined') return;
    const docEl = document.documentElement;
    if (document._agL10nInstalled || (docEl && docEl._agL10nInstalled)) return;

    try {
        const markTarget = typeof Object.isExtensible !== 'function' || Object.isExtensible(document)
            ? document
            : (docEl && (typeof Object.isExtensible !== 'function' || Object.isExtensible(docEl)) ? docEl : null);
        if (markTarget) {
            try {
                Object.defineProperty(markTarget, '_agL10nInstalled', { value: true });
            } catch {
                if (markTarget !== docEl && docEl && (typeof Object.isExtensible !== 'function' || Object.isExtensible(docEl))) {
                    Object.defineProperty(docEl, '_agL10nInstalled', { value: true });
                }
            }
        }

        const VERDICT_ALLOW = 0;
        const VERDICT_SOFT_BLOCK = 1;
        const VERDICT_HARD_BLOCK = 2;
        const VERDICT_BYPASS = 3;

        const cfg = config || {};
        const normalize = typeof translator.norm === 'function'
            ? translator.norm
            : (s => (s ? String(s).replace(/[\s\u00A0\u2009\u202F]+/g, ' ').trim() : ''));
        const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const cleanList = arr => (arr || []).map(c => c.trim()).filter(Boolean);
        const buildClassWordRe = list => (list.length
            ? new RegExp(`(?:^|\\s)(?:${list.map(escapeRegExp).join('|')})(?=\\s|$)`, 'i')
            : null);

        const BLOCKED_TAG_SET = new Set((cfg.blockedTags || []).map(t => t.toUpperCase()));
        const BLOCKED_CLASS_LIST = cleanList(cfg.blockedClasses);
        const BLOCKED_CLASS_SUBSTRINGS = cleanList(cfg.blockedClassSubstrings);
        const BLOCKED_TESTID_SET = new Set((cfg.blockedTestIds || []).map(id => id.toLowerCase()));
        const BLOCKED_TESTID_SUBSTRINGS = (cfg.blockedTestIdSubstrings || []).map(id => id.toLowerCase()).filter(Boolean);
        const BLOCKED_DATA_ATTRS = (cfg.blockedDataAttrs || []).filter(Boolean);
        const BYPASS_CLASS_LIST = cleanList(cfg.bypassClasses);
        const BYPASS_ROLE_SET = new Set((cfg.bypassRoles || []).map(r => r.toLowerCase()));
        const CODE_EDITOR_KEYWORDS = cleanList(cfg.codeEditorKeywords);
        const CONV_ROW_ALLOWED = new Set(cfg.conversationRowAllowedTexts || []);

        const hardClassParts = [];
        if (BLOCKED_CLASS_SUBSTRINGS.length) hardClassParts.push(BLOCKED_CLASS_SUBSTRINGS.map(escapeRegExp).join('|'));
        if (CODE_EDITOR_KEYWORDS.length) {
            hardClassParts.push(`(?:^|\\s)(?!(?:bg-|text-|border-|decoration-|scrollbar-))[^\\s:\\[\\]]*(?:${CODE_EDITOR_KEYWORDS.map(escapeRegExp).join('|')})[^\\s:\\[\\]]*(?=\\s|$)`);
        }
        const HARD_BLOCKED_CLASS_RE = hardClassParts.length ? new RegExp(hardClassParts.join('|'), 'i') : null;
        const SOFT_BLOCKED_CLASS_RE = buildClassWordRe(BLOCKED_CLASS_LIST);
        const BYPASS_CLASS_RE = buildClassWordRe(BYPASS_CLASS_LIST);

        const FRAGMENT_RULES = (cfg.fragmentPatterns || []).map(fp => ({
            containerSelector: fp.containerSelector || '',
            containerRe: new RegExp(fp.containerPattern, 'i'),
            replacements: (fp.nodeReplacements || []).map(nr => ({
                matchRe: new RegExp(nr.match, 'i'),
                replace: nr.replace,
                normalizeEllipsis: Boolean(nr.normalizeEllipsis),
                formatAll: nr.formatGroups === true,
                formatGroupSet: Array.isArray(nr.formatGroups) ? new Set(nr.formatGroups) : null
            }))
        }));

        const fragmentMatchSources = [];
        for (let i = 0; i < FRAGMENT_RULES.length; i++) {
            const reps = FRAGMENT_RULES[i].replacements;
            for (let j = 0; j < reps.length; j++) {
                fragmentMatchSources.push('(?:' + reps[j].matchRe.source + ')');
            }
        }
        const FRAGMENT_NODE_PREFILTER_RE = fragmentMatchSources.length
            ? new RegExp(fragmentMatchSources.join('|'), 'i')
            : null;

        const translatedValues = new WeakMap();
        const translatedAttrs = new WeakMap();
        const elementVerdictCache = new WeakMap();

        function getClassString(el) {
            const className = el.className;
            if (typeof className === 'string') return className;
            if (className && typeof className.baseVal === 'string') return className.baseVal;
            return '';
        }

        function computeStaticVerdict(el, cls) {
            const tag = el.tagName ? el.tagName.toUpperCase() : '';
            if (BLOCKED_TAG_SET.has(tag)) return VERDICT_HARD_BLOCK;
            for (let i = 0; i < BLOCKED_DATA_ATTRS.length; i++) {
                if (el.hasAttribute?.(BLOCKED_DATA_ATTRS[i])) return VERDICT_HARD_BLOCK;
            }
            const contentEditable = el.getAttribute?.('contenteditable');
            if (contentEditable === 'true' || contentEditable === 'plaintext-only' || contentEditable === '') return VERDICT_HARD_BLOCK;
            if (el.getAttribute?.('translate') === 'no') return VERDICT_HARD_BLOCK;

            const testId = el.getAttribute?.('data-testid') || '';
            let lowerTestId = '';
            if (testId) {
                lowerTestId = testId.toLowerCase();
                if (BLOCKED_TESTID_SET.has(lowerTestId)) return VERDICT_HARD_BLOCK;
                for (let i = 0; i < BLOCKED_TESTID_SUBSTRINGS.length; i++) {
                    if (lowerTestId.includes(BLOCKED_TESTID_SUBSTRINGS[i])) return VERDICT_HARD_BLOCK;
                }
            }
            if (cls && HARD_BLOCKED_CLASS_RE && HARD_BLOCKED_CLASS_RE.test(cls)) return VERDICT_HARD_BLOCK;

            if (lowerTestId.startsWith('conversation-row-')) return VERDICT_SOFT_BLOCK;
            if (cls && SOFT_BLOCKED_CLASS_RE && SOFT_BLOCKED_CLASS_RE.test(cls)) return VERDICT_SOFT_BLOCK;

            if (tag === 'DIALOG' || tag === 'BUTTON') return VERDICT_BYPASS;
            const role = el.getAttribute?.('role');
            if (role && BYPASS_ROLE_SET.has(role.toLowerCase())) return VERDICT_BYPASS;
            if (el.getAttribute?.('aria-modal') === 'true') return VERDICT_BYPASS;
            if (el.hasAttribute?.('data-radix-popper-content-wrapper')) return VERDICT_BYPASS;
            if (cls && BYPASS_CLASS_RE && BYPASS_CLASS_RE.test(cls)) return VERDICT_BYPASS;
            return VERDICT_ALLOW;
        }

        function getSelfVerdict(el) {
            if (!el || el.nodeType !== Node.ELEMENT_NODE) return VERDICT_ALLOW;
            const cls = getClassString(el);
            const cached = elementVerdictCache.get(el);
            if (cached && cached.cls === cls) return cached.verdict;
            const verdict = computeStaticVerdict(el, cls);
            elementVerdictCache.set(el, { cls, verdict });
            return verdict;
        }

        function getParentOrHost(node) {
            return node.parentElement
                || (node.parentNode && node.parentNode.nodeType === Node.ELEMENT_NODE ? node.parentNode : null)
                || node.getRootNode?.()?.host
                || null;
        }

        function isConvRowAllowed(el, fallbackText) {
            if (CONV_ROW_ALLOWED.size === 0) return false;
            if (el && el.childElementCount === 0) {
                const raw = el.textContent;
                const trimmed = raw ? raw.trim() : '';
                if (trimmed && CONV_ROW_ALLOWED.has(trimmed)) return true;
            }
            return Boolean(fallbackText && CONV_ROW_ALLOWED.has(fallbackText.trim()));
        }

        function resolveZoneState(node) {
            try {
                if (!node) return { state: VERDICT_ALLOW, cacheable: true };
                const isText = node.nodeType === Node.TEXT_NODE;
                const fallbackText = isText ? node.nodeValue : '';
                let curr = isText ? getParentOrHost(node) : node;
                const originEl = curr;
                let softResult = null;
                let convBypass = false;
                while (curr && curr.nodeType === Node.ELEMENT_NODE) {
                    const verdict = getSelfVerdict(curr);
                    if (verdict === VERDICT_HARD_BLOCK) {
                        return { state: VERDICT_HARD_BLOCK, cacheable: true };
                    }
                    if (softResult === null) {
                        if (verdict === VERDICT_BYPASS) {
                            softResult = VERDICT_ALLOW;
                        } else if (verdict === VERDICT_SOFT_BLOCK) {
                            const isConvRow = (curr.getAttribute?.('data-testid') || '').toLowerCase().startsWith('conversation-row-');
                            if (isConvRow && isConvRowAllowed(originEl, fallbackText)) {
                                softResult = VERDICT_ALLOW;
                                convBypass = true;
                            } else {
                                softResult = VERDICT_SOFT_BLOCK;
                            }
                        }
                    }
                    curr = getParentOrHost(curr);
                }
                return { state: softResult === null ? VERDICT_ALLOW : softResult, cacheable: !convBypass };
            } catch {}
            return { state: VERDICT_ALLOW, cacheable: true };
        }

        function translateSingleAttribute(node, attr) {
            const val = node.getAttribute(attr);
            if (!val || (attr === 'aria-label' && val.trim() === 'Cancel')) return;
            let attrMap = translatedAttrs.get(node);
            if (attrMap && attrMap[attr] === val) return;
            const trans = translator.translateString(val);
            if (trans !== null && trans !== val) {
                if (!attrMap) {
                    attrMap = Object.create(null);
                    translatedAttrs.set(node, attrMap);
                }
                attrMap[attr] = trans;
                node.setAttribute(attr, trans);
            }
        }

        function translateElementAttributes(node, isBlocked) {
            if (isBlocked) return;
            translateSingleAttribute(node, 'placeholder');
            translateSingleAttribute(node, 'title');
            translateSingleAttribute(node, 'aria-label');
        }

        function tryTranslateSiblingFragment(node, val) {
            if (!FRAGMENT_NODE_PREFILTER_RE || !FRAGMENT_NODE_PREFILTER_RE.test(val)) return false;
            const parentEl = getParentOrHost(node);
            if (!parentEl || !parentEl.childNodes || parentEl.childNodes.length < 2 || parentEl.childNodes.length > 16 || parentEl.childElementCount > 6) {
                return false;
            }
            let parentText = null;
            for (let i = 0; i < FRAGMENT_RULES.length; i++) {
                const rule = FRAGMENT_RULES[i];
                if (rule.containerSelector && !parentEl.matches?.(rule.containerSelector)) continue;
                if (parentText === null) {
                    parentText = normalize(parentEl.textContent);
                    if (!parentText) return false;
                }
                if (!rule.containerRe.test(parentText)) continue;
                for (let j = 0; j < rule.replacements.length; j++) {
                    const rep = rule.replacements[j];
                    const match = val.match(rep.matchRe);
                    if (!match) continue;
                    let replaced = rep.replace;
                    if (rep.normalizeEllipsis) {
                        replaced = replaced.replace('$1', (val.includes('...') || val.includes('…')) ? '...' : '');
                    } else if (match.length > 1) {
                        for (let g = match.length - 1; g >= 1; g--) {
                            let groupVal = match[g] !== undefined ? match[g] : '';
                            if (groupVal && (rep.formatAll || (rep.formatGroupSet && rep.formatGroupSet.has(g)))) {
                                const formatted = typeof translator.formatDuration === 'function'
                                    ? translator.formatDuration(groupVal)
                                    : null;
                                if (formatted) groupVal = formatted;
                            }
                            replaced = replaced.split('$' + g).join(groupVal);
                        }
                    }
                    node.nodeValue = replaced;
                    translatedValues.set(node, replaced);
                    return true;
                }
            }
            return false;
        }

        function translateTextNode(node) {
            const val = node.nodeValue;
            if (!val || val.trim().length < 1) return;
            if (translatedValues.get(node) === val) return;
            if (!/[a-zA-Z]/.test(val) && !/^[."”'’\s·]+$/.test(val)) {
                translatedValues.set(node, val);
                return;
            }
            if (tryTranslateSiblingFragment(node, val)) return;
            const trans = translator.translateString(val);
            if (trans !== null && trans !== val) {
                translatedValues.set(node, trans);
                node.nodeValue = trans;
            } else {
                translatedValues.set(node, val);
            }
        }

        function translateNode(node, parentState) {
            if (!node) return;
            try {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    if (parentState === VERDICT_HARD_BLOCK) return;
                    const tag = node.tagName ? node.tagName.toUpperCase() : '';
                    const verdict = getSelfVerdict(node);
                    if (verdict === VERDICT_HARD_BLOCK) {
                        if ((tag === 'INPUT' || tag === 'TEXTAREA') && parentState === VERDICT_ALLOW) {
                            translateElementAttributes(node, false);
                        }
                        return;
                    }
                    let nextState = verdict === VERDICT_SOFT_BLOCK
                        ? VERDICT_SOFT_BLOCK
                        : (verdict === VERDICT_BYPASS ? VERDICT_ALLOW : parentState);
                    if (nextState === VERDICT_SOFT_BLOCK && parentState === VERDICT_SOFT_BLOCK && isConvRowAllowed(node)) {
                        nextState = VERDICT_ALLOW;
                    }
                    translateElementAttributes(node, nextState !== VERDICT_ALLOW);
                    if (node.shadowRoot) translateNode(node.shadowRoot, nextState);
                    const childNodes = node.childNodes;
                    if (childNodes) {
                        for (let k = 0; k < childNodes.length; k++) {
                            translateNode(childNodes[k], nextState);
                        }
                    }
                } else if (node.nodeType === Node.TEXT_NODE) {
                    if (parentState === VERDICT_ALLOW || (parentState === VERDICT_SOFT_BLOCK && isConvRowAllowed(null, node.nodeValue))) {
                        translateTextNode(node);
                    }
                } else if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE || node.nodeType === (Node.DOCUMENT_NODE || 9)) {
                    const childNodes = node.childNodes;
                    if (childNodes) {
                        for (let k = 0; k < childNodes.length; k++) {
                            translateNode(childNodes[k], parentState);
                        }
                    }
                }
            } catch {}
        }

        const observer = new MutationObserver(mutations => {
            const parentCache = new Map();
            function getStateCached(el) {
                if (!el || el.nodeType !== Node.ELEMENT_NODE) return VERDICT_ALLOW;
                if (parentCache.has(el)) return parentCache.get(el);
                const { state, cacheable } = resolveZoneState(el);
                if (cacheable) {
                    parentCache.set(el, state);
                }
                return state;
            }
            let addedElemSet = null;
            if (mutations.length > 1) {
                for (let k = 0; k < mutations.length; k++) {
                    const mutation = mutations[k];
                    if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                        for (let n = 0; n < mutation.addedNodes.length; n++) {
                            const addedNode = mutation.addedNodes[n];
                            if (addedNode && addedNode.nodeType === Node.ELEMENT_NODE) {
                                if (!addedElemSet) addedElemSet = new Set();
                                addedElemSet.add(addedNode);
                            }
                        }
                    }
                }
            }
            function hasAddedAncestor(node) {
                if (!addedElemSet || addedElemSet.size <= 1) return false;
                let cur = getParentOrHost(node);
                while (cur) {
                    if (addedElemSet.has(cur)) return true;
                    cur = getParentOrHost(cur);
                }
                return false;
            }
            for (let k = 0; k < mutations.length; k++) {
                const mutation = mutations[k];
                if (mutation.type === 'childList') {
                    for (let n = 0; n < mutation.addedNodes.length; n++) {
                        const node = mutation.addedNodes[n];
                        if (hasAddedAncestor(node)) continue;
                        const parent = getParentOrHost(node);
                        translateNode(node, parent ? getStateCached(parent) : VERDICT_ALLOW);
                    }
                } else if (mutation.type === 'characterData') {
                    const node = mutation.target;
                    if (!node || translatedValues.get(node) === node.nodeValue) continue;
                    if (resolveZoneState(node).state === VERDICT_ALLOW) {
                        translateTextNode(node);
                    }
                } else if (mutation.type === 'attributes') {
                    const el = mutation.target;
                    if (el && el.nodeType === Node.ELEMENT_NODE && mutation.attributeName) {
                        const attrMap = translatedAttrs.get(el);
                        if (attrMap && attrMap[mutation.attributeName] === el.getAttribute(mutation.attributeName)) continue;
                        const tag = el.tagName ? el.tagName.toUpperCase() : '';
                        const checkTarget = (tag === 'INPUT' || tag === 'TEXTAREA') ? (getParentOrHost(el) || el) : el;
                        if (getStateCached(checkTarget) === VERDICT_ALLOW) {
                            translateSingleAttribute(el, mutation.attributeName);
                        }
                    }
                }
            }
        });

        const observerOptions = {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['title', 'placeholder', 'aria-label']
        };

        const target = document.documentElement || document;
        observer.observe(target, observerOptions);
        translateNode(target, VERDICT_ALLOW);

        if (document.readyState === 'loading' && typeof document.addEventListener === 'function') {
            document.addEventListener('DOMContentLoaded', () => {
                translateNode(document.documentElement || document, VERDICT_ALLOW);
            }, { once: true });
        }
    } catch (err) {
        console.error('[ANTIGRAVITY_DOM_TRANSLATOR_ERROR]', err);
    }
}

module.exports = {
    installDomTranslator
};
