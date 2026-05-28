$env:TEAMMCP_HOME = "C:/Users/ssdlh/Desktop/teammcp"
$env:TEAMMCP_PORT = "3100"
$env:AGENTS_BASE_DIR = "C:/Users/ssdlh/Desktop/agents"
$env:TEAMMCP_URL = "http://localhost:3100"
$env:TEAMMCP_AUTO_RESTART = "1"
$env:AUTH_MONITOR_CANARY = "SecTest"
$env:TEAMMCP_BATCH_ENABLED = "true"
# Bootstrap allowlist: temporary, refactor to spawn node+cli.js to remove
$env:TEAMMCP_CMD_ALLOWLIST_EXTRA = "C:\Users\ssdlh\AppData\Roaming\npm\claude.cmd"

Set-Location "C:/Users/ssdlh/Desktop/teammcp"
Start-Process -FilePath "node" -ArgumentList "server/index.mjs" -WindowStyle Hidden -PassThru
