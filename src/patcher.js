const vm = require('vm');
const utils = require('./utils');
const { normalizeText, createTranslator } = require('./runtime/translator');
const { installMainHooks } = require('./runtime/main');
const { installDomTranslator } = require('./runtime/dom');
const { SIGNATURE_START, SIGNATURE_END, cleanInjectedPatches } = utils;

const RENDERER_PLUGIN_GUARD = `
        if (typeof location !== 'undefined' && location && location.protocol === 'plugin:') return;`;

const FRAME_ORIGIN_GUARD = `
        const loc = typeof location !== 'undefined' ? location : null;
        if (!loc) return;
        const proto = loc.protocol, host = (loc.hostname || '').toLowerCase();
        let isTop = true;
        try { isTop = typeof window === 'undefined' ? true : window === window.top; } catch (e) { isTop = false; }
        const isLocalSub = !isTop && (proto === 'http:' || proto === 'https:') && (host === '127.0.0.1' || host === 'localhost' || host === '[::1]');
        if (proto !== 'plugin:' && !isLocalSub) return;`;

const SLOT_TOKEN = 'AGSLOT0';
const serializeDict = dict => `new Map(${JSON.stringify(dict instanceof Map ? Array.from(dict.entries()) : Object.entries(dict || {}))})`;
const serializeStr = str => JSON.stringify(str).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const escapeTpl = str => String(str).replace(/[`\\]|\$\{/g, m => '\\' + m);

function insertAfterPrologue(source, injectedCode) {
    if (!source) return injectedCode;
    const match = source.match(/^(?:(?:\uFEFF)?(?:\s+|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/)*(['"])use strict\1;?[ \t]*\r?\n?)/);
    if (!match) return injectedCode + '\n' + source;
    const prefix = match[0];
    return prefix + (prefix.endsWith('\n') ? '' : '\n') + injectedCode + '\n' + source.slice(prefix.length);
}

function mergeArrayField(baseArr, extraArr, byJson = false) {
    const combined = [...(Array.isArray(baseArr) ? baseArr : []), ...(Array.isArray(extraArr) ? extraArr : [])];
    if (!byJson) return Array.from(new Set(combined));
    const seen = new Set();
    return combined.filter(item => { const k = JSON.stringify(item); return seen.has(k) ? false : (seen.add(k), true); });
}

function buildScopedConfigs(config) {
    const { frame: frameCfg = {}, audit: _auditCfg, ...hubConfig } = config || {};
    const frameConfig = Object.assign({}, hubConfig, {
        blockedClasses: mergeArrayField(hubConfig.blockedClasses, frameCfg.blockedClasses),
        blockedTestIds: mergeArrayField(hubConfig.blockedTestIds, frameCfg.blockedTestIds),
        bypassClasses: mergeArrayField(hubConfig.bypassClasses, frameCfg.bypassClasses),
        fragmentPatterns: mergeArrayField(hubConfig.fragmentPatterns, frameCfg.fragmentPatterns, true)
    });
    return {
        hubConfig,
        frameConfig,
        frameExtraDict: frameCfg.dict || {},
        frameExtraRules: Array.isArray(frameCfg.rules) ? frameCfg.rules : []
    };
}

const pickTranslatorCfg = cfg => ({
    lowerWordsExclude: (cfg && cfg.lowerWordsExclude) || [],
    protectedFiles: (cfg && cfg.protectedFiles) || [],
    toolStatVerbs: cfg && cfg.toolStatVerbs,
    toolStatNouns: cfg && cfg.toolStatNouns,
    enableLongPrefixLookup: false
});

function buildMainPayload(dict, rules, config, frameScript) {
    if (typeof config === 'string' && frameScript === undefined) { frameScript = config; config = {}; }
    const frameArg = typeof frameScript === 'string' && frameScript.length > 0 ? `, ${serializeStr(frameScript)}` : '';
    return `${SIGNATURE_START}
(() => {
    try {
        const electron = require('electron');
        ${normalizeText.toString()}
        ${createTranslator.toString()}
        ${installMainHooks.toString()}
        const translator = createTranslator(${serializeDict(dict)}, ${JSON.stringify(rules || [])}, ${JSON.stringify(pickTranslatorCfg(config))});
        installMainHooks(electron, translator${frameArg});
    } catch (e) { console.error('[ANTIGRAVITY_MAIN_LOCALIZATION_ERROR]', e); }
})();
${SIGNATURE_END}`;
}

function buildDomPayload({ dict, rules, config, errorTag, guardCode, wrapSignature = true }) {
    const { frame, ...cleanCfg } = config || {};
    const body = `(() => {
    try {${guardCode ? `${guardCode}\n` : ''}
        const __cfg = ${JSON.stringify(cleanCfg)};
        ${normalizeText.toString()}
        ${createTranslator.toString()}
        ${installDomTranslator.toString()}
        const translator = createTranslator(${serializeDict(dict)}, ${JSON.stringify(rules || [])}, __cfg);
        installDomTranslator(translator, __cfg);
    } catch (e) { console.error(${JSON.stringify(errorTag)}, e); }
})();`;
    return wrapSignature ? `${SIGNATURE_START}\n${body}\n${SIGNATURE_END}` : body;
}

const buildRendererPayload = (dict, rules, config) => buildDomPayload({
    dict, rules, config, errorTag: '[ANTIGRAVITY_RENDERER_LOCALIZATION_ERROR]', guardCode: RENDERER_PLUGIN_GUARD, wrapSignature: true
});

const buildFramePayload = (dict, rules, config) => buildDomPayload({
    dict, rules, config, errorTag: '[ANTIGRAVITY_FRAME_LOCALIZATION_ERROR]', guardCode: FRAME_ORIGIN_GUARD, wrapSignature: false
});

// kind 'html': [prefix, eng, suffix, key?]; 'quote': [rawLiteral, key]; 'tpl': [rawTarget, templateKey, slotExpr, open, close]
const STATIC_TEMPLATES = [
    {
        file: 'dist/ideInstall/wizardHtml.js',
        rules: [
            ['html', '<title>', 'Welcome to Antigravity', '</title>'],
            ['html', '>', 'Setting up…', '</div>', 'Setting up...'],
            ['html', '<h1>', 'Welcome to the new Antigravity!', '</h1>'],
            ['html', '<p>', "Antigravity has been redesigned to put agents first with new capabilities. If you'd still like a code editor, you can download it as a separate app named <b>Antigravity IDE</b>.", '</p>'],
            ['html', '<span>', 'Download the Antigravity IDE', '</span>'],
            ['html', '>', 'Explore the new Antigravity', '</button>']
        ]
    },
    {
        file: 'dist/provisionSplash.js',
        rules: [['tpl', '<div>Setting up WSL: ${escapeHtml(distro)}</div>', `Setting up WSL: ${SLOT_TOKEN}`, '${escapeHtml(distro)}', '<div>', '</div>']]
    },
    {
        file: 'dist/wsl.js',
        rules: [
            ['quote', "'Downloading the Antigravity binary\\u2026'", 'Downloading the Antigravity binary...'],
            ['tpl', '`Installing into ${distro}\\u2026`', `Installing into ${SLOT_TOKEN}...`, '${distro}', '`', '`']
        ]
    },
    {
        file: 'dist/cablev2.js',
        rules: [
            ['html', '<title>', 'Passkeys', '</title>'],
            ['html', '<h1 class="sheet-title">', 'Passkeys', '</h1>'],
            ['html', '<p class="mechanism-header">', 'Use your phone or tablet', '</p>'],
            ['tpl', '<p id="status" class="mechanism-desc">Scan this QR code with the camera on the device that has your passkey for ${safeRpId}</p>', `Scan this QR code with the camera on the device that has your passkey for ${SLOT_TOKEN}`, '${safeRpId}', '<p id="status" class="mechanism-desc">', '</p>'],
            ['html', '>', 'Cancel', '</button>'],
            ['quote', "'Connecting to your device…'", 'Connecting to your device...'],
            ['quote', "'Verify on your device to continue…'", 'Verify on your device to continue...']
        ]
    }
];

function patchStaticTemplates(asarReader, patchMap, menusDict, rules, hubConfig) {
    const translator = createTranslator(menusDict, rules, pickTranslatorCfg(hubConfig));
    for (const entry of STATIC_TEMPLATES) {
        const raw = asarReader.readFile(entry.file);
        if (!raw || raw.includes(SIGNATURE_START)) continue;
        let next = raw, changed = false;
        for (const [kind, ...args] of entry.rules) {
            let target, replacement = null;
            if (kind === 'html') {
                const [pre, eng, suf, key] = args;
                target = pre + eng + suf;
                const t = translator.translateString(key || eng);
                if (t) replacement = pre + escapeTpl(t) + suf;
            } else if (kind === 'quote') {
                target = args[0];
                const t = translator.translateString(args[1]);
                if (t) replacement = JSON.stringify(t);
            } else {
                const [rawTarget, tplKey, slotExpr, open, close] = args;
                target = rawTarget;
                const t = translator.translateString(tplKey);
                if (t && t.includes(SLOT_TOKEN)) replacement = open + escapeTpl(t).replace(SLOT_TOKEN, slotExpr) + close;
            }
            if (replacement && replacement !== target && next.includes(target)) {
                next = next.split(target).join(replacement);
                changed = true;
            }
        }
        if (changed) patchMap[entry.file] = `${next}${next.endsWith('\n') ? '' : '\n'}${SIGNATURE_START}\n${SIGNATURE_END}\n`;
    }
}

function verifyPatchOutputs(patchMap, extraScripts = []) {
    for (const [name, code] of extraScripts) {
        if (!code) continue;
        if (code.includes(SIGNATURE_START) || code.includes(SIGNATURE_END)) throw new Error(`补丁产物校验失败: ${name} 不应包含签名边界标记`);
        new vm.Script(code, { filename: name });
    }
    for (const [rel, code] of Object.entries(patchMap || {})) {
        if (!code.includes(SIGNATURE_START) || !code.includes(SIGNATURE_END)) throw new Error(`补丁产物校验失败: ${rel} 缺少签名标记`);
        new vm.Script(code, { filename: rel });
    }
}

function generatePatchMap(asarReader) {
    const allDict = utils.loadDictionary();
    const byFile = utils.loadDictionariesByFile();
    const rules = utils.loadRules();
    const config = utils.loadConfig();

    const menusDict = byFile['menus.json'] || {};
    const agentsDict = byFile['agents.json'] || {};
    const { hubConfig, frameConfig, frameExtraDict, frameExtraRules } = buildScopedConfigs(config);

    const frameDict = Object.keys(frameExtraDict).length ? Object.assign({}, agentsDict, frameExtraDict) : agentsDict;
    const frameRules = frameExtraRules.length ? [...frameExtraRules, ...rules] : rules;

    const framePayload = buildFramePayload(frameDict, frameRules, frameConfig);
    const mainPayload = buildMainPayload(menusDict, rules, hubConfig, framePayload);
    const rendererPayload = buildRendererPayload(allDict, rules, hubConfig);

    const patchMap = {};
    const rawMain = cleanInjectedPatches(asarReader.readFile('dist/main.js'));
    if (rawMain) patchMap['dist/main.js'] = insertAfterPrologue(rawMain, mainPayload);

    const rawPreload = cleanInjectedPatches(asarReader.readFile('dist/preload.js'));
    if (rawPreload) patchMap['dist/preload.js'] = `${rawPreload}${rawPreload.endsWith('\n') ? '' : '\n'}${rendererPayload}`;

    patchStaticTemplates(asarReader, patchMap, menusDict, rules, hubConfig);
    verifyPatchOutputs(patchMap, [['framePayload.js', framePayload]]);
    return patchMap;
}

module.exports = { insertAfterPrologue, buildRendererPayload, buildFramePayload, generatePatchMap };
