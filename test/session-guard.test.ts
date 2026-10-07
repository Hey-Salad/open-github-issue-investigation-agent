import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import {
  attemptKeyFromConnectingIp,
  consumeFixedWindow,
  enforceSessionStartPolicy,
  GLOBAL_SESSION_START_LIMIT,
  GLOBAL_SESSION_START_WINDOW_MS,
  IP_ATTEMPT_LIMIT,
  IP_ATTEMPT_NAMESPACE_ID,
  IP_ATTEMPT_PERIOD_SECONDS,
  MIN_SESSION_AUTH_SECRET_CHARS,
  SESSION_START_OBJECT_NAME,
  timingSafeEqualString,
  WORKER_NAME,
  type SessionStartGate,
  type WindowState,
} from "../src/session-guard";

const SECRET = "0123456789abcdef0123456789abcdef";

function wranglerConfig(): {
  name: string;
  ratelimits: Array<{ name: string; namespace_id: string; simple: { limit: number; period: number } }>;
  durable_objects: { bindings: Array<{ name: string; class_name: string }> };
  migrations: Array<{ tag: string; new_sqlite_classes: string[] }>;
} {
  return JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
}

function createGuards(now: () => number) {
  const attempts = new Map<string, number[]>();
  const attemptKeys: string[] = [];
  const starts = new Map<string, WindowState>();
  const startNames: string[] = [];
  let consumeCalls = 0;

  const attemptLimiter = {
    async limit({ key }: { key: string }) {
      attemptKeys.push(key);
      const current = now();
      const recent = (attempts.get(key) ?? []).filter((stamp) => current - stamp < IP_ATTEMPT_PERIOD_SECONDS * 1000);
      if (recent.length >= IP_ATTEMPT_LIMIT) {
        attempts.set(key, recent);
        return { success: false };
      }
      recent.push(current);
      attempts.set(key, recent);
      return { success: true };
    },
  };

  const sessionStarts: SessionStartGate = {
    async consume() {
      consumeCalls += 1;
      const decision = consumeFixedWindow(
        starts.get(SESSION_START_OBJECT_NAME) ?? null,
        now(),
        GLOBAL_SESSION_START_LIMIT,
        GLOBAL_SESSION_START_WINDOW_MS,
      );
      starts.set(SESSION_START_OBJECT_NAME, decision.state);
      return { allowed: decision.allowed, retryAfterSeconds: decision.retryAfterSeconds };
    },
  };

  return {
    attemptKeys,
    consumeCalls: () => consumeCalls,
    startNames,
    env: {
      SESSION_AUTH_SECRET: SECRET,
      SESSION_ATTEMPT_LIMITER: attemptLimiter,
      SESSION_START_LIMITER: {
        getByName(name: string) {
          startNames.push(name);
          return sessionStarts;
        },
      },
      OPENAI_API_KEY: "test-openai-key",
      OPENAI_PROJECT: "proj_test",
      OPENAI_BASE_URL: "https://api.example.test/v1",
      AGENTS_ENVIRONMENT_TYPE: "none",
    },
  };
}

function sessionRequest(ip: string | null, authorization?: string): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (ip !== null) headers.set("CF-Connecting-IP", ip);
  if (authorization !== undefined) headers.set("Authorization", authorization);
  return new Request("https://worker.test/api/sessions", {
    method: "POST",
    headers,
    body: JSON.stringify({ input: "Investigate the failing test." }),
  });
}

describe("attempt keys", () => {
  it("prefixes CF-Connecting-IP and falls back to ip:unknown", () => {
    expect(attemptKeyFromConnectingIp("203.0.113.9")).toBe("ip:203.0.113.9");
    expect(attemptKeyFromConnectingIp("  2001:db8::1  ")).toBe("ip:2001:db8::1");
    expect(attemptKeyFromConnectingIp(null)).toBe("ip:unknown");
    expect(attemptKeyFromConnectingIp("   ")).toBe("ip:unknown");
  });
});

describe("global session-start window", () => {
  it("allows 10 starts per 60 seconds and then resets", () => {
    let state: WindowState | null = null;
    const start = 1_700_000_000_000;
    for (let count = 0; count < GLOBAL_SESSION_START_LIMIT; count += 1) {
      const decision = consumeFixedWindow(state, start + count, GLOBAL_SESSION_START_LIMIT, GLOBAL_SESSION_START_WINDOW_MS);
      expect(decision.allowed).toBe(true);
      state = decision.state;
    }
    const blocked = consumeFixedWindow(state, start + 10, GLOBAL_SESSION_START_LIMIT, GLOBAL_SESSION_START_WINDOW_MS);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(60);
    const reopened = consumeFixedWindow(
      blocked.state,
      start + GLOBAL_SESSION_START_WINDOW_MS,
      GLOBAL_SESSION_START_LIMIT,
      GLOBAL_SESSION_START_WINDOW_MS,
    );
    expect(reopened.allowed).toBe(true);
    expect(reopened.state.count).toBe(1);
  });
});

describe("session start policy", () => {
  it("limits attempts before the bearer check and uses ip:unknown", async () => {
    let now = 5_000;
    const guards = createGuards(() => now);
    guards.env.SESSION_AUTH_SECRET = "short-secret";

    const first = await enforceSessionStartPolicy(sessionRequest(null, "Bearer short-secret"), guards.env);
    expect(first?.status).toBe(503);
    expect(guards.attemptKeys).toEqual(["ip:unknown"]);
    expect(guards.consumeCalls()).toBe(0);

    for (let count = 1; count < IP_ATTEMPT_LIMIT; count += 1) {
      const response = await enforceSessionStartPolicy(sessionRequest("   ", `Bearer ${SECRET}`), guards.env);
      expect(response?.status).toBe(503);
    }
    const blocked = await enforceSessionStartPolicy(sessionRequest(null), guards.env);
    expect(blocked?.status).toBe(429);
    expect(blocked?.headers.get("Retry-After")).toBe(String(IP_ATTEMPT_PERIOD_SECONDS));
    expect(await blocked?.json()).toEqual({ error: "Too many session start attempts." });
    expect(guards.consumeCalls()).toBe(0);
  });

  it("rejects a secret under 32 characters with 503 and accepts 32", async () => {
    const guards = createGuards(() => 10_000);
    guards.env.SESSION_AUTH_SECRET = "x".repeat(MIN_SESSION_AUTH_SECRET_CHARS - 1);
    const missing = await enforceSessionStartPolicy(
      sessionRequest("203.0.113.4", `Bearer ${"x".repeat(31)}`),
      guards.env,
    );
    expect(missing?.status).toBe(503);

    guards.env.SESSION_AUTH_SECRET = undefined;
    const unset = await enforceSessionStartPolicy(sessionRequest("203.0.113.4", `Bearer ${SECRET}`), guards.env);
    expect(unset?.status).toBe(503);
    expect(guards.consumeCalls()).toBe(0);

    guards.env.SESSION_AUTH_SECRET = SECRET;
    expect(SECRET.length).toBe(32);
    const denied = await enforceSessionStartPolicy(sessionRequest("203.0.113.8", "Bearer wrong-token-wrong-token-xxxx"), guards.env);
    expect(denied?.status).toBe(401);
    expect(guards.consumeCalls()).toBe(0);

    const allowed = await enforceSessionStartPolicy(sessionRequest("203.0.113.8", `Bearer ${SECRET}`), guards.env);
    expect(allowed).toBeNull();
    expect(guards.startNames).toEqual([SESSION_START_OBJECT_NAME]);
    expect(guards.attemptKeys.at(-1)).toBe("ip:203.0.113.8");
  });

  it("caps authenticated session starts at 10 per 60 seconds across IPs", async () => {
    let now = 20_000;
    const guards = createGuards(() => now);
    for (let count = 0; count < GLOBAL_SESSION_START_LIMIT; count += 1) {
      const response = await enforceSessionStartPolicy(
        sessionRequest(`203.0.113.${count}`, `Bearer ${SECRET}`),
        guards.env,
      );
      expect(response).toBeNull();
    }
    const blocked = await enforceSessionStartPolicy(sessionRequest("198.51.100.10", `Bearer ${SECRET}`), guards.env);
    expect(blocked?.status).toBe(429);
    expect(await blocked?.json()).toEqual({ error: "Session start rate limit exceeded." });
    expect(guards.consumeCalls()).toBe(GLOBAL_SESSION_START_LIMIT + 1);

    now += GLOBAL_SESSION_START_WINDOW_MS;
    const again = await enforceSessionStartPolicy(sessionRequest("198.51.100.10", `Bearer ${SECRET}`), guards.env);
    expect(again).toBeNull();
  });

  it("keeps separate attempt buckets per IP", async () => {
    const guards = createGuards(() => 30_000);
    guards.env.SESSION_AUTH_SECRET = "too-short";
    for (let count = 0; count < IP_ATTEMPT_LIMIT; count += 1) {
      expect((await enforceSessionStartPolicy(sessionRequest("203.0.113.5"), guards.env))?.status).toBe(503);
    }
    expect((await enforceSessionStartPolicy(sessionRequest("203.0.113.5"), guards.env))?.status).toBe(429);
    expect((await enforceSessionStartPolicy(sessionRequest("203.0.113.6"), guards.env))?.status).toBe(503);
  });
});

describe("worker session route", () => {
  it("does not call the Agents API until auth and both limits pass", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("upstream down", { status: 500 }));
    let now = 40_000;
    const guards = createGuards(() => now);

    const home = await worker.fetch(new Request("https://worker.test/"), guards.env);
    expect(home.status).toBe(200);
    const html = await home.text();
    expect(html).toContain('id="token"');
    expect(html).toContain('headers.Authorization = "Bearer " + token');

    const health = await worker.fetch(new Request("https://worker.test/health"), guards.env);
    expect(await health.json()).toEqual({ ok: true, service: "github-issue-investigation-agent" });
    expect(fetchMock).not.toHaveBeenCalled();

    const unauthorized = await worker.fetch(sessionRequest("203.0.113.20", "Bearer nope"), guards.env);
    expect(unauthorized.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();

    for (let count = 0; count < GLOBAL_SESSION_START_LIMIT; count += 1) {
      const response = await worker.fetch(
        sessionRequest(`203.0.113.${count + 1}`, `Bearer ${SECRET}`),
        guards.env,
      );
      expect(response.status).toBe(502);
    }
    expect(fetchMock).toHaveBeenCalledTimes(GLOBAL_SESSION_START_LIMIT);

    const limited = await worker.fetch(sessionRequest("198.51.100.20", `Bearer ${SECRET}`), guards.env);
    expect(limited.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(GLOBAL_SESSION_START_LIMIT);

    now += 60_000;
    const afterWindow = await worker.fetch(sessionRequest("198.51.100.21", `Bearer ${SECRET}`), guards.env);
    expect(afterWindow.status).toBe(502);
    fetchMock.mockRestore();
  });

  it("returns 503 from the route when the auth secret is short", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("nope", { status: 500 }));
    const guards = createGuards(() => 80_000);
    guards.env.SESSION_AUTH_SECRET = "short";
    const response = await worker.fetch(sessionRequest("203.0.113.50", "Bearer short"), guards.env);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Session authentication is not configured." });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });
});

describe("worker identifiers", () => {
  it("uses this twin's worker name and namespace id", () => {
    const config = wranglerConfig();
    expect(config.name).toBe(WORKER_NAME);
    expect(config.name).not.toBe("bulk-invoice-contract-review-agent");
    expect(config.ratelimits).toEqual([
      {
        name: "SESSION_ATTEMPT_LIMITER",
        namespace_id: IP_ATTEMPT_NAMESPACE_ID,
        simple: { limit: IP_ATTEMPT_LIMIT, period: IP_ATTEMPT_PERIOD_SECONDS },
      },
    ]);
    expect(config.durable_objects.bindings).toEqual([
      { name: "SESSION_START_LIMITER", class_name: "SessionStartLimiter" },
    ]);
    expect(config.migrations[0]?.new_sqlite_classes).toEqual(["SessionStartLimiter"]);
    expect(config.migrations[0]?.tag).toBe("v1-github-issue-investigation-agent-session-start");
    expect(SESSION_START_OBJECT_NAME).toBe(WORKER_NAME);
    expect(timingSafeEqualString(SECRET, SECRET)).toBe(true);
    expect(timingSafeEqualString(SECRET, `${SECRET}x`)).toBe(false);
  });
});
