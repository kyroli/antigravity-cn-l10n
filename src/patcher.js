const fs = require('fs');
const path = require('path');
const vm = require('vm');
const utils = require('./utils');
const { normalizeText, createTranslator } = require('./runtime/translator');
const { installDomTranslator } = require('./runtime/dom');
const { buildFrameScript } = require('./runtime/main');
const { resolveFragmentPatterns } = require('./fragmentCompiler');
const { SIGNATURE_START, SIGNATURE_END, cleanInjectedPatches } = utils;

const RUNTIME_L10N_FILES = ['translator.js', 'dom.js', 'bundleRewriter.js', 'bundleProxy.js', 'main.js'];
const SLOT_PREFIX = 'AGSLOT';
const NUMERIC_PROBE_BASE = 99100;
const NUMERIC_PROBE_GUARD = '9910';
const escapeTemplateBody = str => String(str).replace(/[`\\]|\$\{/g, match => '\\' + match);

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
    return combined.filter(item => {
        const key = JSON.stringify(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function buildScopedConfigs(config, fragmentsObj) {
    const { frame: frameCfg = {}, audit: _auditCfg, ...rawHubConfig } = config || {};
    const resolvedHubPatterns = resolveFragmentPatterns(rawHubConfig, fragmentsObj);
    const hubConfig = Object.assign({}, rawHubConfig, {
        fragmentPatterns: resolvedHubPatterns
    });
    const frameConfig = Object.assign({}, hubConfig, {
        blockedClasses: mergeArrayField(hubConfig.blockedClasses, frameCfg.blockedClasses),
        blockedTestIds: mergeArrayField(hubConfig.blockedTestIds, frameCfg.blockedTestIds),
        bypassClasses: mergeArrayField(hubConfig.bypassClasses, frameCfg.bypassClasses),
        fragmentPatterns: mergeArrayField(resolvedHubPatterns, frameCfg.fragmentPatterns, true)
    });
    return {
        hubConfig,
        frameConfig,
        frameExtraDict: frameCfg.dict || {},
        frameExtraRules: Array.isArray(frameCfg.rules) ? frameCfg.rules : []
    };
}

const pickTranslatorConfig = cfg => ({
    lowerWordsExclude: (cfg && cfg.lowerWordsExclude) || [],
    protectedFiles: (cfg && cfg.protectedFiles) || [],
    toolStatVerbs: cfg && cfg.toolStatVerbs,
    toolStatNouns: cfg && cfg.toolStatNouns,
    enableLongPrefixLookup: false
});

function buildRendererPayload() {
    return `${SIGNATURE_START}
(() => {
    try {
        if (typeof location !== 'undefined' && location && location.protocol === 'plugin:') return;
        const electron = typeof require === 'function' ? require('electron') : null;
        const ipc = electron && electron.ipcRenderer;
        if (!ipc || typeof ipc.sendSync !== 'function') return;
        const rawBoot = ipc.sendSync('ag-l10n-boot');
        if (!rawBoot) return;
        const boot = typeof rawBoot === 'string' ? JSON.parse(rawBoot) : rawBoot;
        if (!boot || !boot.allDict) return;
        const { frame: _frame, ...cleanCfg } = boot.hubConfig || {};
        ${normalizeText.toString()}
        ${createTranslator.toString()}
        ${installDomTranslator.toString()}
        const translator = createTranslator(new Map(Object.entries(boot.allDict)), boot.rules || [], cleanCfg);
        installDomTranslator(translator, cleanCfg);
    } catch (err) {
        console.error('[ANTIGRAVITY_RENDERER_LOCALIZATION_ERROR]', err);
    }
})();
${SIGNATURE_END}`;
}

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
    ]
};

function translateStaticTarget(target, translator) {
    const withSlot = (str, open, close, literalJson) => {
        if (literalJson) {
            const translated = translator.translateString(str);
            return translated ? JSON.stringify(translated) : null;
        }
        const slotRe = /\$\{[^}]+\}|<[a-z0-9]+\b[^>]*><\/[a-z0-9]+>/gi;
        const slots = str.match(slotRe) || [];
        const tryTranslate = makeToken => {
            const tokens = [];
            const key = str.replace(slotRe, () => {
                const token = makeToken(tokens.length);
                tokens.push(token);
                return token;
            });
            const translated = translator.translateString(key);
            return translated && tokens.every(token => translated.includes(token)) ? { translated, tokens } : null;
        };
        const hit = tryTranslate(idx => `${SLOT_PREFIX}${idx}`)
            || (slots.length > 0 && !str.includes(NUMERIC_PROBE_GUARD) ? tryTranslate(idx => String(NUMERIC_PROBE_BASE + idx)) : null);
        if (!hit) return null;
        let body = escapeTemplateBody(hit.translated);
        hit.tokens.forEach((token, idx) => {
            body = body.split(token).join(slots[idx]);
        });
        return open + body + close;
    };
    const quote = target[0];
    if ((quote === "'" || quote === '"' || quote === '`') && target.endsWith(quote)) {
        const inner = target.slice(1, -1)
            .replace(/\\u2026/g, '…')
            .replace(/\\(['"\\])/g, '$1');
        return (quote === '`' && inner.includes('${')) ? withSlot(inner, '`', '`') : withSlot(inner, '', '', true);
    }
    const htmlMatch = target.match(/^(<[^>]+>|>)(.+)(<\/[a-z0-9]+>)$/i);
    return htmlMatch ? withSlot(htmlMatch[2], htmlMatch[1], htmlMatch[3]) : null;
}

function resolveStaticTarget(entry, translator) {
    const isObj = entry && typeof entry === 'object';
    const target = isObj ? entry.target : entry;
    const replacement = isObj ? entry.replace(translator, target) : translateStaticTarget(target, translator);
    return { target, replacement };
}

function patchStaticTemplates(asarReader, patchMap, dict, rules, hubConfig) {
    const translator = createTranslator(dict, rules, pickTranslatorConfig(hubConfig));
    for (const [file, targets] of Object.entries(STATIC_TEMPLATES)) {
        const raw = asarReader.readFile(file);
        if (!raw || raw.includes(SIGNATURE_START)) continue;
        let next = utils.foldAdjacentJsStrings(raw);
        let changed = false;
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
    const translator = createTranslator(dict, rules, pickTranslatorConfig(hubConfig));
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

function buildMainBootstrap() {
    return `${SIGNATURE_START}
(() => {
    try {
        require('./l10n/main').installFromAsar(require('electron'));
    } catch (err) {
        console.error('[ANTIGRAVITY_MAIN_LOCALIZATION_ERROR]', err);
    }
})();
${SIGNATURE_END}`;
}

function verifyPatchOutputs(patchMap, extraScripts = []) {
    for (const [name, code] of extraScripts) {
        if (!code) continue;
        if (code.includes(SIGNATURE_START) || code.includes(SIGNATURE_END)) {
            throw new Error(`补丁产物校验失败: ${name} 不应包含签名边界标记`);
        }
        new vm.Script(code, { filename: name });
    }
    for (const [rel, code] of Object.entries(patchMap || {})) {
        if (rel.endsWith('.json')) {
            JSON.parse(code);
            continue;
        }
        if (!code.includes(SIGNATURE_START) || !code.includes(SIGNATURE_END)) {
            throw new Error(`补丁产物校验失败: ${rel} 缺少签名标记`);
        }
        new vm.Script(code, { filename: rel });
    }
}

function generatePatchMap(asarReader) {
    const allDict = utils.loadDictionary();
    const byFile = utils.loadDictionariesByFile();
    const rules = utils.loadRules();
    const config = utils.loadConfig();
    const fragments = utils.loadFragments();

    const menusDict = byFile['menus.json'] || {};
    const agentsDict = byFile['agents.json'] || {};
    const { hubConfig, frameConfig, frameExtraDict, frameExtraRules } = buildScopedConfigs(config, fragments);

    const l10nData = {
        dictsHash: utils.getDictsHash(),
        allDict,
        menusDict,
        agentsDict,
        rules,
        hubConfig,
        frameConfig,
        frameExtraDict,
        frameExtraRules
    };

    const patchMap = {};
    patchMap['dist/l10n/data.json'] = JSON.stringify(l10nData);
    for (const file of RUNTIME_L10N_FILES) {
        const rawMod = fs.readFileSync(path.join(__dirname, 'runtime', file), 'utf8');
        patchMap[`dist/l10n/${file}`] = `${rawMod}${rawMod.endsWith('\n') ? '' : '\n'}${SIGNATURE_START}\n${SIGNATURE_END}\n`;
    }

    const rawMain = cleanInjectedPatches(asarReader.readFile('dist/main.js'));
    if (rawMain) patchMap['dist/main.js'] = insertAfterPrologue(rawMain, buildMainBootstrap());

    const rawPreload = cleanInjectedPatches(asarReader.readFile('dist/preload.js'));
    if (rawPreload) patchMap['dist/preload.js'] = `${rawPreload}${rawPreload.endsWith('\n') ? '' : '\n'}${buildRendererPayload()}`;

    patchStaticTemplates(asarReader, patchMap, allDict, rules, hubConfig);
    verifyPatchOutputs(patchMap, [['framePayload.js', buildFrameScript(l10nData)]]);
    return patchMap;
}

module.exports = {
    STATIC_TEMPLATES,
    auditStaticTemplates,
    generatePatchMap
};
