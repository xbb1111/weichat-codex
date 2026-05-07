$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $ProjectRoot 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

Set-Location $ProjectRoot

if (-not $env:CODEX_CMD) {
  $env:CODEX_CMD = 'codex'
}
if (-not $env:DEFAULT_WORKDIR) {
  $env:DEFAULT_WORKDIR = 'C:\Users\UPC\Documents\Codex'
}
if (-not $env:WEIXIN_STATE_PATH) {
  $env:WEIXIN_STATE_PATH = Join-Path $ProjectRoot 'state\bridge.sqlite'
}
if (-not $env:QUICK_MODEL) {
  $env:QUICK_MODEL = 'gpt-5.4-mini'
}
if (-not $env:AGENT_MODEL) {
  $env:AGENT_MODEL = 'gpt-5.5'
}
if (-not $env:QUICK_REASONING_EFFORT) {
  $env:QUICK_REASONING_EFFORT = 'low'
}
if (-not $env:AGENT_REASONING_EFFORT) {
  $env:AGENT_REASONING_EFFORT = 'medium'
}
if (-not $env:QUICK_SANDBOX) {
  $env:QUICK_SANDBOX = 'read-only'
}
if (-not $env:AGENT_SANDBOX) {
  $env:AGENT_SANDBOX = 'workspace-write'
}
if (-not $env:CODEX_APPROVAL_POLICY) {
  $env:CODEX_APPROVAL_POLICY = 'on-request'
}
if (-not $env:QUICK_TIMEOUT_MS) {
  $env:QUICK_TIMEOUT_MS = '180000'
}
if (-not $env:AGENT_TIMEOUT_MS) {
  $env:AGENT_TIMEOUT_MS = '900000'
}
if (-not $env:MAX_WECHAT_REPLY_CHARS) {
  $env:MAX_WECHAT_REPLY_CHARS = '1800'
}
if (-not $env:WECHAT_CODEX_WEB_PORT) {
  $env:WECHAT_CODEX_WEB_PORT = '17878'
}

$LogPath = Join-Path $LogDir 'weichat-codex.log'
$NodeExe = 'C:\Program Files\nodejs\node.exe'

"[$(Get-Date -Format o)] starting weichat-codex from $ProjectRoot" | Out-File -FilePath $LogPath -Encoding UTF8 -Append
& $NodeExe --experimental-strip-types src/index.ts *>> $LogPath
