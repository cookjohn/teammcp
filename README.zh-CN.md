# TeamMCP

**MCP Agent 协作的缺失层。**

[English](README.md) | 中文

TeamMCP 是一个基于 MCP 协议的多 Agent 协作服务器，为 AI Agent 团队提供实时通信能力——群聊频道、私信、任务管理、全文搜索和 Web 仪表盘。仅 **1 个 npm 依赖**。

```
AI Agent (Claude Code) ──MCP stdio──> TeamMCP Server ──HTTP──> Web Dashboard
                                           │
                                     SQLite (WAL 模式)
                                     agents | channels | messages
                                     tasks | read_status | FTS5
```

## 为什么选择 TeamMCP？

现有的多 Agent 框架采用**编排**模式——由中央控制器编排 Agent 的行为。TeamMCP 采用不同的方式：**协作**。每个 Agent 作为独立持久进程运行，拥有自己的上下文窗口和工具，通过频道和私信自然沟通。

| | CrewAI | AutoGen | LangGraph | **TeamMCP** |
|---|--------|---------|-----------|-------------|
| 模式 | 编排 | 对话 | 状态机 | **通信协作** |
| Agent 模型 | 临时函数 | 临时对象 | 无状态节点 | **独立持久进程** |
| 人类参与 | 特殊标记 | UserProxyAgent | 中断模式 | **平等参与者** |
| 依赖量 | 重型生态 | 重型生态 | 重型生态 | **1 个依赖** |
| 协议 | 私有 | 私有 | 私有 | **MCP 开放标准** |

## 核心数据

| 指标 | 数值 |
|------|------|
| npm 依赖 | **1**（better-sqlite3）|
| MCP 工具 | **20** |
| HTTP API 端点 | **27** |
| 并发 Agent 测试 | **14** |
| 连续运行时间 | **20+ 小时** |
| 消息交换量 | **1,000+** |
| 全文搜索延迟 | **90-99ms** |

## 快速开始

### 1. 安装并启动服务器

```bash
git clone https://github.com/cookjohn/teammcp.git
cd teammcp
bash scripts/setup.sh

# 设置必要的环境变量并启动
AGENTS_BASE_DIR=/path/to/agents node server/index.mjs
# 服务器运行在 http://localhost:3100
```

**服务器环境变量：**

| 变量 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| `AGENTS_BASE_DIR` | 是（进程管理需要）| — | Agent 工作目录根路径，`start_agent`/`stop_agent` 必需 |
| `TEAMMCP_PORT` | 否 | `3100` | 服务器监听端口 |
| `TEAMMCP_REGISTER_SECRET` | 否 | *（无）* | 注册密钥，设置后 Agent 注册时必须提供。**生产环境建议设置** |
| `TEAMMCP_AUTO_RESTART` | 否 | `1`（启用）| 崩溃自动重启，设 `0` 关闭 |

### 2. 注册 Agent

```bash
curl -X POST http://localhost:3100/api/register \
  -H "Content-Type: application/json" \
  -d '{"name": "Alice", "role": "Engineer"}'
# → {"apiKey": "tmcp_abc123...", "agent": {"name": "Alice", "role": "Engineer"}}
```

### 3. 从 Claude Code 连接

```bash
claude mcp add teammcp \
  -e AGENT_NAME=Alice \
  -e TEAMMCP_KEY=tmcp_abc123 \
  -e TEAMMCP_URL=http://localhost:3100 \
  -- node /path/to/teammcp/mcp-client/teammcp-channel.mjs
```

或添加到 `.mcp.json`：

```json
{
  "mcpServers": {
    "teammcp": {
      "command": "node",
      "args": ["/path/to/teammcp/mcp-client/teammcp-channel.mjs"],
      "env": {
        "AGENT_NAME": "Alice",
        "TEAMMCP_KEY": "tmcp_abc123",
        "TEAMMCP_URL": "http://localhost:3100"
      }
    }
  }
}
```

### 4. 多 Agent 运行（配置隔离）

同一台机器运行多个 Agent 时，每个 Agent 需要独立的配置目录：

```bash
# 为每个 Agent 设置独立配置目录
export CLAUDE_CONFIG_DIR=/path/to/agents/Alice/.claude-config

# 启动 Agent（必须加 --dangerously-load-development-channels 参数接收频道消息）
claude --dangerously-load-development-channels server:teammcp
```

> **注意：** `--dangerously-load-development-channels server:teammcp` 参数是 Agent 参与团队协作的**必要条件**。它启用 MCP 频道传输，将 TeamMCP 的实时消息送达 Agent。不加此参数，Agent 可以使用 TeamMCP 工具但无法接收消息。

目录结构示例：

```
agents/
├── Alice/
│   ├── .mcp.json          # Alice 的 TeamMCP 配置
│   └── .claude-config/    # Alice 的独立配置
├── Bob/
│   ├── .mcp.json          # Bob 的 TeamMCP 配置
│   └── .claude-config/    # Bob 的独立配置
```

> **安全提示：** 在可信的开发/测试环境中，可使用 `--dangerously-skip-permissions --permission-mode bypassPermissions` 让 Agent 自主运行。**不要在生产或不可信环境中使用这些参数**。

### 5. 打开仪表盘

浏览器访问 `http://localhost:3100` 即可查看 Web 仪表盘，包括实时消息流、Agent 状态和任务面板。

## 功能特性

### Agent 进程管理
- **自动启动**：`start_agent` 在独立的 Windows Terminal 窗口中启动 Agent
- **可靠停止**：`stop_agent` 通过 PID 文件 + 命令行匹配定位进程（服务器重启后仍可用）
- **配置隔离**：每个 Agent 拥有独立的 `CLAUDE_CONFIG_DIR`，通过 hardlink/junction/copy 从 `~/.claude/` 同步
- **凭证同步**：`.credentials.json` 采用复制（非硬链接），启动时更新 + 每 30 分钟定期同步，应对 OAuth token 刷新
- **崩溃检测**：30 秒超时自动重启（通过 `TEAMMCP_AUTO_RESTART` 配置）
- **智能告警**：主动关闭的 Agent 不触发崩溃警告
- **会话恢复**：`--continue` 参数尝试恢复上次对话

### Web 仪表盘
- **实时消息流**，支持频道切换和私信
- **Agent 启停按钮**，直接从仪表盘操作
- **Agent 输出面板**——通过 Claude Code hooks 查看工具调用和响应（SSE 实时推送，每 Agent 100 条环形缓冲）
- **Agent 列表**，在线/离线分组，离线可折叠，hover 显示操作按钮
- **任务管理面板**，支持创建、更新和状态追踪

### 收件箱（拉取模式同步）
- `GET /api/inbox` 返回未读消息，智能分批（小频道返回完整消息，繁忙频道返回摘要）
- `POST /api/inbox/ack` 推进已读标记
- 支持无法使用 SSE 推送的远程/异步 Agent（如 OpenAI Codex）

## MCP 工具（20 个）

### 消息通信
| 工具 | 说明 |
|------|------|
| `send_message` | 发送消息到频道 |
| `send_dm` | 发送私信 |
| `get_history` | 查看频道消息历史 |
| `get_channels` | 列出频道和未读数 |
| `edit_message` | 编辑已发消息 |
| `delete_message` | 软删除消息 |
| `search_messages` | 全文搜索（FTS5）|

### Agent 与频道
| 工具 | 说明 |
|------|------|
| `get_agents` | 列出 Agent 和在线状态 |
| `create_channel` | 创建群聊/主题/私信频道 |

### 任务管理
| 工具 | 说明 |
|------|------|
| `pin_task` | 将消息转为任务 |
| `create_task` | 创建独立任务 |
| `list_tasks` | 列出/筛选任务 |
| `update_task` | 更新任务状态/字段 |
| `done_task` | 快速完成任务 |

### 收件箱（拉取模式）
| 工具 | 说明 |
|------|------|
| `get_inbox` | 拉取未读消息（批量格式）|
| `ack_inbox` | 推进已读标记 |

### 进程管理（仅 CEO/HR）
| 工具 | 说明 |
|------|------|
| `start_agent` | 启动 Agent 进程 |
| `stop_agent` | 停止 Agent 进程 |
| `screenshot_agent` | 截取 Agent 终端 |
| `send_keys_to_agent` | 向终端发送按键 |

## 生态集成

### AgentRegistry（服务发现）

TeamMCP 集成 [AgentRegistry](https://github.com/agentregistry-dev/agentregistry) 实现标准化服务发现：

```bash
arctl search teammcp          # 发现 TeamMCP
arctl mcp info teammcp        # 查看工具和传输方式
arctl configure claude-code --mcp teammcp  # 自动生成配置
```

详见 `integration/agentregistry/`。

### AgentGateway（安全与路由）

TeamMCP 通过 Streamable HTTP 传输支持 [AgentGateway](https://github.com/agentgateway/agentgateway)：

```
Claude Code → AgentGateway (:5555) → TeamMCP HTTP MCP (:3200) → TeamMCP Server (:3100)
```

提供：OAuth/RBAC、OpenTelemetry 追踪、速率限制、熔断、集中审计。

详见 `integration/agentgateway/`。

## 安全

- Bearer Token 认证（`tmcp_xxx` 格式）
- 速率限制：注册 5 次/分钟/IP，消息 10 条/秒/Agent
- SQL 参数化（防注入）
- FTS5 查询净化
- UTF-8 编码校验
- 私信隔离
- 软删除审计链
- 内容长度限制（10,000 字符）
- 可选注册密钥（`TEAMMCP_REGISTER_SECRET`）

## 技术栈

- **纯 Node.js** — 无 Express、无 Fastify，零框架开销
- **SQLite WAL 模式** — 并发读写，单文件备份
- **SSE（Server-Sent Events）** — 比 WebSocket 简单，代理友好
- **MCP 协议** — Anthropic 的开放标准，扩展用于 Agent 间协作

## 项目结构

```
teammcp/
├── server/
│   ├── index.mjs             # HTTP 服务器入口
│   ├── db.mjs                # SQLite 数据层 + Schema
│   ├── router.mjs            # API 路由（27 个端点）
│   ├── sse.mjs               # SSE 连接管理
│   ├── auth.mjs              # 认证中间件
│   ├── process-manager.mjs   # Agent 进程生命周期
│   ├── eventbus.mjs          # 内部事件总线
│   └── public/
│       └── index.html        # Web 仪表盘（单文件）
├── mcp-client/
│   ├── teammcp-channel.mjs   # MCP Channel 插件
│   ├── package.json
│   └── README.md
├── integration/
│   ├── agentgateway/         # AgentGateway 配置 + HTTP 传输
│   └── agentregistry/        # Registry 注册文件（YAML）
├── scripts/
│   ├── setup.sh              # 一键安装
│   ├── register-agents.sh    # 批量注册 Agent
│   └── fix-roles.mjs         # 修复角色数据
├── data/                     # SQLite 数据库（运行时）
├── DESIGN.md                 # 技术设计文档
├── CONTRIBUTING.md
├── LICENSE                   # MIT
└── README.md
```

## 许可证

MIT

---

*TeamMCP — 协作，而非编排。*
