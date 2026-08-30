// Package detection: pure text parsing, no VS Code API dependency.
// Keeping this VS Code-free means it can be unit-tested with a plain Node
// test runner and reused later outside the extension host (e.g. dashboard).

export type Ecosystem = 'pypi';

export interface PackageDetection {
  name: string;
  version?: string;
  ecosystem: Ecosystem;
}

const FROM_IMPORT_LINE_RE = /^\s*from\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s+import\s+/;
const IMPORT_LINE_RE = /^\s*import\s+(.+)$/;
const IMPORT_TARGET_NAME_RE = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/;

function topLevelName(modulePath: string): string {
  return modulePath.split('.')[0];
}

/**
 * Extracts candidate package names from `import x` / `from x import y`
 * statements in a Python source buffer.
 */
export function extractImportedPackages(text: string): PackageDetection[] {
  const results: PackageDetection[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const fromMatch = line.match(FROM_IMPORT_LINE_RE);
    if (fromMatch) {
      results.push({ name: topLevelName(fromMatch[1]), ecosystem: 'pypi' });
      continue;
    }

    const importMatch = line.match(IMPORT_LINE_RE);
    if (!importMatch) {
      continue;
    }

    for (const rawTarget of importMatch[1].split(',')) {
      let target = rawTarget.split('#')[0].trim();
      target = target.replace(/\s+as\s+\w+\s*$/i, '').trim();
      if (!target) {
        continue;
      }
      const nameMatch = target.match(IMPORT_TARGET_NAME_RE);
      if (nameMatch) {
        results.push({ name: topLevelName(nameMatch[0]), ecosystem: 'pypi' });
      }
    }
  }

  return results;
}

const PIP_INSTALL_LINE_RE = /^\s*(?:python[3]?\s+-m\s+)?pip[3]?\s+install\s+(.+)$/;
const PACKAGE_SPEC_RE = /^([A-Za-z0-9][\w.\-]*)\s*(==|>=|<=|~=|!=|===|<|>)?\s*([\w.\*]+)?$/;
const REQUIREMENT_FILE_FLAGS = new Set(['-r', '--requirement']);

/**
 * Extracts candidate package names from `pip install ...` command strings
 * (including `pip3 install` / `python -m pip install`), ignoring flags and
 * `-r requirements.txt`-style file references.
 */
export function extractPipInstallPackages(text: string): PackageDetection[] {
  const results: PackageDetection[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
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
        const detection: PackageDetection = { name: specMatch[1], ecosystem: 'pypi' };
        if (specMatch[3]) {
          detection.version = specMatch[3];
        }
        results.push(detection);
      }
      i += 1;
    }
  }

  return results;
}

/**
 * Runs both extractors over a buffer and merges the results into one
 * normalized, deduplicated list (case-insensitive on package name).
 */
export function detectPackages(text: string): PackageDetection[] {
  const all = [...extractImportedPackages(text), ...extractPipInstallPackages(text)];
  const byName = new Map<string, PackageDetection>();

  for (const detection of all) {
    const key = detection.name.toLowerCase();
    const existing = byName.get(key);
    if (!existing || (!existing.version && detection.version)) {
      byName.set(key, detection);
    }
  }

  return [...byName.values()];
}
