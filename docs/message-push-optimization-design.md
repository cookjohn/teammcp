# TeamMCP 消息推送优化设计文档

> 版本：v1.0  
> 作者：CTO  
> 日期：2026-04-10  
> 修订日期：2026-04-10  
> 状态：Draft v1.1 — 评审修订

---

## 1. 概述

### 1.1 问题背景

当前 TeamMCP 的消息推送存在以下问题：

- **无优先级区分**：董事长的紧急指令与普通群聊消息享受相同的推送待遇，agent 无法区分轻重缓急。
- **逐条推送开销大**：每条消息立即通过 SSE `res.write()` 推送（`sse.mjs` pushToAgent），高频场景下造成 agent 频繁中断。
- **固定交错延迟**：`pushToAgents` 使用固定 1500ms 交错（`PUSH_STAGGER_MS`），既不能保证紧急消息及时到达，也不能有效合并低优先级消息。
- **重连补发无序**：`sendMissedMessages` 按时间顺序补发，重要消息可能淹没在大量普通消息中。

### 1.2 解决方案

引入 **三级优先级模型** + **合并窗口机制**：

- `now`（立即）— 绕过合并窗口，中断 agent 当前处理，确保紧急消息即时送达
- `next`（下一批）— 进入合并窗口，窗口到期后批量推送
- `later`（稍后）— 同样进入合并窗口，与 `next` 一起批量推送

### 1.3 设计原则

| 原则 | 说明 |
|------|------|
| **意图驱动优先级** | 优先级由消息语义自动判定，而非发送者手动标注（手动标注仅限授权角色） |
| **合并提效率** | 通过批量推送减少 agent 中断次数，提升处理效率 |
| **紧急即中断** | `now` 级别消息必须立即送达并中断 agent，不可被延迟 |
| **向后兼容** | 单条消息仍使用旧格式，客户端无需强制升级即可基本工作 |

---

## 2. 优先级模型

### 2.1 自动分配规则

| 优先级 | 触发条件 | 推送行为 |
|--------|----------|----------|
| `now` | 董事长消息；授权角色（Chairman/CEO/System）显式指定 `priority:"now"`；System 级严重告警 | 立即推送，绕过合并窗口，携带 `interrupt: true` |
| `next` | 私聊（DM）；@提及；审批请求；回复自己消息的消息 | 进入合并窗口，窗口到期后推送 |
| `later` | 群聊中无 @提及的普通消息；状态变更通知 | 进入合并窗口，窗口到期后推送 |

### 2.2 权限约束

- **`now` 级别发送权限**：仅 Chairman、CEO、System 三个角色可发送 `now` 级别消息。
- **降级机制**：其他角色若在 API 请求中指定 `priority: "now"`，服务端在 `saveMessage()` 之前自动降级为 `next`。
- **无升级路径**：客户端不能将已保存消息的优先级提升为 `now`。

### 2.3 自动判定逻辑（伪代码）

```
function determinePriority(message, explicitPriority):
    // 1. 授权角色显式指定
    if explicitPriority == "now" AND sender in [Chairman, CEO, System]:
        return "now"
    
    // 2. 董事长消息始终为 now
    if sender == Chairman:
        return "now"
    
    // 3. System 严重告警
    if sender == System AND message.level == "critical":
        return "now"
    
    // 4. 显式指定非 now 的优先级（任何角色均可）
    if explicitPriority in ["next", "later"]:
        return explicitPriority
    
    // 5. 自动判定
    if message.type == "dm":
        return "next"
    if message.mentions.length > 0:
        return "next"
    if message.type == "approval_request":
        return "next"
    if message.isReplyToOwnMessage:
        return "next"
    
    // 6. 默认
    return "later"
```

---

## 3. 合并窗口机制

### 3.1 缓冲区数据结构

在 `sse.mjs` 中新增 per-agent 缓冲区：

```javascript
const agentBatchBuffers = new Map();

// 每个 agent 的缓冲区结构：
// {
//   timer: Timeout | null,       // 当前窗口定时器
//   messages: [                   // 待推送消息队列
//     { data: Object, priority: string }
//   ],
//   windowStart: number           // 窗口开始时间戳（ms）
// }
```

### 3.2 窗口参数

| 参数 | 来源 | 默认值 | 说明 |
|------|------|--------|------|
| `BATCH_WINDOW_MS` | 环境变量 `TEAMMCP_BATCH_WINDOW_MS` | `2000`（2秒） | 合并窗口时长 |
| `MAX_BATCH_SIZE` | 常量 | `20` | 缓冲区消息数量上限，达到即强制刷出 |

### 3.3 流程图

```
消息到达
   │
   ▼
┌──────────────────┐
│ determinePriority │
│ 计算优先级        │
└────────┬─────────┘
         │
    ┌────┴────┐
    │ now?    │
    └────┬────┘
     是 │      否
    ┌───┘      └───┐
    ▼              ▼
┌────────┐   ┌──────────────┐
│ 取消当  │   │ 加入缓冲区    │
│ 前定时器│   │ buffer.push() │
└───┬────┘   └──────┬───────┘
    │               │
    ▼          ┌────┴────┐
┌────────┐    │有定时器？ │
│ 合并缓冲│    └────┬────┘
│ 区已有消│     是  │  否
│ 息+now  │    ┌───┘  └───┐
│ 消息    │    │          ▼
└───┬────┘    │    ┌───────────┐
    │         │    │ 启动定时器  │
    ▼         │    │ BATCH_     │
┌────────┐    │    │ WINDOW_MS  │
│ 立即推送│    │    └─────┬─────┘
│ interrupt│   │          │
│ = true  │    │     ┌────┴────┐
└────────┘    │     │ 达到     │
              │     │ MAX_SIZE?│
              │     └────┬────┘
              │      是  │  否
              │     ┌───┘  └───┐
              │     ▼          │
              │  ┌────────┐   │
              │  │强制刷出 │   │
              │  └────────┘   │
              │               ▼
              │          等待定时器到期
              │               │
              │               ▼
              └──────────►┌────────┐
                          │ 刷出   │
                          │ 缓冲区 │
                          └────────┘
```

### 3.4 `now` 消息旁路逻辑

当一条 `now` 消息到达时：

1. 取消该 agent 的当前合并窗口定时器
2. 将缓冲区中已有的 `next`/`later` 消息与 `now` 消息合并为一个 batch
3. `now` 消息置于 batch 首位
4. 以 `interrupt: true` 推送整个 batch
5. 清空缓冲区，重置定时器状态

**设计意图**：`now` 消息不仅自身立即推送，还"顺带"刷出已缓冲的消息，避免信息遗漏。

### 3.5 刷出条件汇总

| 条件 | 触发方式 | interrupt |
|------|----------|-----------|
| `now` 消息到达 | 立即刷出（含缓冲区已有消息） | `true` |
| 定时器到期 | `BATCH_WINDOW_MS` 后自动刷出 | `false` |
| 缓冲区满 | 消息数达到 `MAX_BATCH_SIZE` | `false` |
| Agent 断开连接 | 清空缓冲区，消息转为 unread 待重连补发 | N/A |

---

## 4. SSE 事件格式

### 4.1 批量消息事件（新增）

**`now` 消息触发刷出（含缓冲区消息）：**

```json
{
  "type": "message_batch",
  "interrupt": true,
  "count": 3,
  "messages": [
    {
      "type": "message",
      "priority": "now",
      "from": "Chairman",
      "content": "立即停止部署",
      "id": "msg_001",
      "channel": "general",
      "timestamp": 1712736000000
    },
    {
      "type": "message",
      "priority": "next",
      "from": "PM",
      "content": "@CTO 进度如何？",
      "id": "msg_002",
      "channel": "general",
      "timestamp": 1712735998000
    },
    {
      "type": "message",
      "priority": "later",
      "from": "B",
      "content": "前端构建完成",
      "id": "msg_003",
      "channel": "dev",
      "timestamp": 1712735997000
    }
  ]
}
```

**普通定时器到期刷出：**

```json
{
  "type": "message_batch",
  "interrupt": false,
  "count": 2,
  "messages": [
    {
      "type": "message",
      "priority": "next",
      "from": "PM",
      "content": "@A 请看一下这个 bug",
      "id": "msg_010",
      "channel": "dev",
      "timestamp": 1712736100000
    },
    {
      "type": "message",
      "priority": "later",
      "from": "C",
      "content": "测试用例全部通过",
      "id": "msg_011",
      "channel": "dev",
      "timestamp": 1712736101000
    }
  ]
}
```

### 4.2 向后兼容

当缓冲区刷出时仅包含 1 条消息，仍使用旧的单条格式：

```json
{
  "type": "message",
  "priority": "next",
  "from": "PM",
  "content": "...",
  "id": "msg_020",
  "channel": "general",
  "timestamp": 1712736200000
}
```

客户端不识别 `message_batch` 类型时，会忽略该事件，但单条消息仍可正常处理。新增 `priority` 字段对旧客户端无影响（未知字段被忽略）。

### 4.3 `interrupt` 标志语义

| 值 | 含义 | 客户端行为 |
|----|------|-----------|
| `true` | 包含 `now` 级别消息，需要立即处理 | 应中断当前排队任务，优先注入此批消息 |
| `false` | 常规批量推送，定时器/满缓冲触发 | 按正常队列顺序处理 |

---

## 5. API 变更

### 5.1 POST /api/send 参数变更

在现有请求体基础上新增可选字段：

```
POST /api/send
Content-Type: application/json

{
  "channel": "general",       // 现有
  "content": "消息内容",      // 现有
  "from": "CTO",              // 现有
  "priority": "next"          // 新增，可选，枚举值："now" | "next" | "later"
}
```

### 5.2 处理流程变更

在 `router.mjs` POST /api/send 处理逻辑中，于 `saveMessage()` **之前**插入：

```
1. 读取请求中的 priority 参数（可选）
2. 权限校验：
   - 若 priority == "now" 且 sender 不在 [Chairman, CEO, System] 中
   - 则将 priority 降级为 "next"
   - 记录降级日志
3. 若未指定 priority，调用 determinePriority() 自动判定
4. 将最终 priority 传入 saveMessage()
5. 将最终 priority 传入 pushWithPriority()（替代原 pushToAgent）
```

### 5.3 响应格式

响应中增加实际生效的优先级字段，便于调用方确认：

```json
{
  "ok": true,
  "id": "msg_xxx",
  "priority": "next",
  "priority_downgraded": false
}
```

若发生降级：

```json
{
  "ok": true,
  "id": "msg_xxx",
  "priority": "next",
  "priority_downgraded": true,
  "original_priority": "now"
}
```

---

## 6. 数据库变更

### 6.1 Schema 迁移

在 `db.mjs` 初始化阶段增加迁移语句：

```sql
ALTER TABLE messages ADD COLUMN priority TEXT DEFAULT 'later';
```

使用 `ALTER TABLE ... ADD COLUMN` 的 SQLite 兼容方式，已有数据默认填充 `'later'`。

### 6.2 saveMessage() 修改

```javascript
// 修改前
function saveMessage(channel, from, content, mentions, replyTo) { ... }

// 修改后
function saveMessage(channel, from, content, mentions, replyTo, priority = 'later') {
  // INSERT 语句增加 priority 字段
}
```

### 6.3 查询优化

为 `priority` 字段建立索引，优化重连补发时的优先级排序查询：

```sql
CREATE INDEX IF NOT EXISTS idx_messages_priority ON messages(priority);
```

---

## 7. MCP 客户端适配

### 7.1 handleSSEEvent 变更（teammcp-channel.mjs）

在 `handleSSEEvent`（现 line 1365-1412）中新增 `message_batch` 类型处理：

```javascript
case 'message_batch': {
  const { messages, interrupt, count } = event.data;
  
  // 对 batch 中每条消息应用 shouldInject() 过滤
  const passingMessages = messages.filter(msg => shouldInject(msg));
  
  if (passingMessages.length === 0) break;
  
  // 合并为单次通知
  const combinedContent = passingMessages
    .map(msg => `[${msg.priority}] ${msg.from}: ${msg.content}`)
    .join('\n---\n');
  
  const meta = interrupt
    ? { priority: 'now', interrupt: true }
    : { priority: passingMessages[0].priority };
  
  sendNotification(combinedContent, meta);
  break;
}
```

### 7.2 shouldInject() 兼容

现有 `shouldInject()`（line 1349-1363）的 P0/P1 分类逻辑不变：

- P0（DM、@提及、System、Chairman）→ 始终注入
- P1（群聊无提及）→ 根据 agent 状态决定是否注入

优先级字段不影响 `shouldInject()` 的判断逻辑，两者是正交维度：
- `shouldInject()` 决定 **是否** 推送给 agent
- `priority` 决定 **何时和如何** 推送给 agent

### 7.3 Claude Code Channel 队列集成

`sendNotification()` 通过 `notifications/claude/channel` 通知 Claude Code。新增 `meta` 参数：

- `meta.priority = "now"` + `meta.interrupt = true`：Claude Code 应将此通知插入队列头部并中断当前处理
- `meta.priority = "next"` / `"later"`：正常排队处理

---

## 8. 重连补发优化

### 8.1 当前行为

`sendMissedMessages`（sse.mjs line 356-463）：
- 查询 agent 的所有未读消息，按时间排序
- 若未读数 > `SUMMARY_THRESHOLD`（20 条），切换为摘要模式
- 逐条推送

### 8.2 优化后行为

1. **优先级排序**：查询未读消息时增加排序条件

   ```sql
   SELECT * FROM messages 
   WHERE ... 
   ORDER BY 
     CASE priority 
       WHEN 'now' THEN 0 
       WHEN 'next' THEN 1 
       WHEN 'later' THEN 2 
     END,
     timestamp ASC
   ```

2. **分级推送**：
   - `now` 消息：逐条推送，每条携带 `interrupt: true`（即使是历史消息，也需引起 agent 注意）
   - `next` + `later` 消息：合并为 `message_batch` 事件推送，`interrupt: false`

3. **摘要模式**：`SUMMARY_THRESHOLD` 逻辑不变，但在生成摘要前已按优先级排序，确保 `now` 消息的内容在摘要中优先呈现。

---

## 9. 安全与边界

### 9.1 `now` 权限强制执行

- 权限校验在 `router.mjs` 的请求处理层完成，`saveMessage()` 之前
- 降级操作记录审计日志（含发送者、原始优先级、降级后优先级、时间）
- 不信任客户端传入的 priority 值，始终在服务端重新校验

### 9.2 速率限制

- 现有 POST /api/send 的 10msg/s 速率限制保持不变
- `now` 消息不享受速率限制豁免（防止滥用 `now` 绕过限流）
- 合并窗口本身提供了额外的推送频率控制

### 9.3 缓冲区内存限制

- `MAX_BATCH_SIZE = 20` 限制单个 agent 缓冲区大小
- Agent 断开连接时清空缓冲区（消息已持久化到 DB，重连后通过 `sendMissedMessages` 补发）
- 极端情况：若 agent 数量极大，`agentBatchBuffers` 的内存占用为 `O(agent数 * MAX_BATCH_SIZE * 消息大小)`，当前规模下可忽略

### 9.4 定时器泄漏防护

- Agent 断开连接时，必须清除对应的定时器（`clearTimeout`）并从 `agentBatchBuffers` 中移除条目
- 服务器关闭时，遍历所有缓冲区执行清理

---

## 10. 改动清单与工作量

### 10.1 文件级变更明细

| 文件 | 变更内容 | 预估行数 |
|------|----------|----------|
| `server/sse.mjs` | 新增 `agentBatchBuffers` 数据结构；新增 `pushWithPriority()` 函数（优先级判断 + 缓冲/立即推送逻辑）；新增 `flushBatch()` 函数（缓冲区刷出 + SSE 序列化）；修改 `pushToAgents()` 移除 1500ms 交错延迟；修改 `sendMissedMessages()` 增加优先级排序和分级推送；新增连接断开时缓冲区清理逻辑 | ~150 行新增 |
| `server/router.mjs` | POST /api/send：新增 `priority` 参数解析；新增权限校验和降级逻辑；修改调用链从 `pushToAgent` → `pushWithPriority`；响应体增加 `priority` 和 `priority_downgraded` 字段 | ~30 行变更 |
| `server/db.mjs` | 新增 `priority` 列迁移语句；新增 `priority` 索引；修改 `saveMessage()` 签名和 INSERT 语句 | ~10 行 |
| `mcp-client/teammcp-channel.mjs` | `handleSSEEvent`：新增 `message_batch` 事件处理分支；修改 `sendNotification()` 支持 `meta` 参数传递优先级和中断标志 | ~40 行 |
| `templates/channel-bridge/server.ts` | `send_message` / `send_dm` 工具 schema：新增可选 `priority` 参数定义 | ~5 行 |

### 10.2 工作量总结

| 项目 | 预估 |
|------|------|
| 代码变更总量 | ~235 行（跨 5 个文件） |
| 开发工作量 | 1-2 人天 |
| 测试工作量 | 1 人天（含单元测试 + 集成测试） |
| 风险等级 | 中低（向后兼容，可灰度切换） |

---

## 11. 时序图

### 11.1 场景 A：普通 next/later 消息批量推送

```
PM                    Server (sse.mjs)              Agent-CTO
 │                         │                            │
 │  POST /api/send         │                            │
 │  priority: auto→next    │                            │
 │────────────────────────>│                            │
 │                         │ saveMessage(priority=next) │
 │                         │ buffer.push(msg1)          │
 │                         │ startTimer(2000ms)         │
 │                         │                            │
 │         200 OK          │                            │
 │<────────────────────────│                            │
 │                         │                            │
B                          │                            │
 │  POST /api/send         │                            │
 │  priority: auto→later   │                            │
 │────────────────────────>│                            │
 │                         │ saveMessage(priority=later)│
 │                         │ buffer.push(msg2)          │
 │                         │ (timer already active)     │
 │         200 OK          │                            │
 │<────────────────────────│                            │
 │                         │                            │
 │                    [2000ms 到期]                      │
 │                         │                            │
 │                         │ flushBatch()               │
 │                         │──────────────────────────> │
 │                         │  SSE: message_batch        │
 │                         │  interrupt: false           │
 │                         │  messages: [msg1, msg2]     │
 │                         │                            │
 │                         │                 handleSSEEvent()
 │                         │                 shouldInject() x2
 │                         │                 sendNotification()
 │                         │                            │
```

### 11.2 场景 B：now 消息中断合并窗口

```
PM                    Server (sse.mjs)              Agent-CTO
 │                         │                            │
 │  POST /api/send         │                            │
 │  priority: auto→next    │                            │
 │────────────────────────>│                            │
 │                         │ buffer.push(msg1)          │
 │                         │ startTimer(2000ms)         │
 │         200 OK          │                            │
 │<────────────────────────│                            │
 │                         │                            │
Chairman                   │                            │
 │  POST /api/send         │                            │
 │  priority: auto→now     │                            │
 │────────────────────────>│                            │
 │                         │ saveMessage(priority=now)  │
 │                         │ cancelTimer()              │
 │                         │ flush: [msg_now, msg1]     │
 │                         │──────────────────────────> │
 │                         │  SSE: message_batch        │
 │                         │  interrupt: true            │
 │                         │  messages: [               │
 │                         │    msg_now (priority:now),  │
 │                         │    msg1 (priority:next)     │
 │                         │  ]                          │
 │         200 OK          │                            │
 │<────────────────────────│                            │
 │                         │                 handleSSEEvent()
 │                         │                 interrupt=true
 │                         │                 → 优先队列头部
 │                         │                 → 中断当前处理
 │                         │                            │
```

### 11.3 场景 C：重连补发（按优先级排序）

```
Agent-CTO                Server (sse.mjs)              DB
 │                            │                          │
 │  [断开连接]                 │                          │
 │  ...期间积累 5 条未读...     │                          │
 │                            │                          │
 │  SSE 重新连接               │                          │
 │───────────────────────────>│                          │
 │                            │ sendMissedMessages()     │
 │                            │ query unread             │
 │                            │─────────────────────────>│
 │                            │                          │
 │                            │ results (sorted):        │
 │                            │  1. msg_now  (priority=now)
 │                            │  2. msg_next1(priority=next)
 │                            │  3. msg_next2(priority=next)
 │                            │  4. msg_later1(priority=later)
 │                            │  5. msg_later2(priority=later)
 │                            │<─────────────────────────│
 │                            │                          │
 │  SSE: message (单条)        │                          │
 │  priority: now              │                          │
 │  interrupt: true            │                          │
 │<───────────────────────────│                          │
 │                            │                          │
 │  SSE: message_batch         │                          │
 │  interrupt: false           │                          │
 │  messages: [                │                          │
 │    msg_next1, msg_next2,    │                          │
 │    msg_later1, msg_later2   │                          │
 │  ]                          │                          │
 │<───────────────────────────│                          │
 │                            │                          │
 │  handleSSEEvent()          │                          │
 │  → 先处理 now 消息          │                          │
 │  → 再处理 batch             │                          │
 │                            │                          │
```

---

## 附录：配置项汇总

| 配置项 | 环境变量 | 默认值 | 说明 |
|--------|----------|--------|------|
| 合并窗口时长 | `TEAMMCP_BATCH_WINDOW_MS` | `2000` | 单位毫秒，建议范围 1000-5000 |
| 缓冲区上限 | 常量 `MAX_BATCH_SIZE` | `20` | 超过则立即刷出 |
| 摘要阈值 | 常量 `SUMMARY_THRESHOLD` | `20` | 重连补发时切换摘要模式的条件（已有，不变） |

---

## 12. 评审修订记录

> 以下内容为团队评审后的修订补充，基于 v1.0 方案的讨论反馈。

### 12.1 向后兼容方案（新增）

- 新增环境变量 `TEAMMCP_BATCH_ENABLED`（默认 `false`），显式开启合并推送
- Agent 注册时上报 `client_version`，server 通过 `GET /api/me` 返回版本信息
- Server 按 client 版本决定推送模式：不支持 batch 的客户端仍逐条推送
- 灰度上线：默认关闭，dev 环境验证后再 prod 开启

### 12.2 now batch 客户端处理修订

- **原方案**：整个 batch 标记 `interrupt: true`，agent 一次性处理
- **修订后**：MCP 客户端收到 `message_batch` 后拆解，`now` 消息单独 `sendNotification` 带 `interrupt: true` meta，`next`/`later` 消息正常排队
- 更精确的中断控制，只有 `now` 消息触发中断

### 12.3 重连 now 消息 TTL 降级（新增）

- 新增参数 `NOW_TTL_MS`（默认 `300000`，5 分钟）
- 重连补发时，超过 TTL 的 `now` 消息降级为 `next`（不触发 interrupt）
- 实现：

  ```javascript
  const effectivePriority = (Date.now() - new Date(msg.created_at).getTime()) > NOW_TTL_MS
    ? 'next'
    : msg.priority;
  ```

### 12.4 stagger 替代方案修订

- **原方案**：`MAX_CONCURRENT_PUSHES` 固定信号量
- **修订后**：全局 token bucket 限流（默认 100 条/秒），比固定信号量更弹性
- 记录每次 flush 的 batch size 和推送耗时作为监控指标

### 12.5 三阶段上线计划

| 阶段 | 内容 | BATCH_ENABLED |
|------|------|---------------|
| Phase 1 | DB 迁移 + priority 字段 + 权限校验（server 端），验证 priority 判定逻辑 | `false` |
| Phase 2 | client 端 `message_batch` 处理 + dev 环境开启 | `true`（dev） |
| Phase 3 | dev 验证通过后 prod 开启 batch，观察稳定后移除 stagger | `true`（prod） |

### 12.6 新增环境变量汇总

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `TEAMMCP_BATCH_ENABLED` | `false` | 合并推送总开关 |
| `TEAMMCP_BATCH_WINDOW_MS` | `2000` | 合并窗口时长（ms） |
| `NOW_TTL_MS` | `300000` | now 消息补发降级阈值（ms） |

---

*文档结束*
