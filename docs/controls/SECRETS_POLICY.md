# FORGE secrets policy

Version 1.0 · 2026-11-10

## Where secrets live
| Secret kind | Store | Never in |
|---|---|---|
| Owner passwords, account logins, recovery codes | 1Password (owner) | FORGE DB, repo, n8n, chat |
| Cloudflare Worker secrets (LS signing secrets, forward secret, report token, HEARTBEAT_SECRET) | `wrangler secret put` (encrypted Worker secrets) | `wrangler.toml` vars, repo, logs |
| n8n outbound/inbound secrets | n8n **credentials** (Header Auth, Crypto credential) | n8n data tables, Code-node literals, workflow JSON |
| Local development | `.dev.vars` / `services/api/.data/` (git-ignored) | tracked files |
| CI | GitHub Actions secrets (only when a deploy job is approved) | workflow YAML |

FORGE Command's Account Directory stores safe identifiers and a 1Password item link only. It never stores or displays passwords or tokens (platform migration 0006 enforces 1Password-only vault links).

## Rules
1. **One secret, one purpose.** The key that signs sale forwards must not also be sent as a bearer token. Report tokens, forward-signing secrets, heartbeat secrets and provider webhook secrets are all distinct.
2. **Minimum 32 random characters** for any shared HMAC secret (`openssl rand -hex 32` or 1Password generator).
3. **Signed, timestamped machine calls.** New internal webhooks use the v2 scheme in `@forge/controls/signing` (timestamp inside the MAC, ±5 minute window, required external id).
4. **Least privilege.** FORGE credentials are separate from Sandbox Coffee and Z3D. Read-only where read is enough (ledger read binding, n8n read key).
5. **No secrets in output.** Logs, alerts, reports and scanner output show at most four characters and a fingerprint.
6. **Scan before every commit and in CI** (`npm run scan-secrets -w @forge/controls`, includes git history). A critical hit fails the build.

## Rotation (no downtime)
1. Generate the new secret in 1Password.
2. Receiver first: set the receiver to accept `new,old` (FORGE heartbeat ingestion accepts a comma list; the sales Worker accepts several LS secrets).
3. Switch the sender to the new secret.
4. After one full cycle with only new-secret traffic, remove the old secret from the receiver.
5. Record the rotation date (not the value) in the change log.

Rotate immediately on suspected exposure (see INCIDENT_RUNBOOK.md §3), otherwise yearly. Rotating a production secret is a production change and needs the owner's go-ahead.
