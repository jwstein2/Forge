# @forge/intelligence

FORGE Intelligence (workstream B, Milestone 4): the Opportunity Scout and Audience & Market Briefs, running as jobs on the FORGE job engine.

Nothing here spends money, calls a model, creates an account or launches anything. Every job is `runType: deterministic`, `usesModel: false`.

## How a Scout run works

1. The owner submits an **evidence pack** (`forge.evidence-pack/1`, see `src/types.ts`): 1 to 8 candidates, each with claims, criterion scores and gates. Each source can list `expect` strings, the figures that must still appear on the live page. A candidate can carry a full Audience & Market Brief.
2. `intel.scout.run` stores a `research_runs` row and fans out small jobs to fit the free-plan CPU budget:
   - `intel.source.check`: HTTP GET for each cited source, 6 per job, streamed with a byte cap. Outcomes are `confirmed`, `reachable`, `mismatch`, `dead`, `unreachable` or `skipped`.
   - `intel.signal.collect`: Wikimedia pageviews for up to 3 articles per candidate. This is a free, keyless interest proxy, never search volume.
3. `intel.scout.finalize` runs once every check is done:
   - It applies the evidence rules:
     - **R1:** a VERIFIED or ESTIMATED claim whose every cited source is dead or mismatched becomes INFERRED.
     - **R2:** a VERIFIED or ESTIMATED criterion must cite a claim that still holds.
     - **R3:** VERIFIED demand needs a claim that measures demand (marketplace sales or reviews, first-party data, or keyword volume).
     - Unreachable sources never downgrade a claim. They are reported for a person to check.
   - It adds the signal claims: VERIFIED averages and INFERRED seasonality.
   - It scores with the scoring model in `scoring-model.v1.json`. `src/score.ts` is a port of `tools/score.py` and gives identical results.
   - It stores the `opportunities` rows (one row is `recommended`), a draft brief through the platform's `storeBrief`, and a report in `research_run_reports`.
   - It marks the run `partial` when any source was unreachable or a signal was missing.

Weekly (Wednesday 05:00 UTC), `intel.source.recheck` re-checks every source cited by the latest briefs. It raises an info alert `intel:sources:dead` for any source that returns 404 or 410.

## Data sources

`GET /api/v1/intelligence/connectors` lists every data source. A source that needs a credential, an account or money stays unconnected until James approves it. Keyword Planner and Search Console show as connected only when their secret exists.

## Commands

```
npm test -w @forge/intelligence
npm run scout:local -w @forge/intelligence -- packs/2026-11-scout-01.json [--offline] [--out report.json]
```

`scout:local` runs the real jobs against an in-memory D1. From the cloud container every source is unreachable because of the network policy, so the run reports `partial` and downgrades nothing. On the staging Worker the same jobs make the real requests.

## Tables (migration `0200_intelligence.sql`)

| Table | Contents |
|---|---|
| `research_packs` | Submitted evidence packs, deduplicated by content hash |
| `research_source_checks` | One row per source per run |
| `research_signals` | Wikimedia series and summaries |
| `research_run_reports` | Ranking, downgrades, source summary and errors |

The platform tables `research_runs`, `opportunities`, `market_briefs` and `scoring_models` (migration 0004) hold the results that Command and Builder read.
