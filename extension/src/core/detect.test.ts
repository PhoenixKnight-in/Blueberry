import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  detectOccurrences,
  detectPackages,
  extractImportedPackages,
  extractPipInstallPackages,
  PackageDetection,
  PackageOccurrence,
} from './detect';

/** Strips position fields so shape assertions don't need to restate them. */
function names(occurrences: PackageOccurrence[]): PackageDetection[] {
  return occurrences.map(({ name, version, ecosystem }) =>
    version ? { name, version, ecosystem } : { name, ecosystem }
  );
}

test('plain import', () => {
  assert.deepEqual(names(extractImportedPackages('import requests')), [
    { name: 'requests', ecosystem: 'pypi' },
  ]);
});

test('from x import y', () => {
  assert.deepEqual(names(extractImportedPackages('from flask import Flask')), [
    { name: 'flask', ecosystem: 'pypi' },
  ]);
});

test('aliased import', () => {
  assert.deepEqual(names(extractImportedPackages('import numpy as np')), [
    { name: 'numpy', ecosystem: 'pypi' },
  ]);
});

test('aliased from-import ignores the member alias', () => {
  assert.deepEqual(names(extractImportedPackages('from sklearn import svm as s')), [
    { name: 'sklearn', ecosystem: 'pypi' },
  ]);
});

test('submodule import collapses to top-level package', () => {
  assert.deepEqual(names(extractImportedPackages('import os.path as p')), [
    { name: 'os', ecosystem: 'pypi' },
  ]);
});

test('multiple packages per import line', () => {
  assert.deepEqual(names(extractImportedPackages('import os, sys as system, json')), [
    { name: 'os', ecosystem: 'pypi' },
    { name: 'sys', ecosystem: 'pypi' },
    { name: 'json', ecosystem: 'pypi' },
  ]);
});

test('relative imports are not treated as packages', () => {
  assert.deepEqual(extractImportedPackages('from . import utils'), []);
  assert.deepEqual(extractImportedPackages('from .models import User'), []);
});

test('full-line comments are ignored', () => {
  assert.deepEqual(extractImportedPackages('# import requests'), []);
});

test('unrelated text is not mistaken for an import', () => {
  assert.deepEqual(extractImportedPackages('important_variable = 5'), []);
  assert.deepEqual(extractImportedPackages('This is not code.'), []);
});

test('import occurrence positions point at the package name', () => {
  const result = extractImportedPackages('    import numpy as np');
  assert.deepEqual(result, [
    { name: 'numpy', ecosystem: 'pypi', line: 0, startCol: 11, endCol: 16 },
  ]);
});

test('multi-target import positions advance across the line', () => {
  const result = extractImportedPackages('import os, sys');
  assert.deepEqual(result, [
    { name: 'os', ecosystem: 'pypi', line: 0, startCol: 7, endCol: 9 },
    { name: 'sys', ecosystem: 'pypi', line: 0, startCol: 11, endCol: 14 },
  ]);
});

test('pip install without version pin', () => {
  assert.deepEqual(names(extractPipInstallPackages('pip install requests')), [
    { name: 'requests', ecosystem: 'pypi' },
  ]);
});

test('pip install with version pin', () => {
  assert.deepEqual(names(extractPipInstallPackages('pip install requests==2.31.0')), [
    { name: 'requests', version: '2.31.0', ecosystem: 'pypi' },
  ]);
});

test('pip install with multiple packages, mixed pins', () => {
  assert.deepEqual(names(extractPipInstallPackages('pip install requests flask==2.0 numpy')), [
    { name: 'requests', ecosystem: 'pypi' },
    { name: 'flask', version: '2.0', ecosystem: 'pypi' },
    { name: 'numpy', ecosystem: 'pypi' },
  ]);
});

test('pip install -r requirements.txt is not treated as a package', () => {
  assert.deepEqual(extractPipInstallPackages('pip install -r requirements.txt'), []);
});

test('pip install -r requirements.txt alongside a real package', () => {
  assert.deepEqual(names(extractPipInstallPackages('pip install flask -r requirements.txt')), [
    { name: 'flask', ecosystem: 'pypi' },
  ]);
});

test('pip3 install and python -m pip install are recognized', () => {
  assert.deepEqual(names(extractPipInstallPackages('pip3 install flask')), [
    { name: 'flask', ecosystem: 'pypi' },
  ]);
  assert.deepEqual(names(extractPipInstallPackages('python -m pip install flask')), [
    { name: 'flask', ecosystem: 'pypi' },
  ]);
});

test('non pip-install lines are not matched', () => {
  assert.deepEqual(extractPipInstallPackages('pip freeze > requirements.txt'), []);
  assert.deepEqual(extractPipInstallPackages('This is not a command.'), []);
});

test('pip install occurrence positions point at the package name', () => {
  const result = extractPipInstallPackages('pip install requests==2.31.0');
  assert.deepEqual(result, [
    { name: 'requests', version: '2.31.0', ecosystem: 'pypi', line: 0, startCol: 12, endCol: 20 },
  ]);
});

test('detectOccurrences concatenates both extractors without deduping', () => {
  const text = ['import requests', 'pip install requests==2.31.0'].join('\n');
  assert.deepEqual(names(detectOccurrences(text)), [
    { name: 'requests', ecosystem: 'pypi' },
    { name: 'requests', version: '2.31.0', ecosystem: 'pypi' },
  ]);
});

test('detectPackages merges imports and pip installs, deduping by name', () => {
  const text = ['import requests', 'pip install requests==2.31.0'].join('\n');
  const result = detectPackages(text);
  assert.deepEqual(result, [{ name: 'requests', version: '2.31.0', ecosystem: 'pypi' }]);
});
