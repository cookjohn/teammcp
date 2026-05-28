# TeamMCP — Daily Health cron wrapper (G0.3)
# Registers with Windows Task Scheduler. Mirrors start-prod.ps1 env.
# Posting identity: A (backend engineer). Change $TEAMMCP_KEY below if
# CEO prefers a different poster.

$env:TEAMMCP_HOME = "C:/Users/ssdlh/Desktop/teammcp"
$env:TEAMMCP_URL  = "http://localhost:3100"

# Posting identity — A's key (same as _start_fakechat.ps1 for agent A).
# CEO: replace with a dedicated ops key if desired.
$env:TEAMMCP_KEY  = 'tmcp_4269dc984cbe4b349a68202d'

Set-Location "C:/Users/ssdlh/Desktop/teammcp"
node "C:/Users/ssdlh/Desktop/teammcp/scripts/daily-health.mjs" @args
