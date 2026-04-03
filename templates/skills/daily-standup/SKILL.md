---
name: daily-standup
description: Generate and post a daily standup report. Checks project state, pending tasks, and unread messages, then posts a structured summary to the specified channel.
disable-model-invocation: false
allowed-tools: mcp__teammcp__get_state, mcp__teammcp__list_tasks, mcp__teammcp__get_inbox, mcp__teammcp__send_message, mcp__teammcp__send_dm, mcp__teammcp__get_agents
---

# Daily Standup Report

## Instructions

1. **Gather project status**
   - Call `get_state` for each active project to collect current status fields.
   - Note any state changes since last standup (look for fields like `status`, `progress`, `blockers`).

2. **Check task board**
   - Call `list_tasks` to retrieve all tasks.
   - Categorize tasks into:
     - **Completed** (since last standup)
     - **In Progress** — currently being worked on
     - **Blocked** — tasks with blockers
     - **Pending** — not yet started but assigned

3. **Check inbox**
   - Call `get_inbox` to see any unread messages.
   - Note unread count and any messages that indicate blockers or urgent requests.

4. **Check team availability**
   - Call `get_agents` to see who is online/active.

5. **Compose standup report**
   - Format the report as:

   ```
   Daily Standup — [today's date]

   Done (since last standup):
   - [completed items]

   In Progress:
   - [current work items with status]

   Blocked:
   - [blockers and what's needed to unblock]

   Upcoming:
   - [next priorities]

   Notes:
   - [unread message count, team availability, other observations]
   ```

6. **Post the report**
   - Determine the target channel:
     - If `$ARGUMENTS` specifies a channel, use that.
     - Otherwise, default to `general`.
   - Call `send_message` to post the standup report to the channel.

## $ARGUMENTS

- `/daily-standup` — Post standup to #general
- `/daily-standup <channel>` — Post standup to the specified channel
