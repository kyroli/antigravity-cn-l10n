function installMainHooks(electron, translator) {
    if (!electron || !translator || electron._agL10nInstalled) return;
    try {
        Object.defineProperty(electron, '_agL10nInstalled', { value: true });
        const { app, Menu, Tray, dialog, BrowserWindow } = electron;

        function wrapMenuItemClick(item, rawLabel, translatedLabel) {
            if (typeof item.click === 'function' && !item.click._l10nWrapped) {
                const origClick = item.click;
                const wrappedClick = function (menuItem, browserWindow, event) {
                    if (menuItem && typeof menuItem === 'object') {
                        const proxy = new Proxy(menuItem, {
                            get(target, prop) {
                                if (prop === 'label') {
                                    const cur = target.label;
                                    return cur === translatedLabel ? (target._rawLabel || rawLabel) : cur;
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
                if (Array.isArray(item.submenu)) {
                    translateTemplateItems(item.submenu);
                } else if (item.submenu && Array.isArray(item.submenu.items)) {
                    translateLiveMenuItems(item.submenu);
                }
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
                if (item.submenu) {
                    translateLiveMenuItems(item.submenu);
                }
            }
        }

        if (Menu) {
            if (typeof Menu.buildFromTemplate === 'function') {
                const origBuild = Menu.buildFromTemplate;
                Menu.buildFromTemplate = function (template) {
                    try { translateTemplateItems(template); } catch (e) {}
                    return origBuild.apply(this, arguments);
                };
            }
            if (typeof Menu.setApplicationMenu === 'function') {
                const origSetAppMenu = Menu.setApplicationMenu;
                Menu.setApplicationMenu = function (menu) {
                    try { translateLiveMenuItems(menu); } catch (e) {}
                    return origSetAppMenu.apply(this, arguments);
                };
            }
        }

        if (Tray && Tray.prototype && typeof Tray.prototype.setContextMenu === 'function') {
            const origSetContextMenu = Tray.prototype.setContextMenu;
            Tray.prototype.setContextMenu = function (menu) {
                try { translateLiveMenuItems(menu); } catch (e) {}
                return origSetContextMenu.apply(this, arguments);
            };
        }

        function translateDialogOptions(args) {
            for (let i = args.length - 1; i >= 0; i--) {
                const arg = args[i];
                if (arg && typeof arg === 'object' && !Array.isArray(arg) && !(BrowserWindow && arg instanceof BrowserWindow)) {
                    for (const field of ['title', 'message', 'detail', 'buttonLabel']) {
                        if (typeof arg[field] === 'string' && arg[field]) {
                            const t = translator.translateString(arg[field]);
                            if (t) arg[field] = t;
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
            for (const method of ['showMessageBox', 'showMessageBoxSync', 'showOpenDialog', 'showOpenDialogSync']) {
                if (typeof dialog[method] === 'function') {
                    const origDialogFn = dialog[method];
                    dialog[method] = function () {
                        try { translateDialogOptions(arguments); } catch (e) {}
                        return origDialogFn.apply(this, arguments);
                    };
                }
            }
            if (typeof dialog.showErrorBox === 'function') {
                const origShowErrorBox = dialog.showErrorBox;
                dialog.showErrorBox = function (title, content) {
                    try {
                        if (typeof title === 'string' && title) {
                            const t = translator.translateString(title);
                            if (t) arguments[0] = t;
                        }
                        if (typeof content === 'string' && content) {
                            const c = translator.translateString(content);
                            if (c) arguments[1] = c;
                        }
                    } catch (e) {}
                    return origShowErrorBox.apply(this, arguments);
                };
            }
        }

        const DATA_PREFIX = 'data:text/html;charset=utf-8,';
        function translateDataUrl(url) {
            if (typeof url !== 'string' || !url.startsWith(DATA_PREFIX)) return url;
            try {
                const rawHtml = decodeURIComponent(url.slice(DATA_PREFIX.length));
                const translatedHtml = rawHtml.replace(
                    /<(title|h1|p|span|button|div)(\b[^>]*)>([\s\S]*?)<\/\1>/gi,
                    (full, tag, attrs, inner) => {
                        const trimmed = inner.trim();
                        if (!trimmed || (trimmed.includes('<') && !trimmed.includes('<b>'))) return full;
                        const trans = translator.translateString(trimmed);
                        return trans ? `<${tag}${attrs}>${trans}</${tag}>` : full;
                    }
                );
                if (translatedHtml !== rawHtml) {
                    return DATA_PREFIX + encodeURIComponent(translatedHtml);
                }
            } catch (e) {}
            return url;
        }

        function wrapLoadUrlOnTarget(target) {
            if (!target || typeof target.loadURL !== 'function' || target.loadURL._l10nWrapped) return;
            const origLoadURL = target.loadURL;
            const wrapped = function (url) {
                if (typeof url === 'string' && url.startsWith(DATA_PREFIX)) {
                    arguments[0] = translateDataUrl(url);
                }
                return origLoadURL.apply(this, arguments);
            };
            Object.defineProperty(wrapped, '_l10nWrapped', { value: true });
            target.loadURL = wrapped;
        }

        if (BrowserWindow && BrowserWindow.prototype) {
            wrapLoadUrlOnTarget(BrowserWindow.prototype);
        }

        // 同时覆盖 BaseWindow + WebContentsView 架构下的 webContents.loadURL
        if (app && typeof app.on === 'function') {
            app.on('web-contents-created', (_event, contents) => {
                wrapLoadUrlOnTarget(contents);
            });
        }
    } catch (e) {
        console.error('[ANTIGRAVITY_MAIN_HOOK_ERROR]', e);
    }
}

module.exports = {
    installMainHooks
};
