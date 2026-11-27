const { normalizeText } = require('./runtime/translator');

const SLOT_PLACEHOLDER_RE = /\{(#?)(\d+)\}/g;
const PLURAL_PHRASE_RE = /([A-Za-z]+(?:\s+[A-Za-z]+)*)\(s\)/g;
const PLURAL_PHRASE_TEST_RE = /\b[A-Za-z]+\(s\)/;
const FLEX_PUNCT_RE = /(\.\.\.|…|\s+|["“”]|['’])/g;

const escapeRegExp = str => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function escapeFlexibleText(text) {
    if (!text) return '';
    return text.split(FLEX_PUNCT_RE).map(token => {
        if (!token) return '';
        if (token === '...' || token === '…') return '(?:\\.\\.\\.|…)';
        if (/^\s+$/.test(token)) return '\\s+';
        if (token === '"' || token === '“' || token === '”') return '[“”"]';
        if (token === "'" || token === '’') return "['’]";
        return escapeRegExp(token);
    }).join('');
}

function compileSegmentBody(coreText, { forContainer }) {
    let output = '';
    let lastIndex = 0;
    for (const match of coreText.matchAll(PLURAL_PHRASE_RE)) {
        if (match.index > lastIndex) output += escapeFlexibleText(coreText.slice(lastIndex, match.index));
        const phraseRe = escapeFlexibleText(match[1]);
        // 容器整句在静态三元并列扫描时可能呈现 `wordwords` 拼接形态
        output += forContainer ? `(?:${phraseRe}(?:s|${phraseRe}s)?)` : `${phraseRe}(?:s)?`;
        lastIndex = match.index + match[0].length;
    }
    if (lastIndex < coreText.length) output += escapeFlexibleText(coreText.slice(lastIndex));
    return output;
}

function parseSlotTemplate(template, label) {
    if (typeof template !== 'string' || !template.trim()) {
        throw new Error(`槽位模板 ${label} 必须为非空字符串`);
    }
    let body = template;
    const wildStart = body.startsWith('{*}');
    if (wildStart) body = body.slice(3);
    const wildEnd = body.endsWith('{*}');
    if (wildEnd) body = body.slice(0, -3);
    if (body.includes('{*}')) {
        throw new Error(`槽位模板 ${label} 中的 {*} 只能出现在开头或结尾: ${template}`);
    }

    const segments = [];
    const slots = [];
    let lastIndex = 0;
    for (const match of body.matchAll(SLOT_PLACEHOLDER_RE)) {
        segments.push(body.slice(lastIndex, match.index));
        slots.push({ isNum: match[1] === '#', idx: Number(match[2]) });
        lastIndex = match.index + match[0].length;
    }
    segments.push(body.slice(lastIndex));
    return { wildStart, wildEnd, segments, slots };
}

function validateTemplatePair(enTemplate, enParsed, zhParsed) {
    if (enParsed.wildStart !== zhParsed.wildStart || enParsed.wildEnd !== zhParsed.wildEnd) {
        throw new Error(`槽位模板 "${enTemplate}" 中英文 {*} 头尾通配位置不一致`);
    }
    if (enParsed.slots.length === 0) {
        throw new Error(`槽位模板 "${enTemplate}" 至少需要一个槽位 ({0})`);
    }
    if (enParsed.slots.length !== zhParsed.slots.length) {
        throw new Error(`槽位模板 "${enTemplate}" 中英文槽位数量不一致`);
    }
    for (let i = 0; i < enParsed.slots.length; i++) {
        const enSlot = enParsed.slots[i];
        const zhSlot = zhParsed.slots[i];
        if (enSlot.idx !== i || zhSlot.idx !== i || enSlot.isNum !== zhSlot.isNum) {
            throw new Error(`槽位模板 "${enTemplate}" 槽位编号必须按 {0}..{${enParsed.slots.length - 1}} 顺序对齐且类型一致`);
        }
    }
}

function formatSegmentPattern(segment, allowTrailingPluralS = false) {
    const core = segment.trim();
    if (!core) return '\\s*';
    const lead = /^\s/.test(segment) ? '\\s*' : '';
    const trail = /\s$/.test(segment) ? '\\s*' : '';
    return `${lead}${compileSegmentBody(core, { forContainer: true })}${allowTrailingPluralS ? 's?' : ''}${trail}`;
}

function formatSlotPattern(slot, isTrailingOpen) {
    if (slot.isNum) return '\\d+';
    return isTrailingOpen ? '.+' : '.+?';
}

function buildContainerPattern(enParsed, zhParsed) {
    const hasAsymmetricEmptySegment = enParsed.segments.some(
        (seg, index) => Boolean(seg.trim()) !== Boolean(zhParsed.segments[index].trim())
    );
    const wrapAnchors = body => `^${enParsed.wildStart ? '.*' : ''}${body}${enParsed.wildEnd ? '.*' : ''}$`;

    // 某段译文为空时若逐段独立二选一，英文前缀可配空尾越界匹配；将英中两分支整体隔离并允许 DOM 翻译中间态
    if (hasAsymmetricEmptySegment) {
        const buildWholeBranch = isZhSide => {
            const parts = [];
            for (let i = 0; i < enParsed.segments.length; i++) {
                const enSeg = enParsed.segments[i];
                const zhSeg = zhParsed.segments[i];
                const segment = isZhSide ? zhSeg : enSeg;
                const core = segment.trim();
                const hasPlural = PLURAL_PHRASE_TEST_RE.test(enSeg);
                if (isZhSide && !core && enSeg.trim()) {
                    parts.push(`(?:${formatSegmentPattern(enSeg)})?`);
                } else if (!core) {
                    parts.push('\\s*');
                } else {
                    parts.push(formatSegmentPattern(segment, isZhSide && hasPlural));
                }
                if (i < enParsed.slots.length) {
                    const nextSeg = isZhSide ? zhParsed.segments[i + 1] : enParsed.segments[i + 1];
                    const isTrailingOpen = i === enParsed.slots.length - 1 && !nextSeg.trim() && !enParsed.wildEnd;
                    parts.push(formatSlotPattern(enParsed.slots[i], isTrailingOpen));
                }
            }
            return parts.join('');
        };
        return wrapAnchors(`(?:${buildWholeBranch(false)}|${buildWholeBranch(true)})`);
    }

    const parts = [];
    for (let i = 0; i < enParsed.segments.length; i++) {
        const enSeg = enParsed.segments[i];
        const zhSeg = zhParsed.segments[i];
        const hasPlural = PLURAL_PHRASE_TEST_RE.test(enSeg);
        if (!enSeg.trim() && !zhSeg.trim()) {
            parts.push('\\s*');
        } else {
            parts.push(`(?:${formatSegmentPattern(enSeg)}|${formatSegmentPattern(zhSeg, hasPlural)})`);
        }
        if (i < enParsed.slots.length) {
            const isTrailingOpen = i === enParsed.slots.length - 1
                && !enParsed.segments[i + 1].trim()
                && !zhParsed.segments[i + 1].trim()
                && !enParsed.wildEnd;
            parts.push(formatSlotPattern(enParsed.slots[i], isTrailingOpen));
        }
    }
    return wrapAnchors(parts.join(''));
}

function buildEdgeWhitespace(enHasWs, zhHasWs, absorbFallbackWs, allocGroup) {
    if (enHasWs && zhHasWs) return { regex: '(\\s*)', output: `$${allocGroup()}` };
    if (!enHasWs && zhHasWs) return { regex: absorbFallbackWs ? '\\s*' : '', output: ' ' };
    return { regex: (enHasWs || absorbFallbackWs) ? '\\s*' : '', output: '' };
}

function buildNodeReplacements(enParsed, zhParsed) {
    const replacements = [];
    const optionalMatches = new Set();
    let needsPluralS = false;

    for (let i = 0; i < enParsed.segments.length; i++) {
        const enSeg = enParsed.segments[i];
        const zhSeg = zhParsed.segments[i];
        const enCore = enSeg.trim();
        const zhCore = zhSeg.trim();
        if (!enCore) continue;

        const enLead = /^\s/.test(enSeg);
        const enTrail = /\s$/.test(enSeg);
        const zhLead = /^\s/.test(zhSeg);
        const zhTrail = /\s$/.test(zhSeg);
        const hasPlural = PLURAL_PHRASE_TEST_RE.test(enCore);
        if (hasPlural) needsPluralS = true;

        if (enCore === zhCore && enLead === zhLead && enTrail === zhTrail && !hasPlural) continue;

        const coreRe = compileSegmentBody(enCore, { forContainer: false });
        const isFirst = i === 0 && !enParsed.wildStart;
        const isLast = i === enParsed.segments.length - 1;

        if (!zhCore) {
            const leadRe = (enLead || isFirst) ? '\\s*' : '';
            const trailRe = (enTrail || isLast) ? '\\s*' : '';
            replacements.push({ match: `^${leadRe}${coreRe}${trailRe}$`, replace: '' });
            continue;
        }

        let nextGroup = 1;
        const allocGroup = () => nextGroup++;
        const hasWordChar = /[a-zA-Z0-9]/.test(enCore);
        const lead = buildEdgeWhitespace(enLead, zhLead, isFirst && hasWordChar, allocGroup);
        const trail = buildEdgeWhitespace(enTrail, zhTrail, isLast && hasWordChar, allocGroup);

        replacements.push({
            match: `^${lead.regex}${coreRe}${trail.regex}$`,
            replace: `${lead.output}${zhCore}${trail.output}`
        });
    }

    if (needsPluralS && !replacements.some(replacement => replacement.match === '^s$')) {
        replacements.push({ match: '^s$', replace: '' });
        optionalMatches.add('^s$');
    }

    return { replacements, optionalMatches };
}

function compileSlotFragment(enTemplate, rawSpec) {
    const isObj = rawSpec && typeof rawSpec === 'object' && !Array.isArray(rawSpec);
    const zhTemplate = isObj ? rawSpec.zh : rawSpec;
    const matchNested = Boolean(isObj && rawSpec.nested);
    const enParsed = parseSlotTemplate(enTemplate, `EN(${enTemplate})`);
    const zhParsed = parseSlotTemplate(zhTemplate, `ZH(${enTemplate})`);

    validateTemplatePair(enTemplate, enParsed, zhParsed);

    const containerPattern = buildContainerPattern(enParsed, zhParsed);
    const { replacements, optionalMatches } = buildNodeReplacements(enParsed, zhParsed);

    new RegExp(containerPattern, 'i');
    for (const replacement of replacements) new RegExp(replacement.match, 'i');

    const rule = { containerPattern, nodeReplacements: replacements };
    if (matchNested) rule.matchNested = true;

    const weight = enParsed.segments.reduce((acc, seg) => acc + normalizeText(seg).length, 0);
    return {
        sourceKey: enTemplate,
        weight,
        slotCount: enParsed.slots.length,
        optionalMatches,
        rule
    };
}

function compileSlotFragmentEntries(fragmentsObj) {
    if (!fragmentsObj || typeof fragmentsObj !== 'object' || Array.isArray(fragmentsObj)) return [];
    const entries = Object.entries(fragmentsObj).map(([enTpl, spec]) => compileSlotFragment(enTpl, spec));
    entries.sort((a, b) => (
        (b.weight - a.weight)
        || (b.slotCount - a.slotCount)
        || a.sourceKey.localeCompare(b.sourceKey)
    ));
    return entries;
}

const compileSlotFragments = fragmentsObj => compileSlotFragmentEntries(fragmentsObj).map(entry => entry.rule);

function resolveFragmentPatterns(config, fragmentsObj) {
    const manual = Array.isArray(config?.fragmentPatterns) ? config.fragmentPatterns : [];
    return [...compileSlotFragments(fragmentsObj), ...manual];
}

module.exports = {
    compileSlotFragment,
    compileSlotFragmentEntries,
    compileSlotFragments,
    resolveFragmentPatterns
};
