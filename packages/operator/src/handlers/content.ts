/**
 * The marketing content pipeline: plan → draft → approve → publish → verify.
 *
 *  ops.content_plan   Deterministic. Reads each niche's Audience & Market Brief (seasonality, channel fit) and creates
 *                     dated content items for upcoming seasonal windows on channels the brief rates strong/moderate.
 *  ops.content_draft  Bounded model step. Drafts copy for planned items from the same brief; output is JSON-validated
 *                     and claims-linted (no invented proof). No provider connected → items stay `planned`, visibly.
 *  ops.content_publish Publishes approved items through the channel's publisher adapter, within the channel policy.
 *                     Default policy is draft_only; only `dry_run` and `manual` publishers exist until the owner approves live ones.
 *  ops.content_verify Confirms a published item from the platform's own URL/feed before marking it verified and
 *                     updating the channel's last verified publication. Self-reported success never counts.
 */
import type { HandlerDef } from "../../../../services/api/src/orchestration/engine.ts";
import { addEvidence, nowIso, newId, raiseAlert, resolveAlert, type Fetcher } from "../lib.ts";
import { boundedJsonCall, type LlmProvider, type Validator } from "../llm.ts";

const DAY = 86400000;

// ---------------------------------------------------------------- briefs
export interface BriefLike {
  brief_id?: string; niche: string; version: string; display_name?: string; summary?: unknown;
  audience?: unknown; pains?: unknown; desired_outcomes?: unknown; objections?: unknown;
  demand?: { seasonality?: { event: string; demand_window: string; publish_by: string; assets?: string[]; evidence?: { evidence?: string } }[] };
  channel_fit?: { channel: string; fit: string }[];
}

export async function latestBriefs(db: D1Database): Promise<BriefLike[]> {
  const rows = (await db.prepare(`SELECT niche_id, version, content_json, created_at FROM market_briefs WHERE status <> 'superseded' ORDER BY niche_id, created_at DESC`).all<{ niche_id: string; version: string; content_json: string }>()).results;
  const seen = new Set<string>(); const out: BriefLike[] = [];
  for (const r of rows) { if (seen.has(r.niche_id)) continue; seen.add(r.niche_id); try { out.push(JSON.parse(r.content_json)); } catch { /* skip corrupt */ } }
  return out;
}

/** Brief channel names → automatable platforms. Community channels are owner-participation only and never automated. */
export function platformFor(channel: string): string | null {
  const c = channel.toLowerCase();
  if (c.includes("pinterest")) return "pinterest";
  if (c.includes("email")) return "email";
  if (c.includes("organic search") || c === "seo") return "seo";
  if (c.includes("instagram")) return "instagram";
  if (c.includes("youtube")) return "youtube";
  return null; // Facebook groups, Reddit, forums: no automated posting
}

const md = (s: string): [number, number] => { const m = /^(\d{2})-(\d{2})$/.exec(s); if (!m) throw new Error(`bad MM-DD "${s}"`); return [Number(m[1]) - 1, Number(m[2])]; };
const utc = (y: number, [mo, d]: [number, number]) => new Date(Date.UTC(y, mo, d));

/** The current or next occurrence of a seasonal window and its publish-by date. */
export function nextWindow(s: { demand_window: string; publish_by: string }, now: Date): { start: Date; end: Date; publishBy: Date } {
  const [a, b] = s.demand_window.split("/"); if (!a || !b) throw new Error(`bad window "${s.demand_window}"`);
  for (const y of [now.getUTCFullYear() - 1, now.getUTCFullYear(), now.getUTCFullYear() + 1]) {
    const start = utc(y, md(a)); let end = utc(y, md(b));
    if (end < start) end = utc(y + 1, md(b));
    end = new Date(end.getTime() + DAY - 1);
    if (end.getTime() < now.getTime()) continue;
    let publishBy = utc(start.getUTCFullYear(), md(s.publish_by));
    if (publishBy > start) publishBy = utc(start.getUTCFullYear() - 1, md(s.publish_by));
    return { start, end, publishBy };
  }
  throw new Error("unreachable");
}

export interface PlannedItem { planKey: string; nicheId: string; platform: string; title: string; event: string; briefRef: string; evidence: string; publishBy: string; windowStart: string; windowEnd: string; late: boolean }

export function planFromBrief(brief: BriefLike, now: Date, horizonDays = 120): PlannedItem[] {
  const platforms = [...new Set((brief.channel_fit ?? []).filter((c) => ["strong", "moderate"].includes(c.fit)).map((c) => platformFor(c.channel)).filter((p): p is string => !!p))];
  const out: PlannedItem[] = [];
  for (const s of brief.demand?.seasonality ?? []) {
    const w = nextWindow(s, now);
    if (w.publishBy.getTime() - now.getTime() > horizonDays * DAY) continue;
    const late = now.getTime() > w.publishBy.getTime();
    for (const asset of s.assets ?? []) for (const p of platforms) {
      out.push({
        planKey: `${brief.niche}|${s.event}|${asset}|${p}|${w.start.getUTCFullYear()}`, nicheId: brief.niche, platform: p, title: asset, event: s.event,
        briefRef: `${brief.brief_id ?? brief.niche}@${brief.version}`, evidence: s.evidence?.evidence ?? "UNKNOWN",
        publishBy: w.publishBy.toISOString().slice(0, 10), windowStart: w.start.toISOString().slice(0, 10), windowEnd: w.end.toISOString().slice(0, 10), late,
      });
    }
  }
  return out;
}

export function contentPlan(): HandlerDef {
  return {
    kind: "ops.content_plan",
    registryId: "OPS-CONTENT-PLAN",
    steps: [{
      name: "plan",
      async run({ db, input, now }) {
        const briefs = (input.briefs as BriefLike[] | undefined) ?? await latestBriefs(db);
        const niches = new Set((await db.prepare(`SELECT id FROM niches WHERE paused = 0`).all<{ id: string }>()).results.map((n) => n.id));
        let created = 0; let existing = 0; let expired = 0; const perNiche: Record<string, number> = {};
        for (const b of briefs) {
          if (!niches.has(b.niche)) continue;
          for (const it of planFromBrief(b, now, Number(input.horizonDays ?? 120))) {
            const ch = await db.prepare(`SELECT id FROM channels WHERE niche_id = ? AND platform = ? LIMIT 1`).bind(it.nicheId, it.platform).first<{ id: string }>();
            const r = await db.prepare(`INSERT INTO op_content_items (id,niche_id,channel_id,platform,plan_key,title,season_event,brief_ref,evidence_label,publish_by,window_start,window_end,late,status,note,created_by,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'planned',?,?,?,?) ON CONFLICT(plan_key) DO NOTHING`)
              .bind(newId("ci"), it.nicheId, ch?.id ?? null, it.platform, it.planKey, it.title, it.event, it.briefRef, it.evidence, it.publishBy, it.windowStart, it.windowEnd, it.late ? 1 : 0,
                ch ? null : `No ${it.platform} channel exists for this niche yet; item is planning-only.`, "ops.content_plan", nowIso(), nowIso()).run();
            if (Number(r.meta.changes)) { created++; perNiche[it.nicheId] = (perNiche[it.nicheId] ?? 0) + 1; } else existing++;
          }
        }
        // Windows that closed without publication expire (kept for the record, out of the queue).
        const ex = await db.prepare(`UPDATE op_content_items SET status='expired', updated_at=? WHERE status IN ('planned','drafted','needs_revision','approved') AND window_end < ?`).bind(nowIso(), now.toISOString().slice(0, 10)).run();
        expired = Number(ex.meta.changes ?? 0);
        return { output: { briefs: briefs.map((b) => `${b.niche}@${b.version}`), created, existing, expired, perNiche } };
      },
    }],
  };
}

// ---------------------------------------------------------------- claims lint
// Invented proof and outcome promises are refused at draft, owner approval and publish time (QA-005 V2).
// Figures: a money amount must be one of the niche's real product prices; any percentage is refused
// (FORGE has no verified outcome data to support one). Measurements such as "2 1/2 in" are allowed.
const CLAIM_RULES: [RegExp, string][] = [
  [/\b(guarantee[ds]?|risk[- ]free|money[- ]back|satisfaction|no[- ]questions[- ]asked)\b/i, "guarantee claim"],
  [/#\s?1\b|\bnumber one\b|\bbest[- ]selling\b|\bmost popular\b|\b(the|our) best\b|\bbest\s+\w+\s+(spreadsheet|template|calculator|planner|tool|kit|workbook)\b|\btop[- ]rated\b|\bleading (?!to\b)\w+|\bindustry[- ]leading\b|\bultimate\b|\bworld[- ]class\b|\bunbeatable\b/i, "unsupported superlative"],
  [/\b(thousands|hundreds|millions|tons|lots) of\b|\ba (thousand|hundred|million)\b/i, "unsupported volume claim"],
  [/\b\d[\d,.]*\s*k?\+?\s+(customers|users|quilters|bakers|contractors|downloads|buyers|happy|people|businesses|makers|members|subscribers)\b/i, "unsupported customer count"],
  [/\b(loved|trusted|used|chosen|preferred|recommended|relied on)\s+by\b|\b(fan|crowd|customer)[- ]favou?rite\b|\beveryone('s| is)\b|\bswears? by\b|\braving\b|\brave reviews?\b|\bgame[- ]changer\b/i, "social proof that FORGE cannot verify"],
  [/\b(testimonials?|reviews?|customers? (say|love|rave)|rated \d|\d(\.\d)?\s*(stars?|\/\s*5|out of (5|five)))\b|★|☆|⭐|\b(five|5)[- ]star\b/i, "rating or review FORGE cannot verify"],
  [/(["“”'‘’])[^"“”'‘’\n]{3,200}["“”'‘’]\s*[—–-]+\s*[A-Z]/u, "quoted testimonial with attribution"],
  [/\bas seen (on|in)\b|\bfeatured (on|in)\b/i, "unsupported press claim"],
  [/\bproven\b|\bclinically\b|\bscientifically\b|\bexperts? (agree|say)\b/i, "unsupported proof claim"],
  [/\b(double|triple|10x|2x|3x)\b|\b\d+\s*(x|times) (faster|quicker|more|better|easier)\b|\bin half\b|\bhalve\b|\bpays? for itself\b|\b(raise|boost|increase|grow|cut|slash|reduce)\b[^.\n]{0,40}\b(margins?|profits?|revenue|sales|income|costs?|time)\b[^.\n]{0,20}\d/i, "unsupported performance claim"],
  [/\b(earn|make|save|extra|additional)\b[^.\n]{0,20}\$\s?\d/i, "unsupported financial outcome"],
  [/\d+(\.\d+)?\s*%|\bpercent\b/i, "percentage claim FORGE cannot verify"],
];
export function claimsLint(text: string, allowedPriceCents: number[] = []): string[] {
  const out = CLAIM_RULES.filter(([re]) => re.test(text)).map(([, why]) => why);
  const allowed = new Set(allowedPriceCents.map((c) => Math.round(c)));
  for (const m of text.matchAll(/\$\s?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)/g)) {
    const cents = Math.round(Number(m[1]!.replace(/,/g, "")) * 100);
    if (!allowed.has(cents)) { out.push(`price $${m[1]} is not a current product price`); break; }
  }
  return [...new Set(out)];
}
export async function nichePrices(db: D1Database, nicheId: string): Promise<number[]> {
  const rows = (await db.prepare(`SELECT site_price_cents AS a, checkout_price_cents AS b FROM products WHERE niche_id = ?`).bind(nicheId).all<{ a: number | null; b: number | null }>()).results;
  return rows.flatMap((r) => [r.a, r.b]).filter((x): x is number => typeof x === "number" && x > 0);
}
export const lintDraft = (d: { headline: string; body: string; cta: string }, prices: number[] = []) => claimsLint(`${d.headline}\n${d.body}\n${d.cta}`, prices);

// ---------------------------------------------------------------- receipts
// What counts as proof that a post is live on its platform (QA-005 V1). Hosts are parsed, never substring-matched,
// and the niche's own site is never a platform receipt, except for that site's own SEO articles.
export function receiptRule(platform: string, url: string, siteUrl: string | null): { ok: true } | { ok: false; reason: string } {
  let u: URL; try { u = new URL(url); } catch { return { ok: false, reason: "not a URL" }; }
  if (u.protocol !== "https:") return { ok: false, reason: "receipt must be https" };
  const host = u.hostname.toLowerCase();
  let own: string | null = null; try { own = siteUrl ? new URL(siteUrl).hostname.toLowerCase() : null; } catch { own = null; }
  const under = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  if (platform === "seo") return own && host === own && u.pathname !== "/" ? { ok: true } : { ok: false, reason: "SEO receipt must be an article page on the niche's own site" };
  if (own && host === own) return { ok: false, reason: "the niche's own site is not a platform receipt" };
  if (platform === "pinterest") return /^(www\.|[a-z]{2}\.)?pinterest\.(com|co\.uk|ca|com\.au|de|fr|es|it|jp|com\.mx|nz|ie|at|ch|pt|se|dk|nl|be)$/.test(host) && /^\/pin\/\d+\/?$/.test(u.pathname) ? { ok: true } : { ok: false, reason: "Pinterest receipt must be https://pinterest.<tld>/pin/<id>/" };
  if (platform === "youtube") return (under("youtube.com") && ((u.pathname === "/watch" && /^[\w-]{11}$/.test(u.searchParams.get("v") ?? "")) || /^\/shorts\/[\w-]{11}$/.test(u.pathname))) || (host === "youtu.be" && /^\/[\w-]{11}$/.test(u.pathname)) ? { ok: true } : { ok: false, reason: "YouTube receipt must be a watch, shorts or youtu.be video URL" };
  if (platform === "email") {
    const webVersion = (under("mailerlite.com") || under("mailerlite.io")) && /^\/(webview|campaign|campaigns|newsletter|p)\/[\w-]+/.test(u.pathname) && !/^(www\.)?mailerlite\.(com|io)$/.test(host) ? true : false;
    const mlsend = under("mlsend.com") && u.pathname.length > 1;
    return webVersion || mlsend ? { ok: true } : { ok: false, reason: "email receipt must be a MailerLite campaign web-version URL" };
  }
  if (platform === "instagram") return under("instagram.com") && /^\/(p|reel)\/[\w-]+\/?$/.test(u.pathname) ? { ok: true } : { ok: false, reason: "Instagram receipt must be a /p/ or /reel/ URL" };
  return { ok: false, reason: `no receipt rule for platform ${platform}` };
}

// ---------------------------------------------------------------- drafting
export interface Draft { headline: string; body: string; cta: string; linkPath: string }
const LIMITS: Record<string, { headline: number; body: number }> = {
  pinterest: { headline: 100, body: 500 }, email: { headline: 90, body: 2500 }, seo: { headline: 65, body: 4000 },
  instagram: { headline: 120, body: 2000 }, youtube: { headline: 100, body: 4000 },
};
export const draftValidator = (platform: string, prices: number[] = []): Validator<Draft> => (v) => {
  const o = v as Record<string, unknown>;
  for (const k of ["headline", "body", "cta", "linkPath"]) if (typeof o?.[k] !== "string" || !(o[k] as string).trim()) return { ok: false, error: `field "${k}" must be a non-empty string` };
  const d = o as unknown as Draft; const lim = LIMITS[platform] ?? { headline: 120, body: 3000 };
  if (d.headline.length > lim.headline) return { ok: false, error: `headline is ${d.headline.length} chars; limit ${lim.headline}` };
  if (d.body.length > lim.body) return { ok: false, error: `body is ${d.body.length} chars; limit ${lim.body}` };
  if (!d.linkPath.startsWith("/") || /\s|:\/\//.test(d.linkPath)) return { ok: false, error: "linkPath must be a site-relative path starting with /" };
  const lint = lintDraft(d, prices);
  if (lint.length) return { ok: false, error: `copy makes claims FORGE cannot support: ${lint.join(", ")}. Remove them; describe only what the product does.` };
  return { ok: true, value: d };
};

const SYSTEM = `You write marketing copy for a small owner-run business. Rules that override everything else:
- Describe only what the product or free tool actually does. No testimonials, ratings, customer counts, rankings, guarantees, earnings or savings promises, press mentions.
- Use the customer's own language from the brief. Warm, specific, plain English. No hype words.
- Structure: promise, the pain it removes, the plan (what to do next), a picture of the result. One clear call to action.
- Reply with exactly one JSON object: {"headline": string, "body": string, "cta": string, "linkPath": string (site-relative path, starts with /)}.`;

export function draftPrompt(brief: BriefLike, item: { title: string; platform: string; season_event: string | null; publish_by: string | null }, sitePaths: string[]): string {
  const pick = (v: unknown) => JSON.stringify(v ?? null).slice(0, 2500);
  return `Business: ${brief.display_name ?? brief.niche} (brief ${brief.brief_id ?? brief.niche}@${brief.version}).
Platform: ${item.platform}. Asset to write: "${item.title}". Season: ${item.season_event ?? "evergreen"} (publish by ${item.publish_by ?? "n/a"}).
Audience: ${pick(brief.audience)}
Pains: ${pick(brief.pains)}
Desired outcomes: ${pick(brief.desired_outcomes)}
Objections: ${pick(brief.objections)}
Existing site paths you may link to (choose one): ${sitePaths.slice(0, 40).join(", ") || "/"}`;
}

export function contentDraft(provider: (env: Record<string, unknown>) => LlmProvider | null): HandlerDef {
  return {
    kind: "ops.content_draft",
    registryId: "OPS-CONTENT-DRAFT",
    steps: [{
      name: "draft",
      async run({ db, env, jobId, input }) {
        const limit = Math.min(Number(input.limit ?? 5), 20);
        const capPerItem = Number(input.costCapCentsPerItem ?? 10);
        const items = (await db.prepare(`SELECT * FROM op_content_items WHERE status = 'planned' AND channel_id IS NOT NULL ORDER BY late DESC, publish_by ASC LIMIT ?`).bind(limit).all<Record<string, any>>()).results;
        const p = provider(env as unknown as Record<string, unknown>);
        if (!p) return { output: { drafted: 0, pending: items.length, provider: "none", note: "No model provider connected (needs owner-approved API key); items remain planned." } };
        const briefs = new Map((await latestBriefs(db)).map((b) => [b.niche, b]));
        let drafted = 0; let failed = 0; let cost = 0;
        for (const it of items) {
          const b = briefs.get(it.niche_id); if (!b) continue;
          const paths = (await db.prepare(`SELECT DISTINCT target FROM op_checks WHERE check_kind='seo_page' AND niche_id=? ORDER BY target LIMIT 60`).bind(it.niche_id).all<{ target: string }>()).results.map((r) => { try { return new URL(r.target).pathname; } catch { return ""; } }).filter(Boolean);
          const r = await boundedJsonCall(db, p, { jobId, purpose: `draft:${it.id}`, system: SYSTEM, prompt: draftPrompt(b, it as any, paths), validate: draftValidator(it.platform, await nichePrices(db, it.niche_id)), costCapCents: capPerItem, maxTokens: 1500 });
          cost += r.costCents;
          if (r.ok) { drafted++; await db.prepare(`UPDATE op_content_items SET status='drafted', body_json=?, lint_json='[]', note=NULL, updated_at=? WHERE id=?`).bind(JSON.stringify(r.value), nowIso(), it.id).run(); }
          else { failed++; await db.prepare(`UPDATE op_content_items SET status='needs_revision', note=?, updated_at=? WHERE id=?`).bind(`Draft rejected: ${r.reason}`, nowIso(), it.id).run(); }
        }
        return { output: { drafted, failed, provider: p.id, model: p.model }, costCents: cost };
      },
    }],
  };
}

// ---------------------------------------------------------------- publishing
export interface PublishResult { published: boolean; externalUrl?: string; note: string; preview?: unknown }
export interface Publisher { id: string; live: boolean; publish(item: Record<string, any>, draft: Draft, siteUrl: string): Promise<PublishResult> }

/** Records what would be published. Never marks anything published. */
export const dryRunPublisher: Publisher = {
  id: "dry_run", live: false,
  async publish(item, draft, siteUrl) {
    const preview = item.platform === "pinterest"
      ? { slug: String(item.id), path: draft.linkPath, title: draft.headline, description: draft.body, link: siteUrl.replace(/\/+$/, "") + draft.linkPath }
      : { headline: draft.headline, body: draft.body, cta: draft.cta, link: siteUrl.replace(/\/+$/, "") + draft.linkPath };
    return { published: false, note: "dry run: nothing sent", preview };
  },
};

interface Policy { channel_id: string; mode: string; publisher: string; daily_cap: number; approval_id: string | null; window_end: string | null }

export async function policyFor(db: D1Database, channelId: string, now: Date): Promise<{ mode: string; publisher: string; dailyCap: number; reason?: string }> {
  const p = await db.prepare(`SELECT * FROM op_channel_policies WHERE channel_id = ?`).bind(channelId).first<Policy>();
  if (!p) return { mode: "draft_only", publisher: "dry_run", dailyCap: 0, reason: "no policy (default draft_only)" };
  if (p.mode === "standing") {
    const ap = p.approval_id ? await db.prepare(`SELECT status FROM approvals WHERE id = ?`).bind(p.approval_id).first<{ status: string }>() : null;
    if (ap?.status !== "approved") return { mode: "draft_only", publisher: p.publisher, dailyCap: 0, reason: "standing approval not approved by owner" };
    if (!p.window_end) return { mode: "draft_only", publisher: p.publisher, dailyCap: 0, reason: "standing approval has no end date" };
    if (p.window_end < now.toISOString()) return { mode: "draft_only", publisher: p.publisher, dailyCap: 0, reason: "standing approval window ended" };
  }
  return { mode: p.mode, publisher: p.publisher, dailyCap: p.daily_cap };
}

export function contentPublish(publishers: Map<string, Publisher>): HandlerDef {
  return {
    kind: "ops.content_publish",
    registryId: "OPS-CONTENT-PUBLISH",
    steps: [{
      name: "publish",
      async run({ db, now }) {
        const today = now.toISOString().slice(0, 10);
        const channels = (await db.prepare(`SELECT DISTINCT c.id, n.site_url FROM op_content_items i JOIN channels c ON c.id = i.channel_id JOIN niches n ON n.id = c.niche_id WHERE i.status IN ('drafted','approved') AND n.paused = 0`).all<{ id: string; site_url: string }>()).results;
        const results: Record<string, unknown>[] = [];
        for (const ch of channels) {
          const pol = await policyFor(db, ch.id, now);
          if (pol.mode === "off" || pol.mode === "draft_only") { results.push({ channelId: ch.id, mode: pol.mode, reason: pol.reason ?? null, published: 0 }); continue; }
          const pub = publishers.get(pol.publisher);
          if (!pub) { results.push({ channelId: ch.id, error: `publisher ${pol.publisher} not available in this build` }); continue; }
          const doneToday = Number((await db.prepare(`SELECT COUNT(*) AS n FROM op_content_items WHERE channel_id=? AND substr(published_at,1,10)=?`).bind(ch.id, today).first<{ n: number }>())?.n ?? 0);
          let budget = Math.max(0, pol.dailyCap - doneToday);
          // approval_each: only owner-approved items. standing: drafted items with clean lint are approved under the standing boundary.
          const statuses = pol.mode === "standing" ? ["approved", "drafted"] : ["approved"];
          const items = (await db.prepare(`SELECT * FROM op_content_items WHERE channel_id=? AND status IN (${statuses.map(() => "?").join(",")}) AND body_json IS NOT NULL ORDER BY late DESC, publish_by ASC LIMIT 20`).bind(ch.id, ...statuses).all<Record<string, any>>()).results;
          const previews: unknown[] = []; let published = 0;
          for (const it of items) {
            if (budget <= 0) break;
            const draft = JSON.parse(it.body_json) as Draft;
            if (lintDraft(draft, await nichePrices(db, it.niche_id)).length) { await db.prepare(`UPDATE op_content_items SET status='needs_revision', note='claims lint failed at publish time', updated_at=? WHERE id=?`).bind(nowIso(), it.id).run(); continue; }
            const r = await pub.publish(it, draft, ch.site_url);
            budget--;
            const rule = r.published && r.externalUrl ? receiptRule(it.platform, r.externalUrl, ch.site_url) : null;
            if (rule && !rule.ok) {
              await db.prepare(`UPDATE op_content_items SET publisher=?, note=?, updated_at=? WHERE id=?`).bind(pub.id, `publisher returned an invalid receipt (${rule.reason})`, nowIso(), it.id).run();
              await raiseAlert(db, { key: `ops:publish:receipt:${it.id}`, severity: "warning", nicheId: it.niche_id, source: "ops.content_publish", title: `Publisher ${pub.id} returned an unusable receipt`, detail: `${r.externalUrl}: ${rule.reason}` });
              continue;
            }
            if (r.published && r.externalUrl) {
              published++;
              await db.prepare(`UPDATE op_content_items SET status='published', publisher=?, external_url=?, published_at=?, note=?, updated_at=? WHERE id=?`).bind(pub.id, r.externalUrl, nowIso(), r.note, nowIso(), it.id).run();
            } else {
              previews.push({ contentId: it.id, ...(r.preview ? { preview: r.preview } : {}), note: r.note });
              await db.prepare(`UPDATE op_content_items SET publisher=?, note=?, updated_at=? WHERE id=?`).bind(pub.id, r.note, nowIso(), it.id).run();
            }
          }
          results.push({ channelId: ch.id, mode: pol.mode, publisher: pub.id, live: pub.live, published, previews });
        }
        return { output: { channels: results } };
      },
    }],
  };
}

// ---------------------------------------------------------------- verification
export function contentVerify(fetcher: Fetcher): HandlerDef {
  return {
    kind: "ops.content_verify",
    registryId: "OPS-CONTENT-VERIFY",
    steps: [{
      name: "verify",
      async run({ db, now }) {
        const graceHours = 72;
        const items = (await db.prepare(`SELECT i.*, n.site_url FROM op_content_items i JOIN niches n ON n.id = i.niche_id WHERE i.status='published' AND i.external_url IS NOT NULL LIMIT 50`).all<Record<string, any>>()).results;
        let verified = 0; let pending = 0; let failed = 0;
        for (const it of items) {
          const draft = it.body_json ? (JSON.parse(it.body_json) as Draft) : null;
          const rule = receiptRule(it.platform, it.external_url, it.site_url);
          let present = false; let status: number | null = null;
          if (rule.ok) {
            // Platform-side content evidence: the URL seen in the platform's own feed, or the platform page shows the headline.
            const inFeed = await db.prepare(`SELECT 1 AS x FROM op_publications WHERE external_url = ? AND source IN ('platform_feed','platform_api')`).bind(it.external_url).first();
            if (inFeed) present = true;
            else {
              const r = await fetcher(it.external_url, { timeoutMs: 15000, maxBytes: 800_000 });
              status = r.status;
              const head = (draft?.headline ?? String(it.title)).trim().slice(0, 40);
              present = r.ok && head.length >= 8 && r.text.includes(head);
            }
          }
          const key = `ops:verify:${it.id}`;
          if (present) {
            verified++;
            await db.prepare(`UPDATE op_content_items SET status='verified', verified_at=?, updated_at=? WHERE id=?`).bind(nowIso(), nowIso(), it.id).run();
            await db.prepare(`INSERT INTO op_publications (id,channel_id,niche_id,external_url,title,published_at,observed_at,source,content_id) VALUES (?,?,?,?,?,?,?,'platform_feed',?) ON CONFLICT(channel_id, external_url) DO UPDATE SET content_id=excluded.content_id`)
              .bind(newId("pub"), it.channel_id, it.niche_id, it.external_url, draft?.headline ?? it.title, it.published_at, nowIso(), it.id).run();
            await db.prepare(`UPDATE channels SET status='verified', last_verified_at=?, last_verified_url=?, updated_at=? WHERE id=?`).bind(nowIso(), it.external_url, nowIso(), it.channel_id).run();
            await addEvidence(db, { subjectType: "channel", subjectId: it.channel_id, claim: `Publication confirmed at its platform URL: ${draft?.headline ?? it.title}`, label: "VERIFIED", source: "ops.content_verify", url: it.external_url, collectedBy: "ops.content_verify" });
            await resolveAlert(db, key);
          } else if (!rule.ok || now.getTime() - Date.parse(it.published_at) > graceHours * 3600000) {
            failed++;
            await db.prepare(`UPDATE op_content_items SET status='failed', note=?, updated_at=? WHERE id=?`).bind(rule.ok ? `Not confirmed at ${it.external_url} within ${graceHours} h (HTTP ${status ?? "none"})` : `Receipt rejected: ${rule.reason}`, nowIso(), it.id).run();
            await raiseAlert(db, { key, severity: "warning", nicheId: it.niche_id, source: "ops.content_verify", title: `Published item could not be confirmed: ${it.title}`, detail: rule.ok ? `HTTP ${status ?? "none"} at ${it.external_url} after ${graceHours} h; headline not found and URL not in the platform feed.` : `Receipt rejected: ${rule.reason}.`, evidenceUrl: it.external_url });
          } else pending++;
        }
        return { output: { checked: items.length, verified, pending, failed } };
      },
    }],
  };
}
