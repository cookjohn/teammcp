<script setup>
import { ref, inject, onMounted, onUnmounted, watch } from 'vue'
import { useStateStore } from '../../stores/state'
import { formatTime, formatDate, agentColor, escapeHtml } from '../../utils/format'
import ApprovalsPanel from './ApprovalsPanel.vue'
import ChangeLog from './ChangeLog.vue'
import StateFieldDetail from './StateFieldDetail.vue'

const api = inject('api')
const store = useStateStore(api)

const projectIdInput = ref('agent-os-mvp')
const showDetail = ref(false)
const detailField = ref('')
const detailData = ref(null)
const detailHistory = ref([])

// ── Auto-refresh ──────────────────────────────────────────
const autoRefreshOn = ref(false)

function toggleAutoRefresh() {
  if (autoRefreshOn.value) {
    store.stopAutoRefresh()
    autoRefreshOn.value = false
  } else {
    store.startAutoRefresh(15000)
    autoRefreshOn.value = true
  }
}

// ── Load ──────────────────────────────────────────────────
async function refresh() {
  const pid = projectIdInput.value.trim()
  if (!pid) return
  store.currentProjectId.value = pid
  await store.refresh(pid)
}

// ── Field Detail ──────────────────────────────────────────
async function openFieldDetail(field) {
  const pid = store.currentProjectId.value
  try {
    const data = await api(`/api/state?project_id=${encodeURIComponent(pid)}&field=${encodeURIComponent(field)}`)
    detailData.value = Array.isArray(data.items) ? data.items[0] : data
  } catch { detailData.value = null }

  try {
    const hist = await api(`/api/state/history?project_id=${encodeURIComponent(pid)}&field=${encodeURIComponent(field)}&limit=20`)
    detailHistory.value = Array.isArray(hist) ? hist : (hist.items || [])
  } catch { detailHistory.value = [] }

  detailField.value = field
  showDetail.value = true
}

function closeFieldDetail() {
  showDetail.value = false
}

// ── SSE ───────────────────────────────────────────────────
const sse = inject('sse')
onMounted(() => {
  sse?.on('state_changed', store.handleStateChanged)
  sse?.on('approval_requested', () => store.loadApprovals(store.currentProjectId.value))
  sse?.on('approval_resolved', () => {
    store.loadApprovals(store.currentProjectId.value)
    store.loadFields(store.currentProjectId.value)
  })
  refresh()
})
onUnmounted(() => {
  store.stopAutoRefresh()
})

// ── Helpers ───────────────────────────────────────────────
function truncateValue(value, maxLen = 100) {
  if (!value) return '(empty)'
  let display = value
  try { display = JSON.stringify(JSON.parse(value), null, 2) } catch {}
  return display.length > maxLen ? display.slice(0, maxLen) + '...' : display
}

function getValueStatusColor(value) {
  if (!value) return ''
  const v = String(value).toLowerCase().trim()
  if (['running','active','online','healthy','ok','success','completed','done','ready','true','yes','enabled','up'].includes(v)) return 'green'
  if (['error','failed','offline','down','critical','false','no','disabled','stopped','crashed'].includes(v)) return 'red'
  if (['warning','pending','waiting','queued','paused','blocked','review'].includes(v)) return 'orange'
  if (['in_progress','in-progress','building','deploying','processing','syncing','loading'].includes(v)) return 'blue'
  if (['draft','wip','todo','planning','scheduled'].includes(v)) return 'yellow'
  return ''
}
</script>

<template>
  <div class="state-view">
    <!-- Header -->
    <div class="state-header">
      <h2>{{ $t('state.title') }}</h2>
      <span v-if="store.lastUpdated.value" class="state-last-updated">
        {{ $t('general.updated') }} {{ formatTime(store.lastUpdated.value) }}
      </span>
      <input
        class="state-project-input"
        v-model="projectIdInput"
        @keydown.enter="refresh"
        placeholder="agent-os-mvp"
      />
      <button
        class="state-auto-refresh-btn"
        :class="{ active: autoRefreshOn }"
        @click="toggleAutoRefresh"
        :title="$t('state.autoRefresh')"
      >
        {{ $t('state.auto') }}
      </button>
      <button class="state-refresh-btn" @click="refresh" :title="$t('state.refresh')">&#128260;</button>
    </div>

    <div class="state-body">
      <!-- Summary Stats -->
      <div v-if="store.fields.value.length > 0" class="state-summary-bar">
        <div class="state-summary-stat accent">
          <div class="stat-value">{{ store.fields.value.length }}</div>
          <div class="stat-label">{{ $t('state.totalFields') }}</div>
        </div>
        <div class="state-summary-stat green">
          <div class="stat-value">{{ store.activeOwnerCount.value }}</div>
          <div class="stat-label">{{ $t('state.activeOwners') }}</div>
        </div>
        <div v-if="store.needApprovalCount.value > 0" class="state-summary-stat orange">
          <div class="stat-value">{{ store.needApprovalCount.value }}</div>
          <div class="stat-label">{{ $t('state.needApproval') }}</div>
        </div>
      </div>

      <!-- Fields Grid -->
      <div class="state-fields-section">
        <div class="state-section-title">{{ $t('state.stateFields') }}</div>
        <div v-if="store.fields.value.length === 0" class="state-empty">
          {{ $t('state.noFields') }}
        </div>
        <div v-else class="state-fields-grid">
          <div
            v-for="field in store.fields.value"
            :key="field.field"
            class="state-field-card"
            :data-status-color="getValueStatusColor(field.value)"
            @click="openFieldDetail(field.field)"
          >
            <div class="state-field-name">
              {{ field.field }}
              <span v-if="field.approval_required" class="state-field-approval-badge">
                {{ $t('state.approvalRequired') }}
              </span>
            </div>
            <span
              v-if="getValueStatusColor(field.value)"
              class="state-value-status"
              :class="getValueStatusColor(field.value)"
            >
              {{ String(field.value).trim() }}
            </span>
            <div class="state-field-value">{{ truncateValue(field.value) }}</div>
            <div class="state-field-meta">
              <span v-if="field.owner" class="state-field-owner">
                <span class="agent-dot online" :style="{ background: agentColor(field.owner) }"></span>
                {{ field.owner }}
              </span>
              <span class="state-field-version">v{{ field.version || 1 }}</span>
              <span v-if="field.updated_at" class="state-field-time">{{ formatTime(field.updated_at) }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Approvals -->
      <ApprovalsPanel
        :approvals="store.approvals.value"
        @resolve="(id, approved) => store.resolveApproval(store.currentProjectId.value, id, approved)"
      />

      <!-- Change Log -->
      <ChangeLog :project-id="store.currentProjectId.value" :api="api" />
    </div>

    <!-- Field Detail Slide-in -->
    <StateFieldDetail
      v-if="showDetail"
      :field="detailField"
      :data="detailData"
      :history="detailHistory"
      @close="closeFieldDetail"
    />
  </div>
</template>

<style scoped>
.state-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.state-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-sidebar);
  flex-shrink: 0;
}
.state-header h2 {
  font-size: 16px;
  font-weight: 700;
}
.state-last-updated {
  font-size: 12px;
  color: var(--text-muted);
}
.state-project-input {
  margin-left: auto;
  padding: 4px 10px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-size: 13px;
  width: 160px;
}
.state-project-input:focus {
  outline: none;
  border-color: var(--accent);
}
.state-auto-refresh-btn {
  padding: 4px 10px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}
.state-auto-refresh-btn.active {
  background: rgba(61, 214, 140, 0.1);
  border-color: var(--green);
  color: var(--green);
}
.state-auto-refresh-btn:hover { background: var(--bg-msg-hover); }
.state-refresh-btn {
  padding: 4px 10px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  font-size: 14px;
  cursor: pointer;
  transition: all 0.15s;
}
.state-refresh-btn:hover { background: var(--bg-msg-hover); color: var(--text); }

.state-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* Summary bar */
.state-summary-bar {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}
.state-summary-stat {
  background: var(--bg-msg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 20px;
  min-width: 120px;
}
.state-summary-stat .stat-value {
  font-size: 22px;
  font-weight: 700;
}
.state-summary-stat .stat-label {
  font-size: 12px;
  color: var(--text-dim);
  margin-top: 2px;
}
.state-summary-stat.accent .stat-value { color: var(--accent); }
.state-summary-stat.green .stat-value { color: var(--green); }
.state-summary-stat.orange .stat-value { color: var(--orange); }

/* Fields */
.state-fields-section { }
.state-section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 10px;
}
.state-fields-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 10px;
}
.state-field-card {
  background: var(--bg-msg);
  border: 1px solid var(--border);
  border-left: 3px solid transparent;
  border-radius: var(--radius);
  padding: 12px 14px;
  cursor: pointer;
  transition: all 0.15s;
}
.state-field-card:hover {
  background: var(--bg-msg-hover);
  border-color: var(--accent);
}
.state-field-card[data-status-color="green"] { border-left-color: var(--green); }
.state-field-card[data-status-color="red"] { border-left-color: var(--red); }
.state-field-card[data-status-color="orange"] { border-left-color: var(--orange); }
.state-field-card[data-status-color="blue"] { border-left-color: var(--accent); }
.state-field-card[data-status-color="yellow"] { border-left-color: var(--yellow); }
.state-field-name {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 4px;
}
.state-field-approval-badge {
  font-size: 10px;
  background: rgba(212, 132, 62, 0.15);
  color: var(--orange);
  padding: 1px 6px;
  border-radius: 3px;
  margin-left: 6px;
  font-weight: 500;
}
.state-field-value {
  font-size: 12px;
  color: var(--text-dim);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 60px;
  overflow: hidden;
}
.state-field-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  font-size: 11px;
  color: var(--text-muted);
}
.state-field-owner {
  display: flex;
  align-items: center;
  gap: 4px;
}
.state-field-version {
  font-size: 10px;
  background: var(--bg);
  padding: 1px 5px;
  border-radius: 3px;
  color: var(--text-dim);
}
.state-value-status {
  display: inline-block;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 10px;
  margin-bottom: 4px;
}
.state-value-status.green { background: rgba(61, 214, 140, 0.12); color: var(--green); }
.state-value-status.red { background: rgba(229, 83, 75, 0.12); color: var(--red); }
.state-value-status.orange { background: rgba(212, 132, 62, 0.12); color: var(--orange); }
.state-value-status.blue { background: rgba(91, 127, 245, 0.12); color: var(--accent); }
.state-value-status.yellow { background: rgba(201, 180, 74, 0.12); color: var(--yellow); }
.agent-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  display: inline-block;
}
.state-empty {
  text-align: center;
  padding: 40px 20px;
  color: var(--text-dim);
  font-size: 13px;
}
</style>
