# GitHub Issue Investigation Agent

Runnable Cloudflare Worker and curl-first example for the OpenAI Agents API. It creates a reusable agent named `GitHub issue investigation agent`, starts a streamed session from the returned `agent_id`, and streams raw session events.

## Files

- `config/agent-definition.json` contains the reusable agent definition.
- `config/session-input.txt` contains the initial user message.
- `scripts/run-agent-session.sh` calls the Agents HTTP API directly with `curl`.
- `src/index.ts` is a Cloudflare Worker UI/API layer that mirrors the same flow.

## Setup

```bash
npm install
export OPENAI_API_KEY="your-api-key"
```

`POST /api/sessions` requires a bearer token. Set `SESSION_AUTH_SECRET` to at least 32 characters. A missing or shorter secret fails closed with HTTP 503.

```bash
npx wrangler secret put SESSION_AUTH_SECRET
```

Session start is limited before that check to 30 attempts per 60 seconds per `CF-Connecting-IP` (`ip:` plus the address, or `ip:unknown` when the header is missing). After a valid token, a Durable Object caps successful session starts at 10 per 60 seconds for this worker. Identifiers for this worker are in `rollout/README.md`.

The app uses OpenAI project `proj_mRsQVx3NjOamxeXH6UrLowoC` via the `OpenAI-Project` header by default.

## Run Locally

```bash
npm run run:agent
npm test
npm run typecheck
npm run dev
```

## Deploy To Cloudflare Workers

```bash
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put SESSION_AUTH_SECRET
npm run deploy
```

Default Agents API environment is `openai_hosted`. Set `AGENTS_ENVIRONMENT_TYPE=none` only when no sandbox is needed.
