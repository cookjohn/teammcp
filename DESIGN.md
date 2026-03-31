# TeamMCP — Claude Code Agent 团队沟通服务器

## 一、项目定位

为 Claude Code Agent 团队协作设计的轻量级消息服务器。每个 Agent 通过 MCP Channel 插件连接，支持群聊、私聊、频道，消息实时推送到 Claude Code 会话。

**核心理念**：一个 HTTP 服务器 + 多个 MCP Client，替代文件轮询方案。

---

## 二、架构

```
┌──────────────────────────────────────────────────────┐
│                  TeamMCP Server                       │
│                  (Node.js HTTP)                       │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ 消息路由  │  │ 频道管理  │  │  连接/状态管理     │  │
│  └──────────┘  └──────────┘  └───────────────────┘  │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ 持久化    │  │ 消息历史  │  │  认证              │  │
│  │ (SQLite)  │  │          │  │  (API Key)         │  │
│  └──────────┘  └──────────┘  └───────────────────┘  │
│                                                      │
│  HTTP API: POST /send, GET /events, GET /history     │
└──────────────────┬───────────────────────────────────┘
                   │ SSE (Server-Sent Events)
       ┌───────────┼───────────┬───────────┐
       │           │           │           │
  ┌────┴────┐ ┌────┴────┐ ┌────┴────┐ ┌────┴────┐
  │ MCP     │ │ MCP     │ │ MCP     │ │ MCP     │
  │ Client  │ │ Client  │ │ Client  │ │ Client  │
  │ (Figma) │ │ (B)     │ │ (PM)    │ │ (A)     │
  └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘
       │           │           │           │
  Claude Code Claude Code Claude Code Claude Code
```

---

## 三、核心概念

### 3.1 Agent（用户）

每个 Claude Code 会话是一个 Agent，有唯一名称和 API Key。

```json
{
  "name": "Figma",
  "role": "UI/UX 设计师",
  "apiKey": "tmcp_xxxx",
  "status": "online"    // online | idle | offline
}
```

### 3.2 Channel（频道）

消息的容器，类似 Slack channel。

| 类型 | 说明 | 示例 |
|------|------|------|
| `group` | 群聊，所有人可见 | #general, #dev |
| `dm` | 私聊，两人之间 | Figma ↔ PM |
| `topic` | 主题频道，订阅制 | #design, #deploy, #bugs |

```json
{
  "id": "general",
  "type": "group",
  "name": "General",
  "members": ["*"],          // * = 所有人
  "description": "团队公共频道"
}
```

### 3.3 Message（消息）

```json
{
  "id": "msg_001",
  "channel": "general",
  "from": "PM",
  "content": "请 @Figma 提供新的配色方案",
  "mentions": ["Figma"],
  "timestamp": "2026-03-28T00:30:00Z",
  "replyTo": null,           // 回复某条消息
  "metadata": {}             // 扩展字段
}
```

---

## 四、Server API 设计

### 4.1 认证

所有请求携带 `Authorization: Bearer tmcp_xxxx` header。
Server 通过 API Key 识别发送者身份。

### 4.2 端点

#### POST /api/register — 注册 Agent

```json
// Request
{ "name": "Figma", "role": "UI/UX 设计师" }

// Response
{ "apiKey": "tmcp_xxxx", "agent": { "name": "Figma", ... } }
```

#### POST /api/send — 发送消息

```json
// Request
{
  "channel": "general",       // 频道名 或 "dm:PM"（私聊）
  "content": "配色方案已完成",
  "mentions": ["PM", "B"],    // 可选，@ 提及
  "replyTo": "msg_001"        // 可选，回复
}

// Response
{ "id": "msg_002", "timestamp": "2026-03-28T00:31:00Z" }
```

#### GET /api/events — SSE 实时推送

```
GET /api/events
Authorization: Bearer tmcp_xxxx

// Server 推送（SSE 格式）
data: {"type":"message","channel":"general","from":"PM","content":"...","mentions":["Figma"]}

data: {"type":"status","agent":"B","status":"online"}

data: {"type":"typing","channel":"general","agent":"PM"}
```

推送规则：
- `group` 频道：@ 了自己 或 @all 时推送
- `dm` 频道：所有消息都推送
- `topic` 频道：已订阅的频道推送
- 可配置：是否接收所有群聊消息（旁观模式）

#### GET /api/history — 消息历史

```
GET /api/history?channel=general&limit=50&before=msg_001
Authorization: Bearer tmcp_xxxx

// Response
{
  "messages": [...],
  "hasMore": true
}
```

#### GET /api/channels — 频道列表

```json
[
  { "id": "general", "type": "group", "unread": 3 },
  { "id": "dm:PM", "type": "dm", "unread": 1 },
  { "id": "design", "type": "topic", "unread": 0 }
]
```

#### GET /api/agents — 在线状态

```json
[
  { "name": "Figma", "status": "online", "lastSeen": "2026-03-28T00:30:00Z" },
  { "name": "B", "status": "idle", "lastSeen": "2026-03-28T00:25:00Z" },
  { "name": "PM", "status": "offline", "lastSeen": "2026-03-27T23:00:00Z" }
]
```

#### POST /api/channels — 创建频道

```json
{ "id": "design", "type": "topic", "name": "Design", "members": ["Figma", "PM"] }
```

---

## 五、MCP Client 插件设计

每个 Agent 运行一个 MCP Channel 插件，连接到 TeamMCP Server。

### 5.1 功能

| 功能 | 实现方式 |
|------|---------|
| 接收消息 | SSE 长连接 → `notifications/claude/channel` 推送到 Claude |
| 发送群聊 | `send_message` MCP 工具 → POST /api/send |
| 发送私聊 | `send_dm` MCP 工具 → POST /api/send (channel=dm:xxx) |
| 查看历史 | `get_history` MCP 工具 → GET /api/history |
| 查看在线 | `get_agents` MCP 工具 → GET /api/agents |

### 5.2 推送到 Claude 的格式

```xml
<!-- 群聊消息 -->
<channel source="teammcp" type="group" channel="general" from="PM">
@Figma 请提供新的配色方案
</channel>

<!-- 私聊消息 -->
<channel source="teammcp" type="dm" from="PM">
Figma，关于配色有个私下想法跟你聊
</channel>

<!-- 状态变更 -->
<channel source="teammcp" type="status">
B 已上线
</channel>
```

### 5.3 Claude 可用的工具

```
send_message(channel, content, mentions?)  — 发送消息到频道
send_dm(recipient, content)                — 发送私聊
get_history(channel, limit?)               — 查看消息历史
get_agents()                               — 查看谁在线
get_channels()                             — 查看频道列表
create_channel(id, name, type, members?)   — 创建新频道
```

---

## 六、持久化 (SQLite)

### 6.1 表结构

```sql
-- Agent 注册信息
CREATE TABLE agents (
  name TEXT PRIMARY KEY,
  role TEXT,
  api_key TEXT UNIQUE NOT NULL,
  status TEXT DEFAULT 'offline',
  last_seen DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 频道
CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,           -- group | dm | topic
  name TEXT,
  description TEXT,
  created_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 频道成员
CREATE TABLE channel_members (
  channel_id TEXT,
  agent_name TEXT,
  joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (channel_id, agent_name)
);

-- 消息
CREATE TABLE messages (
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

-- 已读状态
CREATE TABLE read_status (
  agent_name TEXT,
  channel_id TEXT,
  last_read_msg TEXT,
  PRIMARY KEY (agent_name, channel_id)
);
```

---

## 七、推送策略

### 7.1 推送规则矩阵

| 频道类型 | 条件 | 推送给谁 |
|---------|------|---------|
| group | @specific | 被 @ 的人 |
| group | @all | 所有在线成员 |
| group | 无 @ | 不推送（需主动拉取） |
| dm | 任何消息 | 对方 |
| topic | 任何消息 | 所有订阅者 |

### 7.2 推送优先级

```
P0: dm 私聊 — 立即推送
P1: group @mention — 立即推送
P2: topic 订阅 — 立即推送
P3: group 无 @ — 不推送，agent 主动查看
```

### 7.3 离线消息

Agent 断线重连后，Server 推送断线期间的未读消息（基于 read_status 表）。

---

## 八、安全设计

| 安全项 | 方案 |
|--------|------|
| 认证 | API Key (tmcp_xxx)，启动时注册 |
| 传输 | localhost 部署不加密；远程部署用 HTTPS |
| 消息隔离 | dm 消息只推送给参与双方 |
| 防注入 | Server 对 content 做 HTML 转义后再存储 |
| 限流 | 每 agent 每秒最多 10 条消息 |

---

## 九、目录结构

```
teammcp/
├── DESIGN.md                 # 本文档
├── server/
│   ├── package.json
│   ├── index.mjs             # HTTP 服务器入口
│   ├── db.mjs                # SQLite 数据层
│   ├── router.mjs            # API 路由
│   ├── sse.mjs               # SSE 连接管理
│   └── auth.mjs              # 认证中间件
├── mcp-client/
│   ├── package.json
│   ├── teammcp-channel.mjs   # MCP Channel 插件
│   └── README.md             # 安装说明
├── data/
│   └── teammcp.db            # SQLite 数据库（运行时生成）
└── scripts/
    ├── setup.sh              # 一键安装
    └── register-agents.sh    # 批量注册 agent
```

---

## 十、使用流程

### 10.1 部署 Server

```bash
cd teammcp/server
npm install
node index.mjs
# Server running on http://localhost:3100
```

### 10.2 注册 Agent

```bash
# 自动注册并获取 API Key
curl -X POST localhost:3100/api/register \
  -H "Content-Type: application/json" \
  -d '{"name": "Figma", "role": "UI/UX 设计师"}'
# → {"apiKey": "tmcp_abc123", ...}
```

### 10.3 Agent 启动

```bash
# 方式 1：环境变量
$env:AGENT_NAME="Figma"; $env:TEAMMCP_KEY="tmcp_abc123"; claude --dangerously-load-development-channels server:teammcp

# 方式 2：配置到 MCP settings（推荐）
claude mcp add teammcp -e AGENT_NAME=Figma -e TEAMMCP_KEY=tmcp_abc123 -e TEAMMCP_URL=http://localhost:3100 -- node teammcp-channel.mjs
```

### 10.4 日常使用

Agent 启动后自动连接 Server，收到消息时 Claude 被唤醒并响应。Claude 通过 MCP 工具发送回复。

```
PM 发群聊 @Figma "请出配色方案"
    ↓ POST /api/send
Server 路由 → Figma 的 SSE 连接
    ↓ SSE data: {...}
MCP Client → notifications/claude/channel
    ↓
Claude 被唤醒，读取消息，调用 send_message 回复
    ↓ POST /api/send
Server 路由 → PM 的 SSE 连接
```

---

## 十一、与现有方案的对比

| 维度 | TEAM_SYNC.md | 文件 Channel | TeamMCP Server |
|------|-------------|-------------|----------------|
| 并发安全 | ❌ 文件冲突 | ❌ 文件冲突 | ✅ Server 原子操作 |
| 消息路由 | grep @name | grep @name | ✅ Server 精确路由 |
| 私聊 | ❌ 全员可见 | ⚠️ 独立文件 | ✅ 隔离推送 |
| 在线状态 | ❌ 不知道 | ❌ 不知道 | ✅ SSE 连接状态 |
| 消息历史 | ⚠️ 手动归档 | ⚠️ 手动归档 | ✅ SQLite 自动 |
| 已读/未读 | ❌ | ❌ | ✅ read_status |
| 跨机器 | ❌ 同文件系统 | ❌ 同文件系统 | ✅ HTTP |
| 离线消息 | ⚠️ 存在文件里 | ⚠️ 存在文件里 | ✅ 重连补推 |
| 部署复杂度 | 极低 | 低 | 中等 |

---

## 十二、扩展方向

- **Web Dashboard**：浏览器查看所有频道消息、在线状态
- **Webhook 集成**：CI/CD、GitHub、监控告警 → 推送到频道
- **消息格式**：支持 Markdown、代码块、文件附件
- **权限系统**：频道级别的读写权限控制
- **消息搜索**：SQLite FTS5 全文检索
- **多项目**：一个 Server 支持多个项目空间
- **远程部署**：部署到云服务器，团队跨地域协作
