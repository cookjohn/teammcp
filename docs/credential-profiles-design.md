# TeamMCP 凭证档案（Credential Profiles）设计文档

> 版本：v1.1
> 日期：2026-05-28
> 状态：Draft — 已纳入独立审核修订
> 范围：provider API key 的集中管理、复用、轮换与有效性校验。**不改动**现有共享 OAuth（Claude）链路。

> **v1.1 修订摘要**（基于代码核验后的独立审核）：
> - 修正 mac impl 也注入 api_key（`process-manager-impl-mac.mjs:278-284`），三个 impl 都需改，否则 profile-only agent 在 mac 静默 401。
> - **复用**已存在的测试端点 `POST /api/config/llm/test`（按 provider 分支 + SSRF allowlist），不再自造探针。
> - 补上第二个读内联列的地方：ccrouter 配置生成（`getAgentsNeedingRouter` db.mjs:363 / `generateCCRouterConfig` win:1136），也要 profile-aware。
> - 修正认证模型：`/api/dashboard/credentials/*` 走 `requireDashboardToken`（共享密钥），非 per-agent 角色。
> - MVP 即采用仓库已有的 AES-GCM 加密模式（`llm_config` db.mjs:2705），不再"明文 MVP / 加密完整版"。
> - 明确：轮换 token 对**正在运行**的 agent 需重启才生效（env 在 spawn 时固定）。

---

## 1. 概述

### 1.1 问题背景

当前每个 agent 的 provider API key 以**内联方式**存储在 `agents` 表（`api_provider / api_base_url / api_auth_token / api_model`）。这导致：

- **重复存储**：多个 agent 用同一 provider（如小米 MiMo）时，每行各存一份相同 token。
- **轮换困难**：token 过期需逐个 agent 手动修改，无批量轮换。
- **无有效性校验**：token 失效后 agent 进程仍正常 spawn、SSE 仍连接，dashboard 显示 `online`，但每次 LLM 调用 401 —— 即"假在线、真死"。直接触发场景：HR 配 `xiaomi/mimo-v2-pro`，token `tp-cws3n...` 过期，实测端点返回 `401 Invalid API Key`。
- **管理分散**：共享 OAuth 在 `CredentialsView` 管，每 agent key 却在 `AgentsView` 详情面板改，无统一入口。

### 1.2 解决方案

引入 **凭证档案（credential profile）**：将 `provider + base_url + auth_token + model` 定义为一个**命名档案**，agent 通过 `credential_profile_id` 引用，而非内联。

- 轮换 token：改档案一处 → 所有引用它的 agent **下次启动**生效（运行中的 agent 需重启，见 §1.4）。
- 有效性校验：复用现有 `/api/config/llm/test` + 后台周期探活，失效标红。
- 统一管理：`CredentialsView` 新增「API Key 档案」区，集中增删改测。

### 1.3 设计原则

| 原则 | 说明 |
|------|------|
| **定义一次、多处引用** | 档案是唯一真相源；agent 仅持引用，不再持 token 副本 |
| **向后兼容** | 保留 `agents` 现有内联列；解析时"档案优先、内联兜底"，存量 agent 无需立即迁移即可继续工作 |
| **不碰 OAuth** | `credential-manager.mjs` / `credential-lease.mjs` 的共享 OAuth 链路完全不动，本设计只覆盖 `auth_mode=api_key` |
| **复用既有** | 测试连接复用 `/api/config/llm/test`；加密复用 `llm_config` 的 AES-GCM 模式 |
| **失效可见** | token 有效性必须能在 UI 显式呈现，杜绝"假在线" |
| **可回滚** | 迁移保留原始内联数据，提供反向迁移路径 |

### 1.4 已知约束：env 在 spawn 时固定

agent 的 `ANTHROPIC_*` 环境变量在进程 spawn 时一次性注入（`process-manager-impl-win.mjs:546-548` 等），运行期不可变。因此**轮换档案 token 只对之后启动的 agent 生效**；正在运行的 agent 必须重启。UI 应在轮换后提示"N 个运行中的 agent 需重启以应用新 token"。

---

## 2. 现状分析（调研 + 审核核验结论）

| 维度 | 现状 | 文件位置 |
|------|------|---------|
| agents 认证列 | `auth_mode`(默认 oauth)、`api_provider`、`api_base_url`、`api_auth_token`、`api_model`、`auth_strategy`(默认 legacy) | `db.mjs` ALTER 段 ~L102-108 |
| 共享 OAuth | `credential-manager.mjs` 集中刷新 + 分发各 agent `.credentials.json` | `credential-manager.mjs` |
| Path A 租约 | `credential-lease.mjs` 仅服务 `auth_strategy=path_a` 的 OAuth 租约 | `credential-lease.mjs` |
| **spawn 注入（三处！）** | `auth_mode=api_key` 时从 agent 行读 `api_base_url/auth_token/model` 写 `ANTHROPIC_*`。**win / linux / mac 三个 impl 各有一份，结构不同** | win `:543-549`(用 `effectiveAgentInfo`)、linux `:266-272`(用 `agentInfo`)、mac `:278-284`(shell export) |
| **ccrouter 配置（第二个读内联列处）** | openrouter/openai agent 运行时经 ccrouter 代理；其配置由 `getAgentsNeedingRouter()` 直接读 agent 行的 `api_auth_token` | `db.mjs:363`、`generateCCRouterConfig` win `:1136`、`ROUTER_PROVIDERS` win `:518` |
| 读写端点 | `PATCH /api/agents/:name` → `setAgentAuthConfig()`，权限限 `req.agent.name ∈ {Chairman,CEO,HR}`（router `:1714`） | `router.mjs:1732-1741` |
| **测试连接端点（已存在）** | `POST /api/config/llm/test`，**按 provider 分支**：anthropic 走 `api.anthropic.com/v1/messages`(`:3043`)、openai/openrouter/custom 走 `{base_url}/chat/completions`(`:3064`)，含 SSRF base_url allowlist | `router.mjs:3007-3087` |
| **加密先例（已存在）** | `llm_config` 表用 AES-GCM 加密存 provider key（`api_key_enc/iv/tag`），供 memory/classify LLM 用 | `db.mjs:2705-2725` |
| Dashboard 凭证页 | `CredentialsView` 管 OAuth + lease + auth_strategy；**走 `requireDashboardToken`（共享密钥），非角色** | `CredentialsView.vue`；router `:80,:490` |
| 每 agent key 编辑 | `AgentsView` 详情面板内联字段；**用 `Authorization: Bearer <agentKey>` 调 API** | `AgentsView.vue:52, L509-535` |
| profile 抽象 | **无**。仅 spawn 时 ccrouter 按 `provider\|base_url` 临时去重，token 仍从每行复制 | win `:1136-1184` |
| FK 约束 | **`foreign_keys = ON` 已开启** | `db.mjs:16` |

---

## 3. 数据模型设计

### 3.1 新增表 `credential_profiles`

沿用 `llm_config`（db.mjs:2705）的 AES-GCM 加密模式存 token，**不明文落库**：

```sql
CREATE TABLE IF NOT EXISTS credential_profiles (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL UNIQUE,        -- 引用键，如 "xiaomi-mimo"
  provider          TEXT NOT NULL,               -- 'xiaomi'|'openrouter'|'openai'|'anthropic'|...
  base_url          TEXT NOT NULL,
  -- token 加密存储（复用 llm_config 的 AES-GCM 工具）
  auth_token_enc    TEXT NOT NULL,
  auth_token_iv     TEXT NOT NULL,
  auth_token_tag    TEXT NOT NULL,
  model             TEXT,                        -- 默认模型，可被 agent 覆盖
  last_tested_at    TEXT,
  last_test_status  TEXT,                        -- 'ok' | 'fail' | NULL
  last_test_detail  TEXT,                        -- 失败摘要，写入前经 redactBody 脱敏
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
```

> 复用现有 AES-GCM 加解密工具（`llm_config` 用的那套）。MVP 即加密，不留明文阶段。

### 3.2 `agents` 表新增引用列

```sql
ALTER TABLE agents ADD COLUMN credential_profile_id INTEGER;
```

- **不加 `REFERENCES` 外键**：虽然 `foreign_keys=ON`（db.mjs:16），但删除保护故意走应用层 `countAgentsUsingProfile()`（避免 ON DELETE 级联意外，且能返回友好 409）。这是**有意为之**，非遗漏。
- 保留所有现有内联列不动。
- **解析优先级**（见 §5.1）：`auth_mode=api_key` 且 `credential_profile_id` 非空 → 用档案；否则回退内联列。

### 3.3 模型默认覆盖

解析规则统一用 `??`（非 `||`）：`agent.api_model ?? profile.model`。即 agent 行 `api_model` 为 `null` 时才取档案默认（空串不会发生，因 `setAgentAuthConfig` 存的是 `|| null`，db.mjs:356）。

---

## 4. 迁移方案

### 4.1 自动迁移（显式脚本 `scripts/migrate-credential-profiles.mjs`，幂等，先 dry-run）

1. 扫描 `auth_mode='api_key' AND api_auth_token IS NOT NULL AND credential_profile_id IS NULL` 的 agent。
2. **规范化** `base_url`（去尾斜杠、trim）后，按 `(provider, normalized_base_url, auth_token)` 分组去重。
3. 每个唯一组合创建档案，`name` 自动生成（`{provider}-{model}`，冲突追加序号；序号化的 `xiaomi-mimo-2` 对运维不直观，dry-run 输出时一并列出供改名）。
4. 对应 agent 的 `credential_profile_id` 指向新档案。
5. **保留** agent 行内联列（不清空），供回滚与兜底。
6. **先 `--dry-run`** 打印"将创建的档案 + agent→档案映射"，确认后再执行。建议**停服执行**（见 §9）。

> 预期：HR + xiaomi 若共用同一 `(xiaomi, ..., tp-cws3n...)`，合并为单个 `xiaomi-mimo` 档案。

### 4.2 回滚

迁移不破坏内联列。回滚 = 删 `credential_profiles` 表 + 清空 `agents.credential_profile_id`，解析回退内联，行为同现状。

---

## 5. 后端改造

### 5.1 spawn 解析（**三个 impl 都改**）

在每个 impl 读 agent 认证、构建注入值处，插入档案解析。注意三处结构不同：

- **win**（`:543-549`）：用 `effectiveAgentInfo`，先解析档案覆盖 `effectiveAgentInfo.{api_base_url,api_auth_token,api_model}` 再走原 ccrouter/注入逻辑。
- **linux**（`:266-272`）：用 `agentInfo`，无 ccrouter，直接解析后注入 `ANTHROPIC_*`。
- **mac**（`:278-284`）：shell export 字符串，解析后填入 `apiEnvLines`。**必须改，否则 profile-only agent 在 mac 静默无 token → 401。**

```js
// 公共 helper（db.mjs 提供 resolveAgentCredential(agent)）：
// 返回 { base_url, token, model }，档案优先、内联兜底
function resolveAgentCredential(agent) {
  if (agent.auth_mode === 'api_key' && agent.credential_profile_id) {
    const p = getCredentialProfile(agent.credential_profile_id); // 解密 token
    if (p) return { base_url: p.base_url, token: p.auth_token, model: agent.api_model ?? p.model };
  }
  return { base_url: agent.api_base_url, token: agent.api_auth_token, model: agent.api_model };
}
```

### 5.2 ccrouter 配置 profile-aware（高危必改）

`getAgentsNeedingRouter()`（db.mjs:363）直接读 agent 行的 `api_auth_token`，**profile-first 的 openrouter/openai agent 会被漏掉** → ccrouter 无该 agent 的 key → 运行失败。改法：`getAgentsNeedingRouter` 返回前，对有 `credential_profile_id` 的行用档案值填充 `api_provider/api_base_url/api_auth_token/api_model`（解密 token）。`generateCCRouterConfig`（win:1136）随之自然正确。

### 5.3 db.mjs 新增函数

```
createCredentialProfile({name,provider,base_url,auth_token,model})  // 加密存
updateCredentialProfile(id, fields)        // 含轮换 auth_token（重新加密）
deleteCredentialProfile(id)                // countAgentsUsingProfile>0 则拒绝
getCredentialProfile(id)                   // 解密 token（仅内部/spawn 用）
listCredentialProfiles()                   // token 脱敏：前8位...(N chars)
setProfileTestResult(id,{status,detail})   // detail 经 redactBody 后存
countAgentsUsingProfile(id)
resolveAgentCredential(agent)              // §5.1 公共解析
```

> 脱敏说明：`redact.mjs` 只做 `<redacted>` 整值替换，**不**做前缀掩码。`前8位...(N chars)` 是**新增小工具**，非直接复用。

### 5.4 端点

测试连接**复用现有 `POST /api/config/llm/test`**（按 provider 分支 + SSRF allowlist，比自造单一 `/v1/messages` 探针正确 —— 后者会对 OpenAI 系 provider 误判 fail）。新增档案管理端点放在 `/api/dashboard/credentials/*` 命名空间，**走 `requireDashboardToken`（共享密钥），与该命名空间现有路由一致**：

| 方法 | 路径 | 鉴权 | 作用 |
|------|------|------|------|
| GET | `/api/dashboard/credentials/profiles` | dashboardToken | 列档案（token 脱敏）+ 引用 agent 数 + 最近测试状态 |
| POST | `/api/dashboard/credentials/profiles` | dashboardToken | 新建 |
| PUT | `/api/dashboard/credentials/profiles/:id` | dashboardToken | 编辑/轮换 |
| DELETE | `/api/dashboard/credentials/profiles/:id` | dashboardToken | 删除（有引用 409） |
| POST | `/api/dashboard/credentials/profiles/:id/test` | dashboardToken | 解密 token → 调用现有 llm/test 逻辑 → 写 last_test_* |

`PATCH /api/agents/:name`（角色鉴权 Chairman/CEO/HR）扩展接受 `credential_profile_id`。

**AgentsView 跨命名空间问题**（见 §6.2）：AgentsView 用 `Bearer <agentKey>` 调 API，读不了 `requireDashboardToken` 的 profiles。需**额外**提供一个角色鉴权的只读路由 `GET /api/agents/credential-profiles`（限 Chairman/CEO/HR，返回脱敏列表）供下拉用。

---

## 6. 前端改造

### 6.1 `CredentialsView.vue` 新增「API Key 档案」区

OAuth 卡片之后新增：档案列表（name/provider/base_url/model/token 脱敏/引用数/最近测试状态 绿√红✗灰未测/操作）+「+ 新建」表单（provider 预设下拉预填 base_url）。操作：编辑、轮换、测试、删除。轮换后提示"N 个运行中 agent 需重启"。该页已持有 dashboardToken，直接调 §5.4 端点。

### 6.2 `AgentsView.vue` 详情面板

`auth_mode=api_key` 时改为「凭证档案」下拉（调 §5.4 末尾新增的 `GET /api/agents/credential-profiles`，因为本组件是 Bearer 鉴权）+ 可选「覆盖模型」+ 保留「自定义(内联)」兜底。保存：选档案 → PATCH `credential_profile_id`；自定义 → 走原内联。

### 6.3 失效可见（完整版）

agent 列表/详情：所属档案 `last_test_status='fail'` 时红点 + tooltip；可选接入 `/api/system/health` 聚合"有 agent 引用失效档案"为一条 warn。

---

## 7. 分阶段实施

### MVP

1. `credential_profiles` 表（AES-GCM 加密）+ `agents.credential_profile_id` 列
2. 迁移脚本（dry-run + 停服执行，§4.1）
3. db.mjs CRUD + `resolveAgentCredential` + `getCredentialProfile`（解密）
4. **三个 impl** spawn 解析（win/linux/mac，§5.1）
5. **`getAgentsNeedingRouter` profile-aware**（§5.2，高危）
6. 档案管理端点（§5.4，复用 llm/test）+ `GET /api/agents/credential-profiles`（Bearer，供 AgentsView）
7. `CredentialsView` 档案区（§6.1）+ `AgentsView` 下拉（§6.2）

### 完整版

8. 后台周期探活（定时 test，写状态）
9. 失效可见：agent 列表红点 + system health 聚合（§6.3）
10. provider 预设库（xiaomi/openrouter/openai/anthropic base_url 预填）
11. 轮换历史/审计 + 轮换后自动提示重启受影响 agent
12. 运行中 agent 的 token 热更新探索（当前 env 固定，需要更大改动，暂列）

---

## 8. 安全考量

- **加密存储**：MVP 即用 AES-GCM（复用 `llm_config` 那套），token 不明文落库。
- **响应脱敏**：读端点永不回传完整 token，仅 `前8位...(N chars)`（**新增**掩码工具，非 redact.mjs 直接复用）。
- **测试 detail 脱敏**：`last_test_detail` 存上游错误体前先经 `redactBody`（redact.mjs:38），避免极端情况下回显敏感串。
- **鉴权**：档案管理端点走 `requireDashboardToken`；AgentsView 用的只读列表走角色鉴权。两套模型已厘清（§2）。
- **SSRF**：测试连接复用现有端点已有的 base_url allowlist（router:3021-3037）。
- **探活计费**：test 产生极小真实调用，UI 告知。

---

## 9. 向后兼容与风险

| 项 | 处理 |
|----|------|
| 存量 api_key agent | 迁移；未迁移走内联兜底，零中断 |
| oauth / Path A / lease | 完全不涉及 |
| **三个 spawn impl** | win/linux/mac **都改**（§5.1），否则 mac 上 profile-only agent 静默 401 |
| **ccrouter** | `getAgentsNeedingRouter` 改 profile-aware（§5.2），否则 profile-first openrouter/openai agent 漏配 |
| 运行中 agent 轮换 | env 固定，需重启才生效（§1.4），UI 提示 |
| 删除被引用档案 | 应用层 409 |
| 迁移并发 | **停服执行**或单事务；agent 可能 mid-spawn，better-sqlite3 同步 + busy_timeout 不会损坏但仍建议停服 |
| 回滚 | 内联列保留，删表 + 清列即可（§4.2） |

---

## 10. 测试计划

1. **迁移**：2 个共用同 token 的 api_key agent → 迁移 → 断言生成 1 档案、两 agent 指向它、内联列保留、base_url 尾斜杠差异被规范化合并。
2. **解析（三 impl）**：档案 token 改新值 → 重启引用 agent → 断言注入 token 是新值。**mac 上 profile-only agent 断言能拿到 token**。
3. **ccrouter**：profile-first openrouter agent → 断言出现在 ccrouter 配置且 key 正确。
4. **覆盖**：agent.api_model 非空 → 用 agent model。
5. **测试连接**：失效 token 档案 → POST test → `last_test_status='fail'` 且 detail 含 401；openai 系档案 → 断言走 `/chat/completions` 不误判。
6. **兜底**：agent 仅内联无 profile → 行为同现状。
7. **删除保护**：删被引用档案 → 409。
8. **脱敏**：GET profiles → 不含完整 token；DB 中 token 为密文。
9. **鉴权**：dashboardToken 缺失 → profiles 端点 401；AgentsView 的 Bearer 路由角色不符 → 拒绝。
10. **回滚**：删表 + 清列 → spawn 回退内联、agent 正常启动。

---

## 附：与 HR 当前问题的关系

HR 的 401 是**独立运营问题**（小米 token 过期），不依赖本设计即可修复（改 oauth 或换新 token）。本设计让"下次过期"时：(a) 在一处轮换、受影响 agent 重启后生效，(b) 失效时 dashboard 标红而非假在线。
