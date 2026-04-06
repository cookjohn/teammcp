---
name: deploy-router
description: Deploy claude-code-router for third-party API support (OpenRouter, Gemini, DeepSeek, etc). Use when setting up non-Anthropic API providers for TeamMCP agents.
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Glob, Grep
---

# Deploy claude-code-router

Deploys claude-code-router as a proxy service that translates Anthropic API format to third-party providers. Required for non-Anthropic models (OpenRouter, Gemini, DeepSeek, Ollama, etc).

## Step 1: Install

```bash
npx @musistudio/claude-code-router start
```

This installs and starts the router. Default port: 3456.

## Step 2: Configure

Create/edit `~/.claude-code-router/config.json`:

```json
{
  "LOG": true,
  "LOG_LEVEL": "info",
  "HOST": "127.0.0.1",
  "PORT": 3456,
  "Providers": [
    {
      "name": "openrouter",
      "api_base_url": "https://openrouter.ai/api/v1/chat/completions",
      "api_key": "{YOUR_OPENROUTER_API_KEY}",
      "models": ["{MODEL_NAME}"],
      "transformer": {
        "use": ["openrouter"]
      }
    }
  ],
  "Router": {
    "default": "openrouter,{MODEL_NAME}"
  }
}
```

**Provider examples:**

| Provider | api_base_url | transformer |
|----------|-------------|-------------|
| OpenRouter | `https://openrouter.ai/api/v1/chat/completions` | `["openrouter"]` |
| DeepSeek | `https://api.deepseek.com/chat/completions` | `["deepseek"]` |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/models/` | `["gemini"]` |
| Ollama | `http://localhost:11434/v1/chat/completions` | (none needed) |

## Step 3: Restart router

```bash
npx @musistudio/claude-code-router stop
npx @musistudio/claude-code-router start
```

## Step 4: Verify

```bash
curl -s -X POST http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: test" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"{MODEL_NAME}","max_tokens":50,"messages":[{"role":"user","content":"Hello"}]}'
```

Should return a valid response with the model's reply.

## Step 5: Configure Agent

In TeamMCP Dashboard Agent Management, set for the target agent:
- `auth_mode`: `api_key`
- `api_provider`: provider name (e.g., `openrouter`)
- `api_base_url`: `http://localhost:3456` (router address)
- `api_auth_token`: any value (router handles real auth)
- `api_model`: model name (e.g., `qwen/qwen3-235b-a22b`)

Or via API:
```bash
curl -X PATCH http://localhost:3100/api/agents/{AGENT_NAME} \
  -H "Authorization: Bearer {TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"auth_mode":"api_key","api_provider":"openrouter","api_base_url":"http://localhost:3456","api_auth_token":"test","api_model":"{MODEL_NAME}"}'
```

Then stop+start the agent to apply.

## Step 6: Agent _start.cmd environment

startAgent automatically generates these for api_key mode:
```
set "ANTHROPIC_API_KEY="
set "CLAUDE_CODE_OAUTH_TOKEN=channel-gate-bypass"
set "ANTHROPIC_BASE_URL=http://localhost:3456"
set "ANTHROPIC_AUTH_TOKEN=test"
set "ANTHROPIC_MODEL={MODEL_NAME}"
```

## Notes

- Router must stay running while agents use it
- Each provider can have multiple models
- Use `"transformer": {"use": ["openrouter"]}` for OpenRouter compatibility
- Config reference: https://github.com/musistudio/claude-code-router
