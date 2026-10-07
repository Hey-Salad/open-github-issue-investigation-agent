# Session auth identifiers

These values belong to the GitHub issue investigation worker. Do not copy them onto another agent worker. Sharing the rate-limit namespace shares attempt counters. Sharing the Durable Object instance name shares the global session-start window when scripts are bound together.

| Identifier | Value |
| --- | --- |
| Worker name | `github-issue-investigation-agent` |
| Pre-auth attempt limiter binding | `SESSION_ATTEMPT_LIMITER` |
| Pre-auth attempt namespace id | `github-issue-investigation-agent-session-attempts` |
| Attempt key | `ip:` + `CF-Connecting-IP`, or `ip:unknown` |
| Attempt limit | 30 per 60 seconds |
| Durable Object class | `SessionStartLimiter` |
| Durable Object binding | `SESSION_START_LIMITER` |
| Durable Object instance name | `github-issue-investigation-agent` |
| Migration tag | `v1-github-issue-investigation-agent-session-start` |
| Global session-start cap | 10 per 60 seconds |
| Auth secret | `SESSION_AUTH_SECRET`, minimum 32 characters |

The session route on this worker is `POST /api/sessions`.
