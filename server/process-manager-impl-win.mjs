/**
 * Process Manager — spawn and stop Agent (Claude Code) processes.
 * Windows-specific: uses PowerShell for process management, screenshots, and input simulation.
 */

import { exec, execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, copyFileSync, readdirSync, statSync, lstatSync, cpSync, symlinkSync, linkSync, watch, rmSync, renameSync } from 'node:fs';

// Doc-A v1.6 §11 dedupe (§6 #13): Path A constants moved to path-a-constants.mjs.
// Do NOT inline new Path A magic numbers here — extend path-a-constants.mjs instead.
import {
  PATH_A_SCOPES,
  PATH_A_SUB_TYPE,
  PATH_A_RATE_LIMIT_TIER,
} from './path-a-constants.mjs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, homedir } from 'node:os';
import { getUseResume, getAgentByName, getAgentsNeedingRouter, setState as dbSetState, saveMessage } from './db.mjs';
import { AGENTS_DIR, SCREENSHOTS_DIR, ensureDirectories } from './lib/paths.mjs';
import { startAuthMonitor, stopAuthMonitor, clearAgent as clearAuthMonitorAgent } from './auth-monitor.mjs';

// agentName → { pid, startedAt }
const processes = new Map();

// Track agents that were intentionally stopped (to suppress crash detection)
const stoppedAgents = new Set();
export function markStopped(name) { stoppedAgents.add(name); }
export function clearStopped(name) { stoppedAgents.delete(name); }
export function isStopped(name) { return stoppedAgents.has(name); }

// ── ccrouter process management ─────────────────────────
const CCROUTER_PORT = 3456;
const CCROUTER_CONFIG_DIR = join(homedir(), '.claude-code-router');
const CCROUTER_CONFIG_PATH = join(CCROUTER_CONFIG_DIR, 'config.json');
let ccrouterPid = null;

// Support env var override for backward compatibility
const AGENTS_BASE_DIR = process.env.AGENTS_BASE_DIR || AGENTS_DIR;

if (!AGENTS_BASE_DIR) {
  console.warn('[process-manager] WARNING: AGENTS_BASE_DIR not set. Agent start/stop/screenshot will fail.');
}

// Ensure directories exist
ensureDirectories();

// Doc-C Layer 3 v0: start passive auth monitor (CTO spec, A 实施 2026-04-09)
// Injects db setState + saveMessage as deps. Fires-and-forgets: any failure inside
// the monitor is logged but never affects process management.
if (AGENTS_BASE_DIR) {
  try {
    startAuthMonitor(processes, AGENTS_BASE_DIR, {
      setState: (key, value) => {
        // key format: 'auth/<agent>/last_failure' → projectId='auth', field='<agent>/last_failure'
        try {
          const firstSlash = key.indexOf('/');
          const projectId = firstSlash > 0 ? key.slice(0, firstSlash) : 'auth';
          const field = firstSlash > 0 ? key.slice(firstSlash + 1) : key;
          dbSetState(projectId, field, value, 'system:auth-monitor', 'Doc-C Layer 3 v0 passive auth-failure detection', { isHumanOverride: true });
        } catch (e) { console.error('[auth-monitor] setState failed:', e.message); }
      },
      sendMessage: (channel, content) => {
        try {
          // Pre-fix #3: force real channel id 'general' (caller may pass '#general' placeholder)
          // saveMessage(channelId, fromAgent, content, mentions, replyTo, metadata)
          saveMessage('general', 'System', content, null, null, JSON.stringify({ source: 'auth-monitor' }));
        } catch (e) { console.error('[auth-monitor] sendMessage failed:', e.message); }
      },
      logger: console,
    });
  } catch (e) {
    console.error('[process-manager] startAuthMonitor failed:', e.message);
  }
}

// Only allow safe agent names (letters, digits, hyphen, underscore)
export const SAFE_NAME_RE = /^[A-Za-z0-9_.\-]+$/;

// SecTest fix (PS injection defense-in-depth):
// PowerShell single-quoted literals do NOT interpolate $vars / $(expr) / `escapes`,
// so wrap untrusted strings in single quotes and escape internal single quotes by
// doubling. Stops a hostile DB value (api_auth_token, agent name, etc.) from
// breaking out of the string and executing arbitrary PowerShell.
function psSingleQuote(value) {
  const s = (value == null) ? '' : String(value);
  return "'" + s.replace(/'/g, "''") + "'";
}

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
        const independentDirs = new Set(['sessions', 'plans', 'tasks', 'todos', 'shell-snapshots', 'teams', 'projects', 'file-history', 'skills']);
        const sharedDirs = new Set(['plugins', 'cache', 'statsig', 'telemetry', 'debug', 'backups', 'ide', 'paste-cache']);
        try {
          if (independentDirs.has(entry)) {
            // Per-agent independent directories — create empty dir
            if (!existsSync(dst)) mkdirSync(dst, { recursive: true });
          } else if (['history.jsonl', 'settings.json'].includes(entry)) {
            // Skip — let Claude Code auto-create these per-agent
          } else if (existsSync(dst)) {
            continue; // don't overwrite existing per-agent state
          } else {
            // Other files use hardlinks (no admin needed, stays in sync with original)
            linkSync(src, dst);
          }
        } catch (e) { console.error(`[start-agent] setup '${entry}' for ${name} failed: ${e.code} ${e.message}`); }
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
      cj.cachedGrowthBookFeatures.tengu_harbor_permissions = true;
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

    // SessionStart/SessionEnd hooks for precise session lifecycle tracking
    const sessionStartHook = [{
      hooks: [{
        type: 'http',
        url: `${serverUrl}/api/session-start?key=${agentKey}`
      }]
    }];
    settings.hooks.SessionStart = sessionStartHook;

    const sessionEndHook = [{
      hooks: [{
        type: 'http',
        url: `${serverUrl}/api/session-end?key=${agentKey}`
      }]
    }];
    settings.hooks.SessionEnd = sessionEndHook;
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

    // SessionStart/SessionEnd hooks (config dir copy)
    configSettings.hooks.SessionStart = [{
      hooks: [{ type: 'http', url: `${serverUrl}/api/session-start?key=${agentKey}` }]
    }];
    configSettings.hooks.SessionEnd = [{
      hooks: [{ type: 'http', url: `${serverUrl}/api/session-end?key=${agentKey}` }]
    }];
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

  // Get agent info from DB (used for auth config)
  const agentInfo = getAgentByName(name);

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

  // Restore shared dirs junctions AFTER plugin install (which recreates these dirs)
  // Use cmd /c mklink /J instead of symlinkSync — avoids EPERM on Windows
  const sharedDirs = new Set(['plugins', 'cache', 'statsig', 'telemetry', 'debug', 'backups', 'ide', 'paste-cache']);
  const mainClaudeDir = join(homedir(), '.claude');
  for (const entry of sharedDirs) {
    const src = join(mainClaudeDir, entry);
    const dst = join(configDir, entry);
    if (existsSync(src) && statSync(src).isDirectory()) {
      try {
        if (existsSync(dst) && !lstatSync(dst).isSymbolicLink()) {
          rmSync(dst, { recursive: true, force: true });
        }
        if (!existsSync(dst)) {
          execSync(`cmd /c mklink /J "${dst}" "${src}"`, { stdio: 'ignore', timeout: 5000 });
        }
      } catch (e) { console.error(`[start-agent] restore junction '${entry}' for ${name} failed: ${e.message}`); }
    }
  }

  // Windows: use Windows Terminal with new window and title for tracking
  // Generate a startup script to avoid multi-layer argument escaping issues
  const windowTitle = `Agent-${name}`;
  const startScript = join(agentDir, '_start_fakechat.ps1');
  const pidFile = join(agentDir, '.agent.pid');
  const useResume = false; // Channel mode: always fresh session
  const continueFlag = '';

  // If agent needs ccrouter, ensure it's running and override api_base_url
  // Only providers that need request transformation (openrouter) require ccrouter.
  // Direct providers (xiaomi, etc.) bypass ccrouter and connect directly.
  const ROUTER_PROVIDERS = new Set(['openrouter', 'openai']);
  let effectiveAgentInfo = agentInfo;
  if (agentInfo && agentInfo.auth_mode === 'api_key' && agentInfo.api_provider) {
    if (ROUTER_PROVIDERS.has(agentInfo.api_provider.toLowerCase())) {
      const routerStarted = await ensureCCRouter();
      if (routerStarted) {
        effectiveAgentInfo = { ...agentInfo, api_base_url: `http://127.0.0.1:${CCROUTER_PORT}` };
      } else {
        console.warn(`[start-agent] ccrouter failed to start, using direct API for ${name}`);
      }
    }
    // else: use provider's direct base_url (no ccrouter needed)
  }

  // Build startup script with PowerShell $env: syntax (inherited by child processes)
  const ps1Lines = [
    `Set-Location "${agentDir}"`,
    `$env:CLAUDE_CONFIG_DIR = "${configDir}"`,
    `$env:CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1"`,
  ];
  if (agentKey) {
    ps1Lines.push(`$env:TEAMMCP_KEY = ${psSingleQuote(agentKey)}`);
    ps1Lines.push(`$env:AGENT_NAME = ${psSingleQuote(name)}`);
  }
  ps1Lines.push(`$env:TEAMMCP_URL = ${psSingleQuote(serverUrl)}`);
  if (effectiveAgentInfo && effectiveAgentInfo.auth_mode === 'api_key') {
    ps1Lines.push(`$env:ANTHROPIC_API_KEY = ''`);
    ps1Lines.push(`$env:CLAUDE_CODE_OAUTH_TOKEN = 'channel-gate-bypass'`);
    if (effectiveAgentInfo.api_base_url) ps1Lines.push(`$env:ANTHROPIC_BASE_URL = ${psSingleQuote(effectiveAgentInfo.api_base_url)}`);
    if (effectiveAgentInfo.api_auth_token) ps1Lines.push(`$env:ANTHROPIC_AUTH_TOKEN = ${psSingleQuote(effectiveAgentInfo.api_auth_token)}`);
    if (effectiveAgentInfo.api_model) ps1Lines.push(`$env:ANTHROPIC_MODEL = ${psSingleQuote(effectiveAgentInfo.api_model)}`);
  }
  const channelFlag = '--channels plugin:fakechat@claude-plugins-official';
  // Doc-C Layer 3 v0.2: stdout NOT piped — TTY preserved, CC session jsonl used by watcher
  // Permission mode: TestDev uses 'default' for channel permission testing; all others bypass
  const permFlags = (name === 'TestDev') ? '--permission-mode default' : '--dangerously-skip-permissions --permission-mode bypassPermissions';
  ps1Lines.push(`claude ${continueFlag}${permFlags} ${channelFlag}`);

  // Path A: inject refreshToken-null credentials for path_a agents
  {
    const agentInfo = (typeof getAgentByName === 'function') ? getAgentByName(name) : null;
    if (agentInfo?.auth_strategy === 'path_a' && agentInfo?.auth_mode !== 'api_key') {
      const credPath = join(configDir, '.credentials.json');
      // Doc-A v1.6 §11.10 (M1) — TOCTOU between lstatSync and writeFileSync.
      // Acquire an exclusive lock file BEFORE the lstat→write window, hold it
      // across stat + unlink + atomic-rename, release in finally. The lock is
      // created with O_EXCL ('wx'), so two concurrent injectors can never both
      // pass the symlink/hardlink guard.
      const lockPath = credPath + '.lock';
      let lockHeld = false;
      try {
        // Try to grab the lock. One short retry covers a stale lock from a
        // crashed sibling; a second EEXIST throws loudly so we don't race.
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
            lockHeld = true;
            break;
          } catch (e) {
            if (e.code !== 'EEXIST') throw e;
            if (attempt === 0) {
              // Stale-lock recovery: if lock is older than 30s, blow it away.
              try {
                const lst = lstatSync(lockPath);
                if (Date.now() - lst.mtimeMs > 30_000) unlinkSync(lockPath);
              } catch {}
              continue;
            }
            throw Object.assign(
              new Error(`Path A inject: lock contention at ${lockPath}`),
              { code: 'PATH_A_LOCK_BUSY' }
            );
          }
        }

        // §4.3 hardlink/symlink guard — now safe under the lock.
        try {
          const st = lstatSync(credPath);
          if (st.nlink > 1 || st.isSymbolicLink()) unlinkSync(credPath);
        } catch (e) { if (e.code !== 'ENOENT') throw e; }

        // Lease a fresh token from in-process credential-manager
        const { leaseTokenForAgent } = await import('./credential-lease.mjs');
        const lease = await leaseTokenForAgent(name, 'start');

        const doc = {
          claudeAiOauth: {
            accessToken: lease.accessToken,
            refreshToken: null,
            expiresAt: lease.expiresAt,
            scopes: PATH_A_SCOPES,
            subscriptionType: PATH_A_SUB_TYPE,
            rateLimitTier: PATH_A_RATE_LIMIT_TIER,
          },
        };

        // §4.4 atomic write — still under the lock, so the rename target
        // cannot have been swapped to a symlink between guard and write.
        const tmp = credPath + '.tmp.' + process.pid;
        writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf-8');
        renameSync(tmp, credPath);
        console.log(`[start-agent] Path A injection ok for ${name}, leaseId=${lease.leaseId}`);
      } catch (err) {
        throw Object.assign(
          new Error(`Path A: cannot start ${name}, lease failed: ${err.message}`),
          { statusCode: 503, cause: err }
        );
      } finally {
        if (lockHeld) {
          try { unlinkSync(lockPath); } catch {}
        }
      }
    }
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
    const findPid = await execPSFile(`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*\\${name}\\_start_fakechat.ps1*' -and $_.Name -eq 'powershell.exe' } | Select-Object -First 1 -ExpandProperty ProcessId`);
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
  try { clearAuthMonitorAgent(name); } catch {}

  // Note: Don't kill WindowsTerminal.exe — multiple agents may share the same WT process.
  // WT windows auto-close via closeOnExit:always when the agent process ends.

  if (!killed) {
    console.warn(`[stopAgent] No running process found for "${name}", marking as stopped`);
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
  try { clearAuthMonitorAgent(name); } catch {}
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

// ── ccrouter lifecycle management ────────────────────────

/**
 * Check if ccrouter is needed: any API key agent with api_provider set
 */
function isCCRouterNeeded() {
  try {
    const agents = getAgentsNeedingRouter();
    return agents.length > 0;
  } catch { return false; }
}

/**
 * Generate ccrouter config.json from DB agent configurations
 */
function generateCCRouterConfig() {
  const agents = getAgentsNeedingRouter();

  // Group agents by provider to deduplicate
  const providerMap = new Map();
  for (const agent of agents) {
    const key = `${agent.api_provider}|${agent.api_base_url}`;
    if (!providerMap.has(key)) {
      providerMap.set(key, {
        name: agent.api_provider,
        api_base_url: agent.api_base_url,
        api_key: agent.api_auth_token,
        models: [],
        transformer: { use: [agent.api_provider] }
      });
    }
    const provider = providerMap.get(key);
    if (agent.api_model && !provider.models.includes(agent.api_model)) {
      provider.models.push(agent.api_model);
    }
  }

  const providers = [...providerMap.values()];

  // Build router defaults from first provider/model
  const defaultProvider = providers[0];
  const defaultModel = defaultProvider?.models[0] || '';
  const routerDefault = defaultProvider ? `${defaultProvider.name},${defaultModel}` : '';

  const config = {
    HOST: '127.0.0.1',
    PORT: CCROUTER_PORT,
    LOG: true,
    LOG_LEVEL: 'info',
    API_TIMEOUT_MS: 600000,
    NON_INTERACTIVE_MODE: true,
    Providers: providers,
    Router: {
      default: routerDefault
    }
  };

  if (!existsSync(CCROUTER_CONFIG_DIR)) {
    mkdirSync(CCROUTER_CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CCROUTER_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  console.log(`[ccrouter] config generated: ${providers.length} providers, ${agents.length} agents`);
  return config;
}

/**
 * Start ccrouter if not already running
 */
async function ensureCCRouter() {
  // Check if already running (by PID)
  if (ccrouterPid) {
    try {
      const check = await execPS(`Get-Process -Id ${ccrouterPid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`);
      if (check.trim()) return true; // still running
    } catch {}
    ccrouterPid = null;
  }

  // Check if port is already in use (ccrouter started externally)
  try {
    const portCheck = await execPS(`Get-NetTCPConnection -LocalPort ${CCROUTER_PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess`);
    if (portCheck.trim()) {
      ccrouterPid = parseInt(portCheck.trim(), 10);
      console.log(`[ccrouter] already running on port ${CCROUTER_PORT} (PID: ${ccrouterPid})`);
      return true;
    }
  } catch {}

  // Generate config from DB
  generateCCRouterConfig();

  // Start ccrouter
  console.log(`[ccrouter] starting on port ${CCROUTER_PORT}...`);
  try {
    const child = exec('npx @musistudio/claude-code-router start', {
      shell: 'cmd.exe',
      detached: true,
      stdio: 'ignore',
      env: { ...process.env }
    });
    child.unref();

    // Wait for port to become available
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const check = await execPS(`Get-NetTCPConnection -LocalPort ${CCROUTER_PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess`);
        if (check.trim()) {
          ccrouterPid = parseInt(check.trim(), 10);
          console.log(`[ccrouter] started (PID: ${ccrouterPid})`);
          return true;
        }
      } catch {}
    }
    console.error('[ccrouter] failed to start within 30s');
    return false;
  } catch (e) {
    console.error(`[ccrouter] start failed: ${e.message}`);
    return false;
  }
}

/**
 * Stop ccrouter process
 */
async function stopCCRouter() {
  if (ccrouterPid) {
    try {
      exec(`taskkill /PID ${ccrouterPid} /T /F`, { shell: 'cmd.exe' });
      console.log(`[ccrouter] stopped (PID: ${ccrouterPid})`);
    } catch {}
    ccrouterPid = null;
  }
}

// Export for router.mjs if needed
export { ensureCCRouter, stopCCRouter, generateCCRouterConfig };

// TODO: Credential management moved to credential-manager.mjs
// Old syncCredentials + file watchers + refreshOAuthToken code removed.
// New credential-manager.mjs will handle: login, refresh, distribute.
