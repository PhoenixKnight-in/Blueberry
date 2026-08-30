import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { detectPackages, extractImportedPackages, extractPipInstallPackages } from './detect';

test('plain import', () => {
  const result = extractImportedPackages('import requests');
  assert.deepEqual(result, [{ name: 'requests', ecosystem: 'pypi' }]);
});

test('from x import y', () => {
  const result = extractImportedPackages('from flask import Flask');
  assert.deepEqual(result, [{ name: 'flask', ecosystem: 'pypi' }]);
});

test('aliased import', () => {
  const result = extractImportedPackages('import numpy as np');
  assert.deepEqual(result, [{ name: 'numpy', ecosystem: 'pypi' }]);
});

test('aliased from-import ignores the member alias', () => {
  const result = extractImportedPackages('from sklearn import svm as s');
  assert.deepEqual(result, [{ name: 'sklearn', ecosystem: 'pypi' }]);
});

test('submodule import collapses to top-level package', () => {
  const result = extractImportedPackages('import os.path as p');
  assert.deepEqual(result, [{ name: 'os', ecosystem: 'pypi' }]);
});

test('multiple packages per import line', () => {
  const result = extractImportedPackages('import os, sys as system, json');
  assert.deepEqual(result, [
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

test('pip install without version pin', () => {
  const result = extractPipInstallPackages('pip install requests');
  assert.deepEqual(result, [{ name: 'requests', ecosystem: 'pypi' }]);
});

test('pip install with version pin', () => {
  const result = extractPipInstallPackages('pip install requests==2.31.0');
  assert.deepEqual(result, [{ name: 'requests', version: '2.31.0', ecosystem: 'pypi' }]);
});

test('pip install with multiple packages, mixed pins', () => {
  const result = extractPipInstallPackages('pip install requests flask==2.0 numpy');
  assert.deepEqual(result, [
    { name: 'requests', ecosystem: 'pypi' },
    { name: 'flask', version: '2.0', ecosystem: 'pypi' },
    { name: 'numpy', ecosystem: 'pypi' },
  ]);
});

test('pip install -r requirements.txt is not treated as a package', () => {
  assert.deepEqual(extractPipInstallPackages('pip install -r requirements.txt'), []);
});

test('pip install -r requirements.txt alongside a real package', () => {
  const result = extractPipInstallPackages('pip install flask -r requirements.txt');
  assert.deepEqual(result, [{ name: 'flask', ecosystem: 'pypi' }]);
});

test('pip3 install and python -m pip install are recognized', () => {
  assert.deepEqual(extractPipInstallPackages('pip3 install flask'), [
    { name: 'flask', ecosystem: 'pypi' },
  ]);
  assert.deepEqual(extractPipInstallPackages('python -m pip install flask'), [
    { name: 'flask', ecosystem: 'pypi' },
  ]);
});

test('non pip-install lines are not matched', () => {
  assert.deepEqual(extractPipInstallPackages('pip freeze > requirements.txt'), []);
  assert.deepEqual(extractPipInstallPackages('This is not a command.'), []);
});

test('detectPackages merges imports and pip installs, deduping by name', () => {
  const text = ['import requests', 'pip install requests==2.31.0'].join('\n');
  const result = detectPackages(text);
  assert.deepEqual(result, [{ name: 'requests', version: '2.31.0', ecosystem: 'pypi' }]);
});
