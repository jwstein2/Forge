/** Cloudflare Worker entry: HTTP API + cron-driven scheduler ticks (staging only until production is approved). */
import { createApp } from "./app.ts";
import type { Env } from "./lib/env.ts";
import { defaultHandlers } from "./orchestration/handlers.ts";
import { enqueue, tick } from "./orchestration/engine.ts";
import { hmacSha256Hex, timingSafeEqualHex } from "./lib/util.ts";
import { seedRegistry } from "./domain/seed.ts";
import { REGISTRY_DATA } from "./domain/registry-data.ts";
import { enqueueDue, seedSchedules, seedOperatorRegistry, OPERATOR_SCHEDULES } from "@forge/operator";

const handlers = defaultHandlers();
export const CRON_MAX_JOBS = 3; // ~288 job slots a day; recurring load is ~180 (watchdog 96, syncs 48, operator ~35)

/** Cheap, synchronous fingerprint of the seed data (FNV-1a). Seeding is skipped when it is unchanged since the last tick. */
function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}
let seedPrint: string | null = null; // computed once per isolate
async function seedIfChanged(env: Env): Promise<void> {
  seedPrint ??= fingerprint(JSON.stringify([REGISTRY_DATA, OPERATOR_SCHEDULES]));
  const row = await env.DB.prepare(`SELECT value_json FROM system_controls WHERE key = 'seed:fingerprint'`).first<{ value_json: string }>();
  if (row && JSON.parse(row.value_json) === seedPrint) return;
  await seedRegistry(env.DB, REGISTRY_DATA);
  await seedOperatorRegistry(env.DB);
  await seedSchedules(env.DB, OPERATOR_SCHEDULES);
  await env.DB.prepare(`INSERT INTO system_controls (key,value_json,updated_by,updated_at) VALUES ('seed:fingerprint',?,'cron',?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`).bind(JSON.stringify(seedPrint), new Date().toISOString()).run();
}
const app = createApp({ handlers });

/** Enqueue the recurring FORGE jobs for this time slot (idempotent), then run a tick. */
export async function scheduledTick(env: Env, now = new Date()): Promise<void> {
  const hour = now.toISOString().slice(0, 13);
  const quarter = `${hour}:${String(Math.floor(now.getUTCMinutes() / 15) * 15).padStart(2, "0")}`;
  await seedIfChanged(env); // registry rows and schedules must exist before jobs reference them; skipped when unchanged
  await enqueue(env.DB, handlers, { kind: "ledger.sync", idempotencyKey: `ledger.sync:${hour}`, createdBy: "cron", runAt: now.toISOString() });
  await enqueue(env.DB, handlers, { kind: "n8n.sync", idempotencyKey: `n8n.sync:${hour}`, createdBy: "cron", runAt: now.toISOString() });
  await enqueue(env.DB, handlers, { kind: "heartbeat.watchdog", idempotencyKey: `heartbeat.watchdog:${quarter}`, createdBy: "cron", runAt: now.toISOString() });
  // One job per due schedule slot. Not in the unit-test environment: Operator jobs make real read-only GETs to the live sites.
  if (env.ENVIRONMENT !== "test") await enqueueDue(env.DB, handlers, now);
  // Free-plan limits are per invocation (10 ms CPU, 50 subrequests incl. D1 queries). The first staging cron ran ten jobs in
  // one invocation and hit "Too many subrequests". So each job runs in its OWN invocation via the SELF service binding;
  // without the binding (dev, tests) jobs run inline. At most CRON_MAX_JOBS per tick; the rest wait (jobs are durable).
  const token = await internalToken(env);
  for (let i = 0; i < CRON_MAX_JOBS; i++) {
    if (env.SELF && token) {
      const res = await env.SELF.fetch(INTERNAL_TICK_URL, { method: "POST", headers: { [INTERNAL_HEADER]: token } });
      const body = (await res.json().catch(() => null)) as { ran?: number } | null;
      if (!res.ok || !body?.ran) break; // nothing runnable (or the child failed): stop for this tick
    } else {
      const ran = await tick(env.DB, env, handlers, { workerId: "cron", now, maxJobs: 1 });
      if (!ran.length) break;
    }
  }
}

const INTERNAL_TICK_URL = "https://forge.internal/api/internal/tick"; // under /api/* so static assets never answer it
const INTERNAL_HEADER = "x-forge-internal";
/** Token for the internal tick route, derived from HEARTBEAT_SECRET (first value if rotating). No secret, no route. */
async function internalToken(env: Env): Promise<string | null> {
  const secret = env.HEARTBEAT_SECRET?.split(",")[0]?.trim();
  return secret && secret.length >= 32 ? hmacSha256Hex(secret, "forge-internal-tick-v1") : null;
}

/** Runs exactly one job in this invocation. Reachable only with the derived token; external requests also pass Cloudflare Access first. */
export async function internalTick(req: Request, env: Env): Promise<Response> {
  const token = await internalToken(env);
  const got = req.headers.get(INTERNAL_HEADER) ?? "";
  if (req.method !== "POST" || !token || got.length !== token.length || !timingSafeEqualHex(got, token)) {
    return new Response(JSON.stringify({ ok: false }), { status: 404, headers: { "content-type": "application/json" } });
  }
  const ran = await tick(env.DB, env, handlers, { workerId: "cron-child", maxJobs: 1 });
  return new Response(JSON.stringify({ ok: true, ran: ran.length, outcomes: ran.map((r) => r.outcome) }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) =>
    new URL(req.url).pathname === "/api/internal/tick" ? internalTick(req, env) : app.fetch(req, env, ctx),
  scheduled: (_e: ScheduledController, env: Env, ctx: ExecutionContext) => { ctx.waitUntil(scheduledTick(env)); },
} satisfies ExportedHandler<Env>;
