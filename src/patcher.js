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

const SLOT_PREFIX = 'AGSLOT';
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

// 支持三类静态源码字面量替换：引号字符串（'...' / "..." / `...`）、HTML 标签文本（<tag>...</tag> 或 >...</tag>）及含多处 ${...} 或空内联标签槽位
const STATIC_TEMPLATES = {
    'dist/ideInstall/wizardHtml.js': [
        '<title>Welcome to Antigravity</title>',
        '>Setting up…</div>',
        '<h1>Welcome to the new Antigravity!</h1>',
        "<p>Antigravity has been redesigned to put agents first with new capabilities. If you'd still like a code editor, you can download it as a separate app named <b>Antigravity IDE</b>.</p>",
        '<span>Download the Antigravity IDE</span>',
        '>Explore the new Antigravity</button>'
    ],
    'dist/provisionSplash.js': [
        '<div>Setting up WSL: ${escapeHtml(distro)}</div>'
    ],
    'dist/wsl.js': [
        "'Downloading the Antigravity binary\\u2026'",
        '`Installing into ${distro}\\u2026`'
    ],
    'dist/cablev2.js': [
        '<title>Passkeys</title>',
        '<h1 class="sheet-title">Passkeys</h1>',
        '<p class="mechanism-header">Use your phone or tablet</p>',
        '<p id="status" class="mechanism-desc">Scan this QR code with the camera on the device that has your passkey for ${safeRpId}</p>',
        '>Cancel</button>',
        "'Connecting to your device…'",
        "'Verify on your device to continue…'"
    ],
    'dist/remote/disconnectedPage.js': [
        "'Reconnect'",
        "'Stop Server'",
        "'Close'",
        "'Restarting…'",
        "'Reconnecting…'",
        "'Disconnected'",
        '`Restarting the Antigravity server on ${host}…`',
        '`Reconnecting to ${host}…`',
        '`Disconnected from ${host}`',
        "'This window opens it again once it has started.'",
        '`Its server on ${host} stopped, and its agents with it.`',
        '`Agents keep running on ${host}.`',
        '`Its agents on ${host} stopped with it.`',
        '`Agents keep running on ${host} unless its server stopped.`'
    ],
    'dist/remote/sshPrompts.js': [
        '<p class="context">Connecting to <span id="label"></span></p>',
        '>Asked again: your last answer may not have worked.</div>',
        ">That's too long.</div>",
        '>Cancel</button>',
        '>Continue</button>',
        "'Password'",
        "'Current password'",
        "'New password'",
        "'Confirm new password'",
        "'Passphrase'",
        '`Verification code for ${who}`',
        '`Password for ${who}`',
        '`PIN for ${who}`',
        '`Sign in to ${who}`',
        {
            target: '`${asked[0]} for ${hostPromptsMarked ? asked[1] : label}`',
            replace: translator => {
                const sample = translator.translateString('Password for x');
                return sample && sample !== 'Password for x'
                    ? '`${hostPromptsMarked ? asked[1] : label} 的 ${asked[0]}`'
                    : null;
            }
        }
    ],
    'dist/remote/signInCallback.js': [
        "'You have successfully authenticated.'",
        "'You can close this tab and return to Antigravity.'",
        '"Sign-in didn\'t finish"',
        "`Antigravity couldn't reach ${host} to finish signing in. Sign in again from Antigravity.`",
        "`This sign-in came back from another server than the sign-in page you agreed to, so Antigravity didn't pass it on to ${host}.`",
        "`Antigravity on ${host} couldn't finish signing in (HTTP ${status}). Sign in again from Antigravity.`"
    ],
    'dist/computer/hud.js': [
        '<title>AGY Desktop HUD</title>',
        '<div id="status">AGY is controlling your Mac</div>',
        '>Stop</button>',
        '>Resume</button>',
        "'Stopped'",
        "'Stop'",
        "'AGY Desktop HUD'"
    ],
    'dist/computer/hudState.js': [
        "'Agent paused — you have control'",
        "'Agent idle'",
        '`AGY working in ${name} (background)`',
        "'AGY working in the background'",
        "'AGY is controlling your Mac'"
    ],
    'dist/computer/hudAgents.js': [
        '`${working} AGY agents working`',
        "'Agent stopped'",
        '`${stopped} agents stopped`',
        '`${text} (+${stopped} stopped)`'
    ]
};

/** 将 STATIC_TEMPLATES 中的原始代码片段解析为译文代码（支持多处 ${...}、空内联标签及数字插值回退）。 */
function translateStaticTarget(target, translator) {
    const withSlot = (str, open, close, literalJson) => {
        if (literalJson) {
            const t = translator.translateString(str);
            return t ? JSON.stringify(t) : null;
        }
        const slotRe = /\$\{[^}]+\}|<[a-z0-9]+\b[^>]*><\/[a-z0-9]+>/gi;
        const slots = str.match(slotRe) || [];
        const tryTranslate = mkTok => {
            const toks = [];
            const key = str.replace(slotRe, () => {
                const tok = mkTok(toks.length);
                toks.push(tok);
                return tok;
            });
            const t = translator.translateString(key);
            return t && toks.every(tok => t.includes(tok)) ? { t, toks } : null;
        };
        const hit = tryTranslate(idx => `${SLOT_PREFIX}${idx}`)
            || (slots.length > 0 && !str.includes('9910') ? tryTranslate(idx => String(99100 + idx)) : null);
        if (!hit) return null;
        let body = escapeTpl(hit.t);
        hit.toks.forEach((tok, idx) => { body = body.split(tok).join(slots[idx]); });
        return open + body + close;
    };
    const q = target[0];
    if ((q === "'" || q === '"' || q === '`') && target.endsWith(q)) {
        const inner = target.slice(1, -1)
            .replace(/\\u2026/g, '…')
            .replace(/\\(['"\\])/g, '$1');
        return (q === '`' && inner.includes('${')) ? withSlot(inner, '`', '`') : withSlot(inner, '', '', true);
    }
    const hm = target.match(/^(<[^>]+>|>)(.+)(<\/[a-z0-9]+>)$/i);
    return hm ? withSlot(hm[2], hm[1], hm[3]) : null;
}

function resolveStaticTarget(entry, translator) {
    const isObj = entry && typeof entry === 'object';
    const target = isObj ? entry.target : entry;
    const replacement = isObj ? entry.replace(translator, target) : translateStaticTarget(target, translator);
    return { target, replacement };
}

function patchStaticTemplates(asarReader, patchMap, dict, rules, hubConfig) {
    const translator = createTranslator(dict, rules, pickTranslatorCfg(hubConfig));
    for (const [file, targets] of Object.entries(STATIC_TEMPLATES)) {
        const raw = asarReader.readFile(file);
        if (!raw || raw.includes(SIGNATURE_START)) continue;
        let next = utils.foldAdjacentJsStrings(raw), changed = false;
        for (const entry of targets) {
            const { target, replacement } = resolveStaticTarget(entry, translator);
            if (replacement && replacement !== target && next.includes(target)) {
                next = next.split(target).join(replacement);
                changed = true;
            }
        }
        if (changed) patchMap[file] = `${next}${next.endsWith('\n') ? '' : '\n'}${SIGNATURE_START}\n${SIGNATURE_END}\n`;
    }
}

function auditStaticTemplates(asarReader, dict, rules, hubConfig) {
    const translator = createTranslator(dict, rules, pickTranslatorCfg(hubConfig));
    const issues = [];
    for (const [file, targets] of Object.entries(STATIC_TEMPLATES)) {
        const raw = cleanInjectedPatches(asarReader.readFile(file));
        if (!raw) {
            issues.push(`${file}: 文件不存在或为空`);
            continue;
        }
        const folded = utils.foldAdjacentJsStrings(raw);
        for (const entry of targets) {
            const { target, replacement } = resolveStaticTarget(entry, translator);
            if (!replacement || replacement === target) {
                issues.push(`${file}: 靶点缺少有效译文 -> ${target}`);
            } else if (!folded.includes(target)) {
                issues.push(`${file}: 源码未命中靶点 -> ${target}`);
            }
        }
    }
    return issues;
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

    patchStaticTemplates(asarReader, patchMap, allDict, rules, hubConfig);
    verifyPatchOutputs(patchMap, [['framePayload.js', framePayload]]);
    return patchMap;
}

module.exports = { STATIC_TEMPLATES, insertAfterPrologue, buildRendererPayload, buildFramePayload, auditStaticTemplates, generatePatchMap };
