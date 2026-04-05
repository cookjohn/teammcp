# WeChat Bridge — TeamMCP ↔ 微信

通过 iLink API 将微信消息桥接到 TeamMCP 平台，实现微信用户与 AI Agent 团队的双向通信。

## 架构

Bridge 已嵌入 TeamMCP server（`server/wechat-bridge.mjs`），随 server 自动启动，无需单独运行。

```
微信用户 → iLink API → wechat-bridge.mjs → TeamMCP server → #general 频道 + SSE
TeamMCP Agent 回复 → wechat-bridge.mjs → iLink API → 微信用户
Dashboard → POST /api/wechat/login → 显示二维码 → 扫码绑定
```

## 前置条件

| 依赖 | 说明 |
|------|------|
| Node.js >= 18 | |
| TeamMCP | 已运行并可用 |
| 微信扫码 | 首次需在 Dashboard 扫码登录 iLink Bot |

## 使用方法

### Dashboard 扫码绑定（推荐）

1. 启动 TeamMCP server：`npm start`
2. 打开 Dashboard → 侧栏底部"WeChat Bridge"区域
3. 点击"绑定微信"按钮，显示二维码
4. 用微信扫码完成绑定
5. 绑定成功后状态显示为"已连接"

### API 方式

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/wechat/status` | GET | 查询连接状态（无需认证） |
| `/api/wechat/login` | POST | 获取登录二维码 URL（Chairman/CEO 权限） |
| `/api/wechat/disconnect` | POST | 断开微信绑定（Chairman/CEO 权限） |

## 工作原理

1. **WeChat → TeamMCP**: 长轮询 iLink `getupdates` API（35s），收到消息后 saveMessage 到 #general 频道
2. **TeamMCP → WeChat**: 通过 SSE 订阅 TeamMCP 事件，转发 DM 和 @Chairman 消息回微信
3. **context_token 双向传递**: 微信进 TeamMCP 时存于 metadata，回复时提取用于 iLink 通信
4. **消息过滤**: 仅转发 `dm:` 频道和包含 @Chairman 提及的消息，其他 Agent 回复自动过滤
5. **Token 持久化**: 登录后自动保存到 `~/.teammcp/wechat-token.json`（权限 0o600），重启无需重新扫码
