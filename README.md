# antigravity-cn-l10n

Antigravity（Windows 版）简体中文汉化补丁，通过向客户端 `app.asar` 注入翻译脚本与静态模板替换实现界面中文化。

## 使用方法

需先安装 [Node.js](https://nodejs.org/)。

- **安装 / 更新汉化**：点击下载 [Antigravity-L10n.bat](https://github.com/kyroli/antigravity-cn-l10n/releases/download/launcher/Antigravity-L10n.bat)（数据自动收拢至 `antigravity-cn\`）或克隆完整仓库后双击 `Antigravity-L10n.bat`
- **还原英文**：双击 `Antigravity-Restore.bat`（单文件版位于 `antigravity-cn\` 内）

也可以通过命令行运行：

```powershell
node patch.js                                # 检查更新并安装或更新汉化
node patch.js --no-update                    # 跳过更新检查
node patch.js --restore                      # 还原官方原版
node patch.js --install-dir D:\Antigravity   # 手动指定安装路径
node patch.js --no-kill                      # 跳过自动关闭客户端进程
```

## 目录说明

- `dicts/*.json`：分域静态词典（`menus.json` 主进程、`agents.json` Swarm/Agent 子帧、`common.json` 主界面）
- `dicts/rules.json`：带变量文本的正则替换规则
- `dicts/config.json`：主界面与 `frame` 子帧的保护区选择器、文件名与碎片模式配置
- `src/runtime/`：注入到主进程与渲染进程的运行时脚本（`translator.js`、`main.js`、`dom.js`）
- `src/inspector/`：版本差集提取与词典检查脚本（`unpacker.js`、`extractor.js`、`auditor.js`）
- `src/asar.js` / `src/patcher.js` / `src/updater.js` / `src/utils.js`：`app.asar` 读写、补丁生成、云端更新与公共工具
- `manifest.json` / `patch.js` / `sync.js`：云端文件清单、安装/还原入口与词库校验脚本
