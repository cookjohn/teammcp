# install-tmcp.ps1 — add scripts/ to user PATH so 'tmcp' resolves anywhere.
#
# Run once: .\scripts\install-tmcp.ps1
# Open a NEW terminal afterwards; then `tmcp status` works from any cwd.
# Idempotent — re-running detects the existing entry and exits.
# Uninstall: .\scripts\install-tmcp.ps1 -Uninstall

[CmdletBinding()]
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$scriptDir = $PSScriptRoot

$current = [Environment]::GetEnvironmentVariable('PATH', 'User')
$entries = @()
if ($current) { $entries = $current -split ';' | Where-Object { $_ -ne '' } }

if ($Uninstall) {
  if ($entries -notcontains $scriptDir) {
    Write-Host "[install] $scriptDir not in user PATH; nothing to remove." -ForegroundColor Yellow
    exit 0
  }
  $new = ($entries | Where-Object { $_ -ne $scriptDir }) -join ';'
  [Environment]::SetEnvironmentVariable('PATH', $new, 'User')
  Write-Host "[install] removed from user PATH: $scriptDir" -ForegroundColor Green
  Write-Host "[install] open a NEW terminal for change to take effect." -ForegroundColor Cyan
  exit 0
}

if ($entries -contains $scriptDir) {
  Write-Host "[install] $scriptDir already in user PATH — nothing to do." -ForegroundColor Yellow
  Write-Host "[install] verify: open a NEW terminal and run 'tmcp help'."
  exit 0
}

$new = if ($entries.Count -gt 0) { ($entries -join ';') + ';' + $scriptDir } else { $scriptDir }
[Environment]::SetEnvironmentVariable('PATH', $new, 'User')
Write-Host "[install] added to user PATH: $scriptDir" -ForegroundColor Green
Write-Host "[install] open a NEW terminal, then run: tmcp help" -ForegroundColor Cyan
