# Architecture Decision Log

| # | Date | Decision | Why | Revisit when |
|---|---|---|---|---|
| ADR-001 | 2026-11-10 | Build the platform on Cloudflare Workers + D1 + Pages, not Supabase or a new stack | Existing sites, sales Worker and ledger already run there on the free tier; audit recommends no new vendor | D1 limits (10 GB/db, query time) become binding |
| ADR-002 | 2026-11-10 | Separate FORGE platform DB; read the live sales ledger, never write it | Protects the revenue path; the "first live dollar" thread owns ledger changes | Ledger v2 is merged by its owner and the owner approves consolidation |
| ADR-003 | 2026-11-10 | Durable job engine in D1 (leases, checkpoints, bounded retries, kill switches) driven by Cloudflare cron | Work must survive sessions; no new paid queue/orchestrator; n8n stays for existing workflows | Throughput needs Cloudflare Queues or Workflows |
| ADR-004 | 2026-11-10 | Observe n8n rather than re-implement its workflows; external runners report via signed heartbeats | Preserve working automation; close audit defect D3 (no heartbeat ledger) | n8n is replaced or isolated into its own project |
| ADR-005 | 2026-11-10 | Owner auth via Cloudflare Access + in-Worker JWT verification; dev token only in development/test | Free, uses owner's identity provider, defense in depth | Multi-user or SaaS tenants |
| ADR-006 | 2026-11-10 | Metric contract with explicit `unknown`/`unconnected`/`test_only` states, enforced in code and tests | Constitution §4: never fabricate; "unconnected" must never render as $0 | — |
| ADR-007 | 2026-11-10 | Node 22 built-in SQLite as the D1 test double; same SQL validated on local D1 | Zero native deps, runs on James's PC and CI without a Cloudflare account | — |
| ADR-008 | 2026-11-10 | Registry JSON in git seeds the DB idempotently (ON CONFLICT DO NOTHING) | Git is the source of truth for definitions; runtime state (pauses) is never overwritten by a re-seed | Registry needs edits to existing rows → add versioned registry migrations |
| ADR-009 | 2026-11-10 | apps/command keeps its own lockfile and is outside root npm workspaces | Workstream D owns it end to end; avoids cross-workstream lockfile churn | Shared packages need to be consumed directly by the UI build |
