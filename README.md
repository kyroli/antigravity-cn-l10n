# antigravity-cn-l10n

Antigravity（Windows 版）简体中文汉化补丁，通过向客户端 `app.asar` 注入翻译脚本实现界面中文化。

## 使用方法

需先安装 [Node.js](https://nodejs.org/)。

- **安装汉化**：双击 `安装汉化.bat`
- **还原英文**：双击 `还原英文.bat`

也可以通过命令行运行：

```powershell
node patch.js                                # 安装或更新汉化
node patch.js --restore                      # 还原官方原版
node patch.js --install-dir D:\Antigravity   # 手动指定安装路径
```

## 维护与开发

客户端版本更新后，运行同步脚本提取新增文本并检查词典重复或失效项：

```powershell
node sync.js          # 提取版本差集并清理废弃词条
node sync.js --audit  # 扫描存量未翻译的 UI 属性文本
npm test              # 运行测试
```

## 目录说明

- `dicts/*.json`：静态翻译词典（`common`、`menus`、`agents`、`settings`、`workspaces`、`marketplace`、`knowledge`）
- `dicts/rules.json`：带变量文本的正则替换规则
- `dicts/config.json`：不参与翻译的 DOM 标签、类名与文件名配置
- `src/runtime/`：注入到主进程与渲染进程的运行时脚本（`translator.js`、`main.js`、`dom.js`）
- `src/inspector/`：版本差集提取与词典检查脚本（`unpacker.js`、`extractor.js`、`auditor.js`）
- `src/asar.js` / `src/patcher.js`：`app.asar` 读写与补丁注入
