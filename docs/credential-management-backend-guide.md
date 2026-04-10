# Dashboard 凭证管理后端实现手册

> 面向外部开发者（xiaomi/minimax），指导在 TeamMCP Server 中新增 4 个凭证管理 API 端点。

---

## 目录

1. [现有架构概览](#1-现有架构概览)
2. [路由组织 (router.mjs)](#2-路由组织-routermjs)
3. [认证与权限](#3-认证与权限)
4. [数据库层 (db.mjs)](#4-数据库层-dbmjs)
5. [凭证管理核心逻辑](#5-凭证管理核心逻辑)
6. [新接口设计方案（4个接口）](#6-新接口设计方案4个接口)
7. [错误处理规范](#7-错误处理规范)
8. [实现步骤](#8-实现步骤)
9. [测试用例 (curl 示例)](#9-测试用例-curl-示例)

---

## 1. 现有架构概览

### 技术栈

TeamMCP Server 是纯 Node.js HTTP 服务器，**不使用 Express 或任何 HTTP 框架**。所有路由和中间件逻辑均为手写。

### 核心文件结构

```
server/
├── index.mjs              # HTTP server 创建、端口绑定、入口
├── router.mjs             # (~2090 行) 所有 HTTP 路由处理，核心业务逻辑
├── db.mjs                 # (~2119 行) SQLite 数据库层，better-sqlite3，prepared statements
├── credential-manager.mjs # (830 行) OAuth 凭证统一管理：Token Store、刷新引擎、分发
├── credential-lease.mjs   # (633 行) Path A agent 的 OAuth token 租约机制
├── auth.mjs               # (49 行) API Key 认证中间件
├── auth-token-utils.mjs   # (166 行) HMAC bearer token 的 mint/verify + 重放保护
├── sse.mjs                # Server-Sent Events 推送
├── eventbus.mjs           # 事件发布总线
├── redact.mjs             # 敏感信息脱敏工具
├── process-manager.mjs    # Agent 进程管理（启动/停止/截图）
└── public/                # Dashboard 静态前端文件
```

### 请求生命周期

一个请求的完整处理流程：

```
客户端请求
  │
  ▼
CORS Headers 设置（Access-Control-Allow-*）
  │
  ▼
OPTIONS 预检请求 → 204 直接返回
  │
  ▼
静态文件判断（GET 且非 /api/ 开头 → 读取 public/ 目录）
  │
  ▼
API 路由匹配（if/else 链）
  │
  ├── 无需认证的端点（/api/register, /api/health 等）
  │
  └── 需要认证的端点
      │
      ▼
    requireAuth(req, res) → 失败返回 401
      │
      ▼
    权限检查（角色、STATE_ADMINS 等）
      │
      ▼
    业务逻辑处理
      │
      ▼
    SSE 推送通知（pushToAgent / pushToAgents）
      │
      ▼
    json(res, data, statusCode) 返回 JSON 响应
```

### 关键工具函数

| 函数 | 位置 | 说明 |
|------|------|------|
| `readBody(req)` | router.mjs:136 | 读取并解析请求体 JSON，最大 8MB，UTF-8 校验 |
| `json(res, data, status)` | router.mjs:175 | 发送 JSON 响应，Content-Type 为 `application/json; charset=utf-8` |
| `requireAuth(req, res)` | auth.mjs:39 | 认证中间件，成功时设置 `req.agent`，失败返回 401 |
| `pushToAgent(name, event)` | sse.mjs | 向单个 agent 推送 SSE 事件 |
| `pushToAgents(names, event)` | sse.mjs | 向多个 agents 推送 SSE 事件 |

---

## 2. 路由组织 (router.mjs)

### 路由入口

所有路由位于 `handleRequest(req, res)` 函数内（router.mjs:182）。使用简单的 `if/else` 链匹配 method + path：

```javascript
export async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ... 路由匹配
}
```

### 路由匹配模式

**精确路径匹配：**
```javascript
if (method === 'GET' && path === '/api/agents') {
  // 处理逻辑
}
```

**带参数的路径匹配（使用 startsWith + split 提取参数）：**
```javascript
if (method === 'GET' && path.match(/^\/api\/credentials\/lease\/[^/]+$/)) {
  const name = path.split('/')[4]; // 提取 agent_name
  // ...
}
```

**也可以使用 startsWith + endsWith 组合：**
```javascript
if (method === 'GET' && path.startsWith('/api/tasks/') && path.endsWith('/history')) {
  const taskId = path.split('/')[3]; // 提取 task_id
  // ...
}
```

### URL Query 参数获取

```javascript
const url = new URL(req.url, `http://${req.headers.host}`);
const limit = parseInt(url.searchParams.get('limit') || '50', 10);
const offset = parseInt(url.searchParams.get('offset') || '0', 10);
const agent = url.searchParams.get('agent'); // 可能为 null
```

### 请求体解析

```javascript
const body = await readBody(req);
// body 已经是解析后的 JavaScript 对象
// 如果解析失败，会抛出异常（在外层 try/catch 中捕获）
```

`readBody` 的行为：
- 最大 8MB（`MAX_BODY_SIZE = 8 * 1024 * 1024`）
- 超出返回 413 状态码
- 强制 UTF-8 编码，拒绝其他 charset
- 自动 `JSON.parse`，解析失败抛异常

### 响应返回

**始终使用 `json()` 函数：**
```javascript
return json(res, { success: true, data: result }, 200);
return json(res, { error: 'Not found' }, 404);
```

`json()` 函数签名：
```javascript
function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
```

---

## 3. 认证与权限

### API Key 认证

所有 API 请求通过 `Authorization: Bearer tmcp_xxxxx` 头部认证。

```javascript
// auth.mjs 中的 requireAuth 实现：
export function requireAuth(req, res) {
  const agent = authenticate(req);
  if (!agent) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized: invalid or missing API key' }));
    return false;
  }
  req.agent = agent;  // 认证成功后，agent 对象挂载到 req 上
  return true;        // 返回 true 表示认证通过
}
```

**使用方式（在路由中）：**
```javascript
if (method === 'GET' && path === '/api/some-endpoint') {
  if (!requireAuth(req, res)) return;  // 认证失败已自动返回 401
  // req.agent 现在可用
  const agentName = req.agent.name;
  // ...
}
```

认证还支持 URL query 参数回退（用于 EventSource/SSE）：`?key=tmcp_xxxxx`

### Agent 对象结构

`req.agent` 是从 `agents` 表查询的完整行对象：

```javascript
{
  name: 'Chairman',        // agent 名称（主键）
  role: 'chairman',        // 角色
  api_key: 'tmcp_xxx...',  // API Key
  status: 'online',        // 状态：online / offline / busy
  last_seen: '2026-04-09T10:00:00Z',
  created_at: '2026-01-01T00:00:00Z',
  reports_to: null,        // 上级
  use_resume: 1,           // 是否启用 resume
  auth_mode: 'oauth',      // 认证模式：oauth / api_key
  api_provider: null,      // API 提供商（api_key 模式用）
  api_base_url: null,
  api_auth_token: null,
  api_model: null,
  auth_strategy: 'legacy'  // 认证策略：legacy / path_a
}
```

### 角色权限常量

在 db.mjs 中定义了三组权限数组：

```javascript
// db.mjs:737 — 管理者角色，可以管理任务、agent 等
export const MANAGERS = getRoleConfig().managers || ['CEO', 'PM', 'Product', 'CTO'];

// db.mjs:1157 — State 管理员，可以创建和修改 state
export const STATE_ADMINS = getRoleConfig().state_admins || ['CEO', 'CTO', 'PM', 'human'];

// db.mjs:1159 — 审计角色
export const AUDIT_ROLES = getRoleConfig().audit_roles || ['Audit'];
```

### Dashboard 权限检查模式

对于新的 Dashboard 端点，建议使用如下权限检查模式：

```javascript
// Chairman + CEO 可访问
if (method === 'GET' && path === '/api/dashboard/credentials/overview') {
  if (!requireAuth(req, res)) return;
  const allowed = ['Chairman', 'CEO'];
  if (!allowed.includes(req.agent.name)) {
    return json(res, { error: 'Forbidden: insufficient permissions' }, 403);
  }
  // ... 业务逻辑
}

// 仅 Chairman 可访问（最敏感）
if (method === 'GET' && path === '/api/dashboard/credentials/token-store') {
  if (!requireAuth(req, res)) return;
  if (req.agent.name !== 'Chairman') {
    return json(res, { error: 'Forbidden: Chairman only' }, 403);
  }
  // ... 业务逻辑
}
```

### HMAC Bearer（仅供了解）

`credential-lease.mjs` 中的 `verifyHmacBearer(req, agentName)` 用于 Path A agent 的本地回环认证。Dashboard 接口**不需要**使用此机制，使用标准的 `requireAuth` + 角色检查即可。

---

## 4. 数据库层 (db.mjs)

### 数据库基本信息

- **ORM**: 无，使用 `better-sqlite3` 直接操作
- **路径**: `${TEAMMCP_HOME}/data/teammcp.db`
- **Pragma 配置**: WAL 模式、外键约束、5s 忙等待、UTF-8 编码
- **模式**: 同步 API（`better-sqlite3` 不是异步的）

```javascript
import Database from 'better-sqlite3';
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
```

### 相关表结构

#### agents 表

```sql
CREATE TABLE agents (
  name TEXT PRIMARY KEY,
  role TEXT,
  api_key TEXT UNIQUE NOT NULL,
  status TEXT DEFAULT 'offline',
  last_seen DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  reports_to TEXT DEFAULT NULL,
  use_resume INTEGER DEFAULT 1,
  auth_mode TEXT DEFAULT "oauth",
  api_provider TEXT,
  api_base_url TEXT,
  api_auth_token TEXT,
  api_model TEXT,
  auth_strategy TEXT DEFAULT "legacy"
);
```

关键字段说明：
- `auth_mode`: `"oauth"` (共享 OAuth) 或 `"api_key"` (独立 API Key)
- `auth_strategy`: `"legacy"` (传统凭证分发) 或 `"path_a"` (按需租约)

#### credential_leases 表

```sql
CREATE TABLE credential_leases (
  lease_id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  leased_at INTEGER NOT NULL,        -- epoch ms
  expires_at INTEGER NOT NULL,       -- epoch ms
  reason TEXT NOT NULL,              -- 'start', 'heartbeat' 等
  requested_by TEXT NOT NULL         -- 'process-manager' 等
);
CREATE INDEX idx_credential_leases_agent ON credential_leases(agent);
```

#### credential_lease_revocations 表

```sql
CREATE TABLE credential_lease_revocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT NOT NULL,
  lease_id TEXT,                      -- 可为 NULL（手动撤销全部）
  revoked_at INTEGER NOT NULL,       -- epoch ms
  revoked_by TEXT NOT NULL,          -- 执行撤销的 agent 名
  reason TEXT
);
CREATE INDEX idx_credential_lease_revocations_agent ON credential_lease_revocations(agent_name);
```

#### credential_lease_rate 表

```sql
CREATE TABLE credential_lease_rate (
  agent_name TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,     -- 窗口起始时间 epoch ms
  count INTEGER NOT NULL,            -- 窗口内请求次数
  blocked INTEGER NOT NULL DEFAULT 0 -- 是否被限流封锁
);
```

#### path_a_busy_agents 表

```sql
CREATE TABLE path_a_busy_agents (
  agent_name TEXT PRIMARY KEY,
  locked_at INTEGER NOT NULL,        -- epoch ms
  heartbeat_ts INTEGER NOT NULL,     -- epoch ms, 每 5s 更新
  owner_pid INTEGER NOT NULL         -- 持有锁的进程 PID
);
CREATE INDEX idx_path_a_busy_heartbeat ON path_a_busy_agents(heartbeat_ts);
```

#### change_log 表（审计日志，新端点可用于记录配置变更）

```sql
CREATE TABLE change_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  changed_by TEXT NOT NULL,
  reason TEXT,
  timestamp TEXT NOT NULL,
  version INTEGER NOT NULL,
  source TEXT DEFAULT 'state'        -- 'state', 'approval', 'agent_profile' 等
);
-- 注意：change_log 是 append-only，有触发器禁止 UPDATE 和 DELETE
```

### 现有 CRUD 模式

**Prepared Statement 模式（推荐）：**

```javascript
// 在模块顶部定义 prepared statement
const getAgentByName = db.prepare('SELECT * FROM agents WHERE name = ?');

// 在函数中使用
export function getAgentByName(name) {
  return db.prepare('SELECT * FROM agents WHERE name = ?').get(name);
}
```

**查询单条记录 — `.get()`：**
```javascript
const agent = db.prepare('SELECT * FROM agents WHERE name = ?').get(agentName);
// 返回对象或 undefined
```

**查询多条记录 — `.all()`：**
```javascript
const agents = db.prepare('SELECT name, role, status FROM agents').all();
// 返回数组
```

**执行更新 — `.run()`：**
```javascript
db.prepare('UPDATE agents SET auth_strategy = ? WHERE name = ?')
  .run('path_a', agentName);
// 返回 { changes: 1, lastInsertRowid: ... }
```

**事务操作 — `db.transaction()`：**
```javascript
const updateWithLog = db.transaction((agentName, newStrategy, changedBy) => {
  db.prepare('UPDATE agents SET auth_strategy = ? WHERE name = ?')
    .run(newStrategy, agentName);
  db.prepare('INSERT INTO change_log (...) VALUES (...)').run(...);
});
updateWithLog('A', 'path_a', 'Chairman');
```

### 现有相关函数

| 函数 | 位置 | 返回值 |
|------|------|--------|
| `getAllAgents()` | db.mjs:299 | 所有 agent 的列表（含 auth_mode, auth_strategy）|
| `getAgentByName(name)` | db.mjs:290 | 单个 agent 完整对象或 undefined |
| `setAgentAuthConfig(name, config)` | db.mjs:325 | 更新 auth_mode/api 相关字段 |

---

## 5. 凭证管理核心逻辑

### 5.1 credential-manager.mjs

#### Token Store 文件

- **路径**: `${TEAMMCP_HOME}/oauth-credentials.json`
- **锁文件**: `${TEAMMCP_HOME}/teammcp-oauth.lock`

**文件格式：**
```json
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-oat01-xxxxxxxx...",
    "expiresAt": 1712678400000,
    "refreshToken": "sk-ant-ort01-xxxxxxxx...",
    "scopes": "user:profile user:inference ..."
  },
  "rotation_seq": 5,
  "last_refresh_at": 1712674800000,
  "last_refresh_by": "server-12345"
}
```

#### 关键函数

| 函数 | 说明 |
|------|------|
| `init()` | 初始化凭证管理器，启动刷新定时器 |
| `loadCredentials()` | 读取并解析 `oauth-credentials.json`，失败返回 null |
| `saveCredentials(data)` | 原子写入凭证文件（先写 `.tmp.{pid}` 再 `renameSync`）|
| `getCredentialStatus()` | 返回凭证状态摘要（下面详细说明）|
| `refreshOAuthToken()` | 刷新 OAuth access token，成功后自动调用 `distributeToAgents()` |
| `distributeToAgents()` | 将凭证复制到每个 agent 的 `.claude-config/.credentials.json` |
| `shutdown()` | 停止刷新定时器，清理资源 |

**`getCredentialStatus()` 返回结构（credential-manager.mjs:763）：**
```javascript
{
  hasCredentials: true,       // 凭证文件是否存在且有 claudeAiOauth
  isValid: true,              // accessToken 是否未过期
  expiresAt: 1712678400000,   // 过期时间 epoch ms
  expiresIn: '4h 30m',       // 人类可读的剩余时间
  lastRefresh: '2026-04-09T10:00:00Z',  // 上次刷新时间
  refreshStatus: 'ok',       // 'ok' | 'retrying' | 'failed' | 'never'
  consecutiveFailures: 0     // 连续刷新失败次数
}
```

#### 原子写入模式

```javascript
// 所有凭证文件写入都使用此模式
const tmpPath = targetFile + '.tmp.' + process.pid;
writeFileSync(tmpPath, content, 'utf-8');
renameSync(tmpPath, targetFile);  // rename 在所有平台上都是原子操作
```

#### 分发机制

`distributeToAgents()` 遍历 `AGENTS_BASE_DIR` 下所有 agent 目录，将凭证写入每个 agent 的 `.claude-config/.credentials.json`：

- **OAuth agent（auth_mode="oauth"）**: 写入完整凭证
- **API Key agent（auth_mode="api_key"）**: 写入空对象 `{}`
- **Path A agent（auth_strategy="path_a"）**: 跳过分发（按需租约）
- 使用原子写入（`.tmp.{pid}` + `renameSync`）

### 5.2 credential-lease.mjs

#### 租约流程

```
Agent 请求 → 验证 HMAC Bearer → 检查 per-agent rate limit → 加载 Token
→ 创建 lease_id → 插入 credential_leases 表 → 返回 token + lease_id
```

#### 限流参数

| 参数 | 值 | 说明 |
|------|-----|------|
| Per-agent rate | 3 次 / 5 分钟 | `credential_lease_rate` 表跟踪 |
| Global aggregate | 5 次 / 分钟 | 内存中 `_mintTimestamps` 数组 |

#### Busy Lock 机制

`path_a_busy_agents` 表实现互斥锁：
- **Acquire**: 插入记录，含 `locked_at`、`heartbeat_ts`、`owner_pid`
- **Heartbeat**: 每 5s 更新 `heartbeat_ts`
- **Release**: 删除记录
- **Stale**: `heartbeat_ts` 超过 30s 未更新 → 可被回收

#### 撤销

向 `credential_lease_revocations` 表插入记录，包含：`agent_name`、`lease_id`、`revoked_at`、`revoked_by`、`reason`。

---

## 6. 新接口设计方案（4个接口）

### 6.1 GET /api/dashboard/credentials/overview

**用途**: Dashboard 首页展示凭证管理总览信息。

**权限**: `requireAuth` + Chairman 或 CEO。

**响应格式**:
```json
{
  "oauth": {
    "loggedIn": true,
    "expiresAt": 1234567890000,
    "expiresIn": 3600000,
    "lastRefresh": "2026-04-09T10:00:00Z",
    "lastRefreshBy": "server-12345"
  },
  "agents": {
    "total": 8,
    "pathA": 3,
    "legacy": 5,
    "online": 4
  },
  "leases": {
    "active": 2,
    "total24h": 15,
    "revoked24h": 1,
    "rateLimited": []
  },
  "distribution": {
    "lastDistributedAt": "2026-04-09T10:00:00Z",
    "agentsCovered": 8,
    "agentsStale": 0
  }
}
```

**实现要点**:

```javascript
// router.mjs 中新增
if (method === 'GET' && path === '/api/dashboard/credentials/overview') {
  if (!requireAuth(req, res)) return;
  if (!['Chairman', 'CEO'].includes(req.agent.name)) {
    return json(res, { error: 'Forbidden: insufficient permissions' }, 403);
  }

  // 1. 获取 OAuth 状态
  const { getCredentialStatus, loadCredentials } = await import('./credential-manager.mjs');
  const credStatus = getCredentialStatus();
  const creds = loadCredentials();

  // 2. 获取 agent 统计
  const agents = getAllAgents();
  const pathACount = agents.filter(a => a.auth_strategy === 'path_a').length;
  const legacyCount = agents.filter(a => a.auth_strategy === 'legacy' || !a.auth_strategy).length;
  const onlineCount = agents.filter(a => a.status === 'online').length;

  // 3. 获取租约统计（需要新增 DB helper 函数）
  const now = Date.now();
  const activeLeases = getActiveLeaseCount();          // expires_at > now 且未撤销
  const total24h = getLeaseCountSince(now - 86400000); // 24小时内的租约总数
  const revoked24h = getRevokedCountSince(now - 86400000);
  const rateLimited = getRateLimitedAgents();           // blocked = 1 的 agent 列表

  // 4. 获取分发状态
  // 通过检查各 agent 目录下的 .credentials.json 文件时间

  return json(res, {
    oauth: {
      loggedIn: credStatus.hasCredentials && credStatus.isValid,
      expiresAt: credStatus.expiresAt,
      expiresIn: credStatus.expiresAt ? credStatus.expiresAt - Date.now() : null,
      lastRefresh: credStatus.lastRefresh,
      lastRefreshBy: creds?.last_refresh_by || null
    },
    agents: {
      total: agents.length,
      pathA: pathACount,
      legacy: legacyCount,
      online: onlineCount
    },
    leases: {
      active: activeLeases,
      total24h,
      revoked24h,
      rateLimited
    },
    distribution: { /* ... */ }
  });
}
```

**需要在 db.mjs 新增的函数**:

```javascript
// 获取当前活跃租约数（未过期且未撤销）
export function getActiveLeaseCount() {
  const now = Date.now();
  return db.prepare(`
    SELECT COUNT(*) as cnt FROM credential_leases cl
    WHERE cl.expires_at > ?
      AND NOT EXISTS (
        SELECT 1 FROM credential_lease_revocations clr
        WHERE clr.lease_id = cl.lease_id
      )
  `).get(now).cnt;
}

// 获取指定时间之后的租约总数
export function getLeaseCountSince(since) {
  return db.prepare(
    'SELECT COUNT(*) as cnt FROM credential_leases WHERE leased_at > ?'
  ).get(since).cnt;
}

// 获取指定时间之后的撤销数
export function getRevokedCountSince(since) {
  return db.prepare(
    'SELECT COUNT(*) as cnt FROM credential_lease_revocations WHERE revoked_at > ?'
  ).get(since).cnt;
}

// 获取被限流封锁的 agent 列表
export function getRateLimitedAgents() {
  return db.prepare(
    'SELECT agent_name FROM credential_lease_rate WHERE blocked = 1'
  ).all().map(r => r.agent_name);
}
```

---

### 6.2 GET /api/dashboard/credentials/leases

**用途**: 查询凭证租约历史和当前状态，支持分页和过滤。

**权限**: `requireAuth` + Chairman 或 CEO。

**Query 参数**:

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `agent` | string | 无 | 按 agent 名称过滤 |
| `status` | string | 无 | 按状态过滤：`active` / `expired` / `revoked` |
| `limit` | number | 50 | 每页数量，最大 200 |
| `offset` | number | 0 | 分页偏移量 |

**响应格式**:
```json
{
  "leases": [
    {
      "lease_id": "a1b2c3d4-e5f6-...",
      "agent": "A",
      "leased_at": 1234567890000,
      "expires_at": 1234567950000,
      "reason": "start",
      "requested_by": "process-manager",
      "status": "active",
      "revoked": false,
      "revoked_at": null,
      "revoked_by": null
    }
  ],
  "total": 100,
  "limit": 50,
  "offset": 0
}
```

**实现要点**:

```javascript
if (method === 'GET' && path === '/api/dashboard/credentials/leases') {
  if (!requireAuth(req, res)) return;
  if (!['Chairman', 'CEO'].includes(req.agent.name)) {
    return json(res, { error: 'Forbidden: insufficient permissions' }, 403);
  }

  const agentFilter = url.searchParams.get('agent');
  const statusFilter = url.searchParams.get('status');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  const { leases, total } = getLeaseHistory({ agent: agentFilter, status: statusFilter, limit, offset });

  return json(res, { leases, total, limit, offset });
}
```

**需要在 db.mjs 新增的函数**:

```javascript
/**
 * 查询租约历史，LEFT JOIN 撤销表来计算状态。
 *
 * status 计算逻辑：
 *   - 有撤销记录 → "revoked"
 *   - expires_at > now → "active"
 *   - 否则 → "expired"
 */
export function getLeaseHistory({ agent, status, limit = 50, offset = 0 }) {
  const now = Date.now();

  // 构建 WHERE 子句（动态拼接，注意 SQL 注入防护用 prepared statement 参数）
  let whereClauses = [];
  let params = [];

  if (agent) {
    whereClauses.push('cl.agent = ?');
    params.push(agent);
  }

  // status 过滤需要在子查询/HAVING 或 wrapping query 中做
  // 这里用 CTE 或 subquery 方式
  const baseQuery = `
    SELECT
      cl.lease_id,
      cl.agent,
      cl.leased_at,
      cl.expires_at,
      cl.reason,
      cl.requested_by,
      clr.revoked_at,
      clr.revoked_by,
      clr.reason AS revoke_reason,
      CASE
        WHEN clr.id IS NOT NULL THEN 'revoked'
        WHEN cl.expires_at > ${now} THEN 'active'
        ELSE 'expired'
      END AS status
    FROM credential_leases cl
    LEFT JOIN credential_lease_revocations clr ON clr.lease_id = cl.lease_id
  `;

  let where = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

  // 如果需要按 status 过滤，用包装查询
  let fullQuery;
  let countQuery;

  if (status) {
    fullQuery = `SELECT * FROM (${baseQuery} ${where}) AS sub WHERE sub.status = ? ORDER BY sub.leased_at DESC LIMIT ? OFFSET ?`;
    countQuery = `SELECT COUNT(*) as cnt FROM (${baseQuery} ${where}) AS sub WHERE sub.status = ?`;
    params.push(status);
  } else {
    fullQuery = `${baseQuery} ${where} ORDER BY cl.leased_at DESC LIMIT ? OFFSET ?`;
    countQuery = `SELECT COUNT(*) as cnt FROM credential_leases cl ${where}`;
  }

  // 注意：SQLite 不支持子查询别名用 AS sub 的语法，需要用其他方式
  // 推荐方案：先查所有再在 JS 中过滤 status，或者用 CTE
  // 下面是更实际的 SQLite 兼容实现：

  const allRows = db.prepare(`
    SELECT
      cl.lease_id,
      cl.agent,
      cl.leased_at,
      cl.expires_at,
      cl.reason,
      cl.requested_by,
      clr.revoked_at,
      clr.revoked_by,
      clr.reason AS revoke_reason
    FROM credential_leases cl
    LEFT JOIN credential_lease_revocations clr ON clr.lease_id = cl.lease_id
    ${where}
    ORDER BY cl.leased_at DESC
  `).all(...params);

  // 在 JS 中计算 status 并过滤
  const enriched = allRows.map(row => ({
    lease_id: row.lease_id,
    agent: row.agent,
    leased_at: row.leased_at,
    expires_at: row.expires_at,
    reason: row.reason,
    requested_by: row.requested_by,
    status: row.revoked_at ? 'revoked' : (row.expires_at > now ? 'active' : 'expired'),
    revoked: !!row.revoked_at,
    revoked_at: row.revoked_at || null,
    revoked_by: row.revoked_by || null
  }));

  const filtered = status ? enriched.filter(r => r.status === status) : enriched;
  const total = filtered.length;
  const paged = filtered.slice(offset, offset + limit);

  return { leases: paged, total };
}
```

> **性能注意**: 如果租约数据量较大（>10000 条），应考虑改用纯 SQL 实现过滤和分页。上面 JS 侧过滤的方式适合中小数据量。大数据量可以用 SQLite 的 CASE WHEN + HAVING 或 CTE 配合 WHERE 过滤。

---

### 6.3 GET /api/dashboard/credentials/token-store

**用途**: 查看 Token Store 文件状态，用于诊断凭证问题。**不暴露实际 token 值**。

**权限**: `requireAuth` + **仅 Chairman**（最敏感的端点）。

**响应格式**:
```json
{
  "exists": true,
  "format": "claudeAiOauth",
  "hasAccessToken": true,
  "hasRefreshToken": true,
  "accessTokenPrefix": "sk-ant-...xxxx",
  "expiresAt": 1234567890000,
  "rotationSeq": 5,
  "lastRefreshAt": 1234567890000,
  "lastRefreshBy": "server-12345",
  "fileSize": 512,
  "filePath": "/path/to/oauth-credentials.json",
  "distribution": {
    "agents": [
      {
        "name": "A",
        "fileExists": true,
        "lastModified": "2026-04-09T10:00:00Z"
      },
      {
        "name": "B",
        "fileExists": true,
        "lastModified": "2026-04-09T10:00:00Z"
      }
    ]
  }
}
```

**实现要点**:

```javascript
if (method === 'GET' && path === '/api/dashboard/credentials/token-store') {
  if (!requireAuth(req, res)) return;
  if (req.agent.name !== 'Chairman') {
    return json(res, { error: 'Forbidden: Chairman only' }, 403);
  }

  const { loadCredentials } = await import('./credential-manager.mjs');
  const { existsSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');

  const TEAMMCP_HOME = process.env.TEAMMCP_HOME;
  const tokenFilePath = join(TEAMMCP_HOME, 'oauth-credentials.json');
  const AGENTS_BASE_DIR = process.env.AGENTS_BASE_DIR || process.env.TEAMMCP_AGENTS_DIR;

  // 1. 读取 Token Store
  const creds = loadCredentials();
  const fileExists = existsSync(tokenFilePath);

  let fileSize = 0;
  if (fileExists) {
    try { fileSize = statSync(tokenFilePath).size; } catch {}
  }

  // 2. Token 脱敏 — 只显示前缀和后缀
  function maskToken(token) {
    if (!token || typeof token !== 'string') return null;
    if (token.length <= 12) return '***';
    return token.slice(0, 10) + '...' + token.slice(-4);
  }

  const oauth = creds?.claudeAiOauth;

  // 3. 检查每个 agent 的凭证文件分发状态
  const agents = getAllAgents();
  const agentDistribution = [];

  for (const agent of agents) {
    const credPath = join(AGENTS_BASE_DIR, agent.name, '.claude-config', '.credentials.json');
    let fileExistsForAgent = false;
    let lastModified = null;
    try {
      const st = statSync(credPath);
      fileExistsForAgent = true;
      lastModified = st.mtime.toISOString();
    } catch {}

    agentDistribution.push({
      name: agent.name,
      fileExists: fileExistsForAgent,
      lastModified
    });
  }

  return json(res, {
    exists: fileExists,
    format: creds?.claudeAiOauth ? 'claudeAiOauth' : null,
    hasAccessToken: !!oauth?.accessToken,
    hasRefreshToken: !!oauth?.refreshToken,
    accessTokenPrefix: maskToken(oauth?.accessToken),
    expiresAt: oauth?.expiresAt || null,
    rotationSeq: creds?.rotation_seq ?? null,
    lastRefreshAt: creds?.last_refresh_at ?? null,
    lastRefreshBy: creds?.last_refresh_by ?? null,
    fileSize,
    filePath: tokenFilePath,
    distribution: {
      agents: agentDistribution
    }
  });
}
```

**安全注意事项**:
- `maskToken()` 函数只暴露 token 的前 10 字符和后 4 字符，足以识别 token 类型和版本
- 绝对不能在响应中返回完整的 `accessToken` 或 `refreshToken`
- `filePath` 暴露服务器路径信息，如有安全顾虑可考虑移除

---

### 6.4 PATCH /api/dashboard/credentials/agents/:name/auth-strategy

**用途**: 切换 Agent 的认证策略（`legacy` ↔ `path_a`）。

**权限**: `requireAuth` + Chairman 或 CEO。

**请求体**:
```json
{
  "auth_strategy": "path_a",
  "reason": "Migrating to centralized credential management"
}
```

**响应格式**:
```json
{
  "success": true,
  "agent": "A",
  "previous": "legacy",
  "current": "path_a",
  "updated_at": "2026-04-09T10:00:00Z"
}
```

**实现要点**:

```javascript
// 路由匹配 — PATCH 方法 + 带参数路径
if (method === 'PATCH' && path.match(/^\/api\/dashboard\/credentials\/agents\/[^/]+\/auth-strategy$/)) {
  if (!requireAuth(req, res)) return;
  if (!['Chairman', 'CEO'].includes(req.agent.name)) {
    return json(res, { error: 'Forbidden: insufficient permissions' }, 403);
  }

  // 提取 agent 名称：/api/dashboard/credentials/agents/{name}/auth-strategy
  const segments = path.split('/');
  const agentName = decodeURIComponent(segments[5]);

  const body = await readBody(req);

  // 验证 auth_strategy 值
  const validStrategies = ['legacy', 'path_a'];
  if (!body.auth_strategy || !validStrategies.includes(body.auth_strategy)) {
    return json(res, { error: 'Invalid auth_strategy. Must be "legacy" or "path_a"' }, 400);
  }

  // 查找目标 agent
  const agent = getAgentByName(agentName);
  if (!agent) {
    return json(res, { error: `Agent not found: ${agentName}` }, 404);
  }

  const previousStrategy = agent.auth_strategy || 'legacy';
  const newStrategy = body.auth_strategy;

  // 幂等性检查
  if (previousStrategy === newStrategy) {
    return json(res, {
      success: true,
      agent: agentName,
      previous: previousStrategy,
      current: newStrategy,
      updated_at: new Date().toISOString(),
      note: 'No change — already set to this strategy'
    });
  }

  // 执行更新（事务：更新 agent + 写入审计日志）
  const now = new Date().toISOString();
  updateAgentAuthStrategy(agentName, newStrategy, previousStrategy, req.agent.name, body.reason || '', now);

  // SSE 推送通知
  pushToAgents(['Chairman', 'CEO'], {
    type: 'credential_config_change',
    agent: agentName,
    field: 'auth_strategy',
    previous: previousStrategy,
    current: newStrategy,
    changed_by: req.agent.name,
    timestamp: now
  });

  return json(res, {
    success: true,
    agent: agentName,
    previous: previousStrategy,
    current: newStrategy,
    updated_at: now
  });
}
```

**需要在 db.mjs 新增的函数**:

```javascript
/**
 * 更新 agent 的 auth_strategy 字段，同时写入审计日志。
 * 使用事务保证原子性。
 */
export const updateAgentAuthStrategy = db.transaction(
  (agentName, newStrategy, oldStrategy, changedBy, reason, timestamp) => {
    // 更新 agents 表
    db.prepare('UPDATE agents SET auth_strategy = ? WHERE name = ?')
      .run(newStrategy, agentName);

    // 写入 change_log 审计日志
    db.prepare(`
      INSERT INTO change_log (project_id, field, old_value, new_value, changed_by, reason, timestamp, version, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'credential_config')
    `).run('_system', `auth_strategy:${agentName}`, oldStrategy, newStrategy, changedBy, reason, timestamp);
  }
);
```

---

## 7. 错误处理规范

### 标准错误响应格式

所有错误响应均使用以下 JSON 格式：

```json
{
  "error": "描述性错误消息"
}
```

### HTTP 状态码约定

| 状态码 | 含义 | 使用场景 |
|--------|------|----------|
| 200 | 成功 | 正常响应 |
| 400 | 请求无效 | 缺少必填字段、参数格式错误、枚举值不合法 |
| 401 | 未认证 | API Key 缺失或无效（由 `requireAuth` 自动处理）|
| 403 | 权限不足 | 角色不允许访问该端点 |
| 404 | 资源不存在 | Agent 不存在等 |
| 413 | 请求体过大 | 超过 8MB（由 `readBody` 自动处理）|
| 429 | 限流 | 请求频率超限 |
| 500 | 内部错误 | 数据库异常等不可预期错误 |

### 错误处理模式

```javascript
// 在路由的 try/catch 中统一处理未预期错误
try {
  // ... 路由匹配和业务逻辑
} catch (err) {
  // 不要暴露内部堆栈信息
  console.error('[router] Internal error:', err);
  json(res, { error: 'Internal server error' }, 500);
}
```

### 安全原则

- **永远不要**在响应中返回数据库查询原文、文件路径、堆栈跟踪
- **永远不要**在错误消息中暴露 token、API Key 等敏感信息
- Token 值仅返回脱敏版本（前缀+后缀模式），参考 `maskToken()` 函数
- `filePath` 字段可选返回，视安全需求决定

---

## 8. 实现步骤

### 步骤 1：在 db.mjs 中添加数据库 helper 函数

在 `db.mjs` 的 exports 部分前添加以下函数：

```javascript
// ── Credential Dashboard Helpers ──────────────────────────

export function getActiveLeaseCount() {
  const now = Date.now();
  return db.prepare(`
    SELECT COUNT(*) as cnt FROM credential_leases cl
    WHERE cl.expires_at > ?
      AND NOT EXISTS (
        SELECT 1 FROM credential_lease_revocations clr
        WHERE clr.lease_id = cl.lease_id
      )
  `).get(now).cnt;
}

export function getLeaseCountSince(since) {
  return db.prepare(
    'SELECT COUNT(*) as cnt FROM credential_leases WHERE leased_at > ?'
  ).get(since).cnt;
}

export function getRevokedCountSince(since) {
  return db.prepare(
    'SELECT COUNT(*) as cnt FROM credential_lease_revocations WHERE revoked_at > ?'
  ).get(since).cnt;
}

export function getRateLimitedAgents() {
  return db.prepare(
    'SELECT agent_name FROM credential_lease_rate WHERE blocked = 1'
  ).all().map(r => r.agent_name);
}

export function getLeaseHistory({ agent, status, limit = 50, offset = 0 }) {
  const now = Date.now();
  let whereClauses = [];
  let params = [];

  if (agent) {
    whereClauses.push('cl.agent = ?');
    params.push(agent);
  }

  const where = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

  const allRows = db.prepare(`
    SELECT
      cl.lease_id, cl.agent, cl.leased_at, cl.expires_at, cl.reason, cl.requested_by,
      clr.revoked_at, clr.revoked_by, clr.reason AS revoke_reason
    FROM credential_leases cl
    LEFT JOIN credential_lease_revocations clr ON clr.lease_id = cl.lease_id
    ${where}
    ORDER BY cl.leased_at DESC
  `).all(...params);

  const enriched = allRows.map(row => ({
    lease_id: row.lease_id,
    agent: row.agent,
    leased_at: row.leased_at,
    expires_at: row.expires_at,
    reason: row.reason,
    requested_by: row.requested_by,
    status: row.revoked_at ? 'revoked' : (row.expires_at > now ? 'active' : 'expired'),
    revoked: !!row.revoked_at,
    revoked_at: row.revoked_at || null,
    revoked_by: row.revoked_by || null
  }));

  const filtered = status ? enriched.filter(r => r.status === status) : enriched;
  const total = filtered.length;
  const paged = filtered.slice(offset, offset + limit);

  return { leases: paged, total };
}

export const updateAgentAuthStrategy = db.transaction(
  (agentName, newStrategy, oldStrategy, changedBy, reason, timestamp) => {
    db.prepare('UPDATE agents SET auth_strategy = ? WHERE name = ?')
      .run(newStrategy, agentName);
    db.prepare(`
      INSERT INTO change_log (project_id, field, old_value, new_value, changed_by, reason, timestamp, version, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'credential_config')
    `).run('_system', `auth_strategy:${agentName}`, oldStrategy, newStrategy, changedBy, reason, timestamp);
  }
);
```

### 步骤 2：在 router.mjs 顶部添加 import

在 router.mjs 的 import 区域（约第 6-32 行的 db.mjs import 块）添加新导出函数：

```javascript
import {
  // ... 现有 imports ...
  getActiveLeaseCount,
  getLeaseCountSince,
  getRevokedCountSince,
  getRateLimitedAgents,
  getLeaseHistory,
  updateAgentAuthStrategy
} from './db.mjs';
```

### 步骤 3：在 router.mjs 中添加路由处理

在 `handleRequest` 函数内的适当位置（建议在现有 `/api/credentials/lease/` 路由附近，约 1147 行）添加 4 个新路由。按以下顺序添加：

1. `GET /api/dashboard/credentials/overview`
2. `GET /api/dashboard/credentials/leases`
3. `GET /api/dashboard/credentials/token-store`
4. `PATCH /api/dashboard/credentials/agents/:name/auth-strategy`

完整实现代码参见 [第 6 节](#6-新接口设计方案4个接口)。

### 步骤 4：添加 SSE 事件支持

在 PATCH auth-strategy 端点的实现中，使用已有的 `pushToAgents` 函数推送实时通知：

```javascript
// 已在 router.mjs 顶部 import：
import { pushToAgent, pushToAgents } from './sse.mjs';

// 在 PATCH 处理成功后推送：
pushToAgents(['Chairman', 'CEO'], {
  type: 'credential_config_change',
  agent: agentName,
  field: 'auth_strategy',
  previous: previousStrategy,
  current: newStrategy,
  changed_by: req.agent.name,
  timestamp: now
});
```

Dashboard 前端可通过 SSE 连接监听 `credential_config_change` 事件来实时更新 UI。

### 步骤 5：测试

使用下一节的 curl 命令逐一测试每个端点。

---

## 9. 测试用例 (curl 示例)

> 以下示例中 `tmcp_xxx` 替换为实际的 Chairman 或 CEO 的 API Key。
> 服务器默认运行在 `http://localhost:3100`。

### 9.1 测试凭证总览

```bash
# Chairman 查看凭证总览
curl -s -H "Authorization: Bearer tmcp_chairman_api_key" \
  http://localhost:3100/api/dashboard/credentials/overview | jq .

# 预期响应（200）：
# {
#   "oauth": { "loggedIn": true, "expiresAt": ..., "expiresIn": ..., ... },
#   "agents": { "total": 8, "pathA": 3, "legacy": 5, "online": 4 },
#   "leases": { "active": 2, "total24h": 15, "revoked24h": 1, "rateLimited": [] },
#   "distribution": { ... }
# }

# 无权限测试（普通 agent）
curl -s -H "Authorization: Bearer tmcp_agent_a_key" \
  http://localhost:3100/api/dashboard/credentials/overview | jq .

# 预期响应（403）：
# { "error": "Forbidden: insufficient permissions" }

# 无认证测试
curl -s http://localhost:3100/api/dashboard/credentials/overview | jq .

# 预期响应（401）：
# { "error": "Unauthorized: invalid or missing API key" }
```

### 9.2 测试租约查询

```bash
# 查询全部租约（默认分页）
curl -s -H "Authorization: Bearer tmcp_chairman_api_key" \
  "http://localhost:3100/api/dashboard/credentials/leases" | jq .

# 按 agent 过滤
curl -s -H "Authorization: Bearer tmcp_chairman_api_key" \
  "http://localhost:3100/api/dashboard/credentials/leases?agent=A" | jq .

# 按状态过滤 + 分页
curl -s -H "Authorization: Bearer tmcp_chairman_api_key" \
  "http://localhost:3100/api/dashboard/credentials/leases?status=active&limit=10&offset=0" | jq .

# 预期响应（200）：
# {
#   "leases": [
#     {
#       "lease_id": "a1b2c3d4-...",
#       "agent": "A",
#       "leased_at": 1712674800000,
#       "expires_at": 1712678400000,
#       "reason": "start",
#       "requested_by": "process-manager",
#       "status": "active",
#       "revoked": false,
#       "revoked_at": null,
#       "revoked_by": null
#     }
#   ],
#   "total": 1,
#   "limit": 10,
#   "offset": 0
# }

# 查询已撤销的租约
curl -s -H "Authorization: Bearer tmcp_chairman_api_key" \
  "http://localhost:3100/api/dashboard/credentials/leases?status=revoked" | jq .
```

### 9.3 测试 Token Store 状态

```bash
# Chairman 查看 Token Store（仅 Chairman 有权限）
curl -s -H "Authorization: Bearer tmcp_chairman_api_key" \
  http://localhost:3100/api/dashboard/credentials/token-store | jq .

# 预期响应（200）：
# {
#   "exists": true,
#   "format": "claudeAiOauth",
#   "hasAccessToken": true,
#   "hasRefreshToken": true,
#   "accessTokenPrefix": "sk-ant-oat...xxxx",
#   "expiresAt": 1712678400000,
#   "rotationSeq": 5,
#   "lastRefreshAt": 1712674800000,
#   "lastRefreshBy": "server-12345",
#   "fileSize": 512,
#   "filePath": "C:\\Users\\ssdlh\\Desktop\\teammcp\\oauth-credentials.json",
#   "distribution": {
#     "agents": [
#       { "name": "A", "fileExists": true, "lastModified": "2026-04-09T10:00:00Z" },
#       { "name": "B", "fileExists": true, "lastModified": "2026-04-09T10:00:00Z" }
#     ]
#   }
# }

# CEO 尝试访问（应被拒绝）
curl -s -H "Authorization: Bearer tmcp_ceo_api_key" \
  http://localhost:3100/api/dashboard/credentials/token-store | jq .

# 预期响应（403）：
# { "error": "Forbidden: Chairman only" }
```

### 9.4 测试切换认证策略

```bash
# 将 Agent A 从 legacy 切换到 path_a
curl -s -X PATCH \
  -H "Authorization: Bearer tmcp_chairman_api_key" \
  -H "Content-Type: application/json" \
  -d '{"auth_strategy": "path_a", "reason": "Migrating to centralized credential management"}' \
  http://localhost:3100/api/dashboard/credentials/agents/A/auth-strategy | jq .

# 预期响应（200）：
# {
#   "success": true,
#   "agent": "A",
#   "previous": "legacy",
#   "current": "path_a",
#   "updated_at": "2026-04-09T10:30:00Z"
# }

# 切换回 legacy
curl -s -X PATCH \
  -H "Authorization: Bearer tmcp_chairman_api_key" \
  -H "Content-Type: application/json" \
  -d '{"auth_strategy": "legacy", "reason": "Rolling back due to issue"}' \
  http://localhost:3100/api/dashboard/credentials/agents/A/auth-strategy | jq .

# 无效策略值
curl -s -X PATCH \
  -H "Authorization: Bearer tmcp_chairman_api_key" \
  -H "Content-Type: application/json" \
  -d '{"auth_strategy": "invalid_value"}' \
  http://localhost:3100/api/dashboard/credentials/agents/A/auth-strategy | jq .

# 预期响应（400）：
# { "error": "Invalid auth_strategy. Must be \"legacy\" or \"path_a\"" }

# 不存在的 agent
curl -s -X PATCH \
  -H "Authorization: Bearer tmcp_chairman_api_key" \
  -H "Content-Type: application/json" \
  -d '{"auth_strategy": "path_a"}' \
  http://localhost:3100/api/dashboard/credentials/agents/NonExistent/auth-strategy | jq .

# 预期响应（404）：
# { "error": "Agent not found: NonExistent" }

# 幂等性测试（已经是 path_a，再设一次）
curl -s -X PATCH \
  -H "Authorization: Bearer tmcp_chairman_api_key" \
  -H "Content-Type: application/json" \
  -d '{"auth_strategy": "path_a"}' \
  http://localhost:3100/api/dashboard/credentials/agents/A/auth-strategy | jq .

# 预期响应（200，包含 note 字段）：
# {
#   "success": true,
#   "agent": "A",
#   "previous": "path_a",
#   "current": "path_a",
#   "updated_at": "...",
#   "note": "No change — already set to this strategy"
# }
```

---

## 附录：快速参考

### 文件修改清单

| 文件 | 修改内容 |
|------|----------|
| `server/db.mjs` | 新增 6 个 export 函数：`getActiveLeaseCount`, `getLeaseCountSince`, `getRevokedCountSince`, `getRateLimitedAgents`, `getLeaseHistory`, `updateAgentAuthStrategy` |
| `server/router.mjs` | 新增 import + 4 个路由处理块 |

### 端点权限总结

| 端点 | 方法 | 允许角色 |
|------|------|----------|
| `/api/dashboard/credentials/overview` | GET | Chairman, CEO |
| `/api/dashboard/credentials/leases` | GET | Chairman, CEO |
| `/api/dashboard/credentials/token-store` | GET | Chairman |
| `/api/dashboard/credentials/agents/:name/auth-strategy` | PATCH | Chairman, CEO |

### 依赖的现有函数

| 函数 | 来源文件 | 用途 |
|------|----------|------|
| `requireAuth(req, res)` | auth.mjs | 认证 |
| `json(res, data, status)` | router.mjs (局部) | 响应 |
| `readBody(req)` | router.mjs (局部) | 请求体解析 |
| `getAllAgents()` | db.mjs | 获取全部 agent |
| `getAgentByName(name)` | db.mjs | 获取单个 agent |
| `getCredentialStatus()` | credential-manager.mjs | OAuth 状态 |
| `loadCredentials()` | credential-manager.mjs | 读取 Token Store |
| `pushToAgents(names, event)` | sse.mjs | SSE 推送 |
