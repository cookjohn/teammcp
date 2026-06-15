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
import ChannelsView from './components/channels/ChannelsView.vue'
import SetupWizard from './components/wizard/SetupWizard.vue'
import WechatPanel from './components/wechat/WechatPanel.vue'
import WatchdogPanel from './components/watchdog/WatchdogPanel.vue'

import { useI18n } from 'vue-i18n'

// ── i18n ────────────────────────────────────────────────
// vue-i18n is the single source of truth (drives every $t in the app).
// The old local `locale` ref + `teammcp_locale` storage key only toggled
// a Vue ref that nothing read — leaving the UI stuck in English.
const { t, locale } = useI18n()

function toggleLocale() {
  locale.value = locale.value === 'en' ? 'zh' : 'en'
  localStorage.setItem('tmcp-lang', locale.value)
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

// Labels resolved via `$t('nav.' + id)` in template \u2014 see i18n/en.js + zh.js.
const navItems = [
  { id: 'chanMgmt', icon: '\u{1F4FB}' },
  { id: 'tasks', icon: '\u2611' },
  { id: 'state', icon: '\u2699' },
  { id: 'agents', icon: '\u{1F916}' },
  { id: 'credentials', icon: '\u{1F511}' },
  { id: 'monitor', icon: '\u{1F4CA}' },
  { id: 'memories', icon: '\u{1F4AD}' },
  { id: 'terminal', icon: '\u23CE' },
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

// ── System health badge ─────────────────────────────────
// Polls /api/system/health every 60s + once on mount. Shows a coloured
// dot in the header when any dependency check is non-ok. The popover
// lists failing checks with their suggested fixes.
const sysHealth = ref(null)
const sysHealthOpen = ref(false)
let sysHealthTimer = null

async function loadSysHealth() {
  try {
    const r = await fetch('/api/system/health')
    if (r.ok) sysHealth.value = await r.json()
  } catch {}
}
const sysHealthIssues = computed(() => sysHealth.value?.checks?.filter(c => c.level !== 'ok') || [])
const sysHealthVerdict = computed(() => sysHealth.value?.verdict || 'unknown')
function toggleSysHealth() { sysHealthOpen.value = !sysHealthOpen.value }

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
    agentsStore.loadAgents(),
    loadSysHealth(),
  ])
  // Poll system health on a slow cadence — dep status doesn't change often
  // and the badge is non-critical UX.
  if (sysHealthTimer) clearInterval(sysHealthTimer)
  sysHealthTimer = setInterval(loadSysHealth, 60_000)
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
      <h1 class="auth-title">{{ $t('header.title') }}</h1>
      <p class="auth-subtitle">{{ $t('auth.desc') }}</p>
      <div class="auth-form">
        <input
          v-model="loginKeyInput"
          type="password"
          class="auth-input"
          :placeholder="$t('auth.placeholder')"
          @keydown.enter="doLogin"
        />
        <button class="auth-btn" :disabled="auth.isLoading.value" @click="doLogin">
          {{ auth.isLoading.value ? $t('auth.connecting') : $t('auth.connect') }}
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
        <h1 class="header-title">{{ $t('header.title') }}</h1>
        <div class="connection-status">
          <span class="connection-dot" :class="{ connected: sse.connected.value }"></span>
          <span class="connection-label">{{ sse.connected.value ? $t('sse.connected') : sse.reconnecting.value ? $t('sse.reconnecting') : $t('sse.disconnected') }}</span>
        </div>
        <!-- System health badge — hidden when verdict=='ok' so we don't add
             chrome noise in the steady state. Click toggles a popover that
             lists the failing checks with their suggested fixes. -->
        <div v-if="sysHealth && sysHealthVerdict !== 'ok'" class="sys-health">
          <button class="sys-health-btn" :class="sysHealthVerdict" @click="toggleSysHealth" :title="$t('sysHealth.title')">
            <span class="sys-health-icon">⚠</span>
            {{ sysHealthIssues.length }}
          </button>
          <div v-if="sysHealthOpen" class="sys-health-popover" @click.stop>
            <div class="sys-health-popover-title">{{ $t('sysHealth.title') }}</div>
            <ul>
              <li v-for="c in sysHealthIssues" :key="c.name" :class="'lvl-' + c.level">
                <div class="sys-health-name"><strong>{{ c.name }}</strong> — {{ c.message }}</div>
                <div v-if="c.fix" class="sys-health-fix">→ {{ c.fix }}</div>
              </li>
            </ul>
            <button class="sys-health-refresh" @click="loadSysHealth">{{ $t('credentials.refresh') }}</button>
          </div>
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
        <button class="header-toggle-btn" @click="doLogout">{{ $t('header.logout') }}</button>
      </div>
    </header>

    <!-- Sidebar -->
    <aside class="app-sidebar">
      <!-- Channels Section -->
      <div class="sidebar-section">
        <div class="sidebar-section-title">{{ $t('nav.channels') }}</div>
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
            {{ $t('nav.noChannels') }}
          </li>
        </ul>
      </div>

      <!-- Navigation Section -->
      <div class="sidebar-section">
        <div class="sidebar-section-title">{{ $t('nav.views') }}</div>
        <ul class="channel-list">
          <li
            v-for="item in navItems"
            :key="item.id"
            class="channel-item"
            :class="{ active: currentView === item.id }"
            @click="setView(item.id)"
          >
            <span class="channel-icon">{{ item.icon }}</span>
            <span class="channel-name">{{ $t('nav.' + item.id) }}</span>
          </li>
        </ul>
      </div>

      <!-- Watchdog Section (always visible, auto-collapses detail) -->
      <div class="sidebar-section sidebar-section-bottom">
        <WatchdogPanel :api-key="auth.apiKey.value" />
      </div>

      <!-- WeChat Section (collapsible) -->
      <div class="sidebar-section sidebar-section-bottom">
        <div class="sidebar-section-title sidebar-section-toggle" @click="wechatExpanded = !wechatExpanded">
          {{ $t('nav.wechat') }}
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

      <div v-else-if="currentView === 'chanMgmt'" class="view-panel">
        <ChannelsView />
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

/* System health badge — only shown when there are non-ok checks. */
.sys-health {
  position: relative;
  margin-left: 10px;
}
.sys-health-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 9px;
  border: 1px solid currentColor;
  background: transparent;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}
.sys-health-btn.warn { color: var(--orange); }
.sys-health-btn.fail { color: var(--red); }
.sys-health-btn:hover { background: rgba(255,255,255,0.05); }
.sys-health-icon { font-size: 12px; }
.sys-health-popover {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  width: 380px;
  max-width: 90vw;
  background: var(--bg-sidebar);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 8px 24px rgba(0,0,0,0.4);
  padding: 12px 14px;
  z-index: 50;
  font-size: 12px;
}
.sys-health-popover-title {
  font-weight: 600;
  margin-bottom: 8px;
  color: var(--text);
  font-size: 13px;
}
.sys-health-popover ul {
  list-style: none;
  padding: 0;
  margin: 0 0 10px;
}
.sys-health-popover li {
  padding: 6px 0;
  border-bottom: 1px solid var(--border);
}
.sys-health-popover li:last-child { border-bottom: none; }
.sys-health-popover li.lvl-warn .sys-health-name strong { color: var(--orange); }
.sys-health-popover li.lvl-fail .sys-health-name strong { color: var(--red); }
.sys-health-name { color: var(--text-dim); line-height: 1.45; }
.sys-health-fix { color: var(--text-muted); font-size: 11px; margin-top: 2px; }
.sys-health-refresh {
  padding: 4px 10px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  font-size: 11px;
  cursor: pointer;
}
.sys-health-refresh:hover { background: var(--bg-msg-hover); color: var(--text); }

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
