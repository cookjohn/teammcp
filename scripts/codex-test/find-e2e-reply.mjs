import db from 'better-sqlite3';
const conn = db('C:/Users/ssdlh/Desktop/teammcp/data/teammcp.db');
const rows = conn.prepare(
  "SELECT created_at, channel_id, from_agent, substr(content,1,80) AS content " +
  "FROM messages WHERE content LIKE '%6gt3b%' OR content LIKE '%E2E-PTY%' " +
  "OR (from_agent='CodexTest' AND created_at > '2026-05-26T05:11:00') " +
  "ORDER BY created_at DESC LIMIT 20"
).all();
console.table(rows);
