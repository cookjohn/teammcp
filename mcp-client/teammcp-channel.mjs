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
      experimental: { "claude/channel": {} },
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
        id: { type: "string", description: "定时消息 ID" },
      },
      required: ["id"],
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
        const result = await apiRequest("DELETE", `/api/schedules/${args.id}`);
        return { content: [{ type: "text", text: `Schedule ${result.id} deleted` }] };
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
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

function handleSSEEvent(data) {
  let event;
  try {
    event = JSON.parse(data);
  } catch {
    log(`SSE parse error: ${data}`);
    return;
  }

  if (event.type === "message") {
    const channelId = event.channel || "unknown";
    const from = event.from || "unknown";
    const content = event.content || "";
    const isDm = channelId.startsWith("dm:");
    const source = isDm ? "dm" : "group";

    // Format like the working team-sync-watcher: raw text content, meta for routing
    const msgText = `---\n**${from}** (${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })})\n\n${content}\n`;

    sendNotification(msgText, source, channelId);
  } else if (event.type === "status") {
    const msgText = `${event.agent} is now ${event.status}`;
    sendNotification(msgText, "status", "");
  }
  // Ignore typing, heartbeat, etc.
}

function escapeXml(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function sendNotification(text, source = "group", channelId = "") {
  try {
    await server.notification({
      method: "notifications/claude/channel",
      params: {
        content: text,
        meta: {
          source,
          channel: channelId,
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

  // Start SSE connection for real-time messages
  connectSSE();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
