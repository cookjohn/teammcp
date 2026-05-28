/**
 * Process Manager — Linux implementation (headless node-pty path).
 *
 * Each agent runs as an in-process node-pty child. Output flows to the
 * existing WebSocket bridge via attachPtyOutput; input via proc.write().
 *
 * Differences from win/mac impls:
 *  - No Terminal.app / no PTY daemon — single-process node-pty.
 *  - No DPAPI / Path A (Windows-only by design; refused at startAgent).
 *  - screenshotAgent returns a text snapshot of the WS scrollback
 *    rather than a PNG (no compositor on a headless server).
 *  - sendKeysToAgent maps friendly names to ANSI bytes and writes them
 *    straight to the PTY — no AppleScript indirection.
 */
import { exec } from 'node:child_process';
import {
  existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync,
  copyFileSync, readdirSync, statSync, lstatSync, cpSync, symlinkSync, linkSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import pty from 'node-pty';
import { getUseResume, getAgentByName } from './db.mjs';
import { AGENTS_DIR, SCREENSHOTS_DIR, ensureDirectories } from './lib/paths.mjs';

const LOG_PREFIX = '[process-manager:linux]';

// agentName → { pid, ptyHandle, startedAt }
const processes = new Map();

const stoppedAgents = new Set();
export function markStopped(name)  { stoppedAgents.add(name); }
export function clearStopped(name) { stoppedAgents.delete(name); }
export function isStopped(name)    { return stoppedAgents.has(name); }

export const SAFE_NAME_RE = /^[A-Za-z0-9_.\-]+$/;

const AGENTS_BASE_DIR = process.env.AGENTS_BASE_DIR || AGENTS_DIR;

if (!AGENTS_BASE_DIR) {
  console.warn(`${LOG_PREFIX} AGENTS_BASE_DIR not set — agent ops will fail`);
}

ensureDirectories();
console.log(`${LOG_PREFIX} active. AGENTS_BASE_DIR =`, AGENTS_BASE_DIR);

function execAsync(command, options = {}) {
  return new Promise((resolve, reject) => {
    exec(command, options, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

export async function startAgent(name) {
  if (!SAFE_NAME_RE.test(name)) {
    throw Object.assign(new Error('Invalid agent name'), { statusCode: 400 });
  }
  if (!AGENTS_BASE_DIR) {
    throw Object.assign(new Error('AGENTS_BASE_DIR not set'), { statusCode: 500 });
  }

  // Path A is Windows-only; refuse early on Linux just like mac does.
  try {
    const _ai = getAgentByName(name);
    if (_ai?.auth_strategy === 'path_a' && _ai?.auth_mode !== 'api_key') {
      throw Object.assign(
        new Error('PATH_A_LINUX_UNSUPPORTED: Path A (DPAPI) is Windows-only; set auth_mode=api_key on Linux'),
        { code: 'PATH_A_LINUX_UNSUPPORTED', statusCode: 501 }
      );
    }
  } catch (e) {
    if (e.code === 'PATH_A_LINUX_UNSUPPORTED') throw e;
  }

  clearStopped(name);

  if (processes.has(name)) {
    throw Object.assign(
      new Error(`Agent "${name}" already running (pid ${processes.get(name).pid})`),
      { statusCode: 400 }
    );
  }

  const agentDir = join(AGENTS_BASE_DIR, name);
  if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });

  // .mcp.json — generate if missing so the agent can find the teammcp MCP bridge
  const mcpJsonPath = join(agentDir, '.mcp.json');
  if (!existsSync(mcpJsonPath)) {
    const packageRoot = join(fileURLToPath(import.meta.url), '..', '..');
    const mcpClientPath = join(packageRoot, 'mcp-client', 'teammcp-channel.mjs');
    const serverUrl = process.env.TEAMMCP_URL || 'http://localhost:3100';
    let agentApiKey = '';
    try { agentApiKey = getAgentByName(name)?.api_key || ''; } catch {}
    const mcpConfig = {
      mcpServers: {
        teammcp: {
          command: 'node',
          args: [mcpClientPath],
          env: { AGENT_NAME: name, TEAMMCP_KEY: agentApiKey, TEAMMCP_URL: serverUrl },
        },
      },
    };
    writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2), 'utf-8');
  }

  // CLAUDE.md scaffold (same content as mac impl)
  const claudeMdPath = join(agentDir, 'CLAUDE.md');
  if (!existsSync(claudeMdPath)) {
    try {
      const role = getAgentByName(name)?.role || 'AI Assistant';
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

  // Per-agent .claude-config (Linux supports symlinks without elevation, unlike Windows)
  const configDir = join(agentDir, '.claude-config');
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });

  const defaultClaudeDir = join(homedir(), '.claude');
  if (existsSync(defaultClaudeDir)) {
    try {
      for (const entry of readdirSync(defaultClaudeDir)) {
        if (entry === 'settings.local.json') continue;
        const src = join(defaultClaudeDir, entry);
        const dst = join(configDir, entry);
        if (existsSync(dst)) continue;
        try {
          if (statSync(src).isDirectory()) symlinkSync(src, dst);
          else linkSync(src, dst);
        } catch {}
      }
    } catch {}
  }

  const globalClaudeJson = join(homedir(), '.claude.json');
  const agentClaudeJson = join(configDir, '.claude.json');
  if (existsSync(globalClaudeJson) && !existsSync(agentClaudeJson)) {
    try { copyFileSync(globalClaudeJson, agentClaudeJson); } catch {}
  }

  // Read TEAMMCP_KEY from .mcp.json for hook config
  let agentKey = '';
  try {
    const mcpConfig = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
    agentKey = mcpConfig?.mcpServers?.teammcp?.env?.TEAMMCP_KEY || '';
  } catch {}

  // Wire HTTP hooks for agent-output reporting (same shape as mac/win)
  const serverUrl = process.env.TEAMMCP_URL || 'http://localhost:3100';
  const settingsDir = join(agentDir, '.claude');
  if (!existsSync(settingsDir)) mkdirSync(settingsDir, { recursive: true });

  const wireHooks = (settingsPath) => {
    let settings = {};
    if (existsSync(settingsPath)) {
      try { settings = JSON.parse(readFileSync(settingsPath, 'utf-8')); } catch {}
    }
    if (agentKey) {
      const httpHook = [{
        hooks: [{ type: 'http', url: `${serverUrl}/api/agent-output?key=${agentKey}` }],
      }];
      settings.hooks = settings.hooks || {};
      settings.hooks.PostToolUse = httpHook;
      settings.hooks.Stop = httpHook;
      settings.hooks.StopFailure = httpHook;
    }
    try { writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8'); } catch {}
  };
  wireHooks(join(settingsDir, 'settings.local.json'));
  wireHooks(join(configDir, 'settings.local.json'));

  // Deploy team rules + skills from templates (best-effort)
  const ruleSources = [
    join(AGENTS_BASE_DIR, '..', 'teammcp', 'templates', 'rules'),
    join(AGENTS_BASE_DIR, 'PM', 'projects', 'teammcp-templates', 'rules'),
  ];
  const rulesTargetDir = join(agentDir, '.claude', 'rules');
  for (const src of ruleSources) {
    if (!existsSync(src)) continue;
    if (!existsSync(rulesTargetDir)) mkdirSync(rulesTargetDir, { recursive: true });
    try {
      for (const file of readdirSync(src)) {
        const sp = join(src, file);
        const dp = join(rulesTargetDir, file);
        if (statSync(sp).isFile()) copyFileSync(sp, dp);
      }
    } catch {}
    break;
  }

  const skillSources = [
    join(AGENTS_BASE_DIR, '..', 'teammcp', 'templates', 'skills'),
    join(AGENTS_BASE_DIR, 'PM', 'projects', 'teammcp-templates', 'skills'),
  ];
  const skillsTargetDir = join(agentDir, '.claude', 'skills');
  for (const src of skillSources) {
    if (!existsSync(src)) continue;
    if (!existsSync(skillsTargetDir)) mkdirSync(skillsTargetDir, { recursive: true });
    try {
      for (const entry of readdirSync(src)) {
        const sp = join(src, entry);
        const dp = join(skillsTargetDir, entry);
        const configSkillDir = join(configDir, 'skills', entry);
        if (statSync(sp).isDirectory() && !existsSync(dp) && !existsSync(configSkillDir)) {
          cpSync(sp, dp, { recursive: true });
        }
      }
    } catch {}
    break;
  }

  // Resolve claude binary (PATH lookup — typically /usr/bin/claude after npm -g install)
  let claudeCmd = 'claude';
  try {
    const which = await execAsync('command -v claude || which claude');
    if (which) claudeCmd = which;
  } catch {}

  const useResume = getUseResume(name);
  const claudeArgs = [];
  if (useResume) claudeArgs.push('--continue');
  claudeArgs.push(
    '--dangerously-skip-permissions',
    '--permission-mode', 'bypassPermissions',
    // Load the teammcp MCP server defined in .mcp.json as a "channel"
    '--dangerously-load-development-channels', 'server:teammcp',
  );

  // Build env
  const agentInfo = getAgentByName(name);
  const ptyEnv = {
    ...process.env,
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    AGENT_NAME: name,
    TEAMMCP_URL: serverUrl,
    HOME: process.env.HOME || homedir(),
    TERM: 'xterm-256color',
  };
  if (agentKey) ptyEnv.TEAMMCP_KEY = agentKey;
  if (agentInfo?.auth_mode === 'api_key') {
    // Resolve credential profile-first, inline-fallback (same as win/mac).
    const { resolveAgentCredential } = await import('./db.mjs');
    const cred = resolveAgentCredential(agentInfo);
    ptyEnv.ANTHROPIC_API_KEY = '';
    ptyEnv.CLAUDE_CODE_OAUTH_TOKEN = 'channel-gate-bypass';
    if (cred.base_url) ptyEnv.ANTHROPIC_BASE_URL  = cred.base_url;
    if (cred.token)    ptyEnv.ANTHROPIC_AUTH_TOKEN = cred.token;
    if (cred.model)    ptyEnv.ANTHROPIC_MODEL     = cred.model;
  }

  const pidFile = join(agentDir, '.agent.pid');

  let proc;
  try {
    proc = pty.spawn(claudeCmd, claudeArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: agentDir,
      env: ptyEnv,
    });
  } catch (e) {
    throw Object.assign(
      new Error(`Failed to spawn claude (${claudeCmd}): ${e.message}`),
      { statusCode: 500, cause: e }
    );
  }

  try {
    const { attachPtyOutput } = await import('./pty-manager.mjs');
    attachPtyOutput(name, proc);
  } catch (e) {
    console.error(`${LOG_PREFIX} attachPtyOutput failed for ${name}: ${e.message}`);
  }

  proc.onExit(({ exitCode }) => {
    console.log(`${LOG_PREFIX} ${name} exited (code ${exitCode})`);
    processes.delete(name);
    try { unlinkSync(pidFile); } catch {}
    if (!isStopped(name)) {
      import('./sse.mjs').then(({ pushToAgents }) => {
        pushToAgents(['CEO'], {
          type: 'status',
          agent: name,
          status: 'offline',
          exitCode,
          timestamp: new Date().toISOString(),
        });
      }).catch(() => {});
    }
  });

  writeFileSync(pidFile, String(proc.pid), 'utf-8');
  processes.set(name, { pid: proc.pid, ptyHandle: proc, startedAt: new Date().toISOString() });
  return { pid: proc.pid };
}

export async function stopAgent(name) {
  if (!SAFE_NAME_RE.test(name)) {
    throw Object.assign(new Error('Invalid agent name'), { statusCode: 400 });
  }

  markStopped(name);

  const tracked = processes.get(name);
  if (tracked?.ptyHandle) {
    try { tracked.ptyHandle.kill(); } catch {}
  }
  if (tracked?.pid) {
    try { process.kill(tracked.pid, 'SIGKILL'); } catch {}
  }

  // Best-effort kill by PID file (covers ptyHandle-gone case)
  const pidFile = join(AGENTS_BASE_DIR || '', name, '.agent.pid');
  if (pidFile && existsSync(pidFile)) {
    try {
      const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
      if (pid > 0) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    } catch {}
    try { unlinkSync(pidFile); } catch {}
  }

  processes.delete(name);
  return { stopped: name };
}

/**
 * Headless "screenshot" — there is no compositor, so we return the recent
 * scrollback as a UTF-8 text snapshot written to SCREENSHOTS_DIR.
 * The Dashboard already renders the live terminal via WebSocket; this
 * fallback exists for /api/agents/:name/screenshot consumers (e.g. CEO).
 */
export async function screenshotAgent(name) {
  if (!SAFE_NAME_RE.test(name)) {
    throw Object.assign(new Error('Invalid agent name'), { statusCode: 400 });
  }
  if (!processes.has(name)) {
    throw Object.assign(new Error(`No tracked process for agent "${name}"`), { statusCode: 400 });
  }

  let snapshot = '';
  try {
    const m = await import('./pty-manager.mjs');
    snapshot = m.getScrollbackText?.(name) ?? '';
  } catch {}

  const outPath = join(SCREENSHOTS_DIR, `${name}.txt`);
  writeFileSync(outPath, snapshot || `(no scrollback for ${name})\n`, 'utf-8');
  return { path: outPath, kind: 'text' };
}

export async function sendKeysToAgent(name, keys) {
  if (!SAFE_NAME_RE.test(name)) {
    throw Object.assign(new Error('Invalid agent name'), { statusCode: 400 });
  }
  const tracked = processes.get(name);
  if (!tracked?.ptyHandle) {
    throw Object.assign(new Error(`No tracked process for agent "${name}"`), { statusCode: 400 });
  }

  // ANSI sequences expected by claude's TUI
  const keyMap = {
    enter:  '\r',
    tab:    '\t',
    escape: '\x1b',
    up:     '\x1b[A',
    down:   '\x1b[B',
    right:  '\x1b[C',
    left:   '\x1b[D',
    '1': '1', '2': '2', '3': '3', 'y': 'y', 'n': 'n',
  };
  const bytes = keyMap[String(keys).toLowerCase()];
  if (bytes == null) {
    throw Object.assign(
      new Error(`Invalid key "${keys}". Allowed: ${Object.keys(keyMap).join(', ')}`),
      { statusCode: 400 }
    );
  }
  try { tracked.ptyHandle.write(bytes); } catch (e) {
    throw Object.assign(new Error(`PTY write failed: ${e.message}`), { statusCode: 500 });
  }
  return { sent: keys };
}

export function cleanupStaleProcEntry(name) {
  if (processes.has(name)) processes.delete(name);
}

export function getAgentProcessStatus(name) {
  const proc = processes.get(name);
  return proc
    ? { tracked: true, pid: proc.pid, startedAt: proc.startedAt, running: true }
    : { tracked: false, running: false, pid: null };
}

const ALLOWED_ROLES = ['CEO', '人力资源'];
export function checkProcessPermission(agent) {
  return agent && (
    agent.name === 'Chairman' || agent.name === 'CEO' || agent.name === 'HR' ||
    ALLOWED_ROLES.includes(agent.role)
  );
}
