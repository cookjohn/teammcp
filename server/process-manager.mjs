/**
 * Process Manager — spawn and stop Agent (Claude Code) processes.
 * Windows-specific: uses PowerShell for process management, screenshots, and input simulation.
 */

import { exec } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, copyFileSync, readdirSync, statSync, cpSync, symlinkSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

// agentName → { pid, startedAt }
const processes = new Map();

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
        if (existsSync(dst)) continue; // don't overwrite existing per-agent state
        try {
          if (statSync(src).isDirectory()) {
            // Directories use junctions (no admin needed on Windows)
            symlinkSync(src, dst, 'junction');
          } else {
            // Files use hardlinks (no admin needed, stays in sync with original)
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

  // Windows: use Windows Terminal with new window and title for tracking
  // Generate a startup script to avoid multi-layer argument escaping issues
  const windowTitle = `Agent-${name}`;
  const startScript = join(agentDir, '_start.cmd');
  writeFileSync(startScript, `@echo off\r\ncd /d "${agentDir}"\r\nset "CLAUDE_CONFIG_DIR=${configDir}"\r\nset "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1"\r\nclaude --dangerously-skip-permissions --permission-mode bypassPermissions --dangerously-load-development-channels server:teammcp\r\n`, 'utf-8');

  const psCmd = `$p = Start-Process -FilePath 'wt.exe' -ArgumentList '--window new --title ${windowTitle} cmd /k ""${startScript}""' -PassThru; Write-Output $p.Id`;

  const stdout = await execPS(psCmd);
  const pid = parseInt(stdout, 10);
  if (!pid || isNaN(pid)) {
    throw Object.assign(new Error('Failed to get process PID'), { statusCode: 500 });
  }
  processes.set(name, { pid, windowTitle: `Agent-${name}`, startedAt: new Date().toISOString() });
  return { pid };
}

/**
 * Stop an agent process by killing its tracked PID.
 */
export function stopAgent(name) {
  if (!SAFE_NAME_RE.test(name)) {
    throw Object.assign(new Error('Invalid agent name'), { statusCode: 400 });
  }

  const proc = processes.get(name);
  if (!proc) {
    throw Object.assign(new Error(`No tracked process for agent "${name}"`), { statusCode: 400 });
  }

  // Windows: taskkill with /T (tree) and /F (force) on the tracked PID
  exec(`taskkill /PID ${proc.pid} /T /F`, { shell: 'cmd.exe' });

  processes.delete(name);
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
