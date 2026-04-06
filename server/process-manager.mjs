/**
 * Process Manager — spawn and stop Agent (Claude Code) processes.
 * Windows-specific: uses PowerShell for process management, screenshots, and input simulation.
 */

import { exec, execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, copyFileSync, readdirSync, statSync, cpSync, symlinkSync, linkSync, watch } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, homedir } from 'node:os';
import { getUseResume, getAgentByName } from './db.mjs';
import { AGENTS_DIR, SCREENSHOTS_DIR, ensureDirectories } from './lib/paths.mjs';

// agentName → { pid, startedAt }
const processes = new Map();

// Track agents that were intentionally stopped (to suppress crash detection)
const stoppedAgents = new Set();
export function markStopped(name) { stoppedAgents.add(name); }
export function clearStopped(name) { stoppedAgents.delete(name); }
export function isStopped(name) { return stoppedAgents.has(name); }

// Support env var override for backward compatibility
const AGENTS_BASE_DIR = process.env.AGENTS_BASE_DIR || AGENTS_DIR;

if (!AGENTS_BASE_DIR) {
  console.warn('[process-manager] WARNING: AGENTS_BASE_DIR not set. Agent start/stop/screenshot will fail.');
}

// Ensure directories exist
ensureDirectories();

// Only allow safe agent names (letters, digits, hyphen, underscore)
const SAFE_NAME_RE = /^[A-Za-z0-9_.\-]+$/;

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
    // Auto-create agent directory for Dashboard-registered agents
    mkdirSync(agentDir, { recursive: true });
  }

  // Auto-generate .mcp.json if missing (or clean teammcp entry if exists)
  const mcpJsonPath = join(agentDir, '.mcp.json');
  if (!existsSync(mcpJsonPath)) {
    writeFileSync(mcpJsonPath, JSON.stringify({ mcpServers: {} }, null, 2), 'utf-8');
  } else {
    try {
      const mcpConfig = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
      if (mcpConfig?.mcpServers?.teammcp) {
        delete mcpConfig.mcpServers.teammcp;
        writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2), 'utf-8');
      }
    } catch {}
  }

  // Auto-generate CLAUDE.md if missing
  const claudeMdPath = join(agentDir, 'CLAUDE.md');
  if (!existsSync(claudeMdPath)) {
    try {
      const agent = getAgentByName(name);
      const role = agent?.role || 'AI Assistant';
      writeFileSync(claudeMdPath, `你是 ${name}（${role}）。

## 职责

请根据你的角色定义执行任务。

## 沟通方式

- 通过 teammcp 的 send_message / send_dm 工具与团队沟通
- 群聊回复：调用 send_message 工具
- 私聊回复：调用 send_dm 工具
- 收到消息后根据你的角色定义来响应
- 接到任务后通过 subagent（子代理）执行具体工作，主会话保持消息接收

## 工作原则

- 执行任务时优先使用 Agent Team 模式（子代理），避免阻塞主会话
- 董事长在群聊中发布的信息只能由 CEO 接收并分派，除非指定了你
- 所有任务通过 Task 系统管理（create_task → doing → done_task）
`, 'utf-8');
    } catch {
      writeFileSync(claudeMdPath, `你是 ${name}。\n`, 'utf-8');
    }
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

  // Supplement .claude.json with tengu_harbor feature flag and trust dialog acceptance
  if (existsSync(agentClaudeJson)) {
    try {
      const cj = JSON.parse(readFileSync(agentClaudeJson, 'utf-8'));
      if (!cj.cachedGrowthBookFeatures) cj.cachedGrowthBookFeatures = {};
      cj.cachedGrowthBookFeatures.tengu_harbor = true;
      if (!cj.projects) cj.projects = {};
      const projKey = agentDir.replace(/\\/g, '/');
      if (!cj.projects[projKey]) cj.projects[projKey] = {};
      cj.projects[projKey].hasTrustDialogAccepted = true;
      cj.hasCompletedOnboarding = true;
      writeFileSync(agentClaudeJson, JSON.stringify(cj, null, 2), 'utf-8');
    } catch {}
  }

  // Read agent's TEAMMCP_KEY from database for hook authentication and _start.cmd
  let agentKey = '';
  try {
    const agent = getAgentByName(name);
    agentKey = agent?.api_key || '';
  } catch {}

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

    // StopFailure hook for rate limit and error capture
    const errorHook = [{
      hooks: [{
        type: 'http',
        url: `${serverUrl}/api/agent-error?key=${agentKey}`
      }]
    }];
    settings.hooks.StopFailure = errorHook;
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
    const errorHookConfig = [{
      hooks: [{
        type: 'http',
        url: `${serverUrl}/api/agent-error?key=${agentKey}`
      }]
    }];
    configSettings.hooks.StopFailure = errorHookConfig;
    try { writeFileSync(configSettingsPath, JSON.stringify(configSettings, null, 2), 'utf-8'); } catch {}
  }

  // Supplement settings.json with enabledPlugins and allowedChannelPlugins for fakechat
  const configSettingsJsonPath = join(configDir, 'settings.json');
  let cfgSettings = {};
  if (existsSync(configSettingsJsonPath)) {
    try { cfgSettings = JSON.parse(readFileSync(configSettingsJsonPath, 'utf-8')); } catch {}
  }
  cfgSettings.skipDangerousModePermissionPrompt = true;
  if (!cfgSettings.enabledPlugins) cfgSettings.enabledPlugins = {};
  cfgSettings.enabledPlugins['fakechat@claude-plugins-official'] = true;
  if (!cfgSettings.allowedChannelPlugins) cfgSettings.allowedChannelPlugins = [];
  if (!cfgSettings.allowedChannelPlugins.some(e => typeof e === 'object' && e.plugin === 'fakechat')) {
    cfgSettings.allowedChannelPlugins.push({ marketplace: 'claude-plugins-official', plugin: 'fakechat' });
  }
  writeFileSync(configSettingsJsonPath, JSON.stringify(cfgSettings, null, 2), 'utf-8');

  // Check CLAUDE.md exists (auto-generated above if missing, this is a safety check)
  if (!existsSync(claudeMdPath)) {
    console.warn(`[start-agent] WARNING: ${name} has no CLAUDE.md — agent may lack role definition`);
  }

  // Auto-deploy team rules from templates
  const possibleRulesDirs = [
    join(AGENTS_BASE_DIR, '..', 'teammcp', 'templates', 'rules'),
    join(AGENTS_BASE_DIR, 'PM', 'projects', 'teammcp-templates', 'rules'),
  ];
  const rulesTargetDir = join(agentDir, '.claude', 'rules');
  for (const rulesSourceDir of possibleRulesDirs) {
    if (existsSync(rulesSourceDir)) {
      if (!existsSync(rulesTargetDir)) mkdirSync(rulesTargetDir, { recursive: true });
      try {
        for (const file of readdirSync(rulesSourceDir)) {
          const src = join(rulesSourceDir, file);
          const dst = join(rulesTargetDir, file);
          if (statSync(src).isFile()) copyFileSync(src, dst);
        }
      } catch {}
      break; // Use first found source
    }
  }

  // Auto-deploy shared skills from templates
  const possibleSkillsDirs = [
    join(AGENTS_BASE_DIR, '..', 'teammcp', 'templates', 'skills'),
    join(AGENTS_BASE_DIR, 'PM', 'projects', 'teammcp-templates', 'skills'),
  ];
  const skillsTargetDir = join(agentDir, '.claude', 'skills');
  for (const skillsSourceDir of possibleSkillsDirs) {
    if (existsSync(skillsSourceDir)) {
      if (!existsSync(skillsTargetDir)) mkdirSync(skillsTargetDir, { recursive: true });
      try {
        for (const entry of readdirSync(skillsSourceDir)) {
          const src = join(skillsSourceDir, entry);
          const dst = join(skillsTargetDir, entry);
          // Skip if skill exists in project-level OR agent-config-level skills
          const configSkillDir = join(agentDir, '.claude-config', 'skills', entry);
          if (statSync(src).isDirectory() && !existsSync(dst) && !existsSync(configSkillDir)) {
            cpSync(src, dst, { recursive: true });
          }
        }
      } catch {}
      break;
    }
  }

  // Get agent info from DB (used for credentials handling and auth config)
  const agentInfo = getAgentByName(name);

  // API key agents — clear OAuth credentials to avoid interference
  if (agentInfo && agentInfo.auth_mode === 'api_key') {
    const credFile = join(configDir, '.credentials.json');
    try { unlinkSync(credFile); } catch {}
    writeFileSync(credFile, '{}', 'utf-8');
  }

  // fakechat plugin installation check — auto-install if not present
  const pluginsDir = join(configDir, 'plugins');
  const installedPlugins = join(pluginsDir, 'installed_plugins.json');
  let hasFakechat = false;
  if (existsSync(installedPlugins)) {
    try {
      const d = JSON.parse(readFileSync(installedPlugins, 'utf-8'));
      hasFakechat = !!d.plugins?.['fakechat@claude-plugins-official']?.length;
    } catch {}
  }
  if (!hasFakechat) {
    const globalInstalled = join(homedir(), '.claude', 'plugins', 'installed_plugins.json');
    let globalHas = false;
    if (existsSync(globalInstalled)) {
      try {
        const d = JSON.parse(readFileSync(globalInstalled, 'utf-8'));
        globalHas = !!d.plugins?.['fakechat@claude-plugins-official']?.length;
      } catch {}
    }
    if (!globalHas) {
      execSync('claude plugin marketplace add anthropics/claude-plugins-official', {
        env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
        timeout: 60000
      });
      execSync('claude plugin install fakechat@claude-plugins-official', {
        env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
        timeout: 60000
      });
    }
  }

  // Bridge server.ts auto-replacement — replace fakechat bridge with TeamMCP bridge
  const bridgeSource = join(fileURLToPath(import.meta.url), '..', '..', 'templates', 'channel-bridge', 'server.ts');
  const fakechatPaths = [
    join(configDir, 'plugins', 'marketplaces', 'claude-plugins-official', 'external_plugins', 'fakechat', 'server.ts'),
    join(configDir, 'plugins', 'cache', 'claude-plugins-official', 'fakechat', '0.0.1', 'server.ts'),
    join(homedir(), '.claude', 'plugins', 'marketplaces', 'claude-plugins-official', 'external_plugins', 'fakechat', 'server.ts'),
    join(homedir(), '.claude', 'plugins', 'cache', 'claude-plugins-official', 'fakechat', '0.0.1', 'server.ts'),
  ];
  if (existsSync(bridgeSource)) {
    for (const target of fakechatPaths) {
      if (existsSync(target)) {
        try { copyFileSync(bridgeSource, target); } catch {}
      }
    }
  }

  // Windows: use Windows Terminal with new window and title for tracking
  // Generate a startup script to avoid multi-layer argument escaping issues
  const windowTitle = `Agent-${name}`;
  const startScript = join(agentDir, '_start_fakechat.ps1');
  const pidFile = join(agentDir, '.agent.pid');
  const useResume = getUseResume(name);
  const continueFlag = useResume ? '--continue ' : '';

  // Build startup script with PowerShell $env: syntax (inherited by child processes)
  const ps1Lines = [
    `Set-Location "${agentDir}"`,
    `$env:CLAUDE_CONFIG_DIR = "${configDir}"`,
    `$env:CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1"`,
  ];
  if (agentKey) {
    ps1Lines.push(`$env:TEAMMCP_KEY = "${agentKey}"`);
    ps1Lines.push(`$env:AGENT_NAME = "${name}"`);
  }
  ps1Lines.push(`$env:TEAMMCP_URL = "${serverUrl}"`);
  if (agentInfo && agentInfo.auth_mode === 'api_key') {
    ps1Lines.push(`$env:ANTHROPIC_API_KEY = ""`);
    ps1Lines.push(`$env:CLAUDE_CODE_OAUTH_TOKEN = "channel-gate-bypass"`);
    if (agentInfo.api_base_url) ps1Lines.push(`$env:ANTHROPIC_BASE_URL = "${agentInfo.api_base_url}"`);
    if (agentInfo.api_auth_token) ps1Lines.push(`$env:ANTHROPIC_AUTH_TOKEN = "${agentInfo.api_auth_token}"`);
    if (agentInfo.api_model) ps1Lines.push(`$env:ANTHROPIC_MODEL = "${agentInfo.api_model}"`);
  }
  const channelFlag = '--channels plugin:fakechat@claude-plugins-official';
  ps1Lines.push(`claude ${continueFlag}--dangerously-skip-permissions --permission-mode bypassPermissions ${channelFlag}`);
  if (useResume) {
    ps1Lines.push(`if ($LASTEXITCODE -ne 0) { claude --dangerously-skip-permissions --permission-mode bypassPermissions ${channelFlag} }`);
  }
  writeFileSync(startScript, ps1Lines.join('\r\n') + '\r\n', 'utf-8');

  const psCmd = `$p = Start-Process -FilePath 'wt.exe' -ArgumentList '--window new --title ${windowTitle} powershell -ExecutionPolicy Bypass -File ""${startScript}""' -PassThru; Write-Output $p.Id`;

  const stdout = await execPS(psCmd);
  const wtPid = parseInt(stdout, 10);
  if (!wtPid || isNaN(wtPid)) {
    throw Object.assign(new Error('Failed to get process PID'), { statusCode: 500 });
  }

  // Wait briefly then find the powershell.exe child running _start_fakechat.ps1 and save its PID
  await new Promise(r => setTimeout(r, 3000));
  try {
    const findPid = await execPSFile(`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${name}*_start_fakechat.ps1*' -and $_.Name -eq 'powershell.exe' } | Select-Object -First 1 -ExpandProperty ProcessId`);
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

  // Note: Don't kill WindowsTerminal.exe — multiple agents may share the same WT process.
  // WT windows auto-close via closeOnExit:always when the agent process ends.

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

  const sendKey = keyMap[keys.toLowerCase()];
  if (!sendKey) {
    throw Object.assign(new Error(`Invalid key "${keys}". Allowed: ${Object.keys(keyMap).join(', ')}`), { statusCode: 400 });
  }
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
  return agent.name === 'Chairman' || agent.name === 'CEO' || agent.name === 'HR' || ALLOWED_ROLES.includes(agent.role);
}

// P1: Credential sync — file watcher + periodic fallback (5 min)
const CREDENTIAL_SYNC_INTERVAL_MS = 5 * 60_000;

function syncCredentials() {
  if (!AGENTS_BASE_DIR) return;
  const mainCreds = join(homedir(), '.claude', '.credentials.json');
  if (!existsSync(mainCreds)) return;

  let mainTime;
  try { mainTime = statSync(mainCreds).mtimeMs; } catch { return; }

  let fwdSync = 0, revSync = 0;
  // Iterate ALL agent directories with .claude-config, not just tracked processes
  const agentDirs = readdirSync(AGENTS_BASE_DIR).filter(name => {
    try { return statSync(join(AGENTS_BASE_DIR, name)).isDirectory() && existsSync(join(AGENTS_BASE_DIR, name, '.claude-config')); } catch { return false; }
  });
  for (const name of agentDirs) {
    // Skip agents that use API key auth (not OAuth) — and protect their empty credentials
    try {
      const a = getAgentByName(name);
      if (a?.auth_mode === 'api_key') {
        const agentCreds = join(AGENTS_BASE_DIR, name, '.claude-config', '.credentials.json');
        if (existsSync(agentCreds)) {
          const content = readFileSync(agentCreds, 'utf-8');
          if (content !== '{}' && content.length > 10) {
            writeFileSync(agentCreds, '{}', 'utf-8');
          }
        }
        continue;
      }
    } catch {}
    const configDir = join(AGENTS_BASE_DIR, name, '.claude-config');
    const agentCreds = join(configDir, '.credentials.json');
    try {
      if (!existsSync(agentCreds)) {
        // Agent has no credentials yet — forward sync
        copyFileSync(mainCreds, agentCreds);
        fwdSync++;
      } else {
        const agentTime = statSync(agentCreds).mtimeMs;
        if (agentTime > mainTime) {
          // Agent token is newer — reverse sync to main
          copyFileSync(agentCreds, mainCreds);
          mainTime = agentTime; // Update for subsequent comparisons
          revSync++;
        } else if (mainTime > agentTime) {
          // Main token is newer — forward sync to agent
          copyFileSync(mainCreds, agentCreds);
          fwdSync++;
        }
      }
    } catch {}
  }
  if (fwdSync > 0 || revSync > 0) {
    console.log(`[credential-sync] fwd:${fwdSync} rev:${revSync}`);
  }
}

setInterval(syncCredentials, CREDENTIAL_SYNC_INTERVAL_MS);

// Watch main credentials file for immediate sync on change
try {
  const mainCreds = join(homedir(), '.claude', '.credentials.json');
  if (existsSync(mainCreds)) {
    let debounce = null;
    watch(mainCreds, () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        console.log('[credential-sync] main credentials changed, syncing...');
        syncCredentials();
      }, 2000); // 2s debounce to avoid rapid fire
    });
    console.log('[credential-sync] watching main credentials for changes');
  }
} catch (e) { console.warn('[credential-sync] watch failed:', e.message); }

// Also watch agent credential dirs for reverse sync
try {
  if (AGENTS_BASE_DIR) {
    const agentDirs = readdirSync(AGENTS_BASE_DIR).filter(name => {
      try { return statSync(join(AGENTS_BASE_DIR, name)).isDirectory() && existsSync(join(AGENTS_BASE_DIR, name, '.claude-config')); } catch { return false; }
    });
    for (const name of agentDirs) {
      try { const a = getAgentByName(name); if (a?.auth_mode === 'api_key') continue; } catch {}
      const agentCreds = join(AGENTS_BASE_DIR, name, '.claude-config', '.credentials.json');
      if (existsSync(agentCreds)) {
        let debounce = null;
        watch(agentCreds, () => {
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(() => {
            console.log(`[credential-sync] ${name} credentials changed, syncing...`);
            syncCredentials();
          }, 2000);
        });
      }
    }
  }
} catch (e) { console.warn('[credential-sync] agent watch failed:', e.message); }

// P2: Proactive OAuth token refresh — refresh accessToken before it expires
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_SCOPES = 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
const TOKEN_REFRESH_CHECK_MS = 5 * 60_000; // Check every 5 min
const TOKEN_REFRESH_BUFFER_MS = 15 * 60_000; // Refresh 15 min before expiry

async function refreshOAuthToken() {
  const mainCreds = join(homedir(), '.claude', '.credentials.json');
  if (!existsSync(mainCreds)) return;

  let data;
  try { data = JSON.parse(readFileSync(mainCreds, 'utf-8')); } catch { return; }
  const oauth = data?.claudeAiOauth;
  if (!oauth?.refreshToken || !oauth?.expiresAt) return;

  const timeLeft = oauth.expiresAt - Date.now();
  if (timeLeft > TOKEN_REFRESH_BUFFER_MS) return; // Still valid, no need to refresh

  console.log(`[oauth-refresh] Token expires in ${Math.round(timeLeft / 60000)}min, refreshing...`);
  try {
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: oauth.refreshToken,
        client_id: OAUTH_CLIENT_ID,
        scope: OAUTH_SCOPES,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (res.status !== 200) {
      console.error(`[oauth-refresh] Failed: HTTP ${res.status}`);
      return;
    }
    const resp = await res.json();
    const newData = {
      claudeAiOauth: {
        ...oauth,
        accessToken: resp.access_token,
        refreshToken: resp.refresh_token || oauth.refreshToken,
        expiresAt: Date.now() + (resp.expires_in * 1000),
      },
    };
    writeFileSync(mainCreds, JSON.stringify(newData), 'utf-8');
    console.log(`[oauth-refresh] Token refreshed, expires in ${resp.expires_in}s`);
    // Sync will be triggered by file watcher
  } catch (e) {
    console.error(`[oauth-refresh] Error: ${e.message}`);
  }
}

setInterval(refreshOAuthToken, TOKEN_REFRESH_CHECK_MS);
refreshOAuthToken(); // Check immediately on startup
