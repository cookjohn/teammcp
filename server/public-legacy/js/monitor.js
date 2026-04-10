// ── Runtime Monitor ────────────────────────────────────────
let monitorData = { byAgent: [], byEvent: [] };
let monitorTimeline = [];
let monitorRefreshTimer = null;

function switchToMonitor() {
  currentView = 'monitor';

  // Hide all views and overlays
  document.getElementById('messages-container').style.display = 'none';
  document.getElementById('compose').classList.remove('active');
  document.getElementById('channel-header').style.display = 'none';
  document.getElementById('pin-bar').classList.remove('active');
  document.getElementById('pinned-panel').classList.remove('active');
  document.getElementById('tasks-container').classList.remove('active');
  document.getElementById('state-container').classList.remove('active');
  document.getElementById('agents-container').classList.remove('active');
  document.getElementById('credentials-container').classList.remove('active');
  closeAllOverlays();

  // Show monitor view
  document.getElementById('monitor-container').classList.add('active');

  // Update sidebar highlights
  document.querySelectorAll('.channel-item').forEach(function(el) {
    el.classList.remove('active');
  });
  document.getElementById('tasks-nav').classList.remove('active');
  document.getElementById('state-nav').classList.remove('active');
  document.getElementById('agents-nav').classList.remove('active');
  document.getElementById('credentials-nav').classList.remove('active');
  document.getElementById('monitor-nav').classList.add('active');

  // Load data
  loadMonitorData();

  // Auto-refresh every 30s
  if (monitorRefreshTimer) clearInterval(monitorRefreshTimer);
  monitorRefreshTimer = setInterval(loadMonitorData, 30000);
}

// ── Load Monitor Data ─────────────────────────────────────
async function loadMonitorData() {
  var windowSel = document.getElementById('monitor-window-select');
  var windowVal = windowSel ? windowSel.value : '1h';

  try {
    var data = await api('/api/cc-metrics/summary?window=' + encodeURIComponent(windowVal));
    monitorData = data;
  } catch (e) {
    // If summary fails (e.g. permission), fall back to empty
    monitorData = { byAgent: [], byEvent: [] };
  }

  try {
    var metricsRes = await api('/api/cc-metrics?limit=50');
    monitorTimeline = Array.isArray(metricsRes) ? metricsRes : (metricsRes.metrics || []);
  } catch (e) {
    monitorTimeline = [];
  }

  renderMonitor();
}

// ── Render Monitor ────────────────────────────────────────
function renderMonitor() {
  var body = document.getElementById('monitor-body');
  if (!body) return;

  var html = '';

  // Agent Status Grid
  html += '<div class="monitor-section-title">Agent Status</div>';
  html += renderAgentStatusGrid();

  // Tool Usage Timeline
  html += '<div class="monitor-section-title" style="margin-top:8px;">Tool Usage Timeline</div>';
  html += renderToolTimeline();

  body.innerHTML = html;
}

// ── Agent Status Grid ─────────────────────────────────────
function renderAgentStatusGrid() {
  var byAgent = monitorData.byAgent || [];
  if (byAgent.length === 0) {
    return '<div class="monitor-empty">No agent activity in this window</div>';
  }

  var html = '<div class="agent-status-grid">';

  for (var i = 0; i < byAgent.length; i++) {
    var a = byAgent[i];
    var status = getAgentLiveStatus(a.agent);
    var statusClass = status === 'online' ? 'online' : (a.last_seen && isRecent(a.last_seen, 300000) ? 'idle' : 'dead');

    html += '<div class="agent-card">';
    html += '<div class="agent-card-header">';
    html += '<span class="agent-status-dot ' + statusClass + '"></span>';
    html += '<span class="agent-card-name" style="color:' + agentColor(a.agent) + '">' + escapeHtml(a.agent) + '</span>';
    html += '</div>';
    html += '<div class="agent-card-stats">';
    html += '<div class="agent-card-stat"><span>Tool Calls</span><span class="agent-card-stat-value">' + (a.tool_calls || 0) + '</span></div>';
    html += '<div class="agent-card-stat"><span>Failures</span><span class="agent-card-stat-value">' + (a.failures || 0) + '</span></div>';
    html += '<div class="agent-card-stat"><span>Total Events</span><span class="agent-card-stat-value">' + (a.total_events || 0) + '</span></div>';
    html += '<div class="agent-card-stat"><span>Last Seen</span><span class="agent-card-stat-value">' + (a.last_seen ? formatTime(a.last_seen) : '-') + '</span></div>';
    html += '</div>';
    html += '</div>';
  }

  html += '</div>';
  return html;
}

// ── Tool Usage Timeline ───────────────────────────────────
function renderToolTimeline() {
  if (monitorTimeline.length === 0) {
    return '<div class="monitor-empty">No tool usage events yet</div>';
  }

  var html = '<div class="tool-timeline">';
  html += '<div class="timeline-header"><span>Time</span><span>Agent</span><span>Tool</span><span>Response</span></div>';

  for (var i = 0; i < monitorTimeline.length; i++) {
    var m = monitorTimeline[i];
    var toolName = m.tool_name || m.event || '-';
    var result = '';
    if (m.tool_response) {
      result = typeof m.tool_response === 'string' ? m.tool_response : JSON.stringify(m.tool_response);
      result = result.slice(0, 80);
    } else if (m.error) {
      result = 'ERR: ' + String(m.error).slice(0, 60);
    } else if (m.reason) {
      result = String(m.reason).slice(0, 80);
    }

    html += '<div class="timeline-row">';
    html += '<span class="timeline-time">' + formatTime(m.timestamp) + '</span>';
    html += '<span class="timeline-agent" style="color:' + agentColor(m.agent || '') + '">' + escapeHtml(m.agent || '-') + '</span>';
    html += '<span class="timeline-tool">' + escapeHtml(toolName) + '</span>';
    html += '<span class="timeline-result" title="' + escapeHtml(result) + '">' + escapeHtml(result) + '</span>';
    html += '</div>';
  }

  html += '</div>';
  return html;
}

// ── SSE Handler for Monitor ───────────────────────────────
function handleMonitorSSE(data) {
  if (currentView !== 'monitor') return;

  // Append to timeline
  var entry = {
    agent: data.agent,
    event: data.event,
    tool_name: data.tool_name,
    tool_response: data.tool_result || data.tool_response,
    error: data.error,
    reason: data.reason,
    timestamp: data.timestamp || new Date().toISOString()
  };
  monitorTimeline.unshift(entry);
  if (monitorTimeline.length > 50) monitorTimeline.pop();

  // Update summary if we have agent data
  if (data.agent && monitorData.byAgent) {
    var found = false;
    for (var i = 0; i < monitorData.byAgent.length; i++) {
      if (monitorData.byAgent[i].agent === data.agent) {
        monitorData.byAgent[i].total_events = (monitorData.byAgent[i].total_events || 0) + 1;
        if (data.event === 'PostToolUse') {
          monitorData.byAgent[i].tool_calls = (monitorData.byAgent[i].tool_calls || 0) + 1;
        }
        if (data.event === 'StopFailure') {
          monitorData.byAgent[i].failures = (monitorData.byAgent[i].failures || 0) + 1;
        }
        monitorData.byAgent[i].last_seen = entry.timestamp;
        found = true;
        break;
      }
    }
    if (!found) {
      monitorData.byAgent.push({
        agent: data.agent,
        total_events: 1,
        tool_calls: data.event === 'PostToolUse' ? 1 : 0,
        failures: data.event === 'StopFailure' ? 1 : 0,
        last_seen: entry.timestamp
      });
    }
  }

  renderMonitor();
}

// ── Helpers ───────────────────────────────────────────────
function getAgentLiveStatus(name) {
  // Check if agent is in the global agents list with online status
  for (var i = 0; i < agents.length; i++) {
    if (agents[i].name === name) {
      return agents[i].status || 'offline';
    }
  }
  return 'unknown';
}

function isRecent(isoTimestamp, thresholdMs) {
  if (!isoTimestamp) return false;
  return Date.now() - new Date(isoTimestamp).getTime() < thresholdMs;
}

function stopMonitorRefresh() {
  if (monitorRefreshTimer) {
    clearInterval(monitorRefreshTimer);
    monitorRefreshTimer = null;
  }
}
