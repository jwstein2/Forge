# FORGE incident runbook

Version 1.0 · 2026-11-10 · Severity: **critical** loses money/customers/data now; **warning** degrades; **info** for the weekly summary.
Owner contact: in-app Alerts. Out-of-cycle notification only for criticals matching `shouldInterrupt()` (checkout, payment, ledger, delivery, webhook, signature, secret, outage), once per incident.

## 1. Stop everything FORGE runs
`POST /api/v1/control/emergency-stop {reason}` (owner). Pauses FORGE-run jobs between steps. It does **not** stop n8n workflows or the sales Worker; those are separate (§4, §2). Resume with `POST /control/resume` after the cause is fixed.

## 2. Revenue pipeline failure (webhook rejected, ledger not written, probe fails)
1. Do not hand-insert ledger rows.
2. Check the sales Worker `/health`, then recent Lemon Squeezy webhook deliveries (dashboard → Webhooks) for status codes.
3. 401s: signing secret mismatch (often a trailing newline from a Windows shell). Re-set the Worker secret (production change: owner go-ahead).
4. 5xx: roll back the Worker to the previous version (`wrangler rollback` or redeploy the previous snapshot in `_FORGE_RELEASES`).
5. After the fix, use Lemon Squeezy "resend" for each failed delivery; ledger writes are idempotent on order id.
6. Run the monthly reconciliation for the affected days to prove nothing is missing.

## 3. Secret exposed (in a commit, log, chat, screenshot)
1. Treat it as compromised even if the repo is private.
2. Rotate per SECRETS_POLICY.md (receiver accepts new+old, switch sender, drop old). Owner go-ahead needed for production; ask once, with the exposure details.
3. Remove it from the working tree. If it reached git history on a pushed remote, history rewrite is a destructive action: owner decision.
4. Review the receiver's logs/ledger for use of the old secret since exposure (forged sales would show as orders with no matching Lemon Squeezy order in reconciliation).

## 4. n8n workflow failing or silent
1. Watchdog alert "late" or "never observed" → open the workflow's executions in n8n.
2. Deactivate a misbehaving workflow (e.g. email storm) from n8n; that is reversible and allowed in an incident, then tell the owner.
3. Fix in a draft, test with pinned data, publish. n8n active version must equal the reviewed version (gate G13).

## 5. Budget breach
FIN-BG-02 blocks new spend in that budget automatically (spend guard). Only the owner can raise a ceiling. Model-usage jobs over the envelope fail with a cost-cap error and wait for next month or an owner change.

## 6. Data loss or bad migration
See BACKUP_AND_RESTORE.md: D1 Time Travel restore to a timestamp, or import the latest export. Restoring production is a destructive action: owner go-ahead.

## After every critical
Record in the weekly summary: what happened, impact (orders/$ affected, VERIFIED or ESTIMATED), fix, and the control that should have caught it earlier.
