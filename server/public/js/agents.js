// ── Agents ───────────────────────────────────────────────
let offlineCollapsed = true;

function renderAgents() {
  const container = document.getElementById('agent-list');
  const online = agents.filter(a => a.status === 'online').sort((a, b) => a.name.localeCompare(b.name));
  const offline = agents.filter(a => a.status !== 'online').sort((a, b) => a.name.localeCompare(b.name));

  // Update title with count
  document.getElementById('agents-title').textContent = `${i18n.t('nav.agents')} (${online.length}/${agents.length})`;

  let html = '';

  // Online agents
  if (online.length > 0) {
    html += `<div class="agent-group-title" style="cursor:default">
      <span style="color:var(--green)">●</span> ${i18n.t('agents.online')} <span class="agent-group-count">${online.length}</span>
    </div>`;
    html += '<div class="agent-grid">';
    for (const a of online) html += renderAgentItem(a);
    html += '</div>';
  }

  // Offline agents (collapsible, auto-expand if few agents)
  if (offline.length > 0) {
    var showOffline = !offlineCollapsed || agents.length <= 10;
    html += `<div class="agent-group-title" onclick="toggleOfflineAgents()">
      <span class="toggle-arrow ${showOffline ? '' : 'collapsed'}">▼</span>
      ${i18n.t('agents.offline')} <span class="agent-group-count">${offline.length}</span>
    </div>`;
    if (showOffline) {
      html += '<div class="agent-grid offline-grid">';
      for (const a of offline) html += renderAgentItem(a);
      html += '</div>';
    }
  }

  container.innerHTML = html;
}

function renderAgentItem(a) {
  const online = a.status === 'online';
  const isSelf = a.name === agentName;
  const title = isSelf ? i18n.t('agent.you') : i18n.t('agent.clickDm') + ' ' + a.name;
  const roleHtml = a.role ? `<span class="agent-role" title="${escapeHtml(a.role)}">${escapeHtml(a.role)}</span>` : '';

  return `<div class="agent-item ${isSelf ? 'self' : ''}" title="${title}" onclick="${isSelf ? '' : "openDmWithAgent('" + escapeHtml(a.name) + "')"}">
    <span class="agent-dot ${online ? 'online' : 'offline'}"></span>
    <span class="agent-name">${escapeHtml(a.name)}${isSelf ? ' <span class="agent-self-tag">' + i18n.t('agent.self') + '</span>' : ''}</span>
    ${roleHtml}
  </div>`;
}

function toggleOfflineAgents() {
  offlineCollapsed = !offlineCollapsed;
  renderAgents();
}

async function toggleResume(name, enable) {
  try {
    await fetch(`/api/agents/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      headers: { 'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ use_resume: enable })
    });
    await refreshAgents();
  } catch (e) {
    alert('Failed: ' + e.message);
  }
}

async function agentStart(name, btn) {
  btn.disabled = true;
  btn.textContent = i18n.t('agent.starting');
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(name)}/start`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + API_KEY }
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Failed: ${res.status}`);
    }
    await refreshAgents();
    if (currentView === 'agents') loadAgentManagement();
    // Re-refresh after delay to catch SSE status update
    setTimeout(async function() {
      await refreshAgents();
      if (currentView === 'agents') loadAgentManagement();
    }, 2000);
  } catch (e) {
    alert(i18n.t('agent.startFailed') + ': ' + e.message);
    btn.disabled = false;
    btn.textContent = i18n.t('agent.start');
  }
}

async function agentStop(name, btn) {
  if (!confirm(`Stop agent ${name}?`)) return;
  btn.disabled = true;
  btn.textContent = i18n.t('agent.stopping');
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(name)}/stop`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + API_KEY }
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Failed: ${res.status}`);
    }
    await refreshAgents();
    if (currentView === 'agents') loadAgentManagement();
    // Re-refresh after delay to catch SSE status update
    setTimeout(async function() {
      await refreshAgents();
      if (currentView === 'agents') loadAgentManagement();
    }, 2000);
  } catch (e) {
    alert(i18n.t('agent.stopFailed') + ': ' + e.message);
    btn.disabled = false;
    btn.textContent = i18n.t('agent.stop');
  }
}

// Agent Output Panel
let currentOutputAgent = null;
const agentOutputData = {}; // agentName -> [entries]

// Agent activity/typing indicator
const agentActivity = {}; // agentName -> { text, timer }
const ACTIVITY_TIMEOUT_MS = 30000;

function updateTypingIndicator() {
  const el = document.getElementById('typing-indicator');
  const active = Object.entries(agentActivity)
    .filter(([, v]) => v.text)
    .map(([name, v]) => `<span>${escapeHtml(name)} ${escapeHtml(v.text)}</span>`);
  el.innerHTML = active.join('');
}

function setAgentActivity(name, text) {
  if (agentActivity[name]?.timer) clearTimeout(agentActivity[name].timer);
  const timer = setTimeout(() => {
    delete agentActivity[name];
    updateTypingIndicator();
  }, ACTIVITY_TIMEOUT_MS);
  agentActivity[name] = { text, timer };
  updateTypingIndicator();
}

function clearAgentActivity(name) {
  if (agentActivity[name]?.timer) clearTimeout(agentActivity[name].timer);
  delete agentActivity[name];
  updateTypingIndicator();
}

function handleAgentOutput(data) {
  const name = data.agent;
  if (!agentOutputData[name]) agentOutputData[name] = [];
  agentOutputData[name].push(data);
  if (agentOutputData[name].length > 100) agentOutputData[name].shift();
  if (currentOutputAgent === name) renderAgentOutput();

  // Update typing indicator
  if (data.event === 'Stop' || data.event === 'stop') {
    clearAgentActivity(name);
  } else if (data.tool_name) {
    setAgentActivity(name, `${i18n.t('activity.using')} ${data.tool_name}...`);
  } else {
    setAgentActivity(name, i18n.t('activity.thinking'));
  }
}

function openAgentOutput(name) {
  currentOutputAgent = name;
  document.getElementById('agent-output-panel').classList.add('visible');
  document.getElementById('agent-output-title').textContent = `${name} ${i18n.t('agentDetail.output')}`;
  // Load history if empty
  if (!agentOutputData[name]) {
    agentOutputData[name] = [];
    api(`/api/agent-output/${encodeURIComponent(name)}`).then(res => {
      if (res.output) agentOutputData[name] = res.output;
      renderAgentOutput();
    }).catch(() => {});
  }
  renderAgentOutput();
}

function closeAgentOutput() {
  currentOutputAgent = null;
  document.getElementById('agent-output-panel').classList.remove('visible');
}

function renderAgentOutput() {
  const log = document.getElementById('agent-output-log');
  const entries = agentOutputData[currentOutputAgent] || [];
  if (!entries.length) {
    log.innerHTML = '<div style="color:var(--text-muted);padding:20px;text-align:center;">' + i18n.t('agent.noOutput') + '</div>';
    return;
  }
  let html = '';
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const time = e.timestamp ? new Date(e.timestamp).toLocaleTimeString() : '';
    const tool = e.tool_name ? `<span class="output-tool">${escapeHtml(e.tool_name)}</span>` : '';
    const result = e.tool_result ? escapeHtml(String(e.tool_result)) : (e.message ? escapeHtml(String(e.message).slice(0, 500)) : '');
    html += `<div class="output-entry">
      <div class="output-meta">${time} ${escapeHtml(e.event || '')} ${tool}</div>
      ${result ? `<div class="output-result">${result}</div>` : ''}
    </div>`;
  }
  log.innerHTML = html;
}

async function refreshAgents() {
  try {
    agents = await api('/api/agents');
    renderAgents();
  } catch {}
}

// ── Switch to Agents View ────────────────────────────────
function switchToAgents() {
  currentView = 'agents';
  // Hide all views and overlays
  document.getElementById('messages-container').style.display = 'none';
  document.getElementById('compose').classList.remove('active');
  document.getElementById('channel-header').style.display = 'none';
  document.getElementById('pin-bar').classList.remove('active');
  document.getElementById('pinned-panel').classList.remove('active');
  document.getElementById('tasks-container').classList.remove('active');
  document.getElementById('state-container').classList.remove('active');
  closeAllOverlays();
  // Show agents view
  document.getElementById('agents-container').classList.add('active');
  // Update sidebar highlights
  document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('active'));
  document.getElementById('agents-nav').classList.add('active');
  // Load agent management
  loadAgentManagement();
}

// ── Agent Management ─────────────────────────────────────
async function loadAgentManagement() {
  try {
    const data = await api('/api/agents');
    const agentsList = Array.isArray(data) ? data : (data.agents || []);
    renderAgentOverview(agentsList);
    renderOrgTree(agentsList);
    renderAgentGrid(agentsList);
  } catch (e) {
    console.error('Failed to load agents:', e);
  }
}

function renderAgentOverview(agentsList) {
  var online = agentsList.filter(function(a) { return a.status === 'online'; });
  var offline = agentsList.filter(function(a) { return a.status !== 'online'; });
  var html = '<div class="agents-overview-bar">';
  html += '<div class="agents-stat-card"><div class="stat-value">' + agentsList.length + '</div><div class="stat-label">' + i18n.t('agents.total') + '</div></div>';
  html += '<div class="agents-stat-card green"><div class="stat-value">' + online.length + '</div><div class="stat-label">' + i18n.t('agents.online') + '</div></div>';
  html += '<div class="agents-stat-card gray"><div class="stat-value">' + offline.length + '</div><div class="stat-label">' + i18n.t('agents.offline') + '</div></div>';
  html += '</div>';
  document.getElementById('agents-overview').innerHTML = html;
}

function renderOrgTree(agentsList) {
  var agentMap = {};
  for (var i = 0; i < agentsList.length; i++) {
    agentMap[agentsList[i].name] = agentsList[i];
  }

  // Find root nodes (no reports_to or reports_to is null/empty)
  var roots = [];
  var childrenMap = {};
  for (var i = 0; i < agentsList.length; i++) {
    var a = agentsList[i];
    var parent = a.reports_to || null;
    if (!parent) {
      roots.push(a);
    } else {
      if (!childrenMap[parent]) childrenMap[parent] = [];
      childrenMap[parent].push(a);
    }
  }

  // Sort roots and children alphabetically
  roots.sort(function(a, b) { return a.name.localeCompare(b.name); });
  for (var key in childrenMap) {
    childrenMap[key].sort(function(a, b) { return a.name.localeCompare(b.name); });
  }

  function buildNode(agent, isRoot) {
    var isOnline = agent.status === 'online';
    var html = '<div class="org-node' + (isRoot ? ' org-root' : '') + '">';
    html += '<div class="org-node-item" onclick="showAgentDetail(\'' + escapeHtml(agent.name) + '\')">';
    html += '<span class="org-node-dot ' + (isOnline ? 'online' : 'offline') + '"></span>';
    html += '<span class="org-node-name">' + escapeHtml(agent.name) + '</span>';
    if (agent.role) {
      html += '<span class="org-node-role">(' + escapeHtml(agent.role) + ')</span>';
    }
    html += '</div>';
    var children = childrenMap[agent.name] || [];
    if (children.length > 0) {
      html += '<div class="org-children">';
      for (var j = 0; j < children.length; j++) {
        html += buildNode(children[j], false);
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  var html = '<div class="org-tree-section">';
  html += '<div class="org-tree-title">' + i18n.t('agents.orgTree') + '</div>';
  html += '<div class="org-tree">';
  for (var i = 0; i < roots.length; i++) {
    html += buildNode(roots[i], true);
  }
  if (roots.length === 0) {
    html += '<div style="color:var(--text-muted); font-size:13px; padding:8px;">' + i18n.t('agents.noAgents') + '</div>';
  }
  html += '</div></div>';
  document.getElementById('agents-org-tree').innerHTML = html;
}

function renderAgentGrid(agentsList) {
  var sorted = agentsList.slice().sort(function(a, b) {
    // Online first, then alphabetical
    if (a.status === 'online' && b.status !== 'online') return -1;
    if (a.status !== 'online' && b.status === 'online') return 1;
    return a.name.localeCompare(b.name);
  });

  var html = '<div class="agents-grid-section">';
  html += '<div class="agents-grid-title">' + i18n.t('agents.allAgents') + '</div>';
  html += '<div class="agents-card-grid">';
  for (var i = 0; i < sorted.length; i++) {
    var a = sorted[i];
    var isOnline = a.status === 'online';
    html += '<div class="agent-card ' + (isOnline ? 'online' : 'offline') + '" onclick="showAgentDetail(\'' + escapeHtml(a.name) + '\')">';
    html += '<div class="agent-card-header">';
    html += '<span class="agent-card-name">' + escapeHtml(a.name) + '</span>';
    if (a.role) {
      html += '<span class="agent-card-role">' + escapeHtml(a.role) + '</span>';
    }
    html += '</div>';
    html += '<div class="agent-card-status">';
    html += '<span class="dot ' + (isOnline ? 'online' : 'offline') + '"></span>';
    html += '<span class="label">' + (isOnline ? i18n.t('agents.online') : i18n.t('agents.offline')) + '</span>';
    html += '</div>';
    if (!isOnline && a.last_seen) {
      html += '<div class="agent-card-lastseen">' + i18n.t('agents.lastSeen') + ': ' + formatTime(a.last_seen) + '</div>';
    }
    html += '<div class="agent-card-actions">';
    if (isOnline) {
      html += '<button class="stop-btn" onclick="event.stopPropagation(); agentStop(\'' + escapeHtml(a.name) + '\', this)">' + i18n.t('agent.stop') + '</button>';
    } else {
      html += '<button class="start-btn" onclick="event.stopPropagation(); agentStart(\'' + escapeHtml(a.name) + '\', this)">' + i18n.t('agent.start') + '</button>';
    }
    html += '<button onclick="event.stopPropagation(); openAgentOutput(\'' + escapeHtml(a.name) + '\')">' + i18n.t('agents.viewOutput') + '</button>';
    html += '</div>';
    html += '</div>';
  }
  html += '</div></div>';
  document.getElementById('agents-grid').innerHTML = html;
}

function showAgentDetail(name) {
  var agent = agents.find(function(a) { return a.name === name; });
  if (!agent) return;
  var isOnline = agent.status === 'online';
  var html = '';

  // Name & Status
  html += '<div class="detail-field">';
  html += '<div class="detail-label" style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">' + i18n.t('agentDetail.name') + '</div>';
  html += '<div style="font-size:16px; font-weight:700;">' + escapeHtml(agent.name) + '</div>';
  html += '</div>';

  html += '<div class="detail-field">';
  html += '<div class="detail-label" style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">' + i18n.t('agentDetail.role') + '</div>';
  html += '<div style="font-size:14px; color:var(--text-dim);">' + escapeHtml(agent.role || 'N/A') + '</div>';
  html += '</div>';

  html += '<div class="detail-field">';
  html += '<div class="detail-label" style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">' + i18n.t('agentDetail.status') + '</div>';
  html += '<div style="display:flex; align-items:center; gap:8px;">';
  html += '<span style="width:10px; height:10px; border-radius:50%; background:' + (isOnline ? 'var(--green)' : 'var(--text-muted)') + ';"></span>';
  html += '<span style="font-size:14px;">' + (isOnline ? i18n.t('agents.online') : i18n.t('agents.offline')) + '</span>';
  html += '</div></div>';

  html += '<div class="detail-field">';
  html += '<div class="detail-label" style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">' + i18n.t('agentDetail.reportsTo') + '</div>';
  html += '<div style="font-size:14px;">' + escapeHtml(agent.reports_to || i18n.t('agentDetail.noneRoot')) + '</div>';
  html += '</div>';

  if (agent.last_seen) {
    html += '<div class="detail-field">';
    html += '<div class="detail-label" style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">' + i18n.t('agentDetail.lastSeen') + '</div>';
    html += '<div style="font-size:13px; color:var(--text-dim);">' + formatTime(agent.last_seen) + '</div>';
    html += '</div>';
  }

  // Use Resume toggle
  html += '<div class="detail-field">';
  html += '<div class="detail-label" style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">' + i18n.t('agentDetail.resume') + '</div>';
  var resumeEnabled = agent.use_resume !== false;
  html += '<button style="padding:6px 16px; border-radius:var(--radius-sm); font-size:12px; font-weight:600; cursor:pointer; border:1px solid var(--border); background:' + (resumeEnabled ? 'rgba(61,214,140,0.15)' : 'var(--bg-input)') + '; color:' + (resumeEnabled ? 'var(--green)' : 'var(--text-dim)') + ';" onclick="toggleResume(\'' + escapeHtml(agent.name) + '\', ' + !resumeEnabled + '); setTimeout(function(){ showAgentDetail(\'' + escapeHtml(agent.name) + '\'); }, 500);">' + (resumeEnabled ? i18n.t('agentDetail.resumeOn') : i18n.t('agentDetail.resumeOff')) + '</button>';
  html += '</div>';

  // --- Edit Section ---
  html += '<div style="border-top:1px solid var(--border); margin-top:16px; padding-top:16px;">';
  html += '<div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:12px; font-weight:600;">' + i18n.t('agentDetail.config') + '</div>';

  // Auth Mode
  html += '<div class="detail-field">';
  html += '<div class="detail-label" style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">' + i18n.t('agentDetail.authMode') + '</div>';
  html += '<select id="edit-auth-mode" onchange="toggleEditAuthFields()" style="width:100%; padding:8px 12px; background:var(--bg-input); border:1px solid var(--border); border-radius:var(--radius-sm); color:var(--text); font-size:13px;">';
  html += '<option value="oauth"' + ((agent.auth_mode || 'oauth') === 'oauth' ? ' selected' : '') + '>' + i18n.t('agentDetail.oauth') + '</option>';
  html += '<option value="api_key"' + (agent.auth_mode === 'api_key' ? ' selected' : '') + '>' + i18n.t('agentDetail.apiKey') + '</option>';
  html += '</select>';
  html += '</div>';

  var showApiFields = agent.auth_mode === 'api_key';
  html += '<div id="edit-apikey-fields" style="display:' + (showApiFields ? 'block' : 'none') + ';">';

  // API Provider
  html += '<div class="detail-field">';
  html += '<div class="detail-label" style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">' + i18n.t('agentDetail.provider') + '</div>';
  html += '<select id="edit-api-provider" onchange="updateRouterHint()" style="width:100%; padding:8px 12px; background:var(--bg-input); border:1px solid var(--border); border-radius:var(--radius-sm); color:var(--text); font-size:13px;">';
  html += '<option value="">' + i18n.t('agentDetail.select') + '</option>';
  ['anthropic','openai','openrouter','custom'].forEach(function(p) {
    html += '<option value="' + p + '"' + (agent.api_provider === p ? ' selected' : '') + '>' + p.charAt(0).toUpperCase() + p.slice(1) + '</option>';
  });
  html += '</select></div>';

  // Router hint for non-Anthropic providers
  html += '<div id="router-hint" class="router-hint" style="background:var(--bg-msg);border:1px solid var(--orange);border-radius:4px;padding:8px;margin:8px 0;font-size:12px;color:var(--orange);display:none;">';
  html += '\u26a0\ufe0f Non-Anthropic providers require claude-code-router. Use /deploy-router skill or deploy manually.';
  html += '</div>';

  // API Base URL
  html += '<div class="detail-field">';
  html += '<div class="detail-label" style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">' + i18n.t('agentDetail.baseUrl') + '</div>';
  html += '<input type="text" id="edit-api-base-url" value="' + escapeHtml(agent.api_base_url || '') + '" placeholder="https://api.anthropic.com" style="width:100%; padding:8px 12px; background:var(--bg-input); border:1px solid var(--border); border-radius:var(--radius-sm); color:var(--text); font-size:13px;">';
  html += '</div>';

  // API Token
  html += '<div class="detail-field">';
  html += '<div class="detail-label" style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">' + i18n.t('agentDetail.token') + '</div>';
  html += '<input type="password" id="edit-api-token" value="" placeholder="' + i18n.t('agentDetail.tokenPlaceholder') + '" style="width:100%; padding:8px 12px; background:var(--bg-input); border:1px solid var(--border); border-radius:var(--radius-sm); color:var(--text); font-size:13px;">';
  html += '</div>';

  // API Model
  html += '<div class="detail-field">';
  html += '<div class="detail-label" style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">' + i18n.t('agentDetail.model') + '</div>';
  html += '<input type="text" id="edit-api-model" value="' + escapeHtml(agent.api_model || '') + '" placeholder="claude-sonnet-4-20250514" style="width:100%; padding:8px 12px; background:var(--bg-input); border:1px solid var(--border); border-radius:var(--radius-sm); color:var(--text); font-size:13px;">';
  html += '</div>';

  html += '</div>'; // close edit-apikey-fields

  // Save button
  html += '<button id="save-agent-btn" style="margin-top:12px; padding:8px 20px; border-radius:var(--radius-sm); font-size:13px; font-weight:600; cursor:pointer; border:none; background:var(--accent); color:#fff; width:100%;" onclick="saveAgentConfig(\'' + escapeHtml(agent.name) + '\')">' + i18n.t('agentDetail.save') + '</button>';
  html += '</div>'; // close edit section

  // Action buttons
  html += '<div class="detail-field" style="display:flex; gap:8px; margin-top:16px;">';
  if (isOnline) {
    html += '<button style="padding:8px 20px; border-radius:var(--radius-sm); font-size:13px; font-weight:600; cursor:pointer; border:none; background:rgba(229,83,75,0.15); color:var(--red);" onclick="agentStop(\'' + escapeHtml(agent.name) + '\', this); setTimeout(function(){ loadAgentManagement(); showAgentDetail(\'' + escapeHtml(agent.name) + '\'); }, 1000);">' + i18n.t('agentDetail.stop') + '</button>';
  } else {
    html += '<button style="padding:8px 20px; border-radius:var(--radius-sm); font-size:13px; font-weight:600; cursor:pointer; border:none; background:rgba(61,214,140,0.15); color:var(--green);" onclick="agentStart(\'' + escapeHtml(agent.name) + '\', this); setTimeout(function(){ loadAgentManagement(); showAgentDetail(\'' + escapeHtml(agent.name) + '\'); }, 1000);">' + i18n.t('agentDetail.start') + '</button>';
  }
  html += '<button style="padding:8px 20px; border-radius:var(--radius-sm); font-size:13px; font-weight:600; cursor:pointer; border:1px solid var(--border); background:var(--bg-input); color:var(--text-dim);" onclick="openAgentOutput(\'' + escapeHtml(agent.name) + '\')">' + i18n.t('agents.viewOutput') + '</button>';
  html += '</div>';

  // --- Logs Section ---
  html += '<div style="border-top:1px solid var(--border); margin-top:16px; padding-top:16px;">';
  html += '<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px;">';
  html += '<div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; font-weight:600;">' + i18n.t('agentDetail.logsErrors') + '</div>';
  html += '<div style="display:flex; gap:4px;">';
  html += '<button id="log-tab-output" class="agent-log-tab active" onclick="switchAgentLogTab(\'output\', \'' + escapeHtml(agent.name) + '\')">' + i18n.t('agentDetail.output') + '</button>';
  html += '<button id="log-tab-errors" class="agent-log-tab" onclick="switchAgentLogTab(\'errors\', \'' + escapeHtml(agent.name) + '\')">' + i18n.t('agentDetail.errors') + '</button>';
  html += '</div>';
  html += '</div>';
  html += '<div id="agent-log-content" style="max-height:300px; overflow-y:auto; background:var(--code-bg); border-radius:var(--radius-sm); padding:8px; font-family:\'SF Mono\',\'Fira Code\',monospace; font-size:12px; line-height:1.6;"></div>';
  html += '</div>';

  // Delete button (only show for offline agents, as a safety measure)
  if (!isOnline) {
    html += '<div class="detail-field" style="margin-top:16px; padding-top:16px; border-top:1px solid var(--border);">';
    html += '<button style="padding:8px 20px; border-radius:var(--radius-sm); font-size:13px; font-weight:600; cursor:pointer; border:1px solid var(--red); background:transparent; color:var(--red); width:100%;" onclick="confirmDeleteAgent(\'' + escapeHtml(agent.name) + '\')">' + i18n.t('agentDetail.delete') + '</button>';
    html += '</div>';
  }

  document.getElementById('agent-detail-body').innerHTML = html;
  document.getElementById('agent-detail').classList.add('active');
  currentLogTab = 'output';
  loadAgentLogs(agent.name);
}

function closeAgentDetail() {
  document.getElementById('agent-detail').classList.remove('active');
}

// --- New Agent Wizard ---

function showCreateAgentForm() {
  var select = document.getElementById('ca-reports-to');
  var html = '<option value="">' + i18n.t('agentDetail.noneRoot') + '</option>';
  for (var i = 0; i < agents.length; i++) {
    html += '<option value="' + escapeHtml(agents[i].name) + '">' + escapeHtml(agents[i].name) + '</option>';
  }
  select.innerHTML = html;
  document.getElementById('ca-name').value = '';
  document.getElementById('ca-role').value = '';
  document.getElementById('ca-secret').value = '';
  document.getElementById('ca-auth-mode').value = 'oauth';
  document.getElementById('ca-apikey-fields').style.display = 'none';
  document.getElementById('ca-result').style.display = 'none';
  document.getElementById('create-agent-overlay').classList.add('active');
}

function hideCreateAgentForm() {
  document.getElementById('create-agent-overlay').classList.remove('active');
}

function toggleAuthFields(prefix) {
  var mode = document.getElementById(prefix + '-auth-mode').value;
  document.getElementById(prefix + '-apikey-fields').style.display = mode === 'api_key' ? '' : 'none';
}

async function createAgent() {
  var name = document.getElementById('ca-name').value.trim();
  var role = document.getElementById('ca-role').value.trim();
  var secret = document.getElementById('ca-secret').value.trim();
  var resultDiv = document.getElementById('ca-result');

  if (!name) { alert(i18n.t('createAgent.nameRequired')); return; }

  try {
    var regBody = { name: name };
    if (role) regBody.role = role;
    if (secret) regBody.secret = secret;

    var regRes = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(regBody)
    });
    var regData = await regRes.json();
    if (!regRes.ok) throw new Error(regData.error || 'Registration failed');

    var reportsTo = document.getElementById('ca-reports-to').value;
    var authMode = document.getElementById('ca-auth-mode').value;
    var patchBody = {};
    if (reportsTo) patchBody.reports_to = reportsTo;
    if (authMode !== 'oauth') {
      patchBody.auth_mode = authMode;
      patchBody.api_provider = document.getElementById('ca-api-provider').value || null;
      patchBody.api_base_url = document.getElementById('ca-api-base-url').value || null;
      patchBody.api_auth_token = document.getElementById('ca-api-token').value || null;
      patchBody.api_model = document.getElementById('ca-api-model').value || null;
    }

    if (Object.keys(patchBody).length > 0) {
      await fetch('/api/agents/' + encodeURIComponent(name), {
        method: 'PATCH',
        headers: { 'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(patchBody)
      });
    }

    resultDiv.style.display = 'block';
    resultDiv.style.background = 'rgba(61,214,140,0.1)';
    resultDiv.style.border = '1px solid var(--green)';
    resultDiv.style.color = 'var(--green)';
    resultDiv.innerHTML = '<strong>' + i18n.t('createAgent.success') + '</strong><br>' + i18n.t('createAgent.apiKeyLabel') + ': <code style="user-select:all; background:var(--code-bg); padding:2px 6px; border-radius:3px;">' + escapeHtml(regData.apiKey) + '</code><br><small style="color:var(--text-dim);">' + i18n.t('createAgent.saveWarning') + '</small>';

    await refreshAgents();
    if (currentView === 'agents') loadAgentManagement();

  } catch(e) {
    resultDiv.style.display = 'block';
    resultDiv.style.background = 'rgba(229,83,75,0.1)';
    resultDiv.style.border = '1px solid var(--red)';
    resultDiv.style.color = 'var(--red)';
    resultDiv.innerHTML = '<strong>' + i18n.t('createAgent.error') + ':</strong> ' + escapeHtml(e.message);
  }
}

// Close create-agent overlay on backdrop click
document.addEventListener('DOMContentLoaded', function() {
  var overlay = document.getElementById('create-agent-overlay');
  if (overlay) {
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) hideCreateAgentForm();
    });
  }
});

// --- Edit Agent Config ---

function toggleEditAuthFields() {
  var mode = document.getElementById('edit-auth-mode').value;
  document.getElementById('edit-apikey-fields').style.display = mode === 'api_key' ? 'block' : 'none';
  updateRouterHint();
}

function updateRouterHint() {
  var hint = document.getElementById('router-hint');
  if (!hint) return;
  var authMode = document.getElementById('edit-auth-mode').value;
  var providerEl = document.getElementById('edit-api-provider');
  var provider = providerEl ? providerEl.value : '';
  hint.style.display = (authMode === 'api_key' && provider && provider !== 'anthropic') ? 'block' : 'none';
}

async function saveAgentConfig(name) {
  var btn = document.getElementById('save-agent-btn');
  btn.textContent = i18n.t('agentDetail.saving');
  btn.disabled = true;

  try {
    var body = {};
    body.auth_mode = document.getElementById('edit-auth-mode').value;

    if (body.auth_mode === 'api_key') {
      body.api_provider = document.getElementById('edit-api-provider').value || null;
      body.api_base_url = document.getElementById('edit-api-base-url').value || null;
      var token = document.getElementById('edit-api-token').value;
      if (token) body.api_auth_token = token;
      body.api_model = document.getElementById('edit-api-model').value || null;
    }

    var res = await fetch('/api/agents/' + encodeURIComponent(name), {
      method: 'PATCH',
      headers: { 'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      var err = await res.json().catch(function() { return {}; });
      throw new Error(err.error || 'Update failed');
    }

    btn.textContent = i18n.t('agentDetail.saved');
    btn.style.background = 'var(--green)';
    await refreshAgents();
    if (currentView === 'agents') loadAgentManagement();
    setTimeout(function() {
      btn.textContent = i18n.t('agentDetail.save');
      btn.style.background = 'var(--accent)';
      btn.disabled = false;
    }, 1500);

  } catch(e) {
    alert(i18n.t('agentDetail.failedSave') + ': ' + e.message);
    btn.textContent = i18n.t('agentDetail.save');
    btn.disabled = false;
  }
}

// --- Delete Agent ---

async function confirmDeleteAgent(name) {
  if (!confirm(i18n.t('agentDetail.confirmDelete1') + ' "' + name + '"?')) return;
  if (!confirm(i18n.t('agentDetail.confirmDelete2'))) return;

  try {
    var res = await fetch('/api/agents/' + encodeURIComponent(name), {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + API_KEY }
    });
    if (!res.ok) {
      var err = await res.json().catch(function() { return {}; });
      throw new Error(err.error || 'Delete failed');
    }
    closeAgentDetail();
    await refreshAgents();
    if (currentView === 'agents') loadAgentManagement();
  } catch(e) {
    alert(i18n.t('agentDetail.failedDelete') + ': ' + e.message);
  }
}

// --- Inline Agent Log Viewer ---

var currentLogTab = 'output';

async function switchAgentLogTab(tab, agentName) {
  currentLogTab = tab;
  document.getElementById('log-tab-output').classList.toggle('active', tab === 'output');
  document.getElementById('log-tab-errors').classList.toggle('active', tab === 'errors');
  await loadAgentLogs(agentName);
}

async function loadAgentLogs(agentName) {
  var container = document.getElementById('agent-log-content');
  if (!container) return;
  container.innerHTML = '<div style="color:var(--text-muted); text-align:center; padding:16px;">' + i18n.t('state.loading') + '</div>';

  try {
    if (currentLogTab === 'output') {
      var data = await api('/api/agent-output/' + encodeURIComponent(agentName));
      var entries = data.output || [];
      if (entries.length === 0) {
        container.innerHTML = '<div style="color:var(--text-muted); text-align:center; padding:16px;">' + i18n.t('agentDetail.noOutput') + '</div>';
        return;
      }
      var html = '';
      for (var i = entries.length - 1; i >= 0; i--) {
        var e = entries[i];
        var time = e.timestamp ? formatTime(e.timestamp) : '';
        html += '<div style="padding:4px 0; border-bottom:1px solid rgba(255,255,255,0.05);">';
        html += '<span style="color:var(--text-muted);">' + escapeHtml(time) + '</span> ';
        html += '<span style="color:var(--accent);">[' + escapeHtml(e.event || '') + ']</span> ';
        if (e.tool_name) {
          html += '<span style="color:var(--yellow);">' + escapeHtml(e.tool_name) + '</span> ';
        }
        var content = e.tool_result || e.message || '';
        if (content.length > 200) content = content.substring(0, 200) + '...';
        html += '<span style="color:var(--text-dim);">' + escapeHtml(content) + '</span>';
        html += '</div>';
      }
      container.innerHTML = html;
    } else {
      var data = await api('/api/agent-errors/' + encodeURIComponent(agentName));
      var errors = data.errors || [];
      if (errors.length === 0) {
        container.innerHTML = '<div style="color:var(--text-muted); text-align:center; padding:16px;">' + i18n.t('agentDetail.noErrors') + '</div>';
        return;
      }
      var html = '';
      for (var i = errors.length - 1; i >= 0; i--) {
        var e = errors[i];
        var time = e.timestamp ? formatTime(e.timestamp) : '';
        html += '<div style="padding:4px 0; border-bottom:1px solid rgba(255,255,255,0.05);">';
        html += '<span style="color:var(--text-muted);">' + escapeHtml(time) + '</span> ';
        html += '<span style="color:var(--red);">[' + escapeHtml(e.reason || e.event || 'Error') + ']</span> ';
        var msg = e.message || '';
        if (msg.length > 200) msg = msg.substring(0, 200) + '...';
        html += '<span style="color:var(--text-dim);">' + escapeHtml(msg) + '</span>';
        html += '</div>';
      }
      container.innerHTML = html;
    }
  } catch(e) {
    container.innerHTML = '<div style="color:var(--red); text-align:center; padding:16px;">' + i18n.t('agentDetail.failedLogs') + ': ' + escapeHtml(e.message) + '</div>';
  }
}
