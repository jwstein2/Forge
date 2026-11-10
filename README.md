# Project FORGE

**Build the machine that builds businesses.**

Monorepo for the FORGE platform: FORGE Command (dashboard), the FORGE API and database, the durable job engine, read-only adapters to the existing Bidline / Quilt Plan Kit / Loaf Ledger infrastructure, and the git registry of everything FORGE operates.

Nothing in this repo is deployed. Production deploys, new accounts, credential connections and spending require explicit owner approval.

## Quick start (any machine with Node 22.13+)

```bash
npm install
npm run check            # typecheck + 50+ tests + secret scan
npm run dev:api          # FORGE API on http://localhost:8787/api/v1 (prints the local dev token)
```

FORGE Command (UI): see `apps/command/README.md` (`cd apps/command && npm install && npm run dev`, with `VITE_FORGE_API=http://localhost:8787/api/v1`).

Cloudflare-native local run (workerd + local D1 + cron):

```bash
cd services/api
npm run migrate:local
npx wrangler dev --env development --test-scheduled   # then GET /__scheduled to fire the cron
```
Local secrets go in `services/api/.dev.vars` (gitignored): `DEV_AUTH_TOKEN=...`, `HEARTBEAT_SECRET=...`.

## Where things are

| Path | What |
|---|---|
| `docs/ARCHITECTURE.md` | Implementation architecture and what is built vs proposed |
| `docs/CONTRACTS.md` | API and data contracts |
| `docs/DECISIONS.md` | Architecture decision log |
| `registry/` | Authoritative records of niches, products, jobs, channels, integrations, accounts, costs, budgets, alerts (from the 2026-11-10 audit) |
| `services/api/` | Worker, migrations, adapters, orchestration, tests |
| `packages/contracts/` | Shared types and Intelligence JSON Schemas |
| `apps/command/` | FORGE Command UI (owned by the Command workstream) |
