#!/usr/bin/env node
/**
 * Fix corrupted role data in the database.
 * Reads correct role values from the known agent definitions
 * and updates any corrupted entries (containing U+FFFD or garbled text).
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'teammcp.db');

// Correct role definitions (from register-agents.sh + known agents)
const CORRECT_ROLES = {
  'CEO': 'CEO',
  'PM': '项目经理',
  'A': '后端开发/数据采集工程师',
  'B': '前端开发工程师',
  'C': '全栈开发工程师',
  'Figma': 'UI/UX 设计',
  'HR': '人力资源',
  'Audit': '审计',
  'CTO': 'CTO',
  'Product': '产品经理',
  'QA': 'QA 测试工程师',
  'SecTest': '安全测试工程师',
  'StressTest': '压力测试工程师',
  'Marketing': '营销/宣传专员',
  'MarketIntel': '市场情报分析师',
  'Chairman': '董事长',
};

const db = new Database(DB_PATH);
const allAgents = db.prepare('SELECT name, role FROM agents').all();

console.log('=== Fix Corrupted Role Data ===\n');
console.log(`Found ${allAgents.length} agents in database.\n`);

let fixed = 0;
let skipped = 0;

const updateStmt = db.prepare('UPDATE agents SET role = ? WHERE name = ?');

for (const agent of allAgents) {
  const correctRole = CORRECT_ROLES[agent.name];
  if (!correctRole) {
    console.log(`[SKIP] ${agent.name} — no known correct role`);
    skipped++;
    continue;
  }

  if (agent.role === correctRole) {
    console.log(`[OK]   ${agent.name} — role already correct: "${agent.role}"`);
    continue;
  }

  // Check if corrupted (contains U+FFFD or doesn't match expected)
  const isCorrupted = agent.role && (agent.role.includes('\ufffd') || agent.role !== correctRole);
  if (isCorrupted || !agent.role) {
    console.log(`[FIX]  ${agent.name} — "${agent.role || '(empty)'}" → "${correctRole}"`);
    updateStmt.run(correctRole, agent.name);
    fixed++;
  }
}

db.close();

console.log(`\n=== Done: ${fixed} fixed, ${skipped} skipped ===`);
