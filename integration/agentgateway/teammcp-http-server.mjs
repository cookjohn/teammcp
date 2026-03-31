#!/usr/bin/env node
/**
 * TeamMCP MCP Server — Streamable HTTP Transport Mode
 *
 * This wraps the TeamMCP MCP server with Streamable HTTP transport,
 * enabling integration with AgentGateway as a reverse proxy.
 *
 * Usage:
 *   MCP_HTTP_PORT=3200 AGENT_NAME=B TEAMMCP_KEY=tmcp_xxx node teammcp-http-server.mjs
 *
 * AgentGateway connects to http://localhost:3200/mcp
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const AGENT_NAME = process.env.AGENT_NAME;
const API_KEY = process.env.TEAMMCP_KEY;
const BASE_URL = (process.env.TEAMMCP_URL || "http://localhost:3100").replace(/\/+$/, "");
const MCP_HTTP_PORT = parseInt(process.env.MCP_HTTP_PORT || "3200", 10);

if (!AGENT_NAME || !API_KEY) {
  console.error("ERROR: AGENT_NAME and TEAMMCP_KEY environment variables are required");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// HTTP helpers (calls to TeamMCP backend)
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
// Tool definitions (same as teammcp-channel.mjs)
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: "send_message",
    description: "Send a message to a channel",
    inputSchema: {
      type: "object",
      properties: {
        channel:  { type: "string", description: "Channel ID, e.g. 'general'" },
        content:  { type: "string", description: "Message content" },
        mentions: { type: "array", items: { type: "string" }, description: "@ mentions (optional)" },
        replyTo:  { type: "string", description: "Reply to message ID (optional)" },
      },
      required: ["channel", "content"],
    },
  },
  {
    name: "send_dm",
    description: "Send a direct message to a user",
    inputSchema: {
      type: "object",
      properties: {
        recipient: { type: "string", description: "Recipient name" },
        content:   { type: "string", description: "Message content" },
        replyTo:   { type: "string", description: "Reply to message ID (optional)" },
      },
      required: ["recipient", "content"],
    },
  },
  {
    name: "get_history",
    description: "View channel message history",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel ID" },
        limit:   { type: "number", description: "Number of messages, default 50" },
      },
      required: ["channel"],
    },
  },
  {
    name: "get_agents",
    description: "List all agents and their online status",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_channels",
    description: "List channels and unread counts",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "search_messages",
    description: "Search message history",
    inputSchema: {
      type: "object",
      properties: {
        query:   { type: "string", description: "Search keywords" },
        channel: { type: "string", description: "Limit to channel (optional)" },
        from:    { type: "string", description: "Limit to sender (optional)" },
        limit:   { type: "number", description: "Number of results, default 20" },
      },
      required: ["query"],
    },
  },
  {
    name: "create_task",
    description: "Create a new task",
    inputSchema: {
      type: "object",
      properties: {
        title:     { type: "string", description: "Task title" },
        assignee:  { type: "string", description: "Assignee name" },
        priority:  { type: "string", enum: ["urgent", "high", "medium", "low"], description: "Priority" },
        due_date:  { type: "string", description: "Due date (ISO 8601)" },
      },
      required: ["title"],
    },
  },
  {
    name: "list_tasks",
    description: "List tasks with optional filters",
    inputSchema: {
      type: "object",
      properties: {
        status:   { type: "string", description: "Filter: todo/doing/done" },
        assignee: { type: "string", description: "Filter by assignee" },
        limit:    { type: "number", description: "Number of results, default 20" },
      },
    },
  },
  {
    name: "update_task",
    description: "Update task status or fields",
    inputSchema: {
      type: "object",
      properties: {
        task_id:  { type: "string", description: "Task ID" },
        status:   { type: "string", enum: ["todo", "doing", "done"], description: "New status" },
        result:   { type: "string", description: "Task result/outcome" },
      },
      required: ["task_id"],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------
async function handleTool(name, args) {
  switch (name) {
    case "send_message": {
      const body = { channel: args.channel, content: args.content, mentions: args.mentions || [] };
      if (args.replyTo) body.replyTo = args.replyTo;
      const result = await apiRequest("POST", "/api/send", body);
      return { content: [{ type: "text", text: `Message sent (id: ${result.id})` }] };
    }
    case "send_dm": {
      const body = { channel: `dm:${args.recipient}`, content: args.content };
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
      return { content: [{ type: "text", text: formatted || "(no messages)" }] };
    }
    case "get_agents": {
      const agents = await apiRequest("GET", "/api/agents");
      const formatted = agents
        .map((a) => `${a.name} (${a.role || "?"}) — ${a.status}`)
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
            ? `Found ${result.total} results:\n\n${formatted}`
            : `No results for "${args.query}"`,
        }],
      };
    }
    case "create_task": {
      const body = { title: args.title };
      if (args.assignee) body.assignee = args.assignee;
      if (args.priority) body.priority = args.priority;
      if (args.due_date) body.due_date = args.due_date;
      const result = await apiRequest("POST", "/api/tasks", body);
      const task = result.task;
      return { content: [{ type: "text", text: `Task created: ${task.id} — ${task.title} [${task.status}]` }] };
    }
    case "list_tasks": {
      const params = new URLSearchParams();
      params.set("status", args.status || "todo,doing");
      if (args.assignee) params.set("assignee", args.assignee);
      if (args.limit) params.set("limit", String(args.limit));
      const result = await apiRequest("GET", `/api/tasks?${params}`);
      if (!result.tasks || result.tasks.length === 0) {
        return { content: [{ type: "text", text: "(no tasks found)" }] };
      }
      const formatted = result.tasks.map(t =>
        `[${t.status}] ${t.id} [${t.priority}] ${t.title}${t.assignee ? ` → ${t.assignee}` : ''}`
      ).join("\n");
      return { content: [{ type: "text", text: `${result.total} task(s):\n\n${formatted}` }] };
    }
    case "update_task": {
      const body = {};
      for (const f of ["status", "result"]) {
        if (args[f] !== undefined) body[f] = args[f];
      }
      const result = await apiRequest("PATCH", `/api/tasks/${args.task_id}`, body);
      const task = result.task;
      return { content: [{ type: "text", text: `Task ${task.id} updated — ${task.title} [${task.status}]` }] };
    }
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}

// ---------------------------------------------------------------------------
// MCP Server factory (new instance per session)
// ---------------------------------------------------------------------------
function createMcpServer() {
  const server = new Server(
    { name: "teammcp-channel", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions: `TeamMCP Agent collaboration server. Agent: ${AGENT_NAME}. Use tools to communicate with other agents.`,
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      return await handleTool(name, args);
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// HTTP Server with Streamable HTTP transport
// ---------------------------------------------------------------------------
const transports = {};
const sessionLastActive = {};
const MAX_BODY_SIZE = 1 * 1024 * 1024; // 1MB
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

function isInitializeRequest(body) {
  return body && body.method === "initialize";
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// Session cleanup: remove inactive sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const sid in sessionLastActive) {
    if (now - sessionLastActive[sid] > SESSION_TTL_MS) {
      console.log(`[teammcp-http] Cleaning up inactive session: ${sid}`);
      if (transports[sid]) {
        transports[sid].close().catch(() => {});
        delete transports[sid];
      }
      delete sessionLastActive[sid];
    }
  }
}, 5 * 60 * 1000).unref();

const httpServer = createServer(async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Only handle /mcp path
  const url = new URL(req.url, `http://localhost:${MCP_HTTP_PORT}`);
  if (url.pathname !== "/mcp") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found. Use /mcp endpoint." }));
    return;
  }

  try {
    const sessionId = req.headers["mcp-session-id"];

    if (req.method === "POST") {
      const body = await readBody(req);

      if (sessionId && transports[sessionId]) {
        // Existing session
        sessionLastActive[sessionId] = Date.now();
        await transports[sessionId].handleRequest(req, res, body);
      } else if (!sessionId && isInitializeRequest(body)) {
        // New session
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            console.log(`[teammcp-http] Session initialized: ${sid}`);
            transports[sid] = transport;
            sessionLastActive[sid] = Date.now();
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            console.log(`[teammcp-http] Session closed: ${sid}`);
            delete transports[sid];
            delete sessionLastActive[sid];
          }
        };

        const server = createMcpServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } else {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid session ID" },
          id: null,
        }));
      }
    } else if (req.method === "GET") {
      // SSE stream for server-to-client notifications
      if (!sessionId || !transports[sessionId]) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid or missing session ID");
        return;
      }
      await transports[sessionId].handleRequest(req, res);
    } else if (req.method === "DELETE") {
      // Session termination
      if (!sessionId || !transports[sessionId]) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid or missing session ID");
        return;
      }
      await transports[sessionId].handleRequest(req, res);
    } else {
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Method not allowed");
    }
  } catch (err) {
    console.error("[teammcp-http] Error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      }));
    }
  }
});

httpServer.listen(MCP_HTTP_PORT, () => {
  console.log(`[teammcp-http] TeamMCP MCP Server (Streamable HTTP) listening on port ${MCP_HTTP_PORT}`);
  console.log(`[teammcp-http] Agent: ${AGENT_NAME}`);
  console.log(`[teammcp-http] Backend: ${BASE_URL}`);
  console.log(`[teammcp-http] Endpoint: http://localhost:${MCP_HTTP_PORT}/mcp`);
});

process.on("SIGINT", async () => {
  console.log("[teammcp-http] Shutting down...");
  for (const sid in transports) {
    try {
      await transports[sid].close();
      delete transports[sid];
    } catch {}
  }
  httpServer.close();
  process.exit(0);
});
