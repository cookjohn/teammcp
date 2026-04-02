/**
 * Process Manager — spawn and stop Agent (Claude Code) processes.
 * Windows-specific: uses PowerShell for process management, screenshots, and input simulation.
 */

import { exec } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, copyFileSync, readdirSync, statSync, cpSync, symlinkSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

// agentName → { pid, startedAt }
const processes = new Map();

// Track agents that were intentionally stopped (to suppress crash detection)
const stoppedAgents = new Set();
export function markStopped(name) { stoppedAgents.add(name); }
export function clearStopped(name) { stoppedAgents.delete(name); }
export function isStopped(name) { return stoppedAgents.has(name); }

const AGENTS_BASE_DIR = process.env.AGENTS_BASE_DIR;
const SCREENSHOTS_DIR = process.env.SCREENSHOTS_DIR || (AGENTS_BASE_DIR ? join(AGENTS_BASE_DIR, '..', 'teammcp-screenshots') : null);

if (!AGENTS_BASE_DIR) {
  console.warn('[process-manager] WARNING: AGENTS_BASE_DIR not set. Agent start/stop/screenshot will fail. Set AGENTS_BASE_DIR to your agents workspace directory.');
}

// Ensure screenshots directory exists
if (SCREENSHOTS_DIR && !existsSync(SCREENSHOTS_DIR)) {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

// Only allow safe agent names (letters, digits, hyphen, underscore)
const SAFE_NAME_RE = /^[A-Za-z0-9_-]+$/;

function execPS(command) {
  return new Promise((resolve, reject) => {
    exec(`powershell -NoProfile -Command "${command}"`, { shell: 'cmd.exe' }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

function execPSFile(script) {
  const tmpFile = join(tmpdir(), `teammcp-${Date.now()}.ps1`);
  writeFileSync(tmpFile, script, 'utf-8');
  return new Promise((resolve, reject) => {
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpFile}"`, { shell: 'cmd.exe' }, (err, stdout, stderr) => {
      try { unlinkSync(tmpFile); } catch {}
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

/**
 * Start an agent process in a new terminal window.
 * Returns { pid } on success.
 */
export async function startAgent(name) {
  if (!AGENTS_BASE_DIR) {
    throw Object.assign(new Error('AGENTS_BASE_DIR environment variable not set'), { statusCode: 500 });
  }
  if (!SAFE_NAME_RE.test(name)) {
    throw Object.assign(new Error('Invalid agent name'), { statusCode: 400 });
  }

  clearStopped(name); // Clear intentional-stop flag on restart

  if (processes.has(name)) {
    throw Object.assign(new Error(`Agent "${name}" process already tracked (PID: ${processes.get(name).pid})`), { statusCode: 400 });
  }

  const agentDir = join(AGENTS_BASE_DIR, name);
  if (!existsSync(agentDir)) {
    throw Object.assign(new Error(`Agent directory not found: ${agentDir}`), { statusCode: 400 });
  }

  // Create isolated config directory for this agent to avoid .claude.json write conflicts (EBUSY)
  const configDir = join(agentDir, '.claude-config');
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  // Symlink all files/dirs from ~/.claude/ to per-agent config dir, keeping everything in sync.
  // Only .claude.json gets a per-agent COPY (that's the EBUSY-prone file we're isolating).
  const defaultClaudeDir = join(homedir(), '.claude');
  if (existsSync(defaultClaudeDir)) {
    try {
      for (const entry of readdirSync(defaultClaudeDir)) {
        if (entry === 'settings.local.json') continue; // let project-level .claude/settings.local.json take precedence
        const src = join(defaultClaudeDir, entry);
        const dst = join(configDir, entry);
        try {
          if (entry === '.credentials.json') {
            // Credentials: always copy (hardlinks break when OAuth token refreshes via file replacement)
            copyFileSync(src, dst);
          } else if (existsSync(dst)) {
            continue; // don't overwrite existing per-agent state for other files
          } else if (statSync(src).isDirectory()) {
            // Directories use junctions (no admin needed on Windows)
            symlinkSync(src, dst, 'junction');
          } else {
            // Other files use hardlinks (no admin needed, stays in sync with original)
            linkSync(src, dst);
          }
        } catch {}
      }
    } catch {}
  }

  // Copy ~/.claude.json to per-agent config dir as an independent copy.
  // This is the file that causes EBUSY when multiple agents write simultaneously.
  const globalClaudeJson = join(homedir(), '.claude.json');
  const agentClaudeJson = join(configDir, '.claude.json');
  if (existsSync(globalClaudeJson) && !existsSync(agentClaudeJson)) {
    try { copyFileSync(globalClaudeJson, agentClaudeJson); } catch {}
  }

  // Read agent's TEAMMCP_KEY from .mcp.json for hook authentication and _start.cmd
  let agentKey = '';
  const mcpJsonPath = join(agentDir, '.mcp.json');
  if (existsSync(mcpJsonPath)) {
    try {
      const mcpConfig = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
      agentKey = mcpConfig?.mcpServers?.teammcp?.env?.TEAMMCP_KEY || '';
    } catch {}
  }

  // Auto-configure HTTP hooks for agent-output reporting to Dashboard
  // Write actual token value into hooks config (avoids env var substitution issues)
  const serverUrl = process.env.TEAMMCP_URL || 'http://localhost:3100';
  const settingsDir = join(agentDir, '.claude');
  if (!existsSync(settingsDir)) mkdirSync(settingsDir, { recursive: true });
  const settingsPath = join(settingsDir, 'settings.local.json');
  let settings = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf-8')); } catch {}
  }
  if (!settings.hooks) settings.hooks = {};
  if (agentKey) {
    const httpHook = [{
      hooks: [{
        type: 'http',
        url: `${serverUrl}/api/agent-output?key=${agentKey}`
      }]
    }];
    settings.hooks.PostToolUse = httpHook;
    settings.hooks.Stop = httpHook;
  }
  try { writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8'); } catch {}

  // Also write hooks to CLAUDE_CONFIG_DIR settings (in case Claude Code reads from there)
  const configSettingsPath = join(configDir, 'settings.local.json');
  let configSettings = {};
  if (existsSync(configSettingsPath)) {
    try { configSettings = JSON.parse(readFileSync(configSettingsPath, 'utf-8')); } catch {}
  }
  if (agentKey) {
    if (!configSettings.hooks) configSettings.hooks = {};
    const httpHook = [{
      hooks: [{
        type: 'http',
        url: `${serverUrl}/api/agent-output?key=${agentKey}`
      }]
    }];
    configSettings.hooks.PostToolUse = httpHook;
    configSettings.hooks.Stop = httpHook;
    try { writeFileSync(configSettingsPath, JSON.stringify(configSettings, null, 2), 'utf-8'); } catch {}
  }

  // Windows: use Windows Terminal with new window and title for tracking
  // Generate a startup script to avoid multi-layer argument escaping issues
  const windowTitle = `Agent-${name}`;
  const startScript = join(agentDir, '_start.cmd');
  const pidFile = join(agentDir, '.agent.pid');
  writeFileSync(startScript, `@echo off\r\ncd /d "${agentDir}"\r\nset "CLAUDE_CONFIG_DIR=${configDir}"\r\nset "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1"\r\n${agentKey ? `set "TEAMMCP_KEY=${agentKey}"\r\nset "AGENT_NAME=${name}"\r\n` : ''}claude --continue --dangerously-skip-permissions --permission-mode bypassPermissions --dangerously-load-development-channels server:teammcp || claude --dangerously-skip-permissions --permission-mode bypassPermissions --dangerously-load-development-channels server:teammcp\r\n`, 'utf-8');

  const psCmd = `$p = Start-Process -FilePath 'wt.exe' -ArgumentList '--window new --title ${windowTitle} cmd /c ""${startScript}""' -PassThru; Write-Output $p.Id`;

  const stdout = await execPS(psCmd);
  const wtPid = parseInt(stdout, 10);
  if (!wtPid || isNaN(wtPid)) {
    throw Object.assign(new Error('Failed to get process PID'), { statusCode: 500 });
  }

  // Wait briefly then find the cmd.exe child running _start.cmd and save its PID
  await new Promise(r => setTimeout(r, 3000));
  try {
    const findPid = await execPSFile(`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${name}\\_start.cmd*' -and $_.Name -eq 'cmd.exe' } | Select-Object -First 1 -ExpandProperty ProcessId`);
    const cmdPid = parseInt(findPid.trim(), 10);
    if (cmdPid && !isNaN(cmdPid)) {
      writeFileSync(pidFile, String(cmdPid), 'utf-8');
    }
  } catch {}

  processes.set(name, { pid: wtPid, windowTitle: `Agent-${name}`, startedAt: new Date().toISOString() });
  return { pid: wtPid };
}

/**
 * Stop an agent process by finding its window title.
 * Uses window title "Agent-{name}" to locate the process, independent of
 * in-memory PID tracking. Works even after server restart or for manually
 * started agents, as long as the window title matches.
 */
export async function stopAgent(name) {
  if (!SAFE_NAME_RE.test(name)) {
    throw Object.assign(new Error('Invalid agent name'), { statusCode: 400 });
  }

  if (!AGENTS_BASE_DIR) {
    throw Object.assign(new Error('AGENTS_BASE_DIR not set'), { statusCode: 500 });
  }

  const agentDir = join(AGENTS_BASE_DIR, name);
  const pidFile = join(agentDir, '.agent.pid');
  const safeName = name.replace(/'/g, "''");
  let killed = false;

  // Method 1: Read .agent.pid file and kill process tree
  if (existsSync(pidFile)) {
    try {
      const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
      if (pid && !isNaN(pid)) {
        exec(`taskkill /PID ${pid} /T /F`, { shell: 'cmd.exe' });
        killed = true;
      }
    } catch {}
    try { unlinkSync(pidFile); } catch {}
  }

  // Method 2: Find by CommandLine matching (fallback)
  if (!killed) {
    try {
      const psScript = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*agents\\${safeName}*' -or $_.CommandLine -like '*Agent-${safeName}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }`;
      const stdout = await execPSFile(psScript);
      const killedPids = stdout.trim().split('\n').filter(s => s.trim()).map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
      if (killedPids.length > 0) killed = true;
    } catch {}
  }

  // Method 3: Tracked PID from memory (last resort)
  const proc = processes.get(name);
  if (proc && proc.pid) {
    exec(`taskkill /PID ${proc.pid} /T /F`, { shell: 'cmd.exe' });
    killed = true;
  }
  processes.delete(name);

  // Close the Windows Terminal window by finding it via CommandLine
  try {
    await execPSFile(`Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'WindowsTerminal.exe' -and $_.CommandLine -like '*Agent-${safeName}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);
  } catch {}

  if (!killed) {
    throw Object.assign(new Error(`No process found for agent "${name}"`), { statusCode: 400 });
  }

  markStopped(name); // Suppress crash detection for intentional stops
  return { stopped: name };
}

/**
 * Take a screenshot of an agent's terminal window.
 * Returns { path } with the screenshot file path.
 */
export async function screenshotAgent(name) {
  if (!SAFE_NAME_RE.test(name)) {
    throw Object.assign(new Error('Invalid agent name'), { statusCode: 400 });
  }

  const proc = processes.get(name);
  if (!proc) {
    throw Object.assign(new Error(`No tracked process for agent "${name}"`), { statusCode: 400 });
  }

  const screenshotPath = join(SCREENSHOTS_DIR, `${name}.png`);
  const windowTitle = proc.windowTitle || `Agent-${name}`;

  const psScript = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Drawing;
using System.Drawing.Imaging;

public class WindowCapture {
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left, Top, Right, Bottom;
    }

    public static void CaptureWindow(IntPtr hwnd, string path) {
        RECT rect;
        GetWindowRect(hwnd, out rect);
        int w = rect.Right - rect.Left;
        int h = rect.Bottom - rect.Top;
        if (w <= 0 || h <= 0) { throw new Exception("Invalid window size"); }

        using (Bitmap bmp = new Bitmap(w, h)) {
            using (Graphics g = Graphics.FromImage(bmp)) {
                g.CopyFromScreen(rect.Left, rect.Top, 0, 0, new Size(w, h));
            }
            bmp.Save(path, ImageFormat.Png);
        }
    }
}
'@ -ReferencedAssemblies System.Drawing

# Find window by process or by searching all windows with matching title
$hwnd = [IntPtr]::Zero

# Try by PID first
$proc = Get-Process -Id ${proc.pid} -ErrorAction SilentlyContinue
if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
    $hwnd = $proc.MainWindowHandle
}

# Try child processes
if ($hwnd -eq [IntPtr]::Zero -and $proc) {
    $children = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${proc.pid} }
    foreach ($child in $children) {
        $cp = Get-Process -Id $child.ProcessId -ErrorAction SilentlyContinue
        if ($cp -and $cp.MainWindowHandle -ne [IntPtr]::Zero) {
            $hwnd = $cp.MainWindowHandle
            break
        }
    }
}

# Fallback: find by window title pattern
if ($hwnd -eq [IntPtr]::Zero) {
    $allProcs = Get-Process | Where-Object { $_.MainWindowTitle -like "*${windowTitle}*" }
    foreach ($p in $allProcs) {
        if ($p.MainWindowHandle -ne [IntPtr]::Zero) {
            $hwnd = $p.MainWindowHandle
            break
        }
    }
}

if ($hwnd -eq [IntPtr]::Zero) { throw "No window found for agent ${name}" }
[WindowCapture]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 300
[WindowCapture]::CaptureWindow($hwnd, "${screenshotPath.replace(/\\/g, '\\\\')}")
Write-Output "OK"
`;

  await execPSFile(psScript);
  return { path: screenshotPath };
}

/**
 * Send keystrokes to an agent's terminal window.
 * Uses Win32 API to focus the window and send keys.
 */
export async function sendKeysToAgent(name, keys) {
  if (!SAFE_NAME_RE.test(name)) {
    throw Object.assign(new Error('Invalid agent name'), { statusCode: 400 });
  }

  const proc = processes.get(name);
  if (!proc) {
    throw Object.assign(new Error(`No tracked process for agent "${name}"`), { statusCode: 400 });
  }

  // Map friendly key names to SendKeys format
  const keyMap = {
    'enter': '{ENTER}',
    'tab': '{TAB}',
    'escape': '{ESC}',
    'up': '{UP}',
    'down': '{DOWN}',
    'left': '{LEFT}',
    'right': '{RIGHT}',
    '1': '1',
    '2': '2',
    'y': 'y',
    'n': 'n',
  };

  const sendKey = keyMap[keys.toLowerCase()] || keys;
  const windowTitle = proc.windowTitle || `Agent-${name}`;

  const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;

public class WinAPI {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
'@

$hwnd = [IntPtr]::Zero

$proc = Get-Process -Id ${proc.pid} -ErrorAction SilentlyContinue
if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
    $hwnd = $proc.MainWindowHandle
}

if ($hwnd -eq [IntPtr]::Zero -and $proc) {
    $children = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${proc.pid} }
    foreach ($child in $children) {
        $cp = Get-Process -Id $child.ProcessId -ErrorAction SilentlyContinue
        if ($cp -and $cp.MainWindowHandle -ne [IntPtr]::Zero) {
            $hwnd = $cp.MainWindowHandle
            break
        }
    }
}

if ($hwnd -eq [IntPtr]::Zero) {
    $allProcs = Get-Process | Where-Object { $_.MainWindowTitle -like "*${windowTitle}*" }
    foreach ($p in $allProcs) {
        if ($p.MainWindowHandle -ne [IntPtr]::Zero) {
            $hwnd = $p.MainWindowHandle
            break
        }
    }
}

if ($hwnd -eq [IntPtr]::Zero) { throw "No window found for agent ${name}" }
[WinAPI]::ShowWindow($hwnd, 9)
[WinAPI]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 500
[System.Windows.Forms.SendKeys]::SendWait("${sendKey}")
Write-Output "OK"
`;

  await execPSFile(psScript);
  return { sent: keys };
}

/**
 * Remove a stale process entry (for auto-restart after crash).
 * Does NOT kill the process — only clears the tracking entry.
 */
export function cleanupStaleProcEntry(name) {
  if (processes.has(name)) {
    processes.delete(name);
  }
}

/**
 * Get status of a tracked agent process.
 */
export function getAgentProcessStatus(name) {
  const proc = processes.get(name);
  return proc ? { tracked: true, pid: proc.pid, startedAt: proc.startedAt } : { tracked: false };
}

// Allowed roles for start/stop operations
const ALLOWED_ROLES = ['CEO', '人力资源'];

export function checkProcessPermission(agent) {
  return agent.name === 'CEO' || agent.name === 'HR' || ALLOWED_ROLES.includes(agent.role);
}

// P1: Periodic credential sync — copy ~/.claude/.credentials.json to all agent config dirs every 30 min
const CREDENTIAL_SYNC_INTERVAL_MS = 30 * 60_000;

function syncCredentials() {
  if (!AGENTS_BASE_DIR) return;
  const defaultCreds = join(homedir(), '.claude', '.credentials.json');
  if (!existsSync(defaultCreds)) return;

  let synced = 0;
  for (const [name] of processes) {
    const configDir = join(AGENTS_BASE_DIR, name, '.claude-config');
    if (!existsSync(configDir)) continue;
    const dst = join(configDir, '.credentials.json');
    try {
      copyFileSync(defaultCreds, dst);
      synced++;
    } catch {}
  }
  if (synced > 0) {
    console.log(`[credential-sync] Synced .credentials.json to ${synced} agent(s)`);
  }
}

setInterval(syncCredentials, CREDENTIAL_SYNC_INTERVAL_MS);
