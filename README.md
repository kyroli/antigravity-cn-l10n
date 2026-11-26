# antigravity-cn-l10n

Antigravity（Windows 版）简体中文汉化补丁，基于 `app.asar` 运行时注入、本地 `/main.js` 静态改写代理与静态模板替换实现界面汉化。

## 使用方法

需先安装 [Node.js](https://nodejs.org/)。

- **安装 / 更新**：下载 [Antigravity-L10n.bat](https://github.com/kyroli/antigravity-cn-l10n/releases/download/launcher/Antigravity-L10n.bat)（数据收拢至 `antigravity-cn\`），或克隆仓库后双击运行
- **还原英文**：双击 `Antigravity-Restore.bat`（单文件版位于 `antigravity-cn\` 内）

命令行用法：

```powershell
node patch.js                                # 检查更新并安装/更新汉化
node patch.js --no-update                    # 跳过更新检查
node patch.js --restore                      # 还原官方原版
node patch.js --install-dir D:\Antigravity   # 指定安装目录
node patch.js --no-kill                      # 不自动关闭客户端进程

npm run sync                                 # 扫描客户端资产并同步基线
npm run audit                                # 只读审计覆盖率、存活性与重写质量门禁
npm run prune-dead                           # 清理未命中的历史词条与规则
npm run manifest                             # 重新生成 manifest.json
```

## 目录说明

- `dicts/`：静态词典（`menus.json` / `agents.json` / `common.json`）、正则规则（`rules.json`）、多子节点槽位模板（`fragments.json`）及保护区/特例配置（`config.json`）
- `src/runtime/`：注入主进程与渲染进程的运行时脚本与 `/main.js` 静态改写代理
- `src/inspector/`：客户端资产解包、文本提取与质量审计模块
- `src/` 与根目录：ASAR 补丁构建、槽位编译（`fragmentCompiler.js`）、云端更新（`manifest.json`）及 CLI 入口（`patch.js`、`sync.js`）
