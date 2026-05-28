<script setup>
import { ref, onMounted, watch, inject } from 'vue'

const props = defineProps({
  api: { type: Function, required: true }
})

const t = inject('t')
function periodLabel(p) { return t('memory.cost.' + p) || p }

const period = ref('day')
const usage = ref(null)
const loading = ref(true)

async function loadUsage() {
  loading.value = true
  try {
    usage.value = await props.api(`/api/config/llm/usage?period=${period.value}`)
  } catch (err) {
    console.error('Failed to load usage:', err)
  } finally {
    loading.value = false
  }
}

watch(period, loadUsage)
onMounted(loadUsage)

function formatCost(cost) {
  if (cost == null) return '$0.0000'
  return '$' + Number(cost).toFixed(4)
}

function formatNumber(n) {
  if (n == null) return '0'
  return Number(n).toLocaleString()
}
</script>

<template>
  <div class="cost-monitor">
    <div class="panel-header">
      <h3>{{ t('memory.cost.title') }}</h3>
      <div class="period-tabs">
        <button
          v-for="p in ['day', 'week', 'month']"
          :key="p"
          :class="['period-tab', { active: period === p }]"
          @click="period = p"
        >{{ periodLabel(p) }}</button>
      </div>
    </div>

    <div v-if="loading" class="loading">{{ t('memory.cost.loading') }}</div>

    <div v-else-if="usage" class="cost-content">
      <!-- Summary cards -->
      <div class="cost-summary">
        <div class="cost-card">
          <div class="cost-value">{{ formatCost(usage.total_cost) }}</div>
          <div class="cost-label">{{ t('memory.cost.totalCost') }}</div>
        </div>
        <div class="cost-card">
          <div class="cost-value">{{ formatNumber(usage.total_requests) }}</div>
          <div class="cost-label">{{ t('memory.cost.totalRequests') }}</div>
        </div>
      </div>

      <!-- By Purpose -->
      <div class="cost-section">
        <h4>{{ t('memory.cost.byPurpose') }}</h4>
        <table class="cost-table">
          <thead>
            <tr>
              <th>{{ t('memory.cost.colPurpose') }}</th>
              <th>{{ t('memory.cost.colRequests') }}</th>
              <th>{{ t('memory.cost.colInputTokens') }}</th>
              <th>{{ t('memory.cost.colOutputTokens') }}</th>
              <th>{{ t('memory.cost.colCost') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in (usage.by_purpose || [])" :key="row.purpose">
              <td class="purpose-cell">{{ row.purpose }}</td>
              <td>{{ formatNumber(row.requests) }}</td>
              <td>{{ formatNumber(row.input_tokens) }}</td>
              <td>{{ formatNumber(row.output_tokens) }}</td>
              <td class="cost-cell">{{ formatCost(row.cost) }}</td>
            </tr>
            <tr v-if="!usage.by_purpose?.length">
              <td colspan="5" class="empty-cell">{{ t('memory.cost.noData') }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- By Model -->
      <div class="cost-section">
        <h4>{{ t('memory.cost.byModel') }}</h4>
        <table class="cost-table">
          <thead>
            <tr>
              <th>{{ t('memory.cost.colModel') }}</th>
              <th>{{ t('memory.cost.colRequests') }}</th>
              <th>{{ t('memory.cost.colCost') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in (usage.by_model || [])" :key="row.model">
              <td>{{ row.model }}</td>
              <td>{{ formatNumber(row.requests) }}</td>
              <td class="cost-cell">{{ formatCost(row.cost) }}</td>
            </tr>
            <tr v-if="!usage.by_model?.length">
              <td colspan="3" class="empty-cell">{{ t('memory.cost.noData') }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Daily Trend -->
      <div v-if="usage.daily_trend?.length" class="cost-section">
        <h4>{{ t('memory.cost.trend30d') }}</h4>
        <div class="trend-chart">
          <div
            v-for="day in usage.daily_trend"
            :key="day.date"
            class="trend-bar-wrapper"
            :title="`${day.date}: ${formatCost(day.cost)}`"
          >
            <div
              class="trend-bar"
              :style="{
                height: Math.max(4, (day.cost / Math.max(...usage.daily_trend.map(d => d.cost), 0.001)) * 100) + 'px'
              }"
            ></div>
            <div class="trend-date">{{ day.date.slice(5) }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cost-monitor {
  padding: 20px 24px;
  overflow-y: auto;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.panel-header h3 {
  margin: 0;
  font-size: 16px;
}

.period-tabs {
  display: flex;
  gap: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}

.period-tab {
  padding: 6px 14px;
  background: transparent;
  border: none;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 12px;
  border-right: 1px solid var(--border);
}

.period-tab:last-child {
  border-right: none;
}

.period-tab.active {
  background: var(--accent);
  color: #fff;
}

.loading {
  color: var(--text-dim);
  padding: 20px;
}

.cost-summary {
  display: flex;
  gap: 16px;
  margin-bottom: 24px;
}

.cost-card {
  background: var(--bg-sidebar);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px 24px;
}

.cost-value {
  font-size: 24px;
  font-weight: 700;
  color: var(--accent);
}

.cost-label {
  font-size: 12px;
  color: var(--text-dim);
  margin-top: 4px;
}

.cost-section {
  margin-bottom: 24px;
}

.cost-section h4 {
  margin: 0 0 12px;
  font-size: 14px;
  font-weight: 600;
}

.cost-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.cost-table th {
  text-align: left;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  color: var(--text-dim);
  font-weight: 500;
  font-size: 11px;
  text-transform: uppercase;
}

.cost-table td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}

.purpose-cell {
  text-transform: capitalize;
  font-weight: 500;
}

.cost-cell {
  font-weight: 600;
  color: var(--accent);
}

.empty-cell {
  text-align: center;
  color: var(--text-dim);
  padding: 20px;
}

.trend-chart {
  display: flex;
  gap: 3px;
  align-items: flex-end;
  height: 120px;
  padding: 8px 0;
}

.trend-bar-wrapper {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex: 1;
  min-width: 0;
}

.trend-bar {
  width: 100%;
  max-width: 20px;
  background: var(--accent);
  border-radius: 2px 2px 0 0;
  min-height: 4px;
}

.trend-date {
  font-size: 9px;
  color: var(--text-dim);
  margin-top: 4px;
  white-space: nowrap;
  overflow: hidden;
}
</style>
