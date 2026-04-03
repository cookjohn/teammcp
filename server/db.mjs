import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publish } from './eventbus.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'teammcp.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');  // Wait up to 5s for write lock instead of failing immediately
db.pragma('encoding = "UTF-8"');

// ── Schema ──────────────────────────────────────────────

db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  name TEXT PRIMARY KEY,
  role TEXT,
  api_key TEXT UNIQUE NOT NULL,
  status TEXT DEFAULT 'offline',
  last_seen DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,           -- group | dm | topic
  name TEXT,
  description TEXT,
  created_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id TEXT,
  agent_name TEXT,
  joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (channel_id, agent_name)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  content TEXT NOT NULL,
  mentions TEXT,               -- JSON array
  reply_to TEXT,
  metadata TEXT,               -- JSON
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (channel_id) REFERENCES channels(id)
);

CREATE TABLE IF NOT EXISTS read_status (
  agent_name TEXT,
  channel_id TEXT,
  last_read_msg TEXT,
  PRIMARY KEY (agent_name, channel_id)
);
`);

// ── Schema migrations ────────────────────────────────────

// Add edited_at and deleted columns if not present
try {
  db.exec(`ALTER TABLE messages ADD COLUMN edited_at DATETIME`);
} catch { /* column already exists */ }
try {
  db.exec(`ALTER TABLE messages ADD COLUMN deleted INTEGER DEFAULT 0`);
} catch { /* column already exists */ }

// Add approver column to state_kv if not present
try {
  db.exec(`ALTER TABLE state_kv ADD COLUMN approver TEXT DEFAULT NULL`);
} catch { /* column already exists */ }

// Add reports_to column to agents for data-driven command chain
try {
  db.exec('ALTER TABLE agents ADD COLUMN reports_to TEXT DEFAULT NULL');
} catch { /* column already exists */ }

// Add source column to change_log for audit categorization
try {
  db.exec(`ALTER TABLE change_log ADD COLUMN source TEXT DEFAULT 'state'`);
} catch { /* column already exists */ }

// Add visibility column to audit_reports
try {
  db.exec(`ALTER TABLE audit_reports ADD COLUMN visibility TEXT DEFAULT 'all'`);
} catch { /* column already exists */ }

// ── FTS5 full-text search index ──────────────────────────

db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  id UNINDEXED,
  channel_id UNINDEXED,
  from_agent UNINDEXED,
  content,
  created_at UNINDEXED
)
`);

// Migrate existing messages into FTS index (idempotent — skip if already populated)
const ftsCount = db.prepare('SELECT COUNT(*) as cnt FROM messages_fts').get().cnt;
if (ftsCount === 0) {
  const _unescape = s => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
  const existing = db.prepare(
    'SELECT id, channel_id, from_agent, content, created_at FROM messages WHERE deleted = 0 OR deleted IS NULL'
  ).all();
  if (existing.length > 0) {
    const insert = db.prepare('INSERT INTO messages_fts (id, channel_id, from_agent, content, created_at) VALUES (?, ?, ?, ?, ?)');
    const migrate = db.transaction(() => {
      for (const m of existing) {
        insert.run(m.id, m.channel_id, m.from_agent, _unescape(m.content), m.created_at);
      }
    });
    migrate();
  }
}

// ── Migration: unescape existing HTML-escaped messages ──
// Previously messages were stored HTML-escaped; now we store raw content
// and let the rendering layer handle escaping.
try {
  const hasEscaped = db.prepare(
    "SELECT COUNT(*) as cnt FROM messages WHERE content LIKE '%&amp;%' OR content LIKE '%&lt;%' OR content LIKE '%&gt;%' OR content LIKE '%&quot;%' OR content LIKE '%&#39;%'"
  ).get().cnt;
  if (hasEscaped > 0) {
    const _unescape = s => s
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&gt;/g, '>')
      .replace(/&lt;/g, '<')
      .replace(/&amp;/g, '&');
    const rows = db.prepare('SELECT id, content FROM messages').all();
    const update = db.prepare('UPDATE messages SET content = ? WHERE id = ?');
    const migrate = db.transaction(() => {
      for (const r of rows) {
        const raw = _unescape(r.content);
        if (raw !== r.content) {
          update.run(raw, r.id);
        }
      }
    });
    migrate();
    console.log(`[db] Migrated ${hasEscaped} HTML-escaped messages to raw content`);
  }
} catch (e) {
  console.error('[db] Migration error (unescape):', e.message);
}

// ── Reactions table ──────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS reactions (
  message_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (message_id, agent_name, emoji),
  FOREIGN KEY (message_id) REFERENCES messages(id)
);
`);

// ── Pinned messages table ────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS pinned_messages (
  message_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  pinned_by TEXT NOT NULL,
  pinned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (message_id) REFERENCES messages(id),
  FOREIGN KEY (channel_id) REFERENCES channels(id)
);
`);

// ── Seed: general channel ───────────────────────────────

const ensureGeneral = db.prepare(
  `INSERT OR IGNORE INTO channels (id, type, name, description, created_by)
   VALUES ('general', 'group', 'General', '团队公共频道', 'system')`
);
ensureGeneral.run();

// ── Startup: reset all agents to offline ─────────────────
// Handles stale 'online' status from previous server crash/restart
db.prepare("UPDATE agents SET status = 'offline' WHERE status = 'online'").run();

// ── Agents ──────────────────────────────────────────────

export function registerAgent(name, role) {
  const existing = db.prepare('SELECT * FROM agents WHERE name = ?').get(name);
  if (existing) return existing;

  const apiKey = `tmcp_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  db.prepare(
    'INSERT INTO agents (name, role, api_key, status, last_seen) VALUES (?, ?, ?, ?, ?)'
  ).run(name, role || '', apiKey, 'offline', new Date().toISOString());

  // Auto-join general
  db.prepare(
    'INSERT OR IGNORE INTO channel_members (channel_id, agent_name) VALUES (?, ?)'
  ).run('general', name);

  return db.prepare('SELECT * FROM agents WHERE name = ?').get(name);
}

export function getAgentByKey(apiKey) {
  return db.prepare('SELECT * FROM agents WHERE api_key = ?').get(apiKey);
}

export function getAgentByName(name) {
  return db.prepare('SELECT * FROM agents WHERE name = ?').get(name);
}

export function setAgentStatus(name, status) {
  db.prepare('UPDATE agents SET status = ?, last_seen = ? WHERE name = ?')
    .run(status, new Date().toISOString(), name);
}

export function getAllAgents() {
  return db.prepare('SELECT name, role, status, last_seen, reports_to FROM agents').all();
}

export function getReportsTo(agentName) {
  const row = db.prepare('SELECT reports_to FROM agents WHERE name = ?').get(agentName);
  return row?.reports_to || null;
}

export function setReportsTo(agentName, superior) {
  db.prepare('UPDATE agents SET reports_to = ? WHERE name = ?').run(superior, agentName);
}

export function getSubordinates(superiorName) {
  return db.prepare('SELECT name, role, status FROM agents WHERE reports_to = ?').all(superiorName);
}

// ── Channels ────────────────────────────────────────────

export function createChannel(id, type, name, description, createdBy, members) {
  db.prepare(
    'INSERT INTO channels (id, type, name, description, created_by) VALUES (?, ?, ?, ?, ?)'
  ).run(id, type, name || id, description || '', createdBy || '');

  if (members && members.length) {
    const ins = db.prepare(
      'INSERT OR IGNORE INTO channel_members (channel_id, agent_name) VALUES (?, ?)'
    );
    for (const m of members) ins.run(id, m);
  }

  return db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
}

export function getChannel(id) {
  return db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
}

export function getChannelsForAgent(agentName) {
  // group channels (member = * or explicit), dm channels, topic channels the agent joined
  const rows = db.prepare(`
    SELECT c.*, COALESCE(rs.last_read_msg, '') as last_read
    FROM channels c
    LEFT JOIN read_status rs ON rs.channel_id = c.id AND rs.agent_name = ?
    WHERE c.type = 'group'
       OR c.id IN (SELECT channel_id FROM channel_members WHERE agent_name = ?)
  `).all(agentName, agentName);

  // Compute unread counts
  return rows.map(ch => {
    let unread = 0;
    if (ch.last_read) {
      unread = db.prepare(
        `SELECT COUNT(*) as cnt FROM messages
         WHERE channel_id = ? AND created_at > (SELECT created_at FROM messages WHERE id = ?)
         AND from_agent != ?`
      ).get(ch.id, ch.last_read, agentName)?.cnt || 0;
    } else {
      unread = db.prepare(
        'SELECT COUNT(*) as cnt FROM messages WHERE channel_id = ? AND from_agent != ?'
      ).get(ch.id, agentName)?.cnt || 0;
    }
    return { id: ch.id, type: ch.type, name: ch.name, description: ch.description, unread };
  });
}

export function getChannelMembers(channelId) {
  return db.prepare(
    'SELECT agent_name FROM channel_members WHERE channel_id = ?'
  ).all(channelId).map(r => r.agent_name);
}

export function addChannelMember(channelId, agentName) {
  db.prepare(
    'INSERT OR IGNORE INTO channel_members (channel_id, agent_name) VALUES (?, ?)'
  ).run(channelId, agentName);
}

export function removeChannelMember(channelId, agentName) {
  db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND agent_name = ?').run(channelId, agentName);
}

// ── Messages ────────────────────────────────────────────

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function unescapeHtml(str) {
  return str
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

export function saveMessage(channelId, fromAgent, content, mentions, replyTo, metadata) {
  const id = `msg_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO messages (id, channel_id, from_agent, content, mentions, reply_to, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, channelId, fromAgent, content,
    mentions ? JSON.stringify(mentions) : null,
    replyTo || null,
    metadata ? JSON.stringify(metadata) : null,
    now
  );
  // Sync FTS index (store raw content for search)
  db.prepare('INSERT INTO messages_fts (id, channel_id, from_agent, content, created_at) VALUES (?, ?, ?, ?, ?)').run(id, channelId, fromAgent, content, now);
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
}

export function getMessages(channelId, limit = 50, before) {
  if (before) {
    const rows = db.prepare(
      `SELECT * FROM messages
       WHERE channel_id = ? AND (deleted = 0 OR deleted IS NULL)
         AND created_at < (SELECT created_at FROM messages WHERE id = ?)
       ORDER BY created_at DESC LIMIT ?`
    ).all(channelId, before, limit);
    const hasMore = rows.length === limit;
    return { messages: rows.reverse(), hasMore };
  }
  const rows = db.prepare(
    'SELECT * FROM messages WHERE channel_id = ? AND (deleted = 0 OR deleted IS NULL) ORDER BY created_at DESC LIMIT ?'
  ).all(channelId, limit);
  const hasMore = rows.length === limit;
  return { messages: rows.reverse(), hasMore };
}

export function getMessage(msgId) {
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
}

export function editMessage(msgId, newContent) {
  db.prepare(
    'UPDATE messages SET content = ?, edited_at = ? WHERE id = ?'
  ).run(newContent, new Date().toISOString(), msgId);
  // Sync FTS index
  db.prepare('UPDATE messages_fts SET content = ? WHERE id = ?').run(newContent, msgId);
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
}

export function deleteMessage(msgId) {
  db.prepare(
    'UPDATE messages SET deleted = 1 WHERE id = ?'
  ).run(msgId);
  // Remove from FTS index
  db.prepare('DELETE FROM messages_fts WHERE id = ?').run(msgId);
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
}

// ── Full-text search ────────────────────────────────────

/**
 * Sanitize a query string for FTS5 MATCH.
 * Wraps each token in double quotes to treat special characters as literals.
 */
function sanitizeFtsQuery(query) {
  // Split into tokens by whitespace, wrap each in double quotes
  // to prevent FTS5 syntax interpretation of special chars like - " ( ) * etc.
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map(token => `"${token.replace(/"/g, '""')}"`)  // escape internal double quotes
    .join(' ');
}

export function searchMessages(query, { channel, from, limit = 20, offset = 0 } = {}) {
  const sanitized = sanitizeFtsQuery(query);
  if (!sanitized) return { results: [], total: 0 };

  const conditions = ['messages_fts MATCH ?'];
  const params = [sanitized];

  if (channel) {
    conditions.push('channel_id = ?');
    params.push(channel);
  }
  if (from) {
    conditions.push('from_agent = ?');
    params.push(from);
  }

  const where = conditions.join(' AND ');

  const total = db.prepare(
    `SELECT COUNT(*) as cnt FROM messages_fts WHERE ${where}`
  ).get(...params).cnt;

  const rows = db.prepare(
    `SELECT id, channel_id, from_agent, content, created_at
     FROM messages_fts
     WHERE ${where}
     ORDER BY rank
     LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  return { results: rows, total };
}

// ── Read status ─────────────────────────────────────────

export function updateReadStatus(agentName, channelId, msgId) {
  db.prepare(
    `INSERT INTO read_status (agent_name, channel_id, last_read_msg)
     VALUES (?, ?, ?)
     ON CONFLICT(agent_name, channel_id) DO UPDATE SET last_read_msg = excluded.last_read_msg`
  ).run(agentName, channelId, msgId);
}

export function getUnreadMessages(agentName, channelId) {
  const rs = db.prepare(
    'SELECT last_read_msg FROM read_status WHERE agent_name = ? AND channel_id = ?'
  ).get(agentName, channelId);

  if (rs && rs.last_read_msg) {
    return db.prepare(
      `SELECT * FROM messages
       WHERE channel_id = ? AND (deleted = 0 OR deleted IS NULL)
         AND created_at > (SELECT created_at FROM messages WHERE id = ?)
       ORDER BY created_at ASC`
    ).all(channelId, rs.last_read_msg);
  }
  // No read_status record: limit to last 50 messages to prevent message flood on first connect
  return db.prepare(
    'SELECT * FROM messages WHERE channel_id = ? AND (deleted = 0 OR deleted IS NULL) ORDER BY created_at DESC LIMIT 50'
  ).all(channelId).reverse();
}

// ── Reconnect helpers ────────────────────────────────────

export function getUnreadCount(agentName, channelId) {
  const rs = db.prepare(
    'SELECT last_read_msg FROM read_status WHERE agent_name = ? AND channel_id = ?'
  ).get(agentName, channelId);

  if (rs && rs.last_read_msg) {
    const row = db.prepare(
      `SELECT COUNT(*) as cnt FROM messages
       WHERE channel_id = ? AND (deleted = 0 OR deleted IS NULL)
         AND created_at > (SELECT created_at FROM messages WHERE id = ?)
         AND from_agent != ?`
    ).get(channelId, rs.last_read_msg, agentName);
    return row.cnt;
  }
  // No read_status: count all (capped at 50 in getUnreadMessages)
  const row = db.prepare(
    `SELECT COUNT(*) as cnt FROM messages
     WHERE channel_id = ? AND (deleted = 0 OR deleted IS NULL)
       AND from_agent != ?`
  ).get(channelId, agentName);
  return Math.min(row.cnt, 50);
}

export function getUnreadMentions(agentName, channelId) {
  const rs = db.prepare(
    'SELECT last_read_msg FROM read_status WHERE agent_name = ? AND channel_id = ?'
  ).get(agentName, channelId);

  if (rs && rs.last_read_msg) {
    return db.prepare(
      `SELECT m.* FROM messages m
       WHERE m.channel_id = ? AND (m.deleted = 0 OR m.deleted IS NULL)
         AND m.created_at > (SELECT created_at FROM messages WHERE id = ?)
         AND EXISTS (SELECT 1 FROM json_each(m.mentions) WHERE json_each.value = ?)
       ORDER BY m.created_at ASC`
    ).all(channelId, rs.last_read_msg, agentName);
  }
  return db.prepare(
    `SELECT m.* FROM messages m
     WHERE m.channel_id = ? AND (m.deleted = 0 OR m.deleted IS NULL)
       AND EXISTS (SELECT 1 FROM json_each(m.mentions) WHERE json_each.value = ?)
     ORDER BY m.created_at DESC LIMIT 50`
  ).all(channelId, agentName).reverse();
}

export function getLastUnreadMessageId(agentName, channelId) {
  const rs = db.prepare(
    'SELECT last_read_msg FROM read_status WHERE agent_name = ? AND channel_id = ?'
  ).get(agentName, channelId);

  if (rs && rs.last_read_msg) {
    return db.prepare(
      `SELECT id FROM messages
       WHERE channel_id = ? AND (deleted = 0 OR deleted IS NULL)
         AND created_at > (SELECT created_at FROM messages WHERE id = ?)
       ORDER BY created_at DESC LIMIT 1`
    ).get(channelId, rs.last_read_msg)?.id || null;
  }

  return db.prepare(
    `SELECT id FROM messages
     WHERE channel_id = ? AND (deleted = 0 OR deleted IS NULL)
     ORDER BY created_at DESC LIMIT 1`
  ).get(channelId)?.id || null;
}

export function getLastNMessages(channelId, n) {
  return db.prepare(
    `SELECT * FROM messages
     WHERE channel_id = ? AND (deleted = 0 OR deleted IS NULL)
     ORDER BY created_at DESC LIMIT ?`
  ).all(channelId, n).reverse();
}


export function batchUpdateReadStatus(updates) {
  const txn = db.transaction((items) => {
    const stmt = db.prepare(
      `INSERT INTO read_status (agent_name, channel_id, last_read_msg)
       VALUES (?, ?, ?)
       ON CONFLICT(agent_name, channel_id) DO UPDATE SET last_read_msg = excluded.last_read_msg`
    );
    for (const { agentName, channelId, msgId } of items) {
      stmt.run(agentName, channelId, msgId);
    }
  });
  txn(updates);
}

export function getStateChangesSince(timestamp) {
  return db.prepare(
    `SELECT project_id, field, old_value, new_value, changed_by, timestamp
     FROM change_log
     WHERE timestamp > ? AND source = 'state'
     ORDER BY timestamp ASC
     LIMIT 100`
  ).all(timestamp);
}

// ── DM helpers ──────────────────────────────────────────

export function getOrCreateDmChannel(agent1, agent2) {
  // DM channel id is deterministic: dm:<sorted names>
  const sorted = [agent1, agent2].sort();
  const dmId = `dm:${sorted[0]}:${sorted[1]}`;

  let ch = getChannel(dmId);
  if (!ch) {
    ch = createChannel(dmId, 'dm', `DM ${sorted[0]} ↔ ${sorted[1]}`, '', agent1, sorted);
  }
  return ch;
}

// ── Task Management Schema ──────────────────────────────

db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'todo',
    priority    TEXT NOT NULL DEFAULT 'medium',
    creator     TEXT NOT NULL,
    assignee    TEXT,
    source_msg  TEXT,
    channel     TEXT,
    parent_id   TEXT,
    result      TEXT DEFAULT '',
    due_date    TEXT,
    labels      TEXT DEFAULT '[]',
    metadata    TEXT DEFAULT '{}',
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    closed_at   TEXT,
    deleted     INTEGER DEFAULT 0,
    FOREIGN KEY (creator) REFERENCES agents(name),
    FOREIGN KEY (assignee) REFERENCES agents(name),
    FOREIGN KEY (parent_id) REFERENCES tasks(id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee);
CREATE INDEX IF NOT EXISTS idx_tasks_source_msg ON tasks(source_msg);

CREATE TABLE IF NOT EXISTS task_history (
    id          TEXT PRIMARY KEY,
    task_id     TEXT NOT NULL,
    actor       TEXT NOT NULL,
    action      TEXT NOT NULL,
    changes     TEXT NOT NULL DEFAULT '[]',
    comment     TEXT DEFAULT '',
    created_at  TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE INDEX IF NOT EXISTS idx_task_history_task ON task_history(task_id);
`);

// ── Task Permission Constants ───────────────────────────

export const MANAGERS = ['CEO', 'PM', 'Product', 'CTO'];

// ── Task CRUD ───────────────────────────────────────────

export function updateMessageMetadata(msgId, metadata) {
  db.prepare('UPDATE messages SET metadata = ? WHERE id = ?')
    .run(JSON.stringify(metadata), msgId);
}

export function createTask(data) {
  const id = `task_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO tasks (id, title, status, priority, creator, assignee, source_msg, channel, parent_id, result, due_date, labels, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    data.title,
    data.status || 'todo',
    data.priority || 'medium',
    data.creator,
    data.assignee || null,
    data.source_msg || null,
    data.channel || null,
    data.parent_id || null,
    data.result || '',
    data.due_date || null,
    JSON.stringify(data.labels || []),
    JSON.stringify(data.metadata || {}),
    now,
    now
  );

  // Record creation in history
  const thId = `th_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  db.prepare(`
    INSERT INTO task_history (id, task_id, actor, action, changes, comment, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(thId, id, data.creator, 'created', JSON.stringify([]), '', now);

  // Update source message metadata if source_msg provided
  if (data.source_msg) {
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(data.source_msg);
    if (msg) {
      const existing = msg.metadata ? JSON.parse(msg.metadata) : {};
      existing.task_id = id;
      updateMessageMetadata(data.source_msg, existing);
    }
  }

  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

export function getTask(id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ? AND deleted = 0').get(id);
}

export function getPendingTasksCount() {
  const row = db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status != 'done' AND deleted = 0").get();
  return row.cnt;
}

export function getTasks(filters = {}) {
  const conditions = ['deleted = 0'];
  const params = [];

  if (filters.status) {
    const statuses = filters.status.split(',').map(s => s.trim());
    conditions.push(`status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  if (filters.assignee) {
    conditions.push('assignee = ?');
    params.push(filters.assignee);
  }
  if (filters.creator) {
    conditions.push('creator = ?');
    params.push(filters.creator);
  }
  if (filters.priority) {
    const priorities = filters.priority.split(',').map(s => s.trim());
    conditions.push(`priority IN (${priorities.map(() => '?').join(',')})`);
    params.push(...priorities);
  }
  if (filters.parent_id) {
    conditions.push('parent_id = ?');
    params.push(filters.parent_id);
  }
  if (filters.label) {
    conditions.push("labels LIKE ?");
    params.push(`%"${filters.label}"%`);
  }

  const where = conditions.join(' AND ');

  // Sort
  const sortField = filters.sort || '-priority';
  const desc = sortField.startsWith('-');
  const field = desc ? sortField.slice(1) : sortField;
  const allowedSortFields = ['priority', 'created_at', 'updated_at', 'due_date', 'status', 'title'];
  const sortCol = allowedSortFields.includes(field) ? field : 'priority';

  // For priority sorting, use CASE to define order: urgent > high > medium > low
  let orderBy;
  if (sortCol === 'priority') {
    const priorityOrder = desc
      ? "CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END ASC"
      : "CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END DESC";
    orderBy = priorityOrder;
  } else {
    orderBy = `${sortCol} ${desc ? 'DESC' : 'ASC'}`;
  }

  const limit = Math.max(1, Math.min(filters.limit || 20, 100));
  const offset = Math.max(0, filters.offset || 0);

  const total = db.prepare(`SELECT COUNT(*) as cnt FROM tasks WHERE ${where}`).get(...params).cnt;

  const tasks = db.prepare(
    `SELECT * FROM tasks WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  return { tasks, total, limit, offset };
}

export function updateTask(id, changes, actor) {
  const update = db.transaction(() => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND deleted = 0').get(id);
    if (!task) return null;

    const now = new Date().toISOString();
    const changeLog = [];
    const allowedFields = ['title', 'status', 'priority', 'assignee', 'parent_id', 'result', 'due_date', 'labels', 'metadata', 'channel'];

    const setClauses = ['updated_at = ?'];
    const setParams = [now];

    for (const field of allowedFields) {
      if (changes[field] !== undefined) {
        const oldVal = task[field];
        let newVal = changes[field];

        if (field === 'labels' || field === 'metadata') {
          newVal = JSON.stringify(newVal);
        }

        if (oldVal !== newVal) {
          changeLog.push({ field, old: oldVal, new: newVal });
          setClauses.push(`${field} = ?`);
          setParams.push(newVal);
        }
      }
    }

    // Handle closed_at based on status changes
    if (changes.status === 'done' && task.status !== 'done') {
      setClauses.push('closed_at = ?');
      setParams.push(now);
    } else if (changes.status && changes.status !== 'done' && task.status === 'done') {
      setClauses.push('closed_at = ?');
      setParams.push(null);
    }

    if (changeLog.length === 0) {
      return { task, changeLog: [] }; // No actual changes
    }

    setParams.push(id);
    db.prepare(`UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`).run(...setParams);

    // Record in history
    const thId = `th_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    db.prepare(`
      INSERT INTO task_history (id, task_id, actor, action, changes, comment, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(thId, id, actor, 'updated', JSON.stringify(changeLog), changes.comment || '', now);

    // Update message metadata if source_msg exists
    const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (updated.source_msg) {
      const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(updated.source_msg);
      if (msg) {
        const existing = msg.metadata ? JSON.parse(msg.metadata) : {};
        existing.task_id = id;
        existing.task_status = updated.status;
        updateMessageMetadata(updated.source_msg, existing);
      }
    }

    return { task: updated, changeLog };
  });

  return update();
}

export function deleteTask(id, actor) {
  const del = db.transaction(() => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND deleted = 0').get(id);
    if (!task) return null;

    const now = new Date().toISOString();
    db.prepare('UPDATE tasks SET deleted = 1, updated_at = ? WHERE id = ?').run(now, id);

    // Record in history
    const thId = `th_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    db.prepare(`
      INSERT INTO task_history (id, task_id, actor, action, changes, comment, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(thId, id, actor, 'deleted', JSON.stringify([]), '', now);

    // Clear message metadata if source_msg exists
    if (task.source_msg) {
      const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(task.source_msg);
      if (msg) {
        const existing = msg.metadata ? JSON.parse(msg.metadata) : {};
        delete existing.task_id;
        delete existing.task_status;
        updateMessageMetadata(task.source_msg, existing);
      }
    }

    return { id, deleted: true };
  });

  return del();
}

export function getTaskHistory(taskId) {
  return db.prepare(
    'SELECT * FROM task_history WHERE task_id = ? ORDER BY created_at ASC'
  ).all(taskId);
}

export function getOverdueTasks() {
  return db.prepare(
    `SELECT * FROM tasks
     WHERE status != 'done' AND deleted = 0
       AND due_date IS NOT NULL AND due_date != ''
       AND due_date <= datetime('now')
       AND (metadata NOT LIKE '%"overdue_notified":true%' OR metadata IS NULL)`
  ).all();
}

export function markOverdueNotified(taskId) {
  const task = db.prepare('SELECT metadata FROM tasks WHERE id = ?').get(taskId);
  let meta = {};
  try { meta = JSON.parse(task?.metadata || '{}'); } catch {}
  meta.overdue_notified = true;
  db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(JSON.stringify(meta), taskId);
}

// ── Long-term task tracking helpers ──────────────────────

// Get task with children info
export function getTaskWithChildren(taskId) {
  const task = getTask(taskId);
  if (!task) return null;
  const children = db.prepare(
    'SELECT * FROM tasks WHERE parent_id = ? AND deleted = 0'
  ).all(taskId);
  const childrenDone = children.filter(c => c.status === 'done').length;
  const autoProgress = children.length > 0 ? Math.round((childrenDone / children.length) * 100) : null;
  return { ...task, children, children_count: children.length, children_done: childrenDone, auto_progress: autoProgress };
}

// Get tasks that need check-in reminders
export function getCheckInDueTasks() {
  return db.prepare(
    `SELECT * FROM tasks WHERE status != 'done' AND deleted = 0`
  ).all().filter(t => {
    try {
      const meta = JSON.parse(t.metadata || '{}');
      if (!meta.checkin_interval || !meta.next_checkin) return false;
      return new Date(meta.next_checkin) <= new Date();
    } catch { return false; }
  });
}

// Update check-in timestamps in metadata
export function updateCheckIn(taskId) {
  const task = db.prepare('SELECT metadata FROM tasks WHERE id = ?').get(taskId);
  if (!task) return;
  let meta = {};
  try { meta = JSON.parse(task.metadata || '{}'); } catch {}

  const now = new Date();
  meta.last_checkin = now.toISOString();

  // Calculate next check-in based on interval
  const interval = meta.checkin_interval;
  const next = new Date(now);
  if (interval === 'daily') next.setDate(next.getDate() + 1);
  else if (interval === 'weekly') next.setDate(next.getDate() + 7);
  else if (interval === 'biweekly') next.setDate(next.getDate() + 14);
  meta.next_checkin = next.toISOString();

  db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(JSON.stringify(meta), taskId);
}

// ── Shared State Layer Schema ────────────────────────────

db.exec(`
CREATE TABLE IF NOT EXISTS state_kv (
    project_id   TEXT NOT NULL,
    field        TEXT NOT NULL,
    value        TEXT NOT NULL DEFAULT '{}',
    owner        TEXT NOT NULL,
    approval_required INTEGER DEFAULT 0,
    approver     TEXT DEFAULT NULL,
    subscribers  TEXT NOT NULL DEFAULT '[]',
    version      INTEGER DEFAULT 1,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by   TEXT NOT NULL,
    PRIMARY KEY (project_id, field)
);

CREATE TABLE IF NOT EXISTS change_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id   TEXT NOT NULL,
    field        TEXT NOT NULL,
    old_value    TEXT,
    new_value    TEXT NOT NULL,
    changed_by   TEXT NOT NULL,
    reason       TEXT DEFAULT '',
    timestamp    TEXT NOT NULL DEFAULT (datetime('now')),
    version      INTEGER NOT NULL
);

-- CRITICAL: append-only trigger - prevent UPDATE and DELETE on change_log
CREATE TRIGGER IF NOT EXISTS change_log_no_update
BEFORE UPDATE ON change_log
BEGIN
    SELECT RAISE(ABORT, 'change_log is append-only: UPDATE not allowed');
END;

CREATE TRIGGER IF NOT EXISTS change_log_no_delete
BEFORE DELETE ON change_log
BEGIN
    SELECT RAISE(ABORT, 'change_log is append-only: DELETE not allowed');
END;

CREATE TABLE IF NOT EXISTS pending_approvals (
    approval_id  TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL,
    field        TEXT NOT NULL,
    proposed_value TEXT NOT NULL,
    proposed_by  TEXT NOT NULL,
    owner        TEXT NOT NULL,
    status       TEXT DEFAULT 'pending',
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at  TEXT,
    resolved_by  TEXT,
    comment      TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS audit_reports (
    id           TEXT PRIMARY KEY,
    project_id   TEXT,
    report_type  TEXT NOT NULL,
    content      TEXT NOT NULL,
    generated_by TEXT NOT NULL,
    generated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- audit_reports is also append-only
CREATE TRIGGER IF NOT EXISTS audit_reports_no_update
BEFORE UPDATE ON audit_reports
BEGIN
    SELECT RAISE(ABORT, 'audit_reports is append-only: UPDATE not allowed');
END;

CREATE TRIGGER IF NOT EXISTS audit_reports_no_delete
BEFORE DELETE ON audit_reports
BEGIN
    SELECT RAISE(ABORT, 'audit_reports is append-only: DELETE not allowed');
END;

CREATE TABLE IF NOT EXISTS agent_profiles (
    agent_id     TEXT PRIMARY KEY,
    relevant_fields TEXT NOT NULL DEFAULT '[]',
    critical_fields TEXT NOT NULL DEFAULT '[]',
    participating_projects TEXT NOT NULL DEFAULT '[]',
    participating_channels TEXT NOT NULL DEFAULT '[]',
    last_known_versions TEXT NOT NULL DEFAULT '{}',
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_change_log_project ON change_log(project_id, field);
CREATE INDEX IF NOT EXISTS idx_change_log_timestamp ON change_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_pending_approvals_owner ON pending_approvals(owner, status);
CREATE INDEX IF NOT EXISTS idx_pending_approvals_status ON pending_approvals(status);
`);

// ── Shared State CRUD ──────────────────────────────────

export function getState(projectId, field, limit = 100, offset = 0) {
  if (field) {
    return db.prepare('SELECT * FROM state_kv WHERE project_id = ? AND field = ?').get(projectId, field);
  }
  const safeLimit = Math.max(1, Math.min(limit, 200));
  const safeOffset = Math.max(0, offset);
  const total = db.prepare('SELECT COUNT(*) as cnt FROM state_kv WHERE project_id = ?').get(projectId).cnt;
  const items = db.prepare('SELECT * FROM state_kv WHERE project_id = ? ORDER BY field ASC LIMIT ? OFFSET ?').all(projectId, safeLimit, safeOffset);
  return { items, total, limit: safeLimit, offset: safeOffset };
}

// Roles allowed to create new state fields and assign arbitrary owners
export const STATE_ADMINS = ['CEO', 'CTO', 'PM', 'human'];

export const AUDIT_ROLES = ['Audit'];

// Knowledge check enforcement: max age before setState requires a check (1 hour)
const KNOWLEDGE_CHECK_MAX_AGE_MS = 60 * 60 * 1000;

export function setState(projectId, field, value, changedBy, reason, opts = {}) {
  const setStateTransaction = db.transaction(() => {
    const now = new Date().toISOString();

    // Enforce knowledge check (C5 metacognition principle)
    // Skip for human overrides, approval resolutions, and system operations
    if (!opts.isHumanOverride && !opts.isApproval && !STATE_ADMINS.includes(changedBy)) {
      const profile = db.prepare('SELECT last_known_versions FROM agent_profiles WHERE agent_id = ?').get(changedBy);
      if (profile) {
        const lkv = JSON.parse(profile.last_known_versions || '{}');
        const lastCheck = lkv._last_check_timestamp;
        if (!lastCheck || (Date.now() - new Date(lastCheck).getTime()) > KNOWLEDGE_CHECK_MAX_AGE_MS) {
          return { error: 'knowledge_check_required', message: 'Please run check_knowledge_gaps before modifying state. Your last check is stale or missing.' };
        }
      }
      // If no profile exists, allow (agent hasn't been onboarded yet)
    }
    const isHuman = opts.isHumanOverride === true; // Only set by router for dashboard admin
    const existing = db.prepare('SELECT * FROM state_kv WHERE project_id = ? AND field = ?').get(projectId, field);

    // Optimistic concurrency control (check before any write path)
    if (opts.expected_version !== undefined && existing && opts.expected_version !== existing.version) {
      return { error: 'version_conflict', expected: opts.expected_version, actual: existing.version };
    }

    if (existing) {
      const isOwner = existing.owner === changedBy;

      // approval_required fields: even owner needs upper-level confirmation (unless human override or already approved)
      if (existing.approval_required && !isHuman && !opts.isApproval) {
        // Use designated approver, fallback to CEO if not set
        const approver = existing.approver || 'CEO';
        const approvalId = `appr_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
        db.prepare(`
          INSERT INTO pending_approvals (approval_id, project_id, field, proposed_value, proposed_by, owner, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
        `).run(approvalId, projectId, field, JSON.stringify(value), changedBy, approver, now);
        publish('approval_requested', { project_id: projectId, field, approval_id: approvalId, proposed_by: changedBy, approver });
        return { pending_approval: true, approval_id: approvalId, approver, reason: 'approval_required field' };
      }

      // Non-owner, non-human: create pending approval
      if (!isOwner && !isHuman && !opts.isApproval) {
        const approvalId = `appr_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
        db.prepare(`
          INSERT INTO pending_approvals (approval_id, project_id, field, proposed_value, proposed_by, owner, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
        `).run(approvalId, projectId, field, JSON.stringify(value), changedBy, existing.owner, now);
        publish('approval_requested', { project_id: projectId, field, approval_id: approvalId, proposed_by: changedBy, approver: existing.owner });
        return { pending_approval: true, approval_id: approvalId };
      }

      // Owner, human override, or approved: update
      const newVersion = existing.version + 1;
      const oldValue = existing.value;

      // Optimistic concurrency control (optional)
      if (opts.expected_version !== undefined && opts.expected_version !== existing.version) {
        return { error: 'version_conflict', expected: opts.expected_version, actual: existing.version };
      }

      db.prepare(`
        UPDATE state_kv SET value = ?, version = ?, updated_at = ?, updated_by = ?
        WHERE project_id = ? AND field = ?
      `).run(JSON.stringify(value), newVersion, now, changedBy, projectId, field);

      // Append to change_log
      db.prepare(`
        INSERT INTO change_log (project_id, field, old_value, new_value, changed_by, reason, timestamp, version, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'state')
      `).run(projectId, field, oldValue, JSON.stringify(value), changedBy, reason || '', now, newVersion);

      // Get subscribers for event payload (avoids circular import in eventbus)
      let subs = [];
      try { subs = JSON.parse(existing.subscribers || '[]'); } catch {}
      publish('state_changed', { project_id: projectId, field, version: newVersion, changed_by: changedBy, old_value: oldValue, new_value: JSON.stringify(value), subscribers: subs });

      return { success: true, version: newVersion, field, project_id: projectId };
    } else {
      // New field: only STATE_ADMINS or human override can create
      const isAdmin = STATE_ADMINS.includes(changedBy) || isHuman;
      if (!isAdmin) {
        return { error: 'admin_required', message: 'Only STATE_ADMINS can create new state fields' };
      }
      const owner = opts.owner || changedBy;
      const approvalRequired = opts.approval_required ? 1 : 0;
      const approver = opts.approver || null; // Upper-level approver for approval_required fields
      const subscribers = JSON.stringify(opts.subscribers || []);

      db.prepare(`
        INSERT INTO state_kv (project_id, field, value, owner, approval_required, approver, subscribers, version, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(projectId, field, JSON.stringify(value), owner, approvalRequired, approver, subscribers, now, changedBy);

      // Append to change_log
      db.prepare(`
        INSERT INTO change_log (project_id, field, old_value, new_value, changed_by, reason, timestamp, version, source)
        VALUES (?, ?, NULL, ?, ?, ?, ?, 1, 'state')
      `).run(projectId, field, JSON.stringify(value), changedBy, reason || 'initial creation', now);

      publish('state_changed', { project_id: projectId, field, version: 1, changed_by: changedBy, old_value: null, new_value: JSON.stringify(value), subscribers: opts.subscribers || [] });

      return { success: true, version: 1, field, project_id: projectId, created: true };
    }
  });

  return setStateTransaction();
}

export function getStateHistory(projectId, field, limit = 50) {
  if (field) {
    return db.prepare(
      'SELECT * FROM change_log WHERE project_id = ? AND field = ? ORDER BY timestamp DESC LIMIT ?'
    ).all(projectId, field, limit);
  }
  return db.prepare(
    'SELECT * FROM change_log WHERE project_id = ? ORDER BY timestamp DESC LIMIT ?'
  ).all(projectId, limit);
}

export function getPendingApprovals(owner) {
  return db.prepare(
    "SELECT * FROM pending_approvals WHERE owner = ? AND status = 'pending' ORDER BY created_at DESC"
  ).all(owner);
}

export function resolveApproval(approvalId, approved, resolvedBy, comment) {
  const resolve = db.transaction(() => {
    const approval = db.prepare('SELECT * FROM pending_approvals WHERE approval_id = ?').get(approvalId);
    if (!approval || approval.status !== 'pending') return null;

    // Only the field owner can resolve approvals
    if (resolvedBy !== approval.owner) {
      return { error: 'only_owner_can_resolve', owner: approval.owner, attempted_by: resolvedBy };
    }

    const now = new Date().toISOString();
    const newStatus = approved ? 'approved' : 'rejected';

    db.prepare(`
      UPDATE pending_approvals SET status = ?, resolved_at = ?, resolved_by = ?, comment = ?
      WHERE approval_id = ?
    `).run(newStatus, now, resolvedBy, comment || '', approvalId);

    // Log the approval resolution itself
    db.prepare(`
      INSERT INTO change_log (project_id, field, old_value, new_value, changed_by, reason, timestamp, version, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'approval')
    `).run(
      approval.project_id,
      approval.field,
      JSON.stringify({ status: 'pending', proposed_by: approval.proposed_by, proposed_value: approval.proposed_value }),
      JSON.stringify({ status: newStatus, resolved_by: resolvedBy, comment: comment || '' }),
      resolvedBy,
      `Approval ${approvalId} ${newStatus}`,
      now
    );

    if (approved) {
      // Apply the change
      const result = setState(
        approval.project_id,
        approval.field,
        JSON.parse(approval.proposed_value),
        approval.proposed_by,
        `Approved by ${resolvedBy}: ${comment || ''}`,
        { isApproval: true }
      );
      publish('approval_resolved', { project_id: approval.project_id, field: approval.field, approval_id: approvalId, approved: true, proposed_by: approval.proposed_by, resolved_by: resolvedBy });
      return { ...result, approval_status: 'approved' };
    }

    publish('approval_resolved', { project_id: approval.project_id, field: approval.field, approval_id: approvalId, approved: false, proposed_by: approval.proposed_by, resolved_by: resolvedBy });
    return { approval_status: 'rejected', approval_id: approvalId };
  });

  return resolve();
}

export function getStateSubscribers(projectId, field) {
  const row = db.prepare('SELECT subscribers FROM state_kv WHERE project_id = ? AND field = ?').get(projectId, field);
  if (!row) return [];
  try {
    return JSON.parse(row.subscribers);
  } catch {
    return [];
  }
}

export function subscribeToState(projectId, fields, agentName) {
  const sub = db.transaction(() => {
    for (const field of fields) {
      const row = db.prepare('SELECT subscribers FROM state_kv WHERE project_id = ? AND field = ?').get(projectId, field);
      if (row) {
        let subs = [];
        try { subs = JSON.parse(row.subscribers); } catch {}
        if (!subs.includes(agentName)) {
          subs.push(agentName);
          db.prepare('UPDATE state_kv SET subscribers = ? WHERE project_id = ? AND field = ?')
            .run(JSON.stringify(subs), projectId, field);
        }
      }
    }
  });
  sub();
}

// ── Audit functions ──────────────────────────────────

export function saveAuditReport(data) {
  const id = `audit_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO audit_reports (id, project_id, report_type, content, generated_by, generated_at, visibility)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, data.project_id || null, data.report_type, JSON.stringify(data.content), data.generated_by, now, data.visibility || 'all');
  return { id, generated_at: now, visibility: data.visibility || 'all' };
}

export function getAuditReports(projectId, reportType, limit = 20) {
  const conditions = [];
  const params = [];
  if (projectId) { conditions.push('project_id = ?'); params.push(projectId); }
  if (reportType) { conditions.push('report_type = ?'); params.push(reportType); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  return db.prepare(`SELECT * FROM audit_reports ${where} ORDER BY generated_at DESC LIMIT ?`).all(...params, limit);
}

// ── Audit query functions ────────────────────────────

export function auditGetAllState(projectId) {
  if (projectId) {
    return db.prepare('SELECT * FROM state_kv WHERE project_id = ? ORDER BY field').all(projectId);
  }
  return db.prepare('SELECT * FROM state_kv ORDER BY project_id, field').all();
}

export function auditGetChangeLog(filters = {}) {
  const conditions = [];
  const params = [];
  if (filters.project_id) { conditions.push('project_id = ?'); params.push(filters.project_id); }
  if (filters.field) { conditions.push('field = ?'); params.push(filters.field); }
  if (filters.changed_by) { conditions.push('changed_by = ?'); params.push(filters.changed_by); }
  if (filters.source) { conditions.push('source = ?'); params.push(filters.source); }
  if (filters.from) { conditions.push('timestamp >= ?'); params.push(filters.from); }
  if (filters.to) { conditions.push('timestamp <= ?'); params.push(filters.to); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const limit = Math.max(1, Math.min(filters.limit || 100, 500));
  const offset = Math.max(0, filters.offset || 0);
  const total = db.prepare(`SELECT COUNT(*) as cnt FROM change_log ${where}`).get(...params).cnt;
  const rows = db.prepare(`SELECT * FROM change_log ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  return { entries: rows, total, limit, offset };
}

export function auditGenerateComplianceReport(projectId) {
  // Find unauthorized changes: changes where changed_by != owner
  const unauthorized = db.prepare(`
    SELECT cl.* FROM change_log cl
    JOIN state_kv sk ON cl.project_id = sk.project_id AND cl.field = sk.field
    WHERE cl.project_id = ? AND cl.changed_by != sk.owner AND cl.source = 'state'
    ORDER BY cl.timestamp DESC LIMIT 50
  `).all(projectId);

  // Rejected approvals
  const rejected = db.prepare(`
    SELECT * FROM pending_approvals WHERE project_id = ? AND status = 'rejected'
    ORDER BY created_at DESC LIMIT 50
  `).all(projectId);

  // Check if CEO is involved
  const involvesCeo = unauthorized.some(u => u.changed_by === 'CEO') || rejected.some(r => r.proposed_by === 'CEO' || r.owner === 'CEO');

  return {
    type: 'compliance',
    project_id: projectId,
    findings: { unauthorized_changes: unauthorized, rejected_approvals: rejected },
    finding_count: unauthorized.length + rejected.length,
    visibility: involvesCeo ? 'chairman_only' : 'all'
  };
}

export function auditGenerateEfficiencyReport(projectId) {
  const totalChanges = db.prepare('SELECT COUNT(*) as cnt FROM change_log WHERE project_id = ?').get(projectId).cnt;
  const totalApprovals = db.prepare('SELECT COUNT(*) as cnt FROM pending_approvals WHERE project_id = ?').get(projectId).cnt;
  const rejectedApprovals = db.prepare("SELECT COUNT(*) as cnt FROM pending_approvals WHERE project_id = ? AND status = 'rejected'").get(projectId).cnt;
  const resolvedApprovals = db.prepare("SELECT * FROM pending_approvals WHERE project_id = ? AND status != 'pending' AND resolved_at IS NOT NULL").all(projectId);

  // Avg resolution time
  let avgResolutionMs = 0;
  if (resolvedApprovals.length > 0) {
    const totalMs = resolvedApprovals.reduce((sum, a) => {
      return sum + (new Date(a.resolved_at) - new Date(a.created_at));
    }, 0);
    avgResolutionMs = totalMs / resolvedApprovals.length;
  }

  // Most frequently changed fields
  const topFields = db.prepare(`
    SELECT field, COUNT(*) as change_count FROM change_log
    WHERE project_id = ? AND source = 'state'
    GROUP BY field ORDER BY change_count DESC LIMIT 10
  `).all(projectId);

  return {
    type: 'efficiency',
    project_id: projectId,
    metrics: {
      total_state_changes: totalChanges,
      total_approvals: totalApprovals,
      rejected_approvals: rejectedApprovals,
      approval_rejection_rate: totalApprovals > 0 ? (rejectedApprovals / totalApprovals * 100).toFixed(1) + '%' : '0%',
      avg_approval_resolution_ms: Math.round(avgResolutionMs),
      top_changed_fields: topFields,
    },
    visibility: 'all'
  };
}

export function auditGenerateAnomalyReport(projectId) {
  const oneHourAgo = new Date(Date.now() - 3600000).toISOString();

  // Fields changed >5 times in last hour
  const frequentChanges = db.prepare(`
    SELECT field, COUNT(*) as cnt FROM change_log
    WHERE project_id = ? AND timestamp > ? AND source = 'state'
    GROUP BY field HAVING cnt > 5
  `).all(projectId, oneHourAgo);

  // Agents with >3 rejected approvals
  const frequentRejections = db.prepare(`
    SELECT proposed_by, COUNT(*) as cnt FROM pending_approvals
    WHERE project_id = ? AND status = 'rejected'
    GROUP BY proposed_by HAVING cnt > 3
  `).all(projectId);

  // Agent profile relevant_fields reductions
  const profileReductions = db.prepare(`
    SELECT * FROM change_log
    WHERE source = 'agent_profile' AND field LIKE '_profile:relevant_fields%'
    ORDER BY timestamp DESC LIMIT 20
  `).all();

  const involvesCeo = frequentRejections.some(r => r.proposed_by === 'CEO');

  return {
    type: 'anomaly',
    project_id: projectId,
    findings: {
      frequent_field_changes: frequentChanges,
      frequent_rejections: frequentRejections,
      profile_reductions: profileReductions,
    },
    anomaly_count: frequentChanges.length + frequentRejections.length + profileReductions.length,
    visibility: involvesCeo ? 'chairman_only' : 'all'
  };
}

// ── Agent Profile functions ──────────────────────────

export function getAgentProfile(agentId) {
  return db.prepare('SELECT * FROM agent_profiles WHERE agent_id = ?').get(agentId);
}

export function upsertAgentProfile(agentId, data) {
  const now = new Date().toISOString();

  // Record old profile before update
  const oldProfile = db.prepare('SELECT * FROM agent_profiles WHERE agent_id = ?').get(agentId);

  db.prepare(`
    INSERT INTO agent_profiles (agent_id, relevant_fields, critical_fields, participating_projects, participating_channels, last_known_versions, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      relevant_fields = COALESCE(excluded.relevant_fields, relevant_fields),
      critical_fields = COALESCE(excluded.critical_fields, critical_fields),
      participating_projects = COALESCE(excluded.participating_projects, participating_projects),
      participating_channels = COALESCE(excluded.participating_channels, participating_channels),
      last_known_versions = COALESCE(excluded.last_known_versions, last_known_versions),
      updated_at = excluded.updated_at
  `).run(
    agentId,
    JSON.stringify(data.relevant_fields || []),
    JSON.stringify(data.critical_fields || []),
    JSON.stringify(data.participating_projects || []),
    JSON.stringify(data.participating_channels || []),
    JSON.stringify(data.last_known_versions || {}),
    now
  );

  const newProfile = db.prepare('SELECT * FROM agent_profiles WHERE agent_id = ?').get(agentId);

  // Write change_log entries for profile changes
  const fields = ['relevant_fields', 'critical_fields', 'participating_projects', 'participating_channels'];
  for (const f of fields) {
    const oldVal = oldProfile ? oldProfile[f] : null;
    const newVal = newProfile[f];
    if (oldVal !== newVal) {
      db.prepare(`
        INSERT INTO change_log (project_id, field, old_value, new_value, changed_by, reason, timestamp, version, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'agent_profile')
      `).run('_system', `_profile:${f}:${agentId}`, oldVal || null, newVal, agentId, 'profile update', now);
    }
  }

  // Publish audit_alert event
  publish('audit_alert', {
    alert_type: 'profile_change',
    agent_id: agentId,
    old_profile: oldProfile ? { relevant_fields: oldProfile.relevant_fields, critical_fields: oldProfile.critical_fields } : null,
    new_profile: { relevant_fields: newProfile.relevant_fields, critical_fields: newProfile.critical_fields },
    timestamp: now,
  });

  return newProfile;
}

// ── Metacognition: Knowledge Gap Detection ──────────────

export function checkKnowledgeGaps(agentId, projectId) {
  const profile = db.prepare('SELECT * FROM agent_profiles WHERE agent_id = ?').get(agentId);
  if (!profile) {
    return {
      agent_id: agentId,
      project_id: projectId,
      gaps: [],
      critical_gaps: [],
      auto_injected: false,
      error: 'no_profile',
      message: `No agent profile found for ${agentId}. Create one first.`,
    };
  }

  const relevantFields = JSON.parse(profile.relevant_fields || '[]');
  const criticalFields = JSON.parse(profile.critical_fields || '[]');
  const lastKnownVersions = JSON.parse(profile.last_known_versions || '{}');

  if (relevantFields.length === 0) {
    return {
      agent_id: agentId,
      project_id: projectId,
      gaps: [],
      critical_gaps: [],
      auto_injected: false,
      message: 'No relevant fields configured in agent profile.',
    };
  }

  // Find changes missed: fields where current version > last known version
  const gaps = [];
  const criticalGaps = [];

  for (const field of relevantFields) {
    const lastKnown = lastKnownVersions[field] || 0;
    const current = db.prepare(
      'SELECT * FROM state_kv WHERE project_id = ? AND field = ?'
    ).get(projectId, field);

    if (!current) continue; // Field doesn't exist yet

    const currentVersion = current.version || 0;
    if (currentVersion > lastKnown) {
      // Get missed changes from change_log
      const missedChanges = db.prepare(`
        SELECT old_value, new_value, changed_by, reason, timestamp, version
        FROM change_log
        WHERE project_id = ? AND field = ? AND version > ? AND source = 'state'
        ORDER BY version ASC
      `).all(projectId, field, lastKnown);

      const summary = missedChanges
        .map(c => c.reason || `${c.old_value} → ${c.new_value}`)
        .join('; ');

      const gap = {
        field,
        your_version: lastKnown,
        current_version: currentVersion,
        changes_missed: missedChanges.length,
        current_value: current.value,
        summary: summary || `Updated to version ${currentVersion}`,
      };

      gaps.push(gap);

      if (criticalFields.includes(field)) {
        criticalGaps.push(field);
      }
    }
  }

  return {
    agent_id: agentId,
    project_id: projectId,
    gaps,
    critical_gaps: criticalGaps,
    has_gaps: gaps.length > 0,
    auto_injected: false, // Will be set to true by caller after injection
  };
}

export function updateLastKnownVersions(agentId, projectId, fields) {
  const profile = db.prepare('SELECT * FROM agent_profiles WHERE agent_id = ?').get(agentId);
  if (!profile) return null;

  const lastKnownVersions = JSON.parse(profile.last_known_versions || '{}');

  // Update versions for specified fields based on current state
  for (const field of fields) {
    const current = db.prepare(
      'SELECT version FROM state_kv WHERE project_id = ? AND field = ?'
    ).get(projectId, field);
    if (current) {
      lastKnownVersions[field] = current.version;
    }
  }

  // Update profile (this will also trigger change_log via upsertAgentProfile)
  const data = {
    relevant_fields: JSON.parse(profile.relevant_fields),
    critical_fields: JSON.parse(profile.critical_fields),
    participating_projects: JSON.parse(profile.participating_projects),
    participating_channels: JSON.parse(profile.participating_channels),
    last_known_versions: lastKnownVersions,
  };

  return upsertAgentProfile(agentId, data);
}

// ── Reactions CRUD ───────────────────────────────────────

export function addReaction(msgId, agentName, emoji) {
  db.prepare(
    'INSERT OR IGNORE INTO reactions (message_id, agent_name, emoji, created_at) VALUES (?, ?, ?, ?)'
  ).run(msgId, agentName, emoji, new Date().toISOString());
}

export function removeReaction(msgId, agentName, emoji) {
  db.prepare(
    'DELETE FROM reactions WHERE message_id = ? AND agent_name = ? AND emoji = ?'
  ).run(msgId, agentName, emoji);
}

export function getReactions(msgId) {
  return db.prepare(
    'SELECT emoji, agent_name, created_at FROM reactions WHERE message_id = ? ORDER BY created_at ASC'
  ).all(msgId);
}

export function getReactionsForMessages(msgIds) {
  if (!msgIds || msgIds.length === 0) return {};
  const placeholders = msgIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT message_id, emoji, agent_name FROM reactions WHERE message_id IN (${placeholders}) ORDER BY created_at ASC`
  ).all(...msgIds);
  const result = {};
  for (const row of rows) {
    if (!result[row.message_id]) result[row.message_id] = [];
    result[row.message_id].push({ emoji: row.emoji, agent_name: row.agent_name });
  }
  return result;
}

// ── Pinned Messages CRUD ─────────────────────────────────

export function pinMessage(msgId, channelId, pinnedBy) {
  db.prepare(
    'INSERT OR REPLACE INTO pinned_messages (message_id, channel_id, pinned_by, pinned_at) VALUES (?, ?, ?, ?)'
  ).run(msgId, channelId, pinnedBy, new Date().toISOString());
}

export function unpinMessage(msgId) {
  db.prepare('DELETE FROM pinned_messages WHERE message_id = ?').run(msgId);
}

export function getPinnedMessages(channelId) {
  return db.prepare(
    `SELECT p.message_id, p.channel_id, p.pinned_by, p.pinned_at,
            m.from_agent, m.content, m.created_at
     FROM pinned_messages p
     JOIN messages m ON m.id = p.message_id
     WHERE p.channel_id = ? AND (m.deleted = 0 OR m.deleted IS NULL)
     ORDER BY p.pinned_at DESC`
  ).all(channelId);
}

export function isPinned(msgId) {
  return !!db.prepare('SELECT 1 FROM pinned_messages WHERE message_id = ?').get(msgId);
}

// ── Coordination Router ──────────────────────────────

export function routeTask(agentId, projectId, task) {
  // task: { description, affected_fields: string[], uncertainty: 'low'|'medium'|'high', atomic?: boolean }
  const { affected_fields = [], uncertainty = 'low', atomic = false } = task;

  if (affected_fields.length === 0) {
    // No fields specified, default to discussion
    return [{ action: 'start_discussion', reason: 'no affected fields specified' }];
  }

  // Get field metadata for all affected fields
  const fieldMeta = {};
  for (const field of affected_fields) {
    const state = db.prepare('SELECT * FROM state_kv WHERE project_id = ? AND field = ?').get(projectId, field);
    fieldMeta[field] = state; // null if field doesn't exist
  }

  // System-level uncertainty validation
  let effectiveUncertainty = uncertainty;
  const owners = new Set();
  let hasApprovalRequired = false;
  let highChangeFrequency = false;

  for (const field of affected_fields) {
    const meta = fieldMeta[field];
    if (meta) {
      owners.add(meta.owner);
      if (meta.approval_required) hasApprovalRequired = true;

      // Check change frequency: >3 changes in last 24h
      const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
      const changeCount = db.prepare(
        "SELECT COUNT(*) as cnt FROM change_log WHERE project_id = ? AND field = ? AND timestamp > ? AND source = 'state'"
      ).get(projectId, field, oneDayAgo).cnt;
      if (changeCount > 3) highChangeFrequency = true;
    }
  }

  // Auto-upgrade uncertainty
  if (owners.size > 2 && effectiveUncertainty === 'low') effectiveUncertainty = 'medium';
  if (highChangeFrequency && effectiveUncertainty === 'low') effectiveUncertainty = 'medium';
  if (hasApprovalRequired) effectiveUncertainty = 'high';

  // Route each field independently
  const routes = [];

  for (const field of affected_fields) {
    const meta = fieldMeta[field];

    // R5: approval_required → always submit_approval (highest priority)
    if (meta && meta.approval_required) {
      routes.push({ field, action: 'submit_approval', reason: 'approval_required field', approver: meta.approver || 'CEO' });
      continue;
    }

    // R4: field doesn't exist + high uncertainty → discussion
    if (!meta && effectiveUncertainty === 'high') {
      routes.push({ field, action: 'start_discussion', reason: 'new field with high uncertainty' });
      continue;
    }

    // R4 variant: field doesn't exist + low/medium uncertainty
    if (!meta) {
      // Only STATE_ADMINS can create new fields (matches setState permission)
      if (STATE_ADMINS.includes(agentId)) {
        routes.push({ field, action: 'write_state', reason: 'new field creation (admin)' });
      } else {
        routes.push({ field, action: 'start_discussion', reason: 'new field requires admin to create' });
      }
      continue;
    }

    // R2: not owner → submit_approval
    if (meta.owner !== agentId) {
      routes.push({ field, action: 'submit_approval', reason: 'not field owner', owner: meta.owner });
      continue;
    }

    // R1: owner → direct write
    routes.push({ field, action: 'write_state', reason: 'owner direct write' });
  }

  // R3: if atomic=true and routes have mixed actions involving multiple owners → upgrade all to discussion
  if (atomic) {
    const hasMultipleOwners = owners.size > 1;
    const hasMixedActions = new Set(routes.map(r => r.action)).size > 1;
    if (hasMultipleOwners && hasMixedActions) {
      return affected_fields.map(field => ({
        field, action: 'start_discussion', reason: 'atomic operation across multiple owners'
      }));
    }
  }

  // Fallback: if effective uncertainty is high and any field routes to write_state, upgrade to discussion
  if (effectiveUncertainty === 'high') {
    return routes.map(r => r.action === 'write_state'
      ? { ...r, action: 'start_discussion', reason: 'high uncertainty (system-upgraded)' }
      : r
    );
  }

  return routes;
}

export function concludeDiscussion(projectId, conclusions, decidedBy) {
  // conclusions: [{ field, value, reason }]
  // Uses db.transaction for atomic batch write
  // Each field goes through normal setState permission checks

  const conclude = db.transaction(() => {
    const results = [];

    for (const { field, value, reason } of conclusions) {
      const result = setState(
        projectId,
        field,
        value,
        decidedBy,
        `Concluded from discussion: ${reason || ''}`,
        {} // Normal permission checks apply
      );

      // If any field fails (permission denied or version conflict), abort entire batch
      if (result.pending_approval || result.error) {
        // Throw to trigger transaction rollback
        throw new Error(JSON.stringify({
          error: 'conclude_partial_failure',
          failed_field: field,
          reason: result.pending_approval ? 'requires approval' : result.error,
          detail: result
        }));
      }

      results.push({ field, ...result });
    }

    return { success: true, results };
  });

  try {
    return conclude();
  } catch (e) {
    try {
      return JSON.parse(e.message);
    } catch {
      return { error: 'conclude_failed', message: e.message };
    }
  }
}

// ── Public Reports ──────────────────────────────────

export function getPublicAuditReports(projectId, reportType, limit = 20) {
  const conditions = ["visibility = 'all'"];
  const params = [];
  if (projectId) { conditions.push('project_id = ?'); params.push(projectId); }
  if (reportType) { conditions.push('report_type = ?'); params.push(reportType); }
  const where = 'WHERE ' + conditions.join(' AND ');
  return db.prepare(`SELECT * FROM audit_reports ${where} ORDER BY generated_at DESC LIMIT ?`).all(...params, limit);
}

// ── Scheduled Messages ───────────────────────────────────

db.exec(`
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  content TEXT NOT NULL,
  cron_expr TEXT NOT NULL,
  created_by TEXT NOT NULL,
  next_run TEXT,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

/**
 * Simple cron parser — supports a small subset of cron expressions.
 * Returns the next Date when the cron should fire, after `fromDate`.
 */
export function getNextCronRun(cronExpr, fromDate = new Date()) {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minPart, hourPart, domPart, , dowPart] = parts;

  // every N minutes: */N * * * *
  const everyMatch = minPart.match(/^\*\/(\d+)$/);
  if (everyMatch && hourPart === '*' && domPart === '*' && dowPart === '*') {
    const interval = parseInt(everyMatch[1], 10);
    const next = new Date(fromDate);
    next.setSeconds(0, 0);
    next.setMinutes(next.getMinutes() + 1); // at least 1 minute ahead
    // Round up to next interval boundary
    const rem = next.getMinutes() % interval;
    if (rem !== 0) next.setMinutes(next.getMinutes() + (interval - rem));
    return next;
  }

  const minute = parseInt(minPart, 10);
  const hour = parseInt(hourPart, 10);
  if (isNaN(minute) || isNaN(hour)) return null;

  // monthly: 0 H D * *
  if (domPart !== '*' && dowPart === '*') {
    const dom = parseInt(domPart, 10);
    const next = new Date(fromDate);
    next.setSeconds(0, 0);
    next.setHours(hour, minute, 0, 0);
    next.setDate(dom);
    if (next <= fromDate) {
      next.setMonth(next.getMonth() + 1);
      next.setDate(dom);
    }
    return next;
  }

  // weekly: 0 H * * DOW
  if (domPart === '*' && dowPart !== '*') {
    const dow = parseInt(dowPart, 10); // 0=Sun, 1=Mon, ... 6=Sat
    const next = new Date(fromDate);
    next.setSeconds(0, 0);
    next.setHours(hour, minute, 0, 0);
    const currentDow = next.getDay();
    let daysAhead = dow - currentDow;
    if (daysAhead < 0) daysAhead += 7;
    if (daysAhead === 0 && next <= fromDate) daysAhead = 7;
    next.setDate(next.getDate() + daysAhead);
    return next;
  }

  // daily: 0 H * * *
  if (domPart === '*' && dowPart === '*') {
    const next = new Date(fromDate);
    next.setSeconds(0, 0);
    next.setHours(hour, minute, 0, 0);
    if (next <= fromDate) {
      next.setDate(next.getDate() + 1);
    }
    return next;
  }

  return null;
}

export function createSchedule(channel, content, cronExpr, createdBy) {
  const id = `sched_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const nextRun = getNextCronRun(cronExpr);
  if (!nextRun) throw new Error(`Unsupported cron expression: ${cronExpr}`);
  db.prepare(`
    INSERT INTO scheduled_messages (id, channel, content, cron_expr, created_by, next_run)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, channel, content, cronExpr, createdBy, nextRun.toISOString());
  return { id, channel, content, cron_expr: cronExpr, created_by: createdBy, next_run: nextRun.toISOString(), enabled: 1 };
}

export function getSchedules(createdBy) {
  return db.prepare(
    'SELECT * FROM scheduled_messages WHERE created_by = ? ORDER BY created_at DESC'
  ).all(createdBy);
}

export function getSchedulesDue() {
  return db.prepare(
    `SELECT * FROM scheduled_messages WHERE enabled = 1 AND next_run <= datetime('now')`
  ).all();
}

export function deleteSchedule(id, agentName) {
  const sched = db.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(id);
  if (!sched) throw new Error('Schedule not found');
  if (sched.created_by !== agentName) throw new Error('Not authorized to delete this schedule');
  db.prepare('DELETE FROM scheduled_messages WHERE id = ?').run(id);
  return { id, deleted: true };
}

export function updateScheduleNextRun(id, nextRun) {
  db.prepare('UPDATE scheduled_messages SET next_run = ? WHERE id = ?').run(nextRun, id);
}

// ── Files ─────────────────────────────────────────────────

db.exec(`
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  channel TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`);

export function saveFile(id, originalName, mimeType, size, sha256, uploadedBy, channel) {
  db.prepare(`
    INSERT INTO files (id, original_name, mime_type, size, sha256, uploaded_by, channel)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, originalName, mimeType, size, sha256, uploadedBy, channel);
  return { id, original_name: originalName, mime_type: mimeType, size, sha256, uploaded_by: uploadedBy, channel };
}

export function getFile(id) {
  return db.prepare('SELECT * FROM files WHERE id = ?').get(id);
}

export function getFileMeta(id) {
  return db.prepare('SELECT * FROM files WHERE id = ?').get(id);
}

export function closeDb() {
  try { db.close(); } catch {}
}

export default db;
