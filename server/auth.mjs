import { URL } from 'node:url';
import { getAgentByKey, setAgentStatus } from './db.mjs';

/**
 * Authenticate request via Authorization: Bearer tmcp_xxx header
 * or URL query parameter ?key=tmcp_xxx (fallback for EventSource).
 * Returns the agent object or null.
 */
export function authenticate(req) {
  let apiKey = null;

  // Try Authorization header first
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) {
    apiKey = auth.slice(7).trim();
  }

  // Fallback: URL query parameter ?key=tmcp_xxx
  if (!apiKey) {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      apiKey = url.searchParams.get('key');
    } catch { /* ignore */ }
  }

  if (!apiKey) return null;
  const agent = getAgentByKey(apiKey);
  if (!agent) return null;

  // Touch last_seen
  setAgentStatus(agent.name, agent.status === 'offline' ? 'online' : agent.status);
  return agent;
}

/**
 * Middleware-style: sends 401 if not authenticated, otherwise attaches req.agent.
 * Returns true if authenticated, false if response was already sent.
 */
export function requireAuth(req, res) {
  const agent = authenticate(req);
  if (!agent) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized: invalid or missing API key' }));
    return false;
  }
  req.agent = agent;
  return true;
}
