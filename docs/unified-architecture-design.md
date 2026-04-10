# TeamMCP 统一架构设计文档

> **版本**: v1.0  
> **作者**: CTO  
> **日期**: 2026-04-10  
> **状态**: 设计定稿  
> **说明**: 本文档合并 PTY Daemon 两层架构 (v1.1) 与记忆系统 (v2.0 Final) 为统一设计蓝图，取代两份独立文档，作为实施唯一参考。

---

## 目录

1. [整体架构总览](#1-整体架构总览)
2. [两层进程模型](#2-两层进程模型)
3. [记忆系统完整设计（Server 层）](#3-记忆系统完整设计server-层)
4. [Daemon 轻量事件过滤如何服务记忆系统](#4-daemon-轻量事件过滤如何服务记忆系统)
5. [Dashboard 整合](#5-dashboard-整合)
6. [消息推送优先级配合记忆系统](#6-消息推送优先级配合记忆系统)
7. [跨平台方案](#7-跨平台方案)
8. [分阶段实施计划（统一排期）](#8-分阶段实施计划统一排期)

附录:
- [风险与缓解（统一）](#风险与缓解统一)
- [文件结构变更（统一）](#文件结构变更统一)

---

## 1. 整体架构总览

### 1.1 三子系统定位

| 子系统 | 层级 | 职责 | 变更频率 |
|--------|------|------|----------|
| PTY Daemon | Layer 1 | Agent 进程生命周期管理 | 极低 |
| HTTP Server | Layer 2 | 业务逻辑、API、SSE、Dashboard | 高 |
| Memory System | Layer 2 内部 | 组织记忆：采集、分类、存储、检索 | 随 Server 部署 |

**核心原则**: 记忆系统完全运行在 Layer 2 内部。Daemon 保持精简，零业务逻辑。

### 1.2 统一架构图

```
┌──────────────────────────────────────────────────────────────────┐
│                    Layer 2: HTTP Server (可随时重启)               │
│                                                                  │
│  ┌─────────┐ ┌─────────┐ ┌───────────┐ ┌──────────────────────┐ │
│  │ REST API│ │  SSE    │ │ Dashboard │ │   Memory Engine      │ │
│  │ 80+路由 │ │ 连接池  │ │ Terminal  │ │ ┌──────────────────┐ │ │
│  └─────────┘ └─────────┘ │ LLM Config│ │ │ WriteQueue       │ │ │
│  ┌─────────┐ ┌─────────┐ │ Memory UI │ │ │ LLM Pipeline     │ │ │
│  │EventBus │ │ SQLite  │ └───────────┘ │ │ Provider Registry│ │ │
│  │         │ │ (DB)    │               │ │ FTS5 Index       │ │ │
│  └─────────┘ └─────────┘               │ └──────────────────┘ │ │
│  ┌─────────┐ ┌─────────┐               └──────────────────────┘ │
│  │WebSocket│ │ 限流    │                                        │
│  │Terminal │ │ 批处理  │                                        │
│  └────┬────┘ └─────────┘                                        │
└───────┼─────────────────────────────────────────────────────────┘
        │ IPC (Named Pipe {uid} / Unix Socket)
        │ JSON-RPC 2.0 + 版本握手
┌───────┼─────────────────────────────────────────────────────────┐
│       │         Layer 1: PTY Daemon (常驻，极少重启)              │
│       ▼                                                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐          │
│  │IPC Server│ │PTY 进程池│ │Scrollback│ │事件缓冲区│          │
│  │JSON-RPC  │ │node-pty  │ │100KB/agt │ │(1000条)  │          │
│  └──────────┘ └────┬─────┘ └──────────┘ └──────────┘          │
│                    │                                            │
│              claude.cmd x N                                     │
└─────────────────────────────────────────────────────────────────┘
```

### 1.3 数据流概览

```
Agent PTY 输出 ──> Daemon scrollback ──> IPC ──> Layer 2 WebSocket Terminal
Agent PTY 退出 ──> Daemon 事件缓冲 ───> IPC ──> Layer 2 EventBus ──> Memory System
EventBus 事件  ─────────────────────────────────> Memory WriteQueue ──> LLM 分类 ──> SQLite
cc_metrics     ─────────────────────────────────> Memory 周期扫描  ──> LLM 分类 ──> SQLite
messages       ─────────────────────────────────> Memory 钩子      ──> LLM 分类 ──> SQLite
Memory 新记忆  ─────────────────────────────────> SSE 推送 (Critical/Important) ──> Dashboard/Agent
```

---

## 2. 两层进程模型

### 2.1 问题分析

当前单进程架构下，PTY 进程是 HTTP Server 的子进程。服务重启时：

| 影响 | 说明 |
|------|------|
| Agent PTY 全部死亡 | 父进程退出，所有 `claude.cmd` 子进程被杀掉 |
| 会话上下文丢失 | Agent 对话历史、工作状态中断 |
| SSE 连接断开 | 所有 Agent 长连接中断 |
| 内存状态丢失 | 崩溃计时器、批处理缓冲等归零 |

即使只修改一行路由代码，重启服务也会导致全部 Agent 停机。

### 2.2 两层职责划分

| 维度 | Layer 1: PTY Daemon | Layer 2: HTTP Server |
|------|--------------------|--------------------|
| 核心职责 | PTY 进程生命周期管理 | 业务逻辑、API、Memory System |
| 代码量 | ~1000 行（精简） | ~3000+ 行 |
| 入口文件 | `pty-daemon.mjs` | `index.mjs` |
| 变更频率 | 极低 | 高 |
| 重启影响 | 重启 = 所有 PTY 丢失 | 重启 = 零 PTY 影响 |
| 对外端口 | 无（仅 IPC） | HTTP :3100, WS |
| 攻击面 | 极小 | 正常 Web 攻击面 |

### 2.3 IPC 设计

**传输层**：

| 平台 | 方式 | 地址 |
|------|------|------|
| Windows | Named Pipe | `\\.\pipe\teammcp-pty-{uid}` |
| macOS/Linux | Unix Socket | `~/.teammcp/pty-daemon.sock` |

选择 Named Pipe / UDS 而非 TCP：无需占用端口、无网络暴露、性能优于 TCP。

**协议**: JSON-RPC 2.0，支持请求/响应和单向通知。

**版本握手**: Layer 2 连接后首先执行握手，主版本号必须匹配，超时 3 秒。

```jsonc
// Layer 2 → Layer 1: 握手请求
{
  "jsonrpc": "2.0",
  "method": "handshake",
  "params": {
    "protocol_version": "1.0",
    "client": "http-server",
    "client_version": "2.0.0"
  },
  "id": 0
}

// Layer 1 → Layer 2: 握手响应
{
  "jsonrpc": "2.0",
  "result": {
    "protocol_version": "1.0",
    "server": "pty-daemon",
    "server_version": "1.0.0",
    "compatible": true,
    "agents_running": 5
  },
  "id": 0
}
```

### 2.4 PTY 命令（Layer 2 → Layer 1）

```jsonc
// pty.spawn — 启动 Agent PTY
{
  "method": "pty.spawn",
  "params": {
    "agent": "A", "cmd": "claude.cmd", "args": ["--resume"],
    "cwd": "C:/Users/ssdlh/Desktop/agents/A",
    "env": { "TEAMMCP_HOME": "..." }, "cols": 200, "rows": 50
  },
  "id": 1
}

// pty.kill — 停止 Agent PTY
{ "method": "pty.kill", "params": { "agent": "A", "signal": "SIGTERM" }, "id": 2 }

// pty.resize — 调整终端尺寸
{ "method": "pty.resize", "params": { "agent": "A", "cols": 200, "rows": 60 }, "id": 3 }

// pty.write — 向 PTY 发送输入
{ "method": "pty.write", "params": { "agent": "A", "data": "hello\r" }, "id": 4 }

// pty.list — 列出所有运行中的 PTY
{ "method": "pty.list", "id": 5 }

// pty.status — 获取单个 Agent 状态
{ "method": "pty.status", "params": { "agent": "A" }, "id": 6 }

// pty.scrollback — 获取回滚缓冲区
{ "method": "pty.scrollback", "params": { "agent": "A", "lines": 100 }, "id": 7 }
```

### 2.5 PTY 事件（Layer 1 → Layer 2，单向通知）

```jsonc
// pty.output — 输出流 (base64 编码)
{
  "jsonrpc": "2.0",
  "method": "pty.output",
  "params": { "agent": "A", "data": "QnVpbGRpbmcuLi4=", "encoding": "base64" }
}

// pty.exit — 进程退出
{
  "jsonrpc": "2.0",
  "method": "pty.exit",
  "params": { "agent": "A", "exitCode": 1, "signal": null, "timestamp": 1712700000 }
}
```

### 2.6 输出流编码与限流

PTY 输出统一 base64 编码后放入 JSON，避免 ANSI 转义序列破坏 JSON 解析。

```
限流策略:
  1. 合并窗口: 每 50ms 合并一次 PTY 输出
  2. 单 Agent 速率上限: 200KB/s（超出截断，附 [truncated]）
  3. 全局速率上限: 1MB/s（所有 Agent 合计，超出按 Agent 公平降级）
  4. 无订阅者时: 仅写入 scrollback，不推送
```

### 2.7 订阅机制

```jsonc
// 订阅指定 Agent 输出
{ "method": "pty.subscribe", "params": { "agent": "A" }, "id": 10 }
// 订阅全部 Agent（重连时使用）
{ "method": "pty.subscribe_all", "id": 11 }
// 取消订阅
{ "method": "pty.unsubscribe", "params": { "agent": "A" }, "id": 12 }
```

### 2.8 Daemon 健康检查

Layer 2 每 10 秒 ping Daemon：

```jsonc
// ping
{ "jsonrpc": "2.0", "method": "ping", "id": 999 }
// pong — 携带 Daemon 状态
{
  "jsonrpc": "2.0",
  "result": {
    "uptime": 86400, "agents": 5, "memory_mb": 120,
    "ipc_clients": 1, "buffer_usage": 0.15
  },
  "id": 999
}
```

连续 3 次无响应（30 秒）判定 Daemon 失联，Layer 2 触发告警并尝试自动重启。

### 2.9 Scrollback Buffer

每个 Agent 维护 100KB 环形缓冲区（Ring Buffer），新输出追加至尾部，超出从头淘汰。用途：Dashboard 终端打开时显示历史输出、Layer 2 重连后恢复终端。

### 2.10 事件缓冲区与溢出策略

Layer 2 断开期间，Daemon 缓冲待回放事件：

```javascript
const EVENT_BUFFER = {
  maxItems: 1000,              // 最大事件条数
  maxBytes: 5 * 1024 * 1024,   // 最大 5MB
  maxAge: 30 * 60 * 1000,      // 最大保留 30 分钟
};
```

**三级溢出策略**：

| 级别 | 触发条件 | 处理方式 |
|------|----------|----------|
| L1 正常 | 条数 < 800 且内存 < 4MB | 正常缓冲 |
| L2 警告 | 条数 >= 800 或内存 >= 4MB | 日志告警；丢弃 `pty.started` 类低优先级事件 |
| L3 溢出 | 条数 >= 1000 或内存 >= 5MB 或超龄 | FIFO 淘汰最旧事件；保留最近 500 条；生成溢出摘要 |

溢出摘要事件 `buffer_overflow`：Layer 2 重连时先收到摘要，再收到保留事件，感知数据丢失。

### 2.11 Daemon 优雅重启

PTY Daemon 更新时，按四阶段有序执行：

```
Phase 1: 准备 — Layer 2 调用 daemon.prepare_restart，获取状态快照写入 daemon-state.json
Phase 2: 有序停止 — 可选通知 Agent，等待空闲（超时 10s），Daemon 退出
Phase 3: 快速重启 — Layer 2 检测断开，等 1s，启动新 Daemon，握手
Phase 4: 自动恢复 — 读取快照，按优先级逐个 spawn Agent (CEO 优先级 1)
```

预计中断时间：15-30 秒。

### 2.12 冷启动与重连

```
启动脚本 (start-prod.ps1):
  Step 1: 检查 PID → Daemon 存活则跳过，否则 spawn detached → 等 IPC 就绪 (最多 5s)
  Step 2: HTTP Server 连接 Daemon → subscribe_all → pty.list 同步状态 → replay_pending → HTTP 监听
```

重启 HTTP Server 时序：
```
PTY Daemon:  ████████████████████████████████████████████  持续运行
HTTP Server: ██████████ ▌停止▐ ████████████████████████  短暂中断
Agent PTY:   ████████████████████████████████████████████  不受影响
Agent SSE:   ████████████ ╳ ── 重连 ─ ████████████████████ 自动恢复
```

---

## 3. 记忆系统完整设计（Server 层）

### 3.1 概述

记忆系统是 Layer 2 内部的**组织级自动记忆引擎**，零人工干预地从 EventBus、cc_metrics、messages 三大源采集事件，经 LLM 智能分类/摘要后持久化，供 Agent 和 Dashboard 检索。

### 3.2 模块划分

| 模块文件 | 职责 | 依赖 |
|---------|------|------|
| `memory.mjs` | 核心引擎：采集、去重、WriteQueue | eventbus.mjs, db.mjs |
| `memory-llm.mjs` | LLM 管道：多 Provider 客户端、分类、摘要 | memory.mjs, db.mjs |
| `memory-providers.mjs` | Provider 注册表、生命周期管理 | memory.mjs |
| `providers/sqlite-provider.mjs` | SQLite 持久化 | db.mjs |
| `providers/team-search-provider.mjs` | 跨 agent 搜索 | db.mjs |
| `providers/skill-nudge-provider.mjs` | 技能沉淀 | memory-llm.mjs |

### 3.3 数据流

```
原始事件 --> WriteQueue(串行,上限500) --> 预处理(裁剪2000字符/脱敏) --> SHA-256 hash 去重
--> 事件缓冲 --> 批量 LLM 分类 (5条/批, 30s超时)
--> {Critical/Important --> 深度摘要, Lesson/Routine --> 仅分类}
--> llm_usage 统计写入
--> Provider.onEvent() --> SQLite 持久化 + FTS5 索引
--> SSE 推送 (Critical/Important) --> Dashboard / Agent
```

### 3.4 WriteQueue（单写入队列）

三个事件源统一进内存队列串行化写入，避免 SQLite 并发写冲突。

```javascript
class WriteQueue {
    constructor(maxSize = 500) {
        this.queue = [];
        this.maxSize = maxSize;
        this.processing = false;
    }

    enqueue(event) {
        if (this.queue.length >= this.maxSize) {
            // 超限时优先丢弃 Routine 级别事件
            const routineIdx = this.queue.findIndex(e => e.level_hint === 'routine');
            if (routineIdx >= 0) this.queue.splice(routineIdx, 1);
            else this.queue.shift();  // 无 Routine 则 FIFO
        }
        this.queue.push(event);
        this.drain();
    }

    async drain() {
        if (this.processing || this.queue.length === 0) return;
        this.processing = true;
        while (this.queue.length > 0) {
            const event = this.queue.shift();
            try { await processEvent(event); }
            catch (err) { console.error('[Memory] WriteQueue error:', err.message); }
        }
        this.processing = false;
    }
}
```

### 3.5 三大事件源

#### a. EventBus 订阅（实时）

```javascript
const EVENT_INTEREST = {
    'state_changed':          'important',
    'approval_requested':     'important',
    'approval_resolved':      'important',
    'agent_online':           'routine',
    'knowledge_gap_detected': 'lesson',
    'audit_alert':            'critical',
};

subscribeAll((event) => {
    const hint = EVENT_INTEREST[event.type] || 'routine';
    writeQueue.enqueue({ source_type: 'eventbus', source_id: `eb_${event.type}_${event.timestamp}`,
                         raw: event, level_hint: hint });
});
```

#### b. cc_metrics 周期扫描（每 5 分钟）

扫描位点 `last_scanned_id` 持久化到 `state_kv`，重启后从断点恢复。每次最多扫 200 条。关注事件：CrashLoopDetected (critical)、StopFailure (critical)、SessionStart/End (routine)、PostToolUse 含 error (lesson)。

#### c. messages 钩子（关键词过滤）

筛选条件：System 告警消息、包含关键词（决定/方案/架构/崩溃/bug/error 等）的消息、@提及 >= 3 人的协调消息。

### 3.6 事件预处理

```javascript
function preprocessEvent(event) {
    let raw = JSON.stringify(event.raw);
    if (raw.length > 2000) raw = raw.slice(0, 1950) + '... [truncated]';
    raw = raw.replace(/(?:sk-|AKIA|ghp_|token[=:])\S{10,}/gi, '[REDACTED]');
    raw = raw.replace(/password['":\s]*[^\s,}]+/gi, 'password: [REDACTED]');
    event.raw_text = raw;
    return event;
}
```

### 3.7 去重机制

- **event_hash**: SHA-256(source_type + agent + content前500字符)，截取前 16 hex
- **内存窗口**: 1 小时内 hash Map，每 10 分钟清理过期
- **DB 检查**: `memories.event_hash` + 1小时内重复判定

### 3.8 LLM Pipeline

**批处理**: 5 条/批，最长 30 秒攒批超时。

**分类 Prompt**:
```
级别: critical(崩溃/安全/阻塞) | important(决策/架构/里程碑) | lesson(经验/踩坑) | routine(常规)
类别: error / decision / milestone / debug / security / pattern / general
输出: JSON 数组 [{index, level, category, title(<80字符), summary(<200字符), tags}]
```

**深度摘要 Prompt** (仅 Critical/Important):
```
输出: {title, summary(<500字符), root_cause(可选), action_items[], tags[], related_context}
```

**重试**: 指数退避，base 2s，最多 3 次。

**Fallback**: LLM 失败时使用 level_hint 作为分类，仅保留原始摘要。

**回归测试**: `golden_set.json` 50 条标注事件，85% 准确率门槛。

### 3.9 LLM 多 Provider 架构

```javascript
class LLMClient {
    // 从 llm_config 表加载解密后的配置
    // 支持 Anthropic / OpenAI / OpenRouter / Custom (OpenAI 兼容)
    // 每次调用写入 llm_usage 统计
    // 日预算检查: isDailyBudgetExceeded()
    // 热重载: EventBus 'llm_config_changed' → reloadConfig()
}
```

| 场景 | 默认模型 | Token 预算 |
|------|---------|-----------|
| 批量分类 | Haiku (可配置) | ~2000 输入 / ~500 输出 per batch |
| 深度摘要 | Sonnet (可配置) | ~1500 输入 / ~300 输出 per event |
| Session 回顾 | 摘要模型 | ~3000 输入 / ~500 输出 |
| 自然语言查询 | 摘要模型 | ~2000 输入 / ~500 输出 |

### 3.10 Provider 插拔架构

```javascript
class MemoryProvider {
    constructor(name, config = {}) { ... }
    async init() { }
    async onEvent(event) { }
    async query(query) { }
    async shutdown() { }
}

class ProviderRegistry {
    register(provider) { ... }
    async initAll() { ... }
    async dispatchEvent(event) { ... }  // 分发到所有启用的 Provider
    async queryAll(query) { ... }       // 聚合所有 Provider 的查询结果
    async shutdownAll() { ... }
}
```

内置 Provider:
- **SQLiteProvider** (必选): 写入 memories + memories_fts，事务保证一致性
- **TeamSearchProvider**: 聚合 messages_fts + memories_fts，统一搜索视图
- **SkillNudgeProvider**: 检测重复工作模式 (阈值 10 次)，生成技能建议

### 3.11 数据模型

#### memories 主表

```sql
CREATE TABLE IF NOT EXISTS memories (
    id              TEXT PRIMARY KEY,               -- UUID v4
    agent           TEXT NOT NULL,
    session_id      TEXT,
    level           TEXT NOT NULL DEFAULT 'routine', -- critical/important/lesson/routine
    category        TEXT NOT NULL DEFAULT 'general', -- error/decision/milestone/debug/security/pattern/general
    title           TEXT NOT NULL,                  -- LLM 生成 (<80字符)
    summary         TEXT NOT NULL,                  -- LLM 生成 (<500字符)
    raw_event       TEXT,                           -- 原始事件 JSON (裁剪后, 最大 2000 字符)
    source_type     TEXT NOT NULL,                  -- eventbus/cc_metrics/message/manual
    source_id       TEXT,
    event_hash      TEXT NOT NULL,
    tags            TEXT DEFAULT '[]',              -- JSON 数组
    related_ids     TEXT DEFAULT '[]',
    ttl_days        INTEGER DEFAULT 90,
    pinned          INTEGER DEFAULT 0,
    last_accessed_at TEXT,
    access_count    INTEGER DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent);
CREATE INDEX IF NOT EXISTS idx_memories_level ON memories(level);
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(event_hash);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
CREATE INDEX IF NOT EXISTS idx_memories_expires ON memories(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memories_accessed ON memories(last_accessed_at) WHERE last_accessed_at IS NOT NULL;
```

#### memories_fts 全文索引

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    id UNINDEXED, agent UNINDEXED, level UNINDEXED,
    title, summary, tags
);
```

#### memory_sessions 会话快照

```sql
CREATE TABLE IF NOT EXISTS memory_sessions (
    id          TEXT PRIMARY KEY,
    agent       TEXT NOT NULL,
    session_id  TEXT NOT NULL UNIQUE,
    started_at  TEXT NOT NULL,
    ended_at    TEXT NOT NULL,
    duration_s  INTEGER,
    tool_count  INTEGER DEFAULT 0,
    error_count INTEGER DEFAULT 0,
    summary     TEXT NOT NULL,                  -- LLM 生成
    key_actions TEXT DEFAULT '[]',
    lessons     TEXT DEFAULT '[]',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

#### llm_config 配置表

```sql
CREATE TABLE IF NOT EXISTS llm_config (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    purpose         TEXT NOT NULL UNIQUE,       -- 'classify' / 'summarize'
    provider        TEXT NOT NULL,              -- anthropic/openai/openrouter/custom
    model           TEXT NOT NULL,
    api_key_enc     TEXT NOT NULL,              -- AES-256-GCM 加密
    api_key_iv      TEXT NOT NULL,
    api_key_tag     TEXT NOT NULL,
    base_url        TEXT,
    max_tokens      INTEGER DEFAULT 1024,
    temperature     REAL DEFAULT 0.0,
    timeout_ms      INTEGER DEFAULT 30000,
    max_daily_cost_usd REAL DEFAULT 1.0,
    enabled         INTEGER DEFAULT 1,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO llm_config (purpose, provider, model, api_key_enc, api_key_iv, api_key_tag)
VALUES
    ('classify',  'anthropic', 'claude-haiku-4-5-20251001', '', '', ''),
    ('summarize', 'anthropic', 'claude-sonnet-4-20250514',  '', '', '');
```

#### llm_usage 调用统计表

```sql
CREATE TABLE IF NOT EXISTS llm_usage (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    provider        TEXT NOT NULL,
    model           TEXT NOT NULL,
    purpose         TEXT NOT NULL,              -- classify/summarize/session_review/ask
    input_tokens    INTEGER DEFAULT 0,
    output_tokens   INTEGER DEFAULT 0,
    estimated_cost_usd REAL DEFAULT 0,
    latency_ms      INTEGER,
    success         INTEGER DEFAULT 1,
    error_message   TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_llm_usage_date ON llm_usage(created_at);
CREATE INDEX idx_llm_usage_purpose ON llm_usage(purpose);
```

### 3.12 Level 分级与 TTL

| 级别 | 含义 | TTL | 示例 |
|------|------|-----|------|
| critical | 紧急/系统性问题 | 365 天 | 崩溃、安全事件、阻塞性 bug |
| important | 关键决策和里程碑 | 180 天 | 架构选型、方案变更 |
| lesson | 经验教训 | 90 天 | 调试技巧、踩坑记录 |
| routine | 常规操作 | 30 天 | 普通工具调用、状态更新 |

**访问加权续期**: `access_count > 5` 的过期记忆自动续期 TTL 的 50%。

### 3.13 记忆检索 API

#### REST API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/memories` | GET | 列表查询（agent/level/category/时间范围筛选） |
| `/api/memories/search?q=` | GET | FTS5 全文搜索（含 snippet 高亮） |
| `/api/memories/ask` | POST | LLM 自然语言查询 |
| `/api/memories/:id` | GET | 记忆详情 |
| `/api/memories/:id` | PATCH | 更新 (pinned/level) |
| `/api/memories/:id` | DELETE | 删除（同步删 FTS） |
| `/api/memories` | POST | 手动添加 |
| `/api/memories/sessions` | GET | 会话快照列表 |
| `/api/memories/trigger-review` | POST | 手动触发回顾 |

#### MCP 工具

- **`recall_memory(question)`**: Agent 主动查询组织记忆，3 级渐进加载 (L0 摘要/L1 完整/L2 关联上下文)
- **`ask_memory(question)`**: 自然语言查询，FTS5 取 top 10 候选 → LLM 生成结构化回答

### 3.14 Session 回顾

检测到 `SessionEnd` 事件时，对 session 内 cc_metrics 采样（最多 20 条），发送给摘要模型生成会话总结。写入 `memory_sessions` 表。短 session (< 5 条 metrics) 跳过。

### 3.15 维护机制

- **TTL 清理**: 每天凌晨 3:00，先续期高频访问记忆，再删除真正过期的（同步删 FTS 条目）
- **FTS 重建**: 每周日凌晨 3:00 执行 `INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`

---

## 4. Daemon 轻量事件过滤如何服务记忆系统

### 4.1 核心原则

**Daemon 不运行任何记忆逻辑**。Daemon 仅负责观察 PTY 输出和退出事件，通过 IPC 透传给 Layer 2。记忆系统的一切智能处理（采集、分类、存储）全部在 Layer 2 完成。

### 4.2 事件流转路径

```
┌─ PTY Daemon (Layer 1) ─────────────────────────────┐
│                                                      │
│  claude.cmd 异常退出                                  │
│       │                                              │
│       ▼                                              │
│  pty.exit 事件 ──┬── Layer 2 在线? ──> IPC 推送      │
│                  └── Layer 2 离线? ──> 事件缓冲区     │
│                                                      │
│  PTY 输出 ──> scrollback (100KB) + IPC 推送           │
│               (无订阅者时仅写 scrollback)              │
└──────────────────────────────────────────────────────┘
                    │
                    │ IPC (pty.exit / pty.output)
                    ▼
┌─ HTTP Server (Layer 2) ─────────────────────────────┐
│                                                      │
│  IPC 接收 pty.exit                                    │
│       │                                              │
│       ▼                                              │
│  crashDetection 逻辑 (process-manager.mjs)            │
│       │                                              │
│       ▼                                              │
│  EventBus.publish('agent_crashed', {agent, exitCode}) │
│       │                                              │
│       ▼                                              │
│  Memory System EventBus 订阅者                        │
│       │                                              │
│       ▼                                              │
│  WriteQueue → LLM 分类 (Critical) → SQLite 持久化     │
│       │                                              │
│       ▼                                              │
│  SSE 推送 Critical 事件 → CEO / Dashboard             │
└──────────────────────────────────────────────────────┘
```

### 4.3 Layer 2 重启期间的事件保护

1. Layer 2 断开时，Daemon 将 `pty.exit` 等事件存入**事件缓冲区**（上限 1000 条 / 5MB / 30 分钟）
2. Layer 2 重连后执行 `pty.subscribe_all`，Daemon 自动**回放缓冲事件**
3. 回放的事件进入 Layer 2 正常处理流程，EventBus 发布对应事件
4. 记忆系统的 EventBus 订阅者**自动拾取**回放事件，无需特殊处理
5. WriteQueue 的队列 + 背压机制**天然处理突发回放**（队列上限 500，超限丢弃 Routine）

### 4.4 PTY 输出与记忆的关系

PTY 输出**不直接**输入记忆系统（太噪声）。记忆系统的结构化数据源是：
- **cc_metrics**: Agent 上报的结构化指标（SessionStart/End、ToolUse、Error 等）
- **EventBus 事件**: 系统级事件（状态变更、审批、告警等）
- **messages**: 团队沟通中的关键消息

PTY 输出仅服务于：Dashboard 终端查看、scrollback 历史回溯。

---

## 5. Dashboard 整合

Dashboard 作为统一管理界面，整合三大能力：终端查看、记忆管理、LLM 配置与监控。

### 5.1 终端查看

```
浏览器 ──WebSocket /ws/terminal?agent=A──> Layer 2 ──IPC subscribe──> Daemon
                                                                        │
连接时: Layer 2 通过 pty.scrollback 获取历史输出，一次性推送           pty.onData
实时: Daemon pty.output base64 → Layer 2 decode → WebSocket 推送       │
输入: WebSocket → Layer 2 → IPC pty.write → Daemon → PTY              claude.cmd
```

### 5.2 记忆管理

- **时间线视图**: 按时间倒序，左侧级别颜色标注（红/橙/蓝/灰）
- **筛选器**: agent / 级别 / 类别 / 时间范围
- **搜索框**: FTS5 全文搜索，snippet 高亮
- **统计卡片**: 各级别数量、今日新增、活跃 agent 分布
- **详情面板**: 标题 + 级别徽章 + 摘要 + 标签 + 原始事件(折叠) + 关联消息
- **管理操作**: 置顶 (pin)、删除、提升/降级 level、手动添加、导出

### 5.3 LLM 配置

| 功能 | 说明 |
|------|------|
| Provider 选择 | Anthropic / OpenAI / OpenRouter / 自定义 Base URL |
| 分类模型配置 | provider + model + max_tokens + temperature |
| 摘要模型配置 | 独立于分类模型，可使用不同 Provider |
| API Key 管理 | AES-256-GCM 加密存储，Dashboard 仅显示末 4 位 (`****xF3a`) |
| 测试连接 | 一键验证 API Key 和模型可用性 |
| 日预算设置 | 每个 purpose 独立 `max_daily_cost_usd` |

API 端点:
```
GET  /api/config/llm          -- 读取配置 (API Key 脱敏)
PUT  /api/config/llm          -- 更新配置 (requireAuth)
POST /api/config/llm/test     -- 测试连接
GET  /api/config/llm/usage    -- 成本统计 (?period=day|week|month)
```

热加载: `PUT /api/config/llm` → DB 更新 → EventBus `llm_config_changed` → LLMClient 自动 reloadConfig()。

### 5.4 成本监控

- **今日/本周/本月** Tab 切换
- **调用次数和 token 用量**: 按 purpose 分类 (classify/summarize/session_review/ask)
- **成本趋势折线图**: 按天，最多 30 天
- **日预算告警**: 80% 阈值高亮，100% 自动降级为 fallback 规则分类

成本估算（500 条/天有价值事件）：分类 ~$0.05 + 摘要 ~$0.15 + 回顾 ~$0.10 = **约 $0.30/天**。

### 5.5 Daemon 状态

- **健康指示器**: 绿(正常) / 黄(延迟高) / 红(失联)，基于 ping/pong
- **显示信息**: uptime、内存占用、缓冲区使用率、Agent 数量
- API 端点: `GET /api/pty-daemon/health`

---

## 6. 消息推送优先级配合记忆系统

参考现有消息推送优化设计（三级优先级 + 合并窗口），定义记忆事件的推送集成。

### 6.1 记忆事件的推送优先级

| 优先级 | 记忆级别 | 推送行为 |
|--------|----------|----------|
| **now** (即时) | Critical 记忆事件 | SSE 立即推送给 CEO + Dashboard，携带 `interrupt: true` |
| **next** (下一批次) | Important 记忆事件 | 进入合并窗口，随下一次 SSE batch 推送 |
| **later** (低优先级) | Lesson / Routine | 不主动推送，仅通过 API 查询 |

### 6.2 集成机制

```javascript
// memory.mjs — 新记忆创建后
function notifyNewMemory(memory) {
    // 1. 发布 EventBus 事件
    publish('memory_created', {
        id: memory.id, agent: memory.agent, level: memory.level,
        title: memory.title, summary: memory.summary
    });

    // 2. SSE 推送 (仅 Critical/Important)
    if (memory.level === 'critical') {
        pushWithPriority('CEO', { type: 'memory_created', memory }, 'now');
        pushToDashboard({ type: 'memory_created', memory });
    } else if (memory.level === 'important') {
        pushWithPriority('CEO', { type: 'memory_created', memory }, 'next');
        pushToDashboard({ type: 'memory_created', memory });
    }
}
```

### 6.3 预算告警推送

日预算达到 80% 时，`budget_warning` 事件以 **now** 优先级推送给 CEO 和 Dashboard。

---

## 7. 跨平台方案

### 7.1 IPC 层

| 平台 | 传输方式 | 路径 |
|------|----------|------|
| Windows | Named Pipe | `\\.\pipe\teammcp-pty-{uid}` |
| macOS/Linux | Unix Socket | `~/.teammcp/pty-daemon.sock` |

Node.js `net` 模块提供统一 API，仅路径格式不同。Named Pipe 路径追加用户 UID 实现多实例隔离。

### 7.2 PTY 层

现有平台分离 (`process-manager-impl-win.mjs` / `process-manager-impl-mac.mjs`) 的核心 PTY 逻辑迁入 Daemon，平台差异封装在 Daemon 内部。

### 7.3 Daemon 进程管理

`child_process.spawn` 以 `detached: true` + `unref()` 跨平台启动 Daemon。PID 文件标准方案跨平台通用。

### 7.4 记忆系统

纯 Layer 2 模块，无平台特定代码。SQLite、FTS5、LLM API 调用均跨平台。

### 7.5 Dev/Prod 隔离

| | Prod | Dev |
|--|------|-----|
| HTTP 端口 | :3100 | :3200 |
| Named Pipe | `teammcp-pty-{uid}` | `teammcp-pty-dev-{uid}` |
| PID 文件 | `~/.teammcp/pty-daemon.pid` | `~/.teammcp-dev/pty-daemon.pid` |
| Agent 目录 | `Desktop/agents/` | `Desktop/agents-dev/` |
| 数据目录 | `Desktop/teammcp/` | `Desktop/teammcp-dev/` |

两套 Daemon 实例完全独立，互不干扰。

---

## 8. 分阶段实施计划（统一排期）

> PM 建议：两大变更（PTY 分层 + 记忆系统）不并行，先稳定基础设施再叠加智能能力。

### Phase 1: PTY Daemon 核心 (Week 1-2)

**目标**: 双进程架构可用，HTTP Server 重启不影响 Agent。

| 任务 | 产出 | 预估 |
|------|------|------|
| 抽取 PTY 逻辑 → `pty-daemon.mjs` | Daemon 独立管理 PTY 启停 | 1-2天 |
| 实现 IPC Server/Client (JSON-RPC 2.0) | `pty-daemon-ipc.mjs` + `pty-daemon-client.mjs` | 2-3天 |
| 协议版本握手 + 健康检查 (ping/pong) | 握手逻辑 + 10s 心跳 | 0.5天 |
| 修改启动脚本 (`start-prod.ps1` / `start-dev.ps1`) | 双进程管理、PID 文件检测 | 0.5天 |
| 集成测试 | 重启 HTTP Server，验证 PTY 不中断 | 1-2天 |

**验收标准**: 启动多个 Agent → 重启 HTTP Server → Agent PTY 不中断、SSE 自动重连、Dashboard 终端恢复。

### Phase 2: Daemon 增强 + 记忆系统基础 (Week 3-4)

**目标**: Daemon 容错完备；记忆系统可采集存储事件。

| 任务 | 产出 | 预估 |
|------|------|------|
| Daemon: 事件缓冲区 + 三级溢出策略 | 缓冲区逻辑 + 溢出摘要 | 1天 |
| Daemon: 优雅重启流程 + 状态快照 | daemon-state.json + 四阶段流程 | 1天 |
| Daemon: 输出流限流 (50ms合并 + 200KB/s + 1MB/s) | 限流模块 | 0.5天 |
| Memory: 核心引擎 `memory.mjs` | WriteQueue + EventBus订阅 + cc_metrics扫描 + 去重 | 1.5天 |
| Memory: SQLite Schema | memories + memories_fts + memory_sessions + llm_config + llm_usage | 0.5天 |
| Memory: SQLiteProvider | 写入 + 基础查询 + FTS搜索 | 1天 |
| Memory: REST API (基础) | GET/POST/PATCH/DELETE /api/memories | 0.5天 |
| 集成测试 | 事件采集→SQLite存储、Daemon缓冲回放 | 1天 |

**验收标准**: EventBus 事件自动采集并持久化，WriteQueue 串行写入正常，Daemon 缓冲区在 Layer 2 断开期间工作。

### Phase 3: LLM 管道 + Dashboard (Week 5-6)

**目标**: LLM 智能分类/摘要可用，Dashboard 可配置管理。

| 任务 | 产出 | 预估 |
|------|------|------|
| LLM Pipeline: LLMClient 多 Provider 抽象 | `memory-llm.mjs` | 1天 |
| LLM Pipeline: 批量分类 + 深度摘要 | 分类/摘要 prompt + 批处理 | 1天 |
| LLM Pipeline: 重试(指数退避) + fallback | 3次重试 + 规则降级 | 0.5天 |
| Dashboard: LLM 配置页面 | Provider选择/模型配置/API Key管理/测试连接 | 1.5天 |
| Dashboard: 成本监控面板 | 调用统计/趋势图/预算告警 | 1天 |
| Dashboard: Daemon 健康指示器 | 绿/黄/红状态 + `/api/pty-daemon/health` | 0.5天 |
| Memory 检索 API + MCP 工具 | /search (FTS5) + /ask (LLM) + recall_memory() | 1天 |
| LLM 配置 REST API + 热加载 | GET/PUT /api/config/llm + EventBus 广播 | 0.5天 |
| 集成测试 | 端到端: 事件→LLM分类→存储→API查询→Dashboard展示 | 1天 |

**验收标准**: 事件经 LLM 自动分类摘要，Dashboard 可切换 Provider 并查看成本，FTS5 搜索含 snippet 可用。

### Phase 4: 整合测试 + 优化 (Week 7-8)

**目标**: 全子系统联调、跨平台验证、性能调优。

| 任务 | 产出 | 预估 |
|------|------|------|
| 全子系统集成测试 | PTY Daemon + HTTP Server + Memory 联调 | 2天 |
| 跨平台测试 | Windows 主测 + macOS 辅测 | 1天 |
| Golden set 分类准确率验证 | 50 条标注事件 >= 85% | 0.5天 |
| 性能调优 | 缓冲区大小/限流参数/批处理参数 | 1天 |
| Session 回顾完善 | SessionEnd 触发 + 回顾摘要 | 0.5天 |
| TTL 清理 + FTS 重建 | 定时任务验证 | 0.5天 |
| SkillNudgeProvider | 重复模式检测 + 技能建议 | 1天 |
| Provider 架构 + ProviderRegistry | memory-providers.mjs + 配置管理 | 0.5天 |
| Dashboard 记忆视图完善 | 时间线 + 筛选 + 详情 + 管理操作 | 1天 |

**验收标准**: 全链路稳定运行，跨平台无异常，分类准确率达标，TTL 清理和 FTS 重建正常。

---

## 风险与缓解（统一）

### 基础设施风险

| 风险 | 等级 | 缓解措施 |
|------|------|----------|
| IPC 连接中断 | 中 | 自动重连（指数退避）+ 操作队列重试 |
| PTY Daemon 崩溃 | 高 | PID 文件监控 + 自动重启；代码精简 (~1000行) 降低概率 |
| Named Pipe 安全 | 中 | 路径含 UID 隔离 + ACL 限制 |
| 双进程调试复杂度 | 低 | 统一日志格式和目录；Daemon 健康检查端点 |
| IPC 序列化开销 | 低 | PTY 输出为流式小消息，开销可忽略 |
| Daemon 版本不匹配 | 低 | 握手阶段强制版本校验，不兼容时触发优雅重启 |

### LLM 与成本风险

| 风险 | 等级 | 缓解措施 |
|------|------|----------|
| 事件量大导致 LLM 调用过多 | 中 | 攒批 (5条/批)、Routine 不深度摘要、WriteQueue 超限丢弃 |
| 模型费用超预算 | 中 | 日预算上限 + Dashboard 成本监控 + 80% 预警 |
| LLM 响应慢 | 中 | 30s 超时 + fallback 规则分类 + 指数退避重试 |
| Provider 切换后不兼容 | 低 | 测试连接验证 + golden set 回归测试 |

### 数据风险

| 风险 | 等级 | 缓解措施 |
|------|------|----------|
| 记忆条目无限增长 | 中 | TTL 分级清理 (30-365天) + 访问加权续期 |
| 敏感信息泄露到记忆 | 中 | 预处理阶段脱敏 (token/密码/密钥) |
| API Key 泄露 | 中 | AES-256-GCM 加密存储，API 仅显示末 4 位 |
| SQLite 写入冲突 | 低 | WriteQueue 串行化 + 事务 + WAL 模式 |
| 事件突增 (event storm) | 中 | WriteQueue 缓冲 (上限500) + 攒批 + Daemon 事件缓冲 (上限1000) |
| 重启后丢失扫描进度 | 低 | cc_metrics last_scanned_id 持久化到 state_kv |

---

## 文件结构变更（统一）

```
server/
├── pty-daemon.mjs                  # [新增] PTY Daemon 入口 (~300行)
├── pty-daemon-ipc.mjs              # [新增] IPC Server, JSON-RPC (~400行)
├── pty-daemon-client.mjs           # [新增] IPC Client, HTTP Server 侧 (~300行)
├── memory.mjs                      # [新增] 记忆核心引擎：采集/去重/WriteQueue (~400行)
├── memory-llm.mjs                  # [新增] LLM 管道：多Provider/分类/摘要/统计 (~500行)
├── memory-providers.mjs            # [新增] Provider 注册表/接口定义 (~200行)
├── providers/
│   ├── sqlite-provider.mjs         # [新增] SQLite 持久化 Provider (~250行)
│   ├── team-search-provider.mjs    # [新增] 跨 agent 搜索 Provider (~100行)
│   └── skill-nudge-provider.mjs    # [新增] 技能沉淀 Provider (~100行)
├── tests/
│   ├── golden_set.json             # [新增] 分类回归基准集 (50条)
│   └── test-classify-accuracy.mjs  # [新增] 准确率验证脚本
├── pty-manager.mjs                 # [改造] 改为通过 IPC 代理终端数据
├── process-manager.mjs             # [改造] 改为 IPC Client 封装
├── process-manager-impl-win.mjs    # [迁移] 核心 PTY 逻辑迁入 pty-daemon
├── process-manager-impl-mac.mjs    # [迁移] 核心 PTY 逻辑迁入 pty-daemon
├── index.mjs                       # [改造] 启动时连接 Daemon + 初始化记忆系统
├── router.mjs                      # [改造] PTY 路由走 IPC Client + 新增记忆/LLM 路由
├── sse.mjs                         # [微调] 新增 memory_created 推送
├── eventbus.mjs                    # [微调] 新增事件类型
├── db.mjs                          # [改造] 新增 memories/llm 相关建表
└── ...

新增 EventBus 事件类型:
  memory_created       -- 新记忆创建 (SSE 推送)
  message_saved        -- 消息保存 (记忆采集钩子)
  llm_config_changed   -- LLM 配置变更 (热加载)
  budget_warning       -- 日预算告警

新增 Router 路由:
  GET/POST/PATCH/DELETE /api/memories[/:id]
  GET    /api/memories/search
  POST   /api/memories/ask
  GET    /api/memories/sessions
  POST   /api/memories/trigger-review
  GET    /api/config/llm
  PUT    /api/config/llm
  POST   /api/config/llm/test
  GET    /api/config/llm/usage
  GET    /api/pty-daemon/health
```

---

*文档结束 -- 本文档为 TeamMCP 统一架构设计唯一参考，取代 `two-layer-architecture.md` (v1.1) 和 `memory-system-final.md` (v2.0)。*
