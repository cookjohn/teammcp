# TeamMCP Prod Server — port 3100, production data
$env:TEAMMCP_HOME = "C:/Users/ssdlh/Desktop/teammcp"
$env:TEAMMCP_PORT = "3100"
$env:AGENTS_BASE_DIR = "C:/Users/ssdlh/Desktop/agents"
$env:TEAMMCP_URL = "http://localhost:3100"
$env:TEAMMCP_AUTO_RESTART = "1"

Set-Location "C:/Users/ssdlh/Desktop/teammcp"
node server/index.mjs
