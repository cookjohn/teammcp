/**
 * redact.mjs — Doc-A v1.6 §11.11 (M6 header + body redaction).
 *
 * v1.6 SecTest HIGH-4: ALL keys lowercased; matching uses k.toLowerCase().
 * Without this, AccessToken / REFRESH_TOKEN / Token / Authorization slip
 * through case-sensitive Set lookups.
 */

const SENSITIVE_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie',
  'x-teammcp-secret', 'x-internal-secret', 'x-api-key',
]);

const SENSITIVE_BODY_KEYS = new Set([
  // generic
  'secret', 'token', 'password', 'bearer', 'apikey', 'api_key',
  'authorization',
  // Path A core fields (v1.5 must-fix)
  'accesstoken', 'refreshtoken', 'access_token', 'refresh_token',
  // defense in depth
  'credential', 'credentials', 'claudeaioauth',
  'refresh', 'authtoken', 'auth_token',
]);

export function redactHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) {
    const lk = String(k).toLowerCase();
    if (SENSITIVE_HEADERS.has(lk) || /^x-.*-(auth|secret|token)$/i.test(k)) {
      out[k] = '<redacted>';
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function redactBody(b) {
  if (b === null || b === undefined) return b;
  if (typeof b !== 'object') return b;
  if (Array.isArray(b)) return b.map(redactBody);
  const out = {};
  for (const [k, v] of Object.entries(b)) {
    if (SENSITIVE_BODY_KEYS.has(String(k).toLowerCase())) {
      out[k] = '<redacted>';
    } else if (v && typeof v === 'object') {
      out[k] = redactBody(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export { SENSITIVE_HEADERS, SENSITIVE_BODY_KEYS };
