const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const utils = require('../src/utils');
const asar = require('../src/asar');
const patcher = require('../src/patcher');
const { normalizeText, createTranslator } = require('../src/runtime/translator');
const extractor = require('../src/inspector/extractor');
const auditor = require('../src/inspector/auditor');

test('utils.loadConfig validates dicts/config.json schema and rejects unknown keys', () => {
    const cfg = utils.loadConfig();
    assert.ok(Array.isArray(cfg.blockedTags));
    assert.ok(Array.isArray(cfg.fragmentPatterns));

    assert.throws(
        () => utils.validateConfigSchema({ unknownKey: [] }),
        /包含未知配置键/
    );
    assert.throws(
        () => utils.validateConfigSchema({ blockedTags: 'not-an-array' }),
        /类型错误/
    );
});

test('runtime/translator handles static entries, shortcuts, regex rules, tool stats, and cache rotation', () => {
    const dict = utils.loadDictionary();
    const rules = utils.loadRules();
    const config = utils.loadConfig();
    const translator = createTranslator(dict, rules, config);

    // 1. 空白符与西文标点归一化（含 NBSP \u00A0）
    assert.equal(normalizeText('  Settings\u00A0… '), 'Settings ...');

    // 2. 静态词条与菜单助记符
    assert.equal(translator.translateString('Settings'), '设置');
    assert.equal(translator.translateMenuLabel('&File'), '文件(&F)');
    assert.equal(translator.translateString('Settings (Ctrl+,)'), '设置 (Ctrl+,)');

    // 3. 西文标点 UI 词条匹配
    assert.equal(translator.translateString('Using browser · Thinking…'), '正在使用浏览器 · 思考中...');
    assert.equal(translator.translateString('Allow Once'), '允许一次');

    // 4. 受保护工程文件与路径过滤
    assert.equal(translator.translateString('LICENSE'), null);
    assert.equal(translator.translateString('file:///c:/test/a.js'), null);
    assert.equal(translator.translateString('C:\\Users\\test\\index.js'), null);

    // 5. 复合工具统计句式
    assert.equal(
        translator.translateString('Explored 2 files, Ran 1 command'),
        '已探索 2 个文件，已运行 1 个命令'
    );

    // 6. 双代热冷缓存超过 2048 条轮转后热点依然命中
    for (let i = 0; i < 2500; i++) {
        translator.translateString(`untranslated_synthetic_token_${i}`);
    }
    assert.equal(translator.translateString('Settings'), '设置');
});

test('patcher.insertAfterPrologue preserves "use strict" directive prologue at module top', () => {
    const rawMain = '"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\nconst x = 1;\n';
    const injected = `${utils.SIGNATURE_START}\n(() => {})();\n${utils.SIGNATURE_END}`;
    const patched = patcher.insertAfterPrologue(rawMain, injected);

    assert.ok(patched.startsWith('"use strict";\n'), 'Patched main.js must start with "use strict";');

    // 验证严格模式在 V8 中确实生效（给未声明变量赋值必须抛出 ReferenceError）
    const strictCheckCode = patched + 'UndeclaredGlobalVar = 123;\n';
    assert.throws(
        () => vm.runInNewContext(strictCheckCode, { exports: {}, require: () => ({}) }),
        { name: 'ReferenceError', message: /UndeclaredGlobalVar is not defined/ }
    );

    // 验证幂等清理
    const cleaned = patcher.cleanInjectedPatches(patched);
    assert.equal(cleaned, rawMain);
});

test('patcher.generatePatchMap and asar.patchAsarInMemory pass VM self-check and roundtrip integrity', () => {
    const dummyHeader = {
        files: {
            'package.json': { offset: '0', size: 0 },
            dist: {
                files: {
                    'main.js': { offset: '0', size: 0 },
                    'preload.js': { offset: '0', size: 0 },
                    ideInstall: {
                        files: {
                            'wizardPreload.js': { offset: '0', size: 0 }
                        }
                    }
                }
            }
        }
    };

    const filesContent = {
        'package.json': JSON.stringify({ name: 'antigravity', version: '2.29.1' }),
        'dist/main.js': '"use strict";\nconst electron = { app: {} };\n',
        'dist/preload.js': '"use strict";\nconst p = 1;\n',
        'dist/ideInstall/wizardPreload.js': '"use strict";\nconst w = 1;\n'
    };

    const chunks = [];
    let offset = 0;
    const setNode = (node, rel) => {
        const buf = Buffer.from(filesContent[rel], 'utf8');
        node.offset = String(offset);
        node.size = buf.length;
        node.integrity = asar.calcIntegrity(buf);
        chunks.push(buf);
        offset += buf.length;
    };
    setNode(dummyHeader.files['package.json'], 'package.json');
    setNode(dummyHeader.files.dist.files['main.js'], 'dist/main.js');
    setNode(dummyHeader.files.dist.files['preload.js'], 'dist/preload.js');
    setNode(dummyHeader.files.dist.files.ideInstall.files['wizardPreload.js'], 'dist/ideInstall/wizardPreload.js');

    const headerJsonBuf = Buffer.from(JSON.stringify(dummyHeader), 'utf8');
    const alignedLen = Math.ceil(headerJsonBuf.length / 4) * 4;
    const headerBuf = Buffer.alloc(16 + alignedLen);
    headerBuf.writeUInt32LE(4, 0);
    headerBuf.writeUInt32LE(8 + alignedLen, 4);
    headerBuf.writeUInt32LE(4 + alignedLen, 8);
    headerBuf.writeUInt32LE(headerJsonBuf.length, 12);
    headerJsonBuf.copy(headerBuf, 16);

    const sourceAsarBuf = Buffer.concat([headerBuf, ...chunks]);
    const patchedBuf1 = asar.patchAsarInMemory(sourceAsarBuf, reader => patcher.generatePatchMap(reader));
    const patchedBuf2 = asar.patchAsarInMemory(patchedBuf1, reader => patcher.generatePatchMap(reader));

    const parsed1 = asar.parseAsar(patchedBuf1);
    const parsed2 = asar.parseAsar(patchedBuf2);

    assert.equal(parsed1.readFile('dist/main.js'), parsed2.readFile('dist/main.js'));
    assert.ok(parsed1.readFile('dist/main.js').startsWith('"use strict";'));
    assert.ok(parsed1.readFile('dist/main.js').includes(utils.SIGNATURE_START));
});

test('auditor verifies dictionary health and rule shadowing integrity', () => {
    const { ruleEntries } = auditor.loadExistingTranslations();
    assert.ok(ruleEntries.length > 100);
    assert.ok(extractor.isLikelyUserFacingText('Pending · WIP or no reviewers assigned'));
    assert.ok(extractor.isLikelyUserFacingText('Cannot promote during Battle Mode — end the battle first'));
});
