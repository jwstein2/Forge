import { join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { NodeD1, applyMigrations } from "../../../services/api/src/lib/node-d1.ts";
import type { Env } from "../../../services/api/src/lib/env.ts";
import { seedRegistry } from "../../../services/api/src/domain/seed.ts";
import { REGISTRY_DATA } from "../../../services/api/src/domain/registry-data.ts";
import { tick, type HandlerDef } from "../../../services/api/src/orchestration/engine.ts";
import { defaultHandlers } from "../../../services/api/src/orchestration/handlers.ts";
import { operatorHandlers, seedOperatorRegistry, type OperatorDeps } from "../src/index.ts";
import type { Fetcher, FetchResult } from "../src/lib.ts";

export async function makeEnv(): Promise<{ env: Env; db: D1Database; d1: NodeD1 }> {
  const d1 = new NodeD1(":memory:");
  applyMigrations(d1, join(import.meta.dirname, "..", "..", "..", "services", "api", "migrations"));
  // The platform copies our migrations into services/api/migrations; apply any of ours it does not have yet.
  const platformDir = join(import.meta.dirname, "..", "..", "..", "services", "api", "migrations");
  const have = new Set(readdirSync(platformDir));
  const mine = join(import.meta.dirname, "..", "migrations");
  for (const f of readdirSync(mine).filter((f) => f.endsWith(".sql")).sort()) if (!have.has(f)) d1.db.exec(readFileSync(join(mine, f), "utf8"));
  const env = { DB: d1.asD1(), ENVIRONMENT: "test", OWNER_EMAILS: "owner@forge.test" } as Env;
  await seedRegistry(env.DB, REGISTRY_DATA);
  await seedOperatorRegistry(env.DB);
  return { env, db: env.DB, d1 };
}

export function handlersWith(deps: OperatorDeps): Map<string, HandlerDef> {
  const m = defaultHandlers();
  for (const h of operatorHandlers(deps)) m.set(h.kind, h);
  return m;
}

export const run = (env: Env, handlers: Map<string, HandlerDef>, now = new Date()) => tick(env.DB, env, handlers, { workerId: "test", now });

/** Fake HTTP: exact URL → response; anything else 404. */
export function fakeFetcher(routes: Record<string, Partial<FetchResult> | string>): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    const r = routes[url];
    if (r === undefined) return { ok: false, status: 404, text: "not found", latencyMs: 5 };
    if (typeof r === "string") return { ok: true, status: 200, text: r, latencyMs: 5 };
    return { ok: r.ok ?? true, status: r.status === undefined ? 200 : r.status, text: r.text ?? "", latencyMs: r.latencyMs ?? 5, error: r.error, probeError: r.probeError };
  }) as Fetcher & { calls: string[] };
  f.calls = calls;
  return f;
}

export const brief = (n: string) => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", `${n}.brief.json`), "utf8"));

export const page = (o: { title?: string; desc?: string; canonical?: string; h1?: boolean; body?: string } = {}) =>
  `<!doctype html><html lang="en"><head>${o.title === undefined ? "" : `<title>${o.title}</title>`}<meta name="viewport" content="width=device-width">${o.desc ? `<meta name="description" content="${o.desc}">` : ""}${o.canonical ? `<link rel="canonical" href="${o.canonical}">` : ""}</head><body>${o.h1 === false ? "" : "<h1>Heading</h1>"}${o.body ?? ""}</body></html>`;

/** A healthy copy of all three live sites plus the shared Worker. */
export function healthySites(extra: Record<string, Partial<FetchResult> | string> = {}) {
  const sites = { bidline: ["https://bidline.pages.dev", "Bidline"], qpk: ["https://quiltplankit.pages.dev", "Quilt Plan Kit"], loaf: ["https://loaf-ledger.pages.dev", "Loaf Ledger"] } as const;
  const r: Record<string, Partial<FetchResult> | string> = { "https://quiltplankit-sales.sales-webhook.workers.dev/health": '{"ok":true}' };
  for (const [base, name] of Object.values(sites)) {
    r[`${base}/`] = page({ title: name, desc: `${name} tools`, canonical: `${base}/`, body: name });
    r[`${base}/robots.txt`] = `User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml`;
    r[`${base}/sitemap.xml`] = `<?xml version="1.0"?><urlset><url><loc>${base}/</loc></url></urlset>`;
  }
  r["https://quiltplankit.pages.dev/pins.xml"] = `<rss><channel><item><title>Binding</title><link>https://quiltplankit.pages.dev/calculators/binding</link><pubDate>Fri, 06 Nov 2026 19:00:00 GMT</pubDate></item></channel></rss>`;
  return { ...r, ...extra };
}
