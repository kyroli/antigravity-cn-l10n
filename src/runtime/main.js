function installMainHooks(electron, translator, frameScript) {
    if (!electron || !translator || electron._agL10nInstalled) return;
    try {
        Object.defineProperty(electron, '_agL10nInstalled', { value: true });
        const { app, Menu, Tray, dialog, BrowserWindow } = electron;

        function wrapBefore(obj, prop, onArgs) {
            if (!obj || typeof obj[prop] !== 'function') return;
            const orig = obj[prop];
            obj[prop] = function () {
                const args = [...arguments];
                try { onArgs(args); } catch (e) {}
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

        wrapBefore(Menu, 'buildFromTemplate', a => translateTemplateItems(a[0]));
        wrapBefore(Menu, 'setApplicationMenu', a => translateLiveMenuItems(a[0]));
        wrapBefore(Tray && Tray.prototype, 'setContextMenu', a => translateLiveMenuItems(a[0]));

        function translateDialogOptions(args) {
            for (let i = args.length - 1; i >= 0; i--) {
                const arg = args[i];
                if (arg && typeof arg === 'object' && !Array.isArray(arg) && !(typeof BrowserWindow === 'function' && arg instanceof BrowserWindow)) {
                    for (const field of ['title', 'message', 'detail', 'buttonLabel']) {
                        if (typeof arg[field] === 'string' && arg[field]) {
                            arg[field] = translator.translateString(arg[field]) || arg[field];
                        }
                    }
                    if (Array.isArray(arg.buttons)) {
                        arg.buttons = arg.buttons.map(b => (typeof b === 'string' ? (translator.translateString(b) || b) : b));
                    }
                    break;
                }
            }
        }

        if (dialog) {
            wrapBefore(dialog, 'showMessageBox', translateDialogOptions);
            wrapBefore(dialog, 'showOpenDialog', translateDialogOptions);
            wrapBefore(dialog, 'showErrorBox', a => {
                if (typeof a[0] === 'string' && a[0]) a[0] = translator.translateString(a[0]) || a[0];
                if (typeof a[1] === 'string' && a[1]) a[1] = translator.translateString(a[1]) || a[1];
            });
        }

        if (typeof frameScript === 'string' && frameScript.length > 0 && app) {
            const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
            const pendingWebContents = new Set();
            let appReadyResolved = !app.isReady || Boolean(app.isReady());
            let readyFlushed = false;
            let loggedMissingExecApi = false;

            const safeRead = (obj, prop) => {
                try { return obj ? obj[prop] : undefined; } catch (e) { return undefined; }
            };
            const isDestroyedObj = obj => {
                if (!obj) return true;
                try {
                    if (obj.detached === true) return true;
                    return typeof obj.isDestroyed === 'function' ? Boolean(obj.isDestroyed()) : Boolean(obj.isDestroyed);
                } catch (e) { return true; }
            };
            const parseUrl = raw => {
                if (typeof raw !== 'string' || !raw) return null;
                try { return new URL(raw); } catch (e) { return null; }
            };
            const isLoopbackHttp = u => Boolean(
                u && (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK_HOSTS.has((u.hostname || '').toLowerCase())
            );
            const isExpectedDisposalError = (frame, err) => isDestroyedObj(frame)
                || /Render frame was disposed|frame disposed|frame was disposed|destroyed|detached/i.test(err?.message || String(err || ''));

            // 仅向默认会话宿主内的 plugin:// 帧及本地回环子帧注入，隔离 webview 与外部页面
            function isEligibleWebContents(contents) {
                if (!contents || isDestroyedObj(contents) || !appReadyResolved) return false;
                if (typeof contents.getType === 'function' && contents.getType() === 'webview') return false;
                try {
                    const defaultSes = electron.session && electron.session.defaultSession;
                    return Boolean(defaultSes && contents.session === defaultSes);
                } catch (e) { return false; }
            }

            function isEligibleTargetFrame(frame, contents) {
                if (!frame || isDestroyedObj(frame) || (contents && isDestroyedObj(contents))) return false;
                const frameUrl = safeRead(frame, 'url') || '';
                const u = parseUrl(frameUrl);
                if (!u || u.protocol === 'about:' || u.protocol === 'data:' || u.protocol === 'blob:') return false;
                let eligible = u.protocol === 'plugin:';
                if (!eligible && isLoopbackHttp(u)) {
                    const mainFrame = contents ? safeRead(contents, 'mainFrame') : null;
                    const isSubframe = safeRead(frame, 'parent') != null || (Boolean(mainFrame) && frame !== mainFrame);
                    if (isSubframe) {
                        const topUrl = safeRead(safeRead(frame, 'top'), 'url')
                            || safeRead(mainFrame, 'url')
                            || (typeof contents?.getURL === 'function' ? contents.getURL() : '');
                        const topU = parseUrl(topUrl);
                        eligible = Boolean(topU && (topU.protocol === 'plugin:' || isLoopbackHttp(topU)));
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
                const url = safeRead(frame, 'url') || '';
                const onErr = err => {
                    if (!isExpectedDisposalError(frame, err)) {
                        console.error('[ANTIGRAVITY_FRAME_L10N_ERROR]', url, err);
                    }
                };
                try {
                    Promise.resolve(frame.executeJavaScript(frameScript, false)).catch(onErr);
                } catch (e) { onErr(e); }
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
                        const wfm = electron.webFrameMain;
                        let matched = null;
                        if (wfm && typeof wfm.fromId === 'function' && Number.isInteger(frameProcessId) && Number.isInteger(frameRoutingId)) {
                            try { matched = wfm.fromId(frameProcessId, frameRoutingId) || null; } catch (e) {}
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
                for (const wc of pendingWebContents) attachFrameTracker(wc);
                pendingWebContents.clear();
                try {
                    const existing = electron.webContents?.getAllWebContents?.();
                    if (Array.isArray(existing)) existing.forEach(attachFrameTracker);
                } catch (e) {
                    console.error('[ANTIGRAVITY_FRAME_L10N_ERROR]', 'getAllWebContents', e);
                }
            }

            if (typeof app.on === 'function') {
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
    } catch (e) {
        console.error('[ANTIGRAVITY_MAIN_HOOK_ERROR]', e);
    }
}

module.exports = {
    installMainHooks
};
