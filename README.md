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

## 维护与开发

客户端版本更新后，运行同步脚本提取新增文本并检查词典重复或失效项：

```powershell
node sync.js                    # 提取新增文本至 dicts/new_to_translate.json（无待译词条时推进基线）
node sync.js --audit            # 只读执行覆盖率与词库健康审计（不写盘）
node sync.js --prune            # 显式清理已失效的静态词条
node sync.js --update-snapshot  # 强制更新基线快照
npm test                        # 运行测试
```

## 目录说明

- `dicts/*.json`：分域静态词典（`menus.json` 主进程、`agents.json` Swarm/Agent 子帧、`common.json` 主界面）
- `dicts/rules.json`：带变量文本的正则替换规则
- `dicts/config.json`：主界面与 `frame` 子帧的保护区选择器、文件名与碎片模式配置
- `src/runtime/`：注入到主进程与渲染进程的运行时脚本（`translator.js`、`main.js`、`dom.js`）
- `src/inspector/`：版本差集提取与词典检查脚本（`unpacker.js`、`extractor.js`、`auditor.js`）
- `src/asar.js` / `src/patcher.js` / `src/utils.js`：`app.asar` 读写、补丁生成与公共配置/进程管理
