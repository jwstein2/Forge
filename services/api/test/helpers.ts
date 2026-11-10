import { join } from "node:path";
import { NodeD1, applyMigrations } from "../src/lib/node-d1.ts";
import type { Env } from "../src/lib/env.ts";
import { seedRegistry } from "../src/domain/seed.ts";
import { REGISTRY_DATA } from "../src/domain/registry-data.ts";
import { createApp } from "../src/app.ts";
import { defaultHandlers } from "../src/orchestration/handlers.ts";
import type { HandlerDef } from "../src/orchestration/engine.ts";

export const DEV_TOKEN = "test-token-0123456789abcdef";
export const OWNER = "owner@forge.test";

export async function makeEnv(opts: { seed?: boolean; environment?: Env["ENVIRONMENT"] } = {}): Promise<{ env: Env; d1: NodeD1 }> {
  const d1 = new NodeD1(":memory:");
  applyMigrations(d1, join(import.meta.dirname, "..", "migrations"));
  const env: Env = { DB: d1.asD1(), ENVIRONMENT: opts.environment ?? "test", OWNER_EMAILS: OWNER, DEV_AUTH_TOKEN: DEV_TOKEN, HEARTBEAT_SECRET: "hb-secret-for-tests" };
  if (opts.seed !== false) await seedRegistry(env.DB, REGISTRY_DATA);
  return { env, d1 };
}

export function makeApp(handlers: Map<string, HandlerDef> = defaultHandlers()) {
  const app = createApp({ handlers });
  return {
    app,
    call: async (env: Env, method: string, path: string, body?: unknown, headers: Record<string, string> = { "x-forge-dev-token": DEV_TOKEN }) => {
      const res = await app.fetch(new Request(`http://t/api/v1${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
      return { status: res.status, headers: res.headers, json: (await res.json()) as any };
    },
  };
}

/** Walk any JSON value and return every object that looks like a Metric. */
export function collectMetrics(v: unknown, out: any[] = []): any[] {
  if (Array.isArray(v)) v.forEach((x) => collectMetrics(x, out));
  else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("value" in o && "unit" in o && "state" in o && "period" in o) out.push(o);
    Object.values(o).forEach((x) => collectMetrics(x, out));
  }
  return out;
}
