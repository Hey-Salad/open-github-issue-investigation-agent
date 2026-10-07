import agentDefinition from "../config/agent-definition.json";
import {
  enforceSessionStartPolicy,
  jsonResponse,
  type SessionGuardEnv,
} from "./session-guard";

interface Env extends SessionGuardEnv {
  OPENAI_API_KEY: string;
  OPENAI_PROJECT: string;
  OPENAI_BASE_URL: string;
  AGENTS_ENVIRONMENT_TYPE: string;
}

type AgentCreateResponse = {
  id?: string;
  error?: { message?: string };
};

const DEFAULT_INPUT = "Please investigate this GitHub issue.\n\nWe are testing the GitHub issue investigation agent in a fresh OpenAI Agents API session. No repository, issue URL, branch, logs, reproduction steps, or failing test output have been provided yet.\n\nReturn a concise intake checklist, the missing context you need, a suggested investigation plan, and the first safe next steps.";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return htmlResponse(renderHome());
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ ok: true, service: "github-issue-investigation-agent" });
    }

    if (request.method === "POST" && url.pathname === "/api/sessions") {
      return createAndStreamSession(request, env);
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
};

async function createAndStreamSession(request: Request, env: Env): Promise<Response> {
  const denied = await enforceSessionStartPolicy(request, env);
  if (denied) return denied;

  if (!env.OPENAI_API_KEY) {
    return jsonResponse({ error: "OPENAI_API_KEY secret is not configured." }, 500);
  }
  if (!env.OPENAI_BASE_URL) {
    return jsonResponse({ error: "OPENAI_BASE_URL is not configured." }, 500);
  }

  const contentType = request.headers.get("content-type") ?? "";
  let input = DEFAULT_INPUT;

  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as { input?: unknown };
    if (typeof body.input === "string" && body.input.trim()) {
      input = body.input.trim();
    }
  } else if (contentType.includes("form")) {
    const formData = await request.formData();
    const value = formData.get("input");
    if (typeof value === "string" && value.trim()) {
      input = value.trim();
    }
  }

  const createAgent = await fetch(`${apiBase(env)}/agents`, {
    method: "POST",
    headers: openAiHeaders(env),
    body: JSON.stringify(agentDefinition),
  });

  if (!createAgent.ok) {
    return openAiError("create reusable agent", createAgent);
  }

  const agent = (await createAgent.json()) as AgentCreateResponse;
  if (!agent.id) {
    return jsonResponse({ error: "Create-agent response did not include an id.", response: agent }, 502);
  }

  const session = await fetch(`${apiBase(env)}/agents/sessions`, {
    method: "POST",
    headers: openAiHeaders(env),
    body: JSON.stringify({
      agent_id: agent.id,
      environment: createEnvironment(env),
      input,
      stream: true,
    }),
  });

  if (!session.ok || !session.body) {
    return openAiError("start streamed session", session);
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(`event: agent-created\ndata: ${JSON.stringify({ agent_id: agent.id })}\n\n`));

      const reader = session.body!.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      } catch (error) {
        controller.enqueue(
          encoder.encode(
            `event: worker-error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : String(error) })}\n\n`,
          ),
        );
      } finally {
        controller.close();
        reader.releaseLock();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function apiBase(env: Env): string {
  return env.OPENAI_BASE_URL.replace(/\/$/, "");
}

function createEnvironment(env: Env): { type: string } {
  return { type: env.AGENTS_ENVIRONMENT_TYPE || "openai_hosted" };
}

function openAiHeaders(env: Env): HeadersInit {
  return {
    "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
    "OpenAI-Beta": "agents=v1",
    ...(env.OPENAI_PROJECT ? { "OpenAI-Project": env.OPENAI_PROJECT } : {}),
    "Content-Type": "application/json",
  };
}

async function openAiError(action: string, response: Response): Promise<Response> {
  const body = await response.text();
  return jsonResponse(
    {
      error: `Failed to ${action}.`,
      status: response.status,
      body,
    },
    502,
  );
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function renderHome(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GitHub Issue Investigation Agent</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f6f7f9;
      color: #171b21;
    }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr;
    }
    header {
      padding: 28px clamp(18px, 4vw, 48px) 14px;
      border-bottom: 1px solid #d8dde6;
      background: #ffffff;
    }
    h1 {
      margin: 0 0 8px;
      font-size: clamp(1.45rem, 3vw, 2.3rem);
      letter-spacing: 0;
    }
    p {
      margin: 0;
      max-width: 760px;
      color: #566070;
      line-height: 1.5;
    }
    main {
      display: grid;
      grid-template-columns: minmax(280px, 520px) minmax(320px, 1fr);
      gap: 24px;
      padding: 24px clamp(18px, 4vw, 48px);
    }
    form, section {
      min-width: 0;
    }
    label {
      display: block;
      font-weight: 650;
      margin-bottom: 10px;
    }
    textarea {
      box-sizing: border-box;
      width: 100%;
      min-height: 430px;
      resize: vertical;
      padding: 14px;
      border: 1px solid #c9d1dc;
      border-radius: 8px;
      background: #ffffff;
      color: inherit;
      font: 14px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    input[type="password"] {
      box-sizing: border-box;
      width: 100%;
      min-height: 42px;
      margin-bottom: 4px;
      padding: 0 14px;
      border: 1px solid #c9d1dc;
      border-radius: 8px;
      background: #ffffff;
      color: inherit;
      font: 14px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    button {
      margin-top: 12px;
      min-height: 42px;
      padding: 0 16px;
      border: 0;
      border-radius: 8px;
      background: #2057d6;
      color: white;
      font-weight: 700;
      cursor: pointer;
    }
    button:disabled {
      opacity: 0.65;
      cursor: wait;
    }
    pre {
      box-sizing: border-box;
      min-height: 500px;
      max-height: calc(100vh - 210px);
      overflow: auto;
      margin: 0;
      padding: 14px;
      border: 1px solid #c9d1dc;
      border-radius: 8px;
      background: #111827;
      color: #e8eef8;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    @media (max-width: 860px) {
      main {
        grid-template-columns: 1fr;
      }
      textarea {
        min-height: 320px;
      }
    }
  </style>
</head>
<body>
  <header>
    <h1>GitHub Issue Investigation Agent</h1>
    <p>Create a reusable OpenAI Agents API GitHub issue investigator, start an OpenAI-hosted session from its returned agent ID, and stream raw session events. Session start requires a bearer token.</p>
  </header>
  <main>
    <form id="agent-form">
      <label for="input">Initial user message</label>
      <textarea id="input" name="input">${escapeHtml(DEFAULT_INPUT)}</textarea>
      <label for="token">Session token</label>
      <input id="token" name="token" type="password" autocomplete="off" spellcheck="false">
      <button id="run" type="submit">Run investigation</button>
    </form>
    <section aria-label="Session stream">
      <pre id="output">Waiting to run...</pre>
    </section>
  </main>
  <script>
    const form = document.querySelector("#agent-form");
    const button = document.querySelector("#run");
    const output = document.querySelector("#output");

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      button.disabled = true;
      output.textContent = "Starting session...\\n";

      try {
        const headers = { "Content-Type": "application/json" };
        const token = form.token.value.trim();
        if (token) headers.Authorization = "Bearer " + token;
        const response = await fetch("/api/sessions", {
          method: "POST",
          headers,
          body: JSON.stringify({ input: form.input.value })
        });

        if (!response.ok || !response.body) {
          output.textContent += await response.text();
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          output.textContent += decoder.decode(value, { stream: true });
          output.scrollTop = output.scrollHeight;
        }
      } catch (error) {
        output.textContent += "\\n" + (error?.message || String(error));
      } finally {
        button.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
