/**
 * Tests for the coordinator: ignore list, de-duplication, concurrency, and
 * cancellation.
 *
 * These are the behaviours that decide how much load the extension puts on the
 * backend — and, through it, on the GitHub rate limit. A regression here does
 * not break a feature, it quietly turns a working checker into one that
 * reports "unavailable" for every package after the first minute of typing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PackageChecker } from '../src/checker';
import { LocalCache } from '../src/client/localCache';
import type { BackendClient } from '../src/client/backendClient';
import type {
  BlueberrySettings,
  CheckOutcome,
  PackageCandidate,
  RiskReport,
} from '../src/types';

function settings(overrides: Partial<BlueberrySettings> = {}): BlueberrySettings {
  return {
    enabled: true,
    backendUrl: 'http://127.0.0.1:8000',
    dashboardUrl: 'http://127.0.0.1:5173',
    sensitivityThreshold: 20,
    enabledEcosystems: ['pypi'],
    ignoredPackages: [],
    debounceMs: 600,
    requestTimeoutMs: 8000,
    ...overrides,
  };
}

function candidate(name: string, line = 0): PackageCandidate {
  return {
    name,
    line,
    startCharacter: 7,
    endCharacter: 7 + name.length,
    source: 'import',
  };
}

function report(name: string, score = 0): RiskReport {
  return {
    package_name: name,
    normalized_name: name,
    ecosystem: 'pypi',
    exists_on_pypi: true,
    github_repo_health: null,
    similarity_score: null,
    matched_package: null,
    final_score: score,
    severity: score >= 60 ? 'high_risk' : score >= 20 ? 'caution' : 'safe',
    explanation: [],
    signals: [],
    checked_at: '2026-09-09T10:00:00Z',
    duration_ms: 1,
  };
}

/** A recording stub standing in for the HTTP client. */
class StubClient {
  readonly requested: string[] = [];
  inFlight = 0;
  peakInFlight = 0;

  constructor(private readonly delayMs = 0) {}

  async check(packageName: string, _ecosystem?: string): Promise<CheckOutcome> {
    this.requested.push(packageName);
    this.inFlight += 1;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    try {
      if (this.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      }
      return { kind: 'ok', report: report(packageName) };
    } finally {
      this.inFlight -= 1;
    }
  }
}

function checkerWith(stub: StubClient, maxConcurrent = 4): PackageChecker {
  return new PackageChecker(
    new LocalCache(),
    () => stub as unknown as BackendClient,
    maxConcurrent,
  );
}

describe('PackageChecker', () => {
  it('checks each candidate', async () => {
    const stub = new StubClient();
    const results = await checkerWith(stub).checkCandidates(
      [candidate('requests'), candidate('numpy', 1)],
      settings(),
    );

    assert.deepEqual(stub.requested.sort(), ['numpy', 'requests']);
    assert.equal(results.length, 2);
  });

  it('requests a repeated name once but reports it at every position', async () => {
    const stub = new StubClient();
    const results = await checkerWith(stub).checkCandidates(
      [candidate('requests', 0), candidate('requests', 5), candidate('requests', 9)],
      settings(),
    );

    assert.deepEqual(stub.requested, ['requests']);
    assert.equal(results.length, 3);
    assert.deepEqual(
      results.map((result) => result.candidate.line),
      [0, 5, 9],
    );
  });

  it('never requests an ignored package', async () => {
    const stub = new StubClient();
    const results = await checkerWith(stub).checkCandidates(
      [candidate('requests'), candidate('internal-tool', 1)],
      settings({ ignoredPackages: ['internal-tool'] }),
    );

    assert.deepEqual(stub.requested, ['requests']);
    assert.equal(results.length, 1);
  });

  it('matches the ignore list case-insensitively', async () => {
    const stub = new StubClient();
    await checkerWith(stub).checkCandidates(
      [candidate('Requests')],
      settings({ ignoredPackages: ['requests'] }),
    );

    assert.deepEqual(stub.requested, []);
  });

  it('does nothing when pypi is not an enabled ecosystem', async () => {
    const stub = new StubClient();
    const results = await checkerWith(stub).checkCandidates(
      [candidate('requests')],
      settings({ enabledEcosystems: [] }),
    );

    assert.deepEqual(stub.requested, []);
    assert.deepEqual(results, []);
  });

  it('caps how many checks are in flight at once', async () => {
    // A 60-import file must not open 60 sockets and burn the rate limit.
    const stub = new StubClient(10);
    const candidates = Array.from({ length: 12 }, (_, index) =>
      candidate(`pkg-${index}`, index),
    );

    await checkerWith(stub, 4).checkCandidates(candidates, settings());

    assert.equal(stub.requested.length, 12);
    assert.ok(
      stub.peakInFlight <= 4,
      `expected at most 4 concurrent requests, saw ${stub.peakInFlight}`,
    );
  });

  it('reuses a cached verdict across two scans', async () => {
    const stub = new StubClient();
    const checker = checkerWith(stub);

    await checker.checkCandidates([candidate('requests')], settings());
    await checker.checkCandidates([candidate('requests')], settings());

    assert.deepEqual(stub.requested, ['requests']);
  });

  it('returns nothing once the scan has been aborted', async () => {
    // The document changed underneath; these offsets are stale.
    const stub = new StubClient(20);
    const controller = new AbortController();

    const pending = checkerWith(stub).checkCandidates(
      [candidate('requests'), candidate('numpy', 1)],
      settings(),
      controller.signal,
    );
    controller.abort();

    assert.deepEqual(await pending, []);
  });

  it('returns nothing for an empty candidate list without calling the backend', async () => {
    const stub = new StubClient();
    assert.deepEqual(await checkerWith(stub).checkCandidates([], settings()), []);
    assert.deepEqual(stub.requested, []);
  });

  it('checks a single name directly', async () => {
    const stub = new StubClient();
    const outcome = await checkerWith(stub).checkOne('requests', settings());

    assert.equal(outcome.kind, 'ok');
    assert.deepEqual(stub.requested, ['requests']);
  });
});
