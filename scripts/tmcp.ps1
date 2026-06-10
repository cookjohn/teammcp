# tmcp.ps1 — TeamMCP CLI launcher (named 'tmcp' to avoid colliding with
# the npm-installed 'teammcp' package CLI).
#
# Usage:
#   tmcp start              Start prod server in background (hidden, port 3100)
#   tmcp stop               Stop server + PTY daemon (full shutdown)
#   tmcp restart            Hot-restart server (preserves daemon + agents)
#   tmcp status             Show server + daemon + agent status
#   tmcp logs [-f] [-n N]   Show recent background logs (-f to follow)
#   tmcp help               Show this message
#
# Background logs go to <repo>/logs/teammcp.out and teammcp.err.

[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'restart', 'status', 'logs', 'help')]
  [string]$Command = 'help',

  [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
  [string[]]$Rest = @()
)

$ErrorActionPreference = 'Stop'

# Repo path is the parent of this script's directory.
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Port = 3100
$DaemonPidFile = Join-Path $env:USERPROFILE '.teammcp\pty-daemon.pid'
$LogDir = Join-Path $RepoRoot 'logs'
$LogOut = Join-Path $LogDir 'teammcp.out'
$LogErr = Join-Path $LogDir 'teammcp.err'

function Get-ServerPid {
  $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return [int]$c.OwningProcess }
  return $null
}

function Get-DaemonPid {
  if (-not (Test-Path $DaemonPidFile)) { return $null }
  $raw = (Get-Content $DaemonPidFile -Raw).Trim()
  $out = 0
  if ([int]::TryParse($raw, [ref]$out)) { return $out }
  return $null
}

function Test-ProcessAlive([int]$ProcessId) {
  if (-not $ProcessId) { return $false }
  return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Resolve-Pwsh {
  $cmd = Get-Command pwsh -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return 'powershell.exe'
}

function Invoke-Start {
  $existing = Get-ServerPid
  if ($existing) {
    Write-Host "[teammcp] already running on port $Port (PID=$existing)" -ForegroundColor Yellow
    Invoke-Status
    return
  }

  $startScript = Join-Path $RepoRoot 'start-prod.ps1'
  if (-not (Test-Path $startScript)) {
    Write-Host "[teammcp] start-prod.ps1 not found at $startScript" -ForegroundColor Red
    exit 1
  }

  if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
  if (Test-Path $LogOut) { Move-Item $LogOut "$LogOut.prev" -Force }
  if (Test-Path $LogErr) { Move-Item $LogErr "$LogErr.prev" -Force }

  $pwsh = Resolve-Pwsh
  Write-Host "[teammcp] starting background server... (logs -> $LogOut)" -ForegroundColor Cyan
  Start-Process -FilePath $pwsh `
    -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $startScript `
    -WorkingDirectory $RepoRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $LogOut `
    -RedirectStandardError $LogErr | Out-Null

  # Cold boot can take 30-60s (memory engine, provider init, daemon spawn).
  # Accept any health=ok response — uptime check is only meaningful for
  # restart (where we want to confirm we're seeing the NEW server).
  $deadline = (Get-Date).AddSeconds(90)
  $ok = $false
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    try {
      $h = Invoke-RestMethod -Uri "http://localhost:$Port/api/health" -TimeoutSec 2
      if ($h.status -eq 'ok' -or $h.db_status -eq 'ok') { $ok = $true; break }
    }
    catch {}
  }

  $newPid = Get-ServerPid
  if ($ok -and $newPid) {
    $dp = Get-DaemonPid
    Write-Host "[teammcp] started — server PID=$newPid daemon=$dp port=$Port" -ForegroundColor Green
  }
  else {
    Write-Host "[teammcp] server did not become healthy within 90s. Check $LogErr" -ForegroundColor Red
    if (Test-Path $LogErr) {
      Write-Host "--- last 20 lines of teammcp.err ---" -ForegroundColor DarkGray
      Get-Content $LogErr -Tail 20
    }
    exit 1
  }
}

function Invoke-Stop {
  $serverPid = Get-ServerPid
  $daemonPid = Get-DaemonPid
  $daemonAlive = Test-ProcessAlive $daemonPid

  if (-not $serverPid -and -not $daemonAlive) {
    Write-Host "[teammcp] not running" -ForegroundColor Yellow
    return
  }

  if ($serverPid) {
    Write-Host "[teammcp] stopping server PID=$serverPid..." -ForegroundColor Cyan
    Stop-Process -Id $serverPid -Force -ErrorAction SilentlyContinue
  }

  if ($daemonAlive) {
    Write-Host "[teammcp] stopping PTY daemon PID=$daemonPid (agents will lose PTY)..." -ForegroundColor Cyan
    Stop-Process -Id $daemonPid -Force -ErrorAction SilentlyContinue
    Remove-Item $DaemonPidFile -ErrorAction SilentlyContinue
  }

  Start-Sleep -Milliseconds 800
  if (Get-ServerPid) {
    Write-Host "[teammcp] server still listening; manual kill may be needed" -ForegroundColor Red
    exit 1
  }
  Write-Host "[teammcp] stopped" -ForegroundColor Green
}

function Invoke-Restart {
  $serverPid = Get-ServerPid
  if (-not $serverPid) {
    Write-Host "[teammcp] not running; doing cold start instead" -ForegroundColor Yellow
    Invoke-Start
    return
  }
  $hot = Join-Path $RepoRoot 'scripts\hot-restart.ps1'
  if (-not (Test-Path $hot)) {
    Write-Host "[teammcp] hot-restart.ps1 not found at $hot" -ForegroundColor Red
    exit 1
  }
  & $hot -Port $Port
}

function Invoke-Status {
  $serverPid = Get-ServerPid
  $daemonPid = Get-DaemonPid
  $daemonAlive = Test-ProcessAlive $daemonPid

  Write-Host "TeamMCP status" -ForegroundColor Cyan
  if ($serverPid) {
    Write-Host "  server : running  PID=$serverPid  port=$Port"
  }
  else {
    Write-Host "  server : not running" -ForegroundColor Yellow
  }

  if ($daemonAlive) {
    Write-Host "  daemon : running  PID=$daemonPid"
  }
  else {
    Write-Host "  daemon : not running" -ForegroundColor Yellow
  }

  if ($serverPid) {
    try {
      $h = Invoke-RestMethod -Uri "http://localhost:$Port/api/health" -TimeoutSec 3
      $online = if ($h.agents -and $h.agents.onlineNames) { $h.agents.onlineNames -join ', ' } else { '(none)' }
      Write-Host "  uptime : $([math]::Round($h.uptime_s))s"
      Write-Host "  db     : $($h.db_status)"
      Write-Host "  agents : $online"
    }
    catch {
      Write-Host "  health : unreachable ($($_.Exception.Message))" -ForegroundColor Yellow
    }
  }
}

function Invoke-Logs {
  $follow = ($Rest -contains '-f') -or ($Rest -contains '--follow')
  $lines = 100
  $linesIdx = [Array]::IndexOf($Rest, '-n')
  if ($linesIdx -ge 0 -and ($linesIdx + 1) -lt $Rest.Length) {
    $out = 0
    if ([int]::TryParse($Rest[$linesIdx + 1], [ref]$out)) { $lines = $out }
  }

  if (-not (Test-Path $LogOut)) {
    Write-Host "[teammcp] no log file yet ($LogOut). Run 'teammcp start' first." -ForegroundColor Yellow
    return
  }

  # Node writes UTF-8; default Get-Content uses console OEM codepage and
  # mangles multi-byte chars (arrows, Chinese). Force UTF-8 decoding.
  if ($follow) {
    Write-Host "[teammcp] tailing $LogOut (Ctrl+C to stop)..." -ForegroundColor Cyan
    Get-Content -Path $LogOut -Tail $lines -Wait -Encoding UTF8
  }
  else {
    Get-Content -Path $LogOut -Tail $lines -Encoding UTF8
  }
}

function Show-Help {
  Write-Host "TeamMCP CLI (tmcp)" -ForegroundColor Cyan
  Write-Host ""
  Write-Host "Usage: tmcp <command> [options]"
  Write-Host ""
  Write-Host "Commands:"
  Write-Host "  start              Start prod server in background (port $Port)"
  Write-Host "  stop               Full shutdown (server + PTY daemon)"
  Write-Host "  restart            Hot-restart server, preserve daemon + agents"
  Write-Host "  status             Show server, daemon, and online agents"
  Write-Host "  logs [-f] [-n N]   Show recent background logs; -f to follow live"
  Write-Host "  help               Show this message"
  Write-Host ""
  Write-Host "Logs: $LogOut"
  Write-Host "Repo: $RepoRoot"
}

switch ($Command) {
  'start' { Invoke-Start }
  'stop' { Invoke-Stop }
  'restart' { Invoke-Restart }
  'status' { Invoke-Status }
  'logs' { Invoke-Logs }
  default { Show-Help }
}
