<script setup>
import { ref, computed, inject, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAgentsStore } from '../../stores/agents'
import { formatTime, agentColor, agentInitial } from '../../utils/format'

const api = inject('api')
const apiKey = inject('apiKey')
const store = useAgentsStore(api)
const { t } = useI18n()

const showDetail = ref(false)
const detailAgent = ref(null)
const saving = ref(false)

// ── Create Agent ─────────────────────────────────────────
const showCreate = ref(false)
const newAgent = ref({ name: '', role: '', reportsTo: '', runtime: 'claude', authMode: 'oauth', apiProvider: '', apiBaseUrl: '', apiAuthToken: '', apiModel: '' })
const createResult = ref(null)
const createError = ref('')

async function createAgent() {
  createError.value = ''
  createResult.value = null
  if (!newAgent.value.name.trim()) { createError.value = 'Agent name is required'; return }
  try {
    const regBody = { name: newAgent.value.name.trim() }
    if (newAgent.value.role.trim()) regBody.role = newAgent.value.role.trim()
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey.value },
      body: JSON.stringify(regBody)
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Registration failed')
    createResult.value = data

    // Patch with additional config (reportsTo, runtime, auth)
    const patchBody = {}
    if (newAgent.value.reportsTo) patchBody.reports_to = newAgent.value.reportsTo
    if (newAgent.value.runtime && newAgent.value.runtime !== 'claude') patchBody.runtime = newAgent.value.runtime
    if (newAgent.value.authMode !== 'oauth') {
      patchBody.auth_mode = newAgent.value.authMode
      if (newAgent.value.apiProvider) patchBody.api_provider = newAgent.value.apiProvider
      if (newAgent.value.apiBaseUrl) patchBody.api_base_url = newAgent.value.apiBaseUrl
      if (newAgent.value.apiAuthToken) patchBody.api_auth_token = newAgent.value.apiAuthToken
      if (newAgent.value.apiModel) patchBody.api_model = newAgent.value.apiModel
    }
    if (Object.keys(patchBody).length > 0) {
      await fetch('/api/agents/' + encodeURIComponent(newAgent.value.name.trim()), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey.value },
        body: JSON.stringify(patchBody)
      })
    }
    await store.loadAgents()
  } catch (e) { createError.value = e.message }
}

function closeCreate() {
  showCreate.value = false
  newAgent.value = { name: '', role: '', reportsTo: '', runtime: 'claude', authMode: 'oauth', apiProvider: '', apiBaseUrl: '', apiAuthToken: '', apiModel: '' }
  createResult.value = null
  createError.value = ''
}

// ── Detail Panel ──────────────────────────────────────────
function openDetail(agent) {
  detailAgent.value = { ...agent }
  showDetail.value = true
}
function closeDetail() {
  showDetail.value = false
}

// ── Actions ───────────────────────────────────────────────
// Set of agent names whose start/stop request is currently in flight.
// Drives the per-button spinner + disabled state. Cleared in `finally`
// so a failure still unblocks the button.
const pending = ref(new Set())
function isPending(name) { return pending.value.has(name) }
function setPending(name, v) {
  // Vue's reactivity tracks Set identity, not internal mutations — clone
  // so the template reruns.
  const next = new Set(pending.value)
  if (v) next.add(name); else next.delete(name)
  pending.value = next
}

async function startAgent(name) {
  if (isPending(name)) return
  setPending(name, true)
  try {
    await store.startAgent(name)
  } catch (e) {
    alert('Start failed: ' + e.message)
  } finally {
    setPending(name, false)
  }
}
async function stopAgent(name) {
  if (isPending(name)) return
  setPending(name, true)
  try {
    await store.stopAgent(name)
  } catch (e) {
    alert('Stop failed: ' + e.message)
  } finally {
    setPending(name, false)
  }
}
async function toggleResume(name, enable) {
  try {
    await store.toggleResume(name, enable)
    if (detailAgent.value?.name === name) detailAgent.value.use_resume = enable
  } catch (e) { alert('Failed: ' + e.message) }
}
async function saveConfig() {
  if (!detailAgent.value) return
  saving.value = true
  try {
    const updates = { auth_mode: detailAgent.value.auth_mode || 'oauth' }
    if (updates.auth_mode === 'api_key') {
      updates.api_provider = detailAgent.value.api_provider || ''
      updates.api_base_url = detailAgent.value.api_base_url || ''
      updates.api_model = detailAgent.value.api_model || ''
      const tokenEl = document.getElementById('edit-api-token')
      if (tokenEl?.value) updates.api_auth_token = tokenEl.value
    }
    await store.updateAgent(detailAgent.value.name, updates)
    await store.loadAgents()
    detailAgent.value = store.getAgent(detailAgent.value.name)
  } catch (e) { alert('Save failed: ' + e.message) }
  saving.value = false
}

// ── SSE ───────────────────────────────────────────────────
const sse = inject('sse')
onMounted(() => {
  store.loadAgents()
  sse?.on('status', store.handleStatus)
})

// ── Search + grouping ────────────────────────────────────
const searchQuery = ref('')
const orgTreeExpanded = ref(true)

function matchesSearch(a, q) {
  if (!q) return true
  const needle = q.toLowerCase()
  return (a.name || '').toLowerCase().includes(needle)
      || (a.role || '').toLowerCase().includes(needle)
}

const filteredAgents = computed(() =>
  store.agents.value.filter(a => matchesSearch(a, searchQuery.value))
)
const filteredOnline = computed(() =>
  filteredAgents.value.filter(a => a.status === 'online')
    .sort((a, b) => a.name.localeCompare(b.name))
)
const filteredOffline = computed(() =>
  filteredAgents.value.filter(a => a.status !== 'online')
    .sort((a, b) => a.name.localeCompare(b.name))
)

// ── Org Tree (recursive, DFS-flattened with depth) ───────
// Returns [{ agent, depth, isLast, last }]. `last` is a path of
// boolean-per-ancestor used to draw the proper └/├ guide glyph.
const orgTreeFlat = computed(() => {
  const list = store.agents.value
  const byName = new Map(list.map(a => [a.name, a]))
  const childrenMap = {}
  const roots = []
  for (const a of list) {
    const parent = a.reports_to
    if (parent && byName.has(parent)) (childrenMap[parent] ||= []).push(a)
    else roots.push(a)
  }
  for (const k in childrenMap) childrenMap[k].sort((a, b) => a.name.localeCompare(b.name))
  roots.sort((a, b) => a.name.localeCompare(b.name))
  const visited = new Set()
  const out = []
  function visit(a, depth, lastChain) {
    if (visited.has(a.name)) return  // cycle guard
    visited.add(a.name)
    const kids = childrenMap[a.name] || []
    out.push({ agent: a, depth, last: lastChain, hasChildren: kids.length > 0 })
    kids.forEach((k, i) => visit(k, depth + 1, [...lastChain, i === kids.length - 1]))
  }
  roots.forEach(r => visit(r, 0, []))
  return out
})

// ── Helpers ──────────────────────────────────────────────
function relativeTime(iso) {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0 || ms < 60_000) return t('agents.justNow')
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return mins + t('agents.minAgo')
  const hours = Math.floor(mins / 60)
  if (hours < 24) return hours + t('agents.hourAgo')
  const days = Math.floor(hours / 24)
  if (days < 30) return days + t('agents.dayAgo')
  return new Date(iso).toLocaleDateString()
}

function runtimeOf(a) { return a.runtime || 'claude' }
function runtimeLabel(a) { return runtimeOf(a) === 'codex-pty' ? 'Codex' : 'Claude' }
</script>

<template>
  <div class="agents-view">
    <div class="agents-header">
      <h2>{{ $t('agents.title') }}</h2>
      <div class="header-stats">
        <span class="stat-pill">
          <span class="stat-pill-num">{{ store.agents.value.length }}</span>
          <span class="stat-pill-label">{{ $t('agents.total') }}</span>
        </span>
        <span class="stat-pill green">
          <span class="stat-pill-dot"></span>
          <span class="stat-pill-num">{{ store.onlineAgents.value.length }}</span>
          <span class="stat-pill-label">{{ $t('agents.online') }}</span>
        </span>
        <span class="stat-pill gray">
          <span class="stat-pill-dot"></span>
          <span class="stat-pill-num">{{ store.offlineAgents.value.length }}</span>
          <span class="stat-pill-label">{{ $t('agents.offline') }}</span>
        </span>
      </div>
      <div class="header-search">
        <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <input
          v-model="searchQuery"
          class="search-input"
          :placeholder="$t('agents.searchPlaceholder')"
          type="text"
        />
        <button v-if="searchQuery" class="search-clear" @click="searchQuery = ''" aria-label="Clear">&times;</button>
      </div>
      <button class="create-agent-btn" @click="showCreate = true">+ {{ $t('createAgent.register') }}</button>
      <button class="refresh-btn" @click="store.loadAgents()" :title="$t('credentials.refresh')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12a9 9 0 1 1-3-6.7" />
          <path d="M21 3v6h-6" />
        </svg>
      </button>
    </div>

    <!-- Create Agent Modal -->
    <div v-if="showCreate" class="modal-overlay" @click.self="closeCreate">
      <div class="modal-box">
        <div class="modal-header">
          <h3>{{ $t('createAgent.title') }}</h3>
          <button class="detail-close" @click="closeCreate">&times;</button>
        </div>
        <div class="modal-body" v-if="!createResult">
          <div class="detail-field">
            <div class="detail-label">{{ $t('createAgent.name') }}</div>
            <input v-model="newAgent.name" class="detail-input" :placeholder="$t('createAgent.namePlaceholder')" />
          </div>
          <div class="detail-field">
            <div class="detail-label">{{ $t('createAgent.role') }}</div>
            <input v-model="newAgent.role" class="detail-input" :placeholder="$t('createAgent.rolePlaceholder')" />
          </div>
          <div class="detail-field">
            <div class="detail-label">{{ $t('createAgent.reportsTo') }}</div>
            <select v-model="newAgent.reportsTo" class="detail-select">
              <option value="">—</option>
              <option v-for="a in store.agents.value" :key="a.name" :value="a.name">{{ a.name }}</option>
            </select>
          </div>
          <div class="detail-field">
            <div class="detail-label">{{ $t('createAgent.runtime') }}</div>
            <select v-model="newAgent.runtime" class="detail-select">
              <option value="claude">{{ $t('createAgent.runtimeClaude') }}</option>
              <option value="codex-pty">{{ $t('createAgent.runtimeCodexPty') }}</option>
            </select>
            <div class="detail-hint" v-if="newAgent.runtime !== 'claude'">{{ $t('createAgent.runtimeHint') }}</div>
          </div>
          <div class="detail-field">
            <div class="detail-label">{{ $t('createAgent.authConfig') }}</div>
            <select v-model="newAgent.authMode" class="detail-select">
              <option value="oauth">OAuth</option>
              <option value="api_key">API Key</option>
            </select>
          </div>
          <template v-if="newAgent.authMode === 'api_key'">
            <div class="detail-field">
              <div class="detail-label">{{ $t('agentDetail.provider') }}</div>
              <select v-model="newAgent.apiProvider" class="detail-select">
                <option value="">{{ $t('agentDetail.select') }}</option>
                <option value="anthropic">Anthropic</option>
                <option value="openai">OpenAI</option>
                <option value="openrouter">OpenRouter</option>
                <option value="custom">Custom</option>
              </select>
            </div>
            <div class="detail-field">
              <div class="detail-label">{{ $t('agentDetail.baseUrl') }}</div>
              <input v-model="newAgent.apiBaseUrl" class="detail-input" placeholder="https://api.anthropic.com" />
            </div>
            <div class="detail-field">
              <div class="detail-label">{{ $t('agentDetail.token') }}</div>
              <input type="password" v-model="newAgent.apiAuthToken" class="detail-input" :placeholder="$t('agentDetail.tokenPlaceholder')" />
            </div>
            <div class="detail-field">
              <div class="detail-label">{{ $t('agentDetail.model') }}</div>
              <input v-model="newAgent.apiModel" class="detail-input" placeholder="claude-sonnet-4-20250514" />
            </div>
          </template>
          <div v-if="createError" class="error-text">{{ createError }}</div>
          <button class="save-btn" @click="createAgent">{{ $t('createAgent.register') }}</button>
        </div>
        <div class="modal-body" v-else>
          <div class="success-text">{{ $t('createAgent.success') }}</div>
          <div class="detail-field">
            <div class="detail-label">{{ $t('createAgent.apiKeyLabel') }}</div>
            <div class="api-key-display">{{ createResult.apiKey }}</div>
          </div>
          <div class="warn-text">{{ $t('createAgent.saveWarning') }}</div>
          <button class="save-btn" @click="closeCreate">OK</button>
        </div>
      </div>
    </div>

    <div class="agents-body">
      <!-- Empty state (no agents at all) -->
      <div v-if="store.agents.value.length === 0" class="empty-state">
        <div class="empty-state-icon">
          <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        </div>
        <div class="empty-state-title">{{ $t('agents.noAgents') }}</div>
        <button class="create-agent-btn" @click="showCreate = true">+ {{ $t('createAgent.register') }}</button>
      </div>

      <template v-else>
        <!-- Org Tree (collapsible card) -->
        <section class="panel">
          <header class="panel-header" @click="orgTreeExpanded = !orgTreeExpanded">
            <button class="panel-toggle" :class="{ expanded: orgTreeExpanded }" aria-label="Toggle">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5l8 7-8 7V5z" /></svg>
            </button>
            <h3>{{ $t('agents.orgTree') }}</h3>
            <span class="panel-count">{{ store.agents.value.length }}</span>
          </header>
          <div v-show="orgTreeExpanded" class="panel-body org-tree">
            <div v-for="item in orgTreeFlat" :key="item.agent.name"
                 class="tree-row"
                 @click="openDetail(item.agent)">
              <span class="tree-indent">
                <span v-for="(isLast, i) in item.last" :key="i"
                      class="tree-guide"
                      :class="{ branch: i === item.last.length - 1, blank: i < item.last.length - 1 && item.last[i] }">
                  <template v-if="i === item.last.length - 1">{{ isLast ? '└─' : '├─' }}</template>
                  <template v-else>{{ isLast ? '   ' : '│  ' }}</template>
                </span>
              </span>
              <span class="tree-avatar" :style="{ background: agentColor(item.agent.name) }">{{ agentInitial(item.agent.name) }}</span>
              <span class="tree-name">{{ item.agent.name }}</span>
              <span v-if="item.agent.role" class="tree-role">{{ item.agent.role }}</span>
              <span class="tree-spacer"></span>
              <span class="tree-badge" :class="'rt-' + runtimeOf(item.agent)">{{ runtimeLabel(item.agent) }}</span>
              <span class="tree-status" :class="item.agent.status === 'online' ? 'online' : 'offline'">
                <span class="status-dot" :class="item.agent.status === 'online' ? 'online' : 'offline'"></span>
                {{ item.agent.status === 'online' ? $t('agents.online') : $t('agents.offline') }}
              </span>
            </div>
          </div>
        </section>

        <!-- Filtered: no match -->
        <div v-if="filteredAgents.length === 0" class="empty-text">{{ $t('agents.noMatch') }}</div>

        <!-- Online group -->
        <section v-if="filteredOnline.length > 0" class="panel">
          <header class="panel-header static">
            <span class="group-dot online"></span>
            <h3>{{ $t('agents.online') }}</h3>
            <span class="panel-count">{{ filteredOnline.length }}</span>
          </header>
          <div class="panel-body card-grid">
            <article
              v-for="a in filteredOnline" :key="a.name"
              class="agent-card online"
              @click="openDetail(a)"
            >
              <div class="card-top">
                <span class="card-avatar" :style="{ background: agentColor(a.name) }">{{ agentInitial(a.name) }}</span>
                <div class="card-id">
                  <div class="card-name">{{ a.name }}</div>
                  <div v-if="a.role" class="card-role">{{ a.role }}</div>
                </div>
                <span class="card-badge" :class="'rt-' + runtimeOf(a)">{{ runtimeLabel(a) }}</span>
              </div>
              <div class="card-meta">
                <span class="status-chip online">
                  <span class="status-dot online pulse"></span>
                  {{ $t('agents.online') }}
                </span>
                <span v-if="a.reports_to" class="card-reports-to" :title="$t('agentDetail.reportsTo') + ': ' + a.reports_to">↳ {{ a.reports_to }}</span>
              </div>
              <button class="card-action stop"
                      :disabled="isPending(a.name)"
                      :class="{ pending: isPending(a.name) }"
                      @click.stop="stopAgent(a.name)">
                {{ isPending(a.name) ? $t('agent.stopping') : $t('agent.stop') }}
              </button>
            </article>
          </div>
        </section>

        <!-- Offline group -->
        <section v-if="filteredOffline.length > 0" class="panel">
          <header class="panel-header static">
            <span class="group-dot offline"></span>
            <h3>{{ $t('agents.offline') }}</h3>
            <span class="panel-count">{{ filteredOffline.length }}</span>
          </header>
          <div class="panel-body card-grid">
            <article
              v-for="a in filteredOffline" :key="a.name"
              class="agent-card offline"
              @click="openDetail(a)"
            >
              <div class="card-top">
                <span class="card-avatar dim" :style="{ background: agentColor(a.name) }">{{ agentInitial(a.name) }}</span>
                <div class="card-id">
                  <div class="card-name">{{ a.name }}</div>
                  <div v-if="a.role" class="card-role">{{ a.role }}</div>
                </div>
                <span class="card-badge" :class="'rt-' + runtimeOf(a)">{{ runtimeLabel(a) }}</span>
              </div>
              <div class="card-meta">
                <span class="status-chip offline">
                  <span class="status-dot offline"></span>
                  {{ $t('agents.offline') }}
                </span>
                <span v-if="a.last_seen" class="card-lastseen" :title="formatTime(a.last_seen)">{{ relativeTime(a.last_seen) }}</span>
              </div>
              <button class="card-action start"
                      :disabled="isPending(a.name)"
                      :class="{ pending: isPending(a.name) }"
                      @click.stop="startAgent(a.name)">
                {{ isPending(a.name) ? $t('agent.starting') : $t('agent.start') }}
              </button>
            </article>
          </div>
        </section>
      </template>
    </div>

    <!-- Detail Slide-in -->
    <div v-if="showDetail && detailAgent" class="agent-detail-panel">
      <div class="detail-header">
        <h3>{{ $t('agentDetail.title') }}</h3>
        <button class="detail-close" @click="closeDetail">&times;</button>
      </div>
      <div class="detail-body">
        <div class="detail-field">
          <div class="detail-label">{{ $t('agentDetail.name') }}</div>
          <div class="detail-value big">{{ detailAgent.name }}</div>
        </div>
        <div class="detail-field">
          <div class="detail-label">{{ $t('agentDetail.role') }}</div>
          <div class="detail-value">{{ detailAgent.role || 'N/A' }}</div>
        </div>
        <div class="detail-field">
          <div class="detail-label">{{ $t('agentDetail.status') }}</div>
          <div class="detail-value">
            <span class="status-dot" :class="detailAgent.status === 'online' ? 'online' : 'offline'"></span>
            {{ detailAgent.status === 'online' ? $t('agents.online') : $t('agents.offline') }}
          </div>
        </div>
        <div class="detail-field">
          <div class="detail-label">{{ $t('agentDetail.reportsTo') }}</div>
          <div class="detail-value">{{ detailAgent.reports_to || $t('agentDetail.noneRoot') }}</div>
        </div>
        <div v-if="detailAgent.last_seen" class="detail-field">
          <div class="detail-label">{{ $t('agentDetail.lastSeen') }}</div>
          <div class="detail-value dim">{{ formatTime(detailAgent.last_seen) }}</div>
        </div>
        <div class="detail-field">
          <div class="detail-label">{{ $t('agentDetail.resume') }}</div>
          <button
            class="resume-toggle"
            :class="{ active: detailAgent.use_resume !== false }"
            @click="toggleResume(detailAgent.name, detailAgent.use_resume === false); detailAgent.use_resume = detailAgent.use_resume === false"
          >
            {{ detailAgent.use_resume !== false ? $t('agentDetail.resumeOn') : $t('agentDetail.resumeOff') }}
          </button>
        </div>

        <!-- Config Section -->
        <div class="detail-config-section">
          <div class="detail-label bold">{{ $t('agentDetail.config') }}</div>
          <div class="detail-field">
            <div class="detail-label">{{ $t('agentDetail.authMode') }}</div>
            <select v-model="detailAgent.auth_mode" class="detail-select">
              <option value="oauth">{{ $t('agentDetail.oauth') }}</option>
              <option value="api_key">{{ $t('agentDetail.apiKey') }}</option>
            </select>
          </div>
          <template v-if="detailAgent.auth_mode === 'api_key'">
            <div class="detail-field">
              <div class="detail-label">{{ $t('agentDetail.provider') }}</div>
              <select v-model="detailAgent.api_provider" class="detail-select">
                <option value="">{{ $t('agentDetail.select') }}</option>
                <option value="anthropic">Anthropic</option>
                <option value="openai">OpenAI</option>
                <option value="openrouter">OpenRouter</option>
                <option value="custom">Custom</option>
              </select>
            </div>
            <div class="detail-field">
              <div class="detail-label">{{ $t('agentDetail.baseUrl') }}</div>
              <input type="text" v-model="detailAgent.api_base_url" class="detail-input" placeholder="https://api.anthropic.com" />
            </div>
            <div class="detail-field">
              <div class="detail-label">{{ $t('agentDetail.token') }}</div>
              <input type="password" id="edit-api-token" class="detail-input" :placeholder="$t('agentDetail.tokenPlaceholder')" />
            </div>
            <div class="detail-field">
              <div class="detail-label">{{ $t('agentDetail.model') }}</div>
              <input type="text" v-model="detailAgent.api_model" class="detail-input" placeholder="claude-sonnet-4-20250514" />
            </div>
          </template>
          <button class="save-btn" @click="saveConfig" :disabled="saving">
            {{ saving ? $t('agentDetail.saving') : $t('agentDetail.save') }}
          </button>
        </div>

        <!-- Actions -->
        <div class="detail-actions">
          <button v-if="detailAgent.status === 'online'"
                  class="action-btn stop"
                  :disabled="isPending(detailAgent.name)"
                  :class="{ pending: isPending(detailAgent.name) }"
                  @click="stopAgent(detailAgent.name)">
            {{ isPending(detailAgent.name) ? $t('agent.stopping') : $t('agentDetail.stop') }}
          </button>
          <button v-else
                  class="action-btn start"
                  :disabled="isPending(detailAgent.name)"
                  :class="{ pending: isPending(detailAgent.name) }"
                  @click="startAgent(detailAgent.name)">
            {{ isPending(detailAgent.name) ? $t('agent.starting') : $t('agentDetail.start') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.agents-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

/* ── Header (single row, compact) ─────────────────────── */
.agents-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-sidebar);
  flex-shrink: 0;
}
.agents-header h2 { font-size: 16px; font-weight: 700; white-space: nowrap; }

.header-stats { display: flex; gap: 6px; }
.stat-pill {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 9px;
  background: var(--bg-msg);
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 11px;
  color: var(--text-dim);
  white-space: nowrap;
}
.stat-pill-num { font-weight: 700; color: var(--text); font-size: 12px; }
.stat-pill-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted); }
.stat-pill.green .stat-pill-dot { background: var(--green); }
.stat-pill.green .stat-pill-num { color: var(--green); }
.stat-pill.gray .stat-pill-num { color: var(--text-dim); }

.header-search {
  position: relative;
  flex: 1;
  max-width: 320px;
  margin-left: auto;
  display: flex;
  align-items: center;
}
.search-icon {
  position: absolute;
  left: 10px;
  color: var(--text-muted);
  pointer-events: none;
}
.search-input {
  width: 100%;
  padding: 6px 28px 6px 30px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-size: 13px;
  outline: none;
  transition: border-color 0.15s;
}
.search-input:focus { border-color: var(--accent); }
.search-input::placeholder { color: var(--text-muted); }
.search-clear {
  position: absolute;
  right: 6px;
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
}
.search-clear:hover { color: var(--text); background: var(--bg-msg-hover); }

.refresh-btn {
  padding: 6px 9px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
}
.refresh-btn:hover { background: var(--bg-msg-hover); color: var(--text); }

/* ── Body / Panels ────────────────────────────────────── */
.agents-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.panel {
  background: var(--bg-msg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  flex-shrink: 0;
}
.panel-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: var(--bg-input);
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  user-select: none;
}
.panel-header.static { cursor: default; }
.panel-header h3 {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-dim);
}
.panel-toggle {
  background: none;
  border: none;
  color: var(--text-dim);
  cursor: pointer;
  padding: 2px;
  display: inline-flex;
  transition: transform 0.18s;
}
.panel-toggle.expanded { transform: rotate(90deg); }
.panel-count {
  margin-left: auto;
  background: var(--bg-msg);
  color: var(--text-dim);
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
}
.group-dot {
  width: 8px; height: 8px; border-radius: 50%;
  display: inline-block; flex-shrink: 0;
}
.group-dot.online { background: var(--green); box-shadow: 0 0 0 3px rgba(61,214,140,0.18); }
.group-dot.offline { background: var(--text-muted); }
.panel-body { padding: 12px 14px; }

/* ── Org Tree ─────────────────────────────────────────── */
.org-tree {
  padding: 6px 8px;
  /* Cap at ~12 rows; scroll for the rest. Keeps a 40+ agent tree from
     swamping the page above the card sections. */
  max-height: 380px;
  overflow-y: auto;
}
.tree-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 13px;
  transition: background 0.12s;
}
.tree-row:hover { background: var(--bg-msg-hover); }
.tree-indent {
  display: inline-flex;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--text-muted);
  font-size: 12px;
  white-space: pre;
  user-select: none;
}
.tree-guide { display: inline-block; }
.tree-avatar {
  width: 22px; height: 22px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  color: #fff;
  flex-shrink: 0;
}
.tree-name { font-weight: 600; }
.tree-role { color: var(--text-muted); font-size: 12px; }
.tree-spacer { flex: 1; }
.tree-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 999px;
  letter-spacing: 0.3px;
}
.tree-badge.rt-claude { background: rgba(91,127,245,0.15); color: var(--accent); }
.tree-badge.rt-codex-pty { background: rgba(163,113,247,0.15); color: #a371f7; }
.tree-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-muted);
  min-width: 60px;
  justify-content: flex-end;
}
.tree-status.online { color: var(--green); }

/* ── Agent cards ──────────────────────────────────────── */
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 10px;
  padding: 12px 14px;
}
.agent-card {
  background: var(--bg-sidebar);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px;
  cursor: pointer;
  transition: transform 0.15s, border-color 0.15s, box-shadow 0.15s;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.agent-card:hover {
  border-color: var(--accent);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0,0,0,0.18);
}
.agent-card.offline { opacity: 0.78; }
.agent-card.offline:hover { opacity: 1; }

.card-top {
  display: flex;
  align-items: center;
  gap: 10px;
}
.card-avatar {
  width: 32px; height: 32px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 700;
  color: #fff;
  flex-shrink: 0;
}
.card-avatar.dim { filter: grayscale(0.4) brightness(0.85); }
.card-id { flex: 1; min-width: 0; }
.card-name {
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.card-role {
  font-size: 11px;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.card-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 999px;
  letter-spacing: 0.3px;
  flex-shrink: 0;
}
.card-badge.rt-claude { background: rgba(91,127,245,0.15); color: var(--accent); }
.card-badge.rt-codex-pty { background: rgba(163,113,247,0.15); color: #a371f7; }

.card-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  color: var(--text-muted);
}
.status-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-weight: 600;
}
.status-chip.online { color: var(--green); }
.status-chip.offline { color: var(--text-muted); }
.status-dot {
  width: 7px; height: 7px;
  border-radius: 50%;
  display: inline-block;
}
.status-dot.online { background: var(--green); }
.status-dot.offline { background: var(--text-muted); }
.status-dot.pulse {
  animation: status-pulse 1.8s ease-in-out infinite;
  box-shadow: 0 0 0 0 rgba(61,214,140,0.6);
}
@keyframes status-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(61,214,140,0.5); }
  50%      { box-shadow: 0 0 0 5px rgba(61,214,140,0); }
}
.card-reports-to {
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.card-lastseen {
  font-size: 11px;
  color: var(--text-muted);
}

.card-action {
  padding: 6px 12px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid var(--border);
  background: var(--bg-input);
  color: var(--text);
  transition: all 0.15s;
}
.card-action.start:hover { background: rgba(61,214,140,0.15); border-color: var(--green); color: var(--green); }
.card-action.stop:hover  { background: rgba(229,83,75,0.15); border-color: var(--red); color: var(--red); }
.card-action.pending {
  opacity: 0.6;
  cursor: progress;
  position: relative;
  padding-left: 26px;
}
.card-action.pending::before {
  content: '';
  position: absolute;
  left: 10px; top: 50%;
  width: 10px; height: 10px;
  margin-top: -5px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: pending-spin 0.7s linear infinite;
}
.card-action:disabled { pointer-events: none; }
.action-btn.pending {
  opacity: 0.6; cursor: progress;
  position: relative; padding-left: 32px;
}
.action-btn.pending::before {
  content: '';
  position: absolute;
  left: 12px; top: 50%;
  width: 10px; height: 10px;
  margin-top: -5px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: pending-spin 0.7s linear infinite;
}
.action-btn:disabled { pointer-events: none; }
@keyframes pending-spin { to { transform: rotate(360deg); } }

/* ── Empty states ─────────────────────────────────────── */
.empty-text {
  color: var(--text-muted);
  font-size: 13px;
  text-align: center;
  padding: 24px 0;
}
.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 60px 20px;
  color: var(--text-muted);
}
.empty-state-icon { color: var(--text-muted); opacity: 0.6; }
.empty-state-title { font-size: 14px; color: var(--text-dim); }

/* Detail panel */
.agent-detail-panel {
  position: fixed; top: 0; right: 0; width: 400px; height: 100vh;
  background: var(--bg-sidebar); border-left: 1px solid var(--border);
  z-index: 100; display: flex; flex-direction: column;
  box-shadow: -4px 0 16px rgba(0,0,0,0.3);
}
.detail-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 16px; border-bottom: 1px solid var(--border);
}
.detail-header h3 { font-size: 15px; font-weight: 700; }
.detail-close {
  background: none; border: none; color: var(--text-dim);
  font-size: 20px; cursor: pointer; padding: 4px 8px;
}
.detail-close:hover { background: var(--bg-msg); color: var(--text); }
.detail-body { flex: 1; overflow-y: auto; padding: 16px; }
.detail-field { margin-bottom: 14px; }
.detail-label {
  font-size: 11px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.5px; color: var(--text-muted); margin-bottom: 4px;
}
.detail-label.bold { font-size: 12px; margin-bottom: 12px; color: var(--text-dim); }
.detail-value { font-size: 13px; }
.detail-value.big { font-size: 16px; font-weight: 700; }
.detail-value.dim { font-size: 12px; color: var(--text-dim); }
.status-dot {
  width: 10px; height: 10px; border-radius: 50%;
  display: inline-block; margin-right: 6px;
}
.status-dot.online { background: var(--green); }
.status-dot.offline { background: var(--text-muted); }
.resume-toggle {
  padding: 6px 16px; border-radius: var(--radius-sm);
  font-size: 12px; font-weight: 600; cursor: pointer;
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim);
}
.resume-toggle.active {
  background: rgba(61,214,140,0.15); border-color: var(--green); color: var(--green);
}
.detail-config-section {
  border-top: 1px solid var(--border); margin-top: 16px; padding-top: 16px;
}
.detail-select, .detail-input {
  width: 100%; padding: 8px 12px; background: var(--bg-input);
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  color: var(--text); font-size: 13px;
}
.save-btn {
  margin-top: 12px; padding: 8px 20px; border-radius: var(--radius-sm);
  font-size: 13px; font-weight: 600; cursor: pointer;
  border: none; background: var(--accent); color: #fff; width: 100%;
}
.save-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.detail-actions {
  display: flex; gap: 8px; margin-top: 16px;
  border-top: 1px solid var(--border); padding-top: 16px;
}
.action-btn {
  padding: 8px 20px; border-radius: var(--radius-sm);
  font-size: 13px; font-weight: 600; cursor: pointer; border: none;
}
.action-btn.start { background: rgba(61,214,140,0.15); color: var(--green); }
.action-btn.stop { background: rgba(229,83,75,0.15); color: var(--red); }

/* Create Agent */
.create-agent-btn {
  padding: 5px 14px; border-radius: var(--radius-sm);
  font-size: 12px; font-weight: 600; cursor: pointer;
  border: 1px solid var(--accent); background: var(--accent); color: #fff;
}
.create-agent-btn:hover { opacity: 0.9; }
.modal-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.5);
  display: flex; align-items: center; justify-content: center; z-index: 200;
}
.modal-box {
  background: var(--bg-sidebar); border: 1px solid var(--border);
  border-radius: var(--radius); width: 420px; max-height: 80vh;
  overflow-y: auto; box-shadow: 0 8px 32px rgba(0,0,0,0.4);
}
.modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 16px; border-bottom: 1px solid var(--border);
}
.modal-header h3 { font-size: 15px; font-weight: 700; }
.modal-body { padding: 16px; }
.error-text { color: var(--red); font-size: 12px; margin-bottom: 10px; }
.success-text { color: var(--green); font-size: 14px; font-weight: 600; margin-bottom: 14px; }
.warn-text { color: var(--yellow, #c9b44a); font-size: 12px; margin: 10px 0; }
.api-key-display {
  font-family: monospace; font-size: 14px; padding: 10px;
  background: var(--bg-input); border: 1px solid var(--border);
  border-radius: var(--radius-sm); word-break: break-all;
  user-select: all;
}
</style>
