# TeamMCP Prod Server — port 3100, production data
$env:TEAMMCP_HOME = "C:/Users/ssdlh/Desktop/teammcp"
$env:TEAMMCP_PORT = "3100"
$env:AGENTS_BASE_DIR = "C:/Users/ssdlh/Desktop/agents"
$env:TEAMMCP_URL = "http://localhost:3100"
$env:TEAMMCP_AUTO_RESTART = "1"

Set-Location "C:/Users/ssdlh/Desktop/teammcp"
# Layer 3 v0.3 canary: scan CTO agent only. v0.3 classifyLine uses JSON.parse + top-level
# rec.error field check (no more text regex on raw line), passed A's 309K-line stress test
# against CTO historical JSONL (723 true hits, 0 false positives). Banner text scrubbed
# to avoid ouroboros self-trigger.
$env:AUTH_MONITOR_CANARY = "SecTest"
node server/index.mjs
