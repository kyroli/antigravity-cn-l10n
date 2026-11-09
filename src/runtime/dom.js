function installDomTranslator(translator, config) {
    if (typeof document === 'undefined' || document._agL10nInstalled) return;
    try {
        Object.defineProperty(document, '_agL10nInstalled', { value: true });

        const cfg = config || {};
        const BLOCKED_TAG_SET = new Set((cfg.blockedTags || []).map(t => t.toUpperCase()));
        const BLOCKED_CLASS_SET = new Set((cfg.blockedClasses || []).map(c => c.toLowerCase()));
        const BLOCKED_CLASS_SUBSTRINGS = (cfg.blockedClassSubstrings || []).map(c => c.toLowerCase());
        const BLOCKED_TESTID_SET = new Set((cfg.blockedTestIds || []).map(id => id.toLowerCase()));
        const BLOCKED_TESTID_SUBSTRINGS = (cfg.blockedTestIdSubstrings || []).map(id => id.toLowerCase());
        const BLOCKED_DATA_ATTRS = cfg.blockedDataAttrs || [];
        const BYPASS_CLASS_SET = new Set((cfg.bypassClasses || []).map(c => c.toLowerCase()));
        const BYPASS_ROLE_SET = new Set((cfg.bypassRoles || []).map(r => r.toLowerCase()));
        const CODE_EDITOR_KEYWORDS = (cfg.codeEditorKeywords || []).map(k => k.toLowerCase());
        const CONV_ROW_ALLOWED = new Set(cfg.conversationRowAllowedTexts || []);

        const FRAGMENT_RULES = (cfg.fragmentPatterns || []).map(fp => ({
            containerRe: new RegExp(fp.containerPattern, 'i'),
            replacements: (fp.nodeReplacements || []).map(nr => ({
                matchRe: new RegExp(nr.match, 'i'),
                replace: nr.replace,
                normalizeEllipsis: Boolean(nr.normalizeEllipsis)
            }))
        }));

        const translatedValues = new WeakMap();
        // WeakMap 缓存元素自身判定结果 { cls, verdict } (verdict: 0 = neutral, 1 = blocked, 2 = bypass)
        const elementVerdictCache = new WeakMap();

        function computeBypassElement(el) {
            const tag = el.tagName.toUpperCase();
            if (tag === 'DIALOG' || tag === 'BUTTON') return true;
            const role = el.getAttribute?.('role');
            if (role && BYPASS_ROLE_SET.has(role.toLowerCase())) return true;
            if (el.getAttribute?.('aria-modal') === 'true') return true;
            if (el.hasAttribute?.('data-radix-popper-content-wrapper')) return true;

            const className = el.className;
            if (typeof className === 'string' && className.length > 0) {
                const classes = className.split(/\s+/);
                for (let k = 0; k < classes.length; k++) {
                    if (BYPASS_CLASS_SET.has(classes[k].toLowerCase())) return true;
                }
            }
            return false;
        }

        function computeBlockedElement(el) {
            const tag = el.tagName.toUpperCase();
            if (BLOCKED_TAG_SET.has(tag)) return true;
            for (let i = 0; i < BLOCKED_DATA_ATTRS.length; i++) {
                if (el.hasAttribute?.(BLOCKED_DATA_ATTRS[i])) return true;
            }
            const ce = el.getAttribute?.('contenteditable');
            if (ce === 'true' || ce === 'plaintext-only' || ce === '') return true;
            if (el.getAttribute?.('translate') === 'no') return true;

            const testId = el.getAttribute?.('data-testid') || '';
            if (testId) {
                const lowerTestId = testId.toLowerCase();
                if (BLOCKED_TESTID_SET.has(lowerTestId)) return true;
                for (let i = 0; i < BLOCKED_TESTID_SUBSTRINGS.length; i++) {
                    if (lowerTestId.includes(BLOCKED_TESTID_SUBSTRINGS[i])) return true;
                }
            }

            const className = el.className;
            if (typeof className === 'string' && className.length > 0) {
                const lowerClass = className.toLowerCase();
                for (let i = 0; i < BLOCKED_CLASS_SUBSTRINGS.length; i++) {
                    if (lowerClass.includes(BLOCKED_CLASS_SUBSTRINGS[i])) return true;
                }

                if (tag === 'SPAN' && lowerClass.includes('truncate') && el.closest?.('[data-testid^="conversation-row-"]')) {
                    const txt = el.textContent?.trim();
                    if (!CONV_ROW_ALLOWED.has(txt)) {
                        return true;
                    }
                }

                const classes = lowerClass.split(/\s+/);
                for (let k = 0; k < classes.length; k++) {
                    const cls = classes[k];
                    if (BLOCKED_CLASS_SET.has(cls)) return true;
                    if (cls.includes(':') || cls.includes('[') || cls.includes(']')) continue;
                    if (cls.startsWith('bg-') || cls.startsWith('text-') || cls.startsWith('border-') || cls.startsWith('decoration-') || cls.startsWith('scrollbar-')) {
                        continue;
                    }
                    for (let ek = 0; ek < CODE_EDITOR_KEYWORDS.length; ek++) {
                        if (cls.includes(CODE_EDITOR_KEYWORDS[ek])) {
                            return true;
                        }
                    }
                }
            }
            return false;
        }

        // 获取单个元素的自身判定: 1 = blocked, 2 = bypass, 0 = neutral
        function getElementSelfVerdict(el) {
            if (!el || el.nodeType !== Node.ELEMENT_NODE) return 0;
            const cls = typeof el.className === 'string' ? el.className : '';
            const isConvSpan = el.tagName === 'SPAN' && cls.toLowerCase().includes('truncate');
            if (!isConvSpan) {
                const cached = elementVerdictCache.get(el);
                if (cached && cached.cls === cls) {
                    return cached.verdict;
                }
            }
            let verdict = 0;
            if (computeBlockedElement(el)) {
                verdict = 1;
            } else if (computeBypassElement(el)) {
                verdict = 2;
            }
            if (!isConvSpan) {
                elementVerdictCache.set(el, { cls, verdict });
            }
            return verdict;
        }

        function isInBlockedZone(node) {
            try {
                if (!node) return false;
                let curr = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
                while (curr && curr.nodeType === Node.ELEMENT_NODE) {
                    const v = getElementSelfVerdict(curr);
                    if (v === 1) return true;
                    if (v === 2) return false;
                    curr = curr.parentElement || (curr.getRootNode ? curr.getRootNode().host : null);
                }
            } catch (e) {}
            return false;
        }

        function translateSingleAttribute(node, attr) {
            if (attr === 'aria-label' && node.tagName && node.tagName.toUpperCase() === 'A' && node.closest?.('[data-testid^="conversation-row-"]')) {
                return;
            }
            const v = node.getAttribute(attr);
            if (!v) return;
            const trans = translator.translateString(v);
            if (trans !== null && trans !== v) {
                node.setAttribute(attr, trans);
            }
        }

        function translateElementAttributes(node, isBlocked) {
            let allow = !isBlocked;
            const tag = node.tagName.toUpperCase();
            if (!allow && (tag === 'INPUT' || tag === 'TEXTAREA')) {
                const parent = node.parentElement || (node.getRootNode ? node.getRootNode().host : null);
                if (!parent || !isInBlockedZone(parent)) {
                    allow = true;
                }
            }
            if (allow) {
                translateSingleAttribute(node, 'placeholder');
                translateSingleAttribute(node, 'title');
                translateSingleAttribute(node, 'aria-label');
            }
        }

        // 严格同级序列匹配：仅当父节点直接子节点数 <= 6 且子元素数 <= 1（叶子标签/按钮）时触发
        function tryTranslateSiblingFragment(node, val) {
            const parentEl = node.parentElement;
            if (!parentEl || !parentEl.childNodes || parentEl.childNodes.length > 6) return false;
            if (parentEl.childElementCount > 1) return false;

            const parentText = parentEl.textContent ? parentEl.textContent.trim() : '';
            if (!parentText) return false;

            for (let i = 0; i < FRAGMENT_RULES.length; i++) {
                const rule = FRAGMENT_RULES[i];
                if (rule.containerRe.test(parentText)) {
                    for (let j = 0; j < rule.replacements.length; j++) {
                        const rep = rule.replacements[j];
                        if (rep.matchRe.test(val)) {
                            let newV = rep.replace;
                            if (rep.normalizeEllipsis) {
                                const suffix = (val.includes('...') || val.includes('…')) ? '...' : '';
                                newV = newV.replace('$1', suffix);
                            }
                            node.nodeValue = newV;
                            translatedValues.set(node, newV);
                            return true;
                        }
                    }
                }
            }
            return false;
        }

        function translateTextNode(node) {
            const val = node.nodeValue;
            if (!val || val.trim().length < 1) return;

            if (translatedValues.get(node) === val) return;

            if (tryTranslateSiblingFragment(node, val)) {
                return;
            }

            const trans = translator.translateString(val);
            if (trans !== null && trans !== val) {
                translatedValues.set(node, trans);
                node.nodeValue = trans;
            } else {
                translatedValues.set(node, val);
            }
        }

        function translateNode(node, isBlocked) {
            if (!node) return;
            try {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    const tag = node.tagName ? node.tagName.toUpperCase() : '';
                    if (BLOCKED_TAG_SET.has(tag)) {
                        if (tag === 'INPUT' || tag === 'TEXTAREA') {
                            translateElementAttributes(node, true);
                        }
                        return;
                    }

                    let currentBlocked = isBlocked;
                    const verdict = getElementSelfVerdict(node);
                    if (verdict === 1) {
                        currentBlocked = true;
                    } else if (verdict === 2) {
                        currentBlocked = false;
                    }

                    translateElementAttributes(node, currentBlocked);

                    const sr = node.shadowRoot;
                    if (sr) {
                        translateNode(sr, currentBlocked);
                    }

                    const childNodes = node.childNodes;
                    for (let k = 0; k < childNodes.length; k++) {
                        translateNode(childNodes[k], currentBlocked);
                    }
                } else if (node.nodeType === Node.TEXT_NODE) {
                    if (!isBlocked) {
                        translateTextNode(node);
                    }
                } else if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
                    const childNodes = node.childNodes;
                    for (let k = 0; k < childNodes.length; k++) {
                        translateNode(childNodes[k], isBlocked);
                    }
                }
            } catch (e) {}
        }

        const observer = new MutationObserver(mutations => {
            const parentCache = new Map();
            for (let k = 0; k < mutations.length; k++) {
                const m = mutations[k];
                if (m.type === 'childList') {
                    for (let n = 0; n < m.addedNodes.length; n++) {
                        const node = m.addedNodes[n];
                        const parent = node.parentElement || node;
                        let blocked;
                        if (parentCache.has(parent)) {
                            blocked = parentCache.get(parent);
                        } else {
                            blocked = isInBlockedZone(parent);
                            parentCache.set(parent, blocked);
                        }
                        translateNode(node, blocked);
                    }
                } else if (m.type === 'characterData') {
                    const node = m.target;
                    const parent = node.parentElement;
                    if (parent) {
                        let blocked;
                        if (parentCache.has(parent)) {
                            blocked = parentCache.get(parent);
                        } else {
                            blocked = isInBlockedZone(parent);
                            parentCache.set(parent, blocked);
                        }
                        if (!blocked) {
                            translateTextNode(node);
                        }
                    }
                } else if (m.type === 'attributes') {
                    const el = m.target;
                    if (el && el.nodeType === Node.ELEMENT_NODE) {
                        const attrName = m.attributeName;
                        if (attrName === 'placeholder' || attrName === 'title' || attrName === 'aria-label') {
                            const tag = el.tagName ? el.tagName.toUpperCase() : '';
                            const checkTarget = (tag === 'INPUT' || tag === 'TEXTAREA') ? (el.parentElement || el) : el;
                            let blocked;
                            if (parentCache.has(checkTarget)) {
                                blocked = parentCache.get(checkTarget);
                            } else {
                                blocked = isInBlockedZone(checkTarget);
                                parentCache.set(checkTarget, blocked);
                            }
                            if (!blocked) {
                                translateSingleAttribute(el, attrName);
                            }
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
        translateNode(target, false);

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                translateNode(document.documentElement || document, false);
            }, { once: true });
        }
    } catch (e) {
        console.error('[ANTIGRAVITY_DOM_TRANSLATOR_ERROR]', e);
    }
}

module.exports = {
    installDomTranslator
};
