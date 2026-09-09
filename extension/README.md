# Blueberry — VS Code Extension

Week 3 of the Blueberry build. The extension is the entry point of the system:
it watches for package names in AI-generated code, sends them to the FastAPI
backend, and renders the verdict inline before the developer runs `pip install`.

It performs **no verification itself**. Every check happens in the backend, which
is what keeps this side small and lets the scoring rules change without shipping a
new extension.

## What it does

| Capability | Where |
| --- | --- |
| Editor event listener (edit / open / save / focus, debounced) | [src/extension.ts](src/extension.ts) · [src/util/debounce.ts](src/util/debounce.ts) |
| Import & command parser (`.py`, `requirements.txt`, `pyproject.toml`, `pip install`) | [src/parser/packageParser.ts](src/parser/packageParser.ts) |
| Package candidate extraction & normalisation (stdlib filter, import→PyPI map) | [src/parser/stdlib.ts](src/parser/stdlib.ts) · [src/parser/importMap.ts](src/parser/importMap.ts) |
| Backend API client (timeouts, cancellation, fails closed) | [src/client/backendClient.ts](src/client/backendClient.ts) |
| Local cache (TTL, in-flight de-duplication) | [src/client/localCache.ts](src/client/localCache.ts) |
| Risk response handling & concurrency limiting | [src/checker.ts](src/checker.ts) |
| Inline decoration renderer + hover | [src/ui/decorations.ts](src/ui/decorations.ts) · [src/ui/format.ts](src/ui/format.ts) |
| Diagnostics provider (Problems panel) | [src/ui/diagnostics.ts](src/ui/diagnostics.ts) |
| Quick-fix / command actions | [src/ui/codeActions.ts](src/ui/codeActions.ts) |
| Status bar | [src/ui/statusBar.ts](src/ui/statusBar.ts) |

That table is the Design Document's "VS Code Extension Modules" list, one row per
module.

## Running it

```bash
cd extension
npm install
npm run compile
```

Then press **F5** in VS Code to launch an Extension Development Host. Open a
Python file and type `import reqeusts`.

The backend must be running — `docker compose up` from the repository root, or
`uvicorn app.main:app --reload` from `backend/`. If it is not, the status bar
says **Blueberry: offline** rather than going quiet.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `blueberry.enabled` | `true` | Check as you type. The commands work either way. |
| `blueberry.backendUrl` | `http://127.0.0.1:8000` | Where the FastAPI service is. |
| `blueberry.dashboardUrl` | `http://127.0.0.1:5173` | Opened by *Open Dashboard*. |
| `blueberry.sensitivityThreshold` | `20` | Minimum score that warrants a warning. |
| `blueberry.enabledEcosystems` | `["pypi"]` | Phase one is PyPI only. |
| `blueberry.ignoredPackages` | `[]` | Never warn about these. |
| `blueberry.debounceMs` | `600` | Quiet period after the last keystroke. |
| `blueberry.requestTimeoutMs` | `8000` | How long to wait on the backend. |

## Commands

- **Check Dependencies In This File** — re-check, bypassing the local cache.
- **Check A Package By Name…** — verify a name without writing it anywhere.
- **Show Risk Details** — open the full scoring breakdown.
- **Ignore This Package** — add to `blueberry.ignoredPackages` for this workspace.
- **Open Dashboard** — launch the React dashboard.
- **Clear Local Result Cache**.

## Design notes

### It never fails open

A check that does not complete is rendered as *"could not verify"*, never as
silence. Silence in a security tool reads as an all-clear, and the whole premise
of Blueberry is that a developer is about to trust something they should not.
`BackendClient` has no path that turns a timeout, a 502, or an unparseable body
into a verdict, and `shouldWarn()` surfaces failures regardless of the
sensitivity threshold. Both are asserted in the tests.

### The parser is a line scanner, not an AST

A real Python AST needs a syntactically valid file, and the moment Blueberry most
wants to speak up is *while a completion is being typed* — when it usually is not
valid. A line scanner degrades to "finds slightly less" rather than "finds
nothing". Docstrings are tracked so an `import` in an example block is not
mistaken for a dependency.

### The false-positive budget is spent carefully

Three filters, in order, because a wall of wrong warnings is how a security
extension gets uninstalled:

1. **Standard library** — `import os` is not a package. ~200 names, covering
   3.8–3.12 together so a module removed in a later version is still not reported
   as hallucinated.
2. **Import name → PyPI name** — you `import yaml` but install `PyYAML`. Checking
   the import name would report some of the most popular packages in the
   ecosystem as "not on PyPI".
3. **Relative and private imports** — `from .models import X` is workspace-local.

### Two caches, two jobs

The backend's Redis stops repeated checks from re-hitting PyPI and GitHub. The
cache here stops a *keystroke* from reaching the backend at all. Failures get a
15-second TTL rather than 5 minutes, so a backend that comes back up is noticed
in seconds instead of requiring a restart.

### Cancellation is a correctness property

When an edit supersedes a scan that is already waiting on the network, its
character offsets no longer describe the document. Publishing them would put
squiggles under the wrong text. `KeyedDebouncer` keeps each run registered for
its whole lifetime — not just until its timer fires — so a supersede aborts the
in-flight request, and `scanDocument` drops the result rather than rendering it.

## Tests

```bash
npm test
```

106 tests, no editor required. Everything below the `vscode` seam — parser,
client, cache, checker, formatter, debouncer — is pure and imports no editor API,
which is exactly why it can be tested this way. `src/extension.ts` is the only
file that wires the two halves together.
