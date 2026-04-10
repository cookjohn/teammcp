# TeamMCP Dev Server — port 3200, isolated data
$env:TEAMMCP_HOME = "C:/Users/ssdlh/Desktop/teammcp-dev"
$env:TEAMMCP_PORT = "3200"
$env:AGENTS_BASE_DIR = "C:/Users/ssdlh/Desktop/agents-dev"
$env:TEAMMCP_URL = "http://localhost:3200"
$env:TEAMMCP_AUTO_RESTART = "1"
$env:TEAMMCP_INTERNAL_SECRET = '462a599b71d9a7f7db4e6ce3c393305b295105b58ae5a0bbafe4a92e3ca4da29'

Set-Location "C:/Users/ssdlh/Desktop/teammcp-code-dev"
node server/index.mjs
