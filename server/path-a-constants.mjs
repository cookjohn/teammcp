/**
 * Path A shared constants — Doc-A v1.6 §11 dedupe (§6 #13).
 *
 * Single source of truth for Path A magic numbers, scopes, and identifiers.
 * Imported by process-manager.mjs (Path A inject), credential-lease.mjs,
 * HR/path-a-driver.mjs, and tests.
 *
 * REGRESSION: spec §11 dedupe acceptance requires
 *   Object.keys(<this module>).length === 10
 * Adding/removing exports breaks the regression test in __tests__/path-a-constants.test.mjs.
 */

export const PATH_A_SCOPES = [
  'user:file_upload',
  'user:inference',
  'user:mcp_servers',
  'user:profile',
  'user:sessions:claude_code',
];
export const PATH_A_SUB_TYPE = 'max';
export const PATH_A_RATE_LIMIT_TIER = 'default_claude_max_20x';

// §11.11 — TTL / sweep / heartbeat
export const LEASE_TTL_MS = 10 * 60 * 1000;        // 10 minutes
export const LEASE_SWEEP_INTERVAL_MS = 60 * 1000;  // 60s
export const LEASE_HEARTBEAT_INTERVAL_MS = 30_000; // 30s

// Admin token + lease bearer TTL (§11.11). Admin tokens are short-lived
// to bound the blast radius of a leaked HMAC bearer.
export const ADMIN_TOKEN_TTL_MS = 5 * 60 * 1000;   // 5 minutes
export const LEASE_BEARER_TTL_MS = 60 * 1000;      // 60s

// §11.6 rate limit window
export const LEASE_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 min
export const LEASE_RATE_LIMIT_MAX = 3;                   // 3 mints / window
