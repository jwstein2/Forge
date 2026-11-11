# FORGE Command (apps/command)

The executive dashboard for the FORGE portfolio. Frontend only; the platform API lives in `services/api` (owned by the platform workstream).

Status: **BUILT, TESTED locally** (unit, browser, accessibility, responsive). Not deployed anywhere.

## Run it

```bash
npm install
npm run dev            # http://localhost:5173, audit snapshot data
VITE_FORGE_API=http://localhost:8787/api/v1 VITE_FORGE_DEV_TOKEN=<token printed by the API dev server> npm run dev   # read the platform API
npm test               # 97 unit, component and API-mapping tests (Vitest)
npm run test:e2e       # axe (light, dark, 320px), responsive at 320/375/820/1440, keyboard (Playwright)
npm run screenshots    # evidence screenshots → test-results/screens/
```

## Screens

| Route | Screen | Data today |
|---|---|---|
| `/` | Portfolio overview: outcome headline, headline figures, businesses, contribution statement, exceptions, trends, activity, channel matrix, budget | Audit snapshot (Nov 10) |
| `/niches`, `/niches/:id` | Executed niches and drill-down: products, money, alerts, channels, jobs, integrations, experiments | Audit snapshot |
| `/opportunities` | Opportunity Intelligence: ranked list, recommendation, hunch, score, evidence, seasonality, economics, competitors, risks, gaps | Honest empty state (Scout not run). `?preview=sample` shows labelled sample data |
| `/builder` | Builder workspace: nine milestones with outputs, cost, gates, blockers | Empty state. `?preview=sample` shows a labelled sample build |
| `/operations` | Operations & alerts: weekly summary (the Operator's when available), alerts filtered by severity, business and who raised them, controls findings, Operator schedules, site checks, content pipeline, publishing boundaries, emergency-stop state, jobs with pause/resume, integration health | API: live. Snapshot: Operator section says it is not connected; pause is simulated |
| `/accounts` | Account directory: identifiers, status, sign-in method, password-manager reference, console link | Audit snapshot; no vault linked yet |

## Honesty rules (enforced in types and tests)

- Every number is a `Metric` with `state`, `period`, `asOf` and `source`; the UI shows all four.
- `unknown` and `unconnected` metrics have `value: null` and render as "—" with a chip saying why.
- Test-mode orders are never added to revenue. Contribution reads "Incomplete" while any cost line is unknown, and lists the missing lines.
- Sample data exists only behind `?preview=sample` with a persistent banner; every sample metric is state `sample`.
- The account directory has no password field, reveal control or secret-named property.
- No approval queue and no daily email; the weekly summary is in-app.

## Layout

```
src/
  data/       types.ts (view models), fixtures.ts (audit snapshot), samples.ts, fixtureSource.ts, apiSource.ts, DataContext.tsx
  design/     tokens.css (colour, type, space; light + dark), styles.css (components)
  components/ AppShell, primitives (Stat, StateChip, badges, Section…), Statement, charts, blocks, Icon
  screens/    Portfolio, Niches, Opportunities, Builder, Operations, Accounts
  lib/        format, derive, clock
e2e/          a11y, responsive, screenshots
```

See `DESIGN_SYSTEM.md` for the design rules.

## Staging (same origin, behind Cloudflare Access)

Staging serves this build as Workers Static Assets on `forge-api-staging` (services/api/wrangler.toml `[env.staging.assets]`, SPA fallback, `run_worker_first = ["/api/*"]`), so the dashboard and `/api/v1` share one origin and one Access sign-in. Build with `VITE_FORGE_API=/api/v1 npm run build` (no dev token). `public/_headers` sets a strict CSP (self only) and security headers on the static files, since they bypass the API's header middleware. An expired Access sign-in (redirect, or a non-JSON 401/403) shows "reload the page to sign in again" instead of a raw error.

## API mapping

`src/data/apiSource.ts` reads the platform API (envelope `{ ok, data, meta }`, CONTRACTS.md v1.2.0) and `src/data/apiMap.ts` maps `@forge/contracts` types (vendored in `src/data/contracts.ts`) to the view models. Notable rules: pause returns 409 for jobs FORGE can't enforce (all n8n jobs) and the UI explains that; `needsOwner` comes from `Alert.needsOwner` (inferred from the next action only for pre-1.1.0 APIs); the revenue trend comes from `GET /series` and is omitted, never guessed, if that call fails; opportunity economics and seasonality show "unknown" / "not in this run" unless the Scout produced them. Operator data comes from `/operator/*` and `/control` (`src/data/operatorMap.ts`); each part degrades to empty plus a note if its call fails; checks FORGE could not run (`ok: null`, `checker_error`) count as unknown, not failing. Controls findings are alerts whose source is `controls:<CODE>`. Market briefs come from `/briefs`; the Scout run strip (status, cited sources re-checked, missing connectors) from `/intelligence/runs`. Portfolio adds money by business (known costs summed, unknown lines named, contribution "Incomplete" while any is unknown) and the Scout's strongest candidate. Operations shows `/system/scheduler` (1.4.0) first: "Stopped" in red when the cron has not run for 35 min; 404 = not deployed. Jobs show the heartbeat verdict and where the last success came from (runner heartbeat vs dated export). Operator phase 2 (404 means not deployed yet, shown as absent, not as an error): `/operator/policies/proposal` with one two-step "Apply all" (POST `.../apply {version}`, 409 reloads), `/operator/recommendations` decided as a batch, `/operator/lifecycle` where any snapshot state other than `live` shows subscriber numbers as UNKNOWN, never 0.
