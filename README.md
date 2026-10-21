# AgentSwitcher

一个类似 JetBrains Toolbox 的纯客户端 Codex 配置切换器。基于 Electron、React 和 TypeScript，支持 Windows 托盘和 macOS 菜单栏；点击图标时，在点击所在屏幕的图标附近打开面板，并限制在该屏幕的可用区域内。点击其他位置会保持面板打开，点击关闭按钮或再次点击同屏托盘图标才收起；收起后继续驻留。

## 下载安装

从 [GitHub Releases](https://github.com/TedGillXD/AgentSwitcher/releases/latest) 下载对应平台的安装包：

| 设备 | 安装包 |
| --- | --- |
| Windows Intel / AMD | `AgentSwitcher-版本-win-x64.exe` |
| Windows ARM64 | `AgentSwitcher-版本-win-arm64.exe` |
| macOS Intel | `AgentSwitcher-版本-mac-x64.dmg` |
| macOS Apple Silicon（M 系列） | `AgentSwitcher-版本-mac-arm64.dmg` |

macOS 安装包要求 macOS 13 或更新版本，同时提供 ZIP 包。安装前请退出旧版 AgentSwitcher。当前版本未配置 Windows 代码签名和 Apple Developer 签名/公证；macOS 的系统检查可能需要在“系统设置 → 隐私与安全性”中确认打开此应用。每个 Release 提供 `SHA256SUMS.txt` 校验文件。

## 功能

- 主面板快速切换 ChatGPT 登录和多套 API 配置，并重新启动 Codex；正常退出超时后可强制终止。
- 独立的配置管理窗口，支持新增、编辑、删除配置。内置 DeepSeek、GLM、Kimi 模板，也支持自定义名称、API 地址和 API Key。
- 自动读取服务商模型列表，每套配置可选择多个模型和默认模型；高级选项可以手动填写模型及接口协议。
- 密钥由 Windows DPAPI / macOS Keychain 提供的 Electron `safeStorage` 加密，仅存本机；不会返回给界面，不写入 `localStorage` 或 Codex 配置。
- 简体中文 / English，语言持久化；支持开机启动和托盘菜单切换。Windows 面板靠近托盘、macOS 面板位于菜单栏图标下方，支持多屏及不同缩放比例。
- 保留配置注释、MCP、项目权限及其他无关设置；加密保存恢复信息、原子写入、检测外部编辑冲突，失败回滚，启动时恢复未完成事务。

AgentSwitcher 提供本机凭证代理，绑定 `127.0.0.1`，不同配置切换时更换随机令牌。Codex 的配置中保存的是该本机令牌，各配置的真实 API Key 分别加密保存，仅由主进程解密。请求直接从本机发往设置的服务商，无自建云端服务、账号系统、遥测或同步。

支持原生 Responses API 和 OpenAI 兼容 Chat Completions。自动检测模式先请求 Responses，仅在服务商明确返回 404、405 或 501 时适配 Chat Completions；认证、限流和服务器错误不会重试另一种协议。已知只支持 Chat Completions 的地址可在高级选项直接指定协议。

## 开发与运行

需要 Node.js 22.16+（建议 24）及 pnpm 11.25.0。

```sh
pnpm install
pnpm dev
```

首次运行 Electron 会下载平台二进制文件。仅预览界面可使用 `pnpm dev:ui`；浏览器预览会明确标注，桌面操作不可用。

```sh
pnpm test                 # 配置、存储、进程和本机 HTTP 代理测试
pnpm build                # 类型检查与生产构建
pnpm test:electron        # 真实 Electron / IPC / 系统加密烟测，需先 build
pnpm test:force-stop      # Windows：仅强制结束独立临时测试进程，需 Node 24
pnpm pack:dir             # 当前平台可运行目录
pnpm dist:win             # Windows x64 + ARM64 NSIS 安装包
pnpm dist:mac             # macOS Intel + Apple Silicon DMG / ZIP
```

产物位于 `release/`。Windows 包在 Windows 构建，macOS 包在 macOS 构建。仓库提供 GitHub Actions 双平台构建流程；正式分发可通过 electron-builder 的 `CSC_LINK` / `CSC_KEY_PASSWORD` 配置签名，macOS 公证另需 Apple 凭证。当前源码不包含签名证书或公证配置。

版本发布由 `.github/workflows/release.yml` 管理：先更新 `package.json` 的版本，再创建并推送同名的 `v版本` 标签，例如 `v0.2.1`。Windows、Intel Mac 和 Apple Silicon Mac 的构建与检查全部成功后，发布流程才会上传安装包并公开 Release；日常构建不发布版本。发布使用仓库内置的 `GITHUB_TOKEN`，无需另存个人访问令牌。

## 使用

1. 安装并至少启动一次 Codex 桌面应用。如果使用 ChatGPT，请先在 Codex 内完成原生登录。
2. 点击“管理配置”打开独立窗口，选择“新增配置”。可选择 GLM、Kimi、DeepSeek 模板，或直接填写自定义 API 地址和 API Key；名称可选，保存时会查询地址下的 `/models`。不同账号、不同地址可分别保存为多套配置。
3. 如需核对模型，点击“测试并发现模型”；在“高级选项”选择默认模型或手动填写模型列表。服务商不提供模型列表时，官方模板可使用内置模型；自定义地址需要手动填写模型 ID。地址可填写 API 根路径，末尾的 `/responses`、`/chat/completions`、`/models` 会自动去除。
4. 自动识别传统 Codex 和新版使用 `ChatGPT.exe` / `ChatGPT.app` 的桌面应用；如未检测到，请在配置管理窗口的“通用设置”选择对应应用。
5. 在主面板选择配置并确认重启。先尝试正常退出，5 秒内未退出时强制终止桌面进程；运行中的任务会中断，未保存工作可能丢失，请先保存工作。切回 ChatGPT 会复用现有登录；尚未登录时由 Codex 自己完成登录。

默认使用 `$CODEX_HOME`，否则使用 `~/.codex`。全局配置也会影响共用此目录的 CLI / IDE。程序不会修改 `auth.json`，也不会读取或重写操作系统中的 Codex 登录凭证。切换到 ChatGPT 会设置 `forced_login_method = "chatgpt"`，避免静默使用 OpenAI API 计费。

API 模式下需要保持 AgentSwitcher 驻留。主动退出会提示连接中断，重新打开后恢复原端口；如果端口被其他程序占用会报告错误。编辑或删除正在使用的配置前，请先切到 ChatGPT 或另一套配置。测试连接和自动发现仅查询模型目录，不发送推理请求。关闭配置管理窗口会隐藏窗口并保留未保存草稿；有未保存改动时，切到其他配置会提示确认丢弃。

0.2.1 起不再失焦收起主面板，旧版启用过此选项的设置也会自动按新行为处理，已有配置和加密密钥保持不变。屏幕分辨率或缩放变化时只调整面板位置，不会抢回其他应用的焦点。

升级到 0.2.0 后，原有 DeepSeek 配置和加密密钥会迁移保留，无需重新输入。每套配置拥有独立的模型目录；在 Codex 内可选择该配置启用的模型，代理按每次请求的模型转发。原有 DeepSeek 的 Flash 和 Pro 会继续同时显示。如果你指定了其他模型目录文件，应用会保留该文件。

## 实现与验证边界

- Windows 同时检测常规安装和 Microsoft Store 安装，只匹配桌面进程的完整路径，排除独立 CLI 与 Electron 子进程。用户确认切换或重启后，正常退出超时会重新核对进程路径，再对剩余桌面主进程使用 `taskkill /PID ... /T /F`；不会按进程名称批量结束。macOS 对目标主进程先发送 SIGTERM，超时后发送 SIGKILL，通过 LaunchServices 启动。强制终止后仍未退出时中止切换，保留原配置。
- 启动时自动恢复未完成事务只尝试正常退出，不会在后台强制终止桌面应用。
- 如启动时自动恢复因桌面程序拒绝正常退出而失败，请先手动退出桌面程序，再重新打开 AgentSwitcher；未完成的恢复日志会保留。
- Microsoft Store 激活无法可靠传递自定义 `CODEX_HOME`，初版因此只支持该安装方式的默认 `~/.codex`。需要自定义目录时使用常规桌面安装。
- 模型目录要求 Codex 0.144.0 或更新版本；模型能力和支持范围以服务商及客户端版本为准。DeepSeek 使用对应模型元数据；其他配置采用保守的文本能力描述。代理仅允许当前配置启用的模型，不会静默替换模型。
- Chat Completions 适配支持文本、图片、函数工具、自定义工具和流式事件。服务商原生托管工具、加密历史、`previous_response_id` 和部分文件/音频输入无法通过通用适配表达时会明确报错。初版关闭内置网页搜索；不能保证所有仅提供地址和密钥的服务都实现 Codex 需要的完整工具能力。
- 内联 TOML 表中不能安全增删的目标字段会返回格式错误，不覆盖原配置。首次切换前可打开配置目录，手动将这些目标字段改为常规表。
- 自动恢复只会在当前文件与事务写入版本一致时执行；外部编辑产生冲突时保留文件并报错。完整恢复日志在应用数据目录的加密 `settings.json` 内。
- 开机启动仅在打包安装后可用。系统加密不可用或已有密钥不能解密时，程序保留密文并阻止覆盖。
- 自动化测试使用临时目录、模拟 Codex 进程及本地 HTTP 服务；Electron 烟测仅检查真实 IPC、界面和系统加密，不会退出你正在使用的 Codex，也不会调用付费模型。Windows/macOS 真机的登录、实际服务商请求与代码签名分发仍需对应环境验收。

## 目录

```text
electron/              托盘、IPC、配置事务、系统存储
electron/platform/     Windows / macOS 进程适配
electron/bridge/       本机 Responses API 凭证代理
renderer/              React 双语界面
shared/                主进程 / 界面类型契约
tests/                 配置、存储、代理、事务和进程测试
scripts/               图标生成、真实 Electron 烟测
```

配置依据：[OpenAI 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)、[OpenAI 登录与凭证存储](https://learn.chatgpt.com/docs/auth)、[DeepSeek 官方 Codex 集成](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/)、[GLM 官方 Codex 集成](https://docs.bigmodel.cn/cn/coding-plan/tool/codex)、[Kimi 官方 Codex 集成](https://platform.kimi.ai/docs/guide/codex-kimi)。模板地址和模型可随时在配置管理中修改，请使用与你的服务商账号和套餐匹配的接口。

## English

AgentSwitcher is a local desktop tray utility for Windows and macOS. Switch Codex between ChatGPT sign-in and multiple API configurations, then restart Codex. A separate configuration window manages DeepSeek, GLM, Kimi and custom providers, each with its own URL, encrypted key and model list. It includes Chinese and English UI, model discovery, conflict detection, atomic updates, rollback and crash recovery.

Run `pnpm install && pnpm dev`. Build with `pnpm build`, run tests with `pnpm test`, and package on the target OS using `pnpm dist:win` or `pnpm dist:mac`. Output goes to `release/`. Keep AgentSwitcher running while an API profile is active; switch away before editing it. Existing ChatGPT credentials are reused without editing the native credential cache. Finish running Codex tasks before switching.

The loopback proxy forwards native Responses API requests or adapts them to OpenAI-compatible Chat Completions. Automatic model discovery uses `/models`; custom services without discovery require manual model IDs. Your actual key is never written to Codex configuration or renderer storage. There is no AgentSwitcher cloud service. Platform login, real provider inference and signed distribution require acceptance testing on each target OS.
