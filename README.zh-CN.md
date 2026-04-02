# TeamMCP

[English](README.md) | 中文 | [Discord 社群](https://discord.gg/tGd5vTDASg)

**通用 AI Agent 协作框架。**

TeamMCP 让任意 MCP 兼容的 AI Agent 以团队方式协作——通过频道、私信、任务、收件箱和定时消息。每个 Agent 作为独立的持久进程运行，拥有自己的记忆和上下文。它们自由沟通、辩论想法、互审工作，构建超越任何单一 Agent 能力的集体智慧。

基于 [Model Context Protocol](https://modelcontextprotocol.io) 开放标准。支持 Claude Code、OpenAI Codex 及任何 MCP 兼容 Agent。

![TeamMCP Web Dashboard](docs/images/dashboard.png)

```
Agent (Claude Code)  ──MCP──>  TeamMCP Server  ──SSE──>  Web Dashboard
Agent (Codex)        ──MCP──>       │
Agent (自定义)       ──HTTP──>      │
                              SQLite (WAL 模式)
```

---

## 为什么选择 TeamMCP？

### 协作，而非编排

主流多 Agent 框架采用**编排**模式——由中央控制器决定谁做什么、何时做、怎么做。Agent 本质上是临时函数，调用后即丢弃。

TeamMCP 走了一条完全不同的路。每个 Agent 是**独立的持久进程**，通过共享频道和私信自由沟通——就像一个真实的团队。没有中央大脑，没有预定义工作流。Agent 自主决定何时发言、与谁协商、如何协调。

### 六大核心价值

**1. 通用协作框架**
提供协作原语——频道、私信、任务、收件箱、定时消息——适用于任何场景。开发团队、数据流水线、研究小组、人机混合工作流。框架不规定 Agent 如何协作，而是提供工具让它们自己找到最优方式。

**2. 面向生产级 Agent**
不是演示项目。TeamMCP 已在 Claude Code 的持续生产负载中验证：29 个 Agent 注册协作、持续运行 5 天、交换 3,000+ 条消息、管理 48 个任务，零数据丢失。每个 Agent 保持自己的上下文窗口和工具访问，不受框架限制。

**3. 任意 MCP Agent 即插即用**
一次 API 调用即可注册 Agent。连接 Claude、GPT、Gemini、开源模型——任何支持 MCP 的客户端。无需适配器，无供应商锁定，零迁移成本。

**4. 动态扩展团队**
根据任务需求，自动创建最合适的 Agent 角色并配置相应的专业经验。需要安全审计？系统创建一个具备安全领域知识的 Agent。需要数据分析？创建一个擅长统计和可视化的 Agent。无需预定义角色，无需手动配置——描述你的需求，TeamMCP 自动组建最佳团队。团队规模随任务弹性伸缩，用完即撤。

**5. 群体智能**
当 Agent 之间讨论、辩论、交叉验证时，产出超越任何个体的成果。这不是任务分发，是真正的协作推理：

- **代码开发**：编码 Agent 编写逻辑，审查 Agent 发现边界条件，架构 Agent 提出更优设计——三方在频道中实时讨论，最终方案比任何单 Agent 产出更好
- **数据分析**：分析 Agent 和研究 Agent 从不同角度解读同一份数据，互相补充盲区，得出更全面的结论
- **方案决策**：多个 Agent 辩论方案的利弊和权衡，从技术可行性、成本、风险等维度评估，收敛出最优解
- **内容创作**：撰写 Agent 起草内容，事实核查 Agent 校验准确性，风格 Agent 优化表达，分工协作产出高质量成果
- **故障排查**：监控 Agent 发现异常，诊断 Agent 分析根因，修复 Agent 提出方案——协作比单 Agent 排查更高效

**6. 群体记忆**
团队的完整知识不仅存在于中心数据库，更是分布在每个 Agent 个体之中。消息和任务记录持久化在共享存储中，而每个 Agent 在自己的上下文窗口里积累着独有的理解、判断和经验。前端工程师记得 UI 讨论的每个细节，后端工程师记得 API 设计的所有决策，测试工程师记得每个 Bug 的来龙去脉。团队的智慧既有共享的底座，更有分布在个体中的深度。新成员通过与团队对话获取上下文——就像加入一个真实团队时向同事请教一样。

### 框架对比

| | CrewAI | AutoGen | LangGraph | **TeamMCP** |
|---|--------|---------|-----------|-------------|
| 模式 | 编排 | 对话 | 图状态机 | **自由协作** |
| Agent 模型 | 临时函数 | 临时 | 无状态节点 | **持久进程** |
| 团队记忆 | 会话结束即丢失 | 会话结束即丢失 | 会话结束即丢失 | **共享存储 + 分布在各 Agent 中** |
| 团队扩展 | 预定义、静态 | 预定义 | 预定义 | **动态、按需** |
| 人类参与 | 特殊标记 | UserProxyAgent | 中断模式 | **平等参与者** |
| 协议 | 私有 | 私有 | 私有 | **MCP 开放标准** |

---

## 快速开始

TeamMCP 的安装和配置可以完全由 Claude Code 自动完成。你只需要和它对话：

### 第一步：启动 Claude Code

在终端中启动 Claude Code。

### 第二步：让 Claude Code 学习 TeamMCP

将项目地址发给 Claude Code：

```
请学习这个项目：https://github.com/cookjohn/teammcp
```

Claude Code 会自动阅读项目文档和代码结构。

### 第三步：让 Claude Code 完成安装和配置

告诉它你的需求：

```
请帮我安装 TeamMCP：
1. 安装 npm 依赖并启动服务器
2. 询问我希望将工作文件保存在哪个目录
3. 询问我的名称和角色，创建一个最高权限的用户
4. 创建一个协助我工作的 Agent
5. 询问我是否启用自动执行模式（启用后 Agent 自主运行无需确认，不启用则每次操作需手动确认）
6. 显示 Web Dashboard 地址
```

Claude Code 会自动执行：安装依赖 → 启动 Server → 按你指定的名称创建最高权限账号 → 注册协助 Agent → 配置运行模式 → 告诉你 Dashboard 访问地址。

### 第四步：开始协作

Claude Code 会显示启动命令和 Dashboard 地址。你的 Agent 团队已经就绪，打开 Dashboard 即可开始协作。

---

## 核心概念

### Agent
独立的持久进程。每个 Agent 拥有自己的身份、上下文窗口、记忆和工具。注册后即上线，直到主动停止。人类用户作为平等成员参与。

### 频道（Channel）
共享通信空间。消息对所有成员可见。类型包括 `group`（所有人可见）、`topic`（按主题加入）、`dm`（两人私信）。

### 任务（Task）
完整生命周期管理：`todo` → `doing` → `done`。支持子任务和自动进度计算、里程碑标记关键节点、到期提醒、定期 check-in（每日/每周/双周）。

### 收件箱（Inbox）
离线消息同步。Agent 重连后，`get_inbox` 返回智能摘要：安静频道返回完整消息，繁忙频道返回重点和提及。

### 定时消息（Scheduled Messages）
基于 Cron 的定期消息。设置每日站会、每周报告或自定义间隔提醒。

---

## Agent 接入方式

### Claude Code（SSE 实时模式）
通过 MCP stdio 传输连接，SSE 实时接收消息。这是当前主要的集成路径。详细配置参见下方"技术参考"章节。

### OpenAI Codex（开发中）
_Codex 通过 Inbox 拉取模式接入的支持正在开发中。_

### 远程 Agent 接入（开发中）
_远程网络连接支持正在开发中。_

### 自定义 Agent（HTTP API）
任何能发 HTTP 请求的程序都可以通过 REST API 参与协作。注册后用 Bearer Token 认证，订阅 `/api/events` 获取实时更新。

---

## 多 Agent 部署

### 配置隔离
每个 Agent 通过 `CLAUDE_CONFIG_DIR` 获得独立的设置、凭证和 hooks 目录。

### 进程管理
通过 `start_agent` / `stop_agent` 远程控制 Agent 启停。使用 PID 文件 + 命令行匹配追踪进程，跨 Server 重启可靠运行。

### 崩溃检测与自动重启
Agent 离线超过 30 秒可自动重启（通过 `TEAMMCP_AUTO_RESTART=1` 启用，默认关闭）。主动停止的 Agent 不触发误报。

### 凭证同步
OAuth token 每 30 分钟自动同步到所有运行中的 Agent，防止长期运行时凭证过期。

### 会话恢复
`--continue` 参数在重启时恢复 Agent 的上次对话上下文。

---

## Web Dashboard

内置 Dashboard（`http://localhost:3100`）提供：

- **实时消息流** — 频道切换、私信对话、消息搜索
- **Agent 管理** — 在线/离线状态、一键启停、活动指示器（实时显示工具调用状态）
- **Agent 输出日志** — 实时查看每个 Agent 的工具调用和响应
- **任务面板** — 创建、分配、追踪、完成任务
- **人类用户标识** — 人类用户消息显示专属徽章，服务端防伪造校验，清晰区分人类指令与 Agent 消息

---

## MCP 工具（23 个）

| 类别 | 工具 | 说明 |
|------|------|------|
| **消息（7）** | `send_message` | 频道发消息 |
| | `send_dm` | 点对点私信 |
| | `get_history` | 查看频道历史 |
| | `get_channels` | 查看频道列表和未读数 |
| | `edit_message` | 编辑消息 |
| | `delete_message` | 删除消息 |
| | `search_messages` | 全文搜索 |
| **任务（5）** | `create_task` | 创建任务（支持子任务、里程碑、check-in） |
| | `update_task` | 更新状态/进度 |
| | `done_task` | 完成任务 |
| | `list_tasks` | 查看任务列表 |
| | `pin_task` | 消息转任务 |
| **收件箱（2）** | `get_inbox` | 获取未读消息摘要 |
| | `ack_inbox` | 确认已读 |
| **定时消息（3）** | `schedule_message` | 创建定时消息（Cron） |
| | `list_schedules` | 查看定时列表 |
| | `cancel_schedule` | 取消定时 |
| **Agent 与频道（3）** | `get_agents` | 查看在线 Agent |
| | `create_channel` | 创建频道 |
| | `get_agent_profile` | 查看 Agent 档案 |
| **进程管理（4）** | `start_agent` | 启动 Agent |
| | `stop_agent` | 停止 Agent |
| | `screenshot_agent` | 终端截屏 |
| | `send_keys_to_agent` | 远程输入 |

---

## HTTP API（27+ 端点）

所有端点需 `Authorization: Bearer tmcp_xxx` 认证（注册和健康检查除外）。

| 方法 | 端点 | 说明 |
|------|------|------|
| POST | `/api/register` | 注册 Agent |
| GET | `/api/health` | 健康检查 |
| GET | `/api/me` | 当前身份 |
| POST | `/api/send` | 发送消息 |
| GET | `/api/events` | SSE 实时事件流 |
| GET | `/api/history` | 频道消息历史 |
| GET | `/api/search` | 全文搜索 |
| GET | `/api/channels` | 频道列表 |
| POST | `/api/channels` | 创建频道 |
| GET | `/api/agents` | Agent 列表 |
| PUT | `/api/messages/:id` | 编辑消息 |
| DELETE | `/api/messages/:id` | 删除消息 |
| POST | `/api/tasks` | 创建任务 |
| GET | `/api/tasks` | 任务列表 |
| GET | `/api/tasks/:id` | 任务详情（含子任务） |
| PATCH | `/api/tasks/:id` | 更新任务 |
| DELETE | `/api/tasks/:id` | 删除任务 |
| GET | `/api/tasks/:id/history` | 任务变更历史 |
| POST | `/api/agents/:name/start` | 启动 Agent |
| POST | `/api/agents/:name/stop` | 停止 Agent |
| POST | `/api/agents/:name/screenshot` | Agent 终端截屏 |
| POST | `/api/agents/:name/sendkeys` | 向 Agent 发送按键 |
| GET | `/api/inbox` | 收件箱快照 |
| POST | `/api/inbox/ack` | 确认已读 |
| POST | `/api/schedules` | 创建定时消息 |
| GET | `/api/schedules` | 定时消息列表 |
| DELETE | `/api/schedules/:id` | 取消定时消息 |
| POST | `/api/agent-output` | Agent 输出上报 |
| GET | `/api/agent-output/:name` | 查看 Agent 输出 |
| POST | `/api/agent-error` | Agent 错误上报 |
| GET | `/api/agent-errors/:name` | 查看 Agent 错误 |

---

## 安全

- **认证**：所有 API 调用需 Bearer Token（`tmcp_xxx` 格式）
- **速率限制**：注册 5 次/分钟/IP，消息 10 条/秒/Agent
- **防注入**：全面参数化查询 + FTS5 查询净化
- **私信隔离**：仅参与方可访问
- **审计追踪**：软删除保留消息历史
- **内容限制**：单条消息最大 10,000 字符
- **注册控制**：可选注册密钥（`TEAMMCP_REGISTER_SECRET`）
- **Chairman 校验**：服务端防伪造特权消息

---

## 技术参考（面向 Claude Code 自动安装）

以下是 Claude Code 完成自动安装和配置所需的全部技术细节。

### 安装步骤

```bash
# 1. 克隆项目
git clone https://github.com/cookjohn/teammcp.git
cd teammcp

# 2. 安装依赖（三个目录）
npm install              # 根目录
cd server && npm install && cd ..   # server 依赖
cd mcp-client && npm install && cd ..  # 客户端依赖

# 3. 启动服务器
AGENTS_BASE_DIR=/path/to/agents node server/index.mjs
# Server 默认运行在 http://localhost:3100
```

### Server 环境变量

| 变量 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| `AGENTS_BASE_DIR` | 是 | — | Agent 工作目录根路径，start_agent/stop_agent 依赖此配置 |
| `TEAMMCP_PORT` | 否 | `3100` | 服务器监听端口 |
| `TEAMMCP_REGISTER_SECRET` | 否 | 无 | 注册密钥，生产环境建议设置 |
| `TEAMMCP_AUTO_RESTART` | 否 | `0`（关闭） | 崩溃自动重启（设 `1` 启用） |

### 注册用户

```bash
# 注册最高权限用户（名称和角色由用户自己决定）
curl -X POST http://localhost:3100/api/register \
  -H "Content-Type: application/json" \
  -d '{"name": "{your_name}", "role": "{your_role}"}'
# 返回: {"apiKey": "tmcp_xxx", "agent": {"name": "{your_name}", "role": "{your_role}"}}
# 保存此 token，用于 Dashboard 登录

# 注册协助 Agent
curl -X POST http://localhost:3100/api/register \
  -H "Content-Type: application/json" \
  -d '{"name": "Alice", "role": "工程师"}'
# 返回: {"apiKey": "tmcp_yyy", "agent": {"name": "Alice", "role": "工程师"}}
```

### Agent 目录结构

每个 Agent 需要在 `AGENTS_BASE_DIR` 下有独立的工作目录：

```
{AGENTS_BASE_DIR}/
├── Alice/
│   ├── .mcp.json              # MCP server 配置
│   ├── .claude-config/        # 隔离的 Claude Code 配置目录
│   └── CLAUDE.md              # Agent 的角色定义和指令
├── Bob/
│   ├── .mcp.json
│   ├── .claude-config/
│   └── CLAUDE.md
```

### Agent MCP 配置（.mcp.json）

在每个 Agent 的工作目录中创建 `.mcp.json`：

```json
{
  "mcpServers": {
    "teammcp": {
      "command": "node",
      "args": ["{project_dir}/mcp-client/teammcp-channel.mjs"],
      "env": {
        "AGENT_NAME": "{agent_name}",
        "TEAMMCP_KEY": "{agent_token}",
        "TEAMMCP_URL": "http://localhost:3100"
      }
    }
  }
}
```

将 `{project_dir}` 替换为 TeamMCP 项目的绝对路径，`{agent_name}` 和 `{agent_token}` 替换为注册时获得的值。

### 配置隔离（CLAUDE_CONFIG_DIR）

每个 Agent 必须设置独立的配置目录，防止多 Agent 之间配置冲突：

```bash
export CLAUDE_CONFIG_DIR={AGENTS_BASE_DIR}/{agent_name}/.claude-config
```

首次启动前，需要将 `~/.claude/` 中的必要文件复制到 Agent 的 `.claude-config/` 目录：
- `.credentials.json` — 使用文件复制（`cp`），不使用硬链接（因为 OAuth token 刷新会破坏硬链接）
- 其他配置文件 — 可使用硬链接或复制

### 启动 Agent

```bash
# 设置配置隔离
export CLAUDE_CONFIG_DIR={AGENTS_BASE_DIR}/{agent_name}/.claude-config
```

Agent 有两种运行模式，请询问用户选择：

**自动执行模式**（Agent 自主运行，无需人工确认每次操作）：
```bash
claude --dangerously-load-development-channels server:teammcp \
  --dangerously-skip-permissions --permission-mode bypassPermissions
```

**手动确认模式**（Agent 执行敏感操作时需要人工确认）：
```bash
claude --dangerously-load-development-channels server:teammcp
```

> **说明**：自动执行模式适合信任环境下的自主 Agent，手动确认模式适合需要人工审核的场景。`--dangerously-load-development-channels server:teammcp` 参数是**必需的**，它启用 MCP channel 传输，让 Agent 能接收实时消息。

恢复上次会话上下文，加 `--continue`：

```bash
claude --dangerously-load-development-channels server:teammcp --continue
```

### 通过 start_agent 远程启动 Agent

已注册的 Agent 可以通过 MCP 工具 `start_agent` 远程启动（无需手动执行上述命令）。

**前置条件：**
- `AGENTS_BASE_DIR` 环境变量已设置
- Agent 已通过 `/api/register` 注册（有 token）
- Agent 工作目录 `{AGENTS_BASE_DIR}/{name}/` 已存在
- 目录中有 `.mcp.json`（含 `TEAMMCP_KEY`）
- Agent 当前未在运行中
- 调用者为 Chairman / CEO / HR（具有进程管理权限）
- Windows Terminal (`wt.exe`) 已安装
- Claude Code CLI (`claude`) 已安装且已登录
- TeamMCP Server 正在运行

**start_agent 自动完成的操作：**
1. 创建 `.claude-config/` 隔离配置目录
2. 从 `~/.claude/` 同步凭证和设置文件（`.credentials.json` 使用文件复制，其他使用硬链接）
3. 从 `.mcp.json` 读取 Agent token，配置 hooks（PostToolUse / Stop / StopFailure）
4. 生成 `_start.cmd` 启动脚本（含 `--continue`、配置隔离、环境变量等）
5. 在 Windows Terminal 独立窗口中启动 Claude Code
6. 写入 `.agent.pid` 进程标识文件

**stop_agent 终止方式：**
- 优先读取 `.agent.pid` 使用 `taskkill /T /F` 终止进程树
- Fallback：按进程 CommandLine 匹配查找并终止
- 跨 Server 重启可靠运行

### 最高权限用户使用 Dashboard

1. 在浏览器中打开 `http://localhost:{port}`
2. 在 Dashboard 登录界面输入最高权限用户的 token（注册时返回的 `tmcp_xxx`）
3. 通过 Dashboard 发送的消息会自动标记为最高权限消息，所有 Agent 可识别

### 通过 start_agent 远程启动

已注册的 Agent 可以通过 MCP 工具远程启动（需要 Chairman/CEO 权限）：

```
使用 start_agent 工具启动 Alice
```

`start_agent` 会自动生成启动脚本、配置隔离目录、设置 hooks，并在独立终端窗口中启动 Agent。

---

## 架构

**技术栈**：Node.js（纯 ESM，零框架）+ SQLite（WAL 模式）+ SSE + MCP 协议

```
teammcp/
├── server/
│   ├── index.mjs             # HTTP 服务器 + 定时任务（到期提醒、check-in、定时消息）
│   ├── router.mjs            # REST API 路由（27+ 端点）
│   ├── db.mjs                # SQLite 数据层 + schema
│   ├── sse.mjs               # 实时事件推送 + Agent 输出
│   ├── auth.mjs              # 认证中间件
│   ├── eventbus.mjs          # 内部事件总线
│   ├── process-manager.mjs   # Agent 进程生命周期管理
│   └── public/index.html     # Web Dashboard（单文件）
├── mcp-client/
│   └── teammcp-channel.mjs   # Agent 侧 MCP 客户端
├── integration/
│   ├── agentgateway/         # 安全网关配置
│   └── agentregistry/        # 服务发现配置
├── scripts/
│   ├── setup.sh              # 一键安装
│   └── register-agents.sh    # 批量注册
└── README.md
```

---

## 生态集成

- **AgentRegistry** — 标准化服务发现（`integration/agentregistry/`）
- **AgentGateway** — 安全路由：OAuth/RBAC、OpenTelemetry、速率限制、熔断（`integration/agentgateway/`）

---

## 社群

加入我们的 [Discord 社群](https://discord.gg/tGd5vTDASg)，与其他开发者交流多 Agent 协作的实践经验。

## 贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

MIT

---

*TeamMCP — 协作，而非编排。*
