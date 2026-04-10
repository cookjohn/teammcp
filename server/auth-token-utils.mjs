// auth-token-utils.mjs — Doc-A §11.1 slice 1 (v1.6)
// HMAC bearer token mint/verify + jti replay protection + loopback normalization
// + aggregate /agent-token mint rate limit.
//
// Scope: §11.1 Part B only (HMAC short-TTL per-agent token).
// NOT in this slice: DPAPI sealing (Part A), DB-backed per-agent mint rate
// (slice 4 will create `credential_token_mint_rate` table). Aggregate global
// limit here is in-memory; TODO migrate to DB in slice 4.

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const TOKEN_TTL_MS = 5 * 60 * 1000;           // 5 min
const JTI_EVICTION_MS = 10 * 60 * 1000;       // 10 min, per v1.5 intra-TTL replay protection
const AGGREGATE_MINT_WINDOW_MS = 60 * 1000;   // 1 min sliding window
const AGGREGATE_MINT_LIMIT = 5;               // ≤5/min across all agents

// ── normalizeAddr: strip IPv4-mapped IPv6 prefix (v1.6 SecTest HIGH-1) ──
export function normalizeAddr(a) {
  if (!a) return a;
  return a.replace(/^::ffff:/, '');
}

export function isLoopback(addr) {
  const n = normalizeAddr(addr);
  return n === '127.0.0.1' || n === '::1';
}

// ── usedJtis Map with 10-min eviction (v1.5 intra-TTL replay protection) ──
// Map<jti, { agent_name, lease_id, seen_at }>
const usedJtis = new Map();

// Periodic sweeper (every 60s) — evict entries older than 10 min.
// unref() so it does not keep the process alive in tests.
const _jtiSweeper = setInterval(() => {
  const cutoff = Date.now() - JTI_EVICTION_MS;
  for (const [jti, rec] of usedJtis) {
    if (rec.seen_at <= cutoff) usedJtis.delete(jti);
  }
}, 60 * 1000);
_jtiSweeper.unref?.();

// ── Aggregate global mint rate limit (in-memory, TODO slice 4 → DB) ──
// TODO(slice-4): replace with `credential_token_mint_rate` table queries.
const _mintTimestamps = []; // array of epoch ms, sliding window

function _pruneMintWindow(now) {
  const cutoff = now - AGGREGATE_MINT_WINDOW_MS;
  while (_mintTimestamps.length && _mintTimestamps[0] <= cutoff) {
    _mintTimestamps.shift();
  }
}

/**
 * Check and record a mint against the aggregate ≤5/min global limit.
 * Returns { ok: true } on success, { ok: false, retry_after_ms } on deny.
 * NOTE: synchronous check-and-insert — no await between, per §11.1 v1.6
 * atomicity assertion.
 */
export function checkAggregateMintRate() {
  const now = Date.now();
  _pruneMintWindow(now);
  if (_mintTimestamps.length >= AGGREGATE_MINT_LIMIT) {
    const retry_after_ms = AGGREGATE_MINT_WINDOW_MS - (now - _mintTimestamps[0]);
    return { ok: false, retry_after_ms: Math.max(1, retry_after_ms) };
  }
  _mintTimestamps.push(now);
  return { ok: true };
}

// ── HMAC token mint / verify ──
// payload_canonical = agent_name + ":" + exp + ":" + jti
// token = base64url(payload_canonical + ":" + HMAC_SHA256(secret, payload_canonical))

function _hmac(secret, data) {
  return createHmac('sha256', secret).update(data).digest();
}

export function mintAgentToken(agent_name, secret, nowMs = Date.now()) {
  const exp = nowMs + TOKEN_TTL_MS;
  const jti = randomUUID();
  const canonical = `${agent_name}:${exp}:${jti}`;
  const mac = _hmac(secret, canonical).toString('base64url');
  const token = Buffer.from(`${canonical}:${mac}`, 'utf-8').toString('base64url');
  return { token, expires_at: exp, jti };
}

/**
 * Verify a bearer token.
 * v1.6 atomicity: this function is declared `function` (NOT async) and
 * performs the usedJtis check-and-insert synchronously with NO await between
 * the `has()` check and the `set()` call. Do not add awaits to this function.
 *
 * @param {string} token  base64url-encoded token from Authorization header
 * @param {string} secret HMAC secret
 * @param {string} expectedAgentName  agent_name the caller is requesting lease for
 * @param {string|null} leaseIdForBind  lease_id to bind jti to (null on first use)
 * @returns {{ok: true, agent_name, exp, jti} | {ok: false, code: string}}
 */
export function verifyAgentToken(token, secret, expectedAgentName, leaseIdForBind = null) {
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, code: 'token_missing' };
  }
  let decoded;
  try {
    decoded = Buffer.from(token, 'base64url').toString('utf-8');
  } catch {
    return { ok: false, code: 'token_malformed' };
  }
  // split off trailing :mac — canonical may contain colons but format is fixed 3 fields + mac
  const parts = decoded.split(':');
  if (parts.length !== 4) return { ok: false, code: 'token_malformed' };
  const [agent_name, expStr, jti, macProvided] = parts;
  if (agent_name !== expectedAgentName) return { ok: false, code: 'agent_mismatch' };
  const exp = Number(expStr);
  if (!Number.isFinite(exp)) return { ok: false, code: 'token_malformed' };
  if (Date.now() >= exp) return { ok: false, code: 'token_expired' };

  // Constant-time HMAC compare
  const canonical = `${agent_name}:${exp}:${jti}`;
  const expectedMac = _hmac(secret, canonical);
  let providedMac;
  try {
    providedMac = Buffer.from(macProvided, 'base64url');
  } catch {
    return { ok: false, code: 'token_malformed' };
  }
  if (providedMac.length !== expectedMac.length) {
    // Dummy compare to equalize timing
    timingSafeEqual(expectedMac, expectedMac);
    return { ok: false, code: 'hmac_mismatch' };
  }
  if (!timingSafeEqual(providedMac, expectedMac)) {
    return { ok: false, code: 'hmac_mismatch' };
  }

  // ── v1.5 intra-TTL jti replay check (ATOMIC, no await) ──
  const existing = usedJtis.get(jti);
  if (existing) {
    // Same jti reused — only permitted if same (agent_name, lease_id) tuple
    // (heartbeat/release). If lease_id differs or first-bind lease_id is null
    // on a jti already bound to a different lease → reject.
    if (existing.agent_name !== agent_name) {
      return { ok: false, code: 'jti_reused_other_agent' };
    }
    if (leaseIdForBind && existing.lease_id && existing.lease_id !== leaseIdForBind) {
      return { ok: false, code: 'jti_reused_other_lease' };
    }
    // v1.6: pure auth-gate replay (caller passes leaseIdForBind=null and the
    // jti was already recorded with no lease binding) → reject. This closes
    // the §11.1 intra-TTL replay window for the verifyHmacBearer authn surface.
    if (!leaseIdForBind && !existing.lease_id) {
      return { ok: false, code: 'jti_replay' };
    }
    // OK — same agent, matching lease (heartbeat/release semantics).
  } else {
    usedJtis.set(jti, { agent_name, lease_id: leaseIdForBind, seen_at: Date.now() });
  }

  return { ok: true, agent_name, exp, jti };
}

// Test / introspection helpers (not for production hot path)
export function _debug_usedJtisSize() { return usedJtis.size; }
export function _debug_resetMintWindow() { _mintTimestamps.length = 0; }
export function _debug_clearUsedJtis() { usedJtis.clear(); }
