import { randomUUID, timingSafeEqual, generateKeyPairSync, createPublicKey, createPrivateKey, sign as edSign, verify as edVerify, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { statSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { loadCredentials } from './credential-manager.mjs';
import { getAgentByName } from './db.mjs';
import { SAFE_NAME_RE } from './process-manager.mjs';
import { verifyAgentToken, normalizeAddr, isLoopback, mintAgentToken, checkAggregateMintRate } from './auth-token-utils.mjs';
import Database from 'better-sqlite3';
import path from 'node:path';

const TEAMMCP_HOME = process.env.TEAMMCP_HOME;
const db = new Database(path.join(TEAMMCP_HOME, 'data', 'teammcp.db'));

const insertLease = db.prepare(`
  INSERT INTO credential_leases (lease_id, agent, leased_at, expires_at, reason, requested_by)
  VALUES (?, ?, ?, ?, ?, ?)
`);

// ---------------------------------------------------------------------------
// §11.2 — timing-safe string equality
// ---------------------------------------------------------------------------
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'utf-8');
  const bb = Buffer.from(b, 'utf-8');
  if (ab.length !== bb.length) {
    // Consume time on dummy compare to avoid length-based timing signal.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// §11.3 — agent name validation (path-traversal / encoding defense)
// ---------------------------------------------------------------------------
const FORBIDDEN_SUBSTRS = ['..', '/', '\\', '\0'];
function validateAgentName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 64) return false;
  if (!SAFE_NAME_RE.test(name)) return false;
  for (const bad of FORBIDDEN_SUBSTRS) if (name.includes(bad)) return false;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

function auditLog(tag, extra) {
  try {
    const line = `[audit] ${tag}` + (extra ? ' ' + JSON.stringify(extra) : '');
    console.log(line);
  } catch { /* never throw from audit */ }
}

// ---------------------------------------------------------------------------
// §11.5 — JSONL provenance: getFileOwnerSid with TRUE LRU cache
// key = (path | mtimeMs | size), TTL 60s, max 2000
// On cache hit: delete + re-insert to move to end of Map insertion order.
// On PS spawn failure: return null → caller treats as "unknown" (fail-safe drop).
// ---------------------------------------------------------------------------
const _SID_CACHE_MAX = 2000;
const _SID_CACHE_TTL_MS = 60_000;
const _sidCache = new Map(); // key(string) → { sid, ts }

function _sidKey(absPath, mtimeMs, size) {
  return `${absPath}|${mtimeMs}|${size}`;
}

function _sidCacheGet(key) {
  const entry = _sidCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > _SID_CACHE_TTL_MS) {
    _sidCache.delete(key);
    return null;
  }
  // True LRU: move-to-end on hit.
  _sidCache.delete(key);
  _sidCache.set(key, entry);
  return entry;
}

function _sidCacheSet(key, sid) {
  _sidCache.delete(key);
  if (_sidCache.size >= _SID_CACHE_MAX) {
    const oldestKey = _sidCache.keys().next().value;
    if (oldestKey !== undefined) _sidCache.delete(oldestKey);
  }
  _sidCache.set(key, { sid, ts: Date.now() });
}

export function getFileOwnerSid(absPath) {
  let stat;
  try { stat = statSync(absPath); } catch { return null; }
  const key = _sidKey(absPath, stat.mtimeMs, stat.size);

  const cached = _sidCacheGet(key);
  if (cached) return cached.sid;

  // Spawn PowerShell Get-Acl to read owner, then translate NTAccount → SID.
  try {
    const ownerScript = `(Get-Acl -LiteralPath $env:P).Owner`;
    const ownerName = execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ownerScript],
      { env: { ...process.env, P: absPath }, encoding: 'utf-8', timeout: 5000 }).trim();

    const sidScript = `
      $o = New-Object System.Security.Principal.NTAccount($env:ON);
      ($o.Translate([System.Security.Principal.SecurityIdentifier])).Value`;
    const sid = execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', sidScript],
      { env: { ...process.env, ON: ownerName }, encoding: 'utf-8', timeout: 5000 }).trim();

    _sidCacheSet(key, sid);
    return sid;
  } catch (err) {
    // Safe fallback: do NOT cache, do NOT throw. Caller drops the event.
    auditLog('auth/provenance/ps_spawn_failed', { path: absPath, err: String(err?.message || err).slice(0, 120) });
    return null;
  }
}

let _selfSidCache = null;
export function getCurrentUserSid() {
  if (_selfSidCache) return _selfSidCache;
  try {
    const script = `[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value`;
    _selfSidCache = execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf-8', timeout: 5000 }).trim();
    return _selfSidCache;
  } catch (err) {
    auditLog('auth/provenance/self_sid_failed', { err: String(err?.message || err).slice(0, 120) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// §11.6 — per-agent sliding-window rate limit, persistent
// ---------------------------------------------------------------------------
const RATE_WINDOW_MS = 5 * 60 * 1000;
const RATE_MAX = 3;

const _rateSelect = db.prepare(
  `SELECT window_start, count, blocked FROM credential_lease_rate WHERE agent_name = ?`
);
const _rateUpsert = db.prepare(`
  INSERT INTO credential_lease_rate (agent_name, window_start, count, blocked)
  VALUES (?, ?, 1, 0)
  ON CONFLICT(agent_name) DO UPDATE SET window_start = excluded.window_start, count = 1, blocked = 0
`);
const _rateBump = db.prepare(
  `UPDATE credential_lease_rate SET count = count + 1 WHERE agent_name = ?`
);
const _rateBlock = db.prepare(
  `UPDATE credential_lease_rate SET blocked = 1 WHERE agent_name = ?`
);

export function checkAndBumpRate(agent_name) {
  const now = Date.now();
  const row = _rateSelect.get(agent_name);
  if (row?.blocked) return { ok: false, state: 'blocked', count: row.count };
  if (!row || now - row.window_start >= RATE_WINDOW_MS) {
    _rateUpsert.run(agent_name, now);
    return { ok: true, state: 'fresh', count: 1 };
  }
  if (row.count >= RATE_MAX) {
    _rateBlock.run(agent_name);
    auditLog(`auth/${agent_name}/lease_rate_limit_triggered`);
    return { ok: false, state: 'tripped', count: row.count };
  }
  _rateBump.run(agent_name);
  return { ok: true, state: 'ok', count: row.count + 1 };
}

// ---------------------------------------------------------------------------
// §11.1 verifyHmacBearer — real HMAC bearer impl (v1.6).
// Synchronous (NOT async) per §11.1 v1.6 atomicity assertion: usedJtis
// check-and-insert (inside verifyAgentToken) must run with no await between
// the has() and set(). Do not add awaits to this function.
//
// Gates:
//  1. req.socket.remoteAddress normalized → must be 127.0.0.1 or ::1
//  2. Authorization: Bearer <token> present
//  3. HMAC verify against TEAMMCP_INTERNAL_SECRET
//  4. agent_name in token must equal expectedAgentName (if provided)
//  5. exp not in past
//  6. jti not previously used (replay protection)
//
// Returns { agent_name, source:'hmac_bearer', jti } on success, null on fail.
// ---------------------------------------------------------------------------
export function verifyHmacBearer(req, expectedAgentName) {
  // Gate 1: loopback (defense-in-depth on top of bind assertion in index.mjs).
  const remote = req.socket?.remoteAddress;
  if (!isLoopback(remote)) return null;

  const secret = process.env.TEAMMCP_INTERNAL_SECRET;
  if (!secret) return null;

  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;

  if (!expectedAgentName) return null; // we always know who we expect

  const result = verifyAgentToken(token, secret, expectedAgentName, null);
  if (!result.ok) return null;
  return { agent_name: result.agent_name, source: 'hmac_bearer', jti: result.jti };
}

// §11.1 — /agent-token mint handler. Loopback-only, allowlist + aggregate
// rate-limit gated. Returns { token, expires_at } or 403/429.
// Per slice spec: aggregate ≤5/min global. Per-agent rate limit (60s) is
// TODO slice-4 (DB-backed `credential_token_mint_rate` table).
export function handleMintAgentTokenRequest(req, res, body, json) {
  // Gate 1: loopback.
  const remote = req.socket?.remoteAddress;
  if (!isLoopback(remote)) {
    return deny(res, json, 'unknown', 'mint_non_loopback');
  }
  // Gate 2: agent_name validation.
  const agent_name = body?.agent_name;
  if (!validateAgentName(agent_name)) {
    return deny(res, json, String(agent_name).slice(0, 32), 'mint_invalid_name');
  }
  // Gate 3: server-side allowlist (must be a known agent).
  const agent = getAgentByName(agent_name);
  if (!agent) {
    return deny(res, json, agent_name, 'mint_unknown_agent');
  }
  // Gate 4: aggregate global mint rate (≤5/min). 429 distinguishable per spec.
  const rate = checkAggregateMintRate();
  if (!rate.ok) {
    auditLog(`auth/${agent_name}/mint_rate_exceeded`);
    res.statusCode = 429;
    res.setHeader('Retry-After', String(Math.ceil(rate.retry_after_ms / 1000)));
    return json(res, { error: 'too_many_requests' }, 429);
  }
  // Gate 5: must have secret to sign with.
  const secret = process.env.TEAMMCP_INTERNAL_SECRET;
  if (!secret) {
    return deny(res, json, agent_name, 'mint_no_secret');
  }
  const minted = mintAgentToken(agent_name, secret);
  auditLog(`auth/${agent_name}/mint_ok`);
  return json(res, { token: minted.token, expires_at: minted.expires_at }, 200);
}

// ---------------------------------------------------------------------------
// §11.8 — requestedBy is derived ONLY from the verified principal.
// Caller-supplied X-Requested-By / body.requestedBy are ignored (spoof-logged).
// ---------------------------------------------------------------------------
export function derivePrincipal(req, verified) {
  if (verified && verified.agent_name) return `agent:${verified.agent_name}`;
  const addr = req.socket?.remoteAddress ?? 'unknown';
  return `loopback:${addr}`;
}

// ---------------------------------------------------------------------------
// §11.9 — unified 403 deny. Body is byte-identical {"error":"forbidden"}.
// All unauth/notfound/busy/invalid branches funnel through here so the wire
// response reveals no information beyond "denied". Exception: §11.6 rate
// limit returns 429 deliberately.
// ---------------------------------------------------------------------------
const FORBIDDEN_BODY = Object.freeze({ error: 'forbidden' });
export function deny(res, json, agent, reason) {
  auditLog(`auth/${agent || 'unknown'}/lease_denied_${reason}`);
  return json(res, FORBIDDEN_BODY, 403);
}

// ---------------------------------------------------------------------------
// Core: leaseTokenForAgent  (§11.3 name validation at top)
// ---------------------------------------------------------------------------
export async function leaseTokenForAgent(name, reason, requestedBy = 'process-manager') {
  // §11.3: path-traversal / encoding defense — BEFORE any DB access.
  if (!validateAgentName(name)) {
    auditLog('auth/' + String(name).slice(0, 32) + '/lease_invalid_name');
    const e = new Error('forbidden'); e.statusCode = 403; throw e;
  }
  const agent = getAgentByName(name);
  if (!agent) { const e = new Error('agent not found'); e.statusCode = 404; throw e; }
  if (agent.auth_strategy !== 'path_a') {
    const e = new Error('agent is not path_a'); e.statusCode = 409; throw e;
  }
  const creds = loadCredentials();
  const accessToken = creds?.claudeAiOauth?.accessToken;
  const expiresAt = creds?.claudeAiOauth?.expiresAt;
  if (!accessToken || !expiresAt) {
    const e = new Error('TokenStore empty or refresh failed'); e.statusCode = 503; throw e;
  }
  const leaseId = randomUUID();
  const leasedAt = Date.now();
  insertLease.run(leaseId, name, leasedAt, expiresAt, reason, requestedBy);
  return { accessToken, expiresAt, leasedAt, leaseId };
}

export async function handleLeaseHttpRequest(req, res, name, json) {
  try {
    // §11.3 / §11.9: invalid name → 403 forbidden (was already 403, now routed via deny).
    if (!validateAgentName(name)) {
      return deny(res, json, String(name).slice(0, 32), 'invalid_name');
    }
    const expected = process.env.TEAMMCP_INTERNAL_SECRET;
    if (!expected) {
      // §11.9: never leak misconfig via distinct 500.
      return deny(res, json, name, 'server_misconfigured');
    }

    // §11.1 / §11.2 verified principal (timing-safe compare inside verifyHmacBearer).
    const verified = verifyHmacBearer(req, name);
    if (!verified) return deny(res, json, name, 'bad_token');

    // §11.8 spoof detection: log attempts to set requestedBy via caller input.
    if (req.body?.requestedBy || req.headers['x-requested-by']) {
      auditLog(`auth/${name}/spoof_attempt_requestedBy`, {
        header: req.headers['x-requested-by'] || null,
        body: req.body?.requestedBy || null,
      });
    }

    const reason = req.headers['x-lease-reason'];
    const allowedReasons = new Set(['start','restart_after_401','restart_after_short_circuit','manual']);
    if (!reason || !allowedReasons.has(reason)) {
      return deny(res, json, name, 'invalid_reason');
    }

    // §11.6 per-agent rate limit — 429 is the ONLY deliberately-distinguishable denial.
    const rate = checkAndBumpRate(name);
    if (!rate.ok) {
      return json(res, { error: 'rate_limited' }, 429);
    }

    // §11.8 — authoritative requestedBy from verified principal only.
    const requestedBy = derivePrincipal(req, verified);

    let lease;
    try {
      lease = await leaseTokenForAgent(name, reason, requestedBy);
    } catch (err) {
      // §11.9 — collapse 404 (unknown agent) / 409 (wrong strategy) / 503 (empty store)
      // into uniform 403 forbidden. Actual cause is captured in audit log.
      const reasonTag =
        err.statusCode === 404 ? 'unknown_agent' :
        err.statusCode === 409 ? 'wrong_strategy' :
        err.statusCode === 503 ? 'tokenstore_unavailable' :
        'lease_failed';
      return deny(res, json, name, reasonTag);
    }

    auditLog(`auth/${name}/lease_granted`, {
      requestedBy,
      lease_id: lease.leaseId,
      rate_limit_state_at_request: rate.count,
    });

    const configDir = path.join(process.env.AGENTS_BASE_DIR, name, '.claude-config');
    return json(res, { ...lease, configDir });
  } catch (err) {
    // §11.9 — never leak err.message on the wire.
    auditLog(`auth/${name}/lease_denied_internal_error`, {
      msg: String(err?.message || err).slice(0, 200),
    });
    return json(res, FORBIDDEN_BODY, 403);
  }
}

// ===========================================================================
// Doc-A v1.6 §11.4 — persistent busyAgents lock for HR Path A driver.
// In-memory busyAgents Set lost on restart → double-spend window. Persist to
// SQLite (WAL inherited from db.mjs). Driver heartbeats every 5s; rows older
// than 30s are stale → reclaimable.
// ===========================================================================
const BUSY_STALE_MS = 30_000;

const _busyAcquireAtomic = db.prepare(`
  INSERT INTO path_a_busy_agents (agent_name, locked_at, heartbeat_ts, owner_pid)
  SELECT ?, ?, ?, ?
  WHERE NOT EXISTS (
    SELECT 1 FROM path_a_busy_agents
     WHERE agent_name = ? AND heartbeat_ts > ?
  )
`);
const _busyReclaim = db.prepare(`
  UPDATE path_a_busy_agents
     SET locked_at = ?, heartbeat_ts = ?, owner_pid = ?
   WHERE agent_name = ? AND heartbeat_ts <= ?
`);
const _busyHeartbeatStmt = db.prepare(`
  UPDATE path_a_busy_agents
     SET heartbeat_ts = ?
   WHERE agent_name = ? AND owner_pid = ?
`);
const _busyReleaseStmt = db.prepare(`
  DELETE FROM path_a_busy_agents
   WHERE agent_name = ? AND owner_pid = ?
`);

export function busyAcquire(agent_name, owner_pid) {
  if (!validateAgentName(agent_name)) return false;
  const now = Date.now();
  const cutoff = now - BUSY_STALE_MS;
  const r = _busyAcquireAtomic.run(agent_name, now, now, owner_pid, agent_name, cutoff);
  if (r.changes === 1) {
    auditLog(`auth/${agent_name}/busy_acquired`, { pid: owner_pid });
    return true;
  }
  const o = _busyReclaim.run(now, now, owner_pid, agent_name, cutoff);
  if (o.changes === 1) {
    auditLog(`auth/${agent_name}/busy_reclaimed_stale`, { pid: owner_pid });
    return true;
  }
  return false;
}

export function busyHeartbeat(agent_name, owner_pid) {
  return _busyHeartbeatStmt.run(Date.now(), agent_name, owner_pid).changes === 1;
}

export function busyRelease(agent_name, owner_pid) {
  const ok = _busyReleaseStmt.run(agent_name, owner_pid).changes === 1;
  if (ok) auditLog(`auth/${agent_name}/busy_released`, { pid: owner_pid });
  return ok;
}

export function busyList() {
  return db.prepare('SELECT agent_name, locked_at, heartbeat_ts, owner_pid FROM path_a_busy_agents').all();
}

function _checkInternalSecret(req) {
  const expected = process.env.TEAMMCP_INTERNAL_SECRET;
  if (!expected) return false;
  const auth = req.headers['authorization'] || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return constantTimeEqual(provided, expected);
}

// HTTP handlers for HR driver loopback. Auth: TEAMMCP_INTERNAL_SECRET bearer.
export async function handleBusyAcquireHttp(req, res, name, body, json) {
  if (!_checkInternalSecret(req)) return json(res, { error: 'forbidden' }, 403);
  if (!validateAgentName(name)) return json(res, { error: 'forbidden' }, 403);
  const owner_pid = Number(body?.owner_pid) || 0;
  if (!owner_pid) return json(res, { error: 'owner_pid required' }, 400);
  const ok = busyAcquire(name, owner_pid);
  return json(res, { ok, agent_name: name, owner_pid }, ok ? 200 : 409);
}
export async function handleBusyHeartbeatHttp(req, res, name, body, json) {
  if (!_checkInternalSecret(req)) return json(res, { error: 'forbidden' }, 403);
  if (!validateAgentName(name)) return json(res, { error: 'forbidden' }, 403);
  const owner_pid = Number(body?.owner_pid) || 0;
  const ok = busyHeartbeat(name, owner_pid);
  return json(res, { ok }, ok ? 200 : 410);
}
export async function handleBusyReleaseHttp(req, res, name, body, json) {
  if (!_checkInternalSecret(req)) return json(res, { error: 'forbidden' }, 403);
  if (!validateAgentName(name)) return json(res, { error: 'forbidden' }, 403);
  const owner_pid = Number(body?.owner_pid) || 0;
  return json(res, { ok: busyRelease(name, owner_pid) });
}

// ===========================================================================
// Doc-A v1.6 §11.7 — admin ed25519 keypair (DPAPI-sealed CurrentUser scope)
// + short-TTL JWT mint/verify, used for the admin-revoke route.
// ===========================================================================
const ADMIN_SECRETS_DIR = TEAMMCP_HOME ? path.join(TEAMMCP_HOME, 'secrets') : null;
const ADMIN_KEY_FILE = ADMIN_SECRETS_DIR ? path.join(ADMIN_SECRETS_DIR, 'admin-keypair.dpapi') : null;
const ADMIN_TOKEN_TTL_MS = 60_000;
const ADMIN_TOKEN_RATE_MAX = 3;
const ADMIN_TOKEN_RATE_WINDOW_MS = 60_000;
const _adminMintTimes = [];

function _dpapiSeal(plaintextB64) {
  const script = `
    Add-Type -AssemblyName System.Security;
    $bytes = [Convert]::FromBase64String($env:PT);
    $ct = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);
    [Convert]::ToBase64String($ct)`;
  return execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { env: { ...process.env, PT: plaintextB64 }, encoding: 'utf-8', timeout: 5000 }).trim();
}
function _dpapiUnseal(ciphertextB64) {
  const script = `
    Add-Type -AssemblyName System.Security;
    $bytes = [Convert]::FromBase64String($env:CT);
    $pt = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);
    [Convert]::ToBase64String($pt)`;
  return execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { env: { ...process.env, CT: ciphertextB64 }, encoding: 'utf-8', timeout: 5000 }).trim();
}

let _adminPrivKeyObj = null;
let _adminPubKeyObj = null;
let _adminFingerprint = null;

export function initAdminKeypair() {
  if (_adminPrivKeyObj) return { fingerprint: _adminFingerprint };
  if (!ADMIN_SECRETS_DIR) throw new Error('TEAMMCP_HOME not set');
  mkdirSync(ADMIN_SECRETS_DIR, { recursive: true });

  const row = db.prepare('SELECT public_key_pem, fingerprint FROM admin_keypair WHERE id = 1').get();
  if (row && existsSync(ADMIN_KEY_FILE)) {
    const sealed = readFileSync(ADMIN_KEY_FILE, 'utf-8').trim();
    const privPem = Buffer.from(_dpapiUnseal(sealed), 'base64').toString('utf-8');
    _adminPrivKeyObj = createPrivateKey(privPem);
    _adminPubKeyObj = createPublicKey(row.public_key_pem);
    _adminFingerprint = row.fingerprint;
    return { fingerprint: _adminFingerprint };
  }

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const fingerprint = createHash('sha256').update(pubPem).digest('hex').slice(0, 32);
  const sealed = _dpapiSeal(Buffer.from(privPem, 'utf-8').toString('base64'));
  writeFileSync(ADMIN_KEY_FILE, sealed, { encoding: 'utf-8', mode: 0o600 });
  db.prepare(`
    INSERT INTO admin_keypair (id, public_key_pem, fingerprint, generated_at, scope)
    VALUES (1, ?, ?, ?, 'CurrentUser')
    ON CONFLICT(id) DO UPDATE SET public_key_pem = excluded.public_key_pem,
                                  fingerprint = excluded.fingerprint,
                                  generated_at = excluded.generated_at
  `).run(pubPem, fingerprint, Date.now());
  _adminPrivKeyObj = privateKey;
  _adminPubKeyObj = publicKey;
  _adminFingerprint = fingerprint;
  auditLog('admin/keygen', { fingerprint, scope: 'CurrentUser', generated_at: Date.now(), file: ADMIN_KEY_FILE });
  return { fingerprint };
}

function _b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_');
}
function _b64urlDecode(s) {
  s = s.replace(/-/g,'+').replace(/_/g,'/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

export function mintAdminToken({ target_agent, action = 'revoke' }) {
  initAdminKeypair();
  const now = Date.now();
  while (_adminMintTimes.length && now - _adminMintTimes[0] > ADMIN_TOKEN_RATE_WINDOW_MS) {
    _adminMintTimes.shift();
  }
  if (_adminMintTimes.length >= ADMIN_TOKEN_RATE_MAX) {
    const e = new Error('admin mint rate-limited'); e.statusCode = 429; throw e;
  }
  _adminMintTimes.push(now);
  if (!validateAgentName(target_agent)) {
    const e = new Error('invalid target_agent'); e.statusCode = 400; throw e;
  }
  const header = { alg: 'EdDSA', typ: 'JWT' };
  const payload = {
    iss: 'teammcp-server', aud: 'admin',
    exp: Math.floor((now + ADMIN_TOKEN_TTL_MS) / 1000),
    jti: randomUUID(), action, target_agent,
  };
  const h = _b64url(JSON.stringify(header));
  const p = _b64url(JSON.stringify(payload));
  const signingInput = `${h}.${p}`;
  const sig = edSign(null, Buffer.from(signingInput, 'utf-8'), _adminPrivKeyObj);
  const token = `${signingInput}.${_b64url(sig)}`;
  auditLog('admin/token_minted', { jti: payload.jti, target_agent, action, exp: payload.exp });
  return { token, exp: payload.exp, jti: payload.jti, fingerprint: _adminFingerprint };
}

export function verifyAdminToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    initAdminKeypair();
    const signingInput = `${parts[0]}.${parts[1]}`;
    const sig = _b64urlDecode(parts[2]);
    const ok = edVerify(null, Buffer.from(signingInput, 'utf-8'), _adminPubKeyObj, sig);
    if (!ok) return null;
    const payload = JSON.parse(_b64urlDecode(parts[1]).toString('utf-8'));
    if (payload.iss !== 'teammcp-server' || payload.aud !== 'admin') return null;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// §11.7 dual-path verifier — wraps slice-1 verifyHmacBearer and adds the
// admin ed25519 JWT branch. CONFLICT POINT (see report): if slice 1 changes
// verifyHmacBearer signature in a follow-up, A-main reconciles by folding
// the admin branch INTO verifyHmacBearer itself.
// ---------------------------------------------------------------------------
export function verifyHmacBearerWithAdmin(req, expectedAgentName) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) {
    const tok = auth.slice(7).trim();
    if (tok.split('.').length === 3) {
      const payload = verifyAdminToken(tok);
      if (payload && payload.action === 'revoke' && payload.target_agent === expectedAgentName) {
        return { agent_name: '__admin__', source: 'admin_ed25519', jti: payload.jti };
      }
    }
  }
  // Fall through to slice-1 path (HMAC bearer / internal secret).
  const verified = verifyHmacBearer(req, expectedAgentName);
  if (!verified) return null;
  return verified;
}

// ---------------------------------------------------------------------------
// §11.7 admin-revoke handler. POST /api/credentials/lease/:agent_name/revoke
// ---------------------------------------------------------------------------
export async function handleLeaseRevokeHttp(req, res, name, body, json) {
  if (!validateAgentName(name)) {
    return deny(res, json, String(name).slice(0, 32), 'revoke_invalid_name');
  }
  const verified = verifyHmacBearerWithAdmin(req, name);
  if (!verified) return deny(res, json, name, 'revoke_unauth');
  const principal = verified.agent_name === '__admin__'
    ? `__admin__:${verified.jti}`
    : derivePrincipal(req, verified);
  const now = Date.now();
  try { db.prepare(`UPDATE credential_lease_rate SET count = 0, blocked = 0, window_start = ? WHERE agent_name = ?`).run(now, name); } catch {}
  try {
    db.prepare(`INSERT INTO credential_lease_revocations (agent_name, lease_id, revoked_at, revoked_by, reason) VALUES (?, ?, ?, ?, ?)`)
      .run(name, null, now, principal, body?.reason || 'admin_revoke');
  } catch {}
  try { db.prepare(`DELETE FROM path_a_busy_agents WHERE agent_name = ?`).run(name); } catch {}
  auditLog(`auth/${name}/lease_revoked`, { principal });
  return json(res, { ok: true, agent_name: name, principal, revoked_at: now });
}

// Test-only exports (not part of public API; used by unit tests).
export const __test__ = { constantTimeEqual, validateAgentName, _sidCache, busyAcquire, busyHeartbeat, busyRelease, mintAdminToken, verifyAdminToken };
