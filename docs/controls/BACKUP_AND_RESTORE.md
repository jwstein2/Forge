# FORGE backup and restore

Version 1.0 · 2026-11-10

## What is protected
| Data | Primary protection | Offline copy | Status |
|---|---|---|---|
| Sales ledger D1 `quiltplankit-sales` | Cloudflare D1 Time Travel (point-in-time restore, 30 days on paid plans, 7 days on Free; plan UNVERIFIED) | `scripts/backup-d1.ts` export, weekly | Time Travel: platform-provided. Export: BUILT, not yet run |
| FORGE platform D1 | Migrations + registry in git rebuild schema and seed data; Time Travel once staging exists | same script (target `forge-staging`) | Staging DB not created (needs approval) |
| Site source | `_FORGE_RELEASES` tgz snapshots + per-file sha256 (live-dollar thread); git once the repo is pushed | GitHub (owner action) | Snapshots exist since 2026-11-10 |
| n8n workflows | n8n version history | Export JSON to the repo (planned) | Version history only |

## Weekly export (owner's machine)
```
cd C:\Users\jwste\OneDrive\Desktop\FORGE
npm run backup:plan -w @forge/controls                                   # review commands
npm run backup:plan -w @forge/controls -- --execute --out "C:\Users\jwste\OneDrive\FORGE_BACKUPS"
```
- `wrangler d1 export --remote` only reads the database.
- Writes `<db>-<timestamp>.sql` and `manifest-<timestamp>.json` (bytes, sha256).
- Never deletes. Older files beyond 12 per database are listed as prunable.
- The export contains order ids, amounts and product names, no buyer emails (the Worker never stores them). Keep the folder private; OneDrive is acceptable.

## Restore
**Never restore over production without the owner's go-ahead.** Restore drills run against a local or staging DB.
1. Point-in-time: `npx wrangler d1 time-travel info quiltplankit-sales --timestamp=<ISO>` to check, then `npx wrangler d1 time-travel restore quiltplankit-sales --timestamp=<ISO>` (owner-approved). The release log records safe points (e.g. 2026-11-10T02:16:00Z before the M1 schema change).
2. From export (drill): `node scripts/restore-drill.mjs --file <export.sql> --manifest <manifest.json> --expect <counts.json> --out <report.json>`. It restores into a fresh in-memory SQLite (D1's engine), checks the manifest sha256, `integrity_check`, `foreign_key_check`, that every migration in services/api/migrations is recorded, and that row counts match counts read from the live DB at export time. Exit 0 = PASS; the JSON report is the G13 receipt. For staging only: `npm run backup:plan -w @forge/controls -- --execute --only forge-staging --out <dir>`.

## Drill cadence
Quarterly: restore the latest export to a local DB, recompute revenue, compare to the last weekly summary. Record PASS/FAIL as a gate G13 receipt.
