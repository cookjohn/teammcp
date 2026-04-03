---
name: check-inbox
description: Check and process unread TeamMCP inbox messages. Reviews all unread items, acknowledges processed ones, and summarizes what needs attention.
disable-model-invocation: false
allowed-tools: mcp__teammcp__get_inbox, mcp__teammcp__ack_inbox, mcp__teammcp__send_message, mcp__teammcp__send_dm
---

# Check & Process Inbox

## Instructions

1. **Fetch unread messages**
   - Call `get_inbox` to retrieve all unread inbox items.
   - If the inbox is empty, report "No unread messages" and stop.

2. **Review each item**
   - For each unread message, identify:
     - **Sender**: who sent it
     - **Channel or DM**: where it came from
     - **Content**: the message body
     - **Priority**: whether it requires immediate action, is a question, an FYI, or a task request

3. **Categorize messages**
   - Group messages into categories:
     - **Action Required** — messages that need a response or decision
     - **FYI / Informational** — status updates, notifications
     - **Questions** — questions directed at you that need answers
     - **Tasks / Requests** — work items or review requests

4. **Acknowledge processed items**
   - For each reviewed message, call `ack_inbox` with the message ID to mark it as read.
   - Only acknowledge after you have fully reviewed the content.

5. **Generate summary**
   - Output a structured summary with:
     - Total unread count
     - Breakdown by category
     - List of items requiring immediate attention (with sender and brief description)
     - Any items you recommend responding to first

6. **Respond if needed**
   - If `$ARGUMENTS` includes "respond", also draft and send replies to urgent items using `send_message` (for channels) or `send_dm` (for direct messages).
   - Without the "respond" argument, only summarize — do not send any replies.

## $ARGUMENTS

- `/check-inbox` — Check inbox and summarize only
- `/check-inbox respond` — Check inbox, summarize, and respond to urgent items
