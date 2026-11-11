const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const utils = require('../src/utils');
const asar = require('../src/asar');
const patcher = require('../src/patcher');
const extractor = require('../src/inspector/extractor');
const auditor = require('../src/inspector/auditor');
const { normalizeText, createTranslator } = require('../src/runtime/translator');
const { installDomTranslator } = require('../src/runtime/dom');
const { installMainHooks } = require('../src/runtime/main');

function buildMiniAsar(filesObj) {
    const root = { files: {} }, chunks = [];
    let offset = 0;
    for (const [relPath, content] of Object.entries(filesObj)) {
        const parts = relPath.split('/');
        let curr = root.files;
        for (let i = 0; i < parts.length - 1; i++) curr = (curr[parts[i]] ||= { files: {} }).files;
        const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
        curr[parts[parts.length - 1]] = { size: buf.length, offset: String(offset) };
        chunks.push(buf); offset += buf.length;
    }
    const jsonBuf = Buffer.from(JSON.stringify(root), 'utf8'), aligned = Math.ceil(jsonBuf.length / 4) * 4;
    const hdr = Buffer.alloc(16 + aligned);
    hdr.writeUInt32LE(4, 0); hdr.writeUInt32LE(8 + aligned, 4); hdr.writeUInt32LE(4 + aligned, 8); hdr.writeUInt32LE(jsonBuf.length, 12);
    jsonBuf.copy(hdr, 16);
    return Buffer.concat([hdr, ...chunks]);
}

function createTinyDom(readyState = 'complete') {
    const NodeConsts = { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_FRAGMENT_NODE: 11, DOCUMENT_NODE: 9 };
    const observers = [], listeners = {}, notify = m => observers.forEach(o => o.cb([m]));
    const makeText = val => {
        let cur = String(val);
        return {
            nodeType: 3, parentNode: null, parentElement: null,
            getRootNode() { return this.parentNode ? this.parentNode.getRootNode() : this; },
            get textContent() { return cur; }, get nodeValue() { return cur; },
            set nodeValue(v) { if (cur !== String(v)) { cur = String(v); notify({ type: 'characterData', target: this }); } }
        };
    };
    const makeEl = (tag, attrs = {}, children = []) => {
        const attrMap = new Map(Object.entries(attrs).map(([k, v]) => [k, String(v)])), childNodes = [];
        const el = {
            nodeType: 1, tagName: tag.toUpperCase(), parentNode: null, parentElement: null, childNodes, shadowRoot: null,
            get className() { return attrMap.get('class') || ''; }, set className(v) { attrMap.set('class', String(v)); },
            get childElementCount() { return childNodes.filter(c => c.nodeType === 1).length; },
            get textContent() { return childNodes.map(c => c.textContent).join(''); },
            hasAttribute: k => attrMap.has(k), getAttribute: k => (attrMap.has(k) ? attrMap.get(k) : null),
            setAttribute(k, v) { attrMap.set(k, String(v)); notify({ type: 'attributes', target: this, attributeName: k }); },
            matches: s => s.startsWith('#') ? attrMap.get('id') === s.slice(1) : s.startsWith('.') ? (attrMap.get('class') || '').split(/\s+/).includes(s.slice(1)) : false,
            getRootNode() { return this.parentNode ? this.parentNode.getRootNode() : this; },
            appendChild(c) { c.parentNode = this; c.parentElement = this.nodeType === 1 ? this : null; childNodes.push(c); notify({ type: 'childList', target: this, addedNodes: [c] }); return c; },
            attachShadow() { return (this.shadowRoot = Object.assign(makeEl('#shadow'), { nodeType: 11, host: this })); }
        };
        children.forEach(c => el.appendChild(typeof c === 'string' ? makeText(c) : c));
        return el;
    };
    const docEl = makeEl('html');
    const doc = { nodeType: 9, documentElement: docEl, readyState, addEventListener: (t, fn) => (listeners[t] ||= []).push(fn), emit: t => (listeners[t] || []).forEach(fn => fn()) };
    class MutationObserver { constructor(cb) { this.cb = cb; this.opts = null; observers.push(this); } observe(_t, opts) { this.opts = opts; } }
    return { doc, docEl, observers, NodeConsts, MutationObserver, makeEl, makeText };
}

test('dictionaries & config enforce 3-scope disjoint schema, CRLF, naturalCompare, zero dead keys, and valid rules', () => {
    assert.deepEqual(utils.DICT_FILES, ['menus.json', 'agents.json', 'common.json']);
    const cfg = utils.loadConfig();
    assert.ok(Array.isArray(cfg.fragmentPatterns) && cfg.fragmentPatterns.length > 0);
    assert.ok(cfg.frame && typeof cfg.frame === 'object' && Array.isArray(cfg.frame.rules));
    assert.throws(() => utils.validateConfigSchema({ ...cfg, unknownKey: true }), /未知配置键/);
    assert.throws(() => utils.validateConfigSchema({ ...cfg, blockedTags: {} }), /类型错误/);
    assert.throws(() => utils.validateConfigSchema({ ...cfg, frame: { unknownFrameKey: [] } }), /未知配置键/);

    const seenExact = new Set(), seenLower = new Set();
    for (const df of utils.DICT_FILES) {
        const raw = fs.readFileSync(path.join(utils.DICTS_DIR, df), 'utf8');
        assert.ok(raw.includes('\r\n') && !raw.replace(/\r\n/g, '').includes('\n'), `${df} 必须严格使用 CRLF`);
        const data = JSON.parse(raw);
        const keys = Object.keys(data);
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            assert.notEqual(data[k], k, `${df} 禁止保留 key===value 死键: ${k}`);
            if (i < keys.length - 1) assert.ok(utils.naturalCompare(keys[i], keys[i + 1]) <= 0, `${df} 排序错误: ${keys[i]}`);
            assert.equal(seenExact.has(k), false, `跨文件精确重复键: ${k}`);
            seenExact.add(k);
            const lk = normalizeText(k).toLowerCase();
            assert.equal(seenLower.has(lk), false, `跨文件小写重复键: ${k}`);
            seenLower.add(lk);
        }
    }
    for (const r of [...utils.loadRules(), ...(cfg.frame.rules || [])]) {
        assert.equal(typeof r.pattern, 'string');
        assert.equal(typeof r.replacement, 'string');
        new RegExp(r.pattern, 'i');
    }
    assert.match(utils.getDictsHash(), /^[0-9a-f]{64}$/);
});

test('utils process isolation, ASAR version priority, and reversible patch prologue insertion', () => {
    const exe = 'D:\\Antigravity\\Antigravity.exe';
    const procs = [
        { pid: 100, executablePath: exe, commandLine: `"${exe}"` },
        { pid: 101, executablePath: exe, commandLine: `"${exe}" --type=renderer` },
        { pid: 102, executablePath: exe, commandLine: `"${exe}" --ms-enable-electron-run-as-node worker.js` },
        { pid: 103, executablePath: 'E:\\Other\\Antigravity.exe', commandLine: '"E:\\Other\\Antigravity.exe"' },
        { pid: 104, name: 'chrome.exe', executablePath: 'D:\\Antigravity\\chrome\\chrome.exe' },
        { pid: 105, name: 'Antigravity.exe', executablePath: null }
    ];
    assert.deepEqual(utils.filterBlockingAntigravity(procs, 'D:\\Antigravity\\resources'), [{ pid: 100, isMain: true }, { pid: 101, isMain: false }, { pid: 105, isMain: true }]);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-ver-'));
    try {
        const asarPath = path.join(tmpDir, 'app.asar');
        fs.writeFileSync(asarPath, buildMiniAsar({ 'package.json': JSON.stringify({ version: '2.99.0' }) }));
        assert.equal(asar.getAsarVersion(asarPath), '2.99.0');
        assert.equal(utils.getTargetVersion({ targetVersion: '1.0.0' }, tmpDir), '2.99.0');
        assert.equal(utils.getTargetVersion({ targetVersion: '1.0.0' }, path.join(tmpDir, 'missing')), '1.0.0');
    } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }

    const src = '\uFEFF"use strict";\nconst a = 1;\n';
    const injected = patcher.insertAfterPrologue(src, `${utils.SIGNATURE_START}\n/*p*/\n${utils.SIGNATURE_END}`);
    assert.ok(injected.startsWith('\uFEFF"use strict";\n'));
    assert.equal(utils.cleanInjectedPatches(injected), src);
});

test('asar walkDistJs, ensureAsarFileNode, patchAsarInMemory, and integrity verification roundtrip cleanly', () => {
    const orig = buildMiniAsar({
        'package.json': '{"name":"app","version":"1.2.3"}', 'dist/main.js': '"use strict";console.log(1);',
        'dist/main.test.js': 'test()', 'dist/__mocks__/m.js': 'mock()', 'dist/other.txt': 'hello'
    });
    const parsed = asar.parseAsar(orig);
    assert.equal(JSON.parse(asar.readAsarFile(orig, 'package.json')).version, '1.2.3');
    assert.deepEqual([...asar.walkDistJs(parsed, { stripPrefix: true }).keys()], ['main.js']);
    asar.ensureAsarFileNode(parsed.header, 'dist/nested/new.js');
    assert.throws(() => asar.ensureAsarFileNode(parsed.header, 'dist/main.js/sub.js'), /路径冲突/);

    const patched = asar.patchAsarInMemory(orig, { 'dist/main.js': `${utils.SIGNATURE_START}\n"patched";\n${utils.SIGNATURE_END}` });
    assert.equal(asar.verifyPatchedAsar(patched), true);
    assert.equal(asar.readAsarFile(patched, 'dist/other.txt'), 'hello');
    const tam = Buffer.from(patched); tam[tam.length - 1] ^= 0xff;
    assert.throws(() => asar.verifyPatchedAsar(tam, { 'dist/main.js': asar.parseAsar(patched).getNode('dist/main.js').integrity.hash }), /校验不一致/);
});

test('patcher generates scoped payloads, reversible static templates (idempotent), and isolated origin guards', () => {
    const fakeFiles = {
        'dist/main.js': '"use strict";\nmodule.exports={};', 'dist/preload.js': 'window.__hub=1;',
        'dist/ideInstall/wizardHtml.js': 'const h=`<title>Welcome to Antigravity</title><div>Setting up…</div>`;',
        'dist/provisionSplash.js': 'const s=`<div>Setting up WSL: ${escapeHtml(distro)}</div>`;',
        'dist/wsl.js': "onStatus('Downloading the Antigravity binary\\u2026');onStatus(`Installing into ${distro}\\u2026`);",
        'dist/cablev2.js': 'const p=`<p class="mechanism-header">Use your phone or tablet</p><p id="status" class="mechanism-desc">Scan this QR code with the camera on the device that has your passkey for ${safeRpId}</p>`;'
    };
    const patchMap = patcher.generatePatchMap({ readFile: rel => fakeFiles[rel] || null });
    assert.equal('dist/ideInstall/wizardPreload.js' in patchMap, false);
    assert.deepEqual(Object.keys(patchMap).sort(), Object.keys(fakeFiles).sort());
    assert.ok(patchMap['dist/ideInstall/wizardHtml.js'].includes('欢迎使用 Antigravity'));
    assert.ok(patchMap['dist/provisionSplash.js'].includes('正在配置 WSL：${escapeHtml(distro)}'));
    assert.ok(patchMap['dist/wsl.js'].includes('正在安装到 ${distro}...'));
    assert.ok(patchMap['dist/cablev2.js'].includes('使用手机或平板电脑'));

    const secondMap = patcher.generatePatchMap({ readFile: rel => patchMap[rel] || fakeFiles[rel] || null });
    assert.deepEqual(Object.keys(secondMap).sort(), ['dist/main.js', 'dist/preload.js']);
    assert.equal(secondMap['dist/main.js'], patchMap['dist/main.js']);
    assert.equal(secondMap['dist/preload.js'], patchMap['dist/preload.js']);
    assert.equal(patchMap['dist/preload.js'].includes('"bypassClasses"') && patchMap['dist/preload.js'].includes('"fragmentPatterns"'), true);
    assert.equal(patchMap['dist/preload.js'].includes('"contextOverrides"') || patchMap['dist/preload.js'].includes('"frame":'), false);
    assert.equal(patchMap['dist/main.js'].includes('Archive / Restore'), true);
    assert.equal(patchMap['dist/main.js'].includes('A group with this name already exists.'), false);

    const runGuard = (payload, loc, isTop = false) => {
        let ran = false; const win = { top: isTop ? null : {} }; if (isTop) win.top = win;
        vm.runInNewContext(payload, {
            location: loc, window: win, document: { documentElement: {}, readyState: 'complete', addEventListener() {} },
            Node: { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_FRAGMENT_NODE: 11, DOCUMENT_NODE: 9 },
            MutationObserver: class { observe() { ran = true; } }, console: { error() {} }
        });
        return ran;
    };
    const rPayload = patcher.buildRendererPayload({ OK: '确定' }, [], {}), fPayload = patcher.buildFramePayload({ OK: '确定' }, [], {});
    assert.deepEqual([runGuard(rPayload, { protocol: 'http:', hostname: '127.0.0.1' }, true), runGuard(rPayload, { protocol: 'plugin:', hostname: 'swarm' }, false)], [true, false]);
    assert.deepEqual([
        runGuard(fPayload, { protocol: 'plugin:', hostname: 'swarm' }, false),
        runGuard(fPayload, { protocol: 'http:', hostname: 'localhost' }, false),
        runGuard(fPayload, { protocol: 'http:', hostname: 'localhost' }, true),
        runGuard(fPayload, { protocol: 'https:', hostname: 'evil.example' }, false)
    ], [true, true, false, false]);
});

test('runtime/translator handles normalization, 1-level recursion, rawGroups, caseSensitive, lowerWordsExclude, protection, toolStats, ellipsis & 2048 cache', () => {
    const t = createTranslator(
        { File: '文件', Save: '保存', 'This is a sufficiently long status prefix...': '较长状态前缀译文', 'loading the narrator view': '正在加载旁白视图', 'Resets in <1m': '1 分钟内重置', System: '系统', and: '和', 'readme.md': '自述文件' },
        [
            { pattern: '^overview · (.+)$', replacement: '概览 · $1' },
            { pattern: '^failed \\(no (.+) within (\\d+)s\\)$', replacement: '失败（$2 秒内无 $1）', rawGroups: [1] },
            { pattern: '^(\\d+)m$', replacement: '$1 分钟前', caseSensitive: true },
            { pattern: '^(\\d+[smhd]) limit$', replacement: '$1配额' },
            { pattern: '^(.+?), (resets in .+)$', replacement: '$1，$2' },
            { pattern: '^→ @(.+)$', replacement: '等待 @$1', rawGroups: [1] }
        ],
        { lowerWordsExclude: ['system', 'and'], protectedFiles: ['BUILD.bazel'] }
    );
    assert.equal(normalizeText('  “Hi”\u00A0it’s… '), '"Hi" it\'s...');
    assert.equal(t.translateMenuLabel('&File'), '文件(&F)');
    assert.equal(t.translateString('Save (Ctrl+S)'), '保存 (Ctrl+S)');
    assert.equal(t.translateString('BUILD.bazel'), null);
    assert.equal(t.translateString('C:\\app\\index.js'), null);
    assert.equal(t.translateString('readme.md'), '自述文件');
    assert.equal(t.translateString('system'), null);
    assert.equal(t.translateString('System'), '系统');
    assert.equal(t.translateString('and'), '和');
    assert.equal(t.translateString('And'), null);
    assert.equal(t.translateString('AND'), null);
    assert.equal(t.translateString('1m'), '1 分钟前');
    assert.equal(t.translateString('1M'), null);
    assert.equal(t.translateString('overview · failed (no view.json within 30s)'), '概览 · 失败（30 秒内无 view.json）');
    assert.equal(t.translateString('overview · loading the narrator view'), '概览 · 正在加载旁白视图');
    assert.equal(t.translateString('5h limit, resets in <1m'), '5 小时配额，1 分钟内重置');
    assert.equal(t.translateString('→ @System'), '等待 @System');
    assert.equal(t.translateString('explored 2 files, edited 1 file'), '已探索 2 个文件，已编辑 1 个文件');
    assert.equal(t.translateString('This is a sufficiently...'), '较长状态前缀译文');
    for (let i = 0; i < 2100; i++) t.translateString(`unmapped-${i}`);
    assert.equal(t.translateString('Save'), '保存');
});

test('runtime/dom enforces 3-tier blocking, frozen document, conversation-row guard, fragment rules & ShadowRoot', () => {
    const { doc, docEl, observers, NodeConsts, MutationObserver, makeEl, makeText } = createTinyDom('loading');
    const preBtnText = makeText('Save'), softBtnText = makeText('Save'), softText = makeText('Save');
    const convTitle = makeText('Save'), convAllowed = makeText('Outside of Project'), convLink = makeEl('a', { 'aria-label': 'Save' });
    const fragLeft = makeText('Show '), fragRight = makeText(' more…'), shadowHost = makeEl('div'), shadowText = makeText('Save');
    shadowHost.attachShadow().appendChild(shadowText);

    docEl.appendChild(makeEl('pre', {}, [makeEl('button', {}, [preBtnText])]));
    docEl.appendChild(makeEl('div', { 'data-markdown-root': 'true' }, [makeEl('button', {}, [makeText('Save')])]));
    docEl.appendChild(makeEl('div', { class: 'o2-goal' }, [softText, makeEl('div', { class: 'o2-glbl' }, [softBtnText])]));
    docEl.appendChild(makeEl('div', { 'data-testid': 'conversation-row-1' }, [convTitle, convLink, makeEl('span', {}, [convAllowed])]));
    docEl.appendChild(makeEl('div', {}, [fragLeft, makeEl('span', {}, ['3']), fragRight]));
    docEl.appendChild(shadowHost);

    Object.freeze(doc);
    const translator = createTranslator({ Save: '保存', 'Outside of Project': '项目之外' }, []);
    const cfg = {
        blockedTags: ['PRE'], blockedClasses: ['o2-goal'], blockedClassSubstrings: [], blockedTestIds: [], blockedTestIdSubstrings: [],
        blockedDataAttrs: ['data-markdown-root'], bypassClasses: ['o2-glbl'], bypassRoles: ['button'], codeEditorKeywords: [],
        conversationRowAllowedTexts: ['Outside of Project'],
        fragmentPatterns: [{ containerPattern: '^(?:Show|显示另外)\\s+\\d+\\s+more', nodeReplacements: [
            { match: '^Show\\s*$', replace: '显示另外 ' }, { match: '^\\s*more(\\.\\.\\.|…)?$', replace: ' 个$1', normalizeEllipsis: true }
        ] }]
    };
    vm.runInNewContext(`(${installDomTranslator.toString()})(__t, __c);`, { document: doc, Node: NodeConsts, MutationObserver, __t: translator, __c: cfg, console: { error() {} } });

    assert.equal(docEl._agL10nInstalled, true);
    assert.equal(observers.length, 1);
    assert.equal(observers[0].opts.attributeFilter.includes('class'), false);
    assert.deepEqual([preBtnText.nodeValue, softText.nodeValue, softBtnText.nodeValue, convTitle.nodeValue, convLink.getAttribute('aria-label'), convAllowed.nodeValue, fragLeft.nodeValue, fragRight.nodeValue, shadowText.nodeValue],
        ['Save', 'Save', '保存', 'Save', 'Save', '项目之外', '显示另外 ', ' 个...', '保存']);

    const lateText = makeText('Save');
    docEl.childNodes.push(lateText); doc.emit('DOMContentLoaded');
    assert.equal(lateText.nodeValue, '保存');
    convAllowed.nodeValue = 'Save'; assert.equal(convAllowed.nodeValue, 'Save');
});

test('runtime/main hooks Menu/Tray Proxies, async Dialogs, app.whenReady delay & single-event frame allowlist', async () => {
    const events = [], registeredEvents = new Set(), appListeners = {}, defaultSes = {};
    let appReady = false, resolveReady, clickedLabel;
    const readyPromise = new Promise(r => { resolveReady = r; });
    const makeFrame = (url, opts = {}) => ({ url, parent: opts.parent ?? null, top: opts.top ?? null, detached: false, calls: [], executeJavaScript(c) { this.calls.push(c); return Promise.resolve(); } });
    const makeContents = (frames, opts = {}) => {
        const wcL = {};
        return {
            getType: () => opts.type || 'window', session: opts.session || defaultSes, mainFrame: { url: 'http://127.0.0.1:9000/', framesInSubtree: frames },
            isDestroyed: () => false, on(ev, fn) { registeredEvents.add(ev); (wcL[ev] ||= []).push(fn); },
            once(ev, fn) { (wcL[ev] ||= []).push(fn); }, emit(ev, ...args) { (wcL[ev] || []).forEach(fn => fn(...args)); }
        };
    };

    const pluginSub = makeFrame('plugin://swarm/index.html', { parent: {} }), localTop = makeFrame('http://127.0.0.1:9000/');
    const localSub = makeFrame('http://127.0.0.1:9000/sub', { parent: {}, top: { url: 'http://127.0.0.1:9000/' } });
    const extSub = makeFrame('https://evil.example/sub', { parent: {}, top: { url: 'https://evil.example/' } });
    const preReadyWc = makeContents([pluginSub]), webviewWc = makeContents([makeFrame('plugin://x')], { type: 'webview' }), otherSesWc = makeContents([makeFrame('plugin://x')], { session: {} });
    function Tray() {} Tray.prototype.setContextMenu = () => {};
    const electron = {
        app: { isReady: () => appReady, on(ev, fn) { (appListeners[ev] ||= []).push(fn); }, whenReady: () => readyPromise },
        Menu: { buildFromTemplate(tpl) { events.push(tpl[0].label); return { items: tpl }; }, setApplicationMenu() {} }, Tray,
        dialog: { showMessageBox(_w, opts) { events.push([opts.title, opts.buttons[0]]); return Promise.resolve(); }, showOpenDialog() {}, showErrorBox() {} },
        BrowserWindow: {}, session: { defaultSession: defaultSes }, webContents: { getAllWebContents: () => [] },
        webFrameMain: { fromId: (p, r) => (p === 1 && r === 2 ? localSub : null) }
    };

    installMainHooks(electron, createTranslator({ File: '文件', Quit: '退出', 'Confirm Quit': '确认退出', Cancel: '取消' }, []), '/*FRAME_SCRIPT*/');
    const built = electron.Menu.buildFromTemplate([{ label: '&File', click(item) { clickedLabel = item.label; } }]);
    assert.equal(events[0], '文件(&F)');
    built.items[0].click(built.items[0]); assert.equal(clickedLabel, '&File');

    const liveMenu = { items: [{ label: 'Quit' }] };
    electron.Menu.setApplicationMenu(liveMenu);
    assert.equal(liveMenu.items[0].label, '退出'); assert.ok(liveMenu.items.find(i => i.label === 'Quit'));
    electron.dialog.showMessageBox({}, { title: 'Confirm Quit', buttons: ['Cancel'] });
    assert.deepEqual(events[1], ['确认退出', '取消']);

    appListeners['web-contents-created'].forEach(fn => { fn({}, preReadyWc); fn({}, webviewWc); fn({}, otherSesWc); });
    assert.equal(pluginSub.calls.length, 0);
    appReady = true; resolveReady(); await new Promise(r => setImmediate(r));
    assert.deepEqual([pluginSub.calls.length, webviewWc.mainFrame.framesInSubtree[0].calls.length, otherSesWc.mainFrame.framesInSubtree[0].calls.length], [1, 0, 0]);
    assert.deepEqual([registeredEvents.has('did-frame-finish-load'), registeredEvents.has('frame-created'), registeredEvents.has('did-finish-load')], [true, false, false]);

    preReadyWc.mainFrame.framesInSubtree = [localSub, localTop, extSub];
    preReadyWc.emit('did-frame-finish-load', {}, false, 1, 2);
    assert.deepEqual([localSub.calls.length, localTop.calls.length, extSub.calls.length], [1, 0, 0]);
});

test('inspector extractor accepts real UI copy & filters code/Tailwind, auditor stays read-only & permits regex overrides', () => {
    for (const ok of ['Accept', 'Settings', 'OK', 'Agent ID:', 'All tools (*)', '+ Add Hook', 'Click to return to the previous group.']) {
        assert.equal(extractor.isLikelyUserFacingText(ok), true, `应放行 UI 文案: ${ok}`);
    }
    for (const noise of ['src/utils.js', 'https://example.com', 'C:\\Users\\a\\index.js', 'flex items-center gap-2 bg-zinc-900', 'o2-ti done', 'const x = 1', 'my_label', 'fooBar', 'GET', 'Ctrl+Shift+P']) {
        assert.equal(extractor.isLikelyUserFacingText(noise), false, `应过滤噪声: ${noise}`);
    }
    const uiMap = extractor.extractHighConfidenceUiStrings(`${utils.SIGNATURE_START}\nlabel: "Injected"\n${utils.SIGNATURE_END}\n({ label: "Accept", title: "Agent ID:", className: "flex items-center" })`);
    assert.deepEqual([...uiMap.keys()].sort(), ['Accept', 'Agent ID:']);

    const state = auditor.loadExistingTranslations();
    assert.equal(state.ruleEntries.length, utils.loadRules().length);
    const origLog = console.log; console.log = () => {};
    try {
        const res = auditor.auditAndCleanDictionaries(['Overview', 'Accept'], ['Show 3 files'], {
            loaded: {
                rawByFile: { 'menus.json': { Overview: '概览', 'Show 3 files': '显示 3 个文件' }, 'agents.json': {}, 'common.json': {} },
                ruleEntries: [{ pattern: '^Show \\d+ files$', replacement: '展开 $1 个文件', regex: /^Show \d+ files$/i }],
                rules: [/^Show \d+ files$/i]
            }
        });
        assert.deepEqual([res.redundancies.length, res.deadKeys.length, res.dictHits.length, res.pruned], [0, 0, 1, false]);
        assert.equal(res.dictHits[0].key, 'Show 3 files');
        const realRes = auditor.auditAndCleanDictionaries(['Accept'], [], { loaded: state });
        assert.deepEqual([realRes.redundancies.length, realRes.deadKeys.length, realRes.pruned], [0, 0, false]);
    } finally { console.log = origLog; }
});
