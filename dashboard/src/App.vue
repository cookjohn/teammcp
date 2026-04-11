<script setup>
import { ref, provide, onMounted, computed } from 'vue'
import { useAuth } from './composables/useAuth.js'
import { useApi } from './composables/useApi.js'
import { useSSE } from './composables/useSSE.js'
import { useChannelsStore } from './stores/channels.js'
import { useAgentsStore } from './stores/agents.js'
import { useTasksStore } from './stores/tasks.js'
import ChannelMessages from './components/channels/ChannelMessages.vue'
import StateView from './components/state/StateView.vue'
import TasksView from './components/tasks/TasksView.vue'
import AgentsView from './components/agents/AgentsView.vue'
import CredentialsView from './components/credentials/CredentialsView.vue'
import MonitorView from './components/monitor/MonitorView.vue'
import TerminalView from './components/terminal/TerminalView.vue'
import MemoriesView from './components/memory/MemoriesView.vue'
import SetupWizard from './components/wizard/SetupWizard.vue'
import WechatPanel from './components/wechat/WechatPanel.vue'
import en from './i18n/en.js'
import zh from './i18n/zh.js'

// ── i18n ────────────────────────────────────────────────
const locales = { en, zh }
const locale = ref(localStorage.getItem('teammcp_locale') || 'en')

function t(key) {
  const keys = key.split('.')
  let val = locales[locale.value]
  for (const k of keys) {
    if (val && typeof val === 'object') val = val[k]
    else return key
  }
  return val !== undefined ? val : key
}

function toggleLocale() {
  locale.value = locale.value === 'en' ? 'zh' : 'en'
  localStorage.setItem('teammcp_locale', locale.value)
}

// ── Theme ───────────────────────────────────────────────
const theme = ref(localStorage.getItem('teammcp_theme') || 'dark')

function applyTheme() {
  if (theme.value === 'light') {
    document.documentElement.setAttribute('data-theme', 'light')
  } else {
    document.documentElement.removeAttribute('data-theme')
  }
}

function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
  localStorage.setItem('teammcp_theme', theme.value)
  applyTheme()
}

// Apply theme immediately
applyTheme()

// ── Auth ────────────────────────────────────────────────
const auth = useAuth()
const loginKeyInput = ref('')

// ── Wizard ──────────────────────────────────────────────
const showWizard = ref(false)
const wechatExpanded = ref(false)

// ── API & Stores ────────────────────────────────────────
const { api, post, del } = useApi(() => auth.apiKey.value)
const channelsStore = useChannelsStore(api, auth.agentName)
const agentsStore = useAgentsStore(api)
const tasksStore = useTasksStore(api)

// ── File change signal ──────────────────────────────────
const fileChangeCounter = ref(0)

// ── SSE ─────────────────────────────────────────────────
const sse = useSSE(() => auth.apiKey.value, {
  message: (data) => channelsStore.handleMessage(data),
  message_edited: (data) => channelsStore.handleMessageEdited(data),
  message_deleted: (data) => channelsStore.handleMessageDeleted(data),
  status: (data) => agentsStore.handleStatus(data),
  reaction_added: (data) => handleReactionAdded(data),
  reaction_removed: (data) => handleReactionRemoved(data),
  message_pinned: () => handlePinChanged(),
  message_unpinned: () => handlePinChanged(),
  task_created: () => tasksStore.loadTasks(),
  task_updated: () => tasksStore.loadTasks(),
  task_deleted: () => tasksStore.loadTasks(),
  display_only: (data) => {
    if (data.content) {
      channelsStore.handleMessage({
        id: `display_${Date.now()}`,
        channel: channelsStore.currentChannelId.value || 'general',
        from: data.from || 'CEO',
        content: data.content,
        timestamp: data.timestamp || new Date().toISOString(),
        metadata: { source: 'display_only' }
      })
    }
  },
  approval_requested: (data) => {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('Approval Request', { body: `${data.field || ''} by ${data.proposed_by || 'unknown'}` })
    }
  },
  file_changed: () => { fileChangeCounter.value++ },
  folder_changed: () => { fileChangeCounter.value++ }
})

// ── View state ──────────────────────────────────────────
const currentView = ref('messages')

const navItems = [
  { id: 'tasks', label: 'Tasks', icon: '\u2611' },
  { id: 'state', label: 'State', icon: '\u2699' },
  { id: 'agents', label: 'Agents', icon: '\u{1F916}' },
  { id: 'credentials', label: 'Credentials', icon: '\u{1F511}' },
  { id: 'monitor', label: 'Monitor', icon: '\u{1F4CA}' },
  { id: 'memories', label: 'Memories', icon: '\u{1F4AD}' },
  { id: 'terminal', label: 'Terminal', icon: '\u23CE' },
]

// ── Provide for child components ────────────────────────
provide('currentView', currentView)
provide('sseConnected', sse.connected)
provide('agentName', auth.agentName)
provide('apiKey', auth.apiKey)
provide('sse', sse)
provide('t', t)
provide('api', api)
provide('tasksStore', tasksStore)
provide('fileChangeCounter', fileChangeCounter)

// ── Lifecycle ───────────────────────────────────────────
onMounted(async () => {
  // Check if first-run (no agents registered)
  try {
    const res = await fetch('/api/setup-status')
    if (res.ok) {
      const data = await res.json()
      if (data.agents_count === 0) {
        showWizard.value = true
        return
      }
    }
  } catch {}

  const ok = await auth.restoreSession()
  if (ok) {
    await initApp()
  }
})

async function initApp() {
  await Promise.all([
    channelsStore.loadChannels(),
    agentsStore.loadAgents()
  ])
  sse.connect()
  // Request browser notification permission
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission()
  }
}

async function doLogin() {
  const ok = await auth.login(loginKeyInput.value)
  if (ok) {
    loginKeyInput.value = ''
    await initApp()
  }
}

function doLogout() {
  sse.disconnect()
  auth.logout()
}

// ── Wizard handlers ────────────────────────────────────
async function onWizardComplete(apiKey) {
  if (apiKey) {
    const ok = await auth.login(apiKey)
    if (ok) {
      await initApp()
    }
  }
}

function onWizardEnter() {
  showWizard.value = false
}

// ── Channel selection ───────────────────────────────────
function selectChannel(id) {
  currentView.value = 'messages'
  channelsStore.selectChannel(id)
}

function setView(view) {
  currentView.value = view
}

// ── Reaction SSE handlers ───────────────────────────────
function handleReactionAdded(data) {
  if (data.channel === channelsStore.currentChannelId.value) {
    const msg = channelsStore.messages.value.find(m => m.id === data.message_id)
    if (msg) {
      if (!msg.reactions) msg.reactions = []
      if (!msg.reactions.some(r => r.emoji === data.emoji && r.agent === data.agent)) {
        msg.reactions.push({ emoji: data.emoji, agent: data.agent })
      }
    }
  }
}

function handleReactionRemoved(data) {
  if (data.channel === channelsStore.currentChannelId.value) {
    const msg = channelsStore.messages.value.find(m => m.id === data.message_id)
    if (msg && msg.reactions) {
      msg.reactions = msg.reactions.filter(r => !(r.emoji === data.emoji && r.agent === data.agent))
    }
  }
}

function handlePinChanged() {
  if (channelsStore.currentChannelId.value) {
    channelsStore.loadPins(channelsStore.currentChannelId.value)
  }
}

// ── Message actions ─────────────────────────────────────
async function onSendMessage(content, replyTo, mentions) {
  try {
    await channelsStore.sendMessage(content, replyTo, mentions)
  } catch (e) {
    console.error('Send failed:', e)
  }
}

async function onAddReaction(messageId, emoji) {
  try {
    await post(`/api/messages/${encodeURIComponent(messageId)}/reactions`, { emoji })
  } catch (e) {
    console.error('Add reaction failed:', e)
  }
}

async function onRemoveReaction(messageId, emoji) {
  try {
    await del(`/api/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}`)
  } catch (e) {
    console.error('Remove reaction failed:', e)
  }
}

async function pinMessage(messageId) {
  try {
    await channelsStore.pinMessage(messageId)
  } catch (e) {
    console.error('Pin failed:', e)
  }
}

async function unpinMessage(messageId) {
  try {
    await channelsStore.unpinMessage(messageId)
  } catch (e) {
    console.error('Unpin failed:', e)
  }
}

async function onLoadMembers() {
  if (channelsStore.currentChannelId.value) {
    await channelsStore.loadMembers(channelsStore.currentChannelId.value)
  }
}

async function onAddMember(name) {
  await channelsStore.addMember(name)
  await channelsStore.loadMembers(channelsStore.currentChannelId.value)
}

async function onRemoveMember(name) {
  await channelsStore.removeMember(name)
  await channelsStore.loadMembers(channelsStore.currentChannelId.value)
}

// ── Computed ────────────────────────────────────────────
const unreadCounts = computed(() => channelsStore.unreadCounts.value)
</script>

<template>
  <!-- Setup Wizard overlay -->
  <SetupWizard
    v-if="showWizard"
    @complete="onWizardComplete"
    @enter="onWizardEnter"
  />

  <!-- Auth overlay -->
  <div v-if="!auth.isAuthenticated.value && !showWizard" class="auth-overlay">
    <div class="auth-card">
      <div class="auth-logo">T</div>
      <h1 class="auth-title">TeamMCP Dashboard</h1>
      <p class="auth-subtitle">Enter your API key to connect</p>
      <div class="auth-form">
        <input
          v-model="loginKeyInput"
          type="password"
          class="auth-input"
          placeholder="API Key"
          @keydown.enter="doLogin"
        />
        <button class="auth-btn" :disabled="auth.isLoading.value" @click="doLogin">
          {{ auth.isLoading.value ? 'Connecting...' : 'Connect' }}
        </button>
      </div>
      <div v-if="auth.authError.value" class="auth-error">{{ auth.authError.value }}</div>
    </div>
  </div>

  <!-- Main app -->
  <div v-else class="app-layout">
    <!-- Header -->
    <header class="app-header">
      <div class="header-left">
        <div class="header-logo">T</div>
        <h1 class="header-title">TeamMCP Dashboard</h1>
        <div class="connection-status">
          <span class="connection-dot" :class="{ connected: sse.connected.value }"></span>
          <span class="connection-label">{{ sse.connected.value ? 'Connected' : sse.reconnecting.value ? 'Reconnecting...' : 'Disconnected' }}</span>
        </div>
      </div>
      <div class="header-right">
        <span class="agent-badge">{{ auth.agentName.value }}</span>
        <button class="header-toggle-btn" @click="toggleTheme">
          {{ theme === 'dark' ? t('theme.light') : t('theme.dark') }}
        </button>
        <button class="header-toggle-btn" @click="toggleLocale">
          {{ locale === 'en' ? 'ZH' : 'EN' }}
        </button>
        <button class="header-toggle-btn" @click="doLogout">Logout</button>
      </div>
    </header>

    <!-- Sidebar -->
    <aside class="app-sidebar">
      <!-- Channels Section -->
      <div class="sidebar-section">
        <div class="sidebar-section-title">Channels</div>
        <ul class="channel-list">
          <li
            v-for="ch in channelsStore.channels.value"
            :key="ch.id"
            class="channel-item"
            :class="{ active: currentView === 'messages' && channelsStore.currentChannelId.value === ch.id }"
            @click="selectChannel(ch.id)"
          >
            <span class="channel-icon">#</span>
            <span class="channel-name">{{ ch.name || ch.id }}</span>
            <span v-if="unreadCounts[ch.id] > 0" class="unread-badge">{{ unreadCounts[ch.id] }}</span>
          </li>
          <li v-if="channelsStore.channels.value.length === 0" class="channel-item" style="color: var(--text-muted); cursor: default;">
            No channels loaded
          </li>
        </ul>
      </div>

      <!-- Navigation Section -->
      <div class="sidebar-section">
        <div class="sidebar-section-title">Views</div>
        <ul class="channel-list">
          <li
            v-for="item in navItems"
            :key="item.id"
            class="channel-item"
            :class="{ active: currentView === item.id }"
            @click="setView(item.id)"
          >
            <span class="channel-icon">{{ item.icon }}</span>
            <span class="channel-name">{{ item.label }}</span>
          </li>
        </ul>
      </div>

      <!-- WeChat Section (collapsible) -->
      <div class="sidebar-section sidebar-section-bottom">
        <div class="sidebar-section-title sidebar-section-toggle" @click="wechatExpanded = !wechatExpanded">
          WeChat
          <span class="sidebar-toggle-arrow">{{ wechatExpanded ? '\u25B4' : '\u25BE' }}</span>
        </div>
        <WechatPanel v-if="wechatExpanded" :api-key="auth.apiKey.value" />
      </div>
    </aside>

    <!-- Main Content -->
    <main class="app-main">
      <div v-if="currentView === 'messages'" class="view-panel">
        <ChannelMessages
          :channel="channelsStore.currentChannel.value"
          :messages="channelsStore.messages.value"
          :has-more="channelsStore.hasMore.value"
          :loading="channelsStore.loading.value"
          :pinned-messages="channelsStore.pinnedMessages.value"
          :channel-members="channelsStore.channelMembers.value"
          :agents="agentsStore.agents.value"
          :agent-name="auth.agentName.value"
          :api="api"
          @load-more="channelsStore.loadMoreMessages"
          @send-message="onSendMessage"
          @add-reaction="onAddReaction"
          @remove-reaction="onRemoveReaction"
          @pin="pinMessage"
          @unpin="unpinMessage"
          @load-members="onLoadMembers"
          @add-member="onAddMember"
          @remove-member="onRemoveMember"
        />
      </div>

      <div v-else-if="currentView === 'tasks'" class="view-panel">
        <TasksView />
      </div>

      <div v-else-if="currentView === 'state'" class="view-panel">
        <StateView />
      </div>

      <div v-else-if="currentView === 'agents'" class="view-panel">
        <AgentsView />
      </div>

      <div v-else-if="currentView === 'credentials'" class="view-panel">
        <CredentialsView />
      </div>

      <div v-else-if="currentView === 'monitor'" class="view-panel">
        <MonitorView />
      </div>

      <div v-else-if="currentView === 'memories'" class="view-panel">
        <MemoriesView />
      </div>

      <div v-else-if="currentView === 'terminal'" class="view-panel">
        <TerminalView />
      </div>
    </main>
  </div>
</template>

<style scoped>
/* ── Auth Overlay ────────────────────────────────────────── */
.auth-overlay {
  position: fixed;
  inset: 0;
  background: var(--bg);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.auth-card {
  background: var(--bg-sidebar);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 48px 40px;
  text-align: center;
  width: 380px;
}

.auth-logo {
  width: 48px;
  height: 48px;
  background: var(--accent);
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  font-weight: 800;
  color: #fff;
  margin: 0 auto 16px;
}

.auth-title {
  font-size: 20px;
  font-weight: 700;
  margin-bottom: 4px;
}

.auth-subtitle {
  font-size: 13px;
  color: var(--text-dim);
  margin-bottom: 24px;
}

.auth-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.auth-input {
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text);
  padding: 12px 16px;
  font-size: 14px;
  outline: none;
  width: 100%;
}

.auth-input:focus {
  border-color: var(--accent);
}

.auth-input::placeholder {
  color: var(--text-muted);
}

.auth-btn {
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: var(--radius);
  padding: 12px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}

.auth-btn:hover:not(:disabled) {
  background: var(--accent-dim);
}

.auth-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.auth-error {
  margin-top: 12px;
  color: var(--red);
  font-size: 13px;
}

/* ── App Layout ──────────────────────────────────────────── */
.app-layout {
  display: grid;
  grid-template-columns: 280px 1fr;
  grid-template-rows: auto 1fr;
  height: 100vh;
  overflow: hidden;
}

/* ── Header ───────────────────────────────────────────── */
.app-header {
  grid-column: 1 / -1;
  background: var(--bg-header);
  border-bottom: 1px solid var(--border);
  padding: 12px 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.header-logo {
  width: 28px;
  height: 28px;
  background: var(--accent);
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 800;
  color: #fff;
}

.header-title {
  font-size: 16px;
  font-weight: 700;
}

.connection-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-dim);
  margin-left: 12px;
}

.connection-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--red);
}

.connection-dot.connected {
  background: var(--green);
}

.connection-label {
  font-size: 12px;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 16px;
}

.header-toggle-btn {
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  font-size: 12px;
  font-weight: 600;
  padding: 4px 10px;
  cursor: pointer;
  transition: all 0.15s;
}

.header-toggle-btn:hover {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}

.agent-badge {
  font-size: 12px;
  color: var(--text-dim);
  background: var(--bg);
  padding: 4px 10px;
  border-radius: 12px;
}

/* ── Sidebar ──────────────────────────────────────────── */
.app-sidebar {
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.sidebar-section {
  padding: 16px 12px 8px;
}

.sidebar-section-title {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-muted);
  padding: 0 8px;
  margin-bottom: 6px;
}

.channel-list {
  list-style: none;
}

.channel-item {
  display: flex;
  align-items: center;
  padding: 7px 12px;
  border-radius: var(--radius);
  cursor: pointer;
  font-size: 14px;
  color: var(--text-dim);
  transition: all 0.15s;
  gap: 8px;
  margin: 1px 0;
}

.channel-item:hover {
  background: var(--bg-msg);
  color: var(--text);
}

.channel-item.active {
  background: var(--bg-msg);
  color: var(--text);
  font-weight: 600;
}

.channel-icon {
  font-size: 16px;
  width: 20px;
  text-align: center;
  flex-shrink: 0;
}

.channel-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.unread-badge {
  background: var(--accent);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 10px;
  min-width: 18px;
  text-align: center;
}

.sidebar-section-bottom {
  margin-top: auto;
  border-top: 1px solid var(--border);
}

.sidebar-section-toggle {
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
  user-select: none;
}

.sidebar-section-toggle:hover {
  color: var(--text-dim);
}

.sidebar-toggle-arrow {
  font-size: 10px;
}

/* ── Main Content ─────────────────────────────────────── */
.app-main {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg);
}

.view-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.view-header {
  padding: 14px 24px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 12px;
}

.view-header h2 {
  font-size: 15px;
  font-weight: 700;
}

.view-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px 24px;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-muted);
  font-size: 14px;
  gap: 8px;
}

.empty-state .icon {
  font-size: 40px;
  opacity: 0.5;
}
</style>
