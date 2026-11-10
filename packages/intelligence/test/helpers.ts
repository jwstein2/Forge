import { join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { NodeD1, applyMigrations } from "../../../services/api/src/lib/node-d1.ts";
import type { Env } from "../../../services/api/src/lib/env.ts";
import { seedRegistry } from "../../../services/api/src/domain/seed.ts";
import { REGISTRY_DATA } from "../../../services/api/src/domain/registry-data.ts";
import { tick, type HandlerDef } from "../../../services/api/src/orchestration/engine.ts";
import { defaultHandlers } from "../../../services/api/src/orchestration/handlers.ts";
import { intelligenceHandlers, seedIntelligenceRegistry } from "../src/index.ts";
import type { Fetcher, FetchResult } from "../src/fetch.ts";
import type { EvidencePack, PackCandidate } from "../src/types.ts";

export async function makeEnv(extra: Record<string, string> = {}): Promise<{ env: Env; db: D1Database; d1: NodeD1 }> {
  const d1 = new NodeD1(":memory:");
  const platformDir = join(import.meta.dirname, "..", "..", "..", "services", "api", "migrations");
  applyMigrations(d1, platformDir);
  const have = new Set(readdirSync(platformDir));
  const mine = join(import.meta.dirname, "..", "migrations");
  for (const f of readdirSync(mine).filter((f) => f.endsWith(".sql")).sort()) if (!have.has(f)) d1.db.exec(readFileSync(join(mine, f), "utf8"));
  const env = { DB: d1.asD1(), ENVIRONMENT: "test", OWNER_EMAILS: "owner@forge.test", ...extra } as unknown as Env;
  await seedRegistry(env.DB, REGISTRY_DATA);
  await seedIntelligenceRegistry(env.DB);
  return { env, db: env.DB, d1 };
}

export function handlersWith(fetcher: Fetcher): Map<string, HandlerDef> {
  const m = defaultHandlers();
  for (const h of intelligenceHandlers({ fetcher })) m.set(h.kind, h);
  return m;
}

export const run = (env: Env, handlers: Map<string, HandlerDef>, now = new Date()) => tick(env.DB, env, handlers, { workerId: "test", now });

export async function drain(env: Env, handlers: Map<string, HandlerDef>, now = new Date(), max = 40) {
  for (let i = 0; i < max; i++) {
    await run(env, handlers, now);
    const open = await env.DB.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')`).first<{ n: number }>();
    if (!open?.n) return i;
  }
  throw new Error("jobs did not drain");
}

/** Fake HTTP: exact URL -> response; a RegExp key matches by pattern; anything else 404. */
export function fakeFetcher(routes: Record<string, Partial<FetchResult> | string>, patterns: [RegExp, Partial<FetchResult> | string][] = []): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    const r = routes[url] ?? patterns.find(([re]) => re.test(url))?.[1];
    if (r === undefined) return { ok: false, status: 404, text: "not found" };
    if (typeof r === "string") return { ok: true, status: 200, text: r };
    return { ok: r.ok ?? true, status: r.status === undefined ? 200 : r.status, text: r.text ?? "", error: r.error };
  }) as Fetcher & { calls: string[] };
  f.calls = calls;
  return f;
}

export const fixture = (n: string) => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", n), "utf8"));

/** 60 months of synthetic pageviews peaking in Dec and trough in Jun. */
export function pageviewsJson(base = 1000) {
  const items = [];
  for (let y = 2021; y <= 2026; y++) for (let m = 1; m <= 12; m++) {
    if ((y === 2021 && m < 11) || (y === 2026 && m > 10)) continue;
    const season = m === 12 ? 1.6 : m === 11 ? 1.3 : m === 6 ? 0.7 : 1;
    items.push({ timestamp: `${y}${String(m).padStart(2, "0")}0100`, views: Math.round(base * season * (1 + (y - 2021) * 0.02)) });
  }
  return JSON.stringify({ items });
}

const crit = (key: string, score: number | null, evidence: string, claim_ids?: string[]) => ({ key, score, evidence, rationale: `${key} test`, ...(claim_ids ? { claim_ids } : {}) });
const gatesPass = [{ key: "no_licensed_advice", passed: true }, { key: "budget", passed: true }, { key: "free_channel", passed: true }, { key: "ip_clean", passed: true }];

function candidate(key: string, opts: { demandEv?: string; demandClaim?: string; scores?: number; gates?: { key: string; passed: boolean }[]; articles?: string[] } = {}): PackCandidate {
  const s = opts.scores ?? 4;
  return {
    key, title: `Test ${key}`, customer_segment: "testers", problem: "a problem",
    proposed_offer: { model: "one_time_digital", description: "a kit", price: { value: 15, currency: "USD", evidence: "INFERRED" } },
    confidence: "medium",
    claims: [
      { id: `c_${key.replace(/-/g, "_")}_sales`, statement: "Listing shows 1.8k sales", evidence: "VERIFIED", confidence: "high", method: "marketplace_listing_observation", source_ids: [`src_${key.replace(/-/g, "_")}_listing`], observed_at: "2026-11-10" },
      { id: `c_${key.replace(/-/g, "_")}_price`, statement: "Priced at $18.00", evidence: "VERIFIED", confidence: "high", method: "product_page_observation", source_ids: [`src_${key.replace(/-/g, "_")}_listing`], observed_at: "2026-11-10" },
    ],
    criterion_scores: [
      crit("demand_evidence", s, opts.demandEv ?? "VERIFIED", [opts.demandClaim ?? `c_${key.replace(/-/g, "_")}_sales`]),
      crit("willingness_to_pay", s, "VERIFIED", [`c_${key.replace(/-/g, "_")}_price`]),
      crit("competition_gap", 3, "INFERRED"), crit("unit_economics", 4, "INFERRED"), crit("time_to_first_revenue", 4, "INFERRED"),
      crit("infrastructure_reuse", 4, "INFERRED"), crit("acquisition_channel_fit", 3, "INFERRED"), crit("seasonal_timing", 3, "INFERRED"),
      crit("low_support_load", 4, "INFERRED"), crit("low_risk", 4, "INFERRED"), crit("strategic_fit", 3, "INFERRED"),
    ] as PackCandidate["criterion_scores"],
    gates: opts.gates ?? gatesPass,
    ...(opts.articles ? { signals: { wikipedia_articles: opts.articles } } : {}),
  };
}

export function testPack(): EvidencePack {
  const src = (key: string) => ({ id: `src_${key.replace(/-/g, "_")}_listing`, title: `${key} listing`, url: `https://shop.example/${key}`, kind: "marketplace_listing", accessed_at: "2026-11-10", expect: ["$18.00", "1.8k sales"] });
  return {
    schema: "forge.evidence-pack/1", label: "test pack", prepared_by: "test", prepared_at: "2026-11-10T00:00:00Z",
    sources: [src("alpha-kit"), src("beta-kit"), src("gamma-kit"), src("delta-kit")],
    candidates: [
      candidate("alpha-kit", { scores: 5, articles: ["Alpha"] }),
      candidate("beta-kit", { scores: 4 }),
      candidate("gamma-kit", { scores: 3 }),
      candidate("delta-kit", { scores: 5, gates: [...gatesPass.filter((g) => g.key !== "ip_clean"), { key: "ip_clean", passed: false }] }),
    ],
  };
}
export const listingPage = "<html><body><h1>Kit</h1><p>Price $18.00</p><p>1.8k sales</p></body></html>";
