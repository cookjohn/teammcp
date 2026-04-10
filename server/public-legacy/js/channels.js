function renderChannels() {
  const list = document.getElementById('channel-list');
  // Separate by type
  const groups = channels.filter(c => c.type === 'group');
  const dms = channels.filter(c => c.type === 'dm');
  const topics = channels.filter(c => c.type === 'topic');

  let html = '';
  for (const ch of [...groups, ...topics, ...dms]) {
    const icon = ch.type === 'dm' ? '&#9993;' : ch.type === 'topic' ? '&#9733;' : '#';
    const active = ch.id === currentChannel ? 'active' : '';
    const unread = ch.unread > 0 ? `<span class="unread-badge">${ch.unread > 99 ? '99+' : ch.unread}</span>` : '';
    const displayName = ch.type === 'dm' ? ch.name.replace('DM ', '').replace(' ↔ ', ' / ') : (ch.name || ch.id);
    html += `<li class="channel-item ${active}" data-id="${ch.id}" onclick="selectChannel('${ch.id}')">
      <span class="channel-icon">${icon}</span>
      <span class="channel-name">${escapeHtml(displayName)}</span>
      ${unread}
    </li>`;
  }
  list.innerHTML = html;
}

async function selectChannel(channelId) {
  if (loading) return;
  switchToMessages();
  currentChannel = channelId;
  currentFolderId = null;
  currentFolderPath = [];
  channelFolders = [];
  const ch = channels.find(c => c.id === channelId);

  // Update header
  const icon = ch?.type === 'dm' ? '&#9993;' : ch?.type === 'topic' ? '&#9733;' : '#';
  document.getElementById('ch-icon').innerHTML = icon;
  document.getElementById('ch-name').textContent = ch?.name || channelId;
  document.getElementById('ch-desc').textContent = ch?.description || '';
  document.getElementById('members-btn').style.display = ch?.type === 'dm' ? 'none' : '';
  document.getElementById('files-btn').style.display = ch?.type === 'dm' ? 'none' : '';
  document.getElementById('channel-files-panel').classList.remove('active');

  // Highlight active channel
  document.querySelectorAll('.channel-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === channelId);
  });

  // Clear unread for this channel locally
  if (ch) ch.unread = 0;
  renderChannels();

  // Load messages and pins
  await loadMessages(channelId);
  await loadPins(channelId);
  // Re-render to show pin badges
  renderMessages(true);

  // Mark channel as read on the server (persist read status)
  markChannelRead(channelId);

  // Reset pinned panel
  pinnedPanelOpen = false;
  document.getElementById('pinned-panel').classList.remove('active');

  // Hide new message indicator when switching channels
  hideNewMessageIndicator();

  // Show compose area
  updateComposeUI();

  // Load channel members for @ mention dropdown
  channelMembers = [];
  try {
    const membersData = await api('/api/channels/' + encodeURIComponent(channelId) + '/members');
    channelMembers = membersData.members || [];
  } catch (e) {
    // Fallback to all agents if members API fails
    channelMembers = agents.map(a => a.name);
  }
}

// Mark a channel as read by acking the last message
async function markChannelRead(channelId) {
  try {
    if (messages.length === 0) return;
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || !lastMsg.id) return;
    await fetch('/api/inbox/ack', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        items: [{ channel: channelId, ack_id: lastMsg.id }]
      })
    });
  } catch (e) {
    // Silently fail - read status is not critical
  }
}

async function loadMessages(channelId, before) {
  loading = true;
  try {
    let url = `/api/history?channel=${encodeURIComponent(channelId)}&limit=50`;
    if (before) url += `&before=${encodeURIComponent(before)}`;
    const data = await api(url);
    if (before) {
      messages = [...data.messages, ...messages];
    } else {
      messages = data.messages;
    }
    hasMore = data.hasMore;
    renderMessages(!before); // scroll to bottom only on initial load
    // Mark channel as read (update read_status for unread count)
    if (!before && messages.length > 0) {
      const lastMsgId = messages[messages.length - 1].id;
      fetch('/api/inbox/ack', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ channel: channelId, ack_id: lastMsgId }] })
      }).then(() => refreshChannels()).catch(() => {});
    }
  } catch (e) {
    console.error('Failed to load messages:', e);
  }
  loading = false;
}

// ── Messages ─────────────────────────────────────────────
function renderMessages(scrollToBottom) {
  const container = document.getElementById('messages-container');
  if (messages.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="icon">&#128172;</div><div>No messages yet</div></div>';
    return;
  }

  let html = '';

  // Load more button
  if (hasMore) {
    html += '<div class="load-more-bar"><button class="load-more-btn" onclick="loadOlder()">Load older messages</button></div>';
  }

  let lastDate = '';
  for (const msg of messages) {
    const date = formatDate(msg.created_at);
    if (date !== lastDate) {
      html += `<div class="date-separator">${date}</div>`;
      lastDate = date;
    }
    html += renderMessage(msg);
  }

  container.innerHTML = html;

  if (scrollToBottom) {
    container.scrollTop = container.scrollHeight;
  }
}

function renderMessage(msg) {
  const color = agentColor(msg.from_agent);
  const time = formatTime(msg.created_at);
  const edited = msg.edited_at ? '<span class="msg-edited">(edited)</span>' : '';
  const content = renderMarkdown(msg.content);

  let replyHtml = '';
  if (msg.reply_to) {
    const parent = messages.find(m => m.id === msg.reply_to);
    if (parent) {
      replyHtml = `<div class="msg-reply-indicator">Replying to <strong>${escapeHtml(parent.from_agent)}</strong></div>`;
    }
  }

  // Long message collapse: check if > 15 lines or > 800 chars
  const lineCount = (msg.content || '').split('\n').length;
  const charCount = (msg.content || '').length;
  const shouldCollapse = lineCount > 15 || charCount > 800;
  const collapsedClass = shouldCollapse ? ' collapsed' : '';
  const fadeHtml = shouldCollapse ? '<div class="msg-fade"></div>' : '';
  const toggleHtml = shouldCollapse ? `<button class="msg-toggle" onclick="toggleMsgCollapse(this, event)">Show more</button>` : '';

  // Reactions HTML
  const reactionsHtml = renderReactions(msg);

  // Pin badge
  const pinBadge = (pinnedMsgIds && pinnedMsgIds.has(msg.id)) ? '<span class="msg-pinned-badge">&#128204; pinned</span>' : '';

  // Pin action button
  const isPinnedMsg = pinnedMsgIds && pinnedMsgIds.has(msg.id);
  const pinBtn = isPinnedMsg
    ? `<button class="pin-action-btn" onclick="unpinMsg('${msg.id}', event)" title="Unpin">&#128204;</button>`
    : `<button class="pin-action-btn" onclick="pinMsg('${msg.id}', event)" title="Pin">&#128204;</button>`;

  // Dashboard (chairman) message badge
  let meta = {};
  try { meta = typeof msg.metadata === 'string' ? JSON.parse(msg.metadata) : (msg.metadata || {}); } catch {}
  const isDashboard = meta.source === 'dashboard';
  const isDisplayOnly = meta.source === 'display_only';
  const isWechat = meta.source === 'wechat';
  const chairmanBadge = isDashboard ? '<span style="background:var(--orange);color:#fff;font-size:10px;padding:1px 5px;border-radius:3px;margin-left:4px;">Chairman</span>' : '';
  const displayOnlyBadge = isDisplayOnly ? '<span style="background:var(--text-muted);color:#fff;font-size:10px;padding:1px 5px;border-radius:3px;margin-left:4px;">Output</span>' : '';
  const wechatBadge = isWechat ? '<span style="background:#07C160;color:#fff;font-size:10px;padding:1px 5px;border-radius:3px;margin-left:4px;">WeChat</span>' : '';

  return `<div class="message${isDashboard ? ' chairman-msg' : ''}${isWechat ? ' wechat-msg' : ''}" data-id="${msg.id}" ondblclick="setReply('${msg.id}')">
    <div class="msg-avatar" style="background:${isDashboard ? 'var(--orange)' : isWechat ? '#07C160' : color}">${agentInitial(msg.from_agent)}</div>
    <div class="msg-body">
      ${replyHtml}
      <div class="msg-header">
        <span class="msg-sender" style="color:${isDashboard ? 'var(--orange)' : isWechat ? '#07C160' : color}">${escapeHtml(msg.from_agent)}</span>
        ${chairmanBadge}${displayOnlyBadge}${wechatBadge}
        <span class="msg-time">${time}</span>
        <span class="msg-ack" data-msg-id="${msg.id}"></span>
        ${edited}
        ${pinBadge}
      </div>
      <div class="msg-content-wrapper${collapsedClass}">
        <div class="msg-content">${content}</div>
        ${fadeHtml}
      </div>
      ${toggleHtml}
      ${reactionsHtml}
    </div>
    <button class="reaction-picker-trigger" onclick="toggleReactionPicker('${msg.id}', event)">&#128578;</button>
    ${pinBtn}
    <div class="reaction-picker" id="picker-${msg.id}">
      ${REACTION_EMOJIS.map(e => `<span class="reaction-picker-emoji" onclick="reactToMsg('${msg.id}', '${e}', event)">${e}</span>`).join('')}
    </div>
  </div>`;
}

function loadOlder() {
  if (loading || !hasMore || messages.length === 0) return;
  const oldestId = messages[0].id;
  loadMessages(currentChannel, oldestId);
}

// ── Markdown Renderer ────────────────────────────────────
function renderMarkdown(text) {
  if (!text) return '';

  // Escape HTML first
  let s = escapeHtml(text);

  // Code blocks (``` ... ```)
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code class="lang-${lang}">${code.trim()}</code></pre>`;
  });

  // Inline code
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // Bold
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Italic
  s = s.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');

  // Strikethrough
  s = s.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // Headings (at start of line)
  s = s.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  s = s.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  s = s.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Blockquotes
  s = s.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // Unordered lists
  s = s.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
  s = s.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

  // Ordered lists
  s = s.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

  // Links
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // URLs
  s = s.replace(/(?<!["\(href=])(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');

  // Line breaks to paragraphs
  s = s.replace(/\n\n/g, '</p><p>');
  s = s.replace(/\n/g, '<br>');

  // Wrap in paragraph if not already wrapped
  if (!s.startsWith('<')) {
    s = '<p>' + s + '</p>';
  }

  return s;
}

// ── Compose / Send Messages ─────────────────────────────
let replyToId = null;
let mentionQuery = '';
let mentionStart = -1;
let mentionDropdownIdx = 0;

function updateComposeUI() {
  const compose = document.getElementById('compose');
  const hint = document.getElementById('compose-channel-hint');
  if (!currentChannel) {
    compose.classList.remove('active');
    return;
  }
  compose.classList.add('active');
  const ch = channels.find(c => c.id === currentChannel);
  const label = ch ? (ch.type === 'dm' ? ch.name : '#' + (ch.name || ch.id)) : currentChannel;
  hint.textContent = `Sending to ${label} as ${agentName}`;
}

function handleComposeInput(e) {
  const input = document.getElementById('compose-input');
  const btn = document.getElementById('send-btn');
  btn.disabled = !input.value.trim();

  // Auto-resize textarea
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';

  // Mention detection
  const val = input.value;
  const pos = input.selectionStart;
  const textBefore = val.slice(0, pos);
  const atMatch = textBefore.match(/@(\w*)$/);

  if (atMatch) {
    mentionStart = pos - atMatch[0].length;
    mentionQuery = atMatch[1].toLowerCase();
    showMentionDropdown();
  } else {
    hideMentionDropdown();
  }
}

function showMentionDropdown() {
  const dropdown = document.getElementById('mention-dropdown');
  // Filter from channel members, not all agents
  const memberAgents = agents.filter(a =>
    channelMembers.includes(a.name) && a.name.toLowerCase().includes(mentionQuery) && a.name !== agentName
  );
  const filtered = memberAgents;

  if (filtered.length === 0) {
    hideMentionDropdown();
    return;
  }

  mentionDropdownIdx = 0;
  let html = '';
  for (let i = 0; i < filtered.length; i++) {
    const a = filtered[i];
    const online = a.status === 'online';
    const sel = i === 0 ? 'selected' : '';
    html += `<div class="mention-item ${sel}" data-name="${escapeHtml(a.name)}" onclick="selectMention('${escapeHtml(a.name)}')">
      <span class="agent-dot ${online ? 'online' : 'offline'}"></span>
      <span>${escapeHtml(a.name)}</span>
      ${a.role ? '<span style="color:var(--text-muted);font-size:11px">' + escapeHtml(a.role) + '</span>' : ''}
    </div>`;
  }
  dropdown.innerHTML = html;
  dropdown.classList.add('active');
}

function hideMentionDropdown() {
  document.getElementById('mention-dropdown').classList.remove('active');
  mentionStart = -1;
}

function selectMention(name) {
  const input = document.getElementById('compose-input');
  const before = input.value.slice(0, mentionStart);
  const after = input.value.slice(input.selectionStart);
  input.value = before + '@' + name + ' ' + after;
  input.focus();
  const newPos = mentionStart + name.length + 2;
  input.setSelectionRange(newPos, newPos);
  hideMentionDropdown();
  document.getElementById('send-btn').disabled = !input.value.trim();
}

function handleComposeKeydown(e) {
  const dropdown = document.getElementById('mention-dropdown');

  // Mention dropdown navigation
  if (dropdown.classList.contains('active')) {
    const items = dropdown.querySelectorAll('.mention-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      mentionDropdownIdx = Math.min(mentionDropdownIdx + 1, items.length - 1);
      items.forEach((el, i) => el.classList.toggle('selected', i === mentionDropdownIdx));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      mentionDropdownIdx = Math.max(mentionDropdownIdx - 1, 0);
      items.forEach((el, i) => el.classList.toggle('selected', i === mentionDropdownIdx));
      return;
    }
    if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault();
      const selected = items[mentionDropdownIdx];
      if (selected) selectMention(selected.dataset.name);
      return;
    }
    if (e.key === 'Escape') {
      hideMentionDropdown();
      return;
    }
  }

  // Enter to send (Shift+Enter for newline)
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

async function sendMessage() {
  const input = document.getElementById('compose-input');
  const btn = document.getElementById('send-btn');
  const content = input.value.trim();
  if (!content || !currentChannel) return;

  // Extract @mentions from content
  const mentionRegex = /@(\w+)/g;
  const mentions = [];
  let match;
  while ((match = mentionRegex.exec(content)) !== null) {
    const name = match[1];
    if (agents.some(a => a.name === name)) {
      mentions.push(name);
    }
  }

  btn.disabled = true;
  try {
    const body = {
      channel: currentChannel,
      content: content,
      metadata: { source: 'dashboard', role: 'chairman' },
    };
    if (mentions.length > 0) body.mentions = mentions;
    if (replyToId) body.replyTo = replyToId;

    const res = await fetch('/api/send', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Send failed: ${res.status}`);
    }

    const result = await res.json();

    // Add message locally (SSE will also deliver it for other channels)
    const msg = {
      id: result.id,
      channel_id: currentChannel,
      from_agent: agentName,
      content: content,
      created_at: result.timestamp,
      reply_to: replyToId,
      mentions: mentions,
      metadata: { source: 'dashboard', role: 'chairman' }
    };
    messages.push(msg);
    renderMessages(true);
    scrollToBottom();
    hideNewMessageIndicator();

    // Refresh channels so new DM channels appear in sidebar
    if (currentChannel.startsWith('dm:') && !channels.find(c => c.id === currentChannel)) {
      refreshChannels();
    }

    // Clear input
    input.value = '';
    input.style.height = 'auto';
    cancelReply();
  } catch (e) {
    console.error('Send failed:', e);
    alert('Failed to send: ' + e.message);
  }
  btn.disabled = !input.value.trim();
}

// ── Reply ────────────────────────────────────────────────
function setReply(msgId) {
  const msg = messages.find(m => m.id === msgId);
  if (!msg) return;
  replyToId = msgId;
  document.getElementById('reply-target').textContent = msg.from_agent;
  document.getElementById('reply-preview').textContent = msg.content.slice(0, 80);
  document.getElementById('reply-bar').classList.add('active');
  document.getElementById('compose-input').focus();
}

function cancelReply() {
  replyToId = null;
  document.getElementById('reply-bar').classList.remove('active');
}

// ── Click agent to open DM ───────────────────────────────
function openDmWithAgent(name) {
  if (name === agentName) return;
  // Find existing DM channel
  const dmId1 = 'dm:' + [agentName, name].sort().join(':');
  const existing = channels.find(c => c.id === dmId1);
  if (existing) {
    selectChannel(existing.id);
  } else {
    // Use full sorted channel ID so SSE events match
    currentChannel = dmId1;
    switchToMessages();
    updateComposeUI();
    document.getElementById('ch-icon').innerHTML = '&#9993;';
    document.getElementById('ch-name').textContent = 'DM with ' + name;
    document.getElementById('ch-desc').textContent = '';
    document.getElementById('members-btn').style.display = 'none';
    document.getElementById('files-btn').style.display = 'none';
    document.getElementById('messages-container').innerHTML = '<div class="empty-state"><div class="icon">&#9993;</div><div>Start a conversation with ' + escapeHtml(name) + '</div></div>';
    messages = [];
    channelMembers = [agentName, name];
    // Try to load history for this DM
    loadMessages(dmId1).then(() => refreshChannels());
  }
}

// ── New Message Indicator ────────────────────────────────

function isScrolledToBottom() {
  var container = document.getElementById('messages-container');
  return container && (container.scrollTop + container.clientHeight >= container.scrollHeight - 50);
}

function showNewMessageIndicator() {
  var indicator = document.getElementById('new-msg-indicator');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'new-msg-indicator';
    indicator.className = 'new-msg-indicator';
    indicator.onclick = function() {
      scrollToBottom();
      hideNewMessageIndicator();
    };
    var wrapper = document.getElementById('messages-container');
    if (wrapper) {
      wrapper.parentElement.insertBefore(indicator, wrapper.nextSibling);
    }
  }
  indicator.textContent = i18n.t('msg.newMessages');
  indicator.classList.add('active');
}

function hideNewMessageIndicator() {
  var indicator = document.getElementById('new-msg-indicator');
  if (indicator) indicator.classList.remove('active');
}

function scrollToBottom() {
  var container = document.getElementById('messages-container');
  if (container) container.scrollTop = container.scrollHeight;
}
