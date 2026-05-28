/**
 * credential-probe.mjs — validity check for a provider credential.
 *
 * Decides the wire protocol by provider/base_url, then fires a minimal
 * (max_tokens 16) request. This is why we don't reuse the older
 * /api/config/llm/test logic verbatim: that endpoint hardcodes
 * api.anthropic.com for provider==='anthropic' and assumes OpenAI's
 * /chat/completions for everything else — which mis-probes an
 * Anthropic-protocol provider hosted at a custom base_url (e.g. Xiaomi MiMo
 * at https://token-plan-cn.xiaomimimo.com/anthropic, the case that motivated
 * this whole feature).
 *
 * Protocol decision:
 *   - Anthropic-style (POST {base}/v1/messages, x-api-key + anthropic-version)
 *     when provider ∈ ANTHROPIC_STYLE or base_url path contains '/anthropic'.
 *   - OpenAI-style (POST {base}/chat/completions, Bearer) otherwise.
 */

const ANTHROPIC_STYLE = new Set(['anthropic', 'xiaomi', 'minimax']);

// Block obvious SSRF targets. base_url is admin-entered (Chairman/CEO/HR), so
// the risk is lower than arbitrary user input, but the cloud metadata IP and
// non-http(s) schemes are never legitimate here.
function ssrfReject(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return 'invalid base_url'; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return `scheme ${u.protocol} not allowed`;
  const host = u.hostname;
  if (host === '169.254.169.254' || host === 'metadata.google.internal') return 'metadata endpoint blocked';
  return null; // ok
}

function isAnthropicStyle(provider, baseUrl) {
  if (ANTHROPIC_STYLE.has((provider || '').toLowerCase())) return true;
  try { if (new URL(baseUrl).pathname.includes('/anthropic')) return true; } catch {}
  return false;
}

/**
 * @param {{ provider, base_url, token, model }} cred
 * @param {number} [timeoutMs=12000]
 * @returns {Promise<{ ok: boolean, status: number|null, detail: string }>}
 */
export async function probeCredential({ provider, base_url, token, model }, timeoutMs = 12000) {
  if (!base_url) return { ok: false, status: null, detail: 'no base_url configured' };
  if (!token)    return { ok: false, status: null, detail: 'no token configured' };
  const ssrf = ssrfReject(base_url);
  if (ssrf) return { ok: false, status: null, detail: ssrf };

  const base = base_url.replace(/\/+$/, '');
  const anthropicStyle = isAnthropicStyle(provider, base_url);
  const url = anthropicStyle ? `${base}/v1/messages` : `${base}/chat/completions`;
  const headers = anthropicStyle
    ? { 'content-type': 'application/json', 'x-api-key': token, 'anthropic-version': '2023-06-01' }
    : { 'content-type': 'application/json', 'authorization': `Bearer ${token}` };
  const body = JSON.stringify({
    model: model || (anthropicStyle ? 'claude-3-5-haiku-20241022' : 'gpt-4o-mini'),
    max_tokens: 16,
    messages: [{ role: 'user', content: 'ping' }],
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers, body, signal: ctrl.signal });
    if (res.ok) return { ok: true, status: res.status, detail: 'ok' };
    let txt = '';
    try { txt = (await res.text()).slice(0, 200); } catch {}
    return { ok: false, status: res.status, detail: `HTTP ${res.status}: ${txt}` };
  } catch (e) {
    return { ok: false, status: null, detail: e.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : `fetch failed: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}
