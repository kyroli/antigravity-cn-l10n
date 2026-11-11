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
            } catch (e) {
                if (markTarget !== docEl && docEl && (typeof Object.isExtensible !== 'function' || Object.isExtensible(docEl))) {
                    Object.defineProperty(docEl, '_agL10nInstalled', { value: true });
                }
            }
        }

        const cfg = config || {};
        const normFn = typeof translator.norm === 'function'
            ? translator.norm
            : (s => (s ? String(s).replace(/[\s\u00A0\u2009\u202F]+/g, ' ').trim() : ''));
        const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        const BLOCKED_TAG_SET = new Set((cfg.blockedTags || []).map(t => t.toUpperCase()));
        const BLOCKED_CLASS_LIST = (cfg.blockedClasses || []).map(c => c.trim()).filter(Boolean);
        const BLOCKED_CLASS_SUBSTRINGS = (cfg.blockedClassSubstrings || []).map(c => c.trim()).filter(Boolean);
        const BLOCKED_TESTID_SET = new Set((cfg.blockedTestIds || []).map(id => id.toLowerCase()));
        const BLOCKED_TESTID_SUBSTRINGS = (cfg.blockedTestIdSubstrings || []).map(id => id.toLowerCase()).filter(Boolean);
        const BLOCKED_DATA_ATTRS = (cfg.blockedDataAttrs || []).filter(Boolean);
        const BYPASS_CLASS_LIST = (cfg.bypassClasses || []).map(c => c.trim()).filter(Boolean);
        const BYPASS_ROLE_SET = new Set((cfg.bypassRoles || []).map(r => r.toLowerCase()));
        const CODE_EDITOR_KEYWORDS = (cfg.codeEditorKeywords || []).map(k => k.trim()).filter(Boolean);
        const CONV_ROW_ALLOWED = new Set(cfg.conversationRowAllowedTexts || []);

        const hardClassParts = [];
        if (BLOCKED_CLASS_SUBSTRINGS.length) hardClassParts.push(BLOCKED_CLASS_SUBSTRINGS.map(escRe).join('|'));
        if (CODE_EDITOR_KEYWORDS.length) {
            hardClassParts.push(`(?:^|\\s)(?!(?:bg-|text-|border-|decoration-|scrollbar-))[^\\s:\\[\\]]*(?:${CODE_EDITOR_KEYWORDS.map(escRe).join('|')})[^\\s:\\[\\]]*(?=\\s|$)`);
        }
        const HARD_BLOCKED_CLASS_RE = hardClassParts.length ? new RegExp(hardClassParts.join('|'), 'i') : null;
        const SOFT_BLOCKED_CLASS_RE = BLOCKED_CLASS_LIST.length
            ? new RegExp(`(?:^|\\s)(?:${BLOCKED_CLASS_LIST.map(escRe).join('|')})(?=\\s|$)`, 'i')
            : null;
        const BYPASS_CLASS_RE = BYPASS_CLASS_LIST.length
            ? new RegExp(`(?:^|\\s)(?:${BYPASS_CLASS_LIST.map(escRe).join('|')})(?=\\s|$)`, 'i')
            : null;

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

        const translatedValues = new WeakMap();
        // verdict: 0 = neutral, 1 = soft-blocked, 2 = hard-blocked (不可绕过), 3 = bypass
        const elementVerdictCache = new WeakMap();

        function getClassString(el) {
            const cn = el.className;
            if (typeof cn === 'string') return cn;
            if (cn && typeof cn.baseVal === 'string') return cn.baseVal;
            return '';
        }

        function computeStaticVerdict(el, cls) {
            const tag = el.tagName ? el.tagName.toUpperCase() : '';
            if (BLOCKED_TAG_SET.has(tag)) return 2;
            for (let i = 0; i < BLOCKED_DATA_ATTRS.length; i++) {
                if (el.hasAttribute?.(BLOCKED_DATA_ATTRS[i])) return 2;
            }
            const ce = el.getAttribute?.('contenteditable');
            if (ce === 'true' || ce === 'plaintext-only' || ce === '') return 2;
            if (el.getAttribute?.('translate') === 'no') return 2;

            const testId = el.getAttribute?.('data-testid') || '';
            let lowerTestId = '';
            if (testId) {
                lowerTestId = testId.toLowerCase();
                if (BLOCKED_TESTID_SET.has(lowerTestId)) return 2;
                for (let i = 0; i < BLOCKED_TESTID_SUBSTRINGS.length; i++) {
                    if (lowerTestId.includes(BLOCKED_TESTID_SUBSTRINGS[i])) return 2;
                }
            }
            if (cls && HARD_BLOCKED_CLASS_RE && HARD_BLOCKED_CLASS_RE.test(cls)) return 2;

            if (lowerTestId.startsWith('conversation-row-')) return 1;
            if (cls && SOFT_BLOCKED_CLASS_RE && SOFT_BLOCKED_CLASS_RE.test(cls)) return 1;

            if (tag === 'DIALOG' || tag === 'BUTTON') return 3;
            const role = el.getAttribute?.('role');
            if (role && BYPASS_ROLE_SET.has(role.toLowerCase())) return 3;
            if (el.getAttribute?.('aria-modal') === 'true') return 3;
            if (el.hasAttribute?.('data-radix-popper-content-wrapper')) return 3;
            if (cls && BYPASS_CLASS_RE && BYPASS_CLASS_RE.test(cls)) return 3;
            return 0;
        }

        function getSelfVerdict(el) {
            if (!el || el.nodeType !== Node.ELEMENT_NODE) return 0;
            const cls = getClassString(el);
            const cached = elementVerdictCache.get(el);
            if (cached && cached.cls === cls) return cached.verdict;
            const verdict = computeStaticVerdict(el, cls);
            elementVerdictCache.set(el, { cls, verdict });
            return verdict;
        }

        function getParentOrHost(n) {
            return n.parentElement
                || (n.parentNode && n.parentNode.nodeType === Node.ELEMENT_NODE ? n.parentNode : null)
                || n.getRootNode?.()?.host
                || null;
        }

        function isConvRowAllowed(el, fallbackText) {
            if (CONV_ROW_ALLOWED.size === 0) return false;
            const t = el && el.textContent ? el.textContent.trim() : '';
            if (t && CONV_ROW_ALLOWED.has(t)) return true;
            return Boolean(fallbackText && CONV_ROW_ALLOWED.has(fallbackText.trim()));
        }

        // 返回区域状态: 0 = 开放, 1 = 软阻断, 2 = 硬阻断（祖先任意一层为 2 均不可绕过）
        function getZoneState(node) {
            try {
                if (!node) return 0;
                const isText = node.nodeType === Node.TEXT_NODE;
                const fallbackText = isText ? node.nodeValue : '';
                let curr = isText ? getParentOrHost(node) : node;
                const originEl = curr;
                let softResult = null;
                while (curr && curr.nodeType === Node.ELEMENT_NODE) {
                    const v = getSelfVerdict(curr);
                    if (v === 2) return 2;
                    if (softResult === null) {
                        if (v === 3) {
                            softResult = 0;
                        } else if (v === 1) {
                            const isConvRow = (curr.getAttribute?.('data-testid') || '').toLowerCase().startsWith('conversation-row-');
                            softResult = (isConvRow && isConvRowAllowed(originEl, fallbackText)) ? 0 : 1;
                        }
                    }
                    curr = getParentOrHost(curr);
                }
                return softResult === null ? 0 : softResult;
            } catch (e) {}
            return 0;
        }

        function translateSingleAttribute(node, attr) {
            const v = node.getAttribute(attr);
            if (!v || (attr === 'aria-label' && v.trim() === 'Cancel')) return;
            const trans = translator.translateString(v);
            if (trans !== null && trans !== v) {
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
            const parentEl = getParentOrHost(node);
            if (!parentEl || !parentEl.childNodes || parentEl.childNodes.length > 6 || parentEl.childElementCount > 1) {
                return false;
            }
            let parentText = null;
            for (let i = 0; i < FRAGMENT_RULES.length; i++) {
                const rule = FRAGMENT_RULES[i];
                if (rule.containerSelector && !parentEl.matches?.(rule.containerSelector)) continue;
                if (parentText === null) {
                    parentText = normFn(parentEl.textContent);
                    if (!parentText) return false;
                }
                if (!rule.containerRe.test(parentText)) continue;
                for (let j = 0; j < rule.replacements.length; j++) {
                    const rep = rule.replacements[j];
                    const m = val.match(rep.matchRe);
                    if (!m) continue;
                    let newV = rep.replace;
                    if (rep.normalizeEllipsis) {
                        newV = newV.replace('$1', (val.includes('...') || val.includes('…')) ? '...' : '');
                    } else if (m.length > 1) {
                        for (let g = m.length - 1; g >= 1; g--) {
                            let gVal = m[g] !== undefined ? m[g] : '';
                            if (gVal && (rep.formatAll || (rep.formatGroupSet && rep.formatGroupSet.has(g)))) {
                                const formatted = typeof translator.formatDuration === 'function'
                                    ? translator.formatDuration(gVal)
                                    : null;
                                if (formatted) gVal = formatted;
                            }
                            newV = newV.split('$' + g).join(gVal);
                        }
                    }
                    node.nodeValue = newV;
                    translatedValues.set(node, newV);
                    return true;
                }
            }
            return false;
        }

        function translateTextNode(node) {
            const val = node.nodeValue;
            if (!val || val.trim().length < 1) return;
            if (translatedValues.get(node) === val) return;
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
                    if (parentState === 2) return;
                    const tag = node.tagName ? node.tagName.toUpperCase() : '';
                    const v = getSelfVerdict(node);
                    if (v === 2) {
                        if ((tag === 'INPUT' || tag === 'TEXTAREA') && parentState === 0) {
                            translateElementAttributes(node, false);
                        }
                        return;
                    }
                    let nextState = v === 1 ? 1 : (v === 3 ? 0 : parentState);
                    if (nextState === 1 && parentState === 1 && isConvRowAllowed(node)) {
                        nextState = 0;
                    }
                    translateElementAttributes(node, nextState !== 0);
                    if (node.shadowRoot) translateNode(node.shadowRoot, nextState);
                    const childNodes = node.childNodes;
                    if (childNodes) {
                        for (let k = 0; k < childNodes.length; k++) {
                            translateNode(childNodes[k], nextState);
                        }
                    }
                } else if (node.nodeType === Node.TEXT_NODE) {
                    if (parentState === 0 || (parentState === 1 && isConvRowAllowed(null, node.nodeValue))) {
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
            } catch (e) {}
        }

        const observer = new MutationObserver(mutations => {
            const parentCache = new Map();
            function getStateCached(el) {
                if (!el || el.nodeType !== Node.ELEMENT_NODE) return 0;
                if (parentCache.has(el)) return parentCache.get(el);
                const state = getZoneState(el);
                if (state !== 0 || !isConvRowAllowed(el)) {
                    parentCache.set(el, state);
                }
                return state;
            }
            for (let k = 0; k < mutations.length; k++) {
                const m = mutations[k];
                if (m.type === 'childList') {
                    for (let n = 0; n < m.addedNodes.length; n++) {
                        const node = m.addedNodes[n];
                        const parent = getParentOrHost(node);
                        translateNode(node, parent ? getStateCached(parent) : 0);
                    }
                } else if (m.type === 'characterData') {
                    const node = m.target;
                    if (getZoneState(node) === 0) {
                        translateTextNode(node);
                    }
                } else if (m.type === 'attributes') {
                    const el = m.target;
                    if (el && el.nodeType === Node.ELEMENT_NODE && m.attributeName) {
                        const tag = el.tagName ? el.tagName.toUpperCase() : '';
                        const checkTarget = (tag === 'INPUT' || tag === 'TEXTAREA') ? (getParentOrHost(el) || el) : el;
                        if (getStateCached(checkTarget) === 0) {
                            translateSingleAttribute(el, m.attributeName);
                        }
                    }
                }
            }
        });

        const obsOpts = {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['title', 'placeholder', 'aria-label']
        };

        const target = document.documentElement || document;
        observer.observe(target, obsOpts);
        translateNode(target, 0);

        if (document.readyState === 'loading' && typeof document.addEventListener === 'function') {
            document.addEventListener('DOMContentLoaded', () => {
                translateNode(document.documentElement || document, 0);
            }, { once: true });
        }
    } catch (e) {
        console.error('[ANTIGRAVITY_DOM_TRANSLATOR_ERROR]', e);
    }
}

module.exports = {
    installDomTranslator
};
