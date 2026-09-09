# Blueberry — Backend & Security Track

Verification backend for the **Blueberry AI Dependency Validator**: a FastAPI
service that checks whether a package suggested by an AI is real, healthy, and
not a typosquat, and returns an explainable risk report.

This is **Person 1 (Backend & Security)**'s side of the two-person build.

## Status — Week 4 complete: all four checks live, dashboard API served ✅

| Deliverable | Where |
| --- | --- |
| GitHub checker (repo resolution, activity, stars, archived, package match) | [app/services/github_checker.py](app/services/github_checker.py) |
| Rule-based risk score engine (separate module, tunable weights) | [app/services/risk_engine.py](app/services/risk_engine.py) |
| Levenshtein similarity engine vs. curated high-traffic names | [app/services/similarity.py](app/services/similarity.py) · [app/data/popular_packages.py](app/data/popular_packages.py) |
| Four-check `POST /check` pipeline, concurrent via `asyncio.gather` | [app/services/pipeline.py](app/services/pipeline.py) |
| GitHub token via env/secrets + rate-limit handling (cache + backoff) | [app/config.py](app/config.py) · [app/services/github_checker.py](app/services/github_checker.py) |
| Package-name validation before any external URL is built | [app/security/validation.py](app/security/validation.py) |
| Redis caching in front of PyPI/GitHub, keyed by package name, TTL'd | [app/services/cache.py](app/services/cache.py) |
| Postgres models + persistence for every check result | [app/db/](app/db/) |
| Dashboard API: list / detail / triage / stats | [app/routers/packages.py](app/routers/packages.py) · [app/schemas/dashboard.py](app/schemas/dashboard.py) |
| CORS allowlist so the browser dashboard can call this service | [app/main.py](app/main.py) · [app/config.py](app/config.py) |
| Test suite (295 tests, fully offline) | `tests/` |

Weeks 1–2 (skeleton, health check, and the four checks) are unchanged
underneath, and the Week 0 response contract is preserved field-for-field. The
extension in `../extension/` and the dashboard in `../dashboard/` are both built
against the contract below.

## Project layout

```
backend/
├── app/
│   ├── main.py              # App factory + lifespan (HTTP pool, Redis, DB)
│   ├── config.py            # Env-driven settings, incl. tunable risk weights
│   ├── routers/             # HTTP layer: /health, /check, /packages, /stats
│   ├── security/            # Validation of untrusted names and URLs
│   ├── services/
│   │   ├── pypi_checker.py      # Check 1: registry existence + metadata
│   │   ├── github_checker.py    # Check 2: repository health
│   │   ├── similarity.py        # Check 3: Levenshtein typosquat detection
│   │   ├── risk_engine.py       # Check 4: rule-based scoring
│   │   ├── pipeline.py          # Orchestration (asyncio.gather)
│   │   └── cache.py             # Redis, failure-tolerant
│   ├── db/                  # SQLAlchemy models, session, repository
│   ├── data/                # Curated popular-package corpus
│   └── schemas/             # Pydantic contracts: RiskReport, CheckSummary, ...
└── tests/                   # pytest + respx + fakeredis + SQLite
```

The **routers → services → schemas** split is what lets each check be built and
tested independently — which is the whole premise of the iterative process
model in the project doc.

## The pipeline

```
                       ┌─────────────────────┐
   package name ──────▶│  validate / sanitise │  (before any URL is built)
                       └──────────┬──────────┘
                                  │
              ┌───────────────────┴───────────────────┐
              │      asyncio.gather (concurrent)      │
              ▼                                       ▼
   ┌──────────────────┐                    ┌─────────────────────┐
   │  PyPI checker    │                    │ Similarity engine   │
   │  (Redis-cached)  │                    │ (in-process, local) │
   └────────┬─────────┘                    └──────────┬──────────┘
            │ metadata.project_urls                   │
            ▼                                         │
   ┌──────────────────┐                               │
   │ GitHub checker   │  (depends on PyPI metadata)   │
   │ (Redis-cached)   │                               │
   └────────┬─────────┘                               │
            └──────────────┬──────────────────────────┘
                           ▼
              ┌─────────────────────────┐
              │   Risk score engine     │  score + explanation
              └────────────┬────────────┘
                           ▼
                  RiskReport ──▶ Postgres (history)
```

PyPI and similarity are independent, so they run concurrently. GitHub reads the
repository URL out of the PyPI metadata, so it is a real data dependency and
must follow — running it concurrently would mean guessing the URL.

## Run it

```bash
cd backend
python -m venv .venv
# Windows PowerShell:  .venv\Scripts\Activate.ps1
# bash/macOS/Linux:    source .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env        # then set BLUEBERRY_GITHUB_TOKEN
uvicorn app.main:app --reload
```

Then open <http://127.0.0.1:8000/docs> for the OpenAPI UI.

Redis and Postgres are **optional for local development** — without them the
service logs a warning, skips caching, and skips writing history, but every
check still runs. To get the full stack:

```bash
cd ..                         # the compose file lives at the repository root
docker compose up --build     # api + redis + postgres + dashboard
```

### Try it

```bash
curl -X POST http://127.0.0.1:8000/check \
  -H "Content-Type: application/json" \
  -d '{"package_name": "requests"}'
```

Real responses from a live run:

| Input | Verdict | Why |
| --- | --- | --- |
| `requests` | `safe` (0) | Exists; `psf/requests` active, 54,291 stars, matches the package |
| `numpy` | `safe` (0) | Exists; `numpy/numpy` active, 32,706 stars, pushed today |
| `beautifulsoup4` | `safe` (15) | Exists and healthy, but the listing links no GitHub repo |
| `urllib4` | `high_risk` (75) | **Exists**, but one edit from `urllib3` and links no repository |
| `reqeusts` | `high_risk` (100) | Not on PyPI — hallucinated; closest real package is `requests` |
| `djangoo`, `flask-loginn` | `high_risk` (100) | Not on PyPI — the slopsquatting shape, one edit from a very popular name |

The fourth outcome — a listing that points at *somebody else's* repository — is
covered in `tests/test_risk_engine.py` rather than here, since it needs a
package whose PyPI metadata deliberately misdirects.

## Run the tests

```bash
pytest
```

295 tests, all offline: PyPI and GitHub are mocked with `respx`, Redis with
`fakeredis`, and Postgres with in-memory SQLite through the same models and
DDL. No containers needed to verify the scoring logic — which is the part that
gets edited most often.

## Design notes

### The risk engine is a separate module on purpose

The checkers report facts (`not on PyPI`, `archived`, `one edit from
requests`); `risk_engine.assess()` is the only thing that decides what a fact is
*worth*. It performs no I/O, so it is a pure function of its three inputs and
can be re-tuned in a unit test against real package profiles.

Weights live in `config.RiskWeights` and are environment-overridable, so tuning
is a config change rather than a code change:

```bash
BLUEBERRY_RISK__TYPOSQUAT_DISTANCE_1=70
BLUEBERRY_THRESHOLDS__HIGH_RISK_AT=55
```

Two decisions in there are worth knowing about:

- **An unreachable GitHub scores exactly zero points**, with a note saying so.
  Scoring it as risky would flag half the ecosystem during an outage; scoring it
  as healthy would be a false negative, which is worse than no check at all
  because the developer believes something was verified.
- **Repository health cannot discount a typosquat finding.** A squatter can
  point their listing at the victim's repository, so a healthy repo is evidence
  about maintenance, not about whether the *name* is impersonating something.

Every point in the score comes from a named rule that also produces a sentence,
and `sum(signal.points) == final_score` is asserted in the tests — a developer
can reconstruct the number by hand.

### Similarity runs first and needs no network

Pure string work over an in-process corpus of ~330 high-traffic names, so it
cannot fail, rate-limit, or time out. `reqeusts` is worth flagging even when
PyPI and GitHub are both unreachable. Two rules keep false positives down: an
exact corpus hit is never a squat (the corpus doubles as a whitelist), and
names of ≤4 characters only match at distance 1.

Tuning detection = editing `app/data/popular_packages.py`. No checker changes.

### GitHub rate limits

Unauthenticated GitHub allows **60 requests/hour per IP**; a token raises it to
5000. The token is read from `BLUEBERRY_GITHUB_TOKEN` and never hardcoded — a
test greps the whole `app/` tree for token literals to keep it that way. A
fine-grained token with **no scopes** is sufficient; the service only reads
public repository metadata.

When the limit is hit anyway:

- **Cache** — results are keyed by `owner/repo`, so two packages sharing a
  monorepo cost one request, and repeat checks cost none.
- **Backoff** — retries honour `Retry-After` / `X-RateLimit-Reset` with jitter.
- **A cap** — the primary limit resets on the hour, and an editor cannot block
  that long. Past `github_max_backoff_seconds` we stop and return
  `status: "unavailable"`, `rate_limited: true` rather than guessing.

Rate-limited results are deliberately **not cached**, which would otherwise
stretch a momentary limit into a 30-minute blind spot.

## Security notes

Package names come from AI-generated code, and repository URLs come from
publisher-controlled PyPI metadata. Both are treated as untrusted input, and
both are validated in `app/security/validation.py` *before* any URL is built.

- **Package names** are matched against PyPI's own grammar (PEP 503/508),
  anchored `\A..\Z` — `^..$` would accept a trailing newline and let CRLF
  header injection through. This blocks path traversal, absolute URLs, and
  whitespace/control characters. 67 tests cover this boundary.
- **Repository URLs** are allowlisted, not blocklisted: https/http only, host
  must be exactly `github.com`/`www.github.com` (no userinfo, no port, no
  `github.com.attacker.example`), and GitHub's own site routes (`/features/…`,
  `/sponsors/…`) are excluded so they cannot masquerade as repos. The URL we
  store is *rebuilt* from the validated `owner`/`repo`, so nothing from the
  original string survives. A package whose `Source` points at
  `http://169.254.169.254/` is simply "no repository", never a fetch.
- **No secrets in source.** All config is environment-driven; `.env` is
  git-ignored; the Docker image passes the token through from the host
  environment; the container runs as a non-root user.
- **Fails closed.** A PyPI outage returns `502`, never a `safe` verdict — the
  extension must be able to say "could not verify" rather than "verified".

## API contract

- `GET /health` — liveness probe.
- `POST /check` — body `{ "package_name": "...", "ecosystem": "pypi" }` →
  `RiskReport`. `400` unknown ecosystem, `422` invalid name, `502` PyPI down.
- `GET /packages` — paginated, filterable check history for the dashboard
  table. Filters: `search`, `package_name`, `severity`, `status`, `min_score`,
  `limit`, `offset`. Returns `{ items, total, limit, offset }`, where `total` is
  the count *after* filtering so the UI can render a paginator from one request.
- `GET /packages/{id}` — one stored check in full, signals included. `404` if
  there is no such row.
- `PATCH /packages/{id}` — body `{ "status": "open" | "ignored" | "resolved" }`.
  Records a reviewer's triage decision. The score is never edited: it is the
  engine's output, and keeping it fixed beside the decision is what makes the
  history auditable.
- `GET /stats` — the aggregates behind the dashboard's summary strip.

All four return `503` — never an empty list — when the history store is
unreachable. An empty table with no explanation reads as "nothing has ever been
flagged", which is the opposite of the truth during an outage.

### `RiskReport` shape

```jsonc
{
  "package_name": "urllib4",
  "normalized_name": "urllib4",
  "ecosystem": "pypi",

  // Week 0 flat fields — unchanged, the extension still reads these
  "exists_on_pypi": true,
  "github_repo_health": null,
  "similarity_score": 0.8571,
  "matched_package": "urllib3",

  "final_score": 75,                 // 0 = safe .. 100 = max risk
  "severity": "high_risk",           // safe | caution | high_risk
  "explanation": ["'urllib4' is a single character away from 'urllib3' ..."],
  "signals": [                       // same reasons, with rule ids and points
    { "rule_id": "typosquat_distance_1", "points": 60, "message": "..." },
    { "rule_id": "no_repository_link",   "points": 15, "message": "..." }
  ],

  // Detail objects (additive, for the dashboard)
  "pypi_metadata": { "name": "urllib4", "latest_version": "...", "...": "..." },
  "github":     { "status": "no_repository_link", "repo": null, "...": "..." },
  "similarity": { "is_typosquat_suspect": true, "edit_distance": 1, "...": "..." },

  "checked_at": "2026-09-01T09:34:47Z",
  "duration_ms": 37
}
```

## What the other tracks build on

The VS Code extension (`../extension/`) calls `POST /check` and nothing else, so
it never needs a database to be reachable. The React dashboard
(`../dashboard/`) calls only the endpoints above, so it never triggers an
outbound registry request. Neither client can slow the other down, and the
contract between them is asserted by this suite rather than by convention.
