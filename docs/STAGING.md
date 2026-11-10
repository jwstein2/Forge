# FORGE staging

Free tier only. The owner approved it on 2026-11-10 ("Approve all four", then "deploy Forge staging").

| Item | Value |
|---|---|
| Worker | `forge-api-staging` at https://forge-api-staging.sales-webhook.workers.dev |
| Database | D1 `forge-staging` (`df5672ae-252d-4b44-862e-4eff3ab7f4e5`). Migrations are tracked in its `d1_migrations` table. |
| Login | Cloudflare Access, team `autumn-flower-c26e.cloudflareaccess.com`, scope *All traffic*, policy *Cloudflare account*. The Worker also checks `OWNER_EMAILS` on every owner route. |
| Dashboard | `apps/command/dist`, served as static assets by the same Worker, so it uses the same origin and the same login. |
| Cron | `*/15`. The scheduling invocation fans out through the `SELF` service binding, one job per child invocation, at most 3 per tick. |
| Secrets | `HEARTBEAT_SECRET` and `OWNER_EMAILS` (set with `wrangler secret put`, never in git). |

## Deploy (owner's PC)

```
npm run deploy:staging      # check → build:command → wrangler deploy --env staging
```

The PC's `.claude/settings.local.json` allows only `wrangler deploy --env staging`, `secret put … --env staging`, `tail forge-api-staging` and `deployments list --env staging`. Production deploys still need the owner's explicit approval.

New migrations: apply them to `forge-staging` before deploying, then add a row to `d1_migrations`. Use either `wrangler d1 migrations apply forge-staging --env staging --remote` or the Cloudflare connector.

## Free-plan limits

These limits apply per invocation, which is why the cron fans out:

* 10 ms CPU (the first cron measured 203 ms with everything in one invocation, and 44 ms with 3 jobs);
* 50 subrequests, which include D1 queries (the first cron hit "Too many subrequests" with 10 jobs in one invocation).

A job that still exceeds these on its own has to split its work into child jobs, as `ops.seo_audit` does.

## Connections (approved 2026-11-10)

Heartbeats: staging has an Access *Bypass* application for `/api/v1/ingest/*` (owner-approved 2026-11-10), so n8n reaches the HMAC-checked route without a service token. `scripts/heartbeat-connect.ps1` (owner runs it on the PC) generates a new `HEARTBEAT_SECRET`, stores it in n8n forge_config through the intake, then sets it on the Worker; nothing is printed. `MAILERLITE_API_KEY` is set on staging.

## Heartbeats from n8n

`POST /api/v1/ingest/heartbeat` is behind Access like everything else. To let n8n reach it:

1. The owner creates an Access **service token** in Zero Trust → Access → Service credentials. This is a new credential and needs approval.
2. Add a *Service Auth* policy with that token to the `forge-api-staging` Access application.
3. Each n8n heartbeat node sends `CF-Access-Client-Id`, `CF-Access-Client-Secret`, `X-Forge-Timestamp` and `X-Forge-Signature: v2=<hmac>`. The body format is in docs/CONTRACTS.md §4–5, and n8n snippets are in packages/operator/docs/OPERATOR.md.

## Backup and restore

* D1 Time Travel (free, 30 days): `npx wrangler d1 time-travel info forge-staging` and `npx wrangler d1 time-travel restore forge-staging --timestamp=<ISO>`.
* Offline export: docs/controls/BACKUP_AND_RESTORE.md (`npm run backup:plan -w @forge/controls`).
* Rollback the Worker: `npx wrangler deployments list --env staging`, then `npx wrangler rollback <version-id> --env staging`.
