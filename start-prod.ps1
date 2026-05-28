# TeamMCP Prod Server — port 3100, production data
# Dual-process architecture: PTY Daemon (Layer 1) + HTTP Server (Layer 2)
$env:TEAMMCP_HOME = "C:/Users/ssdlh/Desktop/teammcp"
$env:TEAMMCP_PORT = "3100"
$env:AGENTS_BASE_DIR = "C:/Users/ssdlh/Desktop/agents"
$env:TEAMMCP_URL = "http://localhost:3100"
$env:TEAMMCP_AUTO_RESTART = "0"

# codex-pty runtime: codex.exe lives inside the npm @openai/codex platform
# package, not on PATH. The daemon needs it on the cmd allowlist.
$env:TEAMMCP_CMD_ALLOWLIST_EXTRA = "C:\Users\ssdlh\AppData\Roaming\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe"

# Memory engine + retention sweep ENABLED for Gate 1 soak (CEO unblock 2026-04-25).
# Pre-conditions met: G1.C dedup剥离 + BLOCK 1 retention.mjs §3 8-class severity='error'
# + BLOCK 2 watchdog rollback_history + 7 retention policies registered + watchdog auto-start.
# Rollback: set MEMORY_ENGINE='off' or RETENTION_SWEEP='0' or WATCHDOG_DISABLED='1'.
$env:MEMORY_ENGINE = "on"
$env:RETENTION_SWEEP = "1"

Set-Location "C:/Users/ssdlh/Desktop/teammcp"
# Layer 3 v0.3 canary: scan CTO agent only. v0.3 classifyLine uses JSON.parse + top-level
# rec.error field check (no more text regex on raw line), passed A's 309K-line stress test
# against CTO historical JSONL (723 true hits, 0 false positives). Banner text scrubbed
# to avoid ouroboros self-trigger.
$env:AUTH_MONITOR_CANARY = "SecTest"

# Local secrets bootstrap: gitignored file sets MEMORY_LLM_KEY etc.
# Safe to be absent — memory engine just runs without LLM enrichment.
if (Test-Path "secrets.local.ps1") { . "./secrets.local.ps1" }

# ── PTY Daemon (Layer 1) ────────────────────────────────────
# Daemon is managed by daemon-launcher.mjs inside index.mjs.
# If you need to start daemon manually:  node server/pty-daemon.mjs
# Kill daemon:  Remove-Item "$env:USERPROFILE\.teammcp\pty-daemon.pid" -ErrorAction SilentlyContinue

node server/index.mjs
