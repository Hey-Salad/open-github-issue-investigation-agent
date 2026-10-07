import { DurableObject } from "cloudflare:workers";
import {
  consumeFixedWindow,
  GLOBAL_SESSION_START_LIMIT,
  GLOBAL_SESSION_START_WINDOW_MS,
  type WindowState,
} from "./session-guard";

const SESSION_START_BUCKET = "session-start";

export class SessionStartLimiter extends DurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS windows (
          bucket TEXT PRIMARY KEY,
          window_start_ms INTEGER NOT NULL,
          count INTEGER NOT NULL
        )
      `);
    });
  }

  async consume(): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    const nowMs = Date.now();
    const existing = this.ctx.storage.sql
      .exec<{ window_start_ms: number; count: number }>(
        "SELECT window_start_ms, count FROM windows WHERE bucket = ?",
        SESSION_START_BUCKET,
      )
      .toArray()[0];
    const current: WindowState | null = existing
      ? { windowStartMs: existing.window_start_ms, count: existing.count }
      : null;
    const decision = consumeFixedWindow(
      current,
      nowMs,
      GLOBAL_SESSION_START_LIMIT,
      GLOBAL_SESSION_START_WINDOW_MS,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO windows (bucket, window_start_ms, count)
       VALUES (?, ?, ?)
       ON CONFLICT(bucket) DO UPDATE SET
         window_start_ms = excluded.window_start_ms,
         count = excluded.count`,
      SESSION_START_BUCKET,
      decision.state.windowStartMs,
      decision.state.count,
    );
    return { allowed: decision.allowed, retryAfterSeconds: decision.retryAfterSeconds };
  }
}
