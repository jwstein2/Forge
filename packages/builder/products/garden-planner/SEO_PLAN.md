# Garden Planner: organic search plan for the January to March window

Status: **PROPOSED** (2026-11-11). Nothing here is live, indexed or approved. Search volumes are **UNKNOWN**: FORGE has no keyword-volume source yet (see "Measurement" below). Dates are planning deadlines worked back from the brief's seasonality claim, not forecasts.

## What the brief says

| Claim | Evidence | Use here |
|---|---|---|
| "Planning and seed-starting interest likely peaks January to March." | INFERRED | The window everything is timed to. |
| "Hypothesis only: free calendar pages indexed by January and Pinterest drip running; about 1 sale per 200 sessions" (base scenario) | INFERRED | The base scenario only holds if the free pages are indexed by January. |
| Keywords: "when to start seeds indoors", "seed starting calculator", "vegetable garden planner printable", "garden planting calendar" | Volume UNKNOWN, each phrase observed in search results or listings (VERIFIED) | Page targets below. |
| "Date questions ('when to start seeds') are answered by calculators, which FORGE builds; volume unknown." | INFERRED | Lead with the calculator, not articles. |
| At about $13.75 net per sale, $100/month needs 8 sales and $400/month needs 30; most sales likely January to May. | ESTIMATED (arithmetic) | Why the window matters: missing it loses most of a season. |

## Pages built (staging) and the query each answers

| Page | Target phrase (from the brief) | What makes it useful (not thin) |
|---|---|---|
| `/tools/` Planting calendar | "garden planting calendar", "seed starting calculator" | Working ZIP calculator: NOAA 1991-2020 frost estimate with station and distance, about 30 crops dated, printable. |
| `/when-to-plant/<crop>/` (30 pages) | "when to start <crop> seeds indoors", "when to plant <crop>" (long tail of "when to start seeds indoors") | Each page has its cited week offsets, a calculator filtered to that crop, and a worked example. Generated from data, so every page stays correct when the data changes. |
| `/when-to-plant/` index | "when to start seeds indoors" | Links all 30 crops. |
| `/products/frost-date-garden-planner/` | "vegetable garden planner printable" | Real page previews of the kit, price, contents. |

Not built yet: the "zone pages" from the offer ladder. USDA hardiness zones need the zone map data, and the 2023 map's licence has not been checked. They also answer a different question (winter cold) than planting dates (frost). Proposed instead: one page per state, listing frost estimates for that state's stations, from the same NOAA data. That needs owner agreement because it changes the offer ladder's wording.

## Timeline worked back from January

Google typically needs days to weeks to crawl and index a new site. A brand-new domain with no links can take longer. So the owner decisions are the critical path, not the build.

| By | What | Who |
|---|---|---|
| Done (staging) | Calculator, 30 crop pages, kit draft, sales page, copy deck v0.1.0 | Builder |
| **1 Dec 2026** | Owner decides: go/no-go on the fourth business, brand name and domain, budget (a domain is a small yearly cost; the exact price is checked at purchase), and Etsy yes/no | James |
| 1-8 Dec | Independent QA, G2 copy review, G8 decision on crop-timing attribution, operator details on legal pages | QA, Builder |
| 8-15 Dec | Production deploy on the approved domain (owner-run), sitemap submitted in Google Search Console (owner account, free), `noindex` removed only on that deploy | James, live-dollar thread |
| 15 Dec-15 Jan | Pinterest pins for the crop pages: one per crop, image rendered from the real calendar, through the existing QPK-style drip (owner approval per channel) | Operator |
| Jan-Mar 2027 | Measure (below). One "what to sow this month" email per month if the email list is approved. | Operator |
| 1 Apr 2027 | Falsifying test check: fewer than 1 sale per 200 kit-page sessions over the first 1,000 sessions means lower the price to $9 or sell the calendar alone (brief). | Owner |

If the 1 December decisions slip to January, the plan is still worth running, but expect most of the 2027 window to pass before the pages rank. Say that plainly in the go/no-go.

## On-page rules (enforced by the scaffold or checked at G2)

- One H1 per page that matches the query in plain words ("When to plant tomato").
- Titles: "<page> | <brand>". Meta descriptions to be written in the copy deck (not yet a scaffold field: add before launch).
- No invented figures, ratings or "best" claims. Every date shown is computed from the cited data.
- Fast and private: no third-party scripts, a small data file per 3-digit ZIP prefix, works on a 320px-wide phone.
- Staging stays `noindex` with `robots.txt` disallow-all. Only the approved production deploy removes them.

## Measurement

- Google Search Console (free, owner account): impressions and clicks per crop page, from launch day. This is the first real volume data FORGE will have for this niche.
- Google Ads Keyword Planner (free with an owner Google Ads account, no spend): volume ranges for the four phrases, labelled ESTIMATED. That would replace the UNKNOWN volumes above.
- The site beacon (already in the scaffold, off on staging): calculator uses, kit-page visits, checkout clicks. No cookies, no IP stored.
