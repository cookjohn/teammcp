function switchToState() {
  currentView = 'state';
  // Hide all views and overlays
  document.getElementById('messages-container').style.display = 'none';
  document.getElementById('compose').classList.remove('active');
  document.getElementById('channel-header').style.display = 'none';
  document.getElementById('pin-bar').classList.remove('active');
  document.getElementById('pinned-panel').classList.remove('active');
  document.getElementById('tasks-container').classList.remove('active');
  document.getElementById('agents-container').classList.remove('active');
  document.getElementById('credentials-container').classList.remove('active');
  document.getElementById('monitor-container').classList.remove('active');
  if (typeof stopMonitorRefresh === 'function') stopMonitorRefresh();
  closeAllOverlays();
  // Show state view
  document.getElementById('state-container').classList.add('active');
  // Update sidebar highlights
  document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('active'));
  document.getElementById('tasks-nav').classList.remove('active');
  document.getElementById('agents-nav').classList.remove('active');
  document.getElementById('credentials-nav').classList.remove('active');
  document.getElementById('monitor-nav').classList.remove('active');
  document.getElementById('state-nav').classList.add('active');
  // Load state
  const input = document.getElementById('state-project-input');
  currentProjectId = input.value.trim() || 'agent-os-mvp';
  refreshState();
}

function refreshState() {
  const input = document.getElementById('state-project-input');
  currentProjectId = input.value.trim() || 'agent-os-mvp';
  if (!currentProjectId) {
    document.getElementById('state-body').innerHTML = '<div class="state-empty"><div class="icon">&#128202;</div><div>Enter a project ID to load state</div></div>';
    return;
  }
  loadStateFields(currentProjectId);
  loadApprovals();
  loadAuditReports(currentProjectId);
  // Update last-updated timestamp
  const el = document.getElementById('state-last-updated');
  if (el) el.textContent = 'Updated ' + new Date().toLocaleTimeString();
}

function toggleStateAutoRefresh() {
  const btn = document.getElementById('state-auto-refresh-btn');
  if (stateAutoRefreshTimer) {
    clearInterval(stateAutoRefreshTimer);
    stateAutoRefreshTimer = null;
    btn.classList.remove('active');
  } else {
    stateAutoRefreshTimer = setInterval(function() {
      if (currentView === 'state') refreshState();
    }, 15000);
    btn.classList.add('active');
  }
}

// ── Channel Files Panel ─────────────────────────────────────
function toggleChannelFiles() {
  const panel = document.getElementById('channel-files-panel');
  if (panel.classList.contains('active')) {
    panel.classList.remove('active');
  } else {
    panel.classList.add('active');
    loadChannelFiles();
  }
}

function formatFileSize(bytes) {
  if (bytes == null || isNaN(bytes)) return '—';
  bytes = Number(bytes);
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

function getFileIcon(mimeType) {
  if (!mimeType) return '&#128196;';
  if (mimeType.startsWith('image/')) return '&#128247;';
  if (mimeType.startsWith('video/')) return '&#127909;';
  if (mimeType.startsWith('audio/')) return '&#127925;';
  if (mimeType.includes('pdf')) return '&#128213;';
  if (mimeType.includes('zip') || mimeType.includes('tar') || mimeType.includes('compressed')) return '&#128230;';
  if (mimeType.includes('json') || mimeType.includes('javascript') || mimeType.includes('xml')) return '&#128187;';
  return '&#128196;';
}

async function loadChannelFiles() {
  var panel = document.getElementById('channel-files-panel');
  if (!panel || !currentChannel) return;
  panel.innerHTML = '<div class="files-loading"><div class="files-spinner"></div> Loading...</div>';
  try {
    var folderUrl = '/api/folders?channel=' + encodeURIComponent(currentChannel) + '&parent_id=' + (currentFolderId || '');
    var fileUrl = '/api/files?limit=50&channel=' + encodeURIComponent(currentChannel) + '&folder_id=' + (currentFolderId || 'root');
    var results = await Promise.all([
      api(folderUrl).catch(function() { return []; }),
      api(fileUrl)
    ]);
    channelFolders = Array.isArray(results[0]) ? results[0] : (results[0].folders || []);
    channelFiles = Array.isArray(results[1]) ? results[1] : (results[1].files || []);
    renderChannelFiles();
  } catch (e) {
    console.error('Failed to load channel files:', e);
    panel.innerHTML = '<div class="files-empty"><div class="icon">&#9888;</div><div>Failed to load files</div></div>';
  }
}

function openFolder(folderId, folderName) {
  currentFolderPath.push({ id: folderId, name: folderName });
  currentFolderId = folderId;
  loadChannelFiles();
}

function navigateToFolder(index) {
  if (index === -1) {
    currentFolderId = null;
    currentFolderPath = [];
  } else {
    currentFolderPath = currentFolderPath.slice(0, index + 1);
    currentFolderId = currentFolderPath[index].id;
  }
  loadChannelFiles();
}

async function createFolder() {
  var name = prompt('New folder name:');
  if (!name) return;
  name = name.trim();
  if (name.length === 0 || name.length > 100) {
    alert('Folder name must be 1-100 characters.');
    return;
  }
  if (!/^[a-zA-Z0-9 _\-\.\u4e00-\u9fff]+$/.test(name)) {
    alert('Folder name contains invalid characters.');
    return;
  }
  try {
    await fetch('/api/folders', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, parent_id: currentFolderId, channel: currentChannel })
    });
    loadChannelFiles();
  } catch (e) {
    alert('Failed to create folder: ' + e.message);
  }
}

async function renameFolder(folderId) {
  var name = prompt('New folder name:');
  if (!name) return;
  name = name.trim();
  if (name.length === 0 || name.length > 100) {
    alert('Folder name must be 1-100 characters.');
    return;
  }
  try {
    await fetch('/api/folders/' + encodeURIComponent(folderId), {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name })
    });
    loadChannelFiles();
  } catch (e) {
    alert('Failed to rename folder: ' + e.message);
  }
}

async function deleteFolder(folderId, folderName) {
  if (!confirm('Delete folder "' + folderName + '"? Files inside will be moved to root.')) return;
  try {
    await fetch('/api/folders/' + encodeURIComponent(folderId), {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + API_KEY }
    });
    loadChannelFiles();
  } catch (e) {
    alert('Failed to delete folder: ' + e.message);
  }
}

function renderChannelFiles() {
  var panel = document.getElementById('channel-files-panel');
  if (!panel) return;

  var html = '';

  // Breadcrumb navigation
  html += '<div class="files-breadcrumb">';
  if (currentFolderPath.length === 0) {
    html += '<span class="files-breadcrumb-current">root</span>';
  } else {
    html += '<span class="files-breadcrumb-item" onclick="navigateToFolder(-1)">root</span>';
    for (var bi = 0; bi < currentFolderPath.length; bi++) {
      html += '<span class="files-breadcrumb-separator">/</span>';
      if (bi === currentFolderPath.length - 1) {
        html += '<span class="files-breadcrumb-current">' + escapeHtml(currentFolderPath[bi].name) + '</span>';
      } else {
        html += '<span class="files-breadcrumb-item" onclick="navigateToFolder(' + bi + ')">' + escapeHtml(currentFolderPath[bi].name) + '</span>';
      }
    }
  }
  html += '<button class="files-new-folder-btn" onclick="createFolder()">+ New Folder</button>';
  html += '</div>';

  // Folder list
  if (channelFolders && channelFolders.length > 0) {
    for (var fi = 0; fi < channelFolders.length; fi++) {
      var folder = channelFolders[fi];
      var fName = escapeHtml(folder.name || 'Unnamed');
      var fId = escapeHtml(folder.id);
      html += '<div class="folder-item" onclick="openFolder(\'' + fId + '\', \'' + fName.replace(/'/g, "\\'") + '\')">';
      html += '<span class="folder-icon">&#128193;</span>';
      html += '<span class="folder-name">' + fName + '</span>';
      html += '<span class="folder-actions">';
      html += '<button class="folder-action-btn" onclick="event.stopPropagation(); renameFolder(\'' + fId + '\')" title="Rename">&#9998;</button>';
      html += '<button class="folder-action-btn delete" onclick="event.stopPropagation(); deleteFolder(\'' + fId + '\', \'' + fName.replace(/'/g, "\\'") + '\')" title="Delete">&#128465;</button>';
      html += '</span>';
      html += '</div>';
    }
  }

  // File list
  if (channelFiles && channelFiles.length > 0) {
    for (var i = 0; i < channelFiles.length; i++) {
      var file = channelFiles[i];
      var icon = getFileIcon(file.mime_type);
      var name = escapeHtml(file.original_name || 'Unnamed file');
      var size = formatFileSize(file.size);
      var uploader = file.uploaded_by ? escapeHtml(file.uploaded_by) : '';
      var time = file.created_at ? formatTime(file.created_at) : '';
      var date = file.created_at ? formatDate(file.created_at) : '';
      var downloadUrl = '/api/files/' + encodeURIComponent(file.id);
      html += '<div class="file-item">';
      html += '<span class="file-icon">' + icon + '</span>';
      html += '<div class="file-info">';
      html += '<a class="file-name" href="' + escapeHtml(downloadUrl) + '" download title="' + name + '">' + name + '</a>';
      html += '<div class="file-meta">';
      html += '<span class="file-size">' + escapeHtml(size) + '</span>';
      if (uploader) html += '<span class="file-uploader">' + uploader + '</span>';
      html += '<span class="file-time">' + escapeHtml(date + ' ' + time) + '</span>';
      html += '</div></div></div>';
    }
  }

  // Empty state
  if ((!channelFolders || channelFolders.length === 0) && (!channelFiles || channelFiles.length === 0)) {
    html += '<div class="files-empty"><div class="icon">&#128193;</div><div>No files or folders yet</div></div>';
  }

  panel.innerHTML = html;
}

function getValueStatusColor(value) {
  if (!value) return '';
  var v = String(value).toLowerCase().trim();
  // Green statuses
  if (['running', 'active', 'online', 'healthy', 'ok', 'success', 'completed', 'done', 'ready', 'true', 'yes', 'enabled', 'up'].indexOf(v) !== -1) return 'green';
  // Red statuses
  if (['error', 'failed', 'offline', 'down', 'critical', 'false', 'no', 'disabled', 'stopped', 'crashed'].indexOf(v) !== -1) return 'red';
  // Orange statuses
  if (['warning', 'pending', 'waiting', 'queued', 'paused', 'blocked', 'review'].indexOf(v) !== -1) return 'orange';
  // Blue statuses
  if (['in_progress', 'in-progress', 'building', 'deploying', 'processing', 'syncing', 'loading'].indexOf(v) !== -1) return 'blue';
  // Yellow
  if (['draft', 'wip', 'todo', 'planning', 'scheduled'].indexOf(v) !== -1) return 'yellow';
  return '';
}

async function loadStateFields(projectId) {
  try {
    const data = await api('/api/state?project_id=' + encodeURIComponent(projectId));
    stateFields = data.items || [];
    renderStateView();
    // Load recent change log for all fields
    loadRecentChangeLog(projectId);
  } catch (e) {
    console.error('Failed to load state fields:', e);
    document.getElementById('state-body').innerHTML = '<div class="state-empty"><div class="icon">&#9888;</div><div>Failed to load state: ' + escapeHtml(e.message) + '</div></div>';
  }
}

function renderStateView() {
  const body = document.getElementById('state-body');
  let html = '';

  // Summary stats bar
  if (stateFields.length > 0) {
    const owners = new Set(stateFields.map(function(f){ return f.owner; }).filter(Boolean));
    const latestUpdate = stateFields.reduce(function(latest, f) {
      return f.updated_at && (!latest || f.updated_at > latest) ? f.updated_at : latest;
    }, null);
    const approvalCount = stateFields.filter(function(f){ return f.approval_required; }).length;

    html += '<div class="state-summary-bar">';
    html += '<div class="state-summary-stat accent"><div class="stat-value">' + stateFields.length + '</div><div class="stat-label">Total Fields</div></div>';
    html += '<div class="state-summary-stat green"><div class="stat-value">' + owners.size + '</div><div class="stat-label">Active Owners</div></div>';
    if (approvalCount > 0) {
      html += '<div class="state-summary-stat orange"><div class="stat-value">' + approvalCount + '</div><div class="stat-label">Need Approval</div></div>';
    }
    if (latestUpdate) {
      html += '<div class="state-summary-stat"><div class="stat-value" style="font-size:14px">' + escapeHtml(formatDate(latestUpdate) + ' ' + formatTime(latestUpdate)) + '</div><div class="stat-label">Last Updated</div></div>';
    }
    html += '</div>';
  }

  // Fields section
  html += '<div class="state-fields-section">';
  html += '<div class="state-section-title">State Fields</div>';
  if (stateFields.length === 0) {
    html += '<div class="state-empty"><div class="icon">&#128202;</div><div>No state fields found for this project</div></div>';
  } else {
    html += '<div class="state-fields-grid">';
    html += renderStateFields(stateFields);
    html += '</div>';
  }
  html += '</div>';

  // Approvals section
  html += '<div class="state-approvals-section" id="state-approvals-container">';
  html += renderApprovals(stateApprovals);
  html += '</div>';

  // Audit Reports section
  html += '<div class="audit-reports-section" id="audit-reports-container">';
  html += renderAuditReports(auditReports, auditFilterType);
  html += '</div>';

  // Timeline section
  html += '<div class="state-timeline-section">';
  html += '<div class="state-section-title">&#128220; Recent Changes</div>';
  html += '<div id="state-changelog-container">';
  html += '<div style="color:var(--text-muted);font-size:13px;">Loading...</div>';
  html += '</div>';
  html += '</div>';

  body.innerHTML = html;
}

function renderStateFields(fields) {
  let html = '';
  for (const field of fields) {
    const valueTruncated = truncateValue(field.value, 100);
    const ownerHtml = field.owner ? '<span class="state-field-owner"><span class="agent-dot online" style="width:6px;height:6px;background:' + agentColor(field.owner) + '"></span>' + escapeHtml(field.owner) + '</span>' : '';
    const versionHtml = '<span class="state-field-version">v' + (field.version || 1) + '</span>';
    const timeHtml = field.updated_at ? '<span class="state-field-time">' + formatTime(field.updated_at) + '</span>' : '';
    const approvalHtml = field.approval_required ? '<span class="state-field-approval-badge">approval required</span>' : '';
    const statusColor = getValueStatusColor(field.value);
    const statusAttr = statusColor ? ' data-status-color="' + statusColor + '"' : '';
    const statusPill = statusColor ? '<span class="state-value-status ' + statusColor + '">' + escapeHtml(String(field.value).trim()) + '</span>' : '';

    html += '<div class="state-field-card"' + statusAttr + ' onclick="showFieldDetail(\'' + escapeHtml(currentProjectId) + '\', \'' + escapeHtml(field.field) + '\')">';
    html += '<div class="state-field-name">' + escapeHtml(field.field) + ' ' + approvalHtml + '</div>';
    if (statusPill) {
      html += statusPill;
    }
    html += '<div class="state-field-value">' + escapeHtml(valueTruncated) + '</div>';
    html += '<div class="state-field-meta">' + ownerHtml + versionHtml + timeHtml + '</div>';
    html += '</div>';
  }
  return html;
}

function truncateValue(value, maxLen) {
  if (!value) return '(empty)';
  let display = value;
  // Try to parse JSON for nice display
  try {
    const parsed = JSON.parse(value);
    display = JSON.stringify(parsed, null, 2);
  } catch {
    display = value;
  }
  if (display.length > maxLen) {
    return display.slice(0, maxLen) + '...';
  }
  return display;
}

async function loadRecentChangeLog(projectId) {
  try {
    // Load change log for all fields (fetch history for each field, or if no specific field, get general)
    // We'll try loading history without a field param first; if that fails, load per-field
    let allEntries = [];
    for (const field of stateFields.slice(0, 10)) { // limit to first 10 fields
      try {
        const entries = await api('/api/state/history?project_id=' + encodeURIComponent(projectId) + '&field=' + encodeURIComponent(field.field) + '&limit=5');
        if (Array.isArray(entries)) {
          allEntries = allEntries.concat(entries);
        }
      } catch {}
    }
    // Sort by timestamp descending
    allEntries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    stateChangeLog = allEntries.slice(0, 20);
    const container = document.getElementById('state-changelog-container');
    if (container) {
      container.innerHTML = renderChangeLog(stateChangeLog);
    }
  } catch (e) {
    console.error('Failed to load change log:', e);
    const container = document.getElementById('state-changelog-container');
    if (container) {
      container.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">Failed to load change log</div>';
    }
  }
}

function renderChangeLog(entries) {
  if (!entries || entries.length === 0) {
    return '<div style="color:var(--text-muted);font-size:13px;">No recent changes</div>';
  }
  let html = '<div class="state-timeline">';
  for (const entry of entries) {
    const isCreate = !entry.old_value;
    const actionText = isCreate ? 'created' : 'changed';
    html += '<div class="state-timeline-entry">';
    html += '<div><span class="state-timeline-field">' + escapeHtml(entry.field) + '</span> ';
    html += '<span class="state-timeline-action">' + actionText + ' by </span>';
    html += '<span class="state-timeline-by" style="color:' + agentColor(entry.changed_by || 'unknown') + '">' + escapeHtml(entry.changed_by || 'unknown') + '</span>';
    html += ' <span class="state-field-version">v' + (entry.version || '?') + '</span>';
    html += '</div>';
    if (!isCreate && entry.old_value) {
      html += '<div class="state-timeline-values">';
      html += '<span class="state-timeline-old">' + escapeHtml(truncateValue(entry.old_value, 40)) + '</span>';
      html += '<span class="state-timeline-arrow">&rarr;</span>';
      html += '<span class="state-timeline-new">' + escapeHtml(truncateValue(entry.new_value, 40)) + '</span>';
      html += '</div>';
    } else if (isCreate) {
      html += '<div class="state-timeline-values">';
      html += '<span class="state-timeline-new">' + escapeHtml(truncateValue(entry.new_value, 60)) + '</span>';
      html += '</div>';
    }
    if (entry.reason) {
      html += '<div class="state-timeline-reason">' + escapeHtml(entry.reason) + '</div>';
    }
    html += '<div class="state-timeline-time">' + escapeHtml(entry.timestamp ? formatDate(entry.timestamp) + ' ' + formatTime(entry.timestamp) : '') + '</div>';
    html += '</div>';
  }
  html += '</div>';
  return html;
}

async function loadApprovals() {
  try {
    const data = await api('/api/state/approvals');
    stateApprovals = Array.isArray(data) ? data : (data.items || []);
    const container = document.getElementById('state-approvals-container');
    if (container) {
      container.innerHTML = renderApprovals(stateApprovals);
    }
  } catch (e) {
    console.error('Failed to load approvals:', e);
    stateApprovals = [];
  }
}

function renderApprovals(approvals) {
  if (!approvals || approvals.length === 0) return '';
  let html = '<div class="state-section-title">&#128203; Pending Approvals</div>';
  for (const a of approvals) {
    html += '<div class="state-approval-card">';
    html += '<div class="state-approval-body">';
    html += '<div class="state-approval-field">' + escapeHtml(a.field || a.key || '') + '</div>';
    html += '<div class="state-approval-meta">Requested by <strong>' + escapeHtml(a.updated_by || a.requested_by || 'unknown') + '</strong>';
    if (a.project_id) html += ' in <em>' + escapeHtml(a.project_id) + '</em>';
    html += '</div>';
    if (a.new_value || a.value) {
      html += '<div class="state-approval-value">' + escapeHtml(truncateValue(a.new_value || a.value, 120)) + '</div>';
    }
    html += '<div class="state-approval-actions">';
    html += '<button class="state-approve-btn" onclick="resolveApprovalAction(\'' + (a.id || '') + '\', true)">&#10003; Approve</button>';
    html += '<button class="state-reject-btn" onclick="resolveApprovalAction(\'' + (a.id || '') + '\', false)">&#10007; Reject</button>';
    html += '</div>';
    html += '</div>';
    html += '</div>';
  }
  return html;
}

async function resolveApprovalAction(id, approved) {
  if (!id) return;
  try {
    const res = await fetch('/api/state/approvals/' + encodeURIComponent(id) + '/resolve', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ approved: approved })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Resolve failed: ' + res.status);
    }
    // Refresh
    loadApprovals();
    loadStateFields(currentProjectId);
  } catch (e) {
    console.error('Failed to resolve approval:', e);
    alert('Failed to resolve approval: ' + e.message);
  }
}

// ── Audit Reports ──────────────────────────────────────────
async function loadAuditReports(projectId) {
  try {
    const data = await api('/api/reports/public?project_id=' + encodeURIComponent(projectId) + '&limit=20');
    auditReports = Array.isArray(data) ? data : [];
    const container = document.getElementById('audit-reports-container');
    if (container) {
      container.innerHTML = renderAuditReports(auditReports, auditFilterType);
    }
  } catch (e) {
    console.error('Failed to load audit reports:', e);
    auditReports = [];
    const container = document.getElementById('audit-reports-container');
    if (container) {
      container.innerHTML = '';
    }
  }
}

function renderAuditReports(reports, filterType) {
  if (!reports || reports.length === 0) return '';
  const filtered = filterType === 'all' ? reports : reports.filter(r => r.report_type === filterType);

  let html = '<div class="state-section-title">&#128209; Audit Reports</div>';

  // Efficiency metrics panel (always show if we have efficiency reports)
  html += renderEfficiencyMetrics(reports);

  // Tabs
  html += '<div class="audit-report-tabs">';
  const tabs = ['all', 'compliance', 'efficiency', 'anomaly'];
  const tabLabels = { all: 'All', compliance: 'Compliance', efficiency: 'Efficiency', anomaly: 'Anomaly' };
  for (const t of tabs) {
    const activeClass = t === filterType ? ' active' : '';
    html += '<button class="audit-report-tab' + activeClass + '" onclick="filterAuditReports(\'' + t + '\')">' + tabLabels[t] + '</button>';
  }
  html += '</div>';

  // Report cards
  if (filtered.length === 0) {
    html += '<div style="color:var(--text-muted);font-size:13px;padding:12px 0;">No ' + (filterType === 'all' ? '' : filterType + ' ') + 'reports found</div>';
  } else {
    for (const report of filtered) {
      const badgeClass = report.report_type || 'compliance';
      const timeStr = report.generated_at ? formatDate(report.generated_at) + ' ' + formatTime(report.generated_at) : '';
      const summary = getReportSummary(report);

      html += '<div class="audit-report-card">';
      html += '<div class="audit-report-card-header">';
      html += '<span class="report-type-badge ' + escapeHtml(badgeClass) + '">' + escapeHtml(report.report_type || 'unknown') + '</span>';
      html += '<span class="audit-report-card-time">' + escapeHtml(timeStr) + '</span>';
      if (report.generated_by) {
        html += '<span class="audit-report-card-by">by ' + escapeHtml(report.generated_by) + '</span>';
      }
      html += '</div>';
      html += '<div class="audit-report-card-summary">' + escapeHtml(summary) + '</div>';
      html += '</div>';
    }
  }
  return html;
}

function getReportSummary(report) {
  try {
    const content = typeof report.content === 'string' ? JSON.parse(report.content) : report.content;
    if (!content) return '(no content)';

    if (report.report_type === 'compliance') {
      const findings = content.findings || content.issues || [];
      const count = Array.isArray(findings) ? findings.length : 0;
      const status = content.status || content.result || '';
      return (status ? status + ' - ' : '') + count + ' finding(s)' + (content.summary ? ': ' + content.summary : '');
    }

    if (report.report_type === 'efficiency') {
      const parts = [];
      if (content.avg_resolution_time != null) parts.push('Avg resolution: ' + content.avg_resolution_time);
      if (content.total_changes != null) parts.push('Total changes: ' + content.total_changes);
      if (content.high_frequency_fields && content.high_frequency_fields.length > 0) {
        parts.push('Hot fields: ' + content.high_frequency_fields.slice(0, 3).join(', '));
      }
      return parts.length > 0 ? parts.join(' | ') : (content.summary || JSON.stringify(content).slice(0, 150));
    }

    if (report.report_type === 'anomaly') {
      const anomalies = content.anomalies || content.items || [];
      const count = Array.isArray(anomalies) ? anomalies.length : 0;
      return count + ' anomaly(ies) detected' + (content.summary ? ': ' + content.summary : '');
    }

    return content.summary || JSON.stringify(content).slice(0, 150);
  } catch (e) {
    // content is not valid JSON, return as-is truncated
    const raw = String(report.content || '');
    return raw.length > 150 ? raw.slice(0, 150) + '...' : raw;
  }
}

function renderEfficiencyMetrics(reports) {
  const efficiencyReports = reports.filter(r => r.report_type === 'efficiency');
  if (efficiencyReports.length === 0) return '';

  let avgResolution = '-';
  let hotFields = '-';
  let totalChanges = '-';

  // Aggregate from the most recent efficiency report
  for (const report of efficiencyReports) {
    try {
      const content = typeof report.content === 'string' ? JSON.parse(report.content) : report.content;
      if (!content) continue;
      if (content.avg_resolution_time != null && avgResolution === '-') {
        avgResolution = String(content.avg_resolution_time);
      }
      if (content.high_frequency_fields && content.high_frequency_fields.length > 0 && hotFields === '-') {
        hotFields = content.high_frequency_fields.slice(0, 3).join(', ');
      }
      if (content.total_changes != null && totalChanges === '-') {
        totalChanges = String(content.total_changes);
      }
    } catch (e) {
      // skip unparseable
    }
  }

  // Only render if we found at least one metric
  if (avgResolution === '-' && hotFields === '-' && totalChanges === '-') return '';

  let html = '<div class="efficiency-metrics">';
  html += '<div class="metric-card"><div class="metric-card-value">' + escapeHtml(avgResolution) + '</div><div class="metric-card-label">Avg Approval Resolution</div></div>';
  html += '<div class="metric-card"><div class="metric-card-value">' + escapeHtml(totalChanges) + '</div><div class="metric-card-label">Total State Changes</div></div>';
  html += '<div class="metric-card"><div class="metric-card-value" style="font-size:14px;">' + escapeHtml(hotFields) + '</div><div class="metric-card-label">High Frequency Fields</div></div>';
  html += '</div>';
  return html;
}

function filterAuditReports(type) {
  auditFilterType = type;
  const container = document.getElementById('audit-reports-container');
  if (container) {
    container.innerHTML = renderAuditReports(auditReports, auditFilterType);
  }
}

async function showFieldDetail(projectId, field) {
  try {
    // Load field data
    const data = await api('/api/state?project_id=' + encodeURIComponent(projectId) + '&field=' + encodeURIComponent(field));
    const fieldData = data.items ? data.items[0] : data;
    if (!fieldData) return;

    // Load history for this field
    let history = [];
    try {
      const histData = await api('/api/state/history?project_id=' + encodeURIComponent(projectId) + '&field=' + encodeURIComponent(field) + '&limit=20');
      history = Array.isArray(histData) ? histData : (histData.items || []);
    } catch {}

    let html = '';

    // Field name
    html += '<div class="state-detail-field">';
    html += '<div class="state-detail-label">Field</div>';
    html += '<div class="state-detail-value" style="font-weight:700;color:var(--accent)">' + escapeHtml(fieldData.field) + '</div>';
    html += '</div>';

    // Full value
    html += '<div class="state-detail-field">';
    html += '<div class="state-detail-label">Value</div>';
    let displayValue = fieldData.value || '(empty)';
    try {
      const parsed = JSON.parse(displayValue);
      displayValue = JSON.stringify(parsed, null, 2);
    } catch {}
    html += '<div class="state-detail-full-value">' + escapeHtml(displayValue) + '</div>';
    html += '</div>';

    // Owner
    html += '<div class="state-detail-field">';
    html += '<div class="state-detail-label">Owner</div>';
    html += '<div class="state-detail-value">' + escapeHtml(fieldData.owner || 'None') + '</div>';
    html += '</div>';

    // Version
    html += '<div class="state-detail-field">';
    html += '<div class="state-detail-label">Version</div>';
    html += '<div class="state-detail-value"><span class="state-field-version">v' + (fieldData.version || 1) + '</span></div>';
    html += '</div>';

    // Approval required
    if (fieldData.approval_required) {
      html += '<div class="state-detail-field">';
      html += '<div class="state-detail-label">Approval</div>';
      html += '<div class="state-detail-value"><span class="state-field-approval-badge">approval required</span></div>';
      html += '</div>';
    }

    // Subscribers
    if (fieldData.subscribers && fieldData.subscribers.length > 0) {
      const subs = Array.isArray(fieldData.subscribers) ? fieldData.subscribers : JSON.parse(fieldData.subscribers || '[]');
      if (subs.length > 0) {
        html += '<div class="state-detail-field">';
        html += '<div class="state-detail-label">Subscribers</div>';
        html += '<div class="state-detail-value">' + escapeHtml(subs.join(', ')) + '</div>';
        html += '</div>';
      }
    }

    // Updated by / at
    html += '<div class="state-detail-field">';
    html += '<div class="state-detail-label">Last Updated</div>';
    html += '<div class="state-detail-value" style="font-size:12px;color:var(--text-dim)">';
    html += escapeHtml(fieldData.updated_by || '') + ' &middot; ' + escapeHtml(fieldData.updated_at || '');
    html += '</div>';
    html += '</div>';

    // Change history
    if (history.length > 0) {
      html += '<div class="state-detail-field">';
      html += '<div class="state-detail-label">Change History</div>';
      html += renderChangeLog(history);
      html += '</div>';
    }

    document.getElementById('state-detail-body').innerHTML = html;
    document.getElementById('state-field-detail').classList.add('active');
  } catch (e) {
    console.error('Failed to load field detail:', e);
    alert('Failed to load field detail: ' + e.message);
  }
}

function closeFieldDetail() {
  document.getElementById('state-field-detail').classList.remove('active');
}

// ── Channel Members Panel ─────────────────────────────
async function openMembersPanel() {
  if (!currentChannel) return;
  const panel = document.getElementById('channel-members-panel');
  const titleEl = document.getElementById('channel-members-title');
  const ch = channels.find(c => c.id === currentChannel);
  const searchInput = document.getElementById('members-search');
  if (searchInput) searchInput.value = '';
  // Show add-member form only for Chairman or CEO
  const addForm = document.getElementById('add-member-form');
  addForm.style.display = (agentName === 'Chairman' || agentName === 'CEO') ? 'flex' : 'none';
  try {
    const data = await api('/api/channels/' + encodeURIComponent(currentChannel) + '/members');
    const currentMembers = data.members || [];
    renderMembers(currentMembers);
    titleEl.textContent = (ch ? (ch.name || ch.id) : '') + ' ' + i18n.t('members.title') + ' (' + currentMembers.length + ')';
    // Populate add-member dropdown with agents not already in channel
    const select = document.getElementById('add-member-select');
    const available = agents.filter(a => !currentMembers.includes(a.name)).sort((a, b) => a.name.localeCompare(b.name));
    select.innerHTML = '<option value="" disabled selected>Add member...</option>' + available.map(a => `<option value="${escapeHtml(a.name)}">${escapeHtml(a.name)}</option>`).join('');
  } catch (e) {
    document.getElementById('channel-members-list').innerHTML = '<div style="color:var(--text-dim);padding:12px;">Failed to load members</div>';
  }
  panel.classList.add('visible');
}

