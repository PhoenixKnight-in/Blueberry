# Blueberry — React Dashboard

Week 4 of the Blueberry build. A React + TypeScript single-page app for
reviewing every package the extension has checked, and the reasons behind each
score.

It is a **pure reader**. It calls only `GET /packages`, `GET /packages/{id}`,
`GET /stats`, and `PATCH /packages/{id}` — it never triggers a verification, so
nothing a reviewer does here can cost the developer in the editor a round trip
or a slot in the GitHub rate-limit budget.

## Running it

```bash
cd dashboard
npm install
npm run dev          # http://127.0.0.1:5173
```

The backend must be running at `http://127.0.0.1:8000`. Point elsewhere with:

```bash
VITE_BLUEBERRY_API_URL=http://api.example.internal npm run dev
```

Vite inlines that at build time, which is why the Docker image takes it as a
build argument rather than a runtime environment variable.

The port is fixed (`strictPort`) because the backend's CORS allowlist names this
origin explicitly. A browser will not call the API from an origin the backend
has not allowed, so a silently-reassigned port would look like an outage.

## What it shows

| Piece | Component |
| --- | --- |
| KPI row — checks, open flags, hallucinations, typosquats | [StatsBar](src/components/StatsBar.tsx) · [StatTile](src/components/StatTile.tsx) |
| Severity distribution | [SeverityBar](src/components/SeverityBar.tsx) |
| Filters (name, severity, review status, minimum score) | [FilterBar](src/components/FilterBar.tsx) |
| The flagged-package table | [FlaggedPackageTable](src/components/FlaggedPackageTable.tsx) · [FlaggedPackageRow](src/components/FlaggedPackageRow.tsx) |
| Score, as a number and a meter | [RiskScoreCard](src/components/RiskScoreCard.tsx) |
| The full rule-by-rule breakdown | [SignalList](src/components/SignalList.tsx) · [PackageDetail](src/components/PackageDetail.tsx) |
| API layer | [services/api.ts](src/services/api.ts) |
| Data loading, debounced and abortable | [hooks/useDashboardData.ts](src/hooks/useDashboardData.ts) |

## Design notes

### An empty table and a broken backend must never look the same

This is the single most important behaviour in the app. If the backend is
unreachable, an unexplained empty table tells a team lead *"nothing has ever
been flagged"* — the exact opposite of the truth. So every API call returns an
`ApiResult` discriminated union instead of throwing, an error renders as a
banner **above** the table, and the empty state distinguishes "nothing matches
these filters" from "no checks recorded yet". Three tests cover it directly.

### Severity is never colour alone

The severity palette puts green next to red. The skill's validator measures that
pair at **ΔE 4.1 under deuteranopia** — far below the ΔE 8 floor, meaning a
red/green colourblind reader cannot reliably tell "safe" from "high risk" by hue.

So every severity on screen carries three encodings at once: a **glyph**
(`✓ ● ▲`), a **text label**, and a colour. The colour is reinforcement, never
the carrier. The severity distribution bar is `aria-hidden` and its legend
carries the counts, so the numbers are readable without seeing the bar at all.
The component tests run in jsdom, which has no notion of colour — which makes it
exactly the right place to prove severity is still readable.

### Stat tiles, not charts

Five headline numbers a reader looks *at* rather than compares across. Plotting
them would add a legend to ignore and nothing to read. The one chart on the page
is the severity distribution, where the job really is part-to-whole — and it is
direct-labelled with counts rather than relying on a colour key.

### Requests are debounced and abortable

Typing in the search box fires a request per keystroke otherwise, and — worse —
an early slow response can land *after* a later fast one and paint stale rows.
Every load runs behind a 300 ms debounce with an `AbortController`, and a
superseded response is discarded rather than rendered.

### Triage never edits the verdict

`PATCH /packages/{id}` moves a row between `open`, `ignored`, and `resolved`.
The score and severity are the engine's output and stay fixed, so the original
verdict remains auditable beside the decision a human made about it.

## Tests

```bash
npm test
```

78 tests across four files: the API layer (including that no failure is ever
turned into data), the formatting helpers, every component, and end-to-end tests
of the shell against a stubbed `fetch`.

## Build

```bash
npm run build        # tsc -b && vite build → dist/
npm run lint
```
