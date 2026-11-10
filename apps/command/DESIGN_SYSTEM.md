# FORGE Command design system

**Concept: the view from above.** A calm surface that reports outcomes, not tasks. Warm paper and deep ink by day; night sky in dark mode. The first thing on every page is a sentence in plain words, generated from data ("Three businesses are running. None has taken a live payment yet."), followed by the figures that prove it.

## Type

| Role | Face | Use |
|---|---|---|
| Display | Newsreader (variable serif) | Page headlines, section titles, every money figure and hero number (lining, tabular) |
| UI | Inter (variable) | Body, labels, tables, controls |
| Mono | IBM Plex Mono | Job IDs, account identifiers, gate results |

Scale: 12 / 13 / 15 / 18 / 24 / 32 / fluid 28–44 px. Fonts are bundled locally (no runtime font CDN).

## Colour

Colour carries meaning only; ink carries information.

- **Surfaces:** `--bg`, `--surface-1`, `--surface-2`, `--surface-sunk`, hairline `--line`.
- **Ink:** `--ink-1/2/3`; `--ink-3` is ≥ 4.5:1 on surfaces in both themes.
- **Brand:** brass (`--brass`, text-safe `--brass-ink`) for the mark, kickers, the horizon rule and the "hunch". Night (`--night`) for the weekly summary.
- **Niche identity:** categorical slots 1–3 of the validated reference palette (QPK blue, Bidline orange, Loaf Ledger aqua), which pass all-pairs CVD checks in both modes. Used only for small identity marks (dot, top rule), never for text or status.
- **Status (reserved):** good, warn, serious, critical, neutral, each with a wash. Always paired with an icon and a word. All badge pairs pass axe colour contrast in light and dark.

## Evidence chips (the core component)

Every number carries one, so its trustworthiness is visible without colour:

| State | Look | Meaning |
|---|---|---|
| Verified | Solid tick, green wash | From an authoritative record |
| Estimated | Tilde, value prefixed "~" | Modelled or third-party |
| Unknown | Dashed outline, question mark | Source exists, value not established; value shows "—" |
| Not connected | Dashed, hatched, unplugged icon | No integration yet; never read |
| Test mode only | Flask, amber wash | Test records; never summed into revenue |
| Sample | Brass diagonal hatch | Design data, only under the SAMPLE banner |

Under every metric: **period · freshness · source** (`Nov 1–10, 2026 · as of 20 min ago · D1 sales ledger`).

## Components

`Stat` · `StateChip` · `Provenance` · `HealthBadge` · `StatusTag` (PROPOSED/BUILT/TESTED/LIVE/FAILED/UNVERIFIED) · `ChannelBadge` (verified/running/configured/failing/not connected) · `SeverityBadge` · `Statement` (contribution ledger) · `TrendChart` · `SeasonBars` · `Meter` · `AlertList` · `ActivityFeed` · `ChannelMatrix` · `EmptyState` · `SampleBanner` · `ExternalLink`.

## Data visualisation rules

- One axis per chart; never dual-axis. Single series uses one hue.
- 2px line, hairline solid grid, crosshair + tooltip on hover and on arrow keys, "View as table" on every chart.
- Null points are gaps, never zero. A chart with no values shows "No daily values from <source>" rather than a fake line.
- An all-zero series gets a single $0 tick; no invented scale above the data.
- Seasonality is labelled "relative interest (100 = peak)", never volume.

## Layout

- 248px rail on desktop; below 960px a top bar with a slide-in drawer.
- Content max 1240px; 16px side gutter on phones; no horizontal page scroll (tested at 375, 820, 1440). Wide tables scroll inside their own frame.
- Spacing on a 4px base; cards 10px radius, bands 16px.

## Accessibility

WCAG 2.2 AA checked by axe on every route in light and dark. Skip link, visible focus ring, landmark structure, one h1 per page, tables with scoped headers, charts with `role="img"` + description + table, targets ≥ 24px, reduced-motion respected, forced-colours fallback.
