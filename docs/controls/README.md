# FORGE controls (workstream F: finance, security, reliability)

**Owner:** "Build finance, security and reliability controls" thread · **Package:** `packages/controls` (`@forge/controls`) · **Date:** 2026-11-10
**Reviewer:** independent QA ("Review FORGE builds independently"). Nothing here is self-certified.

Status labels follow the constitution: PROPOSED / BUILT / TESTED / LIVE / FAILED / UNVERIFIED. "TESTED" below means unit-tested locally with real fixtures where noted; nothing in this package is LIVE, deployed, or connected to a production credential.

## Run

```
npm install
npm test -w @forge/controls            # 86 tests
npm run typecheck -w @forge/controls
npm run scan-secrets -w @forge/controls            # tracked + untracked + full git history, redacted output
npm run backup:plan -w @forge/controls             # prints D1 export commands; changes nothing
```

## Control catalogue

| Code | Control | Gate | Module | Status | Evidence |
|---|---|---|---|---|---|
| FIN-REV | Independent revenue recompute from raw ledger rows (live only; test-mode and owner-test excluded; tax netted; unknown vertical kept separate) | G6, G16 | `finance/ledger.ts` `recomputeRevenue` | TESTED | Real ledger snapshot 2026-11-10: live $0.00, 2 test orders ($27.99) reported apart |
| FIN-LI-01..06 | Ledger integrity: unattributed live order, orphan refund, over-refund, duplicate order, non-USD, missing owner_test column | G6 | `checkLedger` | TESTED | Snapshot lacks owner_test → FIN-LI-06 raised |
| FIN-PR-01/02 | Price integrity: site = checkout = ledger amount | G5 | `checkLedger` | TESTED | Registry: Bidline $19.00 site vs $19.99 checkout → FIN-PR-01 (owner decision) |
| FIN-RC-01 | Monthly payout reconciliation to the provider export within $0.01; missed webhooks; amount mismatches | G6 | `finance/reconcile.ts` | TESTED (synthetic CSV) | Runs on the owner's Lemon Squeezy CSV until the API is connected |
| FIN-SPEND | Spend guard: default deny; cash needs a bounded, unexpired owner approval matching budget and vendor; an approval never lifts a ceiling; model usage only inside the $15/month envelope | G14 | `finance/budget.ts` `authorizeSpend` | TESTED | Uses real `registry/budgets.json` |
| FIN-BG-01..04 | Budget health: 80% warn, 100% block (owner), approved > ceiling, unknown-cost usage rows | G14, G16 | `budgetFindings`, `monthToDate` | TESTED | |
| FIN-CAP | Default per-run cost caps by job kind/run type from the cost model; explicit caps win; unknown kinds uncapped | G11 | `finance/job-policy.ts`; platform `enqueue` | TESTED | Patch 0003: wired into `enqueue` |
| FIN-SPEND-ENGINE | Model-using jobs run only if their cap fits the remaining $15 envelope (month-to-date from `op_llm_calls`, or the budget's recorded spend if higher); otherwise deferred to next month with an owner alert; uncapped model jobs fail | G14 | platform `runJob` via `@forge/controls/engine` | TESTED | Patch 0003 |
| CTL-RUN | `ledger.sync` second step runs ledger, price and budget controls and upserts/resolves `controls:FIN-*` alerts | G5, G6, G14 | `controls-run.ts`; platform `handlers.ts` | TESTED | Patch 0003; raises the Bidline price alert from the real registry |
| QA-REV | Registry of authorised gate-receipt reviewers (independent QA, owner); refuses unknown reviewers, same-workstream review, inactive reviewers, out-of-scope gates and PASS without evidence | G1-G16 | `assurance/reviewers.ts` + `reviewers.json` | TESTED | For the builder and any receipt writer to call |
| SEC-HDR-API | API headers + audit | G12 | `security/headers.ts` | TESTED | Platform already ships its own middleware (QA-002 R6); this audit function checks it |
| SEC-HDR-SITE | Cloudflare Pages `_headers` generator: strict CSP from the site's real third parties, inline-script sha256 hashes, embed paths frameable | G12 | `pagesHeadersFile`, `inlineScriptHashes`, `inlineHandlers` | TESTED | Handed to the live-dollar thread (owns the sites) |
| SEC-SIG | Signed calls v2: timestamp inside the MAC, ±5 min window, ≥32-char secrets, rotation, replay guard | G6, G12 | `security/signing.ts` | TESTED | Patch to platform `/ingest/heartbeat` |
| SEC-SCAN | Secret scanner: provider token shapes, credential URLs, n8n webhook URLs, sensitive filenames, entropy; history; never prints secrets; fingerprint allowlist | G12 | `security/leak-scan.ts`, `scripts/scan-leaks.ts` | TESTED | Repo: 0 critical. forge-m1 Library files: 0 critical, 2 warnings (n8n webhook URL in deploy script; acceptable now the workflow verifies HMAC) |
| REL-N8N-P1..P6 | n8n policy: always-send scheduled email, repeat alert email, open webhook, HMAC over re-serialised JSON, secret reuse / secrets in data tables, no heartbeat | G11, G12, G14 | `reliability/n8n-policy.ts` | TESTED | Run on the real workflows read 2026-11-10 (see below) |
| REL-WEEKLY | Weekly summary, failure-first; `shouldInterrupt` limits out-of-cycle alerts to money/customer criticals | G14 | `reliability/weekly-summary.ts` | TESTED | Not yet scheduled (needs a platform handler) |
| REL-PROBE | Synthetic signed test-mode order → ledger check; refuses the production sales Worker | G5, G11 | `reliability/pipeline-probe.ts` | TESTED (fake Worker) | Needs a staging/local sales Worker to run for real |
| REL-BACKUP | D1 read-only export plan/execute with sha256 manifest; never deletes | G13 | `scripts/backup-d1.ts` | BUILT (plan mode tested) | Execute needs the owner's machine + wrangler login; not run |

## Findings from running the controls on real data (2026-11-10)

| Finding | Severity | Where | Owner of the fix |
|---|---|---|---|
| Bidline site $19.00 vs checkout $19.99 | critical, owner decision | registry/products.json (from audit) | James decides; live-dollar thread applies |
| Ledger snapshot read without owner_test | warning | platform importer | Fixed by platform in API 1.2 |
| n8n `n8n_forward_secret` is both the HMAC key for sale forwards and the `x-forge-token` bearer for `/report` | warning | n8n "FORGE · Sales alerts and weekly per-niche report" | live-dollar thread (handoff) |
| Sale-forward HMAC computed over `JSON.stringify(body)` not the raw body | warning | same workflow | live-dollar thread |
| Forward and report secrets live in an n8n data table, not n8n credentials | info | same workflow | live-dollar thread |
| Health check emails every 3 h while an outage lasts (up to 8/day) | warning | n8n "QPK · Health check" | live-dollar thread |
| No n8n workflow sends a heartbeat to FORGE | warning | all scheduled workflows | operations engine (M3) once the FORGE API has a staging URL |
| Daily report now gated (activity, Monday, failure) and webhook verifies a signature | resolved | same workflow | already fixed by the live-dollar thread |

## QA-006 (2026-11-10) fixed in patch 0003
L1 owner_test NULL/absent now excluded (matches platform 63cf3d6) with FIN-LI-06/07; L2 test_mode other than exactly 0 excluded and flagged; L3 refunds inherit the order's class; unreadable timestamps (FIN-LI-08) and cumulative over-refunds flagged. S1 model usage only against `bud_api_month`, using max(recorded spend, month-to-date); S2 one-off approvals single-use, recurring ones need `maxTotalCents`; S3 cash approvals must name budget, vendor and amount; S4 approvals must expire within 90 days. K1 scanner now catches camelCase/unquoted/YAML/header assignments, Bearer tokens, bare 64-hex values and Stripe test keys; K2 "test"/"local" excuse values only in test files. N1 cron lists/ranges counted; N2 webhook verification must happen before any side effect, via an IF that compares the HMAC output or a throwing Code check. H1 audit flags scheme-only sources, 'unsafe-eval', default-src *; H2 `_headers` lines over 2,000 characters are refused. Known minor left: history hits report diff-hunk line numbers.

**QA-006 retest R1 fixes (patch 0004).** S5 cash spend is denied (`usage_unknown`) unless prior charges under the approval are supplied, so a one-off approval cannot be reused by omitting them. S6 cash approvals without a decision time are denied (`approval_undated`). Model usage that cannot be read fails closed: the job waits 5 minutes (`spend_unverified`) without using an attempt; only a missing `op_llm_calls` table counts as $0, and the ledger.sync controls step retries instead of reporting $0. The envelope check now adds the unspent caps of other authorised, unfinished model jobs. A data-table node with no operation counts as a write. An empty ledger read no longer resolves `fin:ledger` alerts.

## Weekly summary ownership
One weekly summary only: the operations engine's `ops.weekly_summary` (stored in `op_summaries`, never emailed) is the owner. Controls findings reach it as alerts. `composeWeekly()` here stays a library function and is not scheduled.

## Not done here (and why)

- No production change, deploy, secret creation, credential connection or purchase. Each needs James's approval.
- Platform wiring (budget guard in `enqueue`, weekly summary and controls jobs as handlers, alerts from findings) is sent to the platform thread as patches; the platform owns `services/api`.
- Live sales Worker and n8n fixes are handed to the live-dollar thread.

See also: [FINANCE_RULES.md](FINANCE_RULES.md), [SECRETS_POLICY.md](SECRETS_POLICY.md), [INCIDENT_RUNBOOK.md](INCIDENT_RUNBOOK.md), [BACKUP_AND_RESTORE.md](BACKUP_AND_RESTORE.md).
