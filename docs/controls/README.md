# FORGE controls (workstream F: finance, security, reliability)

**Owner:** "Build finance, security and reliability controls" thread · **Package:** `packages/controls` (`@forge/controls`) · **Date:** 2026-11-10
**Reviewer:** independent QA ("Review FORGE builds independently"). Nothing here is self-certified.

Status labels follow the constitution: PROPOSED / BUILT / TESTED / LIVE / FAILED / UNVERIFIED. "TESTED" below means unit-tested locally with real fixtures where noted; nothing in this package is LIVE, deployed, or connected to a production credential.

## Run

```
npm install
npm test -w @forge/controls            # 50 tests
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
| FIN-CAP | Default per-run cost caps by run type from the cost model (no default for long-lived Opus wakes) | G11 | `capForRunType` | BUILT | Not yet wired into `enqueue` (platform patch pending) |
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

## Not done here (and why)

- No production change, deploy, secret creation, credential connection or purchase. Each needs James's approval.
- Platform wiring (budget guard in `enqueue`, weekly summary and controls jobs as handlers, alerts from findings) is sent to the platform thread as patches; the platform owns `services/api`.
- Live sales Worker and n8n fixes are handed to the live-dollar thread.

See also: [FINANCE_RULES.md](FINANCE_RULES.md), [SECRETS_POLICY.md](SECRETS_POLICY.md), [INCIDENT_RUNBOOK.md](INCIDENT_RUNBOOK.md), [BACKUP_AND_RESTORE.md](BACKUP_AND_RESTORE.md).
