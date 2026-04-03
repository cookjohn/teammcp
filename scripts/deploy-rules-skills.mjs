#!/usr/bin/env node
/**
 * One-time batch deployment script for TeamMCP
 * Deploys rules and skills to ALL existing agent directories.
 *
 * Usage:
 *   node deploy-rules-skills.mjs
 *   AGENTS_BASE_DIR=/path/to/agents node deploy-rules-skills.mjs
 */

import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync, cpSync, writeFileSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

// ── Configuration ──────────────────────────────────────────────────────────
const AGENTS_DIR = process.env.AGENTS_BASE_DIR || 'C:\\Users\\ssdlh\\Desktop\\agents';

// Template source directories (checked in order of priority)
const TEMPLATE_SOURCES = [
  {
    rules: 'C:\\Users\\ssdlh\\Desktop\\teammcp\\templates\\rules',
    skills: 'C:\\Users\\ssdlh\\Desktop\\teammcp\\templates\\skills',
  },
  {
    rules: join(AGENTS_DIR, 'PM', 'projects', 'teammcp-templates', 'rules'),
    skills: join(AGENTS_DIR, 'PM', 'projects', 'teammcp-templates', 'skills'),
  },
  {
    rules: null,
    skills: join(AGENTS_DIR, 'CTO', '.claude', 'skills'),
  },
];

// Fallback team-rules content if no template source has it
const FALLBACK_TEAM_RULES = `# 团队通用规则

本文件定义所有 Agent 必须遵守的通用规则。各 Agent 的 CLAUDE.md 应引用本规则。

---

## 1. 指挥链规则

- 董事长（Chairman）在群聊中发布的信息，**只能由 CEO 接收并分派**
- 除非董事长明确指定了具体 Agent，其他 Agent 不得直接处理董事长的群聊指令
- 收到董事长指令后的正确流程：CEO 接收 → CEO 判断分派 → 对应 Agent 执行
- 如果董事长在私聊中直接给某 Agent 下达指令，该 Agent 可直接执行，但需同步告知 CEO

## 2. Subagent 规则

- **除 CEO 和 Audit 外**，所有 Agent 接到任务后必须通过 subagent（子代理）执行具体工作
- 主会话（主进程）不能被长时间阻塞，必须保持消息接收能力
- subagent 执行完毕后，主会话负责汇报结果和状态更新
- 如果任务非常简短（如回复一条消息、查询一个状态），可在主会话直接处理，无需启动 subagent

## 3. Task 系统规则

- 所有任务必须通过 Task 系统全程管理，流程如下：
  1. **create_task** — 创建任务，明确标题、描述、指派人
  2. **update_task** — 开始执行时更新状态为 \`doing\`，过程中可更新进度描述
  3. **done_task** — 任务完成后标记为 \`done\`，附上完成说明
- 任务状态流转：\`todo\` → \`doing\` → \`done\`
- 禁止绕过 Task 系统直接执行任务，确保所有工作可追踪、可审计
- 任务粒度建议：一个 Task 对应一个可独立验收的交付物

## 4. GitHub Push 规则

- **默认不执行 git push**，所有代码变更仅保留在本地
- 只有在董事长**主动提出**推送请求时才执行 push
- CEO 无权批准 push，只有董事长有此权限
- push 前必须确认：
  - 代码已通过测试（C 验收通过）
  - 没有敏感信息（密钥、token、.env 等）泄露
  - commit message 规范清晰
- 禁止 force push 到 main/master 分支

## 5. State 系统规则

- 关键决策和状态变更必须同步写入 State 系统（通过 set_state 工具）
- 需要写入 State 的场景包括：
  - 项目阶段变更（如从开发转入测试）
  - 重要技术决策（如架构选型、方案变更）
  - 阻塞问题和解决方案
  - 里程碑完成记录
- State 的 key 命名规范：\`项目名/类别/具体项\`，如 \`arc-agi-3/status/phase\`
- 其他 Agent 可通过 get_state / subscribe_state 获取最新状态，减少重复沟通

## 6. 沟通规范

- **群聊**：使用 \`send_message\` 工具，发送到对应频道
  - 项目相关讨论发到项目频道
  - 全员通知发到 #general
- **私聊**：使用 \`send_dm\` 工具，用于一对一沟通
  - 任务分配、进度催促、敏感问题使用私聊
- **沟通原则**：
  - 收到消息后及时响应，不已读不回
  - 任务完成后主动汇报，不等催促
  - 遇到阻塞及时上报，不自行搁置
  - 跨角色协调通过 PM 或在公共频道进行，避免私下绕过流程
`;

// ── Helper functions ───────────────────────────────────────────────────────

function findRulesSource() {
  for (const src of TEMPLATE_SOURCES) {
    if (src.rules) {
      const rulesFile = join(src.rules, 'team-rules.md');
      if (existsSync(rulesFile)) {
        console.log(`  [rules source] ${rulesFile}`);
        return rulesFile;
      }
    }
  }
  console.log('  [rules source] Using fallback (embedded content)');
  return null;
}

function findSkillsSources() {
  const skillDirs = [];
  const targetSkills = ['check-inbox', 'update-state', 'daily-standup', 'submit-for-review'];

  for (const src of TEMPLATE_SOURCES) {
    if (!src.skills || !existsSync(src.skills)) continue;

    const entries = readdirSync(src.skills, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = join(src.skills, entry.name);
      const skillMd = join(skillPath, 'SKILL.md');
      if (existsSync(skillMd)) {
        // Only add if not already found (first source wins)
        if (!skillDirs.find(s => s.name === entry.name)) {
          skillDirs.push({ name: entry.name, path: skillPath });
        }
      }
    }
  }

  return skillDirs;
}

function copyDirRecursive(src, dest) {
  cpSync(src, dest, { recursive: true, force: false });
}

// ── Main ───────────────────────────────────────────────────────────────────

console.log('=== TeamMCP Rules & Skills Deployment ===\n');
console.log(`Agents directory: ${AGENTS_DIR}\n`);

// Validate agents directory
if (!existsSync(AGENTS_DIR)) {
  console.error(`ERROR: Agents directory not found: ${AGENTS_DIR}`);
  process.exit(1);
}

// Discover template sources
console.log('Discovering template sources...');
const rulesSourceFile = findRulesSource();
const skillSources = findSkillsSources();

if (skillSources.length > 0) {
  console.log(`  [skills sources] Found ${skillSources.length} skill(s): ${skillSources.map(s => s.name).join(', ')}`);
} else {
  console.log('  [skills sources] No skill templates found — skipping skills deployment');
}
console.log('');

// Discover agent directories
const entries = readdirSync(AGENTS_DIR, { withFileTypes: true });
const agentDirs = entries
  .filter(e => e.isDirectory())
  .map(e => ({ name: e.name, path: join(AGENTS_DIR, e.name) }));

console.log(`Found ${agentDirs.length} agent(s): ${agentDirs.map(a => a.name).join(', ')}\n`);

// Deploy
let rulesDeployed = 0;
let skillsDeployed = 0;
let agentsProcessed = 0;

for (const agent of agentDirs) {
  agentsProcessed++;
  const agentLabel = `[${agent.name}]`;

  // ── Deploy rules ──
  const rulesDir = join(agent.path, '.claude', 'rules');
  const rulesTarget = join(rulesDir, 'team-rules.md');

  if (existsSync(rulesTarget)) {
    console.log(`  ${agentLabel} rules: already exists — skipped`);
  } else {
    mkdirSync(rulesDir, { recursive: true });
    if (rulesSourceFile) {
      copyFileSync(rulesSourceFile, rulesTarget);
    } else {
      writeFileSync(rulesTarget, FALLBACK_TEAM_RULES, 'utf-8');
    }
    rulesDeployed++;
    console.log(`  ${agentLabel} rules: deployed team-rules.md`);
  }

  // ── Deploy skills ──
  if (skillSources.length === 0) continue;

  const skillsDir = join(agent.path, '.claude', 'skills');
  mkdirSync(skillsDir, { recursive: true });

  for (const skill of skillSources) {
    const skillTarget = join(skillsDir, skill.name);
    if (existsSync(skillTarget)) {
      console.log(`  ${agentLabel} skill ${skill.name}: already exists — skipped`);
    } else {
      copyDirRecursive(skill.path, skillTarget);
      skillsDeployed++;
      console.log(`  ${agentLabel} skill ${skill.name}: deployed`);
    }
  }
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log('\n=== Deployment Summary ===');
console.log(`  Agents processed : ${agentsProcessed}`);
console.log(`  Rules deployed   : ${rulesDeployed}`);
console.log(`  Skills deployed  : ${skillsDeployed}`);
console.log('\nDone.');
