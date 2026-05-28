/**
 * codex-pty-runner.mjs — Runtime for `runtime=codex-pty` agents.
 *
 * Unlike codex-agent-runner.mjs (SDK / JSON-RPC under the hood, custom event
 * log), this runner spawns the NATIVE codex.exe in a ConPTY via the PTY
 * Daemon, exactly the way claude agents are spawned. The Dashboard Terminal
 * renders the real ratatui TUI byte-for-byte — `/model`, `/diff`, `@file`,
 * Plan mode, ESC interrupt, ↑ history, the welcome screen — all of it.
 *
 * What we add on top of "just a PTY":
 *   • Inbox events: paste the message via bracketed-paste then submit with a
 *     win32-input-mode Enter (probe confirmed codex enables \x1b[?9001h).
 *   • MCP server config: injected with --config args at spawn so the global
 *     ~/.codex/config.toml is untouched.
 *
 * What we DON'T do here (vs SDK runner):
 *   • formatEvent / __ptyWsBroadcast — raw PTY bytes flow directly to xterm
 *     via the existing daemon-output → broadcast path (no extra hop).
 *   • Per-turn usage metrics — those live inside codex's TUI footer; if we
 *     ever need them they have to be scraped from the rendered text.
 *   • Thread resume across server restarts — the codex.exe PROCESS stays
 *     alive across hot-restart (daemon owns it), so the thread state never
 *     leaves memory.
 */

import { join } from 'node:path';
import { mkdirSync, existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { getAgentByName, setAgentStatus } from './db.mjs';
import {
  writeToPty as ipcWriteToPty,
  isConnected as isDaemonConnected,
  listPtys,
} from './pty-daemon-client.mjs';
import {
  spawnPtyViaDaemon,
  getHandleByAgent,
  makeReattachHandle,
} from './spawn-pty-via-daemon.mjs';
import { registerWsAgent } from './pty-manager.mjs';

const AGENTS_BASE_DIR = process.env.AGENTS_BASE_DIR;
const SERVER_URL = process.env.TEAMMCP_URL || 'http://localhost:3100';
const CHANNEL_PLUGIN_PATH = join(
  process.env.TEAMMCP_HOME || process.cwd(),
  'plugin-dist', 'mcp-client', 'teammcp-channel.mjs'
).replace(/\\/g, '/');

// Default codex.exe path; can be overridden via CODEX_EXE env.
const CODEX_EXE = process.env.CODEX_EXE ||
  'C:/Users/ssdlh/AppData/Roaming/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe';

// Submit key. codex enables win32-input-mode (\x1b[?9001h) at startup, so
// the canonical Enter is the encoded key event (press + release):
//   \x1b[Vk;Sc;Uc;Kd;Cs;Rc_  → Vk=13 (VK_RETURN), Sc=28, Uc=13 (CR),
//   Kd=1 down / 0 up, Cs=0, Rc=1.
// History: on older codex builds plain CRLF ('\r\n') triggered submit and the
// win32 form did NOT, so we shipped '\r\n'. As of codex-cli 0.133.0 that
// reversed — CRLF leaves the text sitting in the input box and only the win32
// encoded Enter submits (re-verified 2026-05-28 via
// scripts/codex-test/test-enter-variants.mjs, variant V1). Revisit with that
// harness if a future codex version breaks it again.
const SUBMIT_KEY = '\x1b[13;28;13;1;0;1_\x1b[13;28;13;0;0;1_';

function bracketedPaste(text) {
  // If the message ever contains the paste-end terminator we'd close paste
  // mode early and the rest would be interpreted as TUI input. Strip it.
  const safe = text.replace(/\x1b\[201~/g, '');
  return `\x1b[200~${safe}\x1b[201~`;
}

// ── Spawn args ─────────────────────────────────────────────────
function agentDir(name) {
  if (!AGENTS_BASE_DIR) throw new Error('AGENTS_BASE_DIR not set');
  return join(AGENTS_BASE_DIR, name);
}

function buildCodexArgs(name, apiKey) {
  // --config takes TOML-syntax values. Dotted paths build the nested
  // mcp_servers.<name> table without touching the per-agent CODEX_HOME's
  // config.toml. We pass each --config / value as separate argv tokens
  // because PTY spawn doesn't go through a shell — no quoting hell.
  //
  // model_reasoning_effort is set via the per-agent config.toml (see
  // ensureAgentCodexHome) rather than --config, because the global
  // ~/.codex/config.toml's setting takes priority over CLI --config in
  // some codex versions.
  return [
    '--config', `mcp_servers.teammcp.command="node"`,
    '--config', `mcp_servers.teammcp.args=["${CHANNEL_PLUGIN_PATH}"]`,
    '--config', `mcp_servers.teammcp.env.AGENT_NAME="${name}"`,
    '--config', `mcp_servers.teammcp.env.TEAMMCP_KEY="${apiKey}"`,
    '--config', `mcp_servers.teammcp.env.TEAMMCP_URL="${SERVER_URL}"`,
  ];
}

/**
 * Materialise a per-agent CODEX_HOME so we can pin reasoning effort (and
 * eventually other overrides) without touching the user's global config.
 *
 * Strategy: copy the user's global ~/.codex/config.toml + auth.json to
 * <agentDir>/.codex/, then rewrite model_reasoning_effort = "medium" in
 * the copied config.toml. Skip overwrite if the per-agent file already
 * exists AND already has medium effort (idempotent on re-spawn).
 */
function ensureAgentCodexHome(agentName) {
  const dir = join(agentDir(agentName), '.codex');
  try { mkdirSync(dir, { recursive: true }); } catch {}

  const globalHome = join(homedir(), '.codex');

  // Copy auth.json so codex can authenticate as our user without re-login.
  const srcAuth = join(globalHome, 'auth.json');
  const dstAuth = join(dir, 'auth.json');
  if (existsSync(srcAuth) && !existsSync(dstAuth)) {
    try { copyFileSync(srcAuth, dstAuth); } catch (e) {
      console.warn(`[codex-pty] copy auth.json failed: ${e.message}`);
    }
  }

  // Generate config.toml. Start from the user's global config (preserves
  // model choice, project trust, etc.) then force-override the one knob
  // we care about. Re-runs on every spawn so user-side global edits are
  // picked up at the next agent restart.
  const dstCfg = join(dir, 'config.toml');
  let body = '';
  const srcCfg = join(globalHome, 'config.toml');
  if (existsSync(srcCfg)) {
    try {
      body = readFileSync(srcCfg, 'utf-8');
    } catch (e) {
      console.warn(`[codex-pty] read global config.toml failed: ${e.message}`);
    }
  }
  // Strip any pre-existing top-level keys we're about to override. We only
  // touch the top scope; any `[profiles.X]` section's values are left alone.
  body = body
    .replace(/^model_reasoning_effort\s*=.*$/m, '')
    .replace(/^approval_policy\s*=.*$/m, '')
    .replace(/^sandbox_mode\s*=.*$/m, '');

  // PREPEND (not append) the override. TOML is positional: appending after
  // a `[section]` header would slot the line into THAT section. The user's
  // global config ends with `[tui.model_availability_nux]` followed by
  // `"gpt-5.5" = 4`; appending `model_reasoning_effort = "medium"` there
  // makes codex parse it as `tui.model_availability_nux.model_reasoning_effort`
  // and panic ("expected u32"). Top-of-file is always the bare table.
  //
  // approval_policy="never" + sandbox_mode="danger-full-access" matches what
  // the SDK runtime sets — without these, codex's TUI sits waiting for human
  // Y/N on the first tool call, the daemon's PTY heartbeat eventually times
  // out, and codex dies. This was the root cause of the "ToolCall decided
  // but never dispatched + process disappeared" pattern.
  const header =
    '# teammcp codex-pty overrides — see server/codex-pty-runner.mjs\n' +
    'model_reasoning_effort = "medium"\n' +
    'approval_policy = "never"\n' +
    'sandbox_mode = "danger-full-access"\n\n';
  body = header + body.trimStart();
  try {
    writeFileSync(dstCfg, body, 'utf-8');
  } catch (e) {
    console.warn(`[codex-pty] write per-agent config.toml failed: ${e.message}`);
  }

  return dir;
}

function getAgentApiKey(agent) {
  return agent.api_key || process.env.TEAMMCP_KEY || null;
}

// ── Lifecycle ──────────────────────────────────────────────────

/**
 * Start the native codex TUI for an agent. Idempotent: if a daemon-side
 * handle already exists (e.g. server restart found it), reuse it.
 */
export async function startAgent(name) {
  const agent = getAgentByName(name);
  if (!agent) throw new Error(`agent not found: ${name}`);
  if (agent.runtime !== 'codex-pty') {
    throw new Error(`agent ${name} runtime is "${agent.runtime}", not codex-pty`);
  }

  if (!isDaemonConnected()) {
    throw new Error('PTY Daemon not connected — cannot spawn codex-pty agent');
  }

  // If the daemon already owns a PTY for this agent (post hot-restart),
  // spawn-pty-via-daemon's reattach loop already wired a handle. Reuse it.
  const existing = getHandleByAgent(name);
  if (existing) {
    try { setAgentStatus(name, 'online'); } catch {}
    try { registerWsAgent(name); } catch {}
    return { name, pid: existing.pid, reattached: true };
  }

  // Race-safe path: handle may not be wired yet (the index.mjs reattach
  // loop runs in a parallel IIFE). Query the daemon directly; if it knows
  // about a PTY for this agent, adopt it via makeReattachHandle rather
  // than calling spawnPtyViaDaemon (which would fail with "already has
  // running PTY").
  try {
    const list = await listPtys();
    const items = list?.handles || list?.agents || (Array.isArray(list) ? list : []);
    const match = items.find(p => (p.agent || p.agentId || p.name) === name);
    if (match) {
      const handleId = match.handleId || match.handle_id;
      const pid = match.pid;
      if (handleId) {
        const h = makeReattachHandle({ agentId: name, handleId, pid });
        try { setAgentStatus(name, 'online'); } catch {}
        try { registerWsAgent(name); } catch {}
        console.log(`[codex-pty] adopted daemon PTY for ${name} pid=${pid}`);
        return { name, pid: h.pid, reattached: true };
      }
    }
  } catch (e) {
    console.warn(`[codex-pty] daemon listPtys probe failed: ${e.message} — will spawn fresh`);
  }

  const apiKey = getAgentApiKey(agent);
  if (!apiKey) {
    throw new Error(`agent ${name} has no api_key`);
  }

  // Build per-agent CODEX_HOME with our reasoning_effort override applied
  // on top of the user's global config + auth. This is the only reliable
  // way to override model_reasoning_effort — CLI --config doesn't win
  // against the global config.toml setting in codex 0.133.
  const codexHome = ensureAgentCodexHome(name);

  const args = buildCodexArgs(name, apiKey);
  // The daemon's sanitizeEnv rejects spawns with >64 env keys. Spreading
  // ...process.env trips the cap (typical Windows host has 80+). Hand it a
  // curated allow-list, same pattern as the claude spawn path uses.
  const HOST_ENV_PASSTHROUGH = [
    'PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA',
    'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'TEMP', 'TMP',
    'TERM', 'LANG', 'TZ', 'PROCESSOR_ARCHITECTURE',
  ];
  const env = {};
  for (const k of HOST_ENV_PASSTHROUGH) {
    if (process.env[k] != null) env[k] = process.env[k];
  }
  // Keep keyboard enhancement ON — we depend on win32-input-mode for
  // programmatic Enter injection.
  env.CODEX_TUI_DISABLE_KEYBOARD_ENHANCEMENT = '';
  // Point codex at the per-agent config + auth dir.
  env.CODEX_HOME = codexHome;
  // codex's MCP teammcp server needs these (we inject via --config but the
  // MCP process itself reads from its own env at startup):
  env.AGENT_NAME = name;
  env.TEAMMCP_KEY = apiKey;
  env.TEAMMCP_URL = SERVER_URL;

  const handle = await spawnPtyViaDaemon(name, CODEX_EXE, args, {
    cwd: agentDir(name),
    env,
    cols: 120,
    rows: 30,
  });

  // Reserve the WS slot so /api/pty-sessions lists the agent immediately.
  // The actual PTY bytes flow via the global daemon-output → broadcast path
  // (wired in index.mjs); we do NOT subscribe per-handle here.
  registerWsAgent(name);

  try { setAgentStatus(name, 'online'); } catch {}

  console.log(`[codex-pty] started ${name} pid=${handle.pid}`);
  return { name, pid: handle.pid, reattached: false };
}

export async function stopAgent(name) {
  const handle = getHandleByAgent(name);
  // Force-disconnect any stale SSE clients before/around the kill, so the
  // /api/agents/:name/start endpoint's isOnline check sees a clean state.
  // (Stale plugin:fakechat from a prior claude runtime can hold the SSE
  // open even after the PTY is gone.)
  try {
    const { disconnectAgent } = await import('./sse.mjs');
    disconnectAgent(name);
  } catch (e) {
    console.warn(`[codex-pty] disconnectAgent(${name}) failed:`, e.message);
  }
  if (!handle) {
    try { setAgentStatus(name, 'offline'); } catch {}
    return { stopped: false, reason: 'not_running' };
  }
  try { await handle.kill('user_stop'); } catch {}
  try { setAgentStatus(name, 'offline'); } catch {}
  return { stopped: true };
}

export function isRunning(name) {
  return !!getHandleByAgent(name);
}

// ── Inbox event injection ──────────────────────────────────────
/**
 * Type the inbox message into codex's TUI input box and submit.
 *
 * Sequence:
 *   1. Bracketed paste the prompt text (codex treats it as a single paste,
 *      no special-char interpretation)
 *   2. Brief delay so the TUI renders the pasted text into its input widget
 *   3. Win32-input-mode Enter (press + release) to submit
 */
export async function deliverInboxEvent(name, event) {
  if (!isRunning(name)) return { delivered: false, reason: 'agent_not_running' };
  if (event.type !== 'message') return { delivered: false, reason: 'non_message_event' };

  const channel = event.channel || '?';
  const from = event.from || 'system';
  const content = event.content || '';

  const isDm = channel.startsWith('dm:');
  const replyHint = isDm
    ? `send_dm (to ${from})`
    : `send_message (channel='${channel}')`;
  const prompt =
    `[INBOX EVENT]\n` +
    `channel: ${channel}\n` +
    `from: ${from}\n` +
    `message: ${content}\n` +
    `\n` +
    `You are agent "${name}" responding via TeamMCP. ` +
    `For any question, instruction, request, or greeting → reply by calling the teammcp MCP server's ${replyHint} tool. ` +
    `For pure status/info that does not require a reply → call teammcp's ack_inbox tool to mark it read. ` +
    `Pick one action and execute it now. Do not skip the tool call.`;

  try {
    await ipcWriteToPty(name, bracketedPaste(prompt));
  } catch (e) {
    console.error(`[codex-pty] paste failed for ${name}:`, e.message);
    return { delivered: false, reason: 'paste_failed' };
  }

  // Let codex's TUI consume the paste before we hit submit. The TUI batches
  // input on a render tick (~16ms); 150ms is a comfortable margin.
  await new Promise(r => setTimeout(r, 150));

  try {
    await ipcWriteToPty(name, SUBMIT_KEY);
  } catch (e) {
    console.error(`[codex-pty] submit failed for ${name}:`, e.message);
    return { delivered: false, reason: 'submit_failed' };
  }

  return { delivered: true };
}

// ── Boot-time resume ───────────────────────────────────────────
/**
 * After server boot + daemon-side reattach loop runs, walk the DB for any
 * codex-pty agent that doesn't yet have a handle and start it fresh.
 *
 * Idempotent — startAgent reuses existing handles when present.
 */
export async function resumeAllOnBoot() {
  console.log('[codex-pty] resumeAllOnBoot: starting');
  const { default: db } = await import('./db.mjs');
  const rows = db.prepare("SELECT name FROM agents WHERE runtime = 'codex-pty'").all();
  console.log(`[codex-pty] resumeAllOnBoot: ${rows.length} runtime=codex-pty rows`);

  let started = 0, reattached = 0, failed = 0;
  for (const row of rows) {
    try {
      const r = await startAgent(row.name);
      if (r.reattached) reattached++; else started++;
      console.log(`[codex-pty] ${r.reattached ? 'reattached' : 'started'} ${row.name} pid=${r.pid}`);
    } catch (e) {
      failed++;
      console.error(`[codex-pty] startAgent(${row.name}) failed:`, e.message);
    }
  }
  console.log(`[codex-pty] resumeAllOnBoot: ${started} started, ${reattached} reattached, ${failed} failed`);
  return { started, reattached, failed };
}
