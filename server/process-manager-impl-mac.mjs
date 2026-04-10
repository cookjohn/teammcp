/**
 * Process Manager — macOS specific implementation
 * Uses Terminal.app for agent process management, screencapture for screenshots,
 * and osascript for keystroke simulation.
 */

import { spawn, exec } from 'node:child_process';
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
  console.warn('[process-manager:macos] WARNING: AGENTS_BASE_DIR not set. Agent start/stop/screenshot will fail.');
}

ensureDirectories();

// Only allow safe agent names (letters, digits, hyphen, underscore)
const SAFE_NAME_RE = /^[A-Za-z0-9_.\-]+$/;

/**
 * Execute a shell command and return promise
 */
function execAsync(command, options = {}) {
  return new Promise((resolve, reject) => {
    exec(command, options, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

/**
 * Start an agent process in a new Terminal.app window.
 * Returns { pid } on success.
 */
export async function startAgent(name) {
  if (agentInfo?.auth_strategy === 'path_a') {
    const err = new Error('Path A is Windows-only; set auth_strategy != path_a for mac agents');
    err.code = 'PATH_A_MAC_UNSUPPORTED';
    throw err;
  }
  if (!AGENTS_BASE_DIR) {
    throw Object.assign(new Error('AGENTS_BASE_DIR environment variable not set'), { statusCode: 500 });
  }
  // Doc-A v1.6 §11 dedupe (§7): Path A is Windows-only (DPAPI + SAFE_NAME_RE +
  // hardlink/symlink guard). Refuse to start a path_a agent on macOS instead
  // of silently falling through to the API-key path.
  try {
    const _ai = getAgentByName(name);
    if (_ai?.auth_strategy === 'path_a' && _ai?.auth_mode !== 'api_key') {
      throw Object.assign(
        new Error('PATH_A_MAC_UNSUPPORTED'),
        { code: 'PATH_A_MAC_UNSUPPORTED', statusCode: 501 }
      );
    }
  } catch (e) {
    if (e.code === 'PATH_A_MAC_UNSUPPORTED') throw e;
    // ignore lookup errors — fall through to existing flow
  }
  if (!SAFE_NAME_RE.test(name)) {
    throw Object.assign(new Error('Invalid agent name'), { statusCode: 400 });
  }

  clearStopped(name);

  if (processes.has(name)) {
    throw Object.assign(new Error(`Agent "${name}" process already tracked (PID: ${processes.get(name).pid})`), { statusCode: 400 });
  }

  const agentDir = join(AGENTS_BASE_DIR, name);
  if (!existsSync(agentDir)) {
    mkdirSync(agentDir, { recursive: true });
  }

  // Auto-generate .mcp.json if missing
  const mcpJsonPath = join(agentDir, '.mcp.json');
  if (!existsSync(mcpJsonPath)) {
    const packageRoot = join(fileURLToPath(import.meta.url), '..', '..');
    const mcpClientPath = join(packageRoot, 'mcp-client', 'teammcp-channel.mjs');
    const serverUrl = process.env.TEAMMCP_URL || 'http://localhost:3100';
    let agentApiKey = '';
    try {
      const agent = getAgentByName(name);
      agentApiKey = agent?.api_key || '';
    } catch {}
    const mcpConfig = {
      mcpServers: {
        teammcp: {
          command: 'node',
          args: [mcpClientPath],
          env: { AGENT_NAME: name, TEAMMCP_KEY: agentApiKey, TEAMMCP_URL: serverUrl }
        }
      }
    };
    writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2), 'utf-8');
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

  // Create isolated config directory for this agent
  const configDir = join(agentDir, '.claude-config');
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  // Symlink all files/dirs from ~/.claude/ to per-agent config dir
  const defaultClaudeDir = join(homedir(), '.claude');
  if (existsSync(defaultClaudeDir)) {
    try {
      for (const entry of readdirSync(defaultClaudeDir)) {
        if (entry === 'settings.local.json') continue;
        const src = join(defaultClaudeDir, entry);
        const dst = join(configDir, entry);
        try {
          if (existsSync(dst)) {
            continue;
          } else if (statSync(src).isDirectory()) {
            symlinkSync(src, dst);
          } else {
            linkSync(src, dst);
          }
        } catch {}
      }
    } catch {}
  }

  // Copy ~/.claude.json to per-agent config dir
  const globalClaudeJson = join(homedir(), '.claude.json');
  const agentClaudeJson = join(configDir, '.claude.json');
  if (existsSync(globalClaudeJson) && !existsSync(agentClaudeJson)) {
    try { copyFileSync(globalClaudeJson, agentClaudeJson); } catch {}
  }

  // Read agent's TEAMMCP_KEY from .mcp.json
  let agentKey = '';
  if (existsSync(mcpJsonPath)) {
    try {
      const mcpConfig = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
      agentKey = mcpConfig?.mcpServers?.teammcp?.env?.TEAMMCP_KEY || '';
    } catch {}
  }

  // Auto-configure HTTP hooks for agent-output reporting
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
    settings.hooks.StopFailure = httpHook;
  }
  try { writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8'); } catch {}

  // Also write to CLAUDE_CONFIG_DIR settings
  const configSettingsPath = join(configDir, 'settings.local.json');
  let configSettings = {};
  if (existsSync(configSettingsPath)) {
    try { configSettings = JSON.parse(readFileSync(configSettingsPath, 'utf-8')); } catch {}
  }
  if (agentKey) {
    if (!configSettings.hooks) configSettings.hooks = {};
    configSettings.hooks.PostToolUse = settings.hooks.PostToolUse;
    configSettings.hooks.Stop = settings.hooks.Stop;
    configSettings.hooks.StopFailure = settings.hooks.StopFailure;
    try { writeFileSync(configSettingsPath, JSON.stringify(configSettings, null, 2), 'utf-8'); } catch {}
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
      break;
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
          const configSkillDir = join(agentDir, '.claude-config', 'skills', entry);
          if (statSync(src).isDirectory() && !existsSync(dst) && !existsSync(configSkillDir)) {
            cpSync(src, dst, { recursive: true });
          }
        }
      } catch {}
      break;
    }
  }

  // macOS: Create a launch script and open it in Terminal.app
  const windowTitle = `Agent-${name}`;
  const startScript = join(agentDir, '_start.sh');
  const pidFile = join(agentDir, '.agent.pid');
  const useResume = getUseResume(name);
  const continueFlag = useResume ? '--continue ' : '';

  // Build API auth environment variables
  const agentInfo = getAgentByName(name);
  let apiEnvLines = '';
  if (agentInfo && agentInfo.auth_mode === 'api_key') {
    apiEnvLines += `export ANTHROPIC_API_KEY=""\n`;
    apiEnvLines += `export CLAUDE_CODE_OAUTH_TOKEN="channel-gate-bypass"\n`;
    if (agentInfo.api_base_url) apiEnvLines += `export ANTHROPIC_BASE_URL="${agentInfo.api_base_url}"\n`;
    if (agentInfo.api_auth_token) apiEnvLines += `export ANTHROPIC_AUTH_TOKEN="${agentInfo.api_auth_token}"\n`;
    if (agentInfo.api_model) apiEnvLines += `export ANTHROPIC_MODEL="${agentInfo.api_model}"\n`;
  }

  writeFileSync(startScript, `#!/bin/bash
cd "${agentDir}"
export CLAUDE_CONFIG_DIR="${configDir}"
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
${agentKey ? `export TEAMMCP_KEY="${agentKey}"\nexport AGENT_NAME="${name}"\n` : ''}${apiEnvLines}claude ${continueFlag}--dangerously-skip-permissions --permission-mode bypassPermissions --dangerously-load-development-channels server:teammcp${useResume ? ` || claude --dangerously-skip-permissions --permission-mode bypassPermissions --dangerously-load-development-channels server:teammcp` : ''}
`, 'utf-8');

  // Make script executable
  await execAsync(`chmod +x "${startScript}"`);

  // Use osascript to open Terminal.app with the script
  const osaScript = `tell application "Terminal"
    activate
    do script "bash '\\"${startScript}\\"'"
    set window_id to id of front window
end tell
return window_id`;

  const windowId = await execAsync(`osascript -e '${osaScript.replace(/'/g, "'\\''")}'`);

  // Wait for the process to start and find its PID
  await new Promise(r => setTimeout(r, 3000));

  // Find the bash process running the start script
  try {
    const findPidCmd = `pgrep -f "${name}/_start.sh" | head -1`;
    const pidOutput = await execAsync(findPidCmd);
    const cmdPid = parseInt(pidOutput.trim(), 10);
    if (cmdPid && !isNaN(cmdPid)) {
      writeFileSync(pidFile, String(cmdPid), 'utf-8');
      processes.set(name, { pid: cmdPid, windowTitle, startedAt: new Date().toISOString() });
    }
  } catch {}

  // Even if we couldn't find PID immediately, mark as started
  if (!processes.has(name)) {
    // Use a placeholder - will be resolved on screenshot or stop
    processes.set(name, { pid: 0, windowTitle, startedAt: new Date().toISOString() });
  }

  return { pid: processes.get(name).pid };
}

/**
 * Stop an agent process by finding its terminal window.
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
  let killed = false;

  // Method 1: Read .agent.pid file and kill process tree
  if (existsSync(pidFile)) {
    try {
      const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
      if (pid && !isNaN(pid)) {
        await execAsync(`kill -9 ${pid} 2>/dev/null; pkill -P ${pid} 2>/dev/null; true`);
        killed = true;
      }
    } catch {}
    try { unlinkSync(pidFile); } catch {}
  }

  // Method 2: Find by command line matching
  if (!killed) {
    try {
      const pids = await execAsync(`pgrep -f "agents/${name}/_start.sh" 2>/dev/null`);
      const pidList = pids.trim().split('\n').filter(s => s.trim()).map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
      for (const pid of pidList) {
        await execAsync(`kill -9 ${pid} 2>/dev/null; pkill -P ${pid} 2>/dev/null; true`);
        killed = true;
      }
    } catch {}
  }

  // Method 3: Find by Agent-{name} window title in Terminal
  if (!killed) {
    try {
      const osaScript = `tell application "Terminal"
        set winList to windows
        repeat with win in winList
            if name of win contains "Agent-${name}" then
                close win
                return "closed"
            end if
        end repeat
        return "not found"
    end tell`;
      const result = await execAsync(`osascript -e '${osaScript.replace(/'/g, "'\\''")}'`);
      if (result === 'closed') killed = true;
    } catch {}
  }

  // Method 4: Tracked PID from memory
  const proc = processes.get(name);
  if (proc && proc.pid && !killed) {
    await execAsync(`kill -9 ${proc.pid} 2>/dev/null; pkill -P ${proc.pid} 2>/dev/null; true`);
    killed = true;
  }

  processes.delete(name);

  if (!killed) {
    console.warn(`[stopAgent] No running process found for "${name}", marking as stopped`);
  }

  markStopped(name);
  return { stopped: name };
}

/**
 * Take a screenshot of an agent's terminal window.
 * Uses screencapture command.
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

  // Find the terminal window by title and capture it
  const osaScript = `tell application "Terminal"
    set winList to windows
    set targetWindow to null
    repeat with win in winList
        if name of win contains "${windowTitle}" then
            set targetWindow to win
            exit repeat
        end if
    end repeat

    if targetWindow is null then
        return "NOTFOUND"
    end if

    -- Get the window bounds
    set boundsStr to ""
    tell targetWindow
        set boundsStr to (bounding rectangle as string)
    end tell

    return boundsStr
end tell`;

  try {
    const boundsStr = await execAsync(`osascript -e '${osaScript.replace(/'/g, "'\\''")}'`);

    if (boundsStr === 'NOTFOUND') {
      throw new Error(`No window found for agent ${name}`);
    }

    // Parse bounds string like "{x, y, width, height}"
    const boundsMatch = boundsStr.match(/\{(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\}/);
    if (!boundsMatch) {
      throw new Error(`Invalid window bounds: ${boundsStr}`);
    }

    const [, x, y, width, height] = boundsMatch.map(Number);

    // Use screencapture with window selection
    await execAsync(`screencapture -x -R${x},${y},${width},${height} "${screenshotPath}"`);
  } catch (e) {
    // Fallback: capture entire screen
    await execAsync(`screencapture -x "${screenshotPath}"`);
  }

  return { path: screenshotPath };
}

/**
 * Send keystrokes to an agent's terminal window.
 * Uses osascript to send keystrokes.
 */
export async function sendKeysToAgent(name, keys) {
  if (!SAFE_NAME_RE.test(name)) {
    throw Object.assign(new Error('Invalid agent name'), { statusCode: 400 });
  }

  const proc = processes.get(name);
  if (!proc) {
    throw Object.assign(new Error(`No tracked process for agent "${name}"`), { statusCode: 400 });
  }

  // Map friendly key names to osascript key codes
  const keyMap = {
    'enter': 'return',
    'tab': 'tab',
    'escape': 'escape',
    'up': 'up arrow',
    'down': 'down arrow',
    'left': 'left arrow',
    'right': 'right arrow',
    '1': '1',
    '2': '2',
    'y': 'y',
    'n': 'n',
  };

  const keyName = keyMap[keys.toLowerCase()];
  if (!keyName) {
    throw Object.assign(new Error(`Invalid key "${keys}". Allowed: ${Object.keys(keyMap).join(', ')}`), { statusCode: 400 });
  }

  const windowTitle = proc.windowTitle || `Agent-${name}`;

  const osaScript = `tell application "Terminal"
    activate
    set winList to windows
    repeat with win in winList
        if name of win contains "${windowTitle}" then
            tell win
                do script "${keyName}" in it
            end tell
            return "OK"
        end if
    end repeat
    return "NOTFOUND"
end tell`;

  const result = await execAsync(`osascript -e '${osaScript.replace(/'/g, "'\\''")}'`);
  if (result === 'NOTFOUND') {
    throw Object.assign(new Error(`No window found for agent "${name}"`), { statusCode: 400 });
  }

  return { sent: keys };
}

/**
 * Remove a stale process entry (for auto-restart after crash).
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

// TODO: Credential management moved to credential-manager.mjs
