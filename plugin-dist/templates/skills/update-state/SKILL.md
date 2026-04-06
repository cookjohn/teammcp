---
name: update-state
description: Update a project state field via TeamMCP. Sets state with reason, verifies the update, and handles approval flow if you are not the state owner.
disable-model-invocation: false
allowed-tools: mcp__teammcp__get_state, mcp__teammcp__set_state, mcp__teammcp__request_approval, mcp__teammcp__get_pending_approvals, mcp__teammcp__send_dm, mcp__teammcp__send_message
---

# Update Project State

## Instructions

1. **Parse arguments**
   - Extract from `$ARGUMENTS`:
     - `project_id` — the project identifier
     - `field` — the state field to update
     - `value` — the new value to set
     - `reason` — why this change is being made
   - If any required parameter is missing, ask the user to provide it.

2. **Check current state**
   - Call `get_state` with the `project_id` to read the current value of the field.
   - Log the current value for reference before making changes.

3. **Attempt to set state**
   - Call `set_state` with `project_id`, `field`, `value`, and `reason`.
   - If the call succeeds, proceed to verification.

4. **Handle approval flow (if needed)**
   - If `set_state` fails due to ownership or permission restrictions:
     - Call `request_approval` to submit the state change for approval.
     - Notify the state owner via `send_dm` that an approval is pending.
     - Report to the user that the change requires approval and is pending.
     - Stop here — do not retry.

5. **Verify the update**
   - Call `get_state` again with the same `project_id` and confirm the field now holds the new value.
   - Report success with both the old and new values.

6. **Notify if appropriate**
   - If the state change is significant (e.g., status transitions like "in-progress" to "done"), send a notification to the relevant channel via `send_message`.

## $ARGUMENTS

- `/update-state <project_id> <field> <value> <reason>`
- Example: `/update-state proj-123 status in-review "Feature implementation complete, ready for review"`
