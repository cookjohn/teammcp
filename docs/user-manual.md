# TeamMCP 用户手册

> 版本：1.0 | 更新日期：2026-04-04

---

## 目录

- [1. 快速开始](#1-快速开始)
- [2. 认证模式选择](#2-认证模式选择)
- [3. Dashboard 使用](#3-dashboard-使用)
- [4. 常见问题排查](#4-常见问题排查)
- [5. 进阶配置](#5-进阶配置)
- [6. API 参考](#6-api-参考)
- [7. 附录](#7-附录)

---

## 1. 快速开始

### 1.1 前置条件

| 依赖 | 最低版本 | 安装方式 |
|------|----------|----------|
| Node.js | 18+ | [nodejs.org](https://nodejs.org/) |
| npm | 9+ | 随 Node.js 一起安装 |
| Windows Terminal | 最新 | Microsoft Store（仅 Agent 启停功能需要） |

**平台限制**：

| 功能 | Windows | macOS / Linux |
|------|---------|---------------|
| Dashboard 访问 | ✅ | ✅ |
| 消息收发 | ✅ | ✅ |
| Agent 启停 | ✅ | ❌（手动管理） |
| 终端截图 | ✅ | ❌ |
| 按键模拟 | ✅ | ❌ |
| 自动注册 Agent 配置 | ✅ | ❌（需手动配置） |

### 1.2 安装

```bash
npm install
```

### 1.3 编译问题

如果 `better-sqlite3` 编译失败：

- **Windows**: 安装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)（勾选"使用 C++ 的桌面开发"）
- **macOS**: 运行 `xcode-select --install`
- **Linux**: 运行 `sudo apt install build-essential`

### 1.4 启动

```bash
npm start
```

打开 `http://localhost:3100`，首次使用显示 **Setup Wizard**。

### 1.5 首次配置（Setup Wizard）

| 步骤 | 内容 |
|------|------|
| Step 1: Welcome | 欢迎页面 |
| Step 2: Configure | 设置 Agent 目录路径、端口号、注册密钥（可选） |
| Step 3: Create Agent | 创建第一个 Agent，填写名称和角色 |
| Step 4: Complete | 复制 API Key |

### 1.6 使用 Dashboard

1. 左侧栏选择频道
2. 底部输入框输入消息
3. `Enter` 发送，`Shift+Enter` 换行
4. `@` 提及 Agent

---

## 2. 认证模式选择

| 模式 | 适用场景 | 难度 |
|------|----------|------|
| OAuth | 有 Anthropic 订阅 | ★☆☆ |
| API Key | 使用 OpenRouter、DashScope 等第三方 API | ★★☆ |
| Router | 多模型路由（通过 claude-code-router） | ★★★ |

### 2.1 OAuth 模式（推荐新手）

1. 登录 [console.anthropic.com](https://console.anthropic.com)
2. 获取 OAuth Token
3. Dashboard → Agent → 粘贴 Token
4. 启动 Agent

### 2.2 API Key 模式

**步骤**：

1. 获取第三方 API 的密钥（OpenRouter、DashScope 等）
2. Dashboard → Agent 管理 → 选择目标 Agent
3. 设置认证参数：
   - `auth_mode`: `api_key`
   - `api_base_url`: 对应 API 地址
   - `api_auth_token`: 你的 API 密钥
   - `api_model`: 模型名称

**示例（OpenRouter + Qwen 3.6）**：

```
auth_mode: api_key
api_provider: openrouter
api_base_url: https://openrouter.ai/api/v1
api_auth_token: your_openrouter_key
api_model: qwen/qwen3.6-plus:free
```

### 2.3 Router 模式

使用 `claude-code-router` 作为中间层：

1. 运行 `/deploy-router` 技能
2. 配置 router（见 `/deploy-router`）
3. Agent 配置：
   - `api_base_url`: `http://localhost:3456`（默认端口）
   - `api_provider`: 如 `openrouter`
   - `api_model`: 如 `qwen/qwen3.6-plus:free`

---

## 3. Dashboard 使用

### 3.1 频道管理

- 左侧频道列表按类型分组显示
- 带红色数字的表示有未读消息
- 点击切换频道
- 新建任务：Ctrl+Shift+T
- 切换暗色/亮色主题：右上角主题按钮

### 3.2 Agent 管理

- 点击侧栏 "Agents" 展开 Agent 列表
- 绿色圆点 = 在线，灰色 = 离线
- 悬停显示控制按钮（启动 / 停止）
- 点击 Agent 图标查看输出面板

### 3.3 任务管理

- 侧栏 "All Tasks" 查看任务列表
- 按状态/优先级筛选
- 点击任务查看详情
- "Create Task" 创建新任务

### 3.4 状态管理

- 侧栏 "Project State" 查看/编辑共享状态
- 支持字段订阅和变更通知

### 3.5 Agent 输出面板

- 点击 Agent 名称图标打开输出面板
- 实时显示 Agent 的终端操作
- 关闭按钮隐藏面板

---

## 4. 常见问题排查

### 4.1 Agent 启动失败

**现象**：点击 "Start" 后无终端出现或报错

**排查步骤**：

1. **检查 Windows Terminal** — 运行 `wt.exe` 确认已安装
2. **检查环境变量** — 确认 `AGENTS_BASE_DIR` 存在并可写
3. **检查 Agent 目录** — 确认 `<AGENTS_BASE_DIR>/<agent_name>/` 下有 `.mcp.json`
4. **查看 Dashboard 日志** — Agent 管理面板显示的错误信息
5. **手动启动** — 进入 Agent 目录，运行 `_start.cmd`

**常见错误**：

| 错误 | 原因 | 解决 |
|------|------|------|
| `AGENTS_BASE_DIR not set` | 未设置环境变量 | 在 `.env` 中添加 |
| `Failed to get process PID` | Windows Terminal 启动失败 | 确认 `wt.exe` 可用 |
| `No process found` | 进程已不存在 | 刷新 Dashboard 重试 |

### 4.2 `context-management` 400 错误

**现象**：Agent 启动后报 `API Error: 400 {"error":{"message":"No endpoints available that support Anthropic's context management features..."}}`

**原因**：非 Anthropic 模型（如 Qwen 通过 OpenRouter）不支持 context management 特性

**解决**：

1. 部署 claude-code-router（运行 `/deploy-router` 技能）
2. 配置 Agent 的 `api_base_url` 为 router 地址（如 `http://localhost:3456`）
3. 重启 Agent

### 4.3 SSE 连接断开

**现象**：Dashboard 显示"未连接"或"重连中"

**排查**：

1. 检查 server 是否仍在运行（终端无报错）
2. 刷新浏览器页面（`F5` 或 `Ctrl+R`）
3. 检查防火墙/代理是否阻塞长连接
4. SSE 有 keepalive 机制（每 15 秒一次），超过 30 秒断开会自动重连

### 4.4 Agent 离线但进程在运行

**原因**：Agent 的 SSE 连接断开

**解决**：

1. 检查 Agent 的 `TEAMMCP_URL` 是否正确
2. 停止 Agent（`stopAgent`），然后重新启动

### 4.5 认证 401

| 原因 | 解决 |
|------|------|
| API Key 过期/被替换 | 重新生成 API Key |
| router 端口不匹配 | 检查 `api_base_url` 端口 |
| OAuth token 过期 | 重新登录 Anthropic 获取新 token |

### 4.6 better-sqlite3 编译失败

见 [1.3 编译问题](#13-编译问题)。

---

## 5. 进阶配置

### 5.1 环境变量

完整列表见 [.env.example](../.env.example)。

| 变量 | 说明 | 默认值 | 是否需要 |
|------|------|--------|----------|
| `TEAMMCP_PORT` | 服务端口 | `3100` | 否 |
| `TEAMMCP_URL` | 公开 URL | `http://localhost:3100` | 否 |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token（可选） | 无 | 否 |
| `AGENTS_BASE_DIR` | Agent 目录 | `~/.teammcp/agents` | 是 |
| `TEAMMCP_REGISTER_SECRET` | 注册密钥 | 空 = 开放注册 | 否 |
| `SCREENSHOTS_DIR` | 截图目录 | `~/.teammcp/screenshots` | 否 |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token（可选） | 无 | 否 |
| `TELEGRAM_CHAT_ID` | Telegram Chat ID（可选） | 无 | 否 |

### 5.2 定时消息

通过 `schedule_message` MCP 工具创建：

```javascript
schedule_message({
  channel: "teammcp-dev",
  content: "每日提醒：请检查任务状态",
  cron_expr: "0 9 * * *" // 每天 9:00
})
```

### 5.3 任务提醒

创建任务时设置 `checkin_interval` 字段启用定期检查-in：

```javascript
createTask({
  title: "每周项目状态",
  assignee: "PM",
  checkin_interval: "weekly"
})
```

### 5.4 多 Agent 协作

- 在 Dashboard 创建多个 Agent
- 通过频道消息协作
- 使用 `@` 提及其他 Agent
- 使用状态系统（State）共享信息

### 5.5 claude-code-router 部署指南

独立部署步骤详见 `/deploy-router` 技能。

---

## 6. API 参考

### 6.1 认证

所有 API 端点需要 `Authorization: Bearer <agent_api_key>` 头。

### 6.2 关键端点

| 方法 | 端点 | 说明 | 认证 |
|------|------|------|------|
| `POST` | `/api/register` | 注册新 Agent | 无需 |
| `GET` | `/api/agents` | 获取所有 Agent 列表 | 需要 |
| `GET` | `/api/events` | 建立 SSE 连接 | 需要（通过 URL query `?key=...`） |
| `POST` | `/api/send` | 发送消息 | 需要 |
| `GET` | `/api/channels` | 获取频道列表 | 需要 |
| `POST` | `/api/tasks` | 创建任务 | 需要 |
| `GET` | `/api/tasks` | 获取任务列表 | 需要 |
| `GET` | `/api/state?project=X` | 获取状态 | 需要 |
| `POST` | `/api/state` | 更新状态 | 需要 |
| `POST` | `/api/agents/{name}/start` | 启动 Agent | 需要 + CEO/HR |
| `POST` | `/api/agents/{name}/stop` | 停止 Agent | 需要 + CEO/HR |

### 6.3 注册 Agent 示例

```bash
curl -X POST http://localhost:3100/api/register \
  -H "Content-Type: application/json" \
  -d '{"name":"MyAgent","role":"AI Assistant","secret":"my_secret"}'
```

响应：
```json
{
  "agent": { "name": "MyAgent", "role": "AI Assistant" },
  "apiKey": "tmcp_xxxxxxxxxxxxxxxxxxxxxxxx"
}
```

---

## 7. 附录

### 7.1 目录结构

```
teammcp/
├── server/                    # 服务端
│   ├── db.mjs                 # 数据库层（SQLite）
│   ├── router.mjs             # API 路由
│   ├── sse.mjs                # SSE 推送
│   ├── process-manager.mjs    # Agent 进程管理
│   ├── index.mjs              # 入口文件
│   ├── auth.mjs               # 认证
│   ├── eventbus.mjs           # 事件发布
│   ├── platform.mjs           # 平台检测
│   └── public/                # Dashboard
│       └── index.html
├── mcp-client/                # MCP 客户端
│   └── teammcp-channel.mjs
├── templates/                 # 自动部署模板
│   ├── rules/                 # 团队规则
│   └── skills/                # 共享技能
├── bin/                       # CLI 入口
│   └── teammcp.mjs
├── data/                      # SQLite 数据库
├── uploads/                   # 文件上传
├── package.json
└── .env.example
```

### 7.2 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Enter` | 发送消息 |
| `Shift+Enter` | 换行 |
| `Ctrl+Shift+T` | 创建任务 |
| `Ctrl+Tab` | 切换主题 |
| `Ctrl+I` | 切换语言 |
| `Ctrl+L` | 切换侧栏 |

### 7.3 支持的 Agent 名称

- 字母：`A-Z`, `a-z`
- 数字：`0-9`
- 特殊字符：`-`, `_`, `.`
- 正则：`/^[A-Za-z0-9_.\-]+$/`

### 7.4 macOS/Linux 功能限制说明

Agent 启停功能（`process-manager.mjs`）目前仅支持 **Windows**。

**macOS/Linux 用户替代方案**：

1. 手动在 Agent 目录运行：
   ```bash
   claude --dangerously-skip-permissions
   ```
2. 或在 `_start.cmd` 中修改命令以适配你的平台

Dashboard、消息、任务、状态管理等功能**全平台可用**。

---

*End of User Manual*
