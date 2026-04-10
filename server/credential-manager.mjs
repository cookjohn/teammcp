/**
 * credential-manager.mjs — Unified OAuth credential management for TeamMCP.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DESIGN DECISIONS — How we solve the 4 known traps
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Trap 1: Race with Claude Code's internal refresh
 *   Claude SDK refreshes on 401 with a ~5 min buffer. We use a 30 min buffer
 *   so we always refresh first. If an agent's Claude Code still manages to
 *   refresh first (e.g. 401 mid-request), we detect the newer token via mtime
 *   check in collectAgentTokens() and do a one-way reverse sync:
 *     - Agent token is newer AND contains "accessToken" → copy to TokenStore
 *     - Empty or invalid agent token → skip (never overwrite valid with garbage)
 *
 * Trap 2: Distributor atomic write path
 *   Claude Code reads ~/.claude-config/.credentials.json directly. We write
 *   to .credentials.json.tmp.{pid} then renameSync — rename is atomic on all
 *   platforms. We never use hardlink (any atomic write on either side breaks it).
 *
 * Trap 3: Real-time redistribution on refresh
 *   refreshOAuthToken() calls distributeToAgents() on every success.
 *   This writes the new token file for ALL agents (online or not).
 *   Claude Code picks up the new file on next read — no restart needed.
 *   We do NOT use event bus; direct fs writes only.
 *
 * Trap 4: Cross-process lockfile on Windows
 *   We use fs.openSync(lockPath, 'wx') — exclusive create, fails if exists.
 *   Stale detection: lock file older than 60s is considered abandoned.
 *   We do NOT use flock (unreliable on Windows).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Storage:  ${TEAMMCP_HOME}/oauth-credentials.json (defaults to ~/.teammcp/)
 * Lock:     ${TEAMMCP_HOME}/teammcp-oauth.lock
 * Distrib:  agents/xxx/.claude-config/.credentials.json  (atomic copy)
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  statSync,
  unlinkSync,
  readdirSync,
} from 'node:fs';

// ─── Lazy state setter (for alerting on refresh failure) ─────────────────
let _setStateFn = null;
function setStateFn(fn) { _setStateFn = fn; }

// ─── Agent auth check callback (injected by server at init) ──────────────
let _isApiKeyAgent = null;
function setIsApiKeyAgent(fn) { _isApiKeyAgent = fn; }

// ─── Constants ──────────────────────────────────────────────────────────────

if (!process.env.TEAMMCP_HOME) {
  logErr('FATAL: TEAMMCP_HOME env var is not set. Refusing to use silent fallback ~/.teammcp — this has caused orphan credential files before.');
  throw new Error('TEAMMCP_HOME must be set. Check that the server was started via process-manager or start-prod.ps1.');
}
const TEAMMCP_HOME = process.env.TEAMMCP_HOME;
const TOKEN_FILE = join(TEAMMCP_HOME, 'oauth-credentials.json');
const LOCK_FILE = join(TEAMMCP_HOME, 'teammcp-oauth.lock');
// NOTE: AGENTS_BASE_DIR is the canonical env var (set by process-manager).
// TEAMMCP_AGENTS_DIR was a typo kept for backward compat. Prefer AGENTS_BASE_DIR.
const AGENTS_BASE_DIR = process.env.AGENTS_BASE_DIR || process.env.TEAMMCP_AGENTS_DIR;
if (!AGENTS_BASE_DIR) {
  logErr('FATAL: Neither AGENTS_BASE_DIR nor TEAMMCP_AGENTS_DIR env var is set.');
  throw new Error('AGENTS_BASE_DIR must be set.');
}

const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_SCOPES =
  'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';

const REFRESH_CHECK_INTERVAL = 5 * 60_000; // 5 min
const REFRESH_BUFFER = 30 * 60_000; // 30 min — must be > Claude Code's 5 min buffer (Trap 1)
const MAX_RETRIES = 3;
const RETRY_DELAYS = [60_000, 300_000, 900_000]; // 1 min, 5 min, 15 min
const LOCK_STALE_MS = 60_000; // lock older than 60s is stale

const LOG_PREFIX = '[credential-mgr]';

// ─── Logging ────────────────────────────────────────────────────────────────

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

function logErr(...args) {
  console.error(LOG_PREFIX, ...args);
}

// ═══════════════════════════════════════════════════════════════════════════
// Module 1: TokenStore
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Read and parse the credential file.
 * Returns the full parsed object, or null if file is missing / invalid.
 */
function loadCredentials() {
  try {
    if (!existsSync(TOKEN_FILE)) return null;
    const raw = readFileSync(TOKEN_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    logErr('Failed to load credentials:', err.message);
    return null;
  }
}

/**
 * Ensure rotation_seq fields exist on the loaded TokenStore.
 * Migrates legacy stores (written before Doc-B) by initializing
 * rotation_seq=0 and writing atomically. Idempotent.
 */
function ensureRotationSeq(creds) {
  if (!creds || typeof creds !== 'object') return creds;
  if (typeof creds.rotation_seq === 'number') return creds;
  creds.rotation_seq = 0;
  creds.last_refresh_at = creds.last_refresh_at ?? 0;
  creds.last_refresh_by = creds.last_refresh_by ?? `server-${process.pid}`;
  try {
    saveCredentials(creds);
    log('rotation_seq migration: initialized rotation_seq=0');
  } catch (err) {
    logErr('rotation_seq migration failed:', err.message);
  }
  return creds;
}

/**
 * Atomically write credentials: write to a .tmp file, then rename.
 * renameSync is atomic on all platforms. This prevents partial reads.
 */
function saveCredentials(data) {
  try {
    const dir = TEAMMCP_HOME;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const tmpPath = TOKEN_FILE + '.tmp.' + process.pid;
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tmpPath, TOKEN_FILE);
    return true;
  } catch (err) {
    logErr('Failed to save credentials:', err.message);
    return false;
  }
}

/**
 * Acquire a file-based lock at ~/.claude/teammcp-oauth.lock.
 *
 * Uses fs.openSync with 'wx' flag (exclusive create — fails if exists).
 * Writes PID + timestamp. Stale locks (>60s) are broken automatically.
 *
 * Returns a release function, or null if we could not acquire within timeout.
 *
 * Trap 4: No flock on Windows. 'wx' flag is reliable cross-platform.
 */
async function acquireLock(timeoutMs = 30_000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    // If lock file exists, check staleness
    if (existsSync(LOCK_FILE)) {
      try {
        const content = readFileSync(LOCK_FILE, 'utf-8');
        const parts = content.split('\n');
        const ts = parseInt(parts[1], 10);
        if (!isNaN(ts) && Date.now() - ts > LOCK_STALE_MS) {
          log('Breaking stale lock (age:', Date.now() - ts, 'ms)');
          try { unlinkSync(LOCK_FILE); } catch {}
        }
      } catch {
        // Can't read — try to remove and re-create
        try { unlinkSync(LOCK_FILE); } catch {}
      }
    }

    // Try to create lock (exclusive — fail if exists)
    try {
      if (!existsSync(TEAMMCP_HOME)) mkdirSync(TEAMMCP_HOME, { recursive: true });
      const lockContent = `${process.pid}\n${Date.now()}\n`;
      writeFileSync(LOCK_FILE, lockContent, { encoding: 'utf-8', flag: 'wx' });
      log('Lock acquired (PID:', process.pid, ')');

      // Return release function
      return () => {
        try {
          unlinkSync(LOCK_FILE);
        } catch (err) {
          logErr('Failed to release lock:', err.message);
        }
      };
    } catch {
      // Lock exists, wait and retry with jitter
      const elapsed = Date.now() - start;
      const delay = Math.min(500 + Math.random() * 500, timeoutMs - elapsed);
      if (delay <= 0) break;
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  logErr('Failed to acquire lock within', timeoutMs, 'ms');
  return null;
}

function releaseLock(release) {
  if (typeof release === 'function') {
    release();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Module 2: RefreshEngine
// ═══════════════════════════════════════════════════════════════════════════

let refreshTimer = null;
let consecutiveFailures = 0;
let lastRefreshTime = null;
let refreshStatus = 'never'; // 'ok' | 'retrying' | 'failed' | 'never'
let retryTimeout = null;

/**
 * Attempt to refresh the OAuth access token.
 *
 * Trap 1 solution: REFRESH_BUFFER = 30 min, Claude Code uses ~5 min.
 * We always refresh first. If an agent still beats us (401 mid-request),
 * collectAgentTokens() will detect and reverse-sync the newer token.
 */
async function refreshOAuthToken() {
  // Step 1: Load credentials
  let creds = loadCredentials();
  if (!creds || !creds.claudeAiOauth) {
    log('No credentials found — skipping refresh.');
    return;
  }
  creds = ensureRotationSeq(creds);

  const { claudeAiOauth } = creds;
  if (!claudeAiOauth.refreshToken) {
    log('No refresh token available — skipping refresh.');
    return;
  }

  // Doc-B: snapshot seq observed BEFORE the network call
  const observedSeq = creds.rotation_seq;
  const observedRefreshToken = claudeAiOauth.refreshToken;
  log(`refresh attempt seq=${observedSeq} by=server-${process.pid}`);

  // Step 2: Check if token needs refresh
  const expiresAt = claudeAiOauth.expiresAt;
  if (expiresAt && typeof expiresAt === 'number') {
    const msUntilExpiry = expiresAt - Date.now();
    if (msUntilExpiry > REFRESH_BUFFER) {
      // Token still valid, but also check if any agent has a newer token (Trap 1)
      await collectAgentTokens(creds);
      return;
    }
    log('Token expires in', Math.round(msUntilExpiry / 60_000), 'min — refreshing...');
  } else {
    log('No expiresAt found — attempting refresh anyway.');
  }

  // Step 3: Acquire lock
  const release = await acquireLock(30_000);
  if (!release) {
    logErr('Could not acquire lock for refresh — will retry.');
    scheduleRetry();
    return;
  }

  try {
    // Step 4: Double-check after acquiring lock
    const freshCreds = loadCredentials();
    if (freshCreds?.claudeAiOauth?.expiresAt) {
      const msUntilExpiry = freshCreds.claudeAiOauth.expiresAt - Date.now();
      if (msUntilExpiry > REFRESH_BUFFER) {
        log('Another process already refreshed — skipping.');
        consecutiveFailures = 0;
        refreshStatus = 'ok';
        return;
      }
    }

    // Step 5: Exchange refresh token for new access token
    const resp = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: observedRefreshToken,  // Doc-B: snapshotted value
        client_id: OAUTH_CLIENT_ID,
        scope: OAUTH_SCOPES,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Token refresh failed: HTTP ${resp.status} ${text}`);
    }

    const tokenData = await resp.json();

    // Step 6: CAS re-read — check seq hasn't advanced under us
    const reread = ensureRotationSeq(loadCredentials() || freshCreds);
    const currentSeq = reread.rotation_seq;
    if (currentSeq !== observedSeq) {
      logErr(`refresh discarded (concurrent writer detected) our_seq=${observedSeq} observed_seq=${currentSeq}`);
      // Another writer advanced seq. Our new token is stale-on-arrival; do NOT write.
      consecutiveFailures = 0;
      refreshStatus = 'ok';
      return;
    }

    // Step 6b: Read-modify-write — preserve ALL existing fields, bump seq
    const updated = { ...reread };
    updated.claudeAiOauth = {
      ...updated.claudeAiOauth,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || observedRefreshToken,
      expiresAt: Date.now() + (tokenData.expires_in || 7200) * 1000,
    };
    updated.rotation_seq = observedSeq + 1;
    updated.last_refresh_at = Date.now();
    updated.last_refresh_by = `server-${process.pid}`;

    if (!saveCredentials(updated)) {
      throw new Error('Failed to write updated credentials');
    }

    // Step 8: Success
    consecutiveFailures = 0;
    refreshStatus = 'ok';
    lastRefreshTime = new Date().toISOString();
    if (retryTimeout) {
      clearTimeout(retryTimeout);
      retryTimeout = null;
    }
    log(`refresh complete seq=${observedSeq}→${updated.rotation_seq} expires=${new Date(updated.claudeAiOauth.expiresAt).toISOString()}`);

    // Trap 3: Redistribute to ALL agents after every refresh
    distributeToAgents();
  } catch (err) {
    // Step 9: Failure — schedule retry
    logErr('Refresh failed:', err.message);
    consecutiveFailures++;
    refreshStatus = consecutiveFailures >= MAX_RETRIES ? 'failed' : 'retrying';
    scheduleRetry();

    // Step 10: Alert once when crossing the MAX_RETRIES threshold
    if (consecutiveFailures === MAX_RETRIES) {
      try {
        if (_setStateFn) {
          _setStateFn(
            'teammcp',
            'credentials/refresh_status',
            'failed',
            'credential-manager',
            `Auto-refresh failed ${consecutiveFailures} times consecutively. Last error: ${err.message}`,
          );
        }
      } catch (stateErr) {
        logErr('Failed to write state alert:', stateErr.message);
      }
    }
  } finally {
    // Step 7: Release lock
    releaseLock(release);
  }
}

/**
 * Trap 1 fallback: Check if any agent's Claude Code refreshed the token
 * independently (e.g. got a 401 and refreshed before us).
 *
 * Scans all agent .credentials.json files. If any is:
 *   - newer mtime than TokenStore
 *   - contains a valid "accessToken"
 * Then copy it back to TokenStore (one-way reverse sync).
 *
 * Safety: never overwrites valid TokenStore with empty/corrupt agent data.
 */
async function collectAgentTokens(currentCreds) {
  if (!existsSync(AGENTS_BASE_DIR)) return;

  const mainExpiresAt = currentCreds?.claudeAiOauth?.expiresAt ?? 0;
  let bestAgentCreds = null;
  let bestExpiresAt = mainExpiresAt;

  try {
    const entries = readdirSync(AGENTS_BASE_DIR);
    for (const entry of entries) {
      const agentCredPath = join(AGENTS_BASE_DIR, entry, '.claude-config', '.credentials.json');
      try {
        if (!existsSync(agentCredPath)) continue;
        const agentContent = readFileSync(agentCredPath, 'utf-8');
        if (agentContent.length < 50 || !agentContent.includes('"accessToken"')) continue;

        const agentCreds = JSON.parse(agentContent);
        const agentExpiresAt = agentCreds?.claudeAiOauth?.expiresAt ?? 0;

        if (agentExpiresAt > bestExpiresAt) {
          bestAgentCreds = agentCreds;
          bestExpiresAt = agentExpiresAt;
        }
      } catch { /* skip invalid agent cred files */ }
    }
  } catch { /* skip directory errors */ }

  if (bestAgentCreds && bestExpiresAt > mainExpiresAt) {
    log('Found newer token from agent (expiresAt:', new Date(bestExpiresAt).toISOString(),
        'vs main:', new Date(mainExpiresAt).toISOString(), ') — reverse syncing.');

    // P0-3: Acquire lock before writing
    const release = await acquireLock(10_000);
    if (!release) {
      logErr('Could not acquire lock for reverse sync — skipping.');
      return;
    }

    try {
      // P0-2: Merge — keep main's scopes/subscriptionType/rateLimitTier, overlay newer token fields
      const freshMain = loadCredentials() || currentCreds;
      const merged = {
        ...freshMain,
        claudeAiOauth: {
          ...freshMain.claudeAiOauth,
          ...bestAgentCreds.claudeAiOauth,
          refreshToken: freshMain.claudeAiOauth.refreshToken,
          scopes: freshMain.claudeAiOauth.scopes,
          subscriptionType: freshMain.claudeAiOauth.subscriptionType,
          rateLimitTier: freshMain.claudeAiOauth.rateLimitTier,
        },
        rotation_seq: (freshMain.rotation_seq ?? 0) + 1,
        last_refresh_at: Date.now(),
        last_refresh_by: `server-${process.pid}`,
      };
      saveCredentials(merged);
    } finally {
      releaseLock(release);
    }
  }
}

function scheduleRetry() {
  if (retryTimeout) return;
  const idx = Math.min(consecutiveFailures - 1, RETRY_DELAYS.length - 1);
  const delay = RETRY_DELAYS[Math.max(0, idx)];
  log('Scheduling retry in', Math.round(delay / 1000), 's (attempt', consecutiveFailures, ')');
  retryTimeout = setTimeout(() => {
    retryTimeout = null;
    refreshOAuthToken();
  }, delay);
}

function startRefreshTimer() {
  if (refreshTimer) return;
  log('Starting refresh timer (interval:', REFRESH_CHECK_INTERVAL / 1000, 's, buffer:', REFRESH_BUFFER / 60_000, 'min)');
  refreshTimer = setInterval(refreshOAuthToken, REFRESH_CHECK_INTERVAL);
  refreshOAuthToken(); // immediate check
}

function stopRefreshTimer() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (retryTimeout) {
    clearTimeout(retryTimeout);
    retryTimeout = null;
  }
  log('Refresh timer stopped.');
}

// ═══════════════════════════════════════════════════════════════════════════
// Module 3: LoginFlow (PKCE — P2, kept for future Dashboard integration)
// ═══════════════════════════════════════════════════════════════════════════

const pendingLogins = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [state, session] of pendingLogins) {
    if (session.expiresAt < now) pendingLogins.delete(state);
  }
}, 60_000);

function generatePKCE() {
  const codeVerifier = randomBytes(32)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const codeChallenge = createHash('sha256')
    .update(codeVerifier).digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return { codeVerifier, codeChallenge };
}

function createLoginSession() {
  const { codeVerifier, codeChallenge } = generatePKCE();
  const state = randomBytes(16).toString('hex');

  pendingLogins.set(state, {
    codeVerifier,
    expiresAt: Date.now() + 5 * 60_000,
  });

  const authorizeUrl =
    `https://claude.com/cai/oauth/authorize` +
    `?code=true` +
    `&client_id=${encodeURIComponent(OAUTH_CLIENT_ID)}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent('https://platform.claude.com/oauth/code/callback')}` +
    `&scope=${encodeURIComponent(OAUTH_SCOPES)}` +
    `&code_challenge=${encodeURIComponent(codeChallenge)}` +
    `&code_challenge_method=S256` +
    `&state=${encodeURIComponent(state)}`;

  return { authorizeUrl, state };
}

async function completeLogin(code, state) {
  const session = pendingLogins.get(state);
  if (!session) return { success: false, error: 'Invalid or expired login session' };
  if (session.expiresAt < Date.now()) {
    pendingLogins.delete(state);
    return { success: false, error: 'Login session expired' };
  }
  pendingLogins.delete(state);

  try {
    const resp = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        client_id: OAUTH_CLIENT_ID,
        code_verifier: session.codeVerifier,
        redirect_uri: 'https://platform.claude.com/oauth/code/callback',
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Token exchange failed: HTTP ${resp.status} ${text}`);
    }

    const tokenData = await resp.json();
    const credentials = {
      claudeAiOauth: {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresAt: Date.now() + (tokenData.expires_in || 7200) * 1000,
        scopes: tokenData.scopes || (typeof tokenData.scope === 'string' ? tokenData.scope.split(' ') : []) || [],
        subscriptionType: tokenData.subscription_type || null,
        rateLimitTier: tokenData.rate_limit_tier || null,
      },
      rotation_seq: 0,
      last_refresh_at: Date.now(),
      last_refresh_by: `server-${process.pid}`,
    };

    if (!saveCredentials(credentials)) throw new Error('Failed to save credentials');

    consecutiveFailures = 0;
    refreshStatus = 'ok';
    lastRefreshTime = new Date().toISOString();
    startRefreshTimer();
    distributeToAgents();

    return { success: true };
  } catch (err) {
    logErr('Login completion failed:', err.message);
    return { success: false, error: err.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Module 4: Distributor
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Distribute credentials to all agent directories.
 *
 * Trap 2: Atomic write — write .tmp then renameSync (rename is atomic).
 * Trap 3: Called on every refresh success, not just startup.
 *
 * OAuth agents get the full credential object.
 * API-key agents get {}.
 */
async function distributeToAgents() {
  let creds = loadCredentials();
  if (!creds) {
    log('No credentials to distribute.');
    return;
  }

  if (!existsSync(AGENTS_BASE_DIR)) return;

  let synced = 0;
  let failed = 0;

  try {
    const entries = readdirSync(AGENTS_BASE_DIR);
    for (const entry of entries) {
      const agentDir = join(AGENTS_BASE_DIR, entry);
      try {
        if (!statSync(agentDir).isDirectory()) continue;
      } catch { continue; }

      const configDir = join(agentDir, '.claude-config');
      if (!existsSync(configDir)) continue;

      // Check auth mode — api_key agents get empty credentials
      let isEmpty = false;
      try {
        if (_isApiKeyAgent && _isApiKeyAgent(entry)) isEmpty = true;
      } catch {}

      // Path A Option (b): per-entry detection of auth_strategy=path_a
      let isPathA = false;
      try {
        const { getAgentByName } = await import('./db.mjs');
        isPathA = getAgentByName(entry)?.auth_strategy === 'path_a';
      } catch (e) {
        logErr('auth_strategy lookup failed for', entry, ':', e.message);
      }

      // Build per-entry credential payload; strip refreshToken for path_a agents
      const buildEntryJson = (source) => {
        if (isPathA) {
          const entryCreds = {
            ...source,
            claudeAiOauth: {
              ...source.claudeAiOauth,
              refreshToken: null,
            },
          };
          return JSON.stringify(entryCreds, null, 2);
        }
        return JSON.stringify(source, null, 2);
      };
      let credentialJson = buildEntryJson(creds);

      try {
        const credPath = join(configDir, '.credentials.json');
        const tmpPath = credPath + '.tmp.' + process.pid;

        if (isEmpty) {
          // Sanity check: double-verify this agent is truly api_key before writing {}
          // Prevents misconfigured callbacks from clearing OAuth agents
          let verifiedApiKey = false;
          try {
            const { getAgentByName } = await import('./db.mjs');
            verifiedApiKey = getAgentByName(entry)?.auth_mode === 'api_key';
          } catch (dbErr) { logErr('DB verification failed for', entry, ':', dbErr.message); }
          if (!verifiedApiKey) {
            logErr('Refusing to write {} for', entry, ': DB says auth_mode is NOT api_key (safety net)');
            failed++;
            continue;
          }
          // api_key agent — write empty
          writeFileSync(tmpPath, '{}', 'utf-8');
          renameSync(tmpPath, credPath);
          synced++;
        } else {
          // Safety: refuse to distribute credentials without accessToken
          if (!creds?.claudeAiOauth?.accessToken) {
            logErr('Refusing to distribute to', entry, ': credentials missing accessToken');
            failed++;
            continue;
          }
          // P0-4: Check if agent has a newer token before overwriting
          let shouldWrite = true;
          try {
            if (existsSync(credPath)) {
              const agentContent = readFileSync(credPath, 'utf-8');
              if (agentContent.length > 50 && agentContent.includes('"accessToken"')) {
                const agentCreds = JSON.parse(agentContent);
                const agentExpiresAt = agentCreds?.claudeAiOauth?.expiresAt ?? 0;
                const mainExpiresAt = creds?.claudeAiOauth?.expiresAt ?? 0;
                if (agentExpiresAt > mainExpiresAt) {
                  // Agent has newer token — skip overwrite, collect it back
                  log('Agent', entry, 'has newer token — skipping overwrite, collecting.');
                  shouldWrite = false;
                  // Merge agent's newer token back into main
                  const freshMain = loadCredentials() || creds;
                  const merged = {
                    ...freshMain,
                    claudeAiOauth: {
                      ...freshMain.claudeAiOauth,
                      ...agentCreds.claudeAiOauth,
                      refreshToken: freshMain.claudeAiOauth.refreshToken,
                      scopes: freshMain.claudeAiOauth.scopes,
                      subscriptionType: freshMain.claudeAiOauth.subscriptionType,
                      rateLimitTier: freshMain.claudeAiOauth.rateLimitTier,
                    },
                    rotation_seq: (freshMain.rotation_seq ?? 0) + 1,
                    last_refresh_at: Date.now(),
                    last_refresh_by: `server-${process.pid}`,
                  };
                  saveCredentials(merged);
                  creds = merged; // update for subsequent iterations
                  credentialJson = buildEntryJson(merged);
                }
              }
            }
          } catch {}

          if (shouldWrite) {
            // Trap 2: atomic write — write tmp, then rename
            writeFileSync(tmpPath, credentialJson, 'utf-8');
            renameSync(tmpPath, credPath);
            synced++;
          }
        }
      } catch (err) {
        logErr('Failed to distribute to', entry, ':', err.message);
        failed++;
      }
    }
  } catch (err) {
    logErr('Failed to enumerate agents directory:', err.message);
    return;
  }

  if (synced > 0 || failed > 0) {
    log('Distributed:', synced, 'synced,', failed, 'failed');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Module 5: API Status
// ═══════════════════════════════════════════════════════════════════════════

function formatDuration(ms) {
  if (ms <= 0) return 'expired';
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function getCredentialStatus() {
  const creds = loadCredentials();
  const hasCredentials = !!(creds && creds.claudeAiOauth);
  const expiresAt = creds?.claudeAiOauth?.expiresAt ?? null;
  const isValid = hasCredentials && expiresAt !== null && expiresAt > Date.now();

  return {
    hasCredentials,
    isValid,
    expiresAt,
    expiresIn: expiresAt ? formatDuration(expiresAt - Date.now()) : null,
    lastRefresh: lastRefreshTime,
    refreshStatus,
    consecutiveFailures,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Module 6: Lifecycle (init / shutdown)
// ═══════════════════════════════════════════════════════════════════════════

function init({ setState: sf, isApiKeyAgent: ik } = {}) {
  if (sf) setStateFn(sf);
  if (ik) setIsApiKeyAgent(ik);

  log('Initializing...');
  log('Path A Option (b) active: refreshToken will be stripped for agents with auth_strategy=path_a');

  let creds = loadCredentials();
  if (!creds || !creds.claudeAiOauth) {
    log('No credentials found. Use /login or Dashboard to authenticate.');
    return;
  }
  creds = ensureRotationSeq(creds);

  const expiresAt = creds.claudeAiOauth.expiresAt;
  if (expiresAt && expiresAt > Date.now()) {
    log('Credentials loaded. Token valid for', formatDuration(expiresAt - Date.now()));
  } else {
    log('Credentials loaded but token expired. Will attempt refresh...');
  }

  startRefreshTimer();
  distributeToAgents();
}

function shutdown() {
  stopRefreshTimer();
  pendingLogins.clear();
  log('Shutdown complete.');
}

// ═══════════════════════════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════════════════════════

export {
  init,
  shutdown,
  createLoginSession,
  completeLogin,
  refreshOAuthToken,
  getCredentialStatus,
  distributeToAgents,
  loadCredentials,
  saveCredentials,
};
