export const WORKER_NAME = "github-issue-investigation-agent";

/** Durable Object instance that holds this worker's global session-start window. */
export const SESSION_START_OBJECT_NAME = "github-issue-investigation-agent";

/**
 * Rate Limiting binding namespace for pre-auth attempts.
 * Must stay unique to this worker so twins do not share a counter.
 */
export const IP_ATTEMPT_NAMESPACE_ID = "github-issue-investigation-agent-session-attempts";

export const IP_ATTEMPT_LIMIT = 30;
export const IP_ATTEMPT_PERIOD_SECONDS = 60;

export const GLOBAL_SESSION_START_LIMIT = 10;
export const GLOBAL_SESSION_START_WINDOW_MS = 60_000;
export const MIN_SESSION_AUTH_SECRET_CHARS = 32;

const MAX_CONNECTING_IP_CHARS = 128;

export interface AttemptLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface SessionStartGate {
  consume(): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
}

export interface SessionStartLimiterNamespace {
  getByName(name: string): SessionStartGate;
}

export interface SessionGuardEnv {
  SESSION_AUTH_SECRET?: string;
  SESSION_ATTEMPT_LIMITER: AttemptLimiter;
  SESSION_START_LIMITER: SessionStartLimiterNamespace;
}

export interface WindowState {
  windowStartMs: number;
  count: number;
}

export function attemptKeyFromConnectingIp(header: string | null): string {
  const ip = header?.trim() ?? "";
  if (!ip || ip.length > MAX_CONNECTING_IP_CHARS) return "ip:unknown";
  return `ip:${ip}`;
}

export function consumeFixedWindow(
  state: WindowState | null,
  nowMs: number,
  limit: number,
  windowMs: number,
): { allowed: boolean; state: WindowState; retryAfterSeconds: number } {
  const expired = !state || nowMs - state.windowStartMs >= windowMs;
  const windowStartMs = expired ? nowMs : state.windowStartMs;
  const count = expired ? 0 : state.count;
  if (count >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((windowStartMs + windowMs - nowMs) / 1000));
    return { allowed: false, state: { windowStartMs, count }, retryAfterSeconds };
  }
  return {
    allowed: true,
    state: { windowStartMs, count: count + 1 },
    retryAfterSeconds: 0,
  };
}

export function readBearerToken(authorization: string | null): string | null {
  if (!authorization) return null;
  const prefix = "bearer ";
  if (authorization.length <= prefix.length) return null;
  if (authorization.slice(0, prefix.length).toLowerCase() !== prefix) return null;
  return authorization.slice(prefix.length);
}

export function timingSafeEqualString(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let diff = leftBytes.length === rightBytes.length ? 0 : 1;
  for (let index = 0; index < length; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return diff === 0;
}

export async function enforceSessionStartPolicy(
  request: Request,
  env: SessionGuardEnv,
): Promise<Response | null> {
  const attemptKey = attemptKeyFromConnectingIp(request.headers.get("CF-Connecting-IP"));
  let attempt: { success: boolean };
  try {
    attempt = await env.SESSION_ATTEMPT_LIMITER.limit({ key: attemptKey });
  } catch {
    return jsonResponse({ error: "Session start protection is unavailable." }, 503);
  }
  if (!attempt.success) {
    return rateLimited("Too many session start attempts.", IP_ATTEMPT_PERIOD_SECONDS);
  }

  const secret = env.SESSION_AUTH_SECRET ?? "";
  if (secret.length < MIN_SESSION_AUTH_SECRET_CHARS) {
    return jsonResponse({ error: "Session authentication is not configured." }, 503);
  }

  const presented = readBearerToken(request.headers.get("Authorization"));
  if (presented === null || !timingSafeEqualString(presented, secret)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let start: { allowed: boolean; retryAfterSeconds: number };
  try {
    start = await env.SESSION_START_LIMITER.getByName(SESSION_START_OBJECT_NAME).consume();
  } catch {
    return jsonResponse({ error: "Session start protection is unavailable." }, 503);
  }
  if (!start.allowed) {
    return rateLimited("Session start rate limit exceeded.", start.retryAfterSeconds);
  }

  return null;
}

export function jsonResponse(body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body, null, 2), { status, headers });
}

function rateLimited(message: string, retryAfterSeconds: number): Response {
  return jsonResponse(
    { error: message },
    429,
    { "Retry-After": String(retryAfterSeconds) },
  );
}
