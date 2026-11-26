const { normalizeText, createTranslator } = require('./translator');
const { installDomTranslator } = require('./dom');
const bundleRewriter = require('./bundleRewriter');
const bundleProxy = require('./bundleProxy');

function buildFrameScript(data = {}) {
    const frameExtra = data.frameExtraDict || {};
    const frameDict = Object.keys(frameExtra).length
        ? Object.assign({}, data.agentsDict || {}, frameExtra)
        : (data.agentsDict || {});
    const frameRules = Array.isArray(data.frameExtraRules) && data.frameExtraRules.length
        ? [...data.frameExtraRules, ...(data.rules || [])]
        : (data.rules || []);
    const { frame: _frame, ...cleanCfg } = data.frameConfig || {};
    const safeJson = v => JSON.stringify(v).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    const serializedDict = `new Map(${safeJson(Object.entries(frameDict))})`;
    return `(() => {
    try {
        const loc = typeof location !== 'undefined' ? location : null;
        if (!loc) return;
        const proto = loc.protocol;
        const host = (loc.hostname || '').toLowerCase();
        let isTop = true;
        try {
            isTop = typeof window === 'undefined' ? true : window === window.top;
        } catch {
            isTop = false;
        }
        const isLocalSub = !isTop && (proto === 'http:' || proto === 'https:') && (host === '127.0.0.1' || host === 'localhost' || host === '[::1]');
        if (proto !== 'plugin:' && !isLocalSub) return;
        const __cfg = ${safeJson(cleanCfg)};
        ${normalizeText.toString()}
        ${createTranslator.toString()}
        ${installDomTranslator.toString()}
        const translator = createTranslator(${serializedDict}, ${safeJson(frameRules)}, __cfg);
        installDomTranslator(translator, __cfg);
    } catch (err) {
        console.error('[ANTIGRAVITY_FRAME_LOCALIZATION_ERROR]', err);
    }
})();`;
}

function installMainHooks(electron, translator, extraOpts) {
    if (!electron || !translator || electron._agL10nInstalled) return;
    try {
        Object.defineProperty(electron, '_agL10nInstalled', { value: true });
        const { app, Menu, Tray, dialog, BrowserWindow } = electron;
        const opts = extraOpts && typeof extraOpts === 'object' ? extraOpts : {};
        const dialogTranslator = opts.dialogTranslator || translator;
        const getFrameScript = typeof opts.getFrameScript === 'function' ? opts.getFrameScript : null;
        const onAppReadyExtra = typeof opts.onAppReadyExtra === 'function' ? opts.onAppReadyExtra : null;

        function wrapBefore(obj, prop, onArgs) {
            if (!obj || typeof obj[prop] !== 'function') return;
            const orig = obj[prop];
            obj[prop] = function () {
                const args = [...arguments];
                try {
                    onArgs(args);
                } catch {}
                return orig.apply(this, args);
            };
        }

        function wrapMenuItemClick(item, rawLabel, translatedLabel) {
            if (typeof item.click !== 'function' || item.click._l10nWrapped) return;
            const origClick = item.click;
            const wrappedClick = function (menuItem, browserWindow, event) {
                if (menuItem && typeof menuItem === 'object') {
                    const proxy = new Proxy(menuItem, {
                        get(target, prop) {
                            if (prop === 'label') {
                                return target.label === translatedLabel ? (target._rawLabel || rawLabel) : target.label;
                            }
                            return target[prop];
                        }
                    });
                    return origClick.call(this, proxy, browserWindow, event);
                }
                return origClick.apply(this, arguments);
            };
            Object.defineProperty(wrappedClick, '_l10nWrapped', { value: true });
            item.click = wrappedClick;
        }

        function translateTemplateItems(items) {
            if (!Array.isArray(items)) return;
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                if (!item || typeof item !== 'object') continue;
                if (typeof item.label === 'string' && item.label) {
                    const rawLabel = item._rawLabel || item.label;
                    const trans = translator.translateMenuLabel(item.label);
                    if (trans && trans !== item.label) {
                        item._rawLabel = rawLabel;
                        item.label = trans;
                        wrapMenuItemClick(item, rawLabel, trans);
                    }
                }
                if (Array.isArray(item.submenu)) translateTemplateItems(item.submenu);
                else if (item.submenu && Array.isArray(item.submenu.items)) translateLiveMenuItems(item.submenu);
            }
        }

        function translateLiveMenuItems(menu) {
            if (!menu || !Array.isArray(menu.items)) return;
            if (!menu.items._l10nWrapped) {
                const origFind = menu.items.find;
                Object.defineProperty(menu.items, '_l10nWrapped', { value: true });
                menu.items.find = function (predicate, thisArg) {
                    let found = origFind.call(this, predicate, thisArg);
                    if (!found && typeof predicate === 'function') {
                        found = origFind.call(this, (item, idx, arr) => {
                            if (!item || !item._rawLabel || item._rawLabel === item.label) return false;
                            const proxy = new Proxy(item, {
                                get(target, prop) {
                                    return prop === 'label' ? target._rawLabel : target[prop];
                                }
                            });
                            return predicate.call(thisArg, proxy, idx, arr);
                        });
                    }
                    return found;
                };
            }
            for (let i = 0; i < menu.items.length; i++) {
                const item = menu.items[i];
                if (!item) continue;
                if (typeof item.label === 'string' && item.label) {
                    if (!item._rawLabel) {
                        Object.defineProperty(item, '_rawLabel', { value: item.label, writable: true });
                    }
                    const trans = translator.translateMenuLabel(item.label) || translator.translateMenuLabel(item._rawLabel);
                    if (trans && item.label !== trans) {
                        item.label = trans;
                        wrapMenuItemClick(item, item._rawLabel, trans);
                    }
                }
                if (item.submenu) translateLiveMenuItems(item.submenu);
            }
        }

        wrapBefore(Menu, 'buildFromTemplate', args => translateTemplateItems(args[0]));
        wrapBefore(Menu, 'setApplicationMenu', args => translateLiveMenuItems(args[0]));
        wrapBefore(Tray && Tray.prototype, 'setContextMenu', args => translateLiveMenuItems(args[0]));

        function translateDialogOptions(args) {
            for (let i = args.length - 1; i >= 0; i--) {
                const arg = args[i];
                if (arg && typeof arg === 'object' && !Array.isArray(arg) && !(typeof BrowserWindow === 'function' && arg instanceof BrowserWindow)) {
                    for (const field of ['title', 'message', 'detail', 'buttonLabel']) {
                        if (typeof arg[field] === 'string' && arg[field]) {
                            arg[field] = dialogTranslator.translateString(arg[field]) || arg[field];
                        }
                    }
                    if (Array.isArray(arg.buttons)) {
                        arg.buttons = arg.buttons.map(btn => (typeof btn === 'string' ? (dialogTranslator.translateString(btn) || btn) : btn));
                    }
                    break;
                }
            }
        }

        if (dialog) {
            wrapBefore(dialog, 'showMessageBox', translateDialogOptions);
            wrapBefore(dialog, 'showOpenDialog', translateDialogOptions);
            wrapBefore(dialog, 'showErrorBox', args => {
                if (typeof args[0] === 'string' && args[0]) args[0] = dialogTranslator.translateString(args[0]) || args[0];
                if (typeof args[1] === 'string' && args[1]) args[1] = dialogTranslator.translateString(args[1]) || args[1];
            });
        }

        const hasFrameHooks = Boolean(getFrameScript);
        if ((hasFrameHooks || onAppReadyExtra) && app) {
            const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
            const pendingWebContents = new Set();
            let appReadyResolved = !app.isReady || Boolean(app.isReady());
            let readyFlushed = false;
            let loggedMissingExecApi = false;

            const safeRead = (obj, prop) => {
                try {
                    return obj ? obj[prop] : undefined;
                } catch {
                    return undefined;
                }
            };
            const isDestroyedObj = obj => {
                if (!obj) return true;
                try {
                    if (obj.detached === true) return true;
                    return typeof obj.isDestroyed === 'function' ? Boolean(obj.isDestroyed()) : Boolean(obj.isDestroyed);
                } catch {
                    return true;
                }
            };
            const parseUrl = raw => {
                if (typeof raw !== 'string' || !raw) return null;
                try {
                    return new URL(raw);
                } catch {
                    return null;
                }
            };
            const isLoopbackHttp = url => Boolean(
                url && (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTS.has((url.hostname || '').toLowerCase())
            );
            const isExpectedDisposalError = (frame, err) => isDestroyedObj(frame)
                || /Render frame was disposed|frame disposed|frame was disposed|destroyed|detached/i.test(err?.message || String(err || ''));

            function isEligibleWebContents(contents) {
                if (!contents || isDestroyedObj(contents) || !appReadyResolved) return false;
                if (typeof contents.getType === 'function' && contents.getType() === 'webview') return false;
                try {
                    const defaultSession = electron.session && electron.session.defaultSession;
                    const session = contents.session;
                    return Boolean(session && ((defaultSession && session === defaultSession) || session.protocol?.isProtocolHandled?.('plugin')));
                } catch {
                    return false;
                }
            }

            function isEligibleTargetFrame(frame, contents) {
                if (!frame || isDestroyedObj(frame) || (contents && isDestroyedObj(contents))) return false;
                const frameUrl = safeRead(frame, 'url') || '';
                const url = parseUrl(frameUrl);
                if (!url || url.protocol === 'about:' || url.protocol === 'data:' || url.protocol === 'blob:') return false;
                let eligible = url.protocol === 'plugin:';
                if (!eligible && isLoopbackHttp(url)) {
                    const mainFrame = contents ? safeRead(contents, 'mainFrame') : null;
                    const isSubframe = safeRead(frame, 'parent') != null || (Boolean(mainFrame) && frame !== mainFrame);
                    if (isSubframe) {
                        const topUrl = safeRead(safeRead(frame, 'top'), 'url')
                            || safeRead(mainFrame, 'url')
                            || (typeof contents?.getURL === 'function' ? contents.getURL() : '');
                        const topUrlObj = parseUrl(topUrl);
                        eligible = Boolean(topUrlObj && (topUrlObj.protocol === 'plugin:' || isLoopbackHttp(topUrlObj)));
                    }
                }
                if (!eligible) return false;
                if (typeof frame.executeJavaScript !== 'function') {
                    if (!loggedMissingExecApi) {
                        loggedMissingExecApi = true;
                        console.error('[ANTIGRAVITY_FRAME_L10N_ERROR]', 'WebFrameMain.executeJavaScript is unavailable', frameUrl);
                    }
                    return false;
                }
                return true;
            }

            function injectIntoFrame(frame, contents) {
                if (!isEligibleTargetFrame(frame, contents)) return;
                const scriptToInject = getFrameScript ? getFrameScript() : '';
                if (!scriptToInject) return;
                const url = safeRead(frame, 'url') || '';
                const onErr = err => {
                    if (!isExpectedDisposalError(frame, err)) {
                        console.error('[ANTIGRAVITY_FRAME_L10N_ERROR]', url, err);
                    }
                };
                try {
                    Promise.resolve(frame.executeJavaScript(scriptToInject, false)).catch(onErr);
                } catch (err) {
                    onErr(err);
                }
            }

            function injectSubtreeFrames(contents) {
                const subtree = safeRead(safeRead(contents, 'mainFrame'), 'framesInSubtree');
                if (!Array.isArray(subtree)) return;
                for (let i = 0; i < subtree.length; i++) {
                    injectIntoFrame(subtree[i], contents);
                }
            }

            function attachFrameTracker(contents) {
                if (!isEligibleWebContents(contents) || contents._agL10nFrameTracked) return;
                Object.defineProperty(contents, '_agL10nFrameTracked', { value: true });
                if (typeof contents.on === 'function') {
                    contents.on('did-frame-finish-load', (_event, _isMainFrame, frameProcessId, frameRoutingId) => {
                        if (!isEligibleWebContents(contents)) return;
                        const webFrameMain = electron.webFrameMain;
                        let matched = null;
                        if (webFrameMain && typeof webFrameMain.fromId === 'function' && Number.isInteger(frameProcessId) && Number.isInteger(frameRoutingId)) {
                            try {
                                matched = webFrameMain.fromId(frameProcessId, frameRoutingId) || null;
                            } catch {}
                        }
                        if (matched) injectIntoFrame(matched, contents);
                        else injectSubtreeFrames(contents);
                    });
                }
                injectSubtreeFrames(contents);
            }

            function handleContents(contents) {
                if (!contents || isDestroyedObj(contents)) return;
                if (!appReadyResolved) {
                    if (!pendingWebContents.has(contents)) {
                        pendingWebContents.add(contents);
                        contents.once?.('destroyed', () => pendingWebContents.delete(contents));
                    }
                    return;
                }
                attachFrameTracker(contents);
            }

            function onAppReady() {
                if (readyFlushed) return;
                readyFlushed = true;
                appReadyResolved = true;
                if (onAppReadyExtra) {
                    try {
                        onAppReadyExtra();
                    } catch (err) {
                        console.error('[ANTIGRAVITY_MAIN_READY_ERROR]', err);
                    }
                }
                if (!hasFrameHooks) return;
                for (const contents of pendingWebContents) attachFrameTracker(contents);
                pendingWebContents.clear();
                try {
                    const existing = electron.webContents?.getAllWebContents?.();
                    if (Array.isArray(existing)) existing.forEach(attachFrameTracker);
                } catch (err) {
                    console.error('[ANTIGRAVITY_FRAME_L10N_ERROR]', 'getAllWebContents', err);
                }
            }

            if (hasFrameHooks && typeof app.on === 'function') {
                app.on('web-contents-created', (_event, contents) => handleContents(contents));
            }
            if (appReadyResolved) {
                onAppReady();
            } else if (typeof app.whenReady === 'function') {
                Promise.resolve(app.whenReady()).then(onAppReady).catch(err => {
                    console.error('[ANTIGRAVITY_FRAME_L10N_ERROR]', 'whenReady', err);
                });
            } else if (typeof app.once === 'function') {
                app.once('ready', onAppReady);
            }
        }
    } catch (err) {
        console.error('[ANTIGRAVITY_MAIN_HOOK_ERROR]', err);
    }
}

function installFromAsar(electron) {
    if (!electron || electron._agL10nInstalled) return;
    const data = require('./data.json');

    const hubCfg = data.hubConfig || {};
    const { ipcMain } = electron;
    if (ipcMain && typeof ipcMain.on === 'function') {
        const bootPayloadJson = JSON.stringify({
            allDict: data.allDict || {},
            rules: data.rules || [],
            hubConfig: hubCfg
        });
        ipcMain.on('ag-l10n-boot', event => {
            event.returnValue = bootPayloadJson;
        });
    }

    const translatorCfg = {
        lowerWordsExclude: hubCfg.lowerWordsExclude || [],
        protectedFiles: hubCfg.protectedFiles || [],
        toolStatVerbs: hubCfg.toolStatVerbs,
        toolStatNouns: hubCfg.toolStatNouns,
        enableLongPrefixLookup: false
    };

    const menuTranslator = createTranslator(data.menusDict || {}, data.rules || [], translatorCfg);
    const allTranslator = createTranslator(data.allDict || {}, data.rules || [], translatorCfg);

    let cachedFrameScript = null;
    const getFrameScript = () => {
        if (cachedFrameScript === null) cachedFrameScript = buildFrameScript(data);
        return cachedFrameScript;
    };

    installMainHooks(electron, menuTranslator, {
        dialogTranslator: allTranslator,
        getFrameScript,
        onAppReadyExtra: () => {
            bundleProxy.installBundleProxy(electron, {
                translator: allTranslator,
                hubConfig: hubCfg,
                dictsHash: data.dictsHash || '0',
                bundleRewriter
            });
        }
    });
}

module.exports = {
    buildFrameScript,
    installMainHooks,
    installFromAsar
};
