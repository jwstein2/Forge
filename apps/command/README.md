# FORGE Command (apps/command)

The executive dashboard for the FORGE portfolio. Frontend only; the platform API lives in `services/api` (owned by the platform workstream).

Status: **BUILT, TESTED locally** (unit, browser, accessibility, responsive). Not deployed anywhere.

## Run it

```bash
npm install
npm run dev            # http://localhost:5173, audit snapshot data
VITE_FORGE_API=http://localhost:8787/api/v1 VITE_FORGE_DEV_TOKEN=<token printed by the API dev server> npm run dev   # read the platform API
npm test               # 67 unit, component and API-mapping tests (Vitest)
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
| `/operations` | Operations & alerts: weekly in-app summary, filtered alerts, jobs with last success and pause/resume, integration health | Audit snapshot; pause is simulated in snapshot mode |
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

## API mapping

`src/data/apiSource.ts` reads the platform API (envelope `{ ok, data, meta }`, CONTRACTS.md v1.2.0) and `src/data/apiMap.ts` maps `@forge/contracts` types (vendored in `src/data/contracts.ts`) to the view models. Notable rules: pause returns 409 for jobs FORGE can't enforce (all n8n jobs) and the UI explains that; `needsOwner` comes from `Alert.needsOwner` (inferred from the next action only for pre-1.1.0 APIs); the revenue trend comes from `GET /series` and is omitted, never guessed, if that call fails; opportunity economics and seasonality show "unknown" / "not in this run" unless the Scout produced them.
