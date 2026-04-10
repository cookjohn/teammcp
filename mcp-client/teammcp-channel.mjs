#!/usr/bin/env node
/**
 * TeamMCP Channel — MCP Server plugin for Claude Code
 *
 * Connects to TeamMCP Server via SSE for real-time messages,
 * and exposes MCP tools for sending messages, querying history, etc.
 *
 * Environment variables:
 *   AGENT_NAME    — Agent display name (e.g. "B")
 *   TEAMMCP_KEY   — API key (tmcp_xxx)
 *   TEAMMCP_URL   — Server base URL (default: http://localhost:3100)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------
const AGENT_NAME = process.env.AGENT_NAME;
const API_KEY = process.env.TEAMMCP_KEY;
const BASE_URL = (process.env.TEAMMCP_URL || "http://localhost:3100").replace(/\/+$/, "");

if (!AGENT_NAME || !API_KEY) {
  console.error("ERROR: AGENT_NAME and TEAMMCP_KEY environment variables are required");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
async function apiRequest(method, path, body) {
  const url = `${BASE_URL}${path}`;
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Inbox formatting helpers
// ---------------------------------------------------------------------------

function formatTimestamp(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

function formatInbox(snapshot) {
  const parts = [];

  if (snapshot.channels?.length) {
    parts.push(`Unread channels: ${snapshot.channel_count}, unread messages: ${snapshot.total_unread}`);

    for (const channel of snapshot.channels) {
      parts.push(
        `#${channel.channel} [${channel.channel_type}] unread=${channel.unread_count} ack_id=${channel.ack_id}`
      );

      if (channel.delivery_mode === "messages") {
        for (const msg of channel.messages) {
          parts.push(`- [${formatTimestamp(msg.timestamp)}] ${msg.from}: ${msg.content}`);
        }
      } else {
        if (channel.mentions?.length) {
          parts.push(`  mentions:`);
          for (const msg of channel.mentions) {
            parts.push(`  - [${formatTimestamp(msg.timestamp)}] ${msg.from}: ${msg.content}`);
          }
        }
        if (channel.topic_summary) {
          parts.push(`  summary: ${channel.topic_summary}`);
        }
      }
    }
  }

  if (snapshot.state_changes?.length) {
    parts.push("");
    parts.push(`State changes: ${snapshot.state_changes.length}`);
    for (const change of snapshot.state_changes) {
      parts.push(
        `- ${change.project_id}.${change.field}: ${change.old_value} -> ${change.new_value} (${change.changed_by}, ${formatTimestamp(change.timestamp)})`
      );
    }
  }

  if (!parts.length) {
    return "(inbox is clear)";
  }

  parts.push("");
  parts.push("Use ack_inbox with the ack_id values above after you have handled the batch.");
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// MCP Server definition
// ---------------------------------------------------------------------------
const server = new Server(
  { name: "teammcp-channel", version: "1.0.0" },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
        "claude/channel/permission": {},
      },
      tools: {},
    },
    instructions: [
      `你是 ${AGENT_NAME}。你会通过 <channel> 事件收到消息。`,
      `收到消息后根据你的 CLAUDE.md 角色定义来响应。`,
      ``,
      `回复方式：`,
      `- 群聊回复：调用 send_message 工具`,
      `- 私聊回复：调用 send_dm 工具`,
      `- 查看在线：调用 get_agents 工具`,
      `- 查看历史：调用 get_history 工具`,
    ].join("\n"),
  }
);

// -- Tool definitions -------------------------------------------------------
const TOOLS = [
  {
    name: "send_message",
    description: "发送消息到指定频道（群聊或主题频道）",
    inputSchema: {
      type: "object",
      properties: {
        channel:  { type: "string", description: "频道 ID，如 'general'" },
        content:  { type: "string", description: "消息内容" },
        mentions: { type: "array", items: { type: "string" }, description: "@ 提及的人，可选" },
        replyTo:  { type: "string", description: "回复某条消息的 ID，可选" },
      },
      required: ["channel", "content"],
    },
  },
  {
    name: "send_dm",
    description: "发送私聊消息给指定用户",
    inputSchema: {
      type: "object",
      properties: {
        recipient: { type: "string", description: "接收者名称" },
        content:   { type: "string", description: "消息内容" },
        replyTo:   { type: "string", description: "回复某条消息的 ID，可选" },
      },
      required: ["recipient", "content"],
    },
  },
  {
    name: "get_history",
    description: "查看频道消息历史",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "频道 ID" },
        limit:   { type: "number", description: "返回条数，默认 50" },
      },
      required: ["channel"],
    },
  },
  {
    name: "get_agents",
    description: "查看所有 Agent 及在线状态",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_channels",
    description: "查看频道列表及未读数",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_channel",
    description: "创建新频道",
    inputSchema: {
      type: "object",
      properties: {
        id:      { type: "string", description: "频道 ID（英文，用作标识）" },
        name:    { type: "string", description: "频道显示名" },
        type:    { type: "string", enum: ["group", "topic"], description: "频道类型" },
        members: { type: "array", items: { type: "string" }, description: "成员列表（topic 频道可选）" },
      },
      required: ["id", "name", "type"],
    },
  },
  {
    name: "edit_message",
    description: "编辑自己发送的消息",
    inputSchema: {
      type: "object",
      properties: {
        id:      { type: "string", description: "消息 ID" },
        content: { type: "string", description: "新的消息内容" },
      },
      required: ["id", "content"],
    },
  },
  {
    name: "delete_message",
    description: "删除自己发送的消息",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "消息 ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "search_messages",
    description: "搜索历史消息",
    inputSchema: {
      type: "object",
      properties: {
        query:   { type: "string", description: "搜索关键词" },
        channel: { type: "string", description: "限定频道（可选）" },
        from:    { type: "string", description: "限定发送者（可选）" },
        limit:   { type: "number", description: "返回条数，默认 20，上限 100" },
      },
      required: ["query"],
    },
  },
  {
    name: "start_agent",
    description: "启动一个 Agent 进程（仅 CEO/HR 可用）",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Agent 名称" },
      },
      required: ["name"],
    },
  },
  {
    name: "stop_agent",
    description: "停止一个 Agent 进程（仅 CEO/HR 可用）",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Agent 名称" },
      },
      required: ["name"],
    },
  },
  {
    name: "screenshot_agent",
    description: "截图指定 Agent 的终端窗口，返回截图文件路径（仅 CEO/HR 可用）",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Agent 名称" },
      },
      required: ["name"],
    },
  },
  {
    name: "send_keys_to_agent",
    description: "向指定 Agent 的终端窗口发送按键，如 enter/tab/1/2/y/n（仅 CEO/HR 可用）",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Agent 名称" },
        keys: { type: "string", description: "按键，如 'enter', '1', 'y'" },
      },
      required: ["name", "keys"],
    },
  },
  {
    name: "pin_task",
    description: "将一条消息转化为可追踪的任务（创建任务的主要方式）",
    inputSchema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "要转化为任务的消息 ID" },
        assignee:   { type: "string", description: "负责人 Agent 名称" },
        priority:   { type: "string", enum: ["urgent", "high", "medium", "low"], description: "优先级，默认 medium" },
        due_date:   { type: "string", description: "截止时间 ISO 8601（可选）" },
        title:      { type: "string", description: "自定义标题（可选，默认取消息内容）" },
      },
      required: ["message_id"],
    },
  },
  {
    name: "create_task",
    description: "直接创建任务（不关联消息时使用）。通常优先使用 pin_task 从消息创建。",
    inputSchema: {
      type: "object",
      properties: {
        title:     { type: "string", description: "任务标题" },
        assignee:  { type: "string", description: "负责人" },
        priority:  { type: "string", enum: ["urgent", "high", "medium", "low"], description: "优先级" },
        parent_id: { type: "string", description: "父任务 ID" },
        due_date:  { type: "string", description: "截止时间" },
        labels:    { type: "array", items: { type: "string" }, description: "标签" },
        task_type: { type: "string", enum: ["task", "milestone"], description: "任务类型" },
        checkin_interval: { type: "string", enum: ["daily", "weekly", "biweekly"], description: "定期 check-in 频率" },
        related_state: { type: "string", description: "关联的状态字段名" },
        related_state_project: { type: "string", description: "状态字段所属项目ID" },
        target_value: { type: "string", description: "任务完成时自动设置的目标值" },
        files: { type: "array", items: { type: "string" }, description: "关联的项目文件路径列表" },
      },
      required: ["title"],
    },
  },
  {
    name: "list_tasks",
    description: "查询任务列表。不带参数返回所有未完成任务。",
    inputSchema: {
      type: "object",
      properties: {
        status:   { type: "string", description: "状态过滤：todo/doing/done，逗号分隔" },
        assignee: { type: "string", description: "负责人" },
        creator:  { type: "string", description: "创建者" },
        priority: { type: "string", description: "优先级" },
        limit:    { type: "number", description: "返回数量，默认 20" },
      },
    },
  },
  {
    name: "update_task",
    description: "更新任务字段或状态。状态值：todo/doing/done。",
    inputSchema: {
      type: "object",
      properties: {
        task_id:  { type: "string", description: "任务 ID" },
        status:   { type: "string", enum: ["todo", "doing", "done"], description: "新状态" },
        assignee: { type: "string", description: "新负责人" },
        priority: { type: "string", enum: ["urgent", "high", "medium", "low"], description: "优先级" },
        title:    { type: "string", description: "新标题" },
        result:   { type: "string", description: "完成成果" },
        due_date: { type: "string", description: "截止时间" },
        labels:   { type: "array", items: { type: "string" }, description: "标签" },
        progress: { type: "number", description: "进度百分比 (0-100)" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "done_task",
    description: "快捷完成任务（= update status:done + result）",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "任务 ID" },
        result:  { type: "string", description: "完成成果说明" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "check_knowledge_gaps",
    description: "检查 Agent 的知识缺口——对比当前上下文与共享状态，发现缺失的关键信息",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "项目 ID" },
        agent_id:   { type: "string", description: "Agent ID（可选，默认为当前 Agent）" },
      },
      required: ["project_id"],
    },
  },
  {
    name: "acknowledge_knowledge_gaps",
    description: "确认已补充知识缺口，更新 Agent 的 last_known_versions",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "项目 ID" },
        fields:     { type: "array", items: { type: "string" }, description: "已确认补充的字段列表" },
        agent_id:   { type: "string", description: "Agent ID（可选，默认为当前 Agent）" },
      },
      required: ["project_id", "fields"],
    },
  },
  {
    name: "get_agent_profile",
    description: "获取 Agent 的元认知 Profile（关注字段、参与项目/频道等）",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Agent ID（可选，默认为当前 Agent）" },
      },
    },
  },
  {
    name: "update_agent_profile",
    description: "更新 Agent 的元认知 Profile（关注字段、关键字段、参与项目/频道等）",
    inputSchema: {
      type: "object",
      properties: {
        agent_id:               { type: "string", description: "Agent ID（可选，默认为当前 Agent）" },
        relevant_fields:        { type: "array", items: { type: "string" }, description: "Agent 关注的状态字段列表" },
        critical_fields:        { type: "array", items: { type: "string" }, description: "需要立即关注的关键字段" },
        participating_projects: { type: "array", items: { type: "string" }, description: "参与的项目列表" },
        participating_channels: { type: "array", items: { type: "string" }, description: "参与的频道列表" },
      },
    },
  },
  {
    name: "get_inbox",
    description: "Pull unread TeamMCP messages in a Codex-friendly format.",
    inputSchema: {
      type: "object",
      properties: {
        detail_limit: { type: "number", description: "Max messages or mentions per channel" },
        summary_threshold: { type: "number", description: "Switch to summary mode above this unread count" },
      },
    },
  },
  {
    name: "ack_inbox",
    description: "Advance TeamMCP read markers using ack_id values returned by get_inbox.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              channel: { type: "string" },
              ack_id: { type: "string" },
            },
            required: ["channel", "ack_id"],
          },
        },
      },
    },
  },
  {
    name: "schedule_message",
    description: "创建定时消息，按 cron 表达式定期发送到指定频道",
    inputSchema: {
      type: "object",
      properties: {
        channel:   { type: "string", description: "目标频道 ID" },
        content:   { type: "string", description: "消息内容" },
        cron_expr: { type: "string", description: "Cron 表达式，如 '0 9 * * *'（每天9点）, '0 9 * * 1'（每周一9点）, '*/30 * * * *'（每30分钟）" },
      },
      required: ["channel", "content", "cron_expr"],
    },
  },
  {
    name: "list_schedules",
    description: "查看自己创建的定时消息列表",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "cancel_schedule",
    description: "取消一个定时消息",
    inputSchema: {
      type: "object",
      properties: {
        schedule_id: { type: "string", description: "定时消息 ID (sched_xxx)" },
      },
      required: ["schedule_id"],
    },
  },
  // -- P0 Approval Flow tools ------------------------------------------------
  {
    name: "request_approval",
    description: "提交状态变更请求（非 owner 时自动转审批）",
    inputSchema: {
      type: "object",
      properties: {
        project_id:        { type: "string", description: "项目 ID" },
        field:             { type: "string", description: "要变更的字段" },
        value:             { type: "string", description: "目标值" },
        reason:            { type: "string", description: "变更原因" },
        owner:             { type: "string", description: "字段 owner" },
        approval_required: { type: "boolean", description: "是否需要审批" },
      },
      required: ["project_id", "field", "value"],
    },
  },
  {
    name: "get_pending_approvals",
    description: "查看待我审批的请求列表",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "resolve_approval",
    description: "批准或拒绝审批请求",
    inputSchema: {
      type: "object",
      properties: {
        approval_id: { type: "string", description: "审批请求 ID" },
        approved:    { type: "boolean", description: "是否批准" },
        comment:     { type: "string", description: "审批意见" },
      },
      required: ["approval_id", "approved"],
    },
  },
  // -- P0 Audit tools --------------------------------------------------------
  {
    name: "get_changelog",
    description: "查询变更日志（仅 Audit 角色可用）",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "项目 ID" },
        field:      { type: "string", description: "字段名" },
        changed_by: { type: "string", description: "变更人" },
        source:     { type: "string", description: "来源" },
        from:       { type: "string", description: "开始日期" },
        to:         { type: "string", description: "结束日期" },
        limit:      { type: "number", description: "返回条数" },
      },
    },
  },
  {
    name: "generate_audit_report",
    description: "生成审计报告（仅 Audit 角色可用）",
    inputSchema: {
      type: "object",
      properties: {
        project_id:  { type: "string", description: "项目 ID" },
        report_type: { type: "string", enum: ["compliance", "efficiency", "anomaly"], description: "报告类型" },
      },
      required: ["project_id", "report_type"],
    },
  },
  {
    name: "get_audit_reports",
    description: "查看已生成的审计报告（仅 Audit 角色可用）",
    inputSchema: {
      type: "object",
      properties: {
        project_id:  { type: "string", description: "项目 ID" },
        report_type: { type: "string", description: "报告类型" },
        limit:       { type: "number", description: "返回条数" },
      },
    },
  },
  {
    name: "get_public_reports",
    description: "查看公开审计报告（所有 Agent 可用）",
    inputSchema: {
      type: "object",
      properties: {
        project_id:  { type: "string", description: "项目 ID" },
        report_type: { type: "string", description: "报告类型" },
        limit:       { type: "number", description: "返回条数" },
      },
    },
  },
  // -- P1 Shared State tools -------------------------------------------------
  {
    name: "get_state",
    description: "读取共享状态",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "项目 ID" },
        field:      { type: "string", description: "字段名（可选，不传返回所有字段）" },
      },
      required: ["project_id"],
    },
  },
  {
    name: "set_state",
    description: "写入共享状态（owner 直接生效，非 owner 自动走审批）",
    inputSchema: {
      type: "object",
      properties: {
        project_id:       { type: "string", description: "项目 ID" },
        field:            { type: "string", description: "字段名" },
        value:            { type: "string", description: "字段值" },
        reason:           { type: "string", description: "变更原因" },
        owner:            { type: "string", description: "字段 owner" },
        approval_required: { type: "boolean", description: "是否需要审批" },
        expected_version: { type: "number", description: "期望版本号（乐观并发控制）" },
      },
      required: ["project_id", "field", "value"],
    },
  },
  {
    name: "get_state_history",
    description: "查看状态变更历史",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "项目 ID" },
        field:      { type: "string", description: "字段名（可选）" },
        limit:      { type: "number", description: "返回条数" },
      },
      required: ["project_id"],
    },
  },
  {
    name: "subscribe_state",
    description: "订阅状态变更通知",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "项目 ID" },
        fields:     { type: "array", items: { type: "string" }, description: "要订阅的字段列表" },
      },
      required: ["project_id", "fields"],
    },
  },
  {
    name: "add_reaction",
    description: "给消息添加 emoji 反应",
    inputSchema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "消息 ID" },
        emoji:      { type: "string", description: "Emoji 表情（允许：👍👎❤️😄🎉👀🤔✅）" },
      },
      required: ["message_id", "emoji"],
    },
  },
  {
    name: "remove_reaction",
    description: "移除 emoji 反应",
    inputSchema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "消息 ID" },
        emoji:      { type: "string", description: "要移除的 Emoji 表情" },
      },
      required: ["message_id", "emoji"],
    },
  },
  {
    name: "pin_message",
    description: "置顶消息",
    inputSchema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "消息 ID" },
      },
      required: ["message_id"],
    },
  },
  {
    name: "unpin_message",
    description: "取消置顶消息",
    inputSchema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "消息 ID" },
      },
      required: ["message_id"],
    },
  },
  {
    name: "get_pinned_messages",
    description: "获取频道置顶消息列表",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "频道 ID" },
      },
      required: ["channel_id"],
    },
  },
  {
    name: "upload_file",
    description: "上传文件到 TeamMCP（base64 编码）",
    inputSchema: {
      type: "object",
      properties: {
        name:    { type: "string", description: "文件名（含扩展名），如 'report.json'" },
        content: { type: "string", description: "文件内容的 base64 编码" },
        channel: { type: "string", description: "关联频道 ID（可选，用于权限控制）" },
      },
      required: ["name", "content"],
    },
  },
  {
    name: "download_file",
    description: "下载文件（返回 base64 内容和元数据）",
    inputSchema: {
      type: "object",
      properties: {
        file_id: { type: "string", description: "文件 ID，如 'file_abc123'" },
      },
      required: ["file_id"],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "send_message": {
        const body = {
          channel: args.channel,
          content: args.content,
          mentions: args.mentions || [],
        };
        if (args.replyTo) body.replyTo = args.replyTo;
        const result = await apiRequest("POST", "/api/send", body);
        return { content: [{ type: "text", text: `Message sent (id: ${result.id})` }] };
      }

      case "send_dm": {
        const body = {
          channel: `dm:${args.recipient}`,
          content: args.content,
        };
        if (args.replyTo) body.replyTo = args.replyTo;
        const result = await apiRequest("POST", "/api/send", body);
        return { content: [{ type: "text", text: `DM sent to ${args.recipient} (id: ${result.id})` }] };
      }

      case "get_history": {
        const params = new URLSearchParams({ channel: args.channel });
        if (args.limit) params.set("limit", String(args.limit));
        const result = await apiRequest("GET", `/api/history?${params}`);
        const formatted = result.messages
          .map((m) => `[${m.created_at}] ${m.from_agent}: ${m.content}`)
          .join("\n");
        return {
          content: [{
            type: "text",
            text: formatted || "(no messages)",
          }],
        };
      }

      case "get_agents": {
        const agents = await apiRequest("GET", "/api/agents");
        const formatted = agents
          .map((a) => `${a.name} (${a.role || "?"}) — ${a.status}${a.last_seen ? ` [${a.last_seen}]` : ""}`)
          .join("\n");
        return { content: [{ type: "text", text: formatted || "(no agents)" }] };
      }

      case "get_channels": {
        const channels = await apiRequest("GET", "/api/channels");
        const formatted = channels
          .map((c) => `#${c.id} [${c.type}]${c.unread ? ` (${c.unread} unread)` : ""}`)
          .join("\n");
        return { content: [{ type: "text", text: formatted || "(no channels)" }] };
      }

      case "create_channel": {
        await apiRequest("POST", "/api/channels", {
          id: args.id,
          name: args.name,
          type: args.type,
          members: args.members || [],
        });
        return { content: [{ type: "text", text: `Channel #${args.id} created` }] };
      }

      case "edit_message": {
        const result = await apiRequest("PUT", `/api/messages/${args.id}`, {
          content: args.content,
        });
        return { content: [{ type: "text", text: `Message ${result.id} edited (at ${result.edited_at})` }] };
      }

      case "delete_message": {
        const result = await apiRequest("DELETE", `/api/messages/${args.id}`);
        return { content: [{ type: "text", text: `Message ${result.id} deleted` }] };
      }

      case "search_messages": {
        const params = new URLSearchParams({ q: args.query });
        if (args.channel) params.set("channel", args.channel);
        if (args.from) params.set("from", args.from);
        if (args.limit) params.set("limit", String(args.limit));
        const result = await apiRequest("GET", `/api/search?${params}`);
        const formatted = result.results
          .map((m) => `[${m.created_at}] #${m.channel_id} ${m.from_agent}: ${m.content}`)
          .join("\n");
        return {
          content: [{
            type: "text",
            text: formatted
              ? `Found ${result.total} results for "${result.query}":\n\n${formatted}`
              : `No results for "${result.query}"`,
          }],
        };
      }

      case "start_agent": {
        const result = await apiRequest("POST", `/api/agents/${args.name}/start`);
        return { content: [{ type: "text", text: `Agent ${result.name} starting (PID: ${result.pid})` }] };
      }

      case "stop_agent": {
        const result = await apiRequest("POST", `/api/agents/${args.name}/stop`);
        return { content: [{ type: "text", text: `Agent ${result.name} stopped` }] };
      }

      case "screenshot_agent": {
        const result = await apiRequest("POST", `/api/agents/${args.name}/screenshot`);
        return { content: [
          { type: "text", text: `Screenshot saved: ${result.screenshot}` },
          { type: "resource", resource: { uri: `file:///${result.screenshot.replace(/\\/g, '/')}`, mimeType: "image/png", text: `Screenshot of Agent ${result.name}` } },
        ] };
      }

      case "send_keys_to_agent": {
        const result = await apiRequest("POST", `/api/agents/${args.name}/sendkeys`, { keys: args.keys });
        return { content: [{ type: "text", text: `Sent keys "${result.sent}" to Agent ${result.name}` }] };
      }

      case "pin_task": {
        const body = { source_msg: args.message_id };
        if (args.assignee) body.assignee = args.assignee;
        if (args.priority) body.priority = args.priority;
        if (args.due_date) body.due_date = args.due_date;
        if (args.title) body.title = args.title;
        const result = await apiRequest("POST", "/api/tasks", body);
        const task = result.task;
        return { content: [{ type: "text", text: `Task created: ${task.id} — ${task.title} [${task.status}]${task.assignee ? ` assigned to ${task.assignee}` : ''}` }] };
      }

      case "create_task": {
        const body = { title: args.title };
        if (args.assignee) body.assignee = args.assignee;
        if (args.priority) body.priority = args.priority;
        if (args.parent_id) body.parent_id = args.parent_id;
        if (args.due_date) body.due_date = args.due_date;
        if (args.labels) body.labels = args.labels;
        if (args.task_type) body.task_type = args.task_type;
        if (args.checkin_interval) body.checkin_interval = args.checkin_interval;
        if (args.related_state) body.related_state = args.related_state;
        if (args.related_state_project) body.related_state_project = args.related_state_project;
        if (args.target_value) body.target_value = args.target_value;
        if (args.files) body.files = args.files;
        const result = await apiRequest("POST", "/api/tasks", body);
        const task = result.task;
        return { content: [{ type: "text", text: `Task created: ${task.id} — ${task.title} [${task.status}]${task.assignee ? ` assigned to ${task.assignee}` : ''}` }] };
      }

      case "list_tasks": {
        const params = new URLSearchParams();
        params.set("status", args.status || "todo,doing");
        if (args.assignee) params.set("assignee", args.assignee);
        if (args.creator) params.set("creator", args.creator);
        if (args.priority) params.set("priority", args.priority);
        if (args.limit) params.set("limit", String(args.limit));
        const result = await apiRequest("GET", `/api/tasks?${params}`);
        if (!result.tasks || result.tasks.length === 0) {
          return { content: [{ type: "text", text: "(no tasks found)" }] };
        }
        const icons = { todo: "📋", doing: "🔨", done: "✅" };
        const formatted = result.tasks.map(t =>
          `${icons[t.status] || "?"} ${t.id} [${t.priority}] ${t.title}${t.assignee ? ` → ${t.assignee}` : ''}`
        ).join("\n");
        return { content: [{ type: "text", text: `${result.total} task(s):\n\n${formatted}` }] };
      }

      case "update_task": {
        const body = {};
        for (const f of ["status", "assignee", "priority", "title", "result", "due_date", "labels", "progress"]) {
          if (args[f] !== undefined) body[f] = args[f];
        }
        const result = await apiRequest("PATCH", `/api/tasks/${args.task_id}`, body);
        const task = result.task;
        return { content: [{ type: "text", text: `Task ${task.id} updated — ${task.title} [${task.status}]${task.assignee ? ` → ${task.assignee}` : ''}` }] };
      }

      case "done_task": {
        const body = { status: "done", result: args.result || "" };
        const result = await apiRequest("PATCH", `/api/tasks/${args.task_id}`, body);
        const task = result.task;
        return { content: [{ type: "text", text: `Task ${task.id} completed ✅${args.result ? ` — ${args.result.slice(0, 80)}` : ''}` }] };
      }

      case "check_knowledge_gaps": {
        const params = new URLSearchParams({ project_id: args.project_id });
        if (args.agent_id) params.set("agent_id", args.agent_id);
        const result = await apiRequest("GET", `/api/state/knowledge-gaps?${params}`);
        if (result.error === 'no_profile') {
          return { content: [{ type: "text", text: `No agent profile found. Use update_agent_profile to create one first.` }] };
        }
        if (!result.has_gaps) {
          return { content: [{ type: "text", text: `No knowledge gaps detected for ${result.agent_id} in project ${result.project_id}. Context is up to date.` }] };
        }
        const gapLines = result.gaps.map(g =>
          `- ${g.field}: v${g.your_version} → v${g.current_version} (${g.changes_missed} changes missed) — ${g.summary}`
        );
        let text = `Knowledge gaps detected for ${result.agent_id} in project ${result.project_id}:\n${gapLines.join('\n')}`;
        if (result.critical_gaps.length > 0) {
          text += `\n\n⚠️ Critical gaps: ${result.critical_gaps.join(', ')}`;
        }
        text += `\n\nUse acknowledge_knowledge_gaps to confirm you've reviewed these changes.`;
        return { content: [{ type: "text", text }] };
      }

      case "acknowledge_knowledge_gaps": {
        const body = { project_id: args.project_id, fields: args.fields };
        // agent_id is forced to self on server side, no need to send
        const result = await apiRequest("POST", "/api/state/knowledge-gaps/acknowledge", body);
        if (result.error) {
          return { content: [{ type: "text", text: `Error: ${result.error} — ${result.message || ''}` }], isError: true };
        }
        return { content: [{ type: "text", text: `Acknowledged ${args.fields.length} fields: ${args.fields.join(', ')}. Last known versions updated.` }] };
      }

      case "get_agent_profile": {
        const params = new URLSearchParams();
        if (args.agent_id) params.set("agent_id", args.agent_id);
        const result = await apiRequest("GET", `/api/state/agent-profile?${params}`);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "update_agent_profile": {
        const body = {};
        if (args.agent_id) body.agent_id = args.agent_id;
        if (args.relevant_fields) body.relevant_fields = args.relevant_fields;
        if (args.critical_fields) body.critical_fields = args.critical_fields;
        if (args.participating_projects) body.participating_projects = args.participating_projects;
        if (args.participating_channels) body.participating_channels = args.participating_channels;
        const result = await apiRequest("POST", "/api/state/agent-profile", body);
        if (result.error) {
          return { content: [{ type: "text", text: `Error: ${result.error} — ${result.message || ''}` }], isError: true };
        }
        return { content: [{ type: "text", text: `Agent profile updated for ${result.agent_id}` }] };
      }

      case "get_inbox": {
        const params = new URLSearchParams();
        if (args.detail_limit) params.set("detail_limit", String(args.detail_limit));
        if (args.summary_threshold) params.set("summary_threshold", String(args.summary_threshold));
        const suffix = params.toString() ? `?${params}` : "";
        const result = await apiRequest("GET", `/api/inbox${suffix}`);
        return { content: [{ type: "text", text: formatInbox(result) }] };
      }

      case "ack_inbox": {
        const result = await apiRequest("POST", "/api/inbox/ack", { items: args.items || [] });
        return { content: [{ type: "text", text: `Acknowledged ${result.acknowledged} inbox item(s)` }] };
      }

      case "schedule_message": {
        const result = await apiRequest("POST", "/api/schedules", {
          channel: args.channel,
          content: args.content,
          cron_expr: args.cron_expr,
        });
        const s = result.schedule;
        return { content: [{ type: "text", text: `Schedule created: ${s.id} — next run: ${s.next_run} (cron: ${s.cron_expr})` }] };
      }

      case "list_schedules": {
        const result = await apiRequest("GET", "/api/schedules");
        if (!result.schedules || result.schedules.length === 0) {
          return { content: [{ type: "text", text: "(no scheduled messages)" }] };
        }
        const formatted = result.schedules.map(s =>
          `${s.id} [${s.enabled ? 'ON' : 'OFF'}] #${s.channel} cron=${s.cron_expr} next=${s.next_run}\n  → ${s.content.slice(0, 80)}`
        ).join("\n");
        return { content: [{ type: "text", text: `${result.schedules.length} schedule(s):\n\n${formatted}` }] };
      }

      case "cancel_schedule": {
        const result = await apiRequest("DELETE", `/api/schedules/${args.schedule_id}`);
        return { content: [{ type: "text", text: `Schedule ${result.id} deleted` }] };
      }

      // -- P0 Approval Flow handlers ------------------------------------------

      case "request_approval": {
        const body = {
          project_id: args.project_id,
          field: args.field,
          value: args.value,
        };
        if (args.reason) body.reason = args.reason;
        if (args.owner) body.owner = args.owner;
        if (args.approval_required !== undefined) body.approval_required = args.approval_required;
        const result = await apiRequest("POST", "/api/state", body);
        if (result.error) {
          return { content: [{ type: "text", text: `Error: ${result.error} — ${result.message || ''}` }], isError: true };
        }
        if (result.requires_knowledge_check) {
          return { content: [{ type: "text", text: `Knowledge gaps detected — call check_knowledge_gaps for project ${args.project_id} before updating state.` }] };
        }
        if (result.pending_approval || result.approval) {
          const approvalId = result.approval_id || result.approval?.approval_id || "(unknown)";
          const approvalStatus = result.approval?.status || result.pending_approval?.status || "pending";
          return { content: [{ type: "text", text: `Approval created — request id: ${approvalId}, status: ${approvalStatus}` }] };
        }
        return { content: [{ type: "text", text: `State updated directly — ${args.project_id}.${args.field} = ${args.value}` }] };
      }

      case "get_pending_approvals": {
        const result = await apiRequest("GET", "/api/state/approvals");
        const approvals = result.approvals || result;
        if (!Array.isArray(approvals) || approvals.length === 0) {
          return { content: [{ type: "text", text: "(no pending approvals)" }] };
        }
        const formatted = approvals.map(a =>
          `${a.approval_id} | ${a.project_id}.${a.field} → ${a.proposed_value} | by ${a.proposed_by} | ${formatTimestamp(a.created_at)}`
        ).join("\n");
        return { content: [{ type: "text", text: `${approvals.length} pending approval(s):\n\n${formatted}` }] };
      }

      case "resolve_approval": {
        const body = { approved: args.approved };
        if (args.comment) body.comment = args.comment;
        const result = await apiRequest("POST", `/api/state/approvals/${args.approval_id}/resolve`, body);
        if (result.error) {
          return { content: [{ type: "text", text: `Error: ${result.error} — ${result.message || ''}` }], isError: true };
        }
        const action = args.approved ? "Approved" : "Rejected";
        return { content: [{ type: "text", text: `${action} approval ${args.approval_id}${args.comment ? ` — ${args.comment}` : ""}` }] };
      }

      // -- P0 Audit handlers --------------------------------------------------

      case "get_changelog": {
        const params = new URLSearchParams();
        if (args.project_id) params.set("project_id", args.project_id);
        if (args.field) params.set("field", args.field);
        if (args.changed_by) params.set("changed_by", args.changed_by);
        if (args.source) params.set("source", args.source);
        if (args.from) params.set("from", args.from);
        if (args.to) params.set("to", args.to);
        if (args.limit) params.set("limit", String(args.limit));
        const suffix = params.toString() ? `?${params}` : "";
        const result = await apiRequest("GET", `/api/audit/changelog${suffix}`);
        const entries = result.entries || result;
        if (!Array.isArray(entries) || entries.length === 0) {
          return { content: [{ type: "text", text: "(no changelog entries)" }] };
        }
        const formatted = entries.map(e =>
          `[${formatTimestamp(e.timestamp)}] ${e.project_id}.${e.field}: ${e.old_value} → ${e.new_value} (by ${e.changed_by}, source: ${e.source || "unknown"})`
        ).join("\n");
        return { content: [{ type: "text", text: `${entries.length} changelog entry/entries:\n\n${formatted}` }] };
      }

      case "generate_audit_report": {
        const result = await apiRequest("POST", "/api/audit/reports", {
          project_id: args.project_id,
          report_type: args.report_type,
        });
        if (result.error) {
          return { content: [{ type: "text", text: `Error: ${result.error} — ${result.message || ''}` }], isError: true };
        }
        const report = result.report || result;
        return { content: [{ type: "text", text: `Audit report generated — id: ${report.id || "(unknown)"}, type: ${args.report_type}, project: ${args.project_id}` }] };
      }

      case "get_audit_reports": {
        const params = new URLSearchParams();
        if (args.project_id) params.set("project_id", args.project_id);
        if (args.report_type) params.set("report_type", args.report_type);
        if (args.limit) params.set("limit", String(args.limit));
        const suffix = params.toString() ? `?${params}` : "";
        const result = await apiRequest("GET", `/api/audit/reports${suffix}`);
        const reports = result.reports || result;
        if (!Array.isArray(reports) || reports.length === 0) {
          return { content: [{ type: "text", text: "(no audit reports)" }] };
        }
        const formatted = reports.map(r =>
          `${r.id} | ${r.report_type} | ${r.project_id} | ${formatTimestamp(r.created_at)} | ${r.status || "done"}`
        ).join("\n");
        return { content: [{ type: "text", text: `${reports.length} audit report(s):\n\n${formatted}` }] };
      }

      case "get_public_reports": {
        const params = new URLSearchParams();
        if (args.project_id) params.set("project_id", args.project_id);
        if (args.report_type) params.set("report_type", args.report_type);
        if (args.limit) params.set("limit", String(args.limit));
        const suffix = params.toString() ? `?${params}` : "";
        const result = await apiRequest("GET", `/api/reports/public${suffix}`);
        const reports = result.reports || result;
        if (!Array.isArray(reports) || reports.length === 0) {
          return { content: [{ type: "text", text: "(no public reports)" }] };
        }
        const formatted = reports.map(r =>
          `${r.id} | ${r.report_type} | ${r.project_id} | ${formatTimestamp(r.created_at)} | ${r.summary || ""}`
        ).join("\n");
        return { content: [{ type: "text", text: `${reports.length} public report(s):\n\n${formatted}` }] };
      }

      // -- P1 Shared State handlers ---------------------------------------------

      case "get_state": {
        const params = new URLSearchParams({ project_id: args.project_id });
        if (args.field) params.set("field", args.field);
        const result = await apiRequest("GET", `/api/state?${params}`);
        if (args.field) {
          const state = result.state || result;
          const val = state.value !== undefined ? state.value : JSON.stringify(state);
          return { content: [{ type: "text", text: `${args.project_id}.${args.field} = ${val} (v${state.version || "?"})` }] };
        }
        const fields = result.items || (Array.isArray(result) ? result : []);
        if (!fields.length) {
          return { content: [{ type: "text", text: `(no state fields for project ${args.project_id})` }] };
        }
        const formatted = fields.map(f =>
          `${f.field}: ${f.value} (v${f.version || "?"}, owner: ${f.owner || "-"})`
        ).join("\n");
        return { content: [{ type: "text", text: `State for ${args.project_id}:\n\n${formatted}` }] };
      }

      case "set_state": {
        const body = {
          project_id: args.project_id,
          field: args.field,
          value: args.value,
        };
        if (args.reason) body.reason = args.reason;
        if (args.owner) body.owner = args.owner;
        if (args.approval_required !== undefined) body.approval_required = args.approval_required;
        if (args.expected_version !== undefined) body.expected_version = args.expected_version;
        const result = await apiRequest("POST", "/api/state", body);
        if (result.error) {
          return { content: [{ type: "text", text: `Error: ${result.error} — ${result.message || ''}` }], isError: true };
        }
        if (result.requires_knowledge_check) {
          return { content: [{ type: "text", text: `Knowledge gaps detected — call check_knowledge_gaps for project ${args.project_id} before updating state.` }] };
        }
        if (result.pending_approval || result.approval) {
          const approvalId = result.approval_id || result.approval?.approval_id || "(unknown)";
          const approvalStatus = result.approval?.status || result.pending_approval?.status || "pending";
          return { content: [{ type: "text", text: `Approval created — request id: ${approvalId}, status: ${approvalStatus}` }] };
        }
        return { content: [{ type: "text", text: `State updated: ${args.project_id}.${args.field} = ${args.value}` }] };
      }

      case "get_state_history": {
        const params = new URLSearchParams({ project_id: args.project_id });
        if (args.field) params.set("field", args.field);
        if (args.limit) params.set("limit", String(args.limit));
        const result = await apiRequest("GET", `/api/state/history?${params}`);
        const entries = result.history || result.entries || result;
        if (!Array.isArray(entries) || entries.length === 0) {
          return { content: [{ type: "text", text: "(no state history)" }] };
        }
        const formatted = entries.map(e =>
          `[${formatTimestamp(e.timestamp)}] ${e.field}: ${e.old_value} → ${e.new_value} (by ${e.changed_by})`
        ).join("\n");
        return { content: [{ type: "text", text: `${entries.length} history entry/entries:\n\n${formatted}` }] };
      }

      case "subscribe_state": {
        const result = await apiRequest("POST", "/api/state/subscribe", {
          project_id: args.project_id,
          fields: args.fields,
        });
        if (result.error) {
          return { content: [{ type: "text", text: `Error: ${result.error} — ${result.message || ''}` }], isError: true };
        }
        return { content: [{ type: "text", text: `Subscribed to ${args.fields.length} field(s) in project ${args.project_id}: ${args.fields.join(", ")}` }] };
      }

      case "add_reaction": {
        const result = await apiRequest("POST", `/api/messages/${args.message_id}/reactions`, { emoji: args.emoji });
        if (result.error) {
          return { content: [{ type: "text", text: `Error: ${result.error} — ${result.message || ''}` }], isError: true };
        }
        return { content: [{ type: "text", text: `Reaction ${args.emoji} added to message ${args.message_id}` }] };
      }

      case "remove_reaction": {
        const result = await apiRequest("DELETE", `/api/messages/${args.message_id}/reactions/${encodeURIComponent(args.emoji)}`);
        if (result.error) {
          return { content: [{ type: "text", text: `Error: ${result.error} — ${result.message || ''}` }], isError: true };
        }
        return { content: [{ type: "text", text: `Reaction ${args.emoji} removed from message ${args.message_id}` }] };
      }

      case "pin_message": {
        const result = await apiRequest("POST", `/api/messages/${args.message_id}/pin`);
        if (result.error) {
          return { content: [{ type: "text", text: `Error: ${result.error} — ${result.message || ''}` }], isError: true };
        }
        return { content: [{ type: "text", text: `Message ${args.message_id} pinned` }] };
      }

      case "unpin_message": {
        const result = await apiRequest("DELETE", `/api/messages/${args.message_id}/pin`);
        if (result.error) {
          return { content: [{ type: "text", text: `Error: ${result.error} — ${result.message || ''}` }], isError: true };
        }
        return { content: [{ type: "text", text: `Message ${args.message_id} unpinned` }] };
      }

      case "get_pinned_messages": {
        const result = await apiRequest("GET", `/api/channels/${args.channel_id}/pins`);
        if (result.error) {
          return { content: [{ type: "text", text: `Error: ${result.error} — ${result.message || ''}` }], isError: true };
        }
        const pins = result.pins || result;
        if (!Array.isArray(pins) || pins.length === 0) {
          return { content: [{ type: "text", text: `(no pinned messages in #${args.channel_id})` }] };
        }
        const formatted = pins.map(p =>
          `${p.id} | ${p.from_agent}: ${p.content} [${formatTimestamp(p.pinned_at || p.created_at)}]`
        ).join("\n");
        return { content: [{ type: "text", text: `${pins.length} pinned message(s):\n\n${formatted}` }] };
      }

      case "upload_file": {
        const payload = { name: args.name, content: args.content };
        if (args.channel) payload.channel = args.channel;
        const result = await apiRequest("POST", "/api/files", payload);
        return { content: [{ type: "text", text: `File uploaded: ${result.file_id}\nName: ${result.file_name}\nSize: ${result.file_size} bytes\nMIME: ${result.mime_type}\nSHA256: ${result.sha256}` }] };
      }

      case "download_file": {
        // First get metadata
        const meta = await apiRequest("GET", `/api/files/${args.file_id}/meta`);
        if (meta.error) {
          return { content: [{ type: "text", text: `Error: ${meta.error}` }], isError: true };
        }
        // Download raw file and convert to base64
        const dlUrl = `${BASE_URL}/api/files/${args.file_id}`;
        const dlRes = await fetch(dlUrl, {
          headers: { Authorization: `Bearer ${API_KEY}` },
        });
        if (!dlRes.ok) {
          const errText = await dlRes.text().catch(() => "");
          return { content: [{ type: "text", text: `Download failed: ${dlRes.status} ${errText}` }], isError: true };
        }
        const arrayBuf = await dlRes.arrayBuffer();
        const base64Content = Buffer.from(arrayBuf).toString('base64');
        return { content: [{ type: "text", text: `File: ${meta.original_name}\nSize: ${meta.size} bytes\nMIME: ${meta.mime_type}\nSHA256: ${meta.sha256}\nUploaded by: ${meta.uploaded_by}\n\nContent (base64):\n${base64Content}` }] };
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    const toolName = name || 'unknown';
    sendNotification(
      `[系统] 工具调用失败: ${toolName} — ${err.message}`,
      "system",
      "",
      { isToolError: true, tool: toolName }
    );
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

// ---------------------------------------------------------------------------
// SSE — receive real-time messages from TeamMCP Server
// ---------------------------------------------------------------------------
let sseAbort = null;
let reconnectTimer = null;
const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 30000;
let currentDelay = RECONNECT_DELAY_MS;

function connectSSE() {
  if (sseAbort) sseAbort.abort();
  sseAbort = new AbortController();

  // Fetch command chain info on connect
  fetchMyReportsTo();

  const url = `${BASE_URL}/api/events`;
  log(`SSE connecting to ${url}`);

  fetch(url, {
    headers: { Authorization: `Bearer ${API_KEY}` },
    signal: sseAbort.signal,
  })
    .then(async (res) => {
      if (!res.ok) {
        throw new Error(`SSE HTTP ${res.status}`);
      }
      log("SSE connected");
      currentDelay = RECONNECT_DELAY_MS; // reset backoff

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop(); // keep incomplete line

        let currentData = "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            currentData += line.slice(6);
          } else if (line === "" && currentData) {
            // End of SSE event
            handleSSEEvent(currentData);
            currentData = "";
          }
        }
      }

      // Stream ended — reconnect
      log("SSE stream ended, reconnecting...");
      scheduleReconnect();
    })
    .catch((err) => {
      if (err.name === "AbortError") return;
      log(`SSE error: ${err.message}`);
      scheduleReconnect();
    });
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  log(`Reconnecting in ${currentDelay}ms...`);
  reconnectTimer = setTimeout(() => {
    connectSSE();
  }, currentDelay);
  currentDelay = Math.min(currentDelay * 1.5, MAX_RECONNECT_DELAY_MS);
}

// Command chain: fetch this agent's superior from DB at startup
let myReportsTo = null; // Will be set from /api/agents on SSE connect

async function fetchMyReportsTo() {
  try {
    const agents = await apiRequest("GET", "/api/agents");
    const me = agents.find(a => a.name === AGENT_NAME);
    myReportsTo = me?.reports_to || null;
  } catch {}
}

// Message injection filter: only inject messages that require Agent attention
// Reduces API calls by 80-90% by skipping irrelevant messages
function shouldInject(event) {
  // P0: Always inject
  if (event.type === 'message') {
    const isDm = (event.channel || '').startsWith('dm:');
    if (isDm) return true;                                          // DM — always relevant
    if (event.mentions && event.mentions.includes(AGENT_NAME)) return true; // @ mentioned
    if (event.from === 'System') return true;                       // System notifications (overdue, checkin)
    // Chairman messages: only inject for direct reports (reports_to = Chairman)
    if (event.from === 'Chairman' && myReportsTo === 'Chairman') return true;
    return false;                                                   // Group chat without mention — skip
  }
  if (event.type === 'approval_requested') return true;             // Approval requests
  // Everything else: don't inject (status, agent-output, agent-error, reactions, pins, etc.)
  return false;
}

function handleSSEEvent(data) {
  let event;
  try {
    event = JSON.parse(data);
  } catch {
    log(`SSE parse error: ${data}`);
    return;
  }

  if (event.type === "message") {
    // Apply injection filter
    if (!shouldInject(event)) {
      return; // Skip — Agent will see this via check-inbox when needed
    }

    const channelId = event.channel || "unknown";
    const from = event.from || "unknown";
    const content = event.content || "";
    const isDm = channelId.startsWith("dm:");
    const source = isDm ? "dm" : "group";

    // Format like the working team-sync-watcher: raw text content, meta for routing
    const msgText = `---\n**${from}** (${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })})\n\n${content}\n`;

    // Pass through metadata fields (thread_id, user, context_token, etc.)
    const extraMeta = {};
    if (event.metadata && typeof event.metadata === 'object') {
      for (const [k, v] of Object.entries(event.metadata)) {
        if (typeof v === 'string') extraMeta[k] = v;
      }
    }
    sendNotification(msgText, source, channelId, extraMeta);
    // Send delivery ack
    if (event.id) {
      apiRequest("POST", `/api/messages/${event.id}/ack`).catch(() => {});
    }
  } else if (event.type === "status") {
    // Status changes: only inject when agent comes online (useful context)
    // Skip offline notifications to reduce noise
    if (event.status === 'online') {
      const msgText = `${event.agent} is now ${event.status}`;
      sendNotification(msgText, "status", "");
    }
  } else if (event.type === "approval_resolved") {
    handleApprovalResolved(event);
  }
  // Ignore agent-output, agent-error, reactions, pins, etc.
}

function escapeXml(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Permission integration: CC permission_request → TeamMCP approval → CC permission
// ---------------------------------------------------------------------------

// requestId → { approvalId, toolName, description, inputPreview, createdAt }
const pendingPermissions = new Map();
// approvalId → { requestId }
const pendingApprovals = new Map();

const PERMISSION_REQUEST_METHOD = "notifications/claude/channel/permission_request";
const PERMISSION_RESPONSE_METHOD = "notifications/claude/channel/permission";

// Track next field index for rotating permission request fields
// Each update to an approval_required field triggers a new approval
let permissionFieldCounter = 0;

async function handlePermissionRequest(params) {
  const { request_id, tool_name, description, input_preview } = params;

  if (!request_id || !tool_name) {
    log(`Permission request missing required fields: ${JSON.stringify(params)}`);
    return;
  }

  // Use rotating field names so each permission request creates/updates its own field
  // Field with approval_required=true: first creation doesn't trigger approval,
  // subsequent updates DO trigger approval
  const fieldIndex = permissionFieldCounter++;
  const fieldName = `perm_${fieldIndex}`;

  pendingPermissions.set(request_id, {
    fieldName,
    toolName: tool_name,
    description: description || '',
    inputPreview: input_preview || '',
    createdAt: Date.now(),
  });

  log(`Permission request: ${tool_name} (${request_id}) → field ${fieldName}`);

  try {
    const result = await apiRequest('POST', '/api/state', {
      project_id: 'claude-code-permissions',
      field: fieldName,
      value: {
        tool_name,
        description: description || '',
        input_preview: input_preview || '',
        cc_request_id: request_id,
      },
      approval_required: true,
    });

    if (result.pending_approval) {
      // Approval was triggered (update to existing approval_required field)
      const approvalId = result.approval_id;
      pendingPermissions.get(request_id).approvalId = approvalId;
      pendingApprovals.set(approvalId, { requestId: request_id });
      log(`Approval created for ${tool_name} (${request_id}) → ${approvalId}`);
    } else if (result.created) {
      // First creation — no approval triggered yet. This is the field setup.
      // Send the actual approval by updating the field again.
      log(`Field created for ${tool_name} (${request_id}), triggering approval via update...`);
      const updateResult = await apiRequest('POST', '/api/state', {
        project_id: 'claude-code-permissions',
        field: fieldName,
        value: {
          tool_name,
          description: description || '',
          input_preview: input_preview || '',
          cc_request_id: request_id,
        },
        approval_required: true,
      });
      if (updateResult.pending_approval) {
        const approvalId = updateResult.approval_id;
        pendingPermissions.get(request_id).approvalId = approvalId;
        pendingApprovals.set(approvalId, { requestId: request_id });
        log(`Approval created (update) for ${tool_name} (${request_id}) → ${approvalId}`);
      } else {
        log(`Unexpected: update did not trigger approval: ${JSON.stringify(updateResult)}`);
        sendPermissionResponse(request_id, 'deny');
        cleanupPermission(request_id);
      }
    } else {
      log(`Unexpected setState result: ${JSON.stringify(result)}`);
      sendPermissionResponse(request_id, 'deny');
      cleanupPermission(request_id);
    }
  } catch (err) {
    log(`Permission forward error: ${err.message}`);
    sendPermissionResponse(request_id, 'deny');
    cleanupPermission(request_id);
  }
}

function handleApprovalResolved(event) {
  const { approval_id, approved } = event;
  if (!approval_id) return;

  const mapping = pendingApprovals.get(approval_id);
  if (!mapping) return; // Not our approval — ignore

  const { requestId } = mapping;
  const decision = approved ? 'allow' : 'deny';

  log(`Permission resolved: ${approval_id} → ${requestId} → ${decision}`);
  sendPermissionResponse(requestId, decision);
  cleanupPermission(requestId);
}

async function sendPermissionResponse(requestId, behavior) {
  try {
    await server.notification({
      method: PERMISSION_RESPONSE_METHOD,
      params: {
        request_id: requestId,
        behavior,
      },
    });
    log(`Permission response sent: ${requestId} → ${behavior}`);
  } catch (err) {
    log(`Permission response error: ${err.message}`);
  }
}

function cleanupPermission(requestId) {
  const mapping = pendingPermissions.get(requestId);
  if (mapping) {
    pendingApprovals.delete(mapping.approvalId);
  }
  pendingPermissions.delete(requestId);
}

// Timeout: deny pending permissions after 30 minutes
const PERMISSION_TIMEOUT_MS = 30 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [requestId, info] of pendingPermissions) {
    if (now - info.createdAt > PERMISSION_TIMEOUT_MS) {
      log(`Permission timeout: ${requestId} (${info.toolName})`);
      sendPermissionResponse(requestId, 'deny');
      // Notify channel about the timeout
      sendNotification(
        `⚠️ 审批超时已自动拒绝：${info.toolName}\n${info.description || ''}`.trim(),
        "system", ""
      );
      cleanupPermission(requestId);
    }
  }
}, 60000);

async function sendNotification(text, source = "group", channelId = "", extraMeta = {}) {
  try {
    await server.notification({
      method: "notifications/claude/channel",
      params: {
        content: text,
        meta: {
          source,
          channel: channelId,
          ...extraMeta,
        },
      },
    });
    log(`Notification sent OK (${source})`);
  } catch (err) {
    log(`Notification send failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Logging (stderr so it doesn't interfere with stdio MCP transport)
// ---------------------------------------------------------------------------
function log(msg) {
  process.stderr.write(`[teammcp-channel] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  log(`Starting TeamMCP Channel for agent "${AGENT_NAME}"`);
  log(`Server: ${BASE_URL}`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP server connected via stdio");

  // Register handler for Claude Code permission requests
  const PermissionRequestNotificationSchema = z.object({
    method: z.literal(PERMISSION_REQUEST_METHOD),
    params: z.object({
      request_id: z.string(),
      tool_name: z.string(),
      description: z.string().optional(),
      input_preview: z.string().optional(),
    }),
  });
  server.setNotificationHandler(PermissionRequestNotificationSchema, (notification) => {
    handlePermissionRequest(notification.params);
  });
  log("Permission request handler registered");

  // Start SSE connection for real-time messages
  connectSSE();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
