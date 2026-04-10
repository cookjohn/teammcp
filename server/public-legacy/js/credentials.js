// ── Credentials ───────────────────────────────────────────────

let credentialsOverview = null;
let credentialsAgents = [];
let credentialsLeases = [];
let leasesTotal = 0;
let leasesOffset = 0;
let currentCredentialDetail = null;
let dashboardToken = sessionStorage.getItem('dashboardToken') || null;

// ── Dashboard Token ────────────────────────────────────────
async function ensureDashboardToken() {
  if (dashboardToken) return dashboardToken;
  try {
    const res = await fetch('/api/dashboard/token', {
      headers: { 'Authorization': 'Bearer ' + API_KEY }
    });
    if (!res.ok) throw new Error('Token fetch failed');
    const data = await res.json();
    dashboardToken = data.token || data.dashboardToken || data.access_token;
    if (dashboardToken) sessionStorage.setItem('dashboardToken', dashboardToken);
    return dashboardToken;
  } catch (e) {
    return null;
  }
}

// ── Credential API helper (adds x-dashboard-token) ──────────
async function credApi(path) {
  var token = await ensureDashboardToken();
  if (!token) {
    throw new Error('Unauthorized: dashboard token required');
  }
  const res = await fetch(path, {
    headers: {
      'Authorization': 'Bearer ' + API_KEY,
      'x-dashboard-token': token
    }
  });
  if (!res.ok) {
    var err = await res.json().catch(function() { return {}; });
    throw new Error(err.error || 'API ' + res.status);
  }
  return res.json();
}

async function credFetch(path, options) {
  options = options || {};
  var token = await ensureDashboardToken();
  if (!token) {
    throw new Error('Unauthorized: dashboard token required');
  }
  options.headers = options.headers || {};
  options.headers['Authorization'] = 'Bearer ' + API_KEY;
  options.headers['x-dashboard-token'] = token;
  const res = await fetch(path, options);
  if (!res.ok) {
    var err = await res.json().catch(function() { return {}; });
    throw new Error(err.error || 'Request failed');
  }
  return res;
}

// ── Switch to Credentials View ────────────────────────────
function switchToCredentials() {
  currentView = 'credentials';

  // Hide all views and overlays
  document.getElementById('messages-container').style.display = 'none';
  document.getElementById('compose').classList.remove('active');
  document.getElementById('channel-header').style.display = 'none';
  document.getElementById('pin-bar').classList.remove('active');
  document.getElementById('pinned-panel').classList.remove('active');
  document.getElementById('tasks-container').classList.remove('active');
  document.getElementById('state-container').classList.remove('active');
  document.getElementById('agents-container').classList.remove('active');
  document.getElementById('monitor-container').classList.remove('active');
  if (typeof stopMonitorRefresh === 'function') stopMonitorRefresh();
  closeAllOverlays();

  // Show credentials view
  document.getElementById('credentials-container').classList.add('active');

  // Update sidebar highlights
  document.querySelectorAll('.channel-item').forEach(function(el) {
    el.classList.remove('active');
  });
  document.getElementById('tasks-nav').classList.remove('active');
  document.getElementById('state-nav').classList.remove('active');
  document.getElementById('agents-nav').classList.remove('active');
  document.getElementById('monitor-nav').classList.remove('active');
  document.getElementById('credentials-nav').classList.add('active');

  // Load data: overview first (provides agent data for auth table), then leases in parallel
  loadCredentialsOverview().then(function() {
    loadCredentialsAgents();
    return loadCredentialsLeases().catch(function() {});
  }).then(function() {
    renderCredentialsAuthTable();
  });
}

// ── Load Overview ─────────────────────────────────────────
async function loadCredentialsOverview() {
  try {
    const data = await credApi('/api/dashboard/credentials/overview');
    credentialsOverview = data;
    renderCredentialsStats();
  } catch (e) {
    console.error('Failed to load credentials overview:', e);
    credentialsOverview = { agents: {}, leases: {}, oauth: {}, distribution: {} };
    renderCredentialsStats();
    if (e.message && e.message.indexOf('Unauthorized') !== -1) {
      var body = document.getElementById('credentials-body');
      if (body) body.innerHTML = '<div class="credentials-empty"><div class="icon">&#9888;</div><div>Unauthorized: unable to obtain dashboard token.<br>Please refresh the page or re-login.</div></div>';
    }
  }
}

// ── Load Agents (for Auth Strategy table) ──────────────────
async function loadCredentialsAgents() {
  // Reuse data from loadCredentialsOverview if available
  if (credentialsOverview && Array.isArray(credentialsOverview.agents)) {
    credentialsAgents = credentialsOverview.agents;
    return;
  }
  try {
    const data = await credApi('/api/dashboard/credentials/overview');
    credentialsAgents = data.agents || [];
  } catch (e) {
    console.error('Failed to load credentials agents:', e);
    credentialsAgents = [];
  }
}

// ── Render Auth Strategy Table into placeholder ────────────
function renderCredentialsAuthTable() {
  var body = document.getElementById('credentials-body');
  if (!body) return;

  // Build full body: Zone 1 auth table + Zone 2 leases + Zone 3 tokenstore
  // We need to rebuild the full body because zones are stacked
  // For efficiency, use a marker approach: replace only the auth table section
  var authTableHtml = renderAuthStrategyTable();
  var leasesSectionHtml = renderCredentialsLeasesSection();
  var tokenstoreHtml = renderTokenStoreCard();

  body.innerHTML = authTableHtml + leasesSectionHtml + tokenstoreHtml;
}

// ── Render Leases Section HTML (Zone 2, for body rebuild) ──
function renderCredentialsLeasesSection() {
  var html = '<div class="credentials-section">';
  html += '<div class="credentials-section-title">Credential Leases</div>';

  if (credentialsLeases.length === 0) {
    html += '<div class="credentials-empty"><div class="icon">&#128274;</div><div>No leases found</div></div>';
  } else {
    html += '<table class="leases-table">';
    html += '<thead><tr>';
    html += '<th>Lease ID</th>';
    html += '<th>Agent</th>';
    html += '<th>Leased At</th>';
    html += '<th>Expires At</th>';
    html += '<th>Reason</th>';
    html += '<th>Status</th>';
    html += '<th>Action</th>';
    html += '</tr></thead>';
    html += '<tbody>';

    for (var i = 0; i < credentialsLeases.length; i++) {
      var lease = credentialsLeases[i];
      var statusClass = lease.status === 'active' ? 'online' : (lease.status === 'revoked' ? 'offline' : 'warn');
      var statusLabel = lease.status ? lease.status.charAt(0).toUpperCase() + lease.status.slice(1) : 'Unknown';
      var shortId = (lease.lease_id || '').substring(0, 8);
      var leasedAt = lease.leased_at ? formatDate(lease.leased_at) + ' ' + formatTime(lease.leased_at) : '-';
      var expiresAt = lease.expires_at ? formatDate(lease.expires_at) + ' ' + formatTime(lease.expires_at) : '-';
      var canRevoke = lease.status === 'active' ? true : false;

      html += '<tr>';
      html += '<td class="lease-id">' + escapeHtml(shortId) + '</td>';
      html += '<td><span class="agent-name-tag" style="color:' + agentColor(lease.agent) + ';">' + escapeHtml(lease.agent || '-') + '</span></td>';
      html += '<td class="lease-time">' + escapeHtml(leasedAt) + '</td>';
      html += '<td class="lease-time">' + escapeHtml(expiresAt) + '</td>';
      html += '<td>' + escapeHtml(lease.reason || '-') + '</td>';
      html += '<td><span class="status-dot ' + statusClass + '"></span> ' + escapeHtml(statusLabel) + '</td>';
      html += '<td>';
      if (canRevoke) {
        html += '<button class="btn-revoke" onclick="revokeLease(\'' + escapeHtml(lease.lease_id) + '\', \'' + escapeHtml(lease.agent) + '\')">Revoke</button>';
      } else {
        html += '<span style="color:var(--text-muted);font-size:12px;">-</span>';
      }
      html += '</td>';
      html += '</tr>';
    }

    html += '</tbody></table>';

    if (leasesTotal > 50) {
      var page = Math.floor(leasesOffset / 50) + 1;
      var totalPages = Math.ceil(leasesTotal / 50);
      html += '<div class="leases-pagination">';
      html += '<span>Page ' + page + ' of ' + totalPages + ' (' + leasesTotal + ' total)</span>';
      if (leasesOffset > 0) {
        html += ' <button class="btn-pagination" onclick="leasesPrevPage()">Prev</button>';
      }
      if (leasesOffset + 50 < leasesTotal) {
        html += ' <button class="btn-pagination" onclick="leasesNextPage()">Next</button>';
      }
      html += '</div>';
    }
  }
  html += '</div>';
  return html;
}

// ── Load Leases ───────────────────────────────────────────
async function loadCredentialsLeases(limit) {
  limit = limit || 50;
  try {
    const params = new URLSearchParams({ limit: limit, offset: leasesOffset });
    const res = await credFetch('/api/dashboard/credentials/leases?' + params.toString());
    const data = await res.json();
    credentialsLeases = data.leases || [];
    leasesTotal = data.total || 0;
  } catch (e) {
    console.error('Failed to load credentials leases:', e);
    credentialsLeases = [];
  }
}

// ── Render Stats Bar ───────────────────────────────────────
function renderCredentialsStats() {
  const div = document.getElementById('credentials-stats');
  if (!div || !credentialsOverview) return;

  var agentsList = Array.isArray(credentialsOverview.agents) ? credentialsOverview.agents : [];
  var tokenStatus = credentialsOverview.tokenStatus || {};

  // Compute stats from agents array
  var totalAgents = agentsList.length;
  var pathACount = agentsList.filter(function(a) { return a.auth_strategy === 'path_a'; }).length;
  var legacyCount = agentsList.filter(function(a) { return !a.auth_strategy || a.auth_strategy === 'legacy'; }).length;
  var onlineCount = agentsList.filter(function(a) { return a.status === 'online'; }).length;

  var html = '';

  // Agent stats
  html += '<div class="cred-stat-item">';
  html += '<span class="cred-stat-label">Total Agents</span>: ';
  html += '<span class="cred-stat-value">' + totalAgents + '</span>';
  html += '</div>';

  html += '<div class="cred-stat-item">';
  html += '<span class="cred-stat-label">Path A</span>: ';
  html += '<span class="cred-stat-value" style="color:var(--green);">' + pathACount + '</span>';
  html += '</div>';

  html += '<div class="cred-stat-item">';
  html += '<span class="cred-stat-label">Legacy</span>: ';
  html += '<span class="cred-stat-value" style="color:var(--orange);">' + legacyCount + '</span>';
  html += '</div>';

  html += '<div class="cred-stat-item">';
  html += '<span class="cred-stat-label">Online</span>: ';
  html += '<span class="cred-stat-value" style="color:var(--accent);">' + onlineCount + '</span>';
  html += '</div>';

  // Token status
  if (tokenStatus.loggedIn !== undefined) {
    html += '<div class="cred-stat-sep"></div>';
    html += '<div class="cred-stat-item">';
    html += '<span class="cred-stat-label">Token</span>: ';
    html += '<span class="cred-stat-value" style="color:' + (tokenStatus.loggedIn ? 'var(--green)' : 'var(--red)') + ';">' + (tokenStatus.loggedIn ? 'Valid' : 'Invalid') + '</span>';
    html += '</div>';
  }

  div.innerHTML = html;
}

// ── Render Auth Strategy Table (Zone 1) ───────────────────
function renderAuthStrategyTable() {
  var html = '<div class="credentials-section">';
  html += '<div class="credentials-section-title">Auth Strategy Overview</div>';

  if (credentialsAgents.length === 0) {
    html += '<div class="credentials-empty"><div class="icon">&#128272;</div><div>No agents found</div></div>';
  } else {
    html += '<table class="leases-table">';
    html += '<thead><tr>';
    html += '<th>Agent</th>';
    html += '<th>Role</th>';
    html += '<th>Auth Strategy</th>';
    html += '<th>Status</th>';
    html += '<th>Action</th>';
    html += '</tr></thead>';
    html += '<tbody>';

    for (var i = 0; i < credentialsAgents.length; i++) {
      var agent = credentialsAgents[i];
      var strategy = agent.auth_strategy || 'legacy';
      var statusClass = agent.status === 'online' ? 'online' : 'offline';
      var statusLabel = agent.status === 'online' ? 'Online' : 'Offline';
      var roleLabel = agent.role || '-';
      var agentName = agent.name || agent.agent_id || '-';
      var strategyClass = strategy === 'path_a' ? 'strategy-patha' : 'strategy-legacy';
      var currentUser = typeof CURRENT_USER !== 'undefined' ? CURRENT_USER : null;
      var canSwitch = currentUser === 'Chairman' || currentUser === 'CEO';

      html += '<tr>';
      html += '<td><span class="agent-name-tag" style="color:' + agentColor(agentName) + ';">' + escapeHtml(agentName) + '</span></td>';
      html += '<td style="color:var(--text-dim);font-size:12px;">' + escapeHtml(roleLabel) + '</td>';
      html += '<td><span class="strategy-badge ' + strategyClass + '">' + escapeHtml(strategy) + '</span></td>';
      html += '<td><span class="status-dot ' + statusClass + '"></span> ' + escapeHtml(statusLabel) + '</td>';
      html += '<td>';
      if (canSwitch) {
        html += '<select class="strategy-select" onchange="switchAgentAuthStrategy(\'' + escapeHtml(agentName) + '\', this.value)">';
        html += '<option value="legacy"' + (strategy === 'legacy' ? ' selected' : '') + '>legacy</option>';
        html += '<option value="path_a"' + (strategy === 'path_a' ? ' selected' : '') + '>path_a</option>';
        html += '</select>';
      } else {
        html += '<span style="color:var(--text-muted);font-size:12px;">-</span>';
      }
      html += '</td>';
      html += '</tr>';
    }

    html += '</tbody></table>';
  }
  html += '</div>';

  return html;
}

// ── Render Full Body (all 3 zones) ────────────────────────
function renderCredentialsBody() {
  var body = document.getElementById('credentials-body');
  if (!body) return;

  var html = '';

  // Zone 1: Auth Strategy overview table
  html += renderAuthStrategyTable();

  // Zone 2: Leases table
  html += '<div class="credentials-section">';
  html += '<div class="credentials-section-title">Credential Leases</div>';

  if (credentialsLeases.length === 0) {
    html += '<div class="credentials-empty"><div class="icon">&#128274;</div><div>No leases found</div></div>';
  } else {
    html += '<table class="leases-table">';
    html += '<thead><tr>';
    html += '<th>Lease ID</th>';
    html += '<th>Agent</th>';
    html += '<th>Leased At</th>';
    html += '<th>Expires At</th>';
    html += '<th>Reason</th>';
    html += '<th>Status</th>';
    html += '<th>Action</th>';
    html += '</tr></thead>';
    html += '<tbody>';

    for (var i = 0; i < credentialsLeases.length; i++) {
      var lease = credentialsLeases[i];
      var statusClass = lease.status === 'active' ? 'online' : (lease.status === 'revoked' ? 'offline' : 'warn');
      var statusLabel = lease.status ? lease.status.charAt(0).toUpperCase() + lease.status.slice(1) : 'Unknown';
      var shortId = (lease.lease_id || '').substring(0, 8);
      var leasedAt = lease.leased_at ? formatDate(lease.leased_at) + ' ' + formatTime(lease.leased_at) : '-';
      var expiresAt = lease.expires_at ? formatDate(lease.expires_at) + ' ' + formatTime(lease.expires_at) : '-';
      var canRevoke = lease.status === 'active' ? true : false;

      html += '<tr>';
      html += '<td class="lease-id">' + escapeHtml(shortId) + '</td>';
      html += '<td><span class="agent-name-tag" style="color:' + agentColor(lease.agent) + ';">' + escapeHtml(lease.agent || '-') + '</span></td>';
      html += '<td class="lease-time">' + escapeHtml(leasedAt) + '</td>';
      html += '<td class="lease-time">' + escapeHtml(expiresAt) + '</td>';
      html += '<td>' + escapeHtml(lease.reason || '-') + '</td>';
      html += '<td><span class="status-dot ' + statusClass + '"></span> ' + escapeHtml(statusLabel) + '</td>';
      html += '<td>';
      if (canRevoke) {
        html += '<button class="btn-revoke" onclick="revokeLease(\'' + escapeHtml(lease.lease_id) + '\', \'' + escapeHtml(lease.agent) + '\')">Revoke</button>';
      } else {
        html += '<span style="color:var(--text-muted);font-size:12px;">-</span>';
      }
      html += '</td>';
      html += '</tr>';
    }

    html += '</tbody></table>';

    // Pagination
    if (leasesTotal > 50) {
      var page = Math.floor(leasesOffset / 50) + 1;
      var totalPages = Math.ceil(leasesTotal / 50);
      html += '<div class="leases-pagination">';
      html += '<span>Page ' + page + ' of ' + totalPages + ' (' + leasesTotal + ' total)</span>';
      if (leasesOffset > 0) {
        html += ' <button class="btn-pagination" onclick="leasesPrevPage()">Prev</button>';
      }
      if (leasesOffset + 50 < leasesTotal) {
        html += ' <button class="btn-pagination" onclick="leasesNextPage()">Next</button>';
      }
      html += '</div>';
    }
  }
  html += '</div>';

  // Zone 3: TokenStore / OAuth status card
  html += renderTokenStoreCard();

  body.innerHTML = html;
}

// ── Render Leases (called after overview loads, then fetches agents separately) ─
function renderCredentialsLeases() {
  renderCredentialsBody();
}

// ── TokenStore / OAuth Status Card ─────────────────────────
function renderTokenStoreCard() {
  var html = '<div class="credentials-section">';
  html += '<div class="credentials-section-title">TokenStore Status</div>';

  var tokenStatus = credentialsOverview ? credentialsOverview.tokenStatus : null;
  if (!credentialsOverview || !tokenStatus) {
    html += '<div class="credentials-empty"><div>Loading...</div></div>';
    html += '</div>';
    return html;
  }

  var oauth = tokenStatus;
  var connected = oauth.loggedIn;
  var tokenClass = connected ? 'token-ok' : 'token-bad';
  var tokenLabel = connected ? 'Connected' : 'Disconnected';

  html += '<div class="tokenstore-card ' + tokenClass + '">';

  // Status line
  html += '<div class="tokenstore-status-row">';
  html += '<span class="status-dot ' + (connected ? 'online' : 'offline') + '"></span>';
  html += '<span class="tokenstore-status-label">' + escapeHtml(tokenLabel) + '</span>';
  html += '</div>';

  // Details
  if (oauth.expiresAt) {
    var expDate = new Date(oauth.expiresAt);
    var expStr = expDate.toLocaleString();
    var isExpiringSoon = (oauth.expiresAt - Date.now()) < 30 * 60 * 1000; // 30min
    html += '<div class="tokenstore-meta">';
    html += 'Expires: <span style="color:' + (isExpiringSoon ? 'var(--red)' : 'var(--text)') + ';">' + escapeHtml(expStr) + '</span>';
    html += ' <span style="color:var(--text-dim);">(' + Math.round((oauth.expiresIn || 0) / 60000) + ' min)</span>';
    html += '</div>';
  }

  if (oauth.lastRefresh) {
    html += '<div class="tokenstore-meta">';
    html += 'Last Refresh: <span style="color:var(--text-dim);">' + escapeHtml(formatDate(oauth.lastRefresh) + ' ' + formatTime(oauth.lastRefresh)) + '</span>';
    html += '</div>';
  }

  // Action buttons
  html += '<div class="tokenstore-actions">';
  html += '<button class="btn-token-action" onclick="refreshOAuthFromDashboard()">Refresh Token</button>';
  html += '<button class="btn-token-action" onclick="startOAuthLogin()">Re-login</button>';
  html += '</div>';

  html += '</div>'; // .tokenstore-card
  html += '</div>'; // .credentials-section

  return html;
}

// ── Revoke Lease ───────────────────────────────────────────
async function revokeLease(leaseId, agent) {
  if (!confirm('Revoke lease ' + leaseId.substring(0, 8) + ' for agent ' + agent + '?')) return;
  try {
    await credFetch('/api/credentials/lease/' + encodeURIComponent(agent) + '/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lease_id: leaseId })
    });
    loadCredentialsOverview();
    Promise.all([
      loadCredentialsAgents().catch(function() {}),
      loadCredentialsLeases().catch(function() {})
    ]).then(function() { renderCredentialsAuthTable(); });
  } catch (e) {
    alert('Revoke failed: ' + e.message);
  }
}

// ── Switch Agent Auth Strategy ─────────────────────────────
async function switchAgentAuthStrategy(agentName, newStrategy) {
  if (!confirm('Switch ' + agentName + ' auth_strategy to ' + newStrategy + '?')) {
    // Reset select to previous value by reloading agents
    Promise.all([
      loadCredentialsAgents().catch(function() {}),
      loadCredentialsLeases().catch(function() {})
    ]).then(function() { renderCredentialsAuthTable(); });
    return;
  }
  try {
    await credFetch('/api/dashboard/credentials/agents/' + encodeURIComponent(agentName) + '/auth-strategy', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth_strategy: newStrategy, reason: 'Manual switch from dashboard' })
    });
    loadCredentialsOverview();
    Promise.all([
      loadCredentialsAgents().catch(function() {}),
      loadCredentialsLeases().catch(function() {})
    ]).then(function() { renderCredentialsAuthTable(); });
  } catch (e) {
    alert('Switch failed: ' + e.message);
    Promise.all([
      loadCredentialsAgents().catch(function() {}),
      loadCredentialsLeases().catch(function() {})
    ]).then(function() { renderCredentialsAuthTable(); });
  }
}

// ── Pagination ──────────────────────────────────────────────
function leasesNextPage() {
  leasesOffset += 50;
  loadCredentialsLeases();
}

function leasesPrevPage() {
  leasesOffset = Math.max(0, leasesOffset - 50);
  loadCredentialsLeases();
}

// ── OAuth Actions ─────────────────────────────────────────
async function refreshOAuthFromDashboard() {
  try {
    var btn = document.querySelector('.btn-token-action');
    if (btn) { btn.disabled = true; btn.textContent = 'Refreshing...'; }
    await credFetch('/api/auth/refresh', { method: 'POST' });
    await loadCredentialsOverview();
    if (btn) { btn.disabled = false; btn.textContent = 'Refresh Token'; }
  } catch (e) {
    alert('Token refresh failed: ' + e.message);
    var btn2 = document.querySelector('.btn-token-action');
    if (btn2) { btn2.disabled = false; btn2.textContent = 'Refresh Token'; }
  }
}

async function startOAuthLogin() {
  try {
    var res = await credFetch('/api/auth/login/start', { method: 'POST' });
    var data = await res.json();
    var oauthUrl = data.authorizeUrl || data.url;
    if (oauthUrl) {
      window.open(oauthUrl, '_blank');
    } else {
      alert('OAuth login started. Follow the instructions.');
    }
  } catch (e) {
    alert('OAuth login failed: ' + e.message);
  }
}

// ── Load Credentials (main entry) ─────────────────────────
function loadCredentials() {
  loadCredentialsOverview();
  loadCredentialsLeases();
}
