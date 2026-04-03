#!/usr/bin/env node
import Database from 'better-sqlite3';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'teammcp.db');
const db = new Database(DB_PATH);

// Ensure reports_to column exists
try { db.exec('ALTER TABLE agents ADD COLUMN reports_to TEXT DEFAULT NULL'); } catch {}

const CHAIN = {
  'A': 'PM', 'B': 'PM', 'C': 'PM', 'Figma': 'PM',
  'PM': 'CEO', 'HR': 'CEO', 'CTO': 'CEO', 'Product': 'CEO',
  'SecTest': 'CTO', 'StressTest': 'CTO',
  'Marketing': 'CEO', 'MarketIntel': 'CEO',
  'WeChatOps': 'CEO', 'XHSOps': 'CEO',
  'DocFormatter': 'CEO', 'PolicyWriter': 'CEO',
  'ManagementExpert': 'CEO', 'PhilosophyExpert': 'CEO',
  'CEO': 'Chairman', 'Audit': 'Chairman',
};

console.log('=== Initialize Command Chain ===\n');
const stmt = db.prepare('UPDATE agents SET reports_to = ? WHERE name = ?');
let updated = 0;
for (const [agent, superior] of Object.entries(CHAIN)) {
  const result = stmt.run(superior, agent);
  if (result.changes > 0) {
    console.log(`  ${agent} → ${superior}`);
    updated++;
  }
}
db.close();
console.log(`\n=== Done: ${updated} agents updated ===`);
