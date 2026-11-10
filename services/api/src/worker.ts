/** Cloudflare Worker entry: HTTP API + cron-driven scheduler ticks (staging only until production is approved). */
import { createApp } from "./app.ts";
import type { Env } from "./lib/env.ts";
import { defaultHandlers } from "./orchestration/handlers.ts";
import { enqueue, tick } from "./orchestration/engine.ts";
import { seedRegistry } from "./domain/seed.ts";
import { REGISTRY_DATA } from "./domain/registry-data.ts";
import { enqueueDue, seedSchedules, seedOperatorRegistry, OPERATOR_SCHEDULES } from "@forge/operator";

const handlers = defaultHandlers();
const app = createApp({ handlers });

/** Enqueue the recurring FORGE jobs for this time slot (idempotent), then run a tick. */
export async function scheduledTick(env: Env, now = new Date()): Promise<void> {
  const hour = now.toISOString().slice(0, 13);
  const quarter = `${hour}:${String(Math.floor(now.getUTCMinutes() / 15) * 15).padStart(2, "0")}`;
  await seedRegistry(env.DB, REGISTRY_DATA); // idempotent; guarantees registry rows exist before jobs reference them
  await enqueue(env.DB, handlers, { kind: "ledger.sync", idempotencyKey: `ledger.sync:${hour}`, createdBy: "cron", runAt: now.toISOString() });
  await enqueue(env.DB, handlers, { kind: "n8n.sync", idempotencyKey: `n8n.sync:${hour}`, createdBy: "cron", runAt: now.toISOString() });
  await enqueue(env.DB, handlers, { kind: "heartbeat.watchdog", idempotencyKey: `heartbeat.watchdog:${quarter}`, createdBy: "cron", runAt: now.toISOString() });
  await seedOperatorRegistry(env.DB);                 // idempotent
  await seedSchedules(env.DB, OPERATOR_SCHEDULES);    // git is the source of truth for schedules
  // One job per due schedule slot. Not in the unit-test environment: Operator jobs make real read-only GETs to the live sites.
  if (env.ENVIRONMENT !== "test") await enqueueDue(env.DB, handlers, now);
  await tick(env.DB, env, handlers, { workerId: "cron", now });
}

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => app.fetch(req, env, ctx),
  scheduled: (_e: ScheduledController, env: Env, ctx: ExecutionContext) => { ctx.waitUntil(scheduledTick(env)); },
} satisfies ExportedHandler<Env>;
