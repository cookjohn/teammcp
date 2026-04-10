/**
 * Utility functions extracted from the existing dashboard app.js
 */

const COLORS = [
  '#5b7ff5', '#e5534b', '#3dd68c', '#d4843e', '#c9b44a',
  '#a371f7', '#e07cda', '#39c5cf', '#6cb6ff', '#57ab5a'
]

/**
 * Escape HTML special characters to prevent XSS
 */
export function escapeHtml(str) {
  if (!str) return ''
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }
  return str.replace(/[&<>"']/g, c => map[c])
}

/**
 * Format ISO date string to HH:MM time
 */
export function formatTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
}

/**
 * Format ISO date string to readable date (Today, Yesterday, or MMM DD, YYYY)
 */
export function formatDate(iso, t = (k) => k) {
  if (!iso) return ''
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)

  if (d.toDateString() === today.toDateString()) return t('general.today') || 'Today'
  if (d.toDateString() === yesterday.toDateString()) return t('general.yesterday') || 'Yesterday'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/**
 * Format bytes to human-readable file size
 */
export function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i]
}

/**
 * Get a deterministic color for an agent name
 */
export function agentColor(name) {
  if (!name) return COLORS[0]
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
  return COLORS[Math.abs(hash) % COLORS.length]
}

/**
 * Get the uppercase initial of an agent name
 */
export function agentInitial(name) {
  if (!name) return '?'
  return name.charAt(0).toUpperCase()
}
