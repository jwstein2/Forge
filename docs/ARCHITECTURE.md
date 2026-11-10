# FORGE Implementation Architecture (v0.1, Milestone 1 backend)

**Date:** 2026-11-10 · **Owner of this doc:** Platform Architecture & Backend (workstream A)
**Basis:** `audit/final/FORGE_PROPOSED_ARCHITECTURE.md` and `FORGE_CURRENT_STATE_MAP.md` (Library). This document says what is actually built in this repo and why.

## 1. What exists in this repo (status labels per constitution §4)

| Component | Path | Status |
|---|---|---|
| Shared API contract (TypeScript) | `packages/contracts` | BUILT, typechecked (v1.1.0) |
| Intelligence content schemas (owned by workstream B) | `packages/contracts/schemas/intelligence` | BUILT by B, copied in |
| Platform database schema, 4 migrations | `services/api/migrations` | TESTED locally (Node SQLite and local D1/workerd). **Not applied to any remote database.** |
| FORGE API Worker (Hono) | `services/api/src` | TESTED locally (56 tests; runs under `wrangler dev` and the Node dev server). **Not deployed.** |
| Owner auth (Cloudflare Access JWT + dev token) | `services/api/src/lib/auth.ts` | TESTED with generated keys. Access application **not created** (needs approval). |
| Read-only adapters: sales ledger, n8n | `services/api/src/adapters` | TESTED against dated read-only snapshots taken 2026-11-10 |
| Durable job engine + handlers | `services/api/src/orchestration` | TESTED locally, including cron trigger under workerd. No scheduler deployed. |
| Registry (niches, products, jobs, channels, integrations, accounts, costs, budgets, alerts) | `registry/*.json` | BUILT from audit evidence; seeds the database |
| FORGE Command UI | `apps/command` | BUILT by workstream D; verified rendering live API data from the local dev server (2026-11-10) |
| CI workflow | `.github/workflows/ci.yml` | BUILT, inert (no GitHub repo yet) |

## 2. Shape of the system

```
 apps/command (React, workstream D) ──HTTPS + Cloudflare Access──► services/api  (Worker "forge-api")
                                                                     │  Hono routes /api/v1
                                                                     │  domain/ finance · portfolio · registry · intelligence
                                                                     │  orchestration/ engine + handlers
                                                                     ▼
                                                     D1 "forge" (platform DB, separate from the ledger)
                                                                     ▲
              read-only adapters ────────────────────────────────────┘
               ├─ ledger.d1  : existing D1 "quiltplankit-sales" (sales, events)  ← live Worker keeps writing it
               ├─ n8n        : execution history (public API, FORGE-scoped key)
               └─ (unconnected) Lemon Squeezy · Search Console · KDP · Pages · Analytics
 signed heartbeats: n8n → POST /api/v1/ingest/heartbeat (HMAC)  → runs
 scheduler: Cloudflare cron (*/15) → scheduledTick → seed registry, enqueue syncs + watchdog, tick
```

### Why this stack
* **Cloudflare Workers + D1** is what already runs the business (Pages, the sales Worker, the ledger). Free tier covers FORGE's volume. No Supabase or new vendor (proposed architecture §10).
* **Separate platform database.** FORGE never writes to the live ledger. The "Reach first verified live dollar" thread owns ledger changes (site column, auth on n8n forwarding); FORGE adapts by reading.
* **Hono** is a ~20 KB router that runs identically in Workers and Node, so the same app serves tests, the local Node server and the Worker.
* **Node 22 built-in SQLite** gives a D1-compatible test harness with zero native dependencies and no Cloudflare account. The same SQL is proven on real D1 via `wrangler d1 migrations apply --local`.
* **n8n stays the runner for existing workflows.** FORGE observes them (snapshot/live adapter + signed heartbeats) instead of re-implementing them.

## 3. Data model (platform DB)

| Group | Tables | Key rules enforced in SQL |
|---|---|---|
| Portfolio | `niches`, `products`, `channels`, `integrations`, `accounts` | Channel can be `verified` only with a receipt URL + time. Accounts have **no secret column**; `password_manager_ref` must be a URI. |
| Registry & runs | `registry_entries`, `runs` | Runs come only from platform evidence (n8n executions, signed heartbeats, FORGE jobs). |
| Evidence & status | `evidence`, `status_history` | Promotion to TESTED/LIVE requires an evidence row. |
| Governance | `approvals`, `gate_receipts`, `alerts`, `system_controls`, `audit_log` | Only `owner` decides approvals. Gate reviewer ≠ producer. Alerts deduplicate by key. |
| Finance | `financial_events`, `cost_items`, `budgets`, `funnel_daily`, `usage_records` | Unknown cost must be labelled UNKNOWN (never $0). Test-mode and owner-test money flagged. |
| Orchestration | `jobs`, `job_steps`, `job_dependencies`, `job_events` | Max attempts 1–10; idempotency key unique. |
| Intelligence & Builder | `market_briefs`, `scoring_models`, `research_runs`, `opportunities`, `launch_blueprints`, `builds`, `build_stages` | One recommended opportunity per run. Documents stored whole with sha256 content hash. |

Every table that will need it carries `niche_id`; `niches.tenant_id` reserves multi-tenancy without building it.

## 4. Honesty model (how "never fabricate" is enforced in code)

1. **Metric contract.** Every number is `{value, unit, state, period, asOf, source}`. `metric()` throws if a `verified`/`estimated` metric has no value. Tests walk every read endpoint and assert period/freshness on every metric.
2. **Unconnected ≠ zero.** Without a ledger source, revenue is `null / unconnected`. With the ledger, revenue is `verified` from `test_mode=0 AND owner_test=0` rows only.
3. **Contribution is withheld** (`null / unknown`) while any cost line is unknown, and `missingLines` names each gap. A known-lines subtotal is reported separately as `estimated`.
4. **Fees.** With zero live orders, fees are a verified $0. With live orders, fees are `unconnected` until Lemon Squeezy data exists (the ledger has no fee field).
5. **Funnel.** QA traffic is excluded by the sites' own naming conventions (`qa-test`, `/site/…`, `embed:127.0.0.1`…). Root-path events cannot be attributed to a site yet (no site column), so per-niche views are `unknown` except Bidline (`/bidline/` prefix since 2026-11-10). Portfolio total: 37 real views, matching the audit.
6. **Heartbeats.** A job is `ok`/`late` against 2× its interval; runs from a snapshot are judged at snapshot time and the snapshot's age is shown as source freshness. Runners that do not report to FORGE show `never_observed`, and the watchdog raises an info alert for each LIVE one.
7. **Pausing.** Command can pause only jobs FORGE can enforce (`pausable`). Pausing an n8n workflow from FORGE is refused with an explanation rather than faked.
8. **Status changes** go through `POST /status` with evidence and are recorded in `status_history`.

## 5. Orchestration model

Durable jobs in D1. Workers (cron tick, Node dev loop, later a Queue consumer) claim with a lease; expired leases are reclaimed. Steps checkpoint their output; a retried job replays succeeded steps from checkpoints. Retries: exponential backoff from 30 s, capped at 1 h, max attempts per job. Terminal failure raises one deduplicated alert. Cost cap per job (non-retryable on breach). Kill switches: global emergency stop, niche pause, registry-entry pause, checked before claim and between steps. Handlers may declare `requiresApproval` → the job parks in `waiting_approval` with a pending approval record until the owner decides. Each FORGE job run writes a `runs` row (`forge://jobs/<id>`) so G11 "first scheduled execution observed" has evidence.

Built-in handlers: `registry.seed`, `ledger.sync`, `n8n.sync`, `heartbeat.watchdog`. Milestone 3 adds business workflows (Pinterest queue health, Search Console pulls, weekly summary) as handlers or as n8n workflows that send signed heartbeats.

## 6. Environments

| Environment | DB | Auth | Scheduler | Status |
|---|---|---|---|---|
| test | in-memory Node SQLite | dev token | manual `tick` | Running in CI-equivalent locally |
| development | `.data/forge.dev.sqlite` (Node) or local D1 (wrangler) | dev token | 60 s loop (Node) / `--test-scheduled` (wrangler) | Runs on any machine with Node 22 |
| staging | D1 `forge-staging` (to create) | Cloudflare Access | cron `*/15` | **Needs owner approval** (free-tier Worker + D1 + Access app) |
| production | — | Cloudflare Access | cron | **Not planned without explicit approval** |

Dev auth is refused in staging/production by code and by test.

## 7. Security notes

* Secrets are Worker secrets/bindings only (`.dev.vars` locally, gitignored). The API never selects or returns secret material; the account directory selects explicit safe columns.
* `scripts/check-secrets.mjs` scans tracked files; CI runs it.
* A D1 *binding* to the live ledger cannot be made read-only by Cloudflare; FORGE code only issues SELECTs against it, but the stricter option for staging is a D1 REST read with a read-only API token. Both need owner approval; neither is connected.
* Credential files on James's Desktop were not opened.

## 8. Known limits (Milestone 1)

* Data is from dated snapshots (ledger 02:13 UTC, n8n 02:13 UTC on 2026-11-10). Live freshness needs a read-only ledger credential and a FORGE-scoped n8n key (owner approval).
* No remote staging yet, so "staging test coverage" is local-workerd coverage.
* Claude scheduled tasks and Cloudflare cron/Pages runs have no run feed into FORGE yet (`never_observed`).
* Opportunity and build boards are empty by design until workstreams B and C write real runs.
