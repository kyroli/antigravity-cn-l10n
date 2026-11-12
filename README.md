# antigravity-cn-l10n

Antigravity（Windows 版）简体中文汉化补丁，通过向客户端 `app.asar` 注入翻译脚本与静态模板替换实现界面中文化。

## 使用方法

需先安装 [Node.js](https://nodejs.org/)。

- **安装汉化**：双击 `安装汉化.bat`
- **还原英文**：双击 `还原英文.bat`

也可以通过命令行运行：

```powershell
node patch.js                                # 安装或更新汉化
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
- `src/asar.js` / `src/patcher.js` / `src/utils.js`：`app.asar` 读写、补丁生成与公共配置/进程管理
- `patch.js` / `sync.js`：命令行安装/还原入口，以及向终端输出增量未覆盖词条与词库校验脚本
