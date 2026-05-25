# TeamMCP Dev Server — port 3200, isolated data
# Dual-process architecture: PTY Daemon (Layer 1) + HTTP Server (Layer 2)
$env:TEAMMCP_HOME = "C:/Users/ssdlh/Desktop/teammcp-dev"
$env:TEAMMCP_PORT = "3200"
$env:AGENTS_BASE_DIR = "C:/Users/ssdlh/Desktop/agents-dev"
$env:TEAMMCP_URL = "http://localhost:3200"
$env:TEAMMCP_BIND_HOST = "127.0.0.1"
$env:TEAMMCP_AUTO_RESTART = "1"
$env:TEAMMCP_INTERNAL_SECRET = '462a599b71d9a7f7db4e6ce3c393305b295105b58ae5a0bbafe4a92e3ca4da29'

# Phase 4-T1 dev validation: route agent PTYs through pty-daemon (Layer 1).
# Server boot fails loud if daemon doesn't come up — investigate daemon-launcher
# logs first. To roll back to local pty.spawn behaviour, comment this line out.
$env:TEAMMCP_PTY_DAEMON = "on"

Set-Location "C:/Users/ssdlh/Desktop/teammcp-code-dev"

# ── PTY Daemon (Layer 1, Dev) ───────────────────────────────
# Dev daemon uses separate pipe/pid paths (teammcp-pty-dev-{uid}).
# Daemon is managed by daemon-launcher.mjs inside index.mjs.

node server/index.mjs
