# @forge/builder — FORGE Ecosystem Builder (workstream C, Milestone 5)

Turns an approved opportunity's **Audience & Market Brief** into a versioned **Launch Blueprint**, then tracks a build through nine stages until the owner decides whether to launch. **FORGE never launches anything on its own.**

Status: **BUILT and TESTED locally** (51 tests). Not registered in the API yet, not deployed, not independently reviewed.

## What is here

| Path | What |
|---|---|
| `schemas/launch-blueprint.schema.json` | Launch Blueprint v1 (JSON Schema 2020-12, closed). Owned by this workstream, like Intelligence owns `brief.schema.json`. |
| `src/generate.ts` | Deterministic generator: same brief + options gives a byte-identical blueprint. It rearranges what the brief says and lists what is missing as `unknowns`. It never invents demand, proof, prices, targets or customers. |
| `src/validate.ts` | Schema check + semantic rules + traceability (every cited claim must exist in the source brief with identical wording and evidence label). |
| `src/playbooks.ts` | Reusable playbooks: free resource, spreadsheet template, printable PDF, bundle, KDP book, affiliate content. Unknown formats become `unsupported`, never guessed. |
| `src/stages.ts` | The nine platform `BUILD_STAGES` with tasks, roles, gates (B0, B1, G1–G15 from `audit/final/FORGE_RELEASE_GATES.md`) and owner approvals. |
| `src/pipeline.ts` | Pure state machine: gate receipts + approvals → stage and build status. Self-certified receipts never count; a second FAIL escalates; launch needs the owner's approval even when every gate passes. |
| `src/handlers.ts` | Engine jobs: `builder.blueprint.generate`, `builder.build.plan`, `builder.build.evaluate`. Deterministic, no spend, FORGE tables only. |
| `src/render.ts` | Markdown view of a blueprint (the JSON is authoritative). |
| `bin/blueprint.ts` | CLI to generate/validate/render locally. |
| `blueprints/<niche>/` | v1.0.0 draft blueprints for Bidline, Quilt Plan Kit and Loaf Ledger, generated from Intelligence briefs (dated copies in `test/fixtures/`). |

## Conventions (no schema change to the platform)

* Blueprints are stored whole in `launch_blueprints` with a sha256 content hash; `brief_ref` is the `market_briefs.id`.
* Gate receipts for a build use `gate_receipts.release_id = "<buildId>:<stage>"`. `launch_readiness` reads the latest receipt per gate across the whole build.
* Owner approvals for a build use `approvals.scope = "build:<buildId>"` and `approvals.action` = the exact text in the stage's `owner_approvals`. Only the owner can approve (database CHECK).
* A blueprint is always `implementation_status: PROPOSED`. Build progress lives in `builds` / `build_stages`.
* A new business (niche not in `niches`) gets a build in `awaiting_approval` with a pending "Select this opportunity for a build" approval. Research cannot pass until the owner approves; the blueprint stage then needs the owner's budget ceiling and boundaries.
* A brief that says `hold` or `stop` refuses generation unless the caller passes `allowHold`.

## Run

```bash
npm install                                  # at repo root
npm test -w @forge/builder                   # 51 tests, incl. integration with the real migrations + engine
npm run typecheck -w @forge/builder
npm run blueprints -w @forge/builder         # regenerate the three committed blueprints
npm run blueprint -w @forge/builder -- path/to/brief.json --out /tmp/bp [--new-business] [--budget-cents 50000]
npm run blueprint -w @forge/builder -- --validate blueprints/bidline/launch-blueprint.v1.0.0.json --brief test/fixtures/bidline.brief.json
```

## Registering with the API (platform thread)

```ts
// services/api/src/orchestration/handlers.ts
import { builderHandlers } from "@forge/builder/handlers";
export const defaultHandlers = () => new Map([registrySeed, ledgerSync, n8nSync, heartbeatWatchdog, ...builderHandlers({ NonRetryableError })].map((h) => [h.kind, h as HandlerDef]));
```
and add `"@forge/builder": "0.1.0"` to `services/api/package.json` dependencies. `POST /orchestration/jobs` picks the kinds up from the handler map.

## Not done yet (next)

* **Site scaffold generator** (page map + brand tokens → staging site skeleton using shared components). Waits on the shared component library and a brand stage; must not produce a generic layout.
* **Fourth-business blueprint** (directive M7). Needs a real Scout brief for a new opportunity; the generator and the new-business approval path are ready for it. No synthetic research is ever published as a blueprint.
* Product generators reuse the existing reproducible builders (e.g. `forge-m1/bidline-kit/build_kit.py`) rather than replacing them.
