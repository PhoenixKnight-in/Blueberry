# Blueberry — AI Dependency Validator

Blueberry checks AI-generated package recommendations **before** a developer
installs them. When Copilot, Cursor, Claude Code, Gemini Code Assist, or Codeium
suggests a third-party library, nothing guarantees that library exists, is
maintained, or is safe. Blueberry sits between the suggestion and the terminal:
it verifies the package against PyPI, checks the health of its source
repository, compares the name against high-traffic packages, and returns an
explainable risk score.

Phase one is **Python / PyPI only**, deliberately.

**Team:** Parthiban M (24BYB0135) · Nisha Rathi (24BYB0137)

---

## The three failure modes it catches

| | What it is | What Blueberry says |
| --- | --- | --- |
| **Hallucination** | A name that sounds right but was never published | `reqeusts` → **high risk (100)** — not on PyPI, closest real package is `requests` |
| **Typosquatting** | A real, malicious package one edit from a trusted one | `urllib4` → **high risk (75)** — one character from `urllib3`, links no repository |
| **Low reputation** | Exists, but has none of the signals a real package has | `beautifulsoup4` → **safe (15)** — healthy, but no source repository is linked |

Attackers now pre-register names that LLMs are known to hallucinate — *slopsquatting* —
which is why the first row matters as much as the second.

## Repository layout

  ```
  blueberry/
  ├── backend/           # FastAPI service — the four checks and the risk engine
  ├── extension/         # VS Code extension — detects names, renders the warning
  ├── dashboard/         # React + TypeScript — review flagged packages
  ├── docs/              # Project guide, design document, coding standards
  └── docker-compose.yml # Postgres + Redis + API + dashboard
  ```

## Architecture

A thin client and a central backend. The extension detects package names and
forwards them; **it performs no verification itself**. All the checking happens
in the backend, which keeps the extension small and keeps every scoring decision
in one place.

```
   ┌──────────────────┐                          ┌──────────────────┐
   │  VS Code         │   POST /check            │  React           │
   │  extension       │─────────────┐    ┌───────│  dashboard       │
   └──────────────────┘             │    │       └──────────────────┘
                                    ▼    ▼        GET /packages, /stats
                            ┌───────────────────┐  PATCH /packages/{id}
                            │  FastAPI backend  │
                            └─────────┬─────────┘
              ┌───────────────────────┴───────────────────────┐
              │           asyncio.gather (concurrent)         │
              ▼                                               ▼
      ┌───────────────┐                              ┌─────────────────┐
      │ PyPI checker  │                              │ Similarity      │
      │ (Redis-cached)│                              │ engine (local)  │
      └───────┬───────┘                              └────────┬────────┘
              │ metadata.project_urls                         │
              ▼                                               │
      ┌───────────────┐                                       │
      │ GitHub checker│  (real data dependency — must follow) │
      │ (Redis-cached)│                                       │
      └───────┬───────┘                                       │
              └────────────────────┬──────────────────────────┘
                                   ▼
                        ┌─────────────────────┐
                        │  Risk score engine  │  score + explanation
                        └──────────┬──────────┘
                                   ▼
                    RiskReport ──▶ Postgres ──▶ dashboard
```

PyPI and similarity are independent, so they run concurrently. GitHub reads the
repository URL out of the PyPI metadata, so it is a genuine data dependency and
must follow — running it in parallel would mean guessing the URL.

## Quick start

### Everything at once

```bash
docker compose up --build
```

- API — <http://127.0.0.1:8000> (OpenAPI UI at `/docs`)
- Dashboard — <http://127.0.0.1:5173>

Set `BLUEBERRY_GITHUB_TOKEN` in your environment first. Unauthenticated GitHub
allows 60 requests/hour per IP; a token raises it to 5000. A fine-grained token
with **no scopes** is sufficient — the service only reads public repository
metadata.

### Piece by piece

```bash
# Backend
cd backend && python -m venv .venv
.venv\Scripts\Activate.ps1          # bash: source .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env                 # then set BLUEBERRY_GITHUB_TOKEN
uvicorn app.main:app --reload

# Dashboard
cd dashboard && npm install && npm run dev

# Extension
cd extension && npm install && npm run compile     # then press F5 in VS Code
```

Redis and Postgres are optional for local development: without them the service
logs a warning, skips caching and history, and every check still runs.

## Status

| Week | Deliverable | State |
| --- | --- | --- |
| 1 | Backend skeleton, PyPI integration | ✅ `backend/` |
| 2 | GitHub verification, risk engine, similarity | ✅ `backend/` |
| 3 | VS Code extension | ✅ `extension/` |
| 4 | React dashboard (+ the API it reads) | ✅ `dashboard/` · `backend/app/routers/packages.py` |
| 5 | Integration & testing | ✅ 479 tests; contracts verified against a live stack |
| 6 | Documentation | ✅ this file and the per-component READMEs |

## Tests

```bash
cd backend    && pytest        # 295 — offline: respx, fakeredis, SQLite
cd extension  && npm test      # 106 — no editor needed
cd dashboard  && npm test      #  78 — jsdom + stubbed fetch
```

**479 tests, and none of them need a network, a container, or an editor.** That
is a design property rather than a happy accident: the parser, the client, the
cache, and the risk engine are all pure modules with no I/O, so the parts that
get edited most often are also the cheapest to verify.

## The ideas that shaped the code

### Nothing ever fails open

A check that does not complete is reported as *"could not verify"*, never as
silence. In a security tool, silence reads as an all-clear, and the whole
premise here is that a developer is about to trust something they should not.
So, at every layer:

- a PyPI outage returns **502**, never a `safe` verdict;
- an unreachable GitHub scores **exactly zero points**, with a note saying so —
  scoring it as risky would flag half the ecosystem during an outage, and
  scoring it as healthy would be a false negative, which is worse than no check
  at all because the developer believes something was verified;
- the extension's client has **no path** that turns a timeout, a 502, or an
  unparseable body into a verdict;
- the dashboard renders an **error banner**, not an empty table — "nothing was
  flagged" and "we could not ask" are opposite conclusions.

### Every point in a score comes with a sentence

Rule-based scoring is chosen over a learned model specifically so a developer
can see *why*. `risk_engine.assess()` is the only thing that decides what a fact
is worth; every rule it fires produces both a point value and a plain-English
message, and the tests assert `sum(signal.points) == final_score`. A developer
can reconstruct the number by hand, and the dashboard shows them doing it.

### The false-positive budget is spent carefully

A wall of wrong warnings is how a security extension gets uninstalled. Three
filters run before anything is checked: the **standard library** (`import os` is
not a package), the **import-name → PyPI-name** map (you `import yaml` but
install `PyYAML`), and **relative imports**. On the scoring side, an exact hit
in the popular-package corpus is never a typosquat — the corpus doubles as a
whitelist — and names of four characters or fewer only match at distance 1.

### Weights are configuration, not code

Rule-based scoring is easy to get approximately right and hard to get exactly
right. The weights live in `config.RiskWeights` and are environment-overridable,
so retuning is a config change and can be tested against real package names
without touching a checker:

```bash
BLUEBERRY_RISK__TYPOSQUAT_DISTANCE_1=70
BLUEBERRY_THRESHOLDS__HIGH_RISK_AT=55
```

### Untrusted input is validated before a URL is built

Package names come from AI-generated code and repository URLs come from
publisher-controlled PyPI metadata. Both are treated as untrusted. Names are
matched against PEP 503/508 anchored `\A..\Z` (`^..$` would accept a trailing
newline and allow CRLF header injection). Repository URLs are **allowlisted**,
not blocklisted, and the URL that gets stored is *rebuilt* from the validated
owner and repo, so nothing from the original string survives. A package whose
`Source` points at `http://169.254.169.254/` is simply "no repository", never a
fetch.

## Where the implementation departs from the design document

Two places, both deliberate, both worth knowing about when reading the design
document alongside the code:

1. **The database is one denormalised table, not eight.** The design document
   models `packages`, `package_metadata`, `repository_health`,
   `similarity_results`, `risk_scores`, and `flagged_packages` as separate
   tables. In practice every check writes all of them at once and the dashboard
   reads them all back together, so the normalised form buys five joins per row
   and no extra information. `check_results` carries flat columns for everything
   the dashboard filters or sorts on and JSON blobs for the detail it only
   renders, with `status` covering `flagged_packages.status`. See
   `backend/app/db/models.py`.
2. **`popular_packages` and `extension_settings` are not database tables.** The
   popular-package corpus is an in-process Python list, which is what lets the
   similarity check run with no network and no I/O at all — it cannot fail,
   rate-limit, or time out, so `reqeusts` is flagged even when PyPI and GitHub
   are both unreachable. Extension settings live in VS Code's own settings
   store, where a developer expects to find them and where per-workspace scoping
   is free.

## Documentation

- [`docs/Blueberry_Project_doc_final.pdf`](docs/Blueberry_Project_doc_final.pdf) — project guide, domain knowledge, process model
- [`docs/Blueberry_Final_Design_Document.pdf`](docs/Blueberry_Final_Design_Document.pdf) — architecture, modules, DFDs, UML, database design
- [`docs/Blueberry_Coding_Standards.pdf`](docs/Blueberry_Coding_Standards.pdf) — languages, standards, structure, version control
- [`backend/README.md`](backend/README.md) · [`extension/README.md`](extension/README.md) · [`dashboard/README.md`](dashboard/README.md)

## Future work

Multi-registry support (npm, crates.io, Maven, NuGet), ML-based hallucination
detection to complement the rule-based approach, CI/CD integration so checks run
in a build pipeline rather than only at suggestion time, and an enterprise
dashboard for teams tracking dependency risk across repositories.
