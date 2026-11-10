# FORGE Platform Contracts (API v1.3.0)

**Date:** 2026-11-10 · **Owner:** Platform Architecture & Backend · Types: `packages/contracts/src/index.ts` (`@forge/contracts`) is authoritative; this page summarizes it.

## 1. Repo layout and ownership

```
forge/
├─ apps/command/            FORGE Command UI — owned by "Design FORGE Command interface" (workstream D)
├─ packages/contracts/      Shared TS types (platform) + schemas/intelligence/*.json (owned by workstream B)
├─ packages/intelligence/   @forge/intelligence: Opportunity Scout jobs, evidence rules, brief publishing (workstream B)
├─ services/api/            FORGE API Worker, migrations, adapters, orchestration, tests (platform)
│  ├─ migrations/           D1 SQL, applied locally only until owner approval
│  ├─ fixtures/             Dated read-only snapshots of the live ledger and n8n history
│  └─ test/                 Vitest suites
├─ registry/                Git source of truth for niches, products, jobs, channels, integrations, accounts, costs, budgets, alerts
├─ docs/                    ARCHITECTURE.md, CONTRACTS.md, DECISIONS.md
├─ scripts/                 check-secrets.mjs
└─ .github/workflows/ci.yml Typecheck + tests + secret scan (no deploy)
```

## 2. Conventions

* Niche ids: `bidline`, `quilt-plan-kit`, `loaf-ledger`; new slugs lowercase kebab-case.
* Timestamps ISO 8601 UTC. Storage money = integer cents; `Metric.value` for `usd` = dollars.
* JSON camelCase. Ids are prefixed text (`job_…`, `run_…`, `ev_…`, `brief_…`, `opp_…`).
* Status labels: `PROPOSED | BUILT | TESTED | LIVE | FAILED | UNVERIFIED`. Evidence labels: `VERIFIED | ESTIMATED | INFERRED | UNKNOWN`. Gates: `PASS | FAIL | NOT_RUN | BLOCKED`.

### Metric (agreed with workstream D)
```ts
{ value: number|null, unit: 'usd'|'count'|'pct', state: 'verified'|'estimated'|'unknown'|'unconnected'|'test_only',
  period: { start, end, label }, asOf: string|null, source: string, evidenceUrl?: string, note?: string }
```
Rules: `verified`/`estimated` always have a value; `null` only with `unknown`/`unconnected`; `test_only` never summed into revenue. (`sample` is UI-only and never produced by the API.)

## 3. Envelope

`{ ok: true, data, meta: { apiVersion, environment, generatedAt, sources: SourceFreshness[] } }` or
`{ ok: false, error: { code, message, details? } }` with codes `unauthorized 401 · forbidden 403 · not_found 404 · bad_request 400 · conflict 409 · evidence_required 422 · system_paused 423 · internal 500`.
`meta.sources` lists every data source with `mode: live|snapshot|seed|unconnected` and `asOf`, so the UI can show freshness globally.

## 4. Authentication

* Staging/production: Cloudflare Access in front; Worker verifies `Cf-Access-Jwt-Assertion` (RS256 via team JWKS, `aud`, `iss`, `exp`) and requires the email on `OWNER_EMAILS`.
* Development/test only: header `x-forge-dev-token: <token>` (Node dev server prints it and stores it in `services/api/.data/dev-token`).
* Public: `GET /health`, `POST /ingest/heartbeat` (HMAC v2 with timestamp; see §5).

## 5. Endpoints (base `/api/v1`)

| Method & path | Returns (`@forge/contracts`) | Notes |
|---|---|---|
| GET `/health` | `{status, environment, apiVersion}` | public |
| GET `/me` | `Me` | |
| GET `/sources` | `SourceFreshness[]` | |
| GET `/portfolio` (alias `/portfolio/summary`) `?period=mtd\|last7\|last30\|all\|YYYY-MM` | `PortfolioSummary` | niches, totals, `financials`, `budget`, alert counts, recent activity, `unknowns[]` |
| GET `/niches` | `NicheSummary[]` | |
| GET `/niches/:id` | `NicheDetail` | products, channels, jobs (incl. shared), integrations, costs, alerts, financials, funnel, evidence |
| GET `/financials?niche=<id>\|portfolio&period=` | `FinancialBreakdown` | `missingLines[]` names unknown cost lines |
| GET `/series?metric=revenue\|page_views&niche=<id>\|portfolio&period=` | `TrendSeries` | daily points; null after the source's asOf; `unknown` where events can't be attributed |
| GET `/products?niche=` · `/channels?niche=` · `/integrations?niche=` · `/costs?niche=` · `/budgets` | arrays | |
| GET `/accounts` | `Account[]` | safe identifiers + password-manager link only |
| GET `/alerts?state=open\|acknowledged\|resolved&niche=` · POST `/alerts/:id/acknowledge` | `Alert[]` | `needsOwner` true only for owner decisions (v1.1) |
| GET `/activity?limit=&niche=` | `ActivityItem[]` | runs and ledger orders (test-mode flagged) |
| GET `/evidence?subjectType=&subjectId=` | `EvidenceRef[]` | |
| GET `/jobs?niche=` | `RegistryEntry[]` | agents/workflows/scheduled jobs with `lastRun`, `lastSuccess`, `heartbeat`, `pausable`, `runsLast30d` |
| GET `/jobs/:id/runs` | `RunSummary[]` | |
| POST `/jobs/:id/pause` · `/jobs/:id/resume` | `{id, paused}` | **409** when the job runs outside FORGE's control (e.g. n8n) |
| POST `/status` `{subjectType: product\|registry, subjectId, toStatus, evidence?:{claim,source,url}}` | `{from,to,evidenceId}` | **422** for TESTED/LIVE without evidence |
| GET `/opportunities` | `OpportunityBoard` | `state: not_run` until the Scout writes a run |
| GET `/briefs?niche=` · POST `/briefs` | `MarketBriefEnvelope[]` | POST validates against `brief.schema.json`, stores as draft |
| GET `/intelligence/connectors` | `ConnectorState[]` | Scout data sources and their state (`connected`, `blocked`, `requires_owner_account`, `requires_paid_access`); never a number for an unconnected source (workstream B) |
| POST `/intelligence/scout-runs` `{pack}` | `{packId, jobId, created}` | owner only; **422** for an invalid evidence pack (`forge.evidence-pack/1`); idempotent on pack content; enqueues `intel.scout.run` |
| GET `/intelligence/runs` · `/intelligence/runs/:id` | runs with report; detail adds `sourceChecks[]`, `signals[]` | Scout and weekly source re-check runs. Results also appear on `/opportunities` and `/briefs` |
| GET `/builds` · `/builds/:id` | `BuildBoard` / `Build` | `state: none` until a build is commissioned |
| POST `/orchestration/jobs` `{kind, input?, nicheId?, idempotencyKey?}` · GET `/orchestration/jobs[/:id]` | `{id, created}` / `Job` | kinds: `registry.seed`, `ledger.sync`, `n8n.sync`, `heartbeat.watchdog`, plus package kinds (builder, operator, `intel.*`) |
| POST `/orchestration/tick` | outcomes | development/test only |
| GET `/approvals` · POST `/approvals/:id/decide {approve}` | | owner only |
| GET `/control` · POST `/control/emergency-stop {reason}` · POST `/control/resume` | `SystemControl` | global kill switch for FORGE-run work |
| POST `/ingest/heartbeat` | `{recorded}` | body `{registryId, startedAt, finishedAt?, status, evidenceUrl?, modelCostCents?, error?, externalId}` (externalId **required**, dedupes replays); headers `X-Forge-Timestamp: <unix seconds>` and `X-Forge-Signature: v2=hex(HMAC-SHA256(HEARTBEAT_SECRET, ts + "." + rawBody))`; rejected outside ±300 s; secret ≥32 chars, `new,old` during rotation. Helper: `sign()` in `@forge/controls/signing` |

## 6. Mapping notes for apps/command (VIEW_MODELS.ts)

| UI view model | API source |
|---|---|
| `PortfolioSummary.financials` (`FinancialStatement`) | `PortfolioSummary.financials` (`FinancialBreakdown`): `grossSales→grossRevenue`, `hostingAndSoftware→softwareAndHosting`, `missingLines` same name |
| `Niche` | `NicheDetail` (`healthReasons[]` → `healthReason`) |
| `Job` | `RegistryEntry`: `heartbeat==='ok'→heartbeatOk true`, `late→false`, others → `null`; `runsLast30d→monthlyRuns`; runner `claude→claude_scheduled` |
| `Channel.state` | `ChannelStatus` (`unconnected→not_connected`) |
| `BuildStatus` | `ImplStatus` lower-cased |
| `Severity` | `critical|warning|info` (API has no `serious`) |
| `OpportunityBoard` / `BuildBoard` | same names; content fields are in `content` per the Intelligence schemas |

## 7. Ledger coordination (with "Reach first verified live dollar")

FORGE reads the existing ledger D1 `quiltplankit-sales` and never writes to it. Current schema (read 2026-11-10): `sales(id, event, order_id, test_mode, currency, total_cents, tax_cents, refunded_cents, product, created_at, received_at, source, campaign, vertical, owner_test)` and `events(day, name, path, source, count)`. Requests to the owning thread, so FORGE can attribute per niche without guesswork: (1) add a `site` column to `events` (or prefix every site's paths, as Bidline now does with `/bidline/`); (2) DONE 2026-11-10: `sales.owner_test` exists and FORGE imports it; (3) keep `vertical` mandatory on every sale. FORGE's adapter will pick these up with a one-line mapping change.

## 8. Changelog

* 1.3.0 (2026-11-10): additive only. `/intelligence/*` routes (connectors, scout-runs, runs) and `intel.*` job kinds from @forge/intelligence (migration 0200); brief method enum adds `public_dataset` and `keyword_volume`. Operator phase 2 routes `/operator/policies/proposal[/apply]`, `/operator/lifecycle`, `/operator/recommendations[/decide]`; weekly summary adds `recommendations`. Optional `MAILERLITE_API_KEY` (unset = lifecycle `unconnected`). Clients on 1.2.0 keep working.
* 1.2.0 (2026-11-10): `RegistryEntry.heartbeat` adds `stale` (judged from a snapshot older than 2x the interval; current health unknown, render like unknown, never as ok). Loaf Ledger page views are `unconnected` (no beacon). Security headers on all responses. Ledger import now reads the live `sales.owner_test` flag; owner verification purchases never count as revenue. Account vault links must be 1Password links.
* 1.1.0 (2026-11-10): `Alert.needsOwner`; `GET /series` daily trend series; dev-server CORS allows credentials. Severity stays three levels (critical, warning, info).
* 1.0.0 (2026-11-10): initial contract.
