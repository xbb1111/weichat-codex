# weichat-codex

Windows 本机微信到 Codex CLI 的桥接服务。

## 功能概览

`weichat-codex` 把微信/iLink Bot 收到的消息转发给本机 Codex CLI，并把结果回复到微信。它支持快速问答、较长时间的 agent 任务、本地文件发送确认、提醒确认，以及一个只监听 `127.0.0.1` 的本地对话记录页面。

## 交流模式

- 普通消息：快速交流，默认使用 `gpt-5.4-mini`、`low` reasoning 和 `read-only` 沙箱。
- `/cx <任务>`：高能力 agent 模式，默认使用 `gpt-5.5`、`medium` reasoning、`workspace-write` 沙箱和 `on-request` 审批。

常用微信命令：

- `绑定`
- `状态`
- `任务 #id`
- `确认` / `确认 #id`
- `取消` / `取消 #id`
- `提醒我 2026-05-07 09:00 提交材料`
- `从我电脑上找到1个类似于碎屑岩储层表征研究进展的pdf文件，发给我`
- `/cx 帮我查看当前代码运行情况`

## 运行环境

- Windows
- Node.js `>=24.0.0`
- Git，用于 `git clone` 下载项目
- 可在 PowerShell/cmd 中调用的 Codex CLI
- 可用的 OpenAI/ChatGPT/Codex 账号，或已配置的 OpenAI API Key，让 Codex CLI 可以正常调用模型
- 微信/iLink Bot 相关配置，或可扫码完成 QR 登录流程

## 快速开始

下载项目并安装依赖：

```powershell
git clone https://github.com/xbb1111/weichat-codex.git
cd weichat-codex
cmd /c npm install
```

安装并登录 Codex CLI：

```powershell
npm install -g @openai/codex
codex --version
codex --login
```

如果使用 API Key 方式认证，也可以按你的 Codex CLI 配置方式设置 OpenAI API Key。关键要求是：在当前 PowerShell/cmd 里运行 `codex --version` 能正常输出版本，并且 `codex` 已经能访问模型。

首次启动建议使用前台模式，终端会显示 QR 登录信息：

```powershell
cmd /c npm start
```

扫码登录成功后，在微信里发送：

```text
绑定
```

确认前台模式能正常收发消息后，关闭前台服务，再安装后台计划任务：

```powershell
cmd /c npm run start:background
cmd /c npm run status
```

后台模式会隐藏运行，适合长期挂着；以后登录 Windows 后会自动启动。首次登录不要直接用后台模式，因为隐藏任务看不到 QR 码。

如果只是在本机调试，可以一直使用：

```powershell
cmd /c npm start
```

## 从 0 部署检查清单

部署前逐项确认：

- `node --version` 输出 `24.0.0` 或更高版本。
- `git --version` 能正常输出版本。
- `codex --version` 能正常输出版本。
- `codex --login` 已完成，或 OpenAI API Key 已按 Codex CLI 要求配置好。
- `cmd /c npm install` 已在项目目录执行成功。
- `cmd /c npm start` 能显示微信 QR 登录信息，或环境变量里已经配置 `WEIXIN_BASEURL` / `WEIXIN_BOT_TOKEN` / `WEIXIN_ILINK_BOT_ID`。
- 微信扫码登录后，已在微信里发送 `绑定`。
- 前台模式确认能收发消息后，再执行 `cmd /c npm run start:background`。
- `cmd /c npm run status` 能看到 `weichat-codex` 计划任务状态。

## 本地对话窗口

服务启动后会在本机打开 transcript API 和网页：

```text
http://127.0.0.1:17878
```

这个页面显示微信收到的消息、Bot 回复、任务开始/完成、文件发送记录。只监听 `127.0.0.1`，默认不会暴露到局域网。

## 前台调试

```powershell
cmd /c npm start
```

前台调试依赖当前终端窗口；终端关闭后，微信桥接服务也会停止。长期使用请安装后台计划任务。

如果需要读取 `HTTP_PROXY` / `HTTPS_PROXY`：

```powershell
cmd /c npm run start:proxy
```

## 后台运行

安装登录自启计划任务，并立即在后台启动服务：

```powershell
cmd /c npm run start:background
```

兼容命令：

```powershell
cmd /c npm run start:background-install
```

查看后台任务状态：

```powershell
cmd /c npm run status
```

如果输出 `Scheduled task not found: weichat-codex`，说明还没有安装后台计划任务。先用 `cmd /c npm start` 前台调试；确认可用后再运行 `cmd /c npm run start:background-install`。

如果 `State` 是 `Ready` 且 `LastTaskResult` 是 `1`，说明后台任务启动后失败退出。先查看最近日志：

```powershell
Get-Content .\logs\weichat-codex.log -Tail 80
```

首次登录建议先用 `cmd /c npm start` 在前台完成 QR 扫码；后台隐藏任务看不到二维码。确认前台可连接后再启动后台任务。Node.js 的实验性 warning 会写入日志，但不会单独导致后台任务失败。

卸载后台任务：

```powershell
cmd /c npm run start:background-remove
```

后台日志写入：

```text
logs\weichat-codex.log
```

`logs/` 是本地运行日志目录，默认不会提交到 git。

## 配置

默认值在 `scripts/start-hidden.ps1` 中设置，也可以通过环境变量覆盖：

- `CODEX_CMD`
- `DEFAULT_WORKDIR`
- `WEIXIN_STATE_PATH`
- `QUICK_MODEL`
- `AGENT_MODEL`
- `QUICK_REASONING_EFFORT`
- `AGENT_REASONING_EFFORT`
- `QUICK_SANDBOX`
- `AGENT_SANDBOX`
- `CODEX_APPROVAL_POLICY`
- `QUICK_TIMEOUT_MS`，普通消息的 Codex 执行超时，默认 `180000`。
- `AGENT_TIMEOUT_MS`，`/cx` agent 任务的 Codex 执行超时，默认 `900000`。
- `MAX_WECHAT_REPLY_CHARS`，微信单条回复分片长度，默认 `1800`。
- `WECHAT_CODEX_DIAGNOSTICS=1`，Codex 超时/失败时附带命令、stderr 等详细诊断；默认只返回简短原因。
- `WECHAT_CODEX_WEB_PORT`
- `WECHAT_FILE_SEARCH_ROOTS`，多个目录用英文分号 `;` 分隔
- `OWNER_USER_ID`

如果没有 `WEIXIN_BASEURL` / `WEIXIN_BOT_TOKEN` / `WEIXIN_ILINK_BOT_ID`，服务会进入 QR 登录流程，并把 bot session 保存到 `state\bridge.sqlite`。

普通消息默认最多等待 3 分钟；复杂联网查询、论文检索或代码任务建议使用 `/cx`，默认最多等待 15 分钟。最终回复超过 `MAX_WECHAT_REPLY_CHARS` 时会自动拆成多条微信消息，任务记录仍保存完整结果。

## 安全说明

这是一个本机桥接服务。公开仓库前请确认不要提交以下内容：

- `WEIXIN_BOT_TOKEN`、`.env` 或其他凭据
- `state/bridge.sqlite`
- `state/codex-last-message-*.txt`
- `logs/`
- 真实聊天记录、本机私有路径或未脱敏的用户信息

仓库中的 `.gitignore` 已默认排除 `state/`、`logs/`、`.env` 和日志文件。`state/bridge.sqlite` 保存登录 session 和运行状态，只应留在本机。

## 测试

运行全部测试：

```powershell
cmd /c npm test
```

运行语法检查：

```powershell
cmd /c npm run check
```

当前测试入口使用 Node.js 的 `--experimental-strip-types` 直接运行 TypeScript 测试文件。

## License

MIT
