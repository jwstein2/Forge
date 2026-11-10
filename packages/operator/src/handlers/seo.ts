/**
 * ops.seo_audit — weekly technical SEO crawl of each live site from its own sitemap.
 * Deterministic: robots → sitemap → up to `maxPages` URLs → status, title, description, canonical, h1, noindex, viewport.
 * Search demand, rankings and clicks stay UNKNOWN until Search Console is connected (owner approval); this job never guesses them.
 */
import type { HandlerDef } from "../../../../services/api/src/orchestration/engine.ts";
import { activeNiches, htmlFacts, joinUrl, raiseAlert, recordCheck, resolveAlert, xmlTags, type Fetcher, type Finding } from "../lib.ts";

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
    else if (norm(h.canonical) !== norm(url)) f.push({ code: "canonical_mismatch", severity: new URL(h.canonical).origin === siteOrigin ? "info" : "warning", message: `Canonical ${h.canonical} differs from ${url}` });
  }
  if (h.h1Count === 0) f.push({ code: "h1_missing", severity: "warning", message: "No <h1>" });
  if (h.h1Count > 1) f.push({ code: "h1_multiple", severity: "info", message: `${h.h1Count} <h1> elements` });
  if (h.robots && /noindex/i.test(h.robots)) f.push({ code: "noindex", severity: "warning", message: `robots meta: ${h.robots}` });
  if (!h.hasViewport) f.push({ code: "viewport_missing", severity: "warning", message: "No viewport meta (mobile)" });
  if (!h.lang) f.push({ code: "lang_missing", severity: "info", message: "<html> has no lang" });
  return f;
}

export function seoAudit(fetcher: Fetcher): HandlerDef {
  return {
    kind: "ops.seo_audit",
    registryId: "OPS-SEO-AUDIT",
    steps: [{
      name: "crawl",
      async run({ db, jobId, input }) {
        const maxPages = Math.min(Number(input.maxPages ?? 60), 200);
        const niches = (await activeNiches(db, (input.nicheId as string) ?? null)).filter((n) => n.site_url);
        const summary: Record<string, unknown>[] = [];
        for (const n of niches) {
          const base = n.site_url!; const origin = new URL(base).origin;
          const site: Finding[] = [];
          const robots = await fetcher(joinUrl(base, "/robots.txt"));
          if (!robots.ok) site.push({ code: "robots_missing", severity: "warning", message: `robots.txt HTTP ${robots.status ?? "none"}` });
          else {
            if (/^\s*Disallow:\s*\/\s*$/im.test(robots.text)) site.push({ code: "robots_blocks_all", severity: "critical", message: "robots.txt disallows the whole site" });
            if (!/^\s*Sitemap:/im.test(robots.text)) site.push({ code: "robots_no_sitemap", severity: "info", message: "robots.txt does not reference a sitemap" });
          }
          const sm = await fetcher(joinUrl(base, "/sitemap.xml"));
          const urls = sm.ok ? xmlTags(sm.text, "loc").filter((u) => u.startsWith(origin)) : [];
          if (!sm.ok) site.push({ code: "sitemap_missing", severity: "warning", message: `sitemap.xml HTTP ${sm.status ?? "none"}` });
          else if (!urls.length) site.push({ code: "sitemap_empty", severity: "warning", message: "sitemap has no same-origin <loc> URLs" });
          const foreign = sm.ok ? xmlTags(sm.text, "loc").filter((u) => !u.startsWith(origin)).length : 0;
          if (foreign) site.push({ code: "sitemap_foreign_urls", severity: "warning", message: `${foreign} sitemap URLs point to another origin` });

          let broken = 0; let pagesWithWarnings = 0; const counts: Record<string, number> = {};
          const sample = urls.slice(0, maxPages);
          for (const u of sample) {
            const r = await fetcher(u, { timeoutMs: 15000, maxBytes: 600_000 });
            const pf: Finding[] = r.ok ? auditPage(u, r.text, origin) : [{ code: "page_status", severity: "critical", message: `HTTP ${r.status ?? "none"}${r.error ? ` (${r.error})` : ""}` }];
            if (!r.ok) broken++;
            if (pf.some((x) => x.severity !== "info")) pagesWithWarnings++;
            pf.forEach((x) => { counts[x.code] = (counts[x.code] ?? 0) + 1; });
            await recordCheck(db, { kind: "seo_page", nicheId: n.id, target: u, ok: !pf.some((x) => x.severity !== "info"), status: r.status, latencyMs: r.latencyMs, findings: pf, jobId });
          }
          if (urls.length > sample.length) site.push({ code: "sample_capped", severity: "info", message: `Checked ${sample.length} of ${urls.length} sitemap URLs` });
          await recordCheck(db, { kind: "seo_site", nicheId: n.id, target: base, ok: !site.some((x) => x.severity !== "info") && broken === 0, status: sm.status, findings: site, jobId });

          const key = `ops:seo:${n.id}`;
          const severe = site.filter((x) => x.severity !== "info");
          if (broken || severe.length) await raiseAlert(db, { key, severity: broken || severe.some((x) => x.severity === "critical") ? "critical" : "warning", nicheId: n.id, source: "ops.seo_audit",
            title: `${n.name}: ${broken} broken page(s), ${severe.length} site-level SEO issue(s)`, detail: [...severe.map((x) => x.message), ...(broken ? [`${broken} sitemap URLs did not return 200`] : [])].join("; "), nextAction: "See the SEO findings in Operations; fixes go through the site's normal release gate.", evidenceUrl: joinUrl(base, "/sitemap.xml") });
          else await resolveAlert(db, key);
          summary.push({ nicheId: n.id, sitemapUrls: urls.length, checked: sample.length, broken, pagesWithWarnings, findingCounts: counts, siteFindings: site.map((x) => x.code), searchConsole: "unconnected" });
        }
        return { output: { niches: summary } };
      },
    }],
  };
}
