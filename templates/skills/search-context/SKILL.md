---
name: search-context
description: Search team knowledge across messages, project state, and task history. Compiles relevant context from multiple TeamMCP sources to answer questions.
disable-model-invocation: false
allowed-tools: mcp__teammcp__search_messages, mcp__teammcp__get_state, mcp__teammcp__list_tasks, mcp__teammcp__get_history, mcp__teammcp__get_state_history, mcp__teammcp__get_agents
---

# Search Team Knowledge

## Instructions

1. **Parse the query**
   - Extract the search query from `$ARGUMENTS`.
   - If no query is provided, ask the user what they want to search for.
   - Identify key terms, agent names, project IDs, or date ranges mentioned.

2. **Search messages**
   - Call `search_messages` with the query terms to find relevant conversations.
   - Note the channel, sender, timestamp, and content of matching messages.
   - If results are sparse, try alternative phrasings or broader terms.

3. **Check project state**
   - If the query relates to a specific project, call `get_state` with the project ID.
   - If the query mentions status, progress, or blockers, check relevant state fields.
   - Call `get_state_history` if the query is about how something changed over time.

4. **Check task history**
   - Call `list_tasks` and filter results relevant to the query.
   - Look for tasks matching the topic, assigned to mentioned agents, or in the queried status.

5. **Check channel history (if needed)**
   - If message search is insufficient, call `get_history` for specific channels that are likely relevant.

6. **Compile results**
   - Organize findings into a structured response:

   ```
   Search Results for: "<query>"

   Messages:
   - [timestamp] #channel @sender: relevant excerpt
   - ...

   Project State:
   - [project_id] field: value (if relevant)

   Tasks:
   - [task_id] title — status — assignee

   Summary:
   - Brief synthesis of what was found and how it answers the query
   ```

7. **Highlight gaps**
   - If the search did not find sufficient information, note what is missing.
   - Suggest who to ask or where to look next.

## $ARGUMENTS

- `/search-context <query>`
- Example: `/search-context authentication implementation decision`
- Example: `/search-context what did CEO say about launch timeline`
