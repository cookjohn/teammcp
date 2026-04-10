<script setup>
import { ref, inject, computed, onMounted } from 'vue'
import { useCredentialsStore } from '../../stores/credentials'
import { formatTime, formatDate, agentColor } from '../../utils/format'

const api = inject('api')
const apiKey = inject('apiKey')
const t = inject('t')

const dashboardToken = ref('')
const loading = ref(false)
const refreshing = ref(false)

// Dashboard token management — always fetches fresh token on first call,
// retries once on 403 (token rotates on server restart)
async function fetchDashboardToken() {
  try {
    const data = await api('/api/dashboard/token')
    const token = data.token || data.dashboardToken || data.access_token || ''
    dashboardToken.value = token
    if (token) sessionStorage.setItem('dashboardToken', token)
    return token
  } catch {
    dashboardToken.value = ''
    sessionStorage.removeItem('dashboardToken')
    return null
  }
}

async function ensureDashboardToken() {
  if (dashboardToken.value) return dashboardToken.value
  // Try sessionStorage first
  const stored = sessionStorage.getItem('dashboardToken')
  if (stored) {
    dashboardToken.value = stored
    return stored
  }
  return await fetchDashboardToken()
}

// credApi wrapper with 403 retry (handles stale token after server restart)
async function storeCredApi(path, options = {}) {
  let token = await ensureDashboardToken()
  if (!token) throw new Error('Unauthorized: dashboard token required')

  const url = path
  const headers = {
    'Authorization': 'Bearer ' + (typeof apiKey === 'object' ? apiKey.value : apiKey),
    'x-dashboard-token': token,
    'Content-Type': 'application/json',
    ...(options.headers || {})
  }

  let res = await fetch(url, { ...options, headers })

  // If 403, token may be stale — refresh and retry once
  if (res.status === 403) {
    dashboardToken.value = ''
    sessionStorage.removeItem('dashboardToken')
    token = await fetchDashboardToken()
    if (!token) throw new Error('Unauthorized: could not refresh dashboard token')
    headers['x-dashboard-token'] = token
    res = await fetch(url, { ...options, headers })
  }

  if (!res.ok) {
    let errMsg = 'API ' + res.status
    try { const body = await res.json(); if (body.error) errMsg = body.error } catch {}
    throw new Error(errMsg)
  }
  return res.json()
}

// Replace store's credApi with our wrapper
const localStore = useCredentialsStore(storeCredApi)

const leasesPage = ref(1)
const totalPages = computed(() => Math.ceil(localStore.leasesTotal.value / 50))

// ── Actions ───────────────────────────────────────────────
async function loadAll() {
  loading.value = true
  try {
    await localStore.refresh()
  } catch (e) {
    console.error('Credentials load failed:', e)
  }
  loading.value = false
}

async function refreshAll() {
  refreshing.value = true
  try {
    await localStore.refresh()
  } catch {}
  refreshing.value = false
}

async function switchStrategy(agentName, newStrategy) {
  try {
    await localStore.switchAuthStrategy(agentName, newStrategy)
  } catch (e) {
    alert('Switch failed: ' + e.message)
  }
}

async function revokeLease(leaseId) {
  if (!confirm('Revoke lease ' + leaseId.substring(0, 8) + '?')) return
  try {
    await localStore.revokeLease(leaseId)
  } catch (e) {
    alert('Revoke failed: ' + e.message)
  }
}

async function loadPage(page) {
  leasesPage.value = page
  await localStore.loadLeases(page)
}

async function refreshOAuth() {
  refreshing.value = true
  try {
    const token = await ensureDashboardToken()
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey.value, 'x-dashboard-token': token }
    })
    if (!res.ok) throw new Error('Refresh failed')
    await localStore.loadOverview()
  } catch (e) {
    alert('Token refresh failed: ' + e.message)
  }
  refreshing.value = false
}

async function startOAuthLogin() {
  try {
    const token = await ensureDashboardToken()
    const res = await fetch('/api/auth/login/start', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey.value, 'x-dashboard-token': token }
    })
    const data = await res.json()
    const oauthUrl = data.authorizeUrl || data.url
    if (oauthUrl) window.open(oauthUrl, '_blank')
    else alert('OAuth login started. Follow the instructions.')
  } catch (e) {
    alert('OAuth login failed: ' + e.message)
  }
}

// ── SSE ───────────────────────────────────────────────────
const sse = inject('sse')
onMounted(() => {
  loadAll()
})
</script>

<template>
  <div class="credentials-view">
    <div class="credentials-header">
      <h2>{{ t('credentials.title') }}</h2>
      <button class="refresh-btn" @click="refreshAll" :disabled="refreshing">&#128260;</button>
    </div>

    <div class="credentials-body">
      <!-- Overview Stats -->
      <div class="cred-overview-bar" v-if="localStore.overview.value">
        <div class="cred-stat-card">
          <div class="stat-value">{{ (localStore.overview.value.agents || []).length }}</div>
          <div class="stat-label">{{ t('credentials.agent') }}s</div>
        </div>
        <div class="cred-stat-card green">
          <div class="stat-value">{{ (localStore.overview.value.agents || []).filter(a => a.auth_strategy === 'path_a').length }}</div>
          <div class="stat-label">{{ t('credentials.pathA') }}</div>
        </div>
        <div class="cred-stat-card orange">
          <div class="stat-value">{{ (localStore.overview.value.agents || []).filter(a => !a.auth_strategy || a.auth_strategy === 'legacy').length }}</div>
          <div class="stat-label">{{ t('credentials.legacy') }}</div>
        </div>
        <div class="cred-stat-card" v-if="localStore.overview.value.tokenStatus">
          <div class="stat-value" :style="{ color: localStore.overview.value.tokenStatus.loggedIn ? 'var(--green)' : 'var(--red)' }">
            {{ localStore.overview.value.tokenStatus.loggedIn ? t('credentials.connected') : t('credentials.disconnected') }}
          </div>
          <div class="stat-label">OAuth</div>
        </div>
      </div>

      <!-- Auth Strategy Table -->
      <div class="cred-section">
        <div class="section-title">{{ t('credentials.authStrategy') }}</div>
        <div v-if="!localStore.overview.value" class="cred-loading">{{ t('state.loading') }}</div>
        <table v-else-if="(localStore.overview.value.agents || []).length > 0" class="cred-table">
          <thead>
            <tr>
              <th>{{ t('credentials.agent') }}</th>
              <th>{{ t('credentials.role') }}</th>
              <th>{{ t('credentials.strategy') }}</th>
              <th>{{ t('credentials.status') }}</th>
              <th>{{ t('credentials.action') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="agent in (localStore.overview.value.agents || [])" :key="agent.name || agent.agent_id">
              <td>
                <span class="agent-name" :style="{ color: agentColor(agent.name || agent.agent_id) }">
                  {{ agent.name || agent.agent_id }}
                </span>
              </td>
              <td class="dim">{{ agent.role || '-' }}</td>
              <td>
                <span class="strategy-badge" :class="agent.auth_strategy === 'path_a' ? 'patha' : 'legacy'">
                  {{ agent.auth_strategy || 'legacy' }}
                </span>
              </td>
              <td>
                <span class="status-dot" :class="agent.status === 'online' ? 'online' : 'offline'"></span>
                {{ agent.status === 'online' ? t('credentials.online') : t('credentials.offline') }}
              </td>
              <td>
                <select
                  class="strategy-select"
                  :value="agent.auth_strategy || 'legacy'"
                  @change="switchStrategy(agent.name || agent.agent_id, $event.target.value)"
                >
                  <option value="legacy">{{ t('credentials.legacy') }}</option>
                  <option value="path_a">{{ t('credentials.pathA') }}</option>
                </select>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="cred-empty">{{ t('credentials.noLeases') }}</div>
      </div>

      <!-- Leases Table -->
      <div class="cred-section">
        <div class="section-title">{{ t('credentials.leases') }}</div>
        <div v-if="localStore.loading.value" class="cred-loading">{{ t('state.loading') }}</div>
        <table v-else-if="localStore.leases.value.length > 0" class="cred-table">
          <thead>
            <tr>
              <th>{{ t('credentials.leaseId') }}</th>
              <th>{{ t('credentials.agent') }}</th>
              <th>{{ t('credentials.issuedAt') }}</th>
              <th>{{ t('credentials.expiresAt') }}</th>
              <th>{{ t('credentials.status') }}</th>
              <th>{{ t('credentials.action') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="lease in localStore.leases.value" :key="lease.lease_id || lease.id">
              <td class="lease-id">{{ (lease.lease_id || lease.id || '').substring(0, 8) }}</td>
              <td>
                <span class="agent-name" :style="{ color: agentColor(lease.agent) }">{{ lease.agent || '-' }}</span>
              </td>
              <td class="dim">{{ lease.leased_at ? formatDate(lease.leased_at) + ' ' + formatTime(lease.leased_at) : '-' }}</td>
              <td class="dim">{{ lease.expires_at ? formatDate(lease.expires_at) + ' ' + formatTime(lease.expires_at) : '-' }}</td>
              <td>
                <span class="status-dot" :class="lease.status === 'active' ? 'online' : (lease.status === 'revoked' ? 'offline' : 'warn')"></span>
                {{ lease.status ? lease.status.charAt(0).toUpperCase() + lease.status.slice(1) : 'Unknown' }}
              </td>
              <td>
                <button
                  v-if="lease.status === 'active'"
                  class="btn-revoke"
                  @click="revokeLease(lease.lease_id || lease.id)"
                >{{ t('credentials.revoke') }}</button>
                <span v-else class="dim">-</span>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="cred-empty">{{ t('credentials.noLeases') }}</div>

        <!-- Pagination -->
        <div v-if="localStore.leasesTotal.value > 50" class="leases-pagination">
          <span>{{ t('credentials.page') }} {{ leasesPage }} {{ t('credentials.of') }} {{ totalPages }} ({{ localStore.leasesTotal.value }} total)</span>
          <button v-if="leasesPage > 1" class="btn-pagination" @click="loadPage(leasesPage - 1)">&larr;</button>
          <button v-if="leasesPage < totalPages" class="btn-pagination" @click="loadPage(leasesPage + 1)">&rarr;</button>
        </div>
      </div>

      <!-- TokenStore / OAuth Status Card -->
      <div class="cred-section">
        <div class="section-title">{{ t('credentials.tokenStore') }}</div>
        <div v-if="localStore.overview.value?.tokenStatus" class="tokenstore-card" :class="localStore.overview.value.tokenStatus.loggedIn ? 'ok' : 'bad'">
          <div class="tokenstore-status">
            <span class="status-dot" :class="localStore.overview.value.tokenStatus.loggedIn ? 'online' : 'offline'"></span>
            <span>{{ localStore.overview.value.tokenStatus.loggedIn ? t('credentials.connected') : t('credentials.disconnected') }}</span>
          </div>
          <div v-if="localStore.overview.value.tokenStatus.expiresAt" class="tokenstore-meta">
            Expires: {{ new Date(localStore.overview.value.tokenStatus.expiresAt).toLocaleString() }}
            <span class="dim">({{ Math.round((localStore.overview.value.tokenStatus.expiresIn || 0) / 60000) }} min)</span>
          </div>
          <div v-if="localStore.overview.value.tokenStatus.lastRefresh" class="tokenstore-meta">
            {{ t('credentials.lastRefresh') }}: {{ formatDate(localStore.overview.value.tokenStatus.lastRefresh) }} {{ formatTime(localStore.overview.value.tokenStatus.lastRefresh) }}
          </div>
          <div class="tokenstore-actions">
            <button class="btn-token" @click="refreshOAuth" :disabled="refreshing">{{ t('credentials.refresh') }}</button>
            <button class="btn-token" @click="startOAuthLogin">{{ t('credentials.reconnect') }}</button>
          </div>
        </div>
        <div v-else class="cred-loading">{{ t('state.loading') }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.credentials-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.credentials-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-sidebar);
  flex-shrink: 0;
}
.credentials-header h2 { font-size: 16px; font-weight: 700; }
.refresh-btn {
  margin-left: auto;
  padding: 4px 10px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  font-size: 14px;
  cursor: pointer;
}
.refresh-btn:hover { background: var(--bg-msg-hover); }
.refresh-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.credentials-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* Overview bar */
.cred-overview-bar { display: flex; gap: 16px; flex-wrap: wrap; }
.cred-stat-card {
  background: var(--bg-msg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 20px;
}
.cred-stat-card .stat-value { font-size: 22px; font-weight: 700; }
.cred-stat-card .stat-label { font-size: 12px; color: var(--text-dim); }
.cred-stat-card.green .stat-value { color: var(--green); }
.cred-stat-card.orange .stat-value { color: var(--orange); }

/* Sections */
.cred-section { }
.section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 10px;
}
.cred-loading, .cred-empty {
  color: var(--text-muted);
  font-size: 13px;
  padding: 12px 0;
}

/* Tables */
.cred-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.cred-table th {
  text-align: left;
  padding: 8px 12px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border);
}
.cred-table td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.cred-table tr:hover td { background: var(--bg-msg-hover); }
.agent-name { font-weight: 600; }
.dim { color: var(--text-dim); font-size: 12px; }
.lease-id { font-family: monospace; font-size: 12px; }

.status-dot {
  width: 8px; height: 8px; border-radius: 50%;
  display: inline-block; margin-right: 6px;
}
.status-dot.online { background: var(--green); }
.status-dot.offline { background: var(--text-muted); }
.status-dot.warn { background: var(--orange); }

.strategy-badge {
  padding: 2px 8px;
  border-radius: 3px;
  font-size: 11px;
  font-weight: 600;
}
.strategy-badge.patha {
  background: rgba(61,214,140,0.15);
  color: var(--green);
}
.strategy-badge.legacy {
  background: rgba(212,132,62,0.15);
  color: var(--orange);
}

.strategy-select {
  padding: 4px 8px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-size: 12px;
}

.btn-revoke {
  padding: 4px 10px;
  background: rgba(229,83,75,0.15);
  color: var(--red);
  border: 1px solid rgba(229,83,75,0.3);
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}
.btn-revoke:hover { background: rgba(229,83,75,0.25); }

/* Pagination */
.leases-pagination {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 0;
  font-size: 12px;
  color: var(--text-dim);
}
.btn-pagination {
  padding: 4px 10px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  font-size: 12px;
  cursor: pointer;
}
.btn-pagination:hover { background: var(--bg-msg-hover); }

/* TokenStore card */
.tokenstore-card {
  background: var(--bg-msg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px;
}
.tokenstore-card.ok { border-left: 3px solid var(--green); }
.tokenstore-card.bad { border-left: 3px solid var(--red); }
.tokenstore-status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 8px;
}
.tokenstore-meta {
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 4px;
}
.tokenstore-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
.btn-token {
  padding: 6px 14px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.btn-token:hover { background: var(--bg-msg-hover); border-color: var(--accent); }
.btn-token:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
