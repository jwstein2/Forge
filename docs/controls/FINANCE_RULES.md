# FORGE finance rules

Version 1.0 · 2026-11-10 · Implemented in `@forge/controls` (finance/*) and the platform's `domain/finance.ts`.

## 1. What counts as revenue
- Source of truth: the D1 ledger `quiltplankit-sales.sales`, written only by the signed sales Worker.
- Revenue = `order_created` rows with `test_mode = 0` **and** `owner_test = 0`, amount `total_cents − tax_cents`.
- Refunds = `order_refunded` rows under the same filter, `refunded_cents`.
- Test-mode and owner-test orders are always reported separately and never summed into revenue.
- A live order with `vertical = 'unknown'` counts in the portfolio total but in no niche, and raises a critical alert (FIN-LI-01) until fixed.
- KDP royalties are not in the ledger. They stay UNKNOWN until imported from KDP reports.

## 2. Contribution per niche (monthly)
`gross sales − refunds − payment fees − direct product costs − niche spend − allocated shared costs`
- Payment fees: Lemon Squeezy 5% + $0.50 per order is an ESTIMATE until the monthly payout reconciliation supplies actual fees.
- Shared costs: allocated by usage share (n8n executions, model usage records) where recorded, otherwise equally across live niches. The rule is stored on the cost line.
- If any cost line is unknown, contribution is shown as **unknown**, with the known-lines subtotal labelled as such. Never $0.

## 3. Monthly reconciliation (gate G6)
1. Owner downloads the Lemon Squeezy orders export for the month (until the API is connected).
2. `reconcile(ledgerRows, parseProviderCsv(csv))` must return `matched` (difference ≤ $0.01, no missing orders, no amount mismatches).
3. A mismatch raises FIN-RC-01 (critical). Missing-in-ledger means a webhook was missed: replay it from Lemon Squeezy, do not hand-insert rows.
4. Actual fees from the export replace the estimate for that month.

## 4. Spending
- Default deny. A budget ceiling ($1,500 cumulative on record) is a limit, not permission.
- Cash spend (purchase, subscription, domain, ads) needs an owner approval record that is `approved`, decided by the owner, unexpired, and bounded (`maxCents`, and vendor/budget if given). Recurring charges need `recurring: true`.
- An approval never raises a ceiling. Spend that would cross a ceiling is refused even when approved.
- Model/API usage by FORGE jobs is pre-approved only inside the monthly envelope (`bud_api_month`, $15) and stops when month-to-date plus the estimate would exceed it. Unknown estimates are refused.
- Budget alerts: 80% warning, 100% critical (owner decision), shown in Command Alerts and the weekly summary. No daily emails.

## 5. Evidence labels
Every money figure carries VERIFIED / ESTIMATED / INFERRED / UNKNOWN and its source and as-of time. Figures from a snapshot say so.
