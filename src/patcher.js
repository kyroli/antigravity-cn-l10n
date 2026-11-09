const vm = require('vm');
const utils = require('./utils');
const { normalizeText, createTranslator } = require('./runtime/translator');
const { installMainHooks } = require('./runtime/main');
const { installDomTranslator } = require('./runtime/dom');
const { SIGNATURE_START, SIGNATURE_END } = utils;

const PATCH_BLOCK_RE = new RegExp(
    utils.escapeRegExp(SIGNATURE_START) + '[\\s\\S]*?' + utils.escapeRegExp(SIGNATURE_END) + '\\r?\\n?',
    'g'
);

function cleanInjectedPatches(content) {
    if (!content) return '';
    return content.replace(PATCH_BLOCK_RE, '');
}

/**
 * 将注入代码插入在 CommonJS 模块开头的注释与 "use strict" 指令序言之后，
 * 确保宿主模块不会因为头部插入语句而丢失 ECMAScript 严格模式语义。
 */
function insertAfterPrologue(source, injectedCode) {
    if (!source) return injectedCode;
    const prologueRe = /^(?:(?:\uFEFF)?(?:\s+|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/)*(['"])use strict\1;?[ \t]*\r?\n?)/;
    const match = source.match(prologueRe);
    if (match) {
        const prefix = match[0];
        const rest = source.slice(prefix.length);
        const sep = prefix.endsWith('\n') ? '' : '\n';
        return prefix + sep + injectedCode + '\n' + rest;
    }
    return injectedCode + '\n' + source;
}

function buildMainPayload(dict, rules, config) {
    const mainConfig = Object.assign({}, config, { enableLongPrefixLookup: false });
    return `${SIGNATURE_START}
(() => {
    try {
        const electron = require('electron');
        ${normalizeText.toString()}
        ${createTranslator.toString()}
        ${installMainHooks.toString()}
        const translator = createTranslator(${JSON.stringify(dict)}, ${JSON.stringify(rules)}, ${JSON.stringify(mainConfig)});
        installMainHooks(electron, translator);
    } catch (e) {
        console.error('[ANTIGRAVITY_MAIN_LOCALIZATION_ERROR]', e);
    }
})();
${SIGNATURE_END}`;
}

function buildRendererPayload(dict, rules, config) {
    return `${SIGNATURE_START}
(() => {
    try {
        ${normalizeText.toString()}
        ${createTranslator.toString()}
        ${installDomTranslator.toString()}
        const translator = createTranslator(${JSON.stringify(dict)}, ${JSON.stringify(rules)}, ${JSON.stringify(config)});
        installDomTranslator(translator, ${JSON.stringify(config)});
    } catch (e) {
        console.error('[ANTIGRAVITY_RENDERER_LOCALIZATION_ERROR]', e);
    }
})();
${SIGNATURE_END}`;
}

/**
 * 构建期语法与模拟沙箱自检：
 * 1. 验证生成载荷在隔离沙箱中执行不会抛出 ReferenceError / SyntaxError；
 * 2. 验证每个注入后的宿主文件可通过 V8 vm.Script 语法编译。
 */
function verifyPayloadsAndPatches(mainPayload, rendererPayload, patchMap) {
    let mainError = null;
    const mainSandbox = {
        require: (mod) => {
            if (mod === 'electron') {
                return {
                    app: { on: () => {} },
                    Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
                    Tray: function () {},
                    dialog: { showMessageBox: () => {}, showErrorBox: () => {} },
                    BrowserWindow: function () {}
                };
            }
            return {};
        },
        console: {
            error: (_tag, err) => { mainError = err; },
            warn: () => {},
            log: () => {}
        }
    };
    vm.runInNewContext(mainPayload, mainSandbox, { filename: 'main_payload.js' });
    if (mainError) {
        throw new Error(`主进程注入载荷自检失败: ${mainError.message || mainError}`);
    }

    let rendererError = null;
    const dummyDoc = {
        nodeType: 9,
        readyState: 'complete',
        documentElement: {
            nodeType: 1,
            tagName: 'HTML',
            className: '',
            childNodes: [],
            getAttribute: () => null,
            hasAttribute: () => false
        },
        addEventListener: () => {}
    };
    const rendererSandbox = {
        document: dummyDoc,
        window: {},
        Node: { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_FRAGMENT_NODE: 11 },
        MutationObserver: function () { return { observe: () => {} }; },
        WeakMap,
        Map,
        Set,
        RegExp,
        Object,
        Array,
        console: {
            error: (_tag, err) => { rendererError = err; },
            warn: () => {},
            log: () => {}
        }
    };
    vm.runInNewContext(rendererPayload, rendererSandbox, { filename: 'renderer_payload.js' });
    if (rendererError) {
        throw new Error(`渲染进程注入载荷自检失败: ${rendererError.message || rendererError}`);
    }

    for (const [relPath, fullSource] of Object.entries(patchMap)) {
        new vm.Script(fullSource, { filename: relPath });
    }
}

function generatePatchMap(asarReader) {
    const dict = utils.loadDictionary();
    const rules = utils.loadRules();
    const config = utils.loadConfig();

    const mainPayload = buildMainPayload(dict, rules, config);
    const rendererPayload = buildRendererPayload(dict, rules, config);

    const patchMap = {};

    // 1. 注入主进程 dist/main.js (保留文件头部的 "use strict" 指令序言)
    const rawMain = asarReader.readFile('dist/main.js');
    if (rawMain) {
        const cleanMain = cleanInjectedPatches(rawMain);
        patchMap['dist/main.js'] = insertAfterPrologue(cleanMain, mainPayload);
    }

    // 2. 注入主窗口渲染预加载 dist/preload.js (置于文件末尾)
    const rawPreload = asarReader.readFile('dist/preload.js');
    if (rawPreload) {
        const cleanPreload = cleanInjectedPatches(rawPreload);
        patchMap['dist/preload.js'] = cleanPreload + '\n' + rendererPayload;
    }

    // 3. 注入 IDE 安装向导预加载 dist/ideInstall/wizardPreload.js (置于文件末尾)
    const rawWizard = asarReader.readFile('dist/ideInstall/wizardPreload.js');
    if (rawWizard) {
        const cleanWizard = cleanInjectedPatches(rawWizard);
        patchMap['dist/ideInstall/wizardPreload.js'] = cleanWizard + '\n' + rendererPayload;
    }

    verifyPayloadsAndPatches(mainPayload, rendererPayload, patchMap);

    return patchMap;
}

module.exports = {
    cleanInjectedPatches,
    insertAfterPrologue,
    buildMainPayload,
    buildRendererPayload,
    verifyPayloadsAndPatches,
    generatePatchMap
};
