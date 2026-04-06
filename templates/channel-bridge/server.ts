#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const BASE_URL = (process.env.TEAMMCP_URL || "http://localhost:3100").replace(/\/+$/, "");
const API_KEY = process.env.TEAMMCP_KEY || "";
const AGENT_NAME = process.env.AGENT_NAME || "Agent";

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const opts: RequestInit = { method, headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, opts);
  if (!res.ok) { const t = await res.text().catch(() => ""); throw new Error(`API ${method} ${path} -> ${res.status}: ${t}`); }
  return res.json();
}

function ts(v?: string) { if (!v) return ""; return new Date(v).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }); }

function formatInbox(snap: any): string {
  const p: string[] = [];
  if (snap.channels?.length) {
    p.push(`Unread channels: ${snap.channel_count}, unread messages: ${snap.total_unread}`);
    for (const ch of snap.channels) {
      p.push(`#${ch.channel} [${ch.channel_type}] unread=${ch.unread_count} ack_id=${ch.ack_id}`);
      if (ch.delivery_mode === "messages") { for (const m of ch.messages) p.push(`- [${ts(m.timestamp)}] ${m.from}: ${m.content}`); }
      else { if (ch.mentions?.length) { p.push("  mentions:"); for (const m of ch.mentions) p.push(`  - [${ts(m.timestamp)}] ${m.from}: ${m.content}`); } if (ch.topic_summary) p.push(`  summary: ${ch.topic_summary}`); }
    }
  }
  if (snap.state_changes?.length) { p.push("", `State changes: ${snap.state_changes.length}`); for (const c of snap.state_changes) p.push(`- ${c.project_id}.${c.field}: ${c.old_value} -> ${c.new_value} (${c.changed_by}, ${ts(c.timestamp)})`); }
  if (!p.length) return "(inbox is clear)";
  p.push("", "Use ack_inbox with the ack_id values above after you have handled the batch.");
  return p.join("\n");
}

function txt(text: string) { return { content: [{ type: "text" as const, text }] }; }
function err(text: string) { return { content: [{ type: "text" as const, text }], isError: true }; }

const server = new Server(
  { name: "fakechat", version: "0.1.0" },
  { capabilities: { tools: {}, experimental: { "claude/channel": {}, "claude/channel/permission": {} } }, instructions: `You are ${AGENT_NAME}. You receive messages via <channel> events.\nRespond according to your CLAUDE.md role definition.\nReply in group: send_message | Reply in DM: send_dm | Check online: get_agents | Check history: get_history` },
);

const TOOLS = [
  { name: "send_message", description: "Send a message to a channel", inputSchema: { type: "object" as const, properties: { channel: { type: "string" as const, description: "Channel ID" }, content: { type: "string" as const, description: "Message content" }, mentions: { type: "array" as const, items: { type: "string" as const }, description: "@ mentions" }, replyTo: { type: "string" as const, description: "Reply to message ID" } }, required: ["channel", "content"] } },
  { name: "send_dm", description: "Send a direct message", inputSchema: { type: "object" as const, properties: { recipient: { type: "string" as const, description: "Recipient name" }, content: { type: "string" as const, description: "Message content" }, replyTo: { type: "string" as const, description: "Reply to message ID" } }, required: ["recipient", "content"] } },
  { name: "get_history", description: "View channel message history", inputSchema: { type: "object" as const, properties: { channel: { type: "string" as const, description: "Channel ID" }, limit: { type: "number" as const, description: "Limit (default 50)" } }, required: ["channel"] } },
  { name: "get_agents", description: "View all agents and online status", inputSchema: { type: "object" as const, properties: {} } },
  { name: "get_channels", description: "View channel list and unread counts", inputSchema: { type: "object" as const, properties: {} } },
  { name: "create_channel", description: "Create a new channel", inputSchema: { type: "object" as const, properties: { id: { type: "string" as const, description: "Channel ID" }, name: { type: "string" as const, description: "Display name" }, type: { type: "string" as const, enum: ["group", "topic"], description: "Channel type" }, members: { type: "array" as const, items: { type: "string" as const }, description: "Members" } }, required: ["id", "name", "type"] } },
  { name: "edit_message", description: "Edit a sent message", inputSchema: { type: "object" as const, properties: { id: { type: "string" as const, description: "Message ID" }, content: { type: "string" as const, description: "New content" } }, required: ["id", "content"] } },
  { name: "delete_message", description: "Delete a sent message", inputSchema: { type: "object" as const, properties: { id: { type: "string" as const, description: "Message ID" } }, required: ["id"] } },
  { name: "search_messages", description: "Search message history", inputSchema: { type: "object" as const, properties: { query: { type: "string" as const, description: "Search query" }, channel: { type: "string" as const, description: "Channel filter" }, from: { type: "string" as const, description: "Sender filter" }, limit: { type: "number" as const, description: "Max results" } }, required: ["query"] } },
  { name: "start_agent", description: "Start an agent (CEO/HR)", inputSchema: { type: "object" as const, properties: { name: { type: "string" as const, description: "Agent name" } }, required: ["name"] } },
  { name: "stop_agent", description: "Stop an agent (CEO/HR)", inputSchema: { type: "object" as const, properties: { name: { type: "string" as const, description: "Agent name" } }, required: ["name"] } },
  { name: "screenshot_agent", description: "Screenshot agent terminal (CEO/HR)", inputSchema: { type: "object" as const, properties: { name: { type: "string" as const, description: "Agent name" } }, required: ["name"] } },
  { name: "send_keys_to_agent", description: "Send keys to agent terminal (CEO/HR)", inputSchema: { type: "object" as const, properties: { name: { type: "string" as const, description: "Agent name" }, keys: { type: "string" as const, description: "Keys to send" } }, required: ["name", "keys"] } },
  { name: "pin_task", description: "Convert message to task", inputSchema: { type: "object" as const, properties: { message_id: { type: "string" as const, description: "Message ID" }, assignee: { type: "string" as const }, priority: { type: "string" as const, enum: ["urgent","high","medium","low"] }, due_date: { type: "string" as const }, title: { type: "string" as const } }, required: ["message_id"] } },
  { name: "create_task", description: "Create a task directly", inputSchema: { type: "object" as const, properties: { title: { type: "string" as const, description: "Title" }, assignee: { type: "string" as const }, priority: { type: "string" as const, enum: ["urgent","high","medium","low"] }, parent_id: { type: "string" as const }, due_date: { type: "string" as const }, labels: { type: "array" as const, items: { type: "string" as const } }, task_type: { type: "string" as const, enum: ["task","milestone"] }, checkin_interval: { type: "string" as const, enum: ["daily","weekly","biweekly"] }, related_state: { type: "string" as const }, related_state_project: { type: "string" as const }, target_value: { type: "string" as const }, files: { type: "array" as const, items: { type: "string" as const } } }, required: ["title"] } },
  { name: "list_tasks", description: "Query task list", inputSchema: { type: "object" as const, properties: { status: { type: "string" as const }, assignee: { type: "string" as const }, creator: { type: "string" as const }, priority: { type: "string" as const }, limit: { type: "number" as const } } } },
  { name: "update_task", description: "Update task", inputSchema: { type: "object" as const, properties: { task_id: { type: "string" as const, description: "Task ID" }, status: { type: "string" as const, enum: ["todo","doing","done"] }, assignee: { type: "string" as const }, priority: { type: "string" as const, enum: ["urgent","high","medium","low"] }, title: { type: "string" as const }, result: { type: "string" as const }, due_date: { type: "string" as const }, labels: { type: "array" as const, items: { type: "string" as const } }, progress: { type: "number" as const } }, required: ["task_id"] } },
  { name: "done_task", description: "Mark task done", inputSchema: { type: "object" as const, properties: { task_id: { type: "string" as const }, result: { type: "string" as const } }, required: ["task_id"] } },
  { name: "check_knowledge_gaps", description: "Check knowledge gaps", inputSchema: { type: "object" as const, properties: { project_id: { type: "string" as const }, agent_id: { type: "string" as const } }, required: ["project_id"] } },
  { name: "acknowledge_knowledge_gaps", description: "Acknowledge gaps", inputSchema: { type: "object" as const, properties: { project_id: { type: "string" as const }, fields: { type: "array" as const, items: { type: "string" as const } }, agent_id: { type: "string" as const } }, required: ["project_id", "fields"] } },
  { name: "get_agent_profile", description: "Get agent profile", inputSchema: { type: "object" as const, properties: { agent_id: { type: "string" as const } } } },
  { name: "update_agent_profile", description: "Update agent profile", inputSchema: { type: "object" as const, properties: { agent_id: { type: "string" as const }, relevant_fields: { type: "array" as const, items: { type: "string" as const } }, critical_fields: { type: "array" as const, items: { type: "string" as const } }, participating_projects: { type: "array" as const, items: { type: "string" as const } }, participating_channels: { type: "array" as const, items: { type: "string" as const } } } } },
  { name: "get_inbox", description: "Pull unread messages", inputSchema: { type: "object" as const, properties: { detail_limit: { type: "number" as const }, summary_threshold: { type: "number" as const } } } },
  { name: "ack_inbox", description: "Advance read markers", inputSchema: { type: "object" as const, properties: { items: { type: "array" as const, items: { type: "object" as const, properties: { channel: { type: "string" as const }, ack_id: { type: "string" as const } }, required: ["channel", "ack_id"] } } } } },
  { name: "schedule_message", description: "Schedule recurring message", inputSchema: { type: "object" as const, properties: { channel: { type: "string" as const }, content: { type: "string" as const }, cron_expr: { type: "string" as const } }, required: ["channel", "content", "cron_expr"] } },
  { name: "list_schedules", description: "View scheduled messages", inputSchema: { type: "object" as const, properties: {} } },
  { name: "cancel_schedule", description: "Cancel schedule", inputSchema: { type: "object" as const, properties: { schedule_id: { type: "string" as const } }, required: ["schedule_id"] } },
  { name: "request_approval", description: "Submit state change request", inputSchema: { type: "object" as const, properties: { project_id: { type: "string" as const }, field: { type: "string" as const }, value: { type: "string" as const }, reason: { type: "string" as const }, owner: { type: "string" as const }, approval_required: { type: "boolean" as const } }, required: ["project_id", "field", "value"] } },
  { name: "get_pending_approvals", description: "View pending approvals", inputSchema: { type: "object" as const, properties: {} } },
  { name: "resolve_approval", description: "Resolve approval", inputSchema: { type: "object" as const, properties: { approval_id: { type: "string" as const }, approved: { type: "boolean" as const }, comment: { type: "string" as const } }, required: ["approval_id", "approved"] } },
  { name: "get_changelog", description: "Query changelog (Audit)", inputSchema: { type: "object" as const, properties: { project_id: { type: "string" as const }, field: { type: "string" as const }, changed_by: { type: "string" as const }, source: { type: "string" as const }, from: { type: "string" as const }, to: { type: "string" as const }, limit: { type: "number" as const } } } },
  { name: "generate_audit_report", description: "Generate audit report (Audit)", inputSchema: { type: "object" as const, properties: { project_id: { type: "string" as const }, report_type: { type: "string" as const, enum: ["compliance","efficiency","anomaly"] } }, required: ["project_id", "report_type"] } },
  { name: "get_audit_reports", description: "View audit reports (Audit)", inputSchema: { type: "object" as const, properties: { project_id: { type: "string" as const }, report_type: { type: "string" as const }, limit: { type: "number" as const } } } },
  { name: "get_public_reports", description: "View public reports", inputSchema: { type: "object" as const, properties: { project_id: { type: "string" as const }, report_type: { type: "string" as const }, limit: { type: "number" as const } } } },
  { name: "get_state", description: "Read shared state", inputSchema: { type: "object" as const, properties: { project_id: { type: "string" as const }, field: { type: "string" as const } }, required: ["project_id"] } },
  { name: "set_state", description: "Write shared state", inputSchema: { type: "object" as const, properties: { project_id: { type: "string" as const }, field: { type: "string" as const }, value: { type: "string" as const }, reason: { type: "string" as const }, owner: { type: "string" as const }, approval_required: { type: "boolean" as const }, expected_version: { type: "number" as const } }, required: ["project_id", "field", "value"] } },
  { name: "get_state_history", description: "View state history", inputSchema: { type: "object" as const, properties: { project_id: { type: "string" as const }, field: { type: "string" as const }, limit: { type: "number" as const } }, required: ["project_id"] } },
  { name: "subscribe_state", description: "Subscribe to state changes", inputSchema: { type: "object" as const, properties: { project_id: { type: "string" as const }, fields: { type: "array" as const, items: { type: "string" as const } } }, required: ["project_id", "fields"] } },
  { name: "add_reaction", description: "Add emoji reaction", inputSchema: { type: "object" as const, properties: { message_id: { type: "string" as const }, emoji: { type: "string" as const } }, required: ["message_id", "emoji"] } },
  { name: "remove_reaction", description: "Remove emoji reaction", inputSchema: { type: "object" as const, properties: { message_id: { type: "string" as const }, emoji: { type: "string" as const } }, required: ["message_id", "emoji"] } },
  { name: "pin_message", description: "Pin a message", inputSchema: { type: "object" as const, properties: { message_id: { type: "string" as const } }, required: ["message_id"] } },
  { name: "unpin_message", description: "Unpin a message", inputSchema: { type: "object" as const, properties: { message_id: { type: "string" as const } }, required: ["message_id"] } },
  { name: "get_pinned_messages", description: "Get pinned messages", inputSchema: { type: "object" as const, properties: { channel_id: { type: "string" as const } }, required: ["channel_id"] } },
  { name: "upload_file", description: "Upload file (base64)", inputSchema: { type: "object" as const, properties: { name: { type: "string" as const }, content: { type: "string" as const }, channel: { type: "string" as const } }, required: ["name", "content"] } },
  { name: "download_file", description: "Download file", inputSchema: { type: "object" as const, properties: { file_id: { type: "string" as const } }, required: ["file_id"] } },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: a } = request.params;
  const args: any = a || {};
  try {
    switch (name) {
      case "send_message": { const body: any = { channel: args.channel, content: args.content, mentions: args.mentions || [] }; if (args.replyTo) body.replyTo = args.replyTo; const r = await api("POST", "/api/send", body); return txt(`Message sent (id: ${r.id})`); }
      case "send_dm": { const body: any = { channel: `dm:${args.recipient}`, content: args.content }; if (args.replyTo) body.replyTo = args.replyTo; const r = await api("POST", "/api/send", body); return txt(`DM sent to ${args.recipient} (id: ${r.id})`); }
      case "get_history": { const p = new URLSearchParams({ channel: args.channel }); if (args.limit) p.set("limit", String(args.limit)); const r = await api("GET", `/api/history?${p}`); return txt(r.messages.map((m: any) => `[${m.created_at}] ${m.from_agent}: ${m.content}`).join("\n") || "(no messages)"); }
      case "get_agents": { const r = await api("GET", "/api/agents"); return txt(r.map((a: any) => `${a.name} (${a.role || "?"}) - ${a.status}${a.last_seen ? ` [${a.last_seen}]` : ""}`).join("\n") || "(no agents)"); }
      case "get_channels": { const r = await api("GET", "/api/channels"); return txt(r.map((c: any) => `#${c.id} [${c.type}]${c.unread ? ` (${c.unread} unread)` : ""}`).join("\n") || "(no channels)"); }
      case "create_channel": { await api("POST", "/api/channels", { id: args.id, name: args.name, type: args.type, members: args.members || [] }); return txt(`Channel #${args.id} created`); }
      case "edit_message": { const r = await api("PUT", `/api/messages/${args.id}`, { content: args.content }); return txt(`Message ${r.id} edited (at ${r.edited_at})`); }
      case "delete_message": { const r = await api("DELETE", `/api/messages/${args.id}`); return txt(`Message ${r.id} deleted`); }
      case "search_messages": { const p = new URLSearchParams({ q: args.query }); if (args.channel) p.set("channel", args.channel); if (args.from) p.set("from", args.from); if (args.limit) p.set("limit", String(args.limit)); const r = await api("GET", `/api/search?${p}`); const fmt = r.results.map((m: any) => `[${m.created_at}] #${m.channel_id} ${m.from_agent}: ${m.content}`).join("\n"); return txt(fmt ? `Found ${r.total} results:\n\n${fmt}` : `No results for "${r.query}"`); }
      case "start_agent": { const r = await api("POST", `/api/agents/${args.name}/start`); return txt(`Agent ${r.name} starting (PID: ${r.pid})`); }
      case "stop_agent": { const r = await api("POST", `/api/agents/${args.name}/stop`); return txt(`Agent ${r.name} stopped`); }
      case "screenshot_agent": { const r = await api("POST", `/api/agents/${args.name}/screenshot`); return { content: [{ type: "text" as const, text: `Screenshot: ${r.screenshot}` }, { type: "resource" as const, resource: { uri: `file:///${r.screenshot.replace(/\\/g, "/")}`, mimeType: "image/png", text: `Screenshot of ${args.name}` } }] }; }
      case "send_keys_to_agent": { const r = await api("POST", `/api/agents/${args.name}/sendkeys`, { keys: args.keys }); return txt(`Sent keys "${r.sent}" to ${r.name}`); }
      case "pin_task": { const body: any = { source_msg: args.message_id }; for (const f of ["assignee","priority","due_date","title"]) if (args[f]) body[f] = args[f]; const r = await api("POST", "/api/tasks", body); const t = r.task; return txt(`Task: ${t.id} - ${t.title} [${t.status}]${t.assignee ? ` -> ${t.assignee}` : ""}`); }
      case "create_task": { const body: any = { title: args.title }; for (const f of ["assignee","priority","parent_id","due_date","labels","task_type","checkin_interval","related_state","related_state_project","target_value","files"]) if (args[f] !== undefined) body[f] = args[f]; const r = await api("POST", "/api/tasks", body); const t = r.task; return txt(`Task: ${t.id} - ${t.title} [${t.status}]${t.assignee ? ` -> ${t.assignee}` : ""}`); }
      case "list_tasks": { const p = new URLSearchParams(); p.set("status", args.status || "todo,doing"); for (const f of ["assignee","creator","priority"]) if (args[f]) p.set(f, args[f]); if (args.limit) p.set("limit", String(args.limit)); const r = await api("GET", `/api/tasks?${p}`); if (!r.tasks?.length) return txt("(no tasks)"); return txt(`${r.total} task(s):\n\n` + r.tasks.map((t: any) => `[${t.status.toUpperCase()}] ${t.id} [${t.priority}] ${t.title}${t.assignee ? ` -> ${t.assignee}` : ""}`).join("\n")); }
      case "update_task": { const body: any = {}; for (const f of ["status","assignee","priority","title","result","due_date","labels","progress"]) if (args[f] !== undefined) body[f] = args[f]; const r = await api("PATCH", `/api/tasks/${args.task_id}`, body); return txt(`Task ${r.task.id} updated [${r.task.status}]`); }
      case "done_task": { const r = await api("PATCH", `/api/tasks/${args.task_id}`, { status: "done", result: args.result || "" }); return txt(`Task ${r.task.id} done${args.result ? ` - ${args.result.slice(0,80)}` : ""}`); }
      case "check_knowledge_gaps": { const p = new URLSearchParams({ project_id: args.project_id }); if (args.agent_id) p.set("agent_id", args.agent_id); const r = await api("GET", `/api/state/knowledge-gaps?${p}`); if (r.error === "no_profile") return txt("No profile. update_agent_profile first."); if (!r.has_gaps) return txt(`No gaps for ${r.agent_id} in ${r.project_id}.`); return txt(r.gaps.map((g: any) => `- ${g.field}: v${g.your_version}->v${g.current_version} (${g.changes_missed} missed) ${g.summary}`).join("\n")); }
      case "acknowledge_knowledge_gaps": { const r = await api("POST", "/api/state/knowledge-gaps/acknowledge", { project_id: args.project_id, fields: args.fields }); if (r.error) return err(`Error: ${r.error}`); return txt(`Acknowledged ${args.fields.length} fields`); }
      case "get_agent_profile": { const p = new URLSearchParams(); if (args.agent_id) p.set("agent_id", args.agent_id); return txt(JSON.stringify(await api("GET", `/api/state/agent-profile?${p}`), null, 2)); }
      case "update_agent_profile": { const body: any = {}; for (const f of ["agent_id","relevant_fields","critical_fields","participating_projects","participating_channels"]) if (args[f] !== undefined) body[f] = args[f]; const r = await api("POST", "/api/state/agent-profile", body); if (r.error) return err(`Error: ${r.error}`); return txt(`Profile updated for ${r.agent_id}`); }
      case "get_inbox": { const p = new URLSearchParams(); if (args.detail_limit) p.set("detail_limit", String(args.detail_limit)); if (args.summary_threshold) p.set("summary_threshold", String(args.summary_threshold)); const s = p.toString() ? `?${p}` : ""; return txt(formatInbox(await api("GET", `/api/inbox${s}`))); }
      case "ack_inbox": { const r = await api("POST", "/api/inbox/ack", { items: args.items || [] }); return txt(`Acknowledged ${r.acknowledged} item(s)`); }
      case "schedule_message": { const r = await api("POST", "/api/schedules", { channel: args.channel, content: args.content, cron_expr: args.cron_expr }); return txt(`Schedule ${r.schedule.id} created, next: ${r.schedule.next_run}`); }
      case "list_schedules": { const r = await api("GET", "/api/schedules"); if (!r.schedules?.length) return txt("(no schedules)"); return txt(r.schedules.map((s: any) => `${s.id} [${s.enabled?"ON":"OFF"}] #${s.channel} cron=${s.cron_expr} next=${s.next_run}`).join("\n")); }
      case "cancel_schedule": { const r = await api("DELETE", `/api/schedules/${args.schedule_id}`); return txt(`Schedule ${r.id} deleted`); }
      case "request_approval": { const body: any = { project_id: args.project_id, field: args.field, value: args.value }; for (const f of ["reason","owner"]) if (args[f]) body[f] = args[f]; if (args.approval_required !== undefined) body.approval_required = args.approval_required; const r = await api("POST", "/api/state", body); if (r.error) return err(`Error: ${r.error}`); if (r.requires_knowledge_check) return txt("Knowledge gaps - check first."); if (r.pending_approval || r.approval) return txt(`Approval created: ${r.approval_id || r.approval?.approval_id || "?"}`); return txt(`State set: ${args.project_id}.${args.field} = ${args.value}`); }
      case "get_pending_approvals": { const r = await api("GET", "/api/state/approvals"); const arr = r.approvals || r; if (!Array.isArray(arr) || !arr.length) return txt("(no pending approvals)"); return txt(arr.map((a: any) => `${a.approval_id} | ${a.project_id}.${a.field} -> ${a.proposed_value} | by ${a.proposed_by}`).join("\n")); }
      case "resolve_approval": { const body: any = { approved: args.approved }; if (args.comment) body.comment = args.comment; const r = await api("POST", `/api/state/approvals/${args.approval_id}/resolve`, body); if (r.error) return err(`Error: ${r.error}`); return txt(`${args.approved ? "Approved" : "Rejected"} ${args.approval_id}`); }
      case "get_changelog": { const p = new URLSearchParams(); for (const f of ["project_id","field","changed_by","source","from","to"]) if (args[f]) p.set(f, args[f]); if (args.limit) p.set("limit", String(args.limit)); const s = p.toString() ? `?${p}` : ""; const r = await api("GET", `/api/audit/changelog${s}`); const e = r.entries || r; if (!Array.isArray(e) || !e.length) return txt("(no entries)"); return txt(e.map((x: any) => `[${ts(x.timestamp)}] ${x.project_id}.${x.field}: ${x.old_value}->${x.new_value} (${x.changed_by})`).join("\n")); }
      case "generate_audit_report": { const r = await api("POST", "/api/audit/reports", { project_id: args.project_id, report_type: args.report_type }); if (r.error) return err(`Error: ${r.error}`); return txt(`Report: ${(r.report||r).id || "?"}, type: ${args.report_type}`); }
      case "get_audit_reports": { const p = new URLSearchParams(); if (args.project_id) p.set("project_id", args.project_id); if (args.report_type) p.set("report_type", args.report_type); if (args.limit) p.set("limit", String(args.limit)); const s = p.toString() ? `?${p}` : ""; const r = await api("GET", `/api/audit/reports${s}`); const rpts = r.reports || r; if (!Array.isArray(rpts) || !rpts.length) return txt("(no reports)"); return txt(rpts.map((x: any) => `${x.id} | ${x.report_type} | ${x.project_id} | ${ts(x.created_at)}`).join("\n")); }
      case "get_public_reports": { const p = new URLSearchParams(); if (args.project_id) p.set("project_id", args.project_id); if (args.report_type) p.set("report_type", args.report_type); if (args.limit) p.set("limit", String(args.limit)); const s = p.toString() ? `?${p}` : ""; const r = await api("GET", `/api/reports/public${s}`); const rpts = r.reports || r; if (!Array.isArray(rpts) || !rpts.length) return txt("(no reports)"); return txt(rpts.map((x: any) => `${x.id} | ${x.report_type} | ${x.project_id} | ${x.summary || ""}`).join("\n")); }
      case "get_state": { const p = new URLSearchParams({ project_id: args.project_id }); if (args.field) p.set("field", args.field); const r = await api("GET", `/api/state?${p}`); if (args.field) { const s = r.state || r; return txt(`${args.project_id}.${args.field} = ${s.value !== undefined ? s.value : JSON.stringify(s)} (v${s.version || "?"})`); } const fields = r.items || (Array.isArray(r) ? r : []); if (!fields.length) return txt(`(no state for ${args.project_id})`); return txt(fields.map((f: any) => `${f.field}: ${f.value} (v${f.version||"?"}, owner: ${f.owner||"-"})`).join("\n")); }
      case "set_state": { const body: any = { project_id: args.project_id, field: args.field, value: args.value }; for (const f of ["reason","owner"]) if (args[f]) body[f] = args[f]; if (args.approval_required !== undefined) body.approval_required = args.approval_required; if (args.expected_version !== undefined) body.expected_version = args.expected_version; const r = await api("POST", "/api/state", body); if (r.error) return err(`Error: ${r.error}`); if (r.requires_knowledge_check) return txt("Knowledge gaps - check first."); if (r.pending_approval || r.approval) return txt(`Approval: ${r.approval_id || r.approval?.approval_id || "?"}`); return txt(`State: ${args.project_id}.${args.field} = ${args.value}`); }
      case "get_state_history": { const p = new URLSearchParams({ project_id: args.project_id }); if (args.field) p.set("field", args.field); if (args.limit) p.set("limit", String(args.limit)); const r = await api("GET", `/api/state/history?${p}`); const e = r.history || r.entries || r; if (!Array.isArray(e) || !e.length) return txt("(no history)"); return txt(e.map((x: any) => `[${ts(x.timestamp)}] ${x.field}: ${x.old_value}->${x.new_value} (${x.changed_by})`).join("\n")); }
      case "subscribe_state": { const r = await api("POST", "/api/state/subscribe", { project_id: args.project_id, fields: args.fields }); if (r.error) return err(`Error: ${r.error}`); return txt(`Subscribed to ${args.fields.length} field(s) in ${args.project_id}`); }
      case "add_reaction": { await api("POST", `/api/messages/${args.message_id}/reactions`, { emoji: args.emoji }); return txt(`Reaction ${args.emoji} added to ${args.message_id}`); }
      case "remove_reaction": { await api("DELETE", `/api/messages/${args.message_id}/reactions/${encodeURIComponent(args.emoji)}`); return txt(`Reaction removed`); }
      case "pin_message": { await api("POST", `/api/messages/${args.message_id}/pin`); return txt(`Pinned ${args.message_id}`); }
      case "unpin_message": { await api("DELETE", `/api/messages/${args.message_id}/pin`); return txt(`Unpinned ${args.message_id}`); }
      case "get_pinned_messages": { const r = await api("GET", `/api/channels/${args.channel_id}/pins`); const pins = r.pins || r; if (!Array.isArray(pins) || !pins.length) return txt("(no pins)"); return txt(pins.map((p: any) => `${p.id} | ${p.from_agent}: ${p.content}`).join("\n")); }
      case "upload_file": { const payload: any = { name: args.name, content: args.content }; if (args.channel) payload.channel = args.channel; const r = await api("POST", "/api/files", payload); return txt(`Uploaded: ${r.file_id} ${r.file_name} (${r.file_size}b)`); }
      case "download_file": { const meta = await api("GET", `/api/files/${args.file_id}/meta`); if (meta.error) return err(`Error: ${meta.error}`); const dlRes = await fetch(`${BASE_URL}/api/files/${args.file_id}`, { headers: { Authorization: `Bearer ${API_KEY}` } }); if (!dlRes.ok) return err(`Download failed: ${dlRes.status}`); const b64 = Buffer.from(await dlRes.arrayBuffer()).toString("base64"); return txt(`File: ${meta.original_name} (${meta.size}b) MIME:${meta.mime_type}\n\nbase64:\n${b64}`); }
      default: return err(`Unknown tool: ${name}`);
    }
  } catch (e: any) { return err(`Error: ${e.message}`); }
});

// SSE listener
let sseAbort: AbortController | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let currentDelay = 3000;
let myReportsTo: string | null = null;

async function fetchMyReportsTo() { try { const agents = await api("GET", "/api/agents"); myReportsTo = agents.find((a: any) => a.name === AGENT_NAME)?.reports_to || null; } catch {} }

function shouldInject(ev: any): boolean {
  if (ev.type === "message") { if ((ev.channel||"").startsWith("dm:")) return true; if (ev.mentions?.includes(AGENT_NAME)) return true; if (ev.from === "System") return true; if (ev.from === "Chairman" && myReportsTo === "Chairman") return true; return false; }
  if (ev.type === "approval_requested") return true;
  if (ev.type === "approval_resolved") return true;
  return false;
}

function connectSSE() {
  if (sseAbort) sseAbort.abort();
  sseAbort = new AbortController();
  fetchMyReportsTo();
  const url = `${BASE_URL}/api/events`;
  log(`SSE connecting to ${url}`);
  fetch(url, { headers: { Authorization: `Bearer ${API_KEY}` }, signal: sseAbort.signal })
    .then(async (res) => {
      if (!res.ok) throw new Error(`SSE HTTP ${res.status}`);
      log("SSE connected"); currentDelay = 3000;
      const reader = (res.body as any).getReader(); const decoder = new TextDecoder(); let buffer = "";
      while (true) { const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); const lines = buffer.split("\n"); buffer = lines.pop()!; let cur = ""; for (const line of lines) { if (line.startsWith("data: ")) cur += line.slice(6); else if (line === "" && cur) { handleSSE(cur); cur = ""; } } }
      log("SSE ended"); scheduleReconnect();
    })
    .catch((e) => { if (e.name === "AbortError") return; log(`SSE error: ${e.message}`); scheduleReconnect(); });
}

function scheduleReconnect() { if (reconnectTimer) clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connectSSE, currentDelay); currentDelay = Math.min(currentDelay * 1.5, 30000); }

function handleSSE(data: string) {
  let ev: any; try { ev = JSON.parse(data); } catch { return; }
  if (ev.type === "message" && shouldInject(ev)) {
    const ch = ev.channel || "unknown"; const isDm = ch.startsWith("dm:");
    const msg = `---\n**${ev.from||"?"}** (${new Date().toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"})})\n\n${ev.content||""}\n`;
    const extraMeta: Record<string, string> = {};
    if (ev.metadata && typeof ev.metadata === 'object') {
      for (const [k, v] of Object.entries(ev.metadata)) {
        if (typeof v === 'string') extraMeta[k] = v;
      }
    }
    notify(msg, isDm ? "dm" : "group", ch, extraMeta);
    if (ev.id) api("POST", `/api/messages/${ev.id}/ack`).catch(() => {});
  } else if (ev.type === "status" && ev.status === "online") { notify(`${ev.agent} is now online`, "status", ""); }
  else if (ev.type === "approval_resolved") { handleApprovalResolved(ev); }
}

async function notify(text: string, source = "group", channel = "", extraMeta: Record<string, string> = {}) {
  try { await server.notification({ method: "notifications/claude/channel", params: { content: text, meta: { source, channel, ...extraMeta } } }); log(`Notif OK (${source})`); }
  catch (e: any) { log(`Notif fail: ${e.message}`); }
}

function log(msg: string) { process.stderr.write(`[fakechat] ${msg}\n`); }

// ---------------------------------------------------------------------------
// Permission integration: CC permission_request → TeamMCP approval → CC permission
// ---------------------------------------------------------------------------
import { randomUUID } from "crypto";

const pendingPermissions = new Map<string, { fieldName: string; approvalId?: string; toolName: string; description: string; inputPreview: string; createdAt: number }>();
const pendingApprovals = new Map<string, { requestId: string }>();

const PERMISSION_REQUEST_METHOD = "notifications/claude/channel/permission_request";
const PERMISSION_RESPONSE_METHOD = "notifications/claude/channel/permission";

// Track next field index for rotating permission request fields
let permissionFieldCounter = 0;

async function handlePermissionRequest(params: { request_id: string; tool_name: string; description?: string; input_preview?: string }) {
  const { request_id, tool_name, description, input_preview } = params;
  if (!request_id || !tool_name) { log(`Permission request missing required fields`); return; }

  // Use rotating field names so each permission request creates/updates its own field
  const fieldIndex = permissionFieldCounter++;
  const fieldName = `perm_${fieldIndex}`;
  pendingPermissions.set(request_id, { fieldName, toolName: tool_name, description: description || '', inputPreview: input_preview || '', createdAt: Date.now() });

  log(`Permission request: ${tool_name} (${request_id}) → field ${fieldName}`);

  try {
    const result = await api("POST", "/api/state", {
      project_id: 'claude-code-permissions',
      field: fieldName,
      value: { tool_name, description: description || '', input_preview: input_preview || '', cc_request_id: request_id },
      approval_required: true,
    });

    if (result.pending_approval) {
      const approvalId = result.approval_id;
      pendingPermissions.get(request_id)!.approvalId = approvalId;
      pendingApprovals.set(approvalId, { requestId: request_id });
      log(`Approval created for ${tool_name} (${request_id}) → ${approvalId}`);
    } else if (result.created) {
      log(`Field created for ${tool_name} (${request_id}), triggering approval via update...`);
      const updateResult = await api("POST", "/api/state", {
        project_id: 'claude-code-permissions',
        field: fieldName,
        value: { tool_name, description: description || '', input_preview: input_preview || '', cc_request_id: request_id },
        approval_required: true,
      });
      if (updateResult.pending_approval) {
        const approvalId = updateResult.approval_id;
        pendingPermissions.get(request_id)!.approvalId = approvalId;
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
  } catch (err: any) {
    log(`Permission forward error: ${err.message}`);
    sendPermissionResponse(request_id, 'deny');
    cleanupPermission(request_id);
  }
}

function handleApprovalResolved(event: any) {
  const { approval_id, approved } = event;
  if (!approval_id) return;
  const mapping = pendingApprovals.get(approval_id);
  if (!mapping) return;
  const decision = approved ? 'allow' : 'deny';
  log(`Permission resolved: ${approval_id} → ${mapping.requestId} → ${decision}`);
  sendPermissionResponse(mapping.requestId, decision);
  cleanupPermission(mapping.requestId);
}

async function sendPermissionResponse(requestId: string, behavior: 'allow' | 'deny') {
  try {
    await server.notification({ method: PERMISSION_RESPONSE_METHOD, params: { request_id: requestId, behavior } });
    log(`Permission response sent: ${requestId} → ${behavior}`);
  } catch (err: any) {
    log(`Permission response error: ${err.message}`);
  }
}

function cleanupPermission(requestId: string) {
  const mapping = pendingPermissions.get(requestId);
  if (mapping) pendingApprovals.delete(mapping.approvalId);
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
      notify(`⚠️ 审批超时已自动拒绝：${info.toolName}\n${info.description || ''}`.trim(), "system", "");
      cleanupPermission(requestId);
    }
  }
}, 60000);

async function main() {
  log(`Starting fakechat for "${AGENT_NAME}" -> ${BASE_URL}`);
  await server.connect(new StdioServerTransport());
  log("MCP connected");

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
  server.setNotificationHandler(PermissionRequestNotificationSchema, (notification: any) => {
    handlePermissionRequest(notification.params);
  });
  log("Permission request handler registered");

  connectSSE();
}
main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
