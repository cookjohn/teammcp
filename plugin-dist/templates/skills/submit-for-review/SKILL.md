---
name: submit-for-review
description: Submit work for team review or approval. Creates/updates a review task, notifies the reviewer via channel or DM, and requests state approval if needed.
disable-model-invocation: false
allowed-tools: mcp__teammcp__create_task, mcp__teammcp__update_task, mcp__teammcp__send_message, mcp__teammcp__send_dm, mcp__teammcp__request_approval, mcp__teammcp__set_state, mcp__teammcp__get_state, mcp__teammcp__list_tasks
---

# Submit Work for Review

## Instructions

1. **Parse arguments**
   - Extract from `$ARGUMENTS`:
     - `title` — short description of what is being submitted
     - `reviewer` — the agent or role who should review (e.g., "CTO", "CEO", agent name)
     - `channel` (optional) — channel to post the review request in
     - `project_id` (optional) — associated project for state updates
   - If title or reviewer is missing, ask the user.

2. **Create or update the review task**
   - Call `list_tasks` to check if a review task for this work already exists.
   - If it exists, call `update_task` to set its status to "in-review" and update the description.
   - If it does not exist, call `create_task` with:
     - Title: the provided title
     - Status: "in-review"
     - Assignee: the reviewer
     - Description: summary of what is being submitted and what to review

3. **Notify the reviewer**
   - If a channel is specified, call `send_message` to the channel with the review request, including:
     - What is being submitted
     - Task ID for reference
     - What kind of feedback is expected
   - Always also call `send_dm` to the reviewer directly with the review details.

4. **Request state approval (if applicable)**
   - If a `project_id` is provided:
     - Call `request_approval` to request a state transition (e.g., status from "in-progress" to "in-review").
     - This notifies the state owner that approval is needed.

5. **Confirm submission**
   - Output a summary:
     - Task ID created/updated
     - Reviewer notified
     - Approval requested (if applicable)
     - Next steps (wait for reviewer feedback)

## $ARGUMENTS

- `/submit-for-review "<title>" <reviewer>`
- `/submit-for-review "<title>" <reviewer> --channel <channel>`
- `/submit-for-review "<title>" <reviewer> --project <project_id>`
- Example: `/submit-for-review "API authentication module" CEO --channel general --project proj-123`
