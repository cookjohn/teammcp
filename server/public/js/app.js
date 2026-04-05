// ── State ────────────────────────────────────────────────
let API_KEY = '';
let currentChannel = null;
let channelMembers = [];  // members of current channel for @ mentions
let channels = [];
let agents = [];
let messages = [];  // messages for current channel
let hasMore = false;
let loading = false;
let eventSource = null;
let sseAbortController = null;
let agentName = '';
let currentView = 'messages'; // 'messages', 'tasks', 'state', or 'files'
let fileEvents = [];
let currentProjectId = 'agent-os-mvp';
let stateFields = [];
let stateApprovals = [];
let stateChangeLog = [];
let stateAutoRefreshTimer = null;
let auditReports = [];
let auditFilterType = 'all';
let tasksList = [];
let tasksTotal = 0;
let currentTaskDetail = null;
let pinnedMsgIds = new Set();
let pinnedMessages = [];
let pinnedPanelOpen = false;

const REACTION_EMOJIS = ['\u{1F44D}', '\u{1F44E}', '\u{2764}\u{FE0F}', '\u{1F604}', '\u{1F389}', '\u{1F440}', '\u{1F914}', '\u{2705}'];

const COLORS = [
  '#5b7ff5', '#e5534b', '#3dd68c', '#d4843e', '#c9b44a',
  '#a371f7', '#e07cda', '#39c5cf', '#6cb6ff', '#57ab5a'
];

function agentColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return COLORS[Math.abs(hash) % COLORS.length];
}

function agentInitial(name) {
  return name.charAt(0).toUpperCase();
}

// ── API ──────────────────────────────────────────────────
async function api(path) {
  const res = await fetch(path, {
    headers: { 'Authorization': 'Bearer ' + API_KEY }
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
  return res.json();
}

// ── Auth ─────────────────────────────────────────────────
async function authenticate() {
  const input = document.getElementById('api-key-input');
  const error = document.getElementById('auth-error');
  API_KEY = input.value.trim();
  if (!API_KEY) { error.textContent = 'Please enter an API key'; return; }

  error.textContent = 'Connecting...';
  try {
    const agentsData = await api('/api/agents');
    agents = agentsData;
    // Figure out who we are from the key (try channels endpoint)
    const chData = await api('/api/channels');
    channels = chData;

    // Determine our identity from the agents list by trying to match key
    // The API doesn't directly tell us who we are, but we can check the
    // /api/channels endpoint which returns data scoped to our agent.
    // We'll resolve identity by sending a test to /api/health or matching.
    // For now, find the agent whose key matches by checking the response
    // Use a dedicated endpoint or infer from the agent data.
    agentName = await resolveAgentName();

    error.textContent = '';
    document.getElementById('auth-overlay').style.display = 'none';
    document.getElementById('app').classList.add('active');
    localStorage.setItem('teammcp_key', API_KEY);

    init();
  } catch (e) {
    error.textContent = 'Authentication failed: ' + e.message;
  }
}

// Auto-fill saved key + check first-run wizard
(function() {
  const saved = localStorage.getItem('teammcp_key');
  if (saved) {
    document.getElementById('api-key-input').value = saved;
  }
  document.getElementById('api-key-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') authenticate();
  });

  // First-run detection: check setup-status BEFORE auth (no auth needed)
  // Wrapped in DOMContentLoaded because setup-wizard element is after this script
  document.addEventListener('DOMContentLoaded', function() {
    if (document.getElementById('setup-wizard')) {
      fetch('/api/setup-status').then(function(res) {
        if (!res.ok) return;
        return res.json();
      }).then(function(data) {
        if (data && (data.agents_count === 0 || data.needs_setup)) {
          // No agents registered — show wizard, hide auth
          document.getElementById('auth-overlay').style.display = 'none';
          showSetupWizard();
        }
      }).catch(function() {
        // API not available, skip wizard
      });
    }
  });
})();

// ── Init ─────────────────────────────────────────────────
async function init() {
  // Check if setup wizard should be shown (first run, no agents, valid auth)
  try {
    var agentsRes = await fetch('/api/agents', { headers: { 'Authorization': 'Bearer ' + (typeof API_KEY !== 'undefined' ? API_KEY : '') } });
    if (agentsRes.ok) {
      var agentsArr = await agentsRes.json();
      if (agentsArr && agentsArr.length === 0 && document.getElementById('setup-wizard')) {
        showSetupWizard();
        return;
      }
    }
  } catch (e) {}

  document.getElementById('agent-badge').textContent = agentName;
  renderChannels();
  renderAgents();

  // Scroll listener: auto-hide new message indicator when user scrolls to bottom
  var msgContainer = document.getElementById('messages-container');
  if (msgContainer) {
    msgContainer.addEventListener('scroll', function() {
      if (isScrolledToBottom()) {
        hideNewMessageIndicator();
      }
    });
  }
  connectSSE();
  applyI18n();
  initWechatPanel();

  // Auto-select first channel
  if (channels.length > 0) {
    selectChannel(channels[0].id);
  }

  // Refresh agents periodically
  setInterval(refreshAgents, 30000);
}
async function resolveAgentName() {
  try {
    const data = await api('/api/me');
    return data.name || 'Dashboard';
  } catch {
    return 'Dashboard';
  }
}

// ── Utility Functions ─────────────────────────────────────
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (d.toDateString() === today.toDateString()) return i18n.t('general.today');
  if (d.toDateString() === yesterday.toDateString()) return i18n.t('general.yesterday');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── SSE ──────────────────────────────────────────────────
function connectSSE() {
  // Abort previous fetch-based SSE connection if any
  if (sseAbortController) {
    sseAbortController.abort();
    sseAbortController = null;
  }

  // Native EventSource doesn't support custom headers.
  // Use fetch-based SSE instead.
  const dot = document.getElementById('sse-dot');
  const label = document.getElementById('sse-label');

  sseAbortController = new AbortController();

  fetchSSE('/api/events', {
    signal: sseAbortController.signal,
    onOpen() {
      dot.classList.add('connected');
      label.textContent = i18n.t('sse.connected');
    },
    onMessage(data) {
      handleSSEEvent(data);
    },
    onError() {
      dot.classList.remove('connected');
      label.textContent = i18n.t('sse.reconnecting');
      // Auto-reconnect after 3s
      setTimeout(() => connectSSE(), 3000);
    }
  });
}

async function fetchSSE(url, { signal, onOpen, onMessage, onError }) {
  try {
    const response = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + API_KEY },
      signal: signal
    });

    if (!response.ok) {
      throw new Error(`SSE connection failed: ${response.status}`);
    }

    onOpen();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Keep incomplete line

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            onMessage(data);
          } catch {}
        }
      }
    }

    // Connection closed normally
    onError();
  } catch (e) {
    // Don't reconnect if intentionally aborted
    if (e.name === 'AbortError') return;
    console.error('SSE error:', e);
    onError();
  }
}

function handleSSEEvent(data) {
  switch (data.type) {
    case 'message':
      // If it's for the current channel, append to messages (skip duplicates from own sends)
      if (data.channel === currentChannel) {
        if (!messages.some(m => m.id === data.id)) {
          const msg = {
            id: data.id,
            channel_id: data.channel,
            from_agent: data.from,
            content: data.content,
            created_at: data.timestamp,
            reply_to: data.replyTo,
            mentions: data.mentions,
            metadata: data.metadata
          };
          messages.push(msg);
          var container = document.getElementById('messages-container');
          var isAtBottom = container && (container.scrollTop + container.clientHeight >= container.scrollHeight - 50);
          renderMessages(isAtBottom);
          if (!isAtBottom) {
            showNewMessageIndicator();
          }
          // Mark as read on server since user is viewing this channel
          markChannelRead(data.channel);
        }
      }
      // Bump unread for other channels
      const ch = channels.find(c => c.id === data.channel);
      if (ch && data.channel !== currentChannel) {
        ch.unread = (ch.unread || 0) + 1;
        renderChannels();
      }
      // If channel not in list, refresh
      if (!ch) {
        refreshChannels();
      }
      break;

    case 'status':
      const agent = agents.find(a => a.name === data.agent);
      if (agent) {
        agent.status = data.status;
        renderAgents();
      } else {
        refreshAgents();
      }
      if (currentView === 'agents') {
        loadAgentManagement();
      }
      break;

    case 'message_edited':
      if (data.channel === currentChannel) {
        const msg = messages.find(m => m.id === data.id);
        if (msg) {
          msg.content = data.content;
          msg.edited_at = data.edited_at;
          renderMessages(false);
        }
      }
      break;

    case 'message_deleted':
      if (data.channel === currentChannel) {
        messages = messages.filter(m => m.id !== data.id);
        renderMessages(false);
      }
      break;

    case 'message_acked':
      const ackEl = document.querySelector(`.msg-ack[data-msg-id="${data.message_id}"]`);
      if (ackEl) {
        const current = ackEl.textContent;
        ackEl.classList.add('delivered');
        ackEl.textContent = current ? `${current}, ${data.agent}` : `\u2713 ${data.agent}`;
      }
      break;

    case 'task_created':
      if (currentView === 'tasks') {
        loadTasks();
      }
      break;

    case 'task_updated':
      if (currentView === 'tasks') {
        loadTasks();
      }
      if (currentTaskDetail && data.task_id === currentTaskDetail.id) {
        showTaskDetail(data.task_id);
      }
      break;

    case 'task_deleted':
      if (currentView === 'tasks') {
        tasksList = tasksList.filter(t => t.id !== data.task.id);
        renderTasks();
      }
      if (currentTaskDetail && data.task.id === currentTaskDetail.id) {
        closeTaskDetail();
      }
      break;

    case 'reaction_added':
      if (data.channel === currentChannel) {
        const rMsg = messages.find(m => m.id === data.message_id);
        if (rMsg) {
          if (!rMsg.reactions) rMsg.reactions = [];
          if (!rMsg.reactions.some(r => r.emoji === data.emoji && r.agent_name === data.agent)) {
            rMsg.reactions.push({ emoji: data.emoji, agent_name: data.agent });
          }
          renderMessages(false);
        }
      }
      break;

    case 'reaction_removed':
      if (data.channel === currentChannel) {
        const rrMsg = messages.find(m => m.id === data.message_id);
        if (rrMsg && rrMsg.reactions) {
          rrMsg.reactions = rrMsg.reactions.filter(r => !(r.emoji === data.emoji && r.agent_name === data.agent));
          renderMessages(false);
        }
      }
      break;

    case 'message_pinned':
      if (data.channel === currentChannel) {
        loadPins(currentChannel).then(() => renderMessages(false));
      }
      break;

    case 'message_unpinned':
      if (data.channel === currentChannel) {
        loadPins(currentChannel).then(() => renderMessages(false));
      }
      break;

    case 'state_changed':
      if (currentView === 'state' && data.project_id === currentProjectId) {
        loadStateFields(currentProjectId);
        loadApprovals();
        var tsEl = document.getElementById('state-last-updated');
        if (tsEl) tsEl.textContent = 'Updated ' + new Date().toLocaleTimeString();
      }
      break;

    case 'file_changed':
      if (document.getElementById('channel-files-panel').classList.contains('active')) {
        const evt = {
          id: data.id,
          file_path: data.file_path,
          event_type: data.event_type,
          agent_name: data.agent,
          created_at: data.timestamp
        };
        fileEvents.unshift(evt);
        renderChannelFiles();
      }
      break;

    case 'agent-output':
      handleAgentOutput(data);
      break;

    case 'display_only':
      // CEO output displayed in main chat (zero token, display only)
      if (data.content) {
        const displayMsg = {
          id: `display_${Date.now()}`,
          channel_id: currentChannel || 'general',
          from_agent: data.from || 'CEO',
          content: data.content,
          created_at: data.timestamp || new Date().toISOString(),
          metadata: { source: 'display_only' }
        };
        messages.push(displayMsg);
        var dContainer = document.getElementById('messages-container');
        var dIsAtBottom = dContainer && (dContainer.scrollTop + dContainer.clientHeight >= dContainer.scrollHeight - 50);
        renderMessages(dIsAtBottom);
        if (!dIsAtBottom) {
          showNewMessageIndicator();
        }
      }
      break;

    case 'system_operation':
      // System operation notifications (agent start/stop/register/delete)
      break;
  }
}

// ── Refresh Channels ─────────────────────────────────────
async function refreshChannels() {
  try {
    const oldChannel = currentChannel;
    channels = await api('/api/channels');
    renderChannels();
    // Re-highlight current
    if (oldChannel) {
      document.querySelectorAll('.channel-item').forEach(el => {
        el.classList.toggle('active', el.dataset.id === oldChannel);
      });
    }
  } catch {}
}
