# Server-Side Workspace 设计文档

> **版本**: v1.0  
> **作者**: CTO  
> **日期**: 2026-04-10  
> **状态**: Draft  

---

## 目录

1. [架构概述](#1-架构概述)
2. [MCP 工具 API 设计](#2-mcp-工具-api-设计)
3. [权限模型](#3-权限模型)
4. [网络容错](#4-网络容错)
5. [安全考量](#5-安全考量)
6. [实现计划](#6-实现计划)
7. [使用示例](#7-使用示例)

---

## 1. 架构概述

### 1.1 问题背景

远程 Agent（如通过公网连接的 Claude Code 实例）需要在 TeamMCP 服务器所在机器上执行文件操作（读取、编辑、写入、搜索、运行命令）。当前存在以下痛点：

- **Token 容量有限** — 无法通过消息上下文传递大文件内容
- **网络不稳定** — 公网环境下连接可能中断、超时
- **缺乏权限控制** — 没有机制限制 Agent 对文件系统的访问范围
- **已有通道未复用** — TeamMCP 已建立 SSE+HTTP 通道，应直接扩展而非另建通道

### 1.2 方案概述

在现有 TeamMCP HTTP API 层新增 Workspace 工具组，远程 Agent 通过标准 HTTP 请求调用文件操作工具，服务器在本地执行并返回紧凑结果。核心设计原则：

- **编辑传差异** — `workspace_edit` 使用精确字符串替换，不传输完整文件
- **输出传摘要** — `workspace_bash` 返回首尾摘要，完整输出按需分页获取
- **读取可分页** — `workspace_read` / `workspace_grep` 支持 offset+limit 分页

### 1.3 架构图

```
┌─────────────────────────────────────────────────────────────┐
│                     Remote Agent (Claude Code)               │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ workspace_   │  │ workspace_   │  │ workspace_bash   │   │
│  │ read/edit/   │  │ grep         │  │                  │   │
│  │ write        │  │              │  │                  │   │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘   │
│         │                 │                    │             │
└─────────┼─────────────────┼────────────────────┼─────────────┘
          │                 │                    │
          ▼                 ▼                    ▼
    ╔═══════════════════════════════════════════════════╗
    ║          HTTP POST /api/workspace/{tool}          ║
    ║          Authorization: Bearer tmcp_xxx           ║
    ╚═══════════════════════╤═══════════════════════════╝
                            │
          ┌─────────────────▼──────────────────┐
          │         TeamMCP Server (:3100)       │
          │                                     │
          │  ┌───────────┐   ┌──────────────┐  │
          │  │ router.mjs│──▶│  auth.mjs    │  │
          │  │ /api/     │   │  requireAuth │  │
          │  │ workspace/│   └──────┬───────┘  │
          │  └─────┬─────┘          │          │
          │        │         ┌──────▼───────┐  │
          │        ├────────▶│workspace.mjs │  │
          │        │         │              │  │
          │        │         │ - 路径校验    │  │
          │        │         │ - 权限检查    │  │
          │        │         │ - 文件操作    │  │
          │        │         │ - 审计日志    │  │
          │        │         └──────┬───────┘  │
          │        │                │          │
          │  ┌─────▼────────────────▼───────┐  │
          │  │          db.mjs              │  │
          │  │  workspace_config 表         │  │
          │  │  workspace_audit_log 表      │  │
          │  └─────────────────────────────┘  │
          │                                     │
          │  ┌─────────────────────────────┐    │
          │  │    Local Filesystem          │    │
          │  │    /workspace/agent-A/       │    │
          │  │    /workspace/agent-B/       │    │
          │  └─────────────────────────────┘    │
          └─────────────────────────────────────┘
```

### 1.4 典型数据流（以 workspace_edit 为例）

```
Agent                           Server
  │                               │
  │  POST /api/workspace/edit     │
  │  {path, old_string,           │
  │   new_string, replace_all}    │
  │ ─────────────────────────────▶│
  │                               │── auth.mjs: 验证 tmcp_xxx
  │                               │── workspace.mjs: 校验 path 在允许范围内
  │                               │── workspace.mjs: 读取文件，查找 old_string
  │                               │── workspace.mjs: 执行替换，写回文件
  │                               │── db.mjs: 写入 audit_log
  │                               │
  │  200 {success: true,          │
  │   matched_line: 42,           │
  │   preview: [...]}             │
  │ ◀─────────────────────────────│
```

---

## 2. MCP 工具 API 设计

所有 Workspace 工具共享以下约定：

- **HTTP 方法**: `POST`
- **路径前缀**: `/api/workspace/{tool_name}`
- **认证**: `Authorization: Bearer tmcp_xxx`（复用现有 `requireAuth`）
- **请求体**: JSON
- **响应体**: JSON，统一格式 `{ ok: boolean, data?: {...}, error?: string }`

### 2.1 workspace_read — 读取文件内容

**用途**: 按行读取文件内容，支持分页。

**路由**: `POST /api/workspace/read`

**请求参数**:

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `path` | string | 是 | — | 相对于 workspace 根目录的文件路径 |
| `offset` | number | 否 | 0 | 起始行号（0-based） |
| `limit` | number | 否 | 200 | 读取行数，最大 2000 |

**成功响应** (200):

```json
{
  "ok": true,
  "data": {
    "path": "server/router.mjs",
    "lines": [
      { "n": 1, "content": "import { URL } from 'node:url';" },
      { "n": 2, "content": "import crypto from 'node:crypto';" }
    ],
    "total_lines": 2357,
    "returned": 200,
    "truncated": true
  }
}
```

**错误响应**:

| 状态码 | error | 场景 |
|--------|-------|------|
| 404 | `file_not_found` | 文件不存在 |
| 403 | `permission_denied` | Agent 无权访问该路径 |
| 403 | `path_outside_workspace` | 路径越界（路径遍历攻击） |
| 400 | `invalid_params` | 参数校验失败（如 limit 超过 2000） |

---

### 2.2 workspace_edit — 精确字符串替换

**用途**: 通过精确匹配 `old_string` 进行文件编辑，只传差异，不传完整文件。

**路由**: `POST /api/workspace/edit`

**请求参数**:

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `path` | string | 是 | — | 相对于 workspace 根目录的文件路径 |
| `old_string` | string | 是 | — | 要替换的原始字符串 |
| `new_string` | string | 是 | — | 替换后的新字符串 |
| `replace_all` | boolean | 否 | false | 是否替换所有匹配项 |

**成功响应** (200):

```json
{
  "ok": true,
  "data": {
    "success": true,
    "matched_line": 42,
    "matches_replaced": 1,
    "preview": [
      { "n": 40, "content": "  const config = loadConfig();" },
      { "n": 41, "content": "  // 新增缓存层" },
      { "n": 42, "content": "  const cached = cache.get(key);" },
      { "n": 43, "content": "  if (cached) return cached;" },
      { "n": 44, "content": "  const result = await fetch(url);" }
    ]
  }
}
```

**错误响应**:

| 状态码 | error | 场景 |
|--------|-------|------|
| 404 | `file_not_found` | 文件不存在 |
| 400 | `no_match` | `old_string` 在文件中未找到 |
| 400 | `multiple_matches` | 匹配到多处但 `replace_all` 为 false |
| 403 | `permission_denied` | Agent 无写权限 |
| 403 | `path_outside_workspace` | 路径越界 |
| 403 | `read_only_path` | 该路径为只读 |

---

### 2.3 workspace_write — 写入/创建文件

**用途**: 创建新文件或完整覆盖现有文件。

**路由**: `POST /api/workspace/write`

**请求参数**:

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `path` | string | 是 | — | 相对于 workspace 根目录的文件路径 |
| `content` | string | 是 | — | 文件内容 |
| `create_dirs` | boolean | 否 | true | 自动创建中间目录 |

**成功响应** (200/201):

```json
{
  "ok": true,
  "data": {
    "success": true,
    "bytes_written": 1542,
    "created": true,
    "path": "server/workspace.mjs"
  }
}
```

**错误响应**:

| 状态码 | error | 场景 |
|--------|-------|------|
| 403 | `permission_denied` | Agent 无写权限 |
| 403 | `path_outside_workspace` | 路径越界 |
| 403 | `read_only_path` | 该路径为只读 |
| 400 | `file_too_large` | 内容超过大小限制（默认 5MB） |
| 507 | `disk_full` | 磁盘空间不足 |

---

### 2.4 workspace_grep — 正则搜索文件内容

**用途**: 在 workspace 内搜索匹配正则表达式的文件内容。

**路由**: `POST /api/workspace/grep`

**请求参数**:

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `pattern` | string | 是 | — | 正则表达式模式 |
| `path` | string | 否 | `.` (workspace 根) | 搜索路径（相对于 workspace） |
| `glob` | string | 否 | — | 文件过滤 glob（如 `"*.mjs"`） |
| `max_results` | number | 否 | 50 | 最大返回结果数，上限 500 |

**成功响应** (200):

```json
{
  "ok": true,
  "data": {
    "matches": [
      {
        "file": "server/router.mjs",
        "line_number": 189,
        "content": "function json(res, data, status = 200) {"
      },
      {
        "file": "server/auth.mjs",
        "line_number": 9,
        "content": "export function authenticate(req) {"
      }
    ],
    "total_matches": 2,
    "truncated": false
  }
}
```

**错误响应**:

| 状态码 | error | 场景 |
|--------|-------|------|
| 400 | `invalid_regex` | 正则表达式语法错误 |
| 403 | `permission_denied` | Agent 无权访问搜索路径 |
| 403 | `path_outside_workspace` | 路径越界 |
| 408 | `search_timeout` | 搜索超时（默认 30 秒） |

**实现说明**: 服务端使用 `ripgrep`（若可用）或 Node.js `readline` + `RegExp` 逐行匹配。自动跳过二进制文件和 `node_modules`/`.git` 目录。

---

### 2.5 workspace_bash — 执行 Shell 命令

**用途**: 在 workspace 目录下执行 shell 命令，返回摘要结果。

**路由**: `POST /api/workspace/bash`

**请求参数**:

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `command` | string | 是 | — | 要执行的 shell 命令 |
| `timeout_ms` | number | 否 | 30000 | 超时时间（毫秒），最大 120000 |

**成功响应** (200):

```json
{
  "ok": true,
  "data": {
    "exit_code": 0,
    "stdout_summary": {
      "head": ["PASS src/auth.test.js", "PASS src/db.test.js"],
      "tail": ["Test Suites: 12 passed, 12 total", "Tests: 47 passed, 47 total"],
      "total_lines": 85
    },
    "stderr_summary": {
      "head": [],
      "tail": [],
      "total_lines": 0
    },
    "output_id": "ws_out_a1b2c3d4",
    "duration_ms": 4520
  }
}
```

`stdout_summary` 和 `stderr_summary` 各包含首 20 行（`head`）和末 20 行（`tail`），如果总行数 <= 40 则全部在 `head` 中返回，`tail` 为空。

**错误响应**:

| 状态码 | error | 场景 |
|--------|-------|------|
| 403 | `permission_denied` | Agent 无 bash 执行权限 |
| 403 | `command_blocked` | 命令匹配黑名单 |
| 408 | `command_timeout` | 命令执行超时 |
| 400 | `invalid_params` | 参数校验失败 |

---

### 2.6 workspace_bash_output — 获取完整命令输出

**用途**: 分页获取 `workspace_bash` 的完整输出内容。

**路由**: `POST /api/workspace/bash_output`

**请求参数**:

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `output_id` | string | 是 | — | `workspace_bash` 返回的 output_id |
| `offset` | number | 否 | 0 | 起始行号（0-based） |
| `limit` | number | 否 | 200 | 读取行数，最大 2000 |
| `stream` | string | 否 | `"stdout"` | 输出流：`"stdout"` 或 `"stderr"` |

**成功响应** (200):

```json
{
  "ok": true,
  "data": {
    "output_id": "ws_out_a1b2c3d4",
    "stream": "stdout",
    "lines": [
      { "n": 0, "content": "PASS src/auth.test.js" },
      { "n": 1, "content": "  ✓ validates API key (3ms)" }
    ],
    "total_lines": 85,
    "returned": 200,
    "truncated": false
  }
}
```

**错误响应**:

| 状态码 | error | 场景 |
|--------|-------|------|
| 404 | `output_not_found` | output_id 不存在或已过期（输出缓存保留 30 分钟） |
| 403 | `permission_denied` | 非该命令的执行者 |

---

## 3. 权限模型

### 3.1 Workspace 注册

每个 Agent 在注册时（或后续由管理员配置）关联一个 workspace 路径。Workspace 配置存储在 `workspace_config` 表中。

```sql
CREATE TABLE workspace_config (
  agent_name TEXT PRIMARY KEY,
  workspace_root TEXT NOT NULL,         -- 绝对路径，如 /home/user/projects/myapp
  permissions TEXT NOT NULL DEFAULT '{}', -- JSON: 细粒度权限配置
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agent_name) REFERENCES agents(name)
);
```

**permissions JSON 结构**:

```json
{
  "mode": "readwrite",
  "allowed_paths": ["server/", "src/", "tests/"],
  "denied_paths": [".env", "*.key", "credentials/"],
  "bash_enabled": true,
  "bash_blocked_commands": ["rm -rf /", "shutdown", "reboot", "mkfs", "dd if="],
  "max_file_size_mb": 5,
  "require_approval_paths": ["config.json", "package.json"]
}
```

### 3.2 目录访问控制

路径访问分为三级：

| 级别 | 说明 | 操作 |
|------|------|------|
| **readwrite** | 完全读写 | read, edit, write, grep, bash |
| **readonly** | 只读访问 | read, grep |
| **denied** | 禁止访问 | 任何操作均拒绝 |

**路径解析规则**:

1. 将请求中的相对路径 `resolve` 为绝对路径
2. 检查绝对路径是否以 `workspace_root` 开头（防止路径遍历）
3. 检查 `allowed_paths` 白名单（如配置了白名单，仅允许白名单内路径）
4. 检查 `denied_paths` 黑名单（总是生效，优先级高于白名单）
5. 检查 `require_approval_paths`，若匹配则触发审批流程

### 3.3 写操作审批流（可选）

对于 `require_approval_paths` 中的路径，写操作（edit/write）触发审批：

```
Agent 发起 edit 请求
  → Server 检查 path 在 require_approval_paths 中
  → Server 创建 pending_approval 记录
  → Server 通过 SSE 通知管理员（CEO/CTO）
  → 管理员 resolve_approval (approve/reject)
  → 原操作执行或拒绝
```

此流程复用现有的 `pending_approvals` / `resolve_approval` 机制。

### 3.4 Bash 命令黑名单

默认黑名单（全局生效，不可覆盖）:

```javascript
const GLOBAL_BLOCKED_PATTERNS = [
  /^rm\s+-rf\s+\/$/,           // rm -rf /
  /\bshutdown\b/,               // shutdown
  /\breboot\b/,                 // reboot
  /\bmkfs\b/,                   // mkfs
  /\bdd\s+if=/,                 // dd if=
  /\b:(){ :|:& };:/,           // fork bomb
  /\bchmod\s+-R\s+777\s+\//,   // chmod -R 777 /
  />\s*\/dev\/sd/,              // 写入磁盘设备
  /\bcurl\b.*\|\s*bash/,        // curl | bash
  /\bwget\b.*\|\s*bash/,        // wget | bash
  /\bgit\s+push\b/,            // git push（符合团队规则：仅董事长可批准）
];
```

Agent 级别可通过 `bash_blocked_commands` 追加额外黑名单。

### 3.5 角色默认权限

| 角色 | 默认 mode | bash_enabled | 说明 |
|------|-----------|-------------|------|
| CEO | readwrite | true | 全权管理 |
| CTO | readwrite | true | 技术架构 |
| PM | readonly | false | 仅查看进度 |
| Product | readonly | false | 仅查看产品代码 |
| A (后端) | readwrite | true | 开发需要 |
| B (前端) | readwrite | true | 开发需要 |
| C (测试) | readonly | true | 测试需 bash，不需写 |
| Audit | readonly | false | 审计只读 |
| SecTest | readonly | true | 安全测试 |
| StressTest | readonly | true | 压力测试 |

管理员可通过 API 覆盖默认配置。

---

## 4. 网络容错

### 4.1 幂等性

各操作的幂等性特征：

| 工具 | 幂等性 | 说明 |
|------|--------|------|
| `workspace_read` | 天然幂等 | 纯读取操作 |
| `workspace_grep` | 天然幂等 | 纯搜索操作 |
| `workspace_edit` | 内容匹配幂等 | 基于 `old_string` 精确匹配：若已替换，重复调用时 `old_string` 不存在，返回 `no_match` 错误而非重复替换 |
| `workspace_write` | 幂等（覆盖写） | 相同内容重复写入结果一致 |
| `workspace_bash` | 不保证幂等 | 命令本身可能有副作用，由调用方负责 |
| `workspace_bash_output` | 天然幂等 | 纯读取缓存 |

### 4.2 客户端重试策略

MCP 工具客户端应实现指数退避重试：

```
重试间隔 = min(base_delay * 2^attempt, max_delay)
base_delay = 1000ms
max_delay  = 30000ms
max_attempts = 3

可重试的错误：
- HTTP 5xx（服务端错误）
- HTTP 408（超时）
- 网络连接失败（ECONNRESET, ETIMEDOUT）

不可重试的错误：
- HTTP 4xx（客户端错误：参数错误、权限不足等）
```

### 4.3 超时处理

各操作超时配置：

| 工具 | 默认超时 | 最大超时 | 说明 |
|------|---------|---------|------|
| `workspace_read` | 10s | 30s | 文件读取通常很快 |
| `workspace_edit` | 10s | 30s | 包含读取+写入 |
| `workspace_write` | 10s | 60s | 大文件写入可能较慢 |
| `workspace_grep` | 30s | 60s | 搜索范围可能很大 |
| `workspace_bash` | 30s（可配） | 120s | Agent 在请求中指定 |
| `workspace_bash_output` | 5s | 10s | 纯内存读取 |

超时触发时，服务器：
1. 终止正在执行的操作（bash 命令发送 SIGTERM，5s 后 SIGKILL）
2. 返回 408 状态码
3. 记录审计日志（含超时原因）

### 4.4 大结果分页

`workspace_read` 和 `workspace_bash_output` 通过 `offset` + `limit` 支持分页：

```
第一页: offset=0, limit=200  → 返回行 0-199, truncated=true
第二页: offset=200, limit=200 → 返回行 200-399, truncated=true
...
最后页: offset=2200, limit=200 → 返回行 2200-2357, truncated=false
```

`workspace_grep` 通过 `max_results` 控制结果数量，响应中 `total_matches` 表示实际匹配总数（可能大于返回数）。

### 4.5 连接无关性

每次工具调用是独立的 HTTP 请求，不依赖 SSE 连接状态。即使 SSE 连接中断重连期间，Agent 仍可正常调用 Workspace 工具。这与现有 TeamMCP API（消息、任务等）的设计模式一致。

---

## 5. 安全考量

### 5.1 路径遍历防护

所有路径参数在使用前必须经过安全校验：

```javascript
function resolveSafePath(workspaceRoot, requestedPath) {
  // 1. 解析为绝对路径
  const resolved = path.resolve(workspaceRoot, requestedPath);

  // 2. 规范化（消除 .. / ./ 等）
  const normalized = path.normalize(resolved);

  // 3. 验证在 workspace 范围内
  if (!normalized.startsWith(workspaceRoot + path.sep) && normalized !== workspaceRoot) {
    throw new WorkspaceError('path_outside_workspace', 403);
  }

  // 4. 禁止符号链接逃逸 — 解析 realpath 后再次校验
  const real = fs.realpathSync.native(normalized);
  if (!real.startsWith(workspaceRoot + path.sep) && real !== workspaceRoot) {
    throw new WorkspaceError('symlink_escape', 403);
  }

  return normalized;
}
```

关键点：
- 使用 `path.resolve` + `path.normalize` 消除相对路径
- 使用 `fs.realpathSync.native` 检测符号链接逃逸
- 校验结果路径以 `workspaceRoot + sep` 开头（而非 `startsWith(workspaceRoot)`，防止 `/workspace-evil` 匹配 `/workspace`）

### 5.2 命令注入防护

`workspace_bash` 的命令不通过 shell 插值传递，而是使用 `child_process.exec` 的安全模式：

```javascript
// 命令经过以下处理：
// 1. 黑名单检查（全局 + Agent 级别）
// 2. 设置 cwd 为 workspace 目录
// 3. 设置受限环境变量（移除 PATH 中的敏感目录）
// 4. 以受限用户身份执行（如果 OS 支持）

const result = execSync(command, {
  cwd: workspaceRoot,
  timeout: timeout_ms,
  maxBuffer: 10 * 1024 * 1024,  // 10MB
  env: sanitizedEnv,
  shell: true  // 需要 shell 特性（管道、重定向等）
});
```

**注意**: 由于需要 shell 管道等特性，无法完全避免 `shell: true`。安全依赖黑名单 + 路径限制 + 审计日志的组合防御。

### 5.3 资源限制

| 资源 | 限制 | 说明 |
|------|------|------|
| 单文件写入大小 | 5MB（可配） | 防止磁盘填满 |
| Bash 输出缓冲 | 10MB | `maxBuffer` 限制 |
| Bash 输出缓存保留 | 30 分钟 | 过期自动清理 |
| Grep 搜索结果 | 500 条 | `max_results` 上限 |
| 读取行数 | 2000 行/次 | `limit` 上限 |
| API 调用频率 | 60 次/分钟/Agent | 防止滥用 |
| 并发 Bash 执行 | 3 个/Agent | 防止资源耗尽 |

### 5.4 审计日志

所有 workspace 操作写入 `workspace_audit_log` 表：

```sql
CREATE TABLE workspace_audit_log (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  operation TEXT NOT NULL,        -- read | edit | write | grep | bash | bash_output
  path TEXT,                      -- 操作路径（bash 为 NULL）
  command TEXT,                   -- bash 命令（非 bash 操作为 NULL）
  params TEXT,                    -- 完整请求参数 JSON（敏感信息脱敏）
  result_status TEXT NOT NULL,    -- success | error | timeout | blocked
  error_detail TEXT,              -- 错误详情
  duration_ms INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agent_name) REFERENCES agents(name)
);

CREATE INDEX idx_workspace_audit_agent ON workspace_audit_log(agent_name);
CREATE INDEX idx_workspace_audit_time ON workspace_audit_log(created_at);
CREATE INDEX idx_workspace_audit_op ON workspace_audit_log(operation);
```

审计日志用途：
- **Audit Agent** 可查询审计日志用于合规报告
- **异常检测**: 频繁的权限拒绝、大量写操作等
- **事后追溯**: 出问题时定位是哪个 Agent 的哪次操作导致

### 5.5 敏感文件保护

以下文件模式默认加入全局 `denied_paths`，任何 Agent 均不可通过 workspace 工具访问：

```javascript
const SENSITIVE_PATTERNS = [
  '.env',
  '.env.*',
  '*.key',
  '*.pem',
  '*.p12',
  '*.pfx',
  'credentials.json',
  'secrets.json',
  '**/id_rsa',
  '**/id_ed25519',
  '.git/config',       // 可能含 token
  '**/config.json',    // 需由管理员显式允许
  'node_modules/**',   // 避免读取海量依赖
];
```

管理员可通过 workspace 配置的 `allowed_sensitive` 字段显式解除部分限制。

---

## 6. 实现计划

### 6.1 新增文件

#### `server/workspace.mjs` — Workspace 管理器

核心模块，负责路径校验、权限检查、文件操作执行。

```
workspace.mjs
├── resolveSafePath(root, requestPath)     // 安全路径解析
├── checkPermission(agent, path, operation) // 权限检查
├── readFile(agent, params)                // workspace_read 实现
├── editFile(agent, params)                // workspace_edit 实现
├── writeFile(agent, params)               // workspace_write 实现
├── grepFiles(agent, params)               // workspace_grep 实现
├── execBash(agent, params)                // workspace_bash 实现
├── getBashOutput(agent, params)           // workspace_bash_output 实现
├── getWorkspaceConfig(agentName)          // 获取 Agent workspace 配置
├── setWorkspaceConfig(agentName, config)  // 设置 Agent workspace 配置（管理员）
└── logAudit(entry)                        // 写审计日志
```

预计代码量：约 500-700 行。

### 6.2 修改文件

#### `server/router.mjs` — 新增 Workspace 路由

在路由文件中新增 workspace API 段落（插入位置：在 `/api/files` 路由段之后）：

```javascript
// ── Workspace API (/api/workspace/*) ──────────────────
import {
  readFile, editFile, writeFile, grepFiles,
  execBash, getBashOutput, getWorkspaceConfig, setWorkspaceConfig
} from './workspace.mjs';

// POST /api/workspace/read
// POST /api/workspace/edit
// POST /api/workspace/write
// POST /api/workspace/grep
// POST /api/workspace/bash
// POST /api/workspace/bash_output
// GET  /api/workspace/config         — 获取当前 Agent 的 workspace 配置
// PUT  /api/workspace/config/:agent  — 管理员设置 Agent workspace 配置
```

预计新增路由代码：约 150-200 行。

#### `server/db.mjs` — 新增表和操作函数

新增内容：

1. **Schema**: `workspace_config` 和 `workspace_audit_log` 两张表（见第 3.1 和 5.4 节的 DDL）
2. **操作函数**:
   - `getWorkspaceConfig(agentName)` — 查询 Agent workspace 配置
   - `upsertWorkspaceConfig(agentName, root, permissions)` — 创建/更新配置
   - `insertWorkspaceAudit(entry)` — 插入审计日志
   - `getWorkspaceAuditLog(filters)` — 查询审计日志（支持按 Agent、操作类型、时间范围过滤）
   - `cleanupBashOutputCache()` — 清理过期的 bash 输出缓存

预计新增代码：约 80-120 行。

#### `mcp-client/teammcp-channel.mjs` — 新增 MCP 工具定义

为 Claude Code 客户端添加 6 个新工具定义（workspace_read/edit/write/grep/bash/bash_output），每个工具包含：

- 工具名称和描述
- 参数 Schema（JSON Schema）
- HTTP 调用逻辑（POST 到 `/api/workspace/{tool}`）
- 结果格式化（将 JSON 响应转为人类可读文本）

预计新增代码：约 200-300 行。

#### `config.json` — 新增 Workspace 配置

```json
{
  "state_admins": ["CEO", "CTO", "PM", "human"],
  "audit_roles": ["Audit"],
  "managers": ["CEO", "PM", "Product", "CTO"],
  "workspace_admins": ["CEO", "CTO"],
  "workspace_defaults": {
    "max_file_size_mb": 5,
    "bash_output_cache_ttl_minutes": 30,
    "rate_limit_per_minute": 60,
    "max_concurrent_bash": 3
  }
}
```

### 6.3 数据库迁移

由于 TeamMCP 使用 `CREATE TABLE IF NOT EXISTS` 模式（直接在 `db.mjs` 中定义 schema），新表只需将 DDL 追加到现有 `db.exec()` 块中即可。无需单独的 migration 脚本。

### 6.4 实施阶段

| 阶段 | 内容 | 预计工作量 |
|------|------|-----------|
| Phase 1 | `workspace.mjs` 核心模块 + DB schema | 1-2 天 |
| Phase 2 | `router.mjs` 路由接入 + 权限校验 | 0.5-1 天 |
| Phase 3 | `teammcp-channel.mjs` MCP 工具定义 | 0.5-1 天 |
| Phase 4 | 安全测试（路径遍历、命令注入、权限绕过） | 1 天 |
| Phase 5 | Dev 环境集成测试，Prod 部署 | 0.5 天 |

总计：约 3.5-5.5 天。

---

## 7. 使用示例

以下演示远程 Agent（身份：A，后端工程师）修改代码的完整流程。

### Step 1: 搜索相关文件 (workspace_grep)

**请求**:

```json
POST /api/workspace/grep
Authorization: Bearer tmcp_a_xxxxx

{
  "pattern": "function json\\(",
  "glob": "*.mjs",
  "max_results": 10
}
```

**响应**:

```json
{
  "ok": true,
  "data": {
    "matches": [
      {
        "file": "server/router.mjs",
        "line_number": 189,
        "content": "function json(res, data, status = 200) {"
      }
    ],
    "total_matches": 1,
    "truncated": false
  }
}
```

### Step 2: 读取目标文件 (workspace_read)

**请求**:

```json
POST /api/workspace/read
Authorization: Bearer tmcp_a_xxxxx

{
  "path": "server/router.mjs",
  "offset": 185,
  "limit": 20
}
```

**响应**:

```json
{
  "ok": true,
  "data": {
    "path": "server/router.mjs",
    "lines": [
      { "n": 186, "content": "" },
      { "n": 187, "content": "// ── Helpers ────────────────────────────────────────" },
      { "n": 188, "content": "" },
      { "n": 189, "content": "function json(res, data, status = 200) {" },
      { "n": 190, "content": "  res.writeHead(status, { 'Content-Type': 'application/json' });" },
      { "n": 191, "content": "  res.end(JSON.stringify(data));" },
      { "n": 192, "content": "}" },
      { "n": 193, "content": "" },
      { "n": 194, "content": "function readBody(req) {" }
    ],
    "total_lines": 2357,
    "returned": 20,
    "truncated": true
  }
}
```

### Step 3: 编辑文件 (workspace_edit)

为 `json` 函数添加 CORS header 支持：

**请求**:

```json
POST /api/workspace/edit
Authorization: Bearer tmcp_a_xxxxx

{
  "path": "server/router.mjs",
  "old_string": "function json(res, data, status = 200) {\n  res.writeHead(status, { 'Content-Type': 'application/json' });\n  res.end(JSON.stringify(data));\n}",
  "new_string": "function json(res, data, status = 200) {\n  res.writeHead(status, {\n    'Content-Type': 'application/json',\n    'Access-Control-Allow-Origin': req.headers.origin || '*'\n  });\n  res.end(JSON.stringify(data));\n}"
}
```

**响应**:

```json
{
  "ok": true,
  "data": {
    "success": true,
    "matched_line": 189,
    "matches_replaced": 1,
    "preview": [
      { "n": 187, "content": "// ── Helpers ────────────────────────────────────────" },
      { "n": 188, "content": "" },
      { "n": 189, "content": "function json(res, data, status = 200) {" },
      { "n": 190, "content": "  res.writeHead(status, {" },
      { "n": 191, "content": "    'Content-Type': 'application/json'," },
      { "n": 192, "content": "    'Access-Control-Allow-Origin': req.headers.origin || '*'" },
      { "n": 193, "content": "  });" },
      { "n": 194, "content": "  res.end(JSON.stringify(data));" },
      { "n": 195, "content": "}" }
    ]
  }
}
```

### Step 4: 运行测试 (workspace_bash)

**请求**:

```json
POST /api/workspace/bash
Authorization: Bearer tmcp_a_xxxxx

{
  "command": "npm test",
  "timeout_ms": 60000
}
```

**响应**:

```json
{
  "ok": true,
  "data": {
    "exit_code": 1,
    "stdout_summary": {
      "head": [
        "> teammcp@1.0.0 test",
        "> node --experimental-vm-modules node_modules/.bin/jest",
        "",
        "PASS src/auth.test.js",
        "PASS src/db.test.js"
      ],
      "tail": [
        "FAIL src/router.test.js",
        "  ● json helper › should set CORS header",
        "",
        "Test Suites: 1 failed, 11 passed, 12 total",
        "Tests: 1 failed, 46 passed, 47 total"
      ],
      "total_lines": 95
    },
    "stderr_summary": {
      "head": [],
      "tail": [],
      "total_lines": 0
    },
    "output_id": "ws_out_f7e8d9c0",
    "duration_ms": 8320
  }
}
```

### Step 5: 查看完整测试输出 (workspace_bash_output)

测试失败，需要查看详细错误信息：

**请求**:

```json
POST /api/workspace/bash_output
Authorization: Bearer tmcp_a_xxxxx

{
  "output_id": "ws_out_f7e8d9c0",
  "offset": 60,
  "limit": 30,
  "stream": "stdout"
}
```

**响应**:

```json
{
  "ok": true,
  "data": {
    "output_id": "ws_out_f7e8d9c0",
    "stream": "stdout",
    "lines": [
      { "n": 60, "content": "  FAIL src/router.test.js" },
      { "n": 61, "content": "    json helper" },
      { "n": 62, "content": "      ✓ should set Content-Type (2ms)" },
      { "n": 63, "content": "      ✕ should set CORS header (5ms)" },
      { "n": 64, "content": "" },
      { "n": 65, "content": "    ● json helper › should set CORS header" },
      { "n": 66, "content": "" },
      { "n": 67, "content": "      ReferenceError: req is not defined" },
      { "n": 68, "content": "        at json (server/router.mjs:192:49)" }
    ],
    "total_lines": 95,
    "returned": 30,
    "truncated": false
  }
}
```

此时 Agent 发现问题：`json` 函数没有 `req` 参数。Agent 可以继续用 `workspace_edit` 修复这个问题，然后再次运行测试。

---

## 附录

### A. 与现有 File API 的区别

| 特性 | File API (`/api/files`) | Workspace API (`/api/workspace`) |
|------|------------------------|--------------------------------|
| 用途 | 团队间共享附件 | 操作服务器本地文件系统 |
| 存储 | TeamMCP 内部存储 + DB 记录 | 直接操作真实文件系统 |
| 路径 | 通过 file_id 引用 | 真实文件路径 |
| 编辑 | 不支持 | 支持精确字符串替换 |
| 搜索 | 不支持 | 支持正则搜索 |
| 命令执行 | 不支持 | 支持 bash |

### B. 后续扩展方向

- **workspace_diff** — 查看文件的 git diff
- **workspace_glob** — 按文件名模式搜索
- **workspace_watch** — 通过 SSE 推送文件变更事件
- **多 workspace** — 一个 Agent 可访问多个 workspace（如同时访问前端和后端仓库）
- **协同锁** — 防止多个 Agent 同时编辑同一文件
