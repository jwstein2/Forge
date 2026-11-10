# FORGE Operator (workstream E · Milestone 3)

**Date:** 2026-11-10 · **Package:** `packages/operator` (`@forge/operator`) · **Status:** BUILT and TESTED locally (29 package tests plus the platform, builder and controls suites, and one real cron tick under local workerd). Merged on main. Migrations 0100 and 0101 are applied to staging D1. QA-005 defects fixed and passed QA. The SEO crawl was split into small jobs after staging measured 203 ms CPU for one unsplit tick.

FORGE Operator is the part of FORGE that keeps the businesses running between conversations. It runs on the platform's durable job engine (`services/api/src/orchestration/engine.ts`), so every run is stored in D1, takes a lease, saves a checkpoint after each step, retries a limited number of times, respects the global, niche and job pause switches, and writes a `runs` row. That row is the heartbeat FORGE Command shows as the last successful run.

## What runs, and when (UTC)

| Registry id | Job | Schedule | What it does | External effect |
|---|---|---|---|---|
| OPS-SITE-HEALTH | `ops.site_health` | every 60 min | Checks each site's home page (brand text present, no error page, latency), robots.txt, sitemap and the QPK pin feed, plus the sales Worker's `/health`. Opens an alert per failing URL (critical for home pages and the Worker) and resolves it when the URL recovers. | Read-only GETs |
| OPS-PIN-RUNWAY | `ops.pin_runway` | every 6 h | Shows how many days of scheduled pins remain in the QPK RSS drip, with a warning under 5 days and a critical alert at 0. If the queue can't be read, runway is shown as UNKNOWN. Pins in our own feed are recorded as `site_feed`, which proves the feed served them but not that Pinterest published them. The channel is marked verified only from the public Pinterest profile feed. | Read-only GETs |
| OPS-SEO-AUDIT | `ops.seo_audit` → `ops.seo_batch` → `ops.seo_finalize` | Mon 06:00 | The planner reads robots.txt and the sitemap per niche and enqueues one batch job per 8 URLs plus a finalize job that waits for them. Each batch reads only the first 64 KB of each page and parses with regex (no DOM). Crawls up to 60 sitemap URLs per site and checks status, title, description, canonical, h1, noindex, viewport and lang. Alerts on broken pages and on site-level problems. Search Console data stays UNKNOWN. | Read-only GETs |
| OPS-CONTENT-PLAN | `ops.content_plan` | Mon 07:00 | Reads each Audience & Market Brief's seasonality and channel fit and creates dated content items for windows starting within 120 days. Items are flagged `late` when their publish-by date has passed. Communities such as Facebook groups and Reddit are never automated. | None |
| OPS-CONTENT-DRAFT | `ops.content_draft` | daily 08:00 | Model step with limits: the output must be valid JSON within each platform's length limits, and a claims check rejects testimonials, customer counts, superlatives, guarantees and earnings claims. One retry, at most 10¢ per item and 40¢ per run (4 items, so at most about $12 a month, inside the $15 model budget), and every attempt is logged in `op_llm_calls`. With no API key, items stay `planned` and the job says why. | Anthropic API, only once a key is approved |
| OPS-CONTENT-PUBLISH | `ops.content_publish` | daily 15:00 | Publishes only what each channel's policy allows. The default is `draft_only` (nothing goes out). `approval_each` publishes only items the owner approved. `standing` publishes within a boundary the owner approved (publisher, daily cap, end date). Only the `dry_run` (preview only) and `manual` publishers exist. | None until a live publisher is approved |
| OPS-CONTENT-VERIFY | `ops.content_verify` | every 6 h | Accepts only a receipt URL that passes the platform's rule (host parsed against an allowlist, e.g. `pinterest.<tld>/pin/<id>/`; the niche's own site never counts except for its own SEO articles). It then needs content evidence from the platform side: the URL seen in the platform's own feed, or the platform page showing the headline. Only then is the item marked `verified` and the channel's last verified post updated. A receipt that fails the rule, or an item not confirmed within 72 h, becomes `failed` and raises an alert. | Read-only GETs |
| OPS-WEEKLY-SUMMARY | `ops.weekly_summary` | Mon 12:00 | Builds the weekly summary shown in the app: revenue (or "unknown, ledger not connected"), job runs, LIVE jobs that reported nothing, channels, alerts, content pipeline, uptime and model spend. It is never emailed. | None |

Schedules are declared in code (`OPERATOR_SCHEDULES`) and seeded into `op_schedules`. Each cron tick enqueues exactly one job per due slot (idempotency key `sched:<id>:<slot>`), so overlapping ticks never run a job twice. After an outage only the latest missed slot runs, not the backlog. Setting `enabled = 0` retires a schedule, and re-seeding never turns it back on.

## Owner controls (`/api/v1/operator`, behind owner auth)

`GET /summaries`, `/summaries/latest`, `/schedules`, `/checks`, `/content`, `/policies` ·
`POST /content/decide {ids[], approve}`: approve or reject drafts in one batch, so there is no daily approval queue. Drafts that fail the claims check are refused even when approved. ·
`POST /content/:id/published {externalUrl}`: the owner posted an item by hand, and FORGE then verifies it. ·
`PUT /policies/:channelId {mode, publisher, dailyCap, windowEnd}`: setting `standing` records the owner's approval along with its boundary.

## Honesty rules enforced in code

* A channel or content item can only be `verified` with a receipt URL and time (SQL CHECK constraints). The receipt must pass the platform's URL rule, and content evidence must come from the platform side.
* A Pinterest channel drops from `verified` to `running` after 7 days without a new pin in the profile feed.
* Claims check: blocks guarantees and money-back promises, superlatives, customer counts, "loved/trusted by", star glyphs and numeric ratings, quoted testimonials, review claims, press claims, performance and earnings claims, and any percentage. A money amount is allowed only if it is one of the niche's real product prices.
* A `standing` policy cannot exist without an approval row (CHECK) or an end date (0101 triggers; the API also caps it at 90 days). It is treated as `draft_only` unless that approval is `approved` and still inside its window.
* The dry-run publisher never marks anything published.
* A queue that can't be read, a missing Pinterest profile, or a disconnected ledger shows as unknown or unconnected, never as fine or $0.

## What is not built or not connected (needs owner approval)

1. **Live publishers.** Pinterest: either extend the RSS drip (a site deploy) or use the Pinterest API (new app and credential). MailerLite campaigns (credential). Instagram, Facebook and YouTube are deliberately not built yet (architecture §10).
2. **Model API key** for drafting (`ANTHROPIC_API_KEY` Worker secret; model `claude-opus-5-5`, configurable through `OPERATOR_MODEL`).
3. **QPK Pinterest profile URL** on `ch_qpk_pinterest`, so pins can be verified from the platform.
4. **Readable pin queue.** If `pins.json` isn't public on the site, runway shows as UNKNOWN until it is exposed or the queue path is given.
5. **Heartbeats from n8n and Claude scheduled tasks** (N8N-01..05, SCH-01/02). The platform already accepts signed `POST /ingest/heartbeat`. Adding the heartbeat node to the live n8n workflows means editing them, which needs owner approval. A snippet is below.
6. **Staging.** The Worker CPU limit on the free plan (10 ms per invocation) has not been measured with the Operator jobs. The SEO crawl is the heaviest. Staging measured 203 ms CPU for one unsplit tick, so the SEO crawl now runs as a planner, batches of 8 pages and a finalize job, and the fetcher stops reading at its byte cap. Re-measure after the next staging redeploy.

### n8n heartbeat snippet (prepared, not applied; matches heartbeat v2)
Add a final Code node, plus one on the error path with `status: "failed"`. `FORGE_HEARTBEAT_SECRET` must be 32 or more characters.
```js
const body = JSON.stringify({ registryId: "N8N-02", startedAt: $execution.startedAt ?? new Date().toISOString(), finishedAt: new Date().toISOString(), status: "success", externalId: String($execution.id) });
const ts = String(Math.floor(Date.now() / 1000));
const sig = "v2=" + require("crypto").createHmac("sha256", $env.FORGE_HEARTBEAT_SECRET).update(ts + "." + body).digest("hex");
return [{ json: { body, ts, sig } }];
// then an HTTP Request node: POST <forge-api>/api/v1/ingest/heartbeat with headers X-Forge-Timestamp: {{$json.ts}}, X-Forge-Signature: {{$json.sig}} and raw body {{$json.body}}
```

## Running it

```bash
npm install && npm run check                              # all workspaces incl. operator
cd packages/operator && npx vitest run                    # 29 operator tests
FORGE_OPERATOR=1 npm run dev:api                          # local dev server also runs Operator schedules (real GETs to the live sites)
cd services/api && npx wrangler dev --env development --test-scheduled   # then GET /__scheduled
```
