# TeamMCP Dev Server — port 3200, isolated data
$env:TEAMMCP_HOME = "C:/Users/ssdlh/Desktop/teammcp-dev"
$env:TEAMMCP_PORT = "3200"
$env:AGENTS_BASE_DIR = "C:/Users/ssdlh/Desktop/agents-dev"
$env:TEAMMCP_URL = "http://localhost:3200"
$env:TEAMMCP_AUTO_RESTART = "1"

Set-Location "C:/Users/ssdlh/Desktop/teammcp-code-dev"
node server/index.mjs
