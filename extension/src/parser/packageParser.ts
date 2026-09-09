/**
 * Extracts package-name candidates from the text a developer is looking at.
 *
 * Four sources, because an AI assistant suggests a dependency in four places:
 * an `import` line it wrote, a `requirements.txt` entry, a `pip install`
 * command in a comment or a notebook cell, and a `pyproject.toml` dependency
 * list.
 *
 * This is a line scanner rather than a real Python parser. That is a
 * deliberate trade. A full AST would need the file to be syntactically valid,
 * and the moment Blueberry most wants to speak up is *while a completion is
 * being typed*, when it usually is not. Scanning line by line degrades to
 * "finds slightly less" instead of "finds nothing", which is the right failure
 * mode here. Triple-quoted strings are tracked so an `import` inside a
 * docstring or an example block is not mistaken for a real one.
 *
 * Every function in this file is pure — no `vscode` import anywhere — so the
 * whole extraction layer is unit-testable without an editor.
 */

import type { CandidateSource, PackageCandidate } from '../types';
import { toDistributionName } from './importMap';
import { isStandardLibrary } from './stdlib';

/** PEP 508 names: letters, digits, and single `.`/`-`/`_` separators. */
const VALID_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** `import a.b, c as d` — everything after the keyword. */
const IMPORT_RE = /^\s*import\s+(.+)$/;

/** `from a.b import c` — only the module path is a package candidate. */
const FROM_IMPORT_RE = /^\s*from\s+([A-Za-z0-9_.]+)\s+import\s+/;

/** `pip install x y`, `pip3 install`, `python -m pip install`, `uv pip install`. */
const PIP_INSTALL_RE =
  /(?:^|\s|`)(?:python[0-9.]*\s+-m\s+)?(?:uv\s+)?pip[0-9.]*\s+install\s+([^\n`#;]+)/g;

/** A `name==1.0` / `name[extra]>=2` requirement specifier. */
const REQUIREMENT_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(?:[<>=!~;].*)?$/;

/**
 * Normalise a raw token into a checkable PyPI distribution name.
 *
 * Returns `null` when the token should not be checked at all — a relative
 * import, a standard-library module, or something that is not a package name.
 */
export function normalizeCandidate(raw: string): string | null {
  const token = raw.trim();
  if (!token) {
    return null;
  }
  // `from . import x` / `from .models import y`: workspace-local, never PyPI.
  if (token.startsWith('.')) {
    return null;
  }
  // Only the top-level package is on PyPI; `os.path` lives inside `os`.
  const top = token.split('.')[0];
  if (!top || !VALID_NAME.test(top)) {
    return null;
  }
  if (isStandardLibrary(top)) {
    return null;
  }
  // Private/underscore-prefixed modules are C extensions or internals.
  if (top.startsWith('_')) {
    return null;
  }
  return toDistributionName(top);
}

/**
 * Split an `import` clause into its individual module paths.
 *
 * Handles `import a, b as c` and drops the alias, which is a local binding
 * and not part of any package name.
 */
function splitImportClause(clause: string): string[] {
  return clause
    .split(',')
    .map((part) => part.trim().split(/\s+as\s+/)[0] ?? '')
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Strip a trailing `# comment`, respecting quotes well enough for one line. */
function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (char === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (char === '#' && !inSingle && !inDouble) {
      return line.slice(0, index);
    }
  }
  return line;
}

/**
 * Count unclosed triple-quote delimiters on a line.
 *
 * Used to skip docstrings and example blocks, where an `import` line is
 * documentation rather than a dependency.
 */
function countTripleQuotes(line: string): number {
  const matches = line.match(/"""|'''/g);
  return matches ? matches.length : 0;
}

/**
 * Locate `token` on `line` and build a candidate positioned at it.
 *
 * The reported range covers the token *as written in the source*, not the
 * mapped distribution name, so the squiggle sits under `yaml` even though the
 * package checked is `PyYAML`.
 */
function locate(
  line: string,
  lineNumber: number,
  token: string,
  name: string,
  source: CandidateSource,
): PackageCandidate | null {
  const index = line.indexOf(token);
  if (index === -1) {
    return null;
  }
  return {
    name,
    line: lineNumber,
    startCharacter: index,
    endCharacter: index + token.length,
    source,
  };
}

/**
 * Extract candidates from Python source.
 *
 * @param text Full document text.
 * @returns One candidate per import occurrence, in document order.
 */
export function parsePythonImports(text: string): PackageCandidate[] {
  const candidates: PackageCandidate[] = [];
  const lines = text.split(/\r?\n/);
  let inDocstring = false;

  lines.forEach((rawLine, lineNumber) => {
    const quotesOnLine = countTripleQuotes(rawLine);

    // A line that both opens and closes a docstring (`"""doc"""`) is neutral,
    // so only an odd count actually flips the state.
    if (inDocstring) {
      if (quotesOnLine % 2 === 1) {
        inDocstring = false;
      }
      return;
    }

    const line = stripComment(rawLine);

    const fromMatch = FROM_IMPORT_RE.exec(line);
    if (fromMatch?.[1]) {
      const token = fromMatch[1];
      const name = normalizeCandidate(token);
      if (name) {
        const found = locate(rawLine, lineNumber, token, name, 'from-import');
        if (found) {
          candidates.push(found);
        }
      }
    } else {
      const importMatch = IMPORT_RE.exec(line);
      if (importMatch?.[1]) {
        for (const token of splitImportClause(importMatch[1])) {
          const name = normalizeCandidate(token);
          if (name) {
            const found = locate(rawLine, lineNumber, token, name, 'import');
            if (found) {
              candidates.push(found);
            }
          }
        }
      }
    }

    if (quotesOnLine % 2 === 1) {
      inDocstring = true;
    }
  });

  return candidates;
}

/**
 * Extract candidates from a `requirements.txt`-style file.
 *
 * Skips everything pip treats as an option or a non-registry source: `-r`,
 * `-e`, `--index-url`, VCS URLs, and local paths. A `git+https://…` dependency
 * never touches PyPI, so there is nothing for the backend to verify.
 */
export function parseRequirements(text: string): PackageCandidate[] {
  const candidates: PackageCandidate[] = [];

  text.split(/\r?\n/).forEach((rawLine, lineNumber) => {
    const line = stripComment(rawLine).trim();
    if (!line || line.startsWith('-')) {
      return;
    }
    // Not a registry lookup: a URL, a VCS ref, or a path on disk.
    if (/^[a-z+]+:\/\//i.test(line) || line.startsWith('.') || line.includes('/')) {
      return;
    }

    const match = REQUIREMENT_RE.exec(line);
    const token = match?.[1];
    if (!token) {
      return;
    }
    const name = normalizeCandidate(token);
    if (!name) {
      return;
    }
    const found = locate(rawLine, lineNumber, token, name, 'requirements');
    if (found) {
      candidates.push(found);
    }
  });

  return candidates;
}

/**
 * Extract candidates from `pip install` commands appearing anywhere in text.
 *
 * This is the one that catches an AI assistant's "run this to get started"
 * block — the shortest path there is between a suggestion and an install.
 */
export function parsePipInstallCommands(text: string): PackageCandidate[] {
  const candidates: PackageCandidate[] = [];

  text.split(/\r?\n/).forEach((rawLine, lineNumber) => {
    PIP_INSTALL_RE.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = PIP_INSTALL_RE.exec(rawLine)) !== null) {
      const argumentList = match[1];
      if (!argumentList) {
        continue;
      }
      for (const token of argumentList.split(/\s+/)) {
        // Flags, and the values that follow them, are not package names.
        if (!token || token.startsWith('-')) {
          continue;
        }
        if (/^[a-z+]+:\/\//i.test(token) || token.includes('/')) {
          continue;
        }
        const specifier = REQUIREMENT_RE.exec(token)?.[1];
        if (!specifier) {
          continue;
        }
        const name = normalizeCandidate(specifier);
        if (!name) {
          continue;
        }
        const found = locate(rawLine, lineNumber, specifier, name, 'pip-install');
        if (found) {
          candidates.push(found);
        }
      }
    }
  });

  return candidates;
}

/**
 * Extract candidates from a `pyproject.toml`.
 *
 * Covers both spellings in common use: the PEP 621 `dependencies = [...]`
 * array and Poetry's `[tool.poetry.dependencies]` table.
 */
export function parsePyproject(text: string): PackageCandidate[] {
  const candidates: PackageCandidate[] = [];
  const lines = text.split(/\r?\n/);

  let inDependencyArray = false;
  let inPoetryTable = false;

  lines.forEach((rawLine, lineNumber) => {
    const line = rawLine.trim();

    if (line.startsWith('[')) {
      inDependencyArray = false;
      inPoetryTable = /^\[tool\.poetry(\.group\.[^.\]]+)?\.dependencies\]/.test(line);
      return;
    }

    if (/^(?:dependencies|optional-dependencies)\s*=\s*\[/.test(line)) {
      inDependencyArray = true;
    }

    if (inDependencyArray) {
      if (line.includes(']')) {
        inDependencyArray = false;
      }
      // Every quoted entry in the array is a PEP 508 requirement string.
      for (const quoted of rawLine.matchAll(/["']([^"']+)["']/g)) {
        const entry = quoted[1];
        if (!entry) {
          continue;
        }
        const token = REQUIREMENT_RE.exec(entry.trim())?.[1];
        if (!token) {
          continue;
        }
        const name = normalizeCandidate(token);
        if (!name) {
          continue;
        }
        const found = locate(rawLine, lineNumber, token, name, 'pyproject');
        if (found) {
          candidates.push(found);
        }
      }
      return;
    }

    if (inPoetryTable) {
      const key = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/.exec(line)?.[1];
      if (!key || key.toLowerCase() === 'python') {
        return;
      }
      const name = normalizeCandidate(key);
      if (!name) {
        return;
      }
      const found = locate(rawLine, lineNumber, key, name, 'pyproject');
      if (found) {
        candidates.push(found);
      }
    }
  });

  return candidates;
}

/**
 * Run the right extractors for a document and return unique candidates.
 *
 * Duplicates are collapsed on name *and* position, so the same package
 * imported on two lines is still flagged on both — the developer needs the
 * squiggle where they are looking, not only on the first occurrence.
 */
export function extractCandidates(
  text: string,
  languageId: string,
  fileName = '',
): PackageCandidate[] {
  const candidates: PackageCandidate[] = [];
  const lowerName = fileName.toLowerCase();

  if (languageId === 'python') {
    candidates.push(...parsePythonImports(text));
  } else if (
    languageId === 'pip-requirements' ||
    /requirements[^/\\]*\.(txt|in)$/.test(lowerName)
  ) {
    candidates.push(...parseRequirements(text));
  } else if (languageId === 'toml' && lowerName.endsWith('pyproject.toml')) {
    candidates.push(...parsePyproject(text));
  }

  // `pip install` can appear in any of them — a comment in a .py file, a
  // README block, a note at the top of requirements.txt.
  candidates.push(...parsePipInstallCommands(text));

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.name}:${candidate.line}:${candidate.startCharacter}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** The distinct package names in a candidate list, preserving first-seen order. */
export function uniqueNames(candidates: readonly PackageCandidate[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const candidate of candidates) {
    const key = candidate.name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      names.push(candidate.name);
    }
  }
  return names;
}
