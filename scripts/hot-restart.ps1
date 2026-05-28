# hot-restart.ps1 — graceful prod server restart, agents stay alive
#
# Sequence:
#   1. Capture current server PID listening on port (must exist)
#   2. Capture pre-restart daemon PID + agent count for invariant check
#   3. Send Ctrl+C / graceful shutdown to server (SIGTERM equivalent)
#   4. Wait for port to free
#   5. Spawn new server (start-prod-detached.ps1 style, no console window)
#   6. Poll /api/health until 200 OK + uptime_s small
#   7. Verify daemon PID unchanged + agent count unchanged
#   8. Print before/after summary
#
# Exit codes: 0 = ok, 1 = pre-flight failed, 2 = old server didn't die,
#             3 = new server didn't come up, 4 = invariant broken (daemon
#             died, agents lost — investigate immediately).
#
# Usage:
#   .\scripts\hot-restart.ps1                  # prod (port 3100)
#   .\scripts\hot-restart.ps1 -Port 3200       # dev
#   .\scripts\hot-restart.ps1 -DryRun          # print what would happen

param(
  [int]$Port = 3100,
  [int]$ShutdownTimeoutSec = 15,
  [int]$BootTimeoutSec = 30,
  [int]$AgentReconnectTimeoutSec = 45,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Write-Step($msg) { Write-Host "[hot-restart] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "[hot-restart] $msg" -ForegroundColor Green }
function Write-Err($msg)  { Write-Host "[hot-restart] $msg" -ForegroundColor Red }

# ── 1. Find current server PID ─────────────────────────────
Write-Step "Looking for server on port $Port..."
$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $conn) {
  Write-Err "No server listening on port $Port. Use start-prod.ps1 for cold start."
  exit 1
}
$oldServerPid = $conn.OwningProcess
$oldProc = Get-Process -Id $oldServerPid -ErrorAction SilentlyContinue
if (-not $oldProc) {
  Write-Err "Port $Port held by PID $oldServerPid but process not found."
  exit 1
}
Write-Step "Old server: PID=$oldServerPid ($($oldProc.ProcessName))"

# ── 2. Pre-restart invariants ──────────────────────────────
$daemonPidFile = Join-Path $env:USERPROFILE ".teammcp\pty-daemon.pid"
if ($Port -eq 3200) { $daemonPidFile = Join-Path $env:USERPROFILE ".teammcp-dev\pty-daemon.pid" }
$preDaemonPid = $null
if (Test-Path $daemonPidFile) {
  $preDaemonPid = (Get-Content $daemonPidFile -Raw).Trim()
}
Write-Step "Pre-restart daemon PID: $preDaemonPid"

$preAgents = @()
try {
  $health = Invoke-RestMethod -Uri "http://localhost:$Port/api/health" -TimeoutSec 5
  $preAgents = @($health.agents.onlineNames)
  Write-Step "Pre-restart online agents ($($preAgents.Count)): $($preAgents -join ', ')"
} catch {
  Write-Step "Pre-restart health probe failed (continuing): $_"
}

if ($DryRun) {
  Write-Ok "DryRun: would kill PID $oldServerPid and spawn new server. Exiting."
  exit 0
}

# ── 3. Graceful shutdown ───────────────────────────────────
Write-Step "Sending shutdown to PID $oldServerPid..."
# Windows has no SIGTERM. Stop-Process -Force is SIGKILL → server's
# graceful shutdown handler doesn't run → SSE clients see abrupt close
# (their reconnect logic handles it). Daemon is unref'd so it survives.
Stop-Process -Id $oldServerPid -Force

# ── 4. Wait for port to free ───────────────────────────────
$deadline = (Get-Date).AddSeconds($ShutdownTimeoutSec)
while ((Get-Date) -lt $deadline) {
  $stillListening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if (-not $stillListening) { break }
  Start-Sleep -Milliseconds 200
}
$stillListening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($stillListening) {
  Write-Err "Port $Port still held after ${ShutdownTimeoutSec}s. Aborting."
  exit 2
}
Write-Ok "Port $Port released"

# ── 5. Spawn new server ────────────────────────────────────
Write-Step "Spawning new server..."
$startScript = if ($Port -eq 3200) { 'start-dev.ps1' } else { 'start-prod.ps1' }
if (-not (Test-Path $startScript)) {
  Write-Err "Start script not found: $startScript"
  exit 3
}
# Use Start-Process with PowerShell so dot-sourcing in start-prod.ps1 works.
# Hidden window keeps it detached from this shell; logs still go to its own
# console buffer (lost on exit — for full logs use start-prod-debug.ps1).
# Prefer pwsh (PowerShell 7+) when available, fall back to Windows
# powershell.exe (5.1) which is always present on Windows.
$pwshCmd = Get-Command pwsh -ErrorAction SilentlyContinue
$pwshExe = if ($pwshCmd) { $pwshCmd.Source } else { 'powershell.exe' }
$newProc = Start-Process -FilePath $pwshExe `
  -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $startScript `
  -WorkingDirectory $repoRoot `
  -WindowStyle Hidden -PassThru
Write-Step "Spawned PID=$($newProc.Id)"

# ── 6. Poll health endpoint ────────────────────────────────
$deadline = (Get-Date).AddSeconds($BootTimeoutSec)
$bootHealth = $null
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
  try {
    $bootHealth = Invoke-RestMethod -Uri "http://localhost:$Port/api/health" -TimeoutSec 2
    # New server should report tiny uptime
    if ($bootHealth.uptime_s -lt 60) {
      break
    }
  } catch {
    # Not ready yet
  }
}
if (-not $bootHealth -or $bootHealth.uptime_s -ge 60) {
  Write-Err "New server did not become healthy within ${BootTimeoutSec}s"
  exit 3
}
Write-Ok "New server healthy: uptime_s=$($bootHealth.uptime_s) db=$($bootHealth.db_status)"

# ── 7. Invariant check ────────────────────────────────────
# Daemon PID is the strict invariant — must be unchanged. Agent
# reconnection is a soft invariant: plugin SSE backoff is 3-30s, so we
# poll up to AgentReconnectTimeoutSec for all pre-restart agents to
# come back online via SSE.
$postDaemonPid = $null
if (Test-Path $daemonPidFile) {
  $postDaemonPid = (Get-Content $daemonPidFile -Raw).Trim()
}
if ($preDaemonPid -and $postDaemonPid -and $preDaemonPid -ne $postDaemonPid) {
  Write-Err "DAEMON RESPAWNED! pre=$preDaemonPid post=$postDaemonPid — agents lost their PTY."
  exit 4
}
Write-Ok "Daemon PID unchanged ($postDaemonPid)"

if ($preAgents.Count -eq 0) {
  Write-Ok "No pre-restart agents to verify"
} else {
  $deadline = (Get-Date).AddSeconds($AgentReconnectTimeoutSec)
  $missing = @($preAgents)
  $postAgents = @()
  while ((Get-Date) -lt $deadline) {
    try {
      $postHealth = Invoke-RestMethod -Uri "http://localhost:$Port/api/health" -TimeoutSec 5
      $postAgents = @($postHealth.agents.onlineNames)
      $missing = @($preAgents | Where-Object { $_ -notin $postAgents })
      if ($missing.Count -eq 0) { break }
    } catch {}
    Start-Sleep -Seconds 2
  }
  if ($missing.Count -gt 0) {
    Write-Err "Agents not reconnected after ${AgentReconnectTimeoutSec}s: $($missing -join ', ')"
    Write-Err "(Currently online: $($postAgents -join ', '))"
    exit 4
  }
  Write-Ok "All $($preAgents.Count) agent(s) reattached: $($postAgents -join ', ')"
}

Write-Host ""
Write-Ok "HOT RESTART OK  old_pid=$oldServerPid  new_pid=$($newProc.Id)  daemon=$postDaemonPid  agents=$($preAgents.Count)"
