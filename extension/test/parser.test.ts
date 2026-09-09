/**
 * Tests for the candidate extractors.
 *
 * This is the layer with the highest false-positive cost in the whole system:
 * a parser that reports `os` as a package turns every Python file into a wall
 * of warnings, and a developer who sees that once switches the extension off.
 * So most of what is asserted here is what must *not* be reported.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  extractCandidates,
  normalizeCandidate,
  parsePipInstallCommands,
  parsePyproject,
  parsePythonImports,
  parseRequirements,
  uniqueNames,
} from '../src/parser/packageParser';

/** The package names found in a Python source string. */
function names(source: string): string[] {
  return parsePythonImports(source).map((candidate) => candidate.name);
}

describe('normalizeCandidate', () => {
  it('passes an ordinary name through', () => {
    assert.equal(normalizeCandidate('requests'), 'requests');
  });

  it('keeps only the top-level package of a dotted path', () => {
    assert.equal(normalizeCandidate('numpy.linalg'), 'numpy');
  });

  it('maps an import name to its PyPI distribution', () => {
    assert.equal(normalizeCandidate('yaml'), 'PyYAML');
    assert.equal(normalizeCandidate('cv2'), 'opencv-python');
    assert.equal(normalizeCandidate('sklearn'), 'scikit-learn');
  });

  it('rejects standard-library modules', () => {
    for (const module of ['os', 'sys', 'json', 'asyncio', 'typing', 'pathlib']) {
      assert.equal(normalizeCandidate(module), null, module);
    }
  });

  it('rejects a module removed from the stdlib in a later version', () => {
    // Still not a package a developer can be typosquatted into installing.
    assert.equal(normalizeCandidate('distutils'), null);
  });

  it('rejects relative imports', () => {
    assert.equal(normalizeCandidate('.models'), null);
    assert.equal(normalizeCandidate('..shared'), null);
  });

  it('rejects private and dunder modules', () => {
    assert.equal(normalizeCandidate('_ctypes'), null);
    assert.equal(normalizeCandidate('__future__'), null);
  });

  it('rejects anything that is not a valid package name', () => {
    assert.equal(normalizeCandidate(''), null);
    assert.equal(normalizeCandidate('   '), null);
    assert.equal(normalizeCandidate('has space'), null);
    assert.equal(normalizeCandidate('-leading'), null);
  });
});

describe('parsePythonImports', () => {
  it('finds a plain import', () => {
    assert.deepEqual(names('import requests'), ['requests']);
  });

  it('finds a from-import', () => {
    assert.deepEqual(names('from requests import get'), ['requests']);
  });

  it('splits a multi-name import', () => {
    assert.deepEqual(names('import requests, numpy, pandas'), [
      'requests',
      'numpy',
      'pandas',
    ]);
  });

  it('drops the alias', () => {
    assert.deepEqual(names('import numpy as np'), ['numpy']);
    assert.deepEqual(names('import pandas as pd, numpy as np'), ['pandas', 'numpy']);
  });

  it('reduces a dotted from-import to its top-level package', () => {
    assert.deepEqual(names('from sqlalchemy.orm import Session'), ['sqlalchemy']);
  });

  it('ignores stdlib imports mixed in with real ones', () => {
    const source = ['import os', 'import sys', 'import requests'].join('\n');
    assert.deepEqual(names(source), ['requests']);
  });

  it('ignores relative imports', () => {
    const source = ['from . import models', 'from .db import session'].join('\n');
    assert.deepEqual(names(source), []);
  });

  it('ignores an import inside a docstring', () => {
    const source = [
      '"""Example usage:',
      '',
      '    import totally-not-real',
      '"""',
      'import requests',
    ].join('\n');

    assert.deepEqual(names(source), ['requests']);
  });

  it('handles a single-line docstring without swallowing the rest of the file', () => {
    const source = ['"""One-liner."""', 'import requests'].join('\n');
    assert.deepEqual(names(source), ['requests']);
  });

  it('ignores an import in a trailing comment', () => {
    assert.deepEqual(names('x = 1  # import fakepkg'), []);
  });

  it('does not treat a hash inside a string as a comment', () => {
    // The import is real; the `#` belongs to the string on the line above.
    const source = ['colour = "#ffffff"', 'import requests'].join('\n');
    assert.deepEqual(names(source), ['requests']);
  });

  it('reports the position of the name as written, not the mapped name', () => {
    const [candidate] = parsePythonImports('import yaml');

    assert.ok(candidate);
    assert.equal(candidate.name, 'PyYAML');
    assert.equal(candidate.line, 0);
    // The squiggle belongs under `yaml`, which starts at column 7.
    assert.equal(candidate.startCharacter, 7);
    assert.equal(candidate.endCharacter, 11);
  });

  it('reports every occurrence, on every line', () => {
    const source = ['import requests', 'import numpy', 'from requests import get'].join(
      '\n',
    );
    const candidates = parsePythonImports(source);

    assert.equal(candidates.length, 3);
    assert.deepEqual(
      candidates.map((candidate) => candidate.line),
      [0, 1, 2],
    );
  });

  it('handles indented imports inside a function', () => {
    const source = ['def load():', '    import requests', '    return requests'].join(
      '\n',
    );
    assert.deepEqual(names(source), ['requests']);
  });
});

describe('parseRequirements', () => {
  const parse = (text: string) =>
    parseRequirements(text).map((candidate) => candidate.name);

  it('reads a pinned requirement', () => {
    assert.deepEqual(parse('requests==2.31.0'), ['requests']);
  });

  it('reads a bare name', () => {
    assert.deepEqual(parse('requests'), ['requests']);
  });

  it('strips extras and version ranges', () => {
    assert.deepEqual(parse('requests[security]>=2.0,<3'), ['requests']);
  });

  it('strips an environment marker', () => {
    assert.deepEqual(parse('requests; python_version >= "3.8"'), ['requests']);
  });

  it('skips comments and blank lines', () => {
    const text = ['# core deps', '', 'requests==2.31.0', '   ', '# end'].join('\n');
    assert.deepEqual(parse(text), ['requests']);
  });

  it('skips pip options', () => {
    const text = [
      '-r base.txt',
      '-e .',
      '--index-url https://example.invalid/simple',
      'requests',
    ].join('\n');
    assert.deepEqual(parse(text), ['requests']);
  });

  it('skips VCS and path requirements, which never hit PyPI', () => {
    const text = [
      'git+https://github.com/psf/requests.git#egg=requests',
      './vendor/local-package',
      'requests',
    ].join('\n');
    assert.deepEqual(parse(text), ['requests']);
  });
});

describe('parsePipInstallCommands', () => {
  const parse = (text: string) =>
    parsePipInstallCommands(text).map((candidate) => candidate.name);

  it('reads a plain install command', () => {
    assert.deepEqual(parse('pip install requests'), ['requests']);
  });

  it('reads several packages at once', () => {
    assert.deepEqual(parse('pip install requests numpy pandas'), [
      'requests',
      'numpy',
      'pandas',
    ]);
  });

  it('handles pip3, python -m pip, and uv', () => {
    assert.deepEqual(parse('pip3 install requests'), ['requests']);
    assert.deepEqual(parse('python -m pip install requests'), ['requests']);
    assert.deepEqual(parse('uv pip install requests'), ['requests']);
  });

  it('skips flags', () => {
    assert.deepEqual(parse('pip install -U --no-cache-dir requests'), ['requests']);
  });

  it('strips version pins', () => {
    assert.deepEqual(parse('pip install requests==2.31.0'), ['requests']);
  });

  it('finds a command inside a Python comment', () => {
    // The case that matters: an assistant's "run this first" line.
    assert.deepEqual(parse('# pip install reqeusts'), ['reqeusts']);
  });

  it('finds a command inside a Markdown code fence', () => {
    assert.deepEqual(parse('`pip install requests`'), ['requests']);
  });

  it('ignores an install from a URL or a path', () => {
    assert.deepEqual(parse('pip install https://example.invalid/pkg.whl'), []);
    assert.deepEqual(parse('pip install ./dist/pkg.whl'), []);
  });
});

describe('parsePyproject', () => {
  const parse = (text: string) => parsePyproject(text).map((c) => c.name);

  it('reads a PEP 621 dependency array', () => {
    const text = [
      '[project]',
      'name = "demo"',
      'dependencies = [',
      '  "requests>=2.31",',
      '  "numpy",',
      ']',
    ].join('\n');

    assert.deepEqual(parse(text), ['requests', 'numpy']);
  });

  it('reads a Poetry dependency table', () => {
    const text = [
      '[tool.poetry.dependencies]',
      'python = "^3.11"',
      'requests = "^2.31"',
      'numpy = "*"',
    ].join('\n');

    // `python` is the interpreter constraint, not a package.
    assert.deepEqual(parse(text), ['requests', 'numpy']);
  });

  it('stops reading at the next table', () => {
    const text = [
      '[tool.poetry.dependencies]',
      'requests = "^2.31"',
      '',
      '[tool.black]',
      'line-length = 88',
    ].join('\n');

    assert.deepEqual(parse(text), ['requests']);
  });
});

describe('extractCandidates', () => {
  it('routes a Python document to the import parser', () => {
    const found = extractCandidates('import requests', 'python', 'main.py');
    assert.deepEqual(
      found.map((candidate) => candidate.name),
      ['requests'],
    );
    assert.equal(found[0]?.source, 'import');
  });

  it('routes a requirements file by name even without the language id', () => {
    const found = extractCandidates('requests==2.31.0', 'plaintext', 'requirements.txt');
    assert.deepEqual(
      found.map((candidate) => candidate.name),
      ['requests'],
    );
  });

  it('finds a pip install line in a Python file too', () => {
    const source = ['# pip install reqeusts', 'import requests'].join('\n');
    const found = extractCandidates(source, 'python', 'main.py');

    assert.deepEqual(new Set(found.map((c) => c.name)), new Set(['reqeusts', 'requests']));
  });

  it('does not report the same name twice at the same position', () => {
    // `pip install` scanning runs over every document, so a requirements line
    // must not be counted by two extractors at once.
    const found = extractCandidates(
      'pip install requests',
      'pip-requirements',
      'requirements.txt',
    );
    assert.equal(found.length, 1);
  });

  it('returns nothing for an unrelated language', () => {
    assert.deepEqual(extractCandidates('import requests', 'javascript', 'a.js'), []);
  });
});

describe('uniqueNames', () => {
  it('collapses repeats but keeps first-seen order', () => {
    const candidates = parsePythonImports(
      ['import requests', 'import numpy', 'from requests import get'].join('\n'),
    );

    assert.deepEqual(uniqueNames(candidates), ['requests', 'numpy']);
  });
});
