// Package detection: pure text parsing, no VS Code API dependency.
// Keeping this VS Code-free means it can be unit-tested with a plain Node
// test runner and reused later outside the extension host (e.g. dashboard).

export type Ecosystem = 'pypi';

export interface PackageDetection {
  name: string;
  version?: string;
  ecosystem: Ecosystem;
}

/** A single detected occurrence, with its location in the source buffer. */
export interface PackageOccurrence extends PackageDetection {
  line: number; // 0-based line index
  startCol: number; // 0-based character offset where the name starts
  endCol: number; // 0-based character offset where the name ends (exclusive)
}

const FROM_IMPORT_LINE_RE = /^\s*from\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s+import\s+/;
const IMPORT_LINE_RE = /^\s*import\s+(.+)$/;
const IMPORT_TARGET_NAME_RE = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/;

function topLevelName(modulePath: string): string {
  return modulePath.split('.')[0];
}

/**
 * Extracts candidate package occurrences from `import x` / `from x import y`
 * statements in a Python source buffer, with their position in the buffer.
 */
export function extractImportedPackages(text: string): PackageOccurrence[] {
  const results: PackageOccurrence[] = [];
  const lines = text.split(/\r?\n/);

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const rawLine = lines[lineNo];
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const fromMatch = line.match(FROM_IMPORT_LINE_RE);
    if (fromMatch) {
      const name = topLevelName(fromMatch[1]);
      const startCol = rawLine.indexOf(name);
      if (startCol !== -1) {
        results.push({ name, ecosystem: 'pypi', line: lineNo, startCol, endCol: startCol + name.length });
      }
      continue;
    }

    const importMatch = line.match(IMPORT_LINE_RE);
    if (!importMatch) {
      continue;
    }

    let searchFrom = 0;
    for (const rawTarget of importMatch[1].split(',')) {
      let target = rawTarget.split('#')[0].trim();
      target = target.replace(/\s+as\s+\w+\s*$/i, '').trim();
      if (!target) {
        continue;
      }
      const nameMatch = target.match(IMPORT_TARGET_NAME_RE);
      if (!nameMatch) {
        continue;
      }
      const name = topLevelName(nameMatch[0]);
      const idx = rawLine.indexOf(name, searchFrom);
      if (idx === -1) {
        continue;
      }
      results.push({ name, ecosystem: 'pypi', line: lineNo, startCol: idx, endCol: idx + name.length });
      searchFrom = idx + name.length;
    }
  }

  return results;
}

const PIP_INSTALL_LINE_RE = /^\s*(?:python[3]?\s+-m\s+)?pip[3]?\s+install\s+(.+)$/;
const PACKAGE_SPEC_RE = /^([A-Za-z0-9][\w.\-]*)\s*(==|>=|<=|~=|!=|===|<|>)?\s*([\w.\*]+)?$/;
const REQUIREMENT_FILE_FLAGS = new Set(['-r', '--requirement']);

/**
 * Extracts candidate package occurrences from `pip install ...` command
 * strings (including `pip3 install` / `python -m pip install`), ignoring
 * flags and `-r requirements.txt`-style file references.
 */
export function extractPipInstallPackages(text: string): PackageOccurrence[] {
  const results: PackageOccurrence[] = [];
  const lines = text.split(/\r?\n/);

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const rawLine = lines[lineNo];
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const pipMatch = line.match(PIP_INSTALL_LINE_RE);
    if (!pipMatch) {
      continue;
    }

    const tokens = pipMatch[1].split(/\s+/).filter(Boolean);
    let i = 0;
    let searchFrom = 0;
    while (i < tokens.length) {
      const token = tokens[i];

      if (REQUIREMENT_FILE_FLAGS.has(token)) {
        i += 2; // skip the flag and the filename that follows it
        continue;
      }
      if (token.startsWith('-')) {
        i += 1; // skip other flags (-U, --upgrade, --no-cache-dir, ...)
        continue;
      }

      const specMatch = token.match(PACKAGE_SPEC_RE);
      if (specMatch) {
        const name = specMatch[1];
        const idx = rawLine.indexOf(name, searchFrom);
        if (idx !== -1) {
          const occurrence: PackageOccurrence = {
            name,
            ecosystem: 'pypi',
            line: lineNo,
            startCol: idx,
            endCol: idx + name.length,
          };
          if (specMatch[3]) {
            occurrence.version = specMatch[3];
          }
          results.push(occurrence);
          searchFrom = idx + name.length;
        }
      }
      i += 1;
    }
  }

  return results;
}

/** Runs both extractors over a buffer and returns every raw occurrence found. */
export function detectOccurrences(text: string): PackageOccurrence[] {
  return [...extractImportedPackages(text), ...extractPipInstallPackages(text)];
}

/**
 * Runs both extractors over a buffer and merges the results into one
 * normalized, deduplicated list (case-insensitive on package name).
 * Use this when you need "what packages does this buffer reference"
 * without caring where each one appears (e.g. to call the backend).
 */
export function detectPackages(text: string): PackageDetection[] {
  const byName = new Map<string, PackageDetection>();

  for (const occurrence of detectOccurrences(text)) {
    const key = occurrence.name.toLowerCase();
    const detection: PackageDetection = { name: occurrence.name, ecosystem: occurrence.ecosystem };
    if (occurrence.version) {
      detection.version = occurrence.version;
    }
    const existing = byName.get(key);
    if (!existing || (!existing.version && detection.version)) {
      byName.set(key, detection);
    }
  }

  return [...byName.values()];
}
