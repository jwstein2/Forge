/**
 * Weekly technical SEO crawl, split into small jobs so each cron invocation stays light (staging measured 203 ms
 * CPU for an unsplit tick against a 10 ms free-plan budget).
 *
 *  ops.seo_audit     planner: with no nicheId it enqueues one planner per niche; per niche it reads robots.txt and the sitemap, records site-level findings, then enqueues
 *                    one ops.seo_batch job per `batchSize` URLs and one ops.seo_finalize job that depends on them.
 *  ops.seo_batch     fetches its URLs (head of the page only, capped bytes) and records per-page findings.
 *  ops.seo_finalize  runs after every batch of that niche succeeded; raises or resolves the niche's SEO alert.
 *
 * Parsing is regex over at most the first 64 KB of each page (enough for <head> and the first <h1>), never a DOM.
 * Search demand, rankings and clicks stay UNKNOWN until Search Console is connected.
 */
import type { HandlerDef } from "../../../../services/api/src/orchestration/engine.ts";
import { enqueue } from "../../../../services/api/src/orchestration/engine.ts";
import { activeNiches, checkStmt, flush, htmlFacts, joinUrl, raiseAlert, recordCheck, resolveAlert, xmlTags, type Fetcher, type Finding } from "../lib.ts";

export const PAGE_BYTES = 64_000;

export function auditPage(url: string, html: string, siteOrigin: string): Finding[] {
  const f: Finding[] = []; const h = htmlFacts(html);
  if (!h.title) f.push({ code: "title_missing", severity: "warning", message: "No <title>" });
  else if (h.title.length > 65) f.push({ code: "title_long", severity: "info", message: `Title ${h.title.length} chars (>65 may truncate)` });
  if (!h.description) f.push({ code: "description_missing", severity: "warning", message: "No meta description" });
  else if (h.description.length > 170) f.push({ code: "description_long", severity: "info", message: `Description ${h.description.length} chars` });
  if (!h.canonical) f.push({ code: "canonical_missing", severity: "warning", message: "No canonical link" });
  else {
    const norm = (u: string) => u.replace(/\/index\.html$/, "/").replace(/\/+$/, "");
    if (!h.canonical.startsWith("http")) f.push({ code: "canonical_relative", severity: "info", message: `Relative canonical ${h.canonical}` });
    else if (norm(h.canonical) !== norm(url)) {
      let sameOrigin = false; try { sameOrigin = new URL(h.canonical).origin === siteOrigin; } catch { /* malformed */ }
      f.push({ code: "canonical_mismatch", severity: sameOrigin ? "info" : "warning", message: `Canonical ${h.canonical} differs from ${url}` });
    }
  }
  if (h.h1Count === 0) f.push({ code: "h1_missing", severity: "warning", message: "No <h1> in the first 64 KB" });
  if (h.h1Count > 1) f.push({ code: "h1_multiple", severity: "info", message: `${h.h1Count} <h1> elements` });
  if (h.robots && /noindex/i.test(h.robots)) f.push({ code: "noindex", severity: "warning", message: `robots meta: ${h.robots}` });
  if (!h.hasViewport) f.push({ code: "viewport_missing", severity: "warning", message: "No viewport meta (mobile)" });
  if (!h.lang) f.push({ code: "lang_missing", severity: "info", message: "<html> has no lang" });
  return f;
}

/** Planner. */
export function seoAudit(fetcher: Fetcher, handlers: () => Map<string, HandlerDef>): HandlerDef {
  return {
    kind: "ops.seo_audit",
    registryId: "OPS-SEO-AUDIT",
    steps: [{
      name: "plan",
      async run({ db, jobId, input }) {
        const maxPages = Math.min(Number(input.maxPages ?? 60), 200);
        const batchSize = Math.min(Math.max(Number(input.batchSize ?? 10), 1), 15);
        const niches = (await activeNiches(db, (input.nicheId as string) ?? null)).filter((n) => n.site_url);
        const planned: Record<string, unknown>[] = [];
        if (!input.nicheId && niches.length > 1) {
          // Fan out: one planner per niche, so no single job pays for every site's fetches and enqueues
          // (staging allows 50 subrequests per invocation, D1 calls included).
          const h = handlers();
          for (const n of niches) {
            const c = await enqueue(db, h, { kind: "ops.seo_audit", nicheId: n.id, parentId: jobId, idempotencyKey: `${jobId}:${n.id}:plan`, input: { ...input, nicheId: n.id }, createdBy: `job:${jobId}`, maxAttempts: 2 });
            planned.push({ nicheId: n.id, plannerJobId: c.id });
          }
          return { output: { fannedOut: planned } };
        }
        for (const n of niches) {
          const base = n.site_url!; const origin = new URL(base).origin;
          const site: Finding[] = [];
          const robots = await fetcher(joinUrl(base, "/robots.txt"), { maxBytes: 32_000 });
          const sm = await fetcher(joinUrl(base, "/sitemap.xml"), { maxBytes: 500_000 });
          if (robots.probeError || sm.probeError) {
            // FORGE's own runtime failed the request: the site's state is UNKNOWN, so record that and plan nothing.
            await recordCheck(db, { kind: "seo_site", nicheId: n.id, target: base, ok: null, status: null, jobId,
              findings: [{ code: "checker_error", severity: "info", message: `FORGE could not fetch robots.txt or the sitemap (${robots.error ?? sm.error ?? "runtime error"}). Not crawled this week.` }] });
            planned.push({ nicheId: n.id, skipped: "checker_error" });
            continue;
          }
          if (!robots.ok) site.push({ code: "robots_missing", severity: "warning", message: `robots.txt HTTP ${robots.status ?? "none"}` });
          else {
            if (/^\s*Disallow:\s*\/\s*$/im.test(robots.text)) site.push({ code: "robots_blocks_all", severity: "critical", message: "robots.txt disallows the whole site" });
            if (!/^\s*Sitemap:/im.test(robots.text)) site.push({ code: "robots_no_sitemap", severity: "info", message: "robots.txt does not reference a sitemap" });
          }
          const locs = sm.ok ? xmlTags(sm.text, "loc") : [];
          const urls = locs.filter((u) => u.startsWith(origin));
          if (!sm.ok) site.push({ code: "sitemap_missing", severity: "warning", message: `sitemap.xml HTTP ${sm.status ?? "none"}` });
          else if (!urls.length) site.push({ code: "sitemap_empty", severity: "warning", message: "sitemap has no same-origin <loc> URLs" });
          if (locs.length > urls.length) site.push({ code: "sitemap_foreign_urls", severity: "warning", message: `${locs.length - urls.length} sitemap URLs point to another origin` });
          const sample = urls.slice(0, maxPages);
          if (urls.length > sample.length) site.push({ code: "sample_capped", severity: "info", message: `Checking ${sample.length} of ${urls.length} sitemap URLs` });
          await recordCheck(db, { kind: "seo_site", nicheId: n.id, target: base, ok: !site.some((x) => x.severity !== "info"), status: sm.status, findings: site, jobId });

          const h = handlers(); const batchIds: string[] = [];
          for (let i = 0; i < sample.length; i += batchSize) {
            const b = await enqueue(db, h, { kind: "ops.seo_batch", nicheId: n.id, parentId: jobId, idempotencyKey: `${jobId}:${n.id}:${i}`, input: { nicheId: n.id, urls: sample.slice(i, i + batchSize) }, createdBy: `job:${jobId}`, maxAttempts: 2 });
            batchIds.push(b.id);
          }
          await enqueue(db, h, { kind: "ops.seo_finalize", nicheId: n.id, parentId: jobId, idempotencyKey: `${jobId}:${n.id}:final`, dependsOn: batchIds,
            input: { nicheId: n.id, batchJobIds: batchIds, siteFindings: site, sitemapUrls: urls.length }, createdBy: `job:${jobId}`, maxAttempts: 2 });
          planned.push({ nicheId: n.id, sitemapUrls: urls.length, batches: batchIds.length, siteFindings: site.map((x) => x.code) });
        }
        return { output: { niches: planned } };
      },
    }],
  };
}

export function seoBatch(fetcher: Fetcher): HandlerDef {
  return {
    kind: "ops.seo_batch",
    registryId: "OPS-SEO-AUDIT",
    steps: [{
      name: "crawl",
      async run({ db, jobId, input }) {
        const nicheId = String(input.nicheId);
        const urls = (input.urls as string[]) ?? [];
        let broken = 0; let warn = 0; let unknown = 0; let retries = 0; let halted: string | null = null;
        const stmts: D1PreparedStatement[] = []; // one batch write at the end
        for (const u of urls) {
          const origin = new URL(u).origin;
          const unknownRow = (why: string) => { unknown++; stmts.push(checkStmt(db, { kind: "seo_page", nicheId, target: u, ok: null, status: null, jobId,
            findings: [{ code: "checker_error", severity: "info", message: `FORGE could not fetch this page (${why}). Page state UNKNOWN.` }] })); };
          if (halted) { unknownRow(`stopped after a runtime error: ${halted}`); continue; }
          let r = await fetcher(u, { timeoutMs: 15000, maxBytes: PAGE_BYTES });
          if (!r.ok && !r.probeError && retries < 3) { retries++; r = await fetcher(u, { timeoutMs: 15000, maxBytes: PAGE_BYTES }); } // re-check before calling it broken
          if (r.probeError) { halted = r.error ?? "runtime error"; unknownRow(halted); continue; }
          const pf: Finding[] = r.ok ? auditPage(u, r.text, origin) : [{ code: "page_status", severity: "critical", message: `HTTP ${r.status ?? "none"}${r.error ? ` (${r.error})` : ""}` }];
          if (!r.ok) broken++;
          const bad = pf.some((x) => x.severity !== "info"); if (bad) warn++;
          stmts.push(checkStmt(db, { kind: "seo_page", nicheId, target: u, ok: !bad, status: r.status, latencyMs: r.latencyMs, findings: pf, jobId }));
        }
        await flush(db, stmts);
        return { output: { nicheId, checked: urls.length - unknown, unknown, broken, pagesWithWarnings: warn } };
      },
    }],
  };
}

export function seoFinalize(): HandlerDef {
  return {
    kind: "ops.seo_finalize",
    registryId: "OPS-SEO-AUDIT",
    steps: [{
      name: "summarize",
      async run({ db, input }) {
        const nicheId = String(input.nicheId);
        const ids = (input.batchJobIds as string[]) ?? [];
        const site = (input.siteFindings as Finding[]) ?? [];
        const niche = await db.prepare(`SELECT name, site_url FROM niches WHERE id = ?`).bind(nicheId).first<{ name: string; site_url: string }>();
        const rows = ids.length
          ? (await db.prepare(`SELECT ok, status_code, findings_json FROM op_checks WHERE check_kind='seo_page' AND job_id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<{ ok: number | null; status_code: number | null; findings_json: string }>()).results
          : [];
        const counts: Record<string, number> = {};
        let broken = 0; let pagesWithWarnings = 0; let unknown = 0;
        for (const r of rows) {
          const f = JSON.parse(r.findings_json) as Finding[];
          if (r.ok === null) { unknown++; continue; }
          if (f.some((x) => x.code === "page_status")) broken++;
          if (!r.ok) pagesWithWarnings++;
          f.forEach((x) => { counts[x.code] = (counts[x.code] ?? 0) + 1; });
        }
        const key = `ops:seo:${nicheId}`;
        const severe = site.filter((x) => x.severity !== "info");
        if (broken || severe.length) await raiseAlert(db, { key, severity: broken || severe.some((x) => x.severity === "critical") ? "critical" : "warning", nicheId, source: "ops.seo_audit",
          title: `${niche?.name ?? nicheId}: ${broken} broken page(s), ${severe.length} site-level SEO issue(s)`, detail: [...severe.map((x) => x.message), ...(broken ? [`${broken} sitemap URLs did not return 200 (each re-checked once)`] : []), ...(unknown ? [`${unknown} page(s) could not be checked (state unknown)`] : [])].join("; "),
          nextAction: "See the SEO findings in Operations; fixes go through the site's normal release gate.", evidenceUrl: niche?.site_url ? joinUrl(niche.site_url, "/sitemap.xml") : null });
        else await resolveAlert(db, key);
        return { output: { nicheId, sitemapUrls: input.sitemapUrls ?? null, checked: rows.length - unknown, unknown, broken, pagesWithWarnings, findingCounts: counts, siteFindings: site.map((x) => x.code), searchConsole: "unconnected" } };
      },
    }],
  };
}
