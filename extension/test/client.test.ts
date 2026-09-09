/**
 * Tests for the backend client, the local cache, and the debouncer.
 *
 * The single most important assertion in this file is that **no failure path
 * ever produces a report**. A timeout, a 502, a garbled body, a dead socket —
 * each must come back as `unavailable`, because an extension that renders
 * silence after a failed check is telling the developer the package is fine.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BackendClient } from '../src/client/backendClient';
import { LocalCache } from '../src/client/localCache';
import type { CheckOutcome, RiskReport } from '../src/types';
import { KeyedDebouncer } from '../src/util/debounce';

/** A minimal but structurally valid risk report. */
function report(overrides: Partial<RiskReport> = {}): RiskReport {
  return {
    package_name: 'requests',
    normalized_name: 'requests',
    ecosystem: 'pypi',
    exists_on_pypi: true,
    github_repo_health: 0.95,
    similarity_score: null,
    matched_package: null,
    final_score: 0,
    severity: 'safe',
    explanation: [],
    signals: [],
    checked_at: '2026-09-09T10:00:00Z',
    duration_ms: 37,
    ...overrides,
  };
}

/** A `fetch` stub returning one canned response. */
function stubFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
}

function client(fetchImpl: typeof fetch, timeoutMs = 1000): BackendClient {
  return new BackendClient({
    baseUrl: 'http://127.0.0.1:8000',
    timeoutMs,
    fetchImpl,
  });
}

describe('BackendClient', () => {
  it('returns the report on a 200', async () => {
    const outcome = await client(stubFetch(200, report())).check('requests');

    assert.equal(outcome.kind, 'ok');
    assert.equal(outcome.kind === 'ok' && outcome.report.package_name, 'requests');
  });

  it('posts the package name and ecosystem', async () => {
    let captured: { url: string; body: unknown } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      captured = { url, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify(report()), { status: 200 });
    }) as unknown as typeof fetch;

    await client(fetchImpl).check('requests');

    assert.equal(captured?.url, 'http://127.0.0.1:8000/check');
    assert.deepEqual(captured?.body, { package_name: 'requests', ecosystem: 'pypi' });
  });

  it('does not produce a double slash when the base URL has a trailing one', async () => {
    let capturedUrl = '';
    const fetchImpl = (async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify(report()), { status: 200 });
    }) as unknown as typeof fetch;

    await new BackendClient({
      baseUrl: 'http://127.0.0.1:8000/',
      timeoutMs: 1000,
      fetchImpl,
    }).check('requests');

    assert.equal(capturedUrl, 'http://127.0.0.1:8000/check');
  });

  it('maps a 422 to invalid, carrying the backend detail', async () => {
    const outcome = await client(
      stubFetch(422, { detail: "'bad name' is not a valid package name" }),
    ).check('bad name');

    assert.equal(outcome.kind, 'invalid');
    assert.match(outcome.kind === 'invalid' ? outcome.reason : '', /not a valid/);
  });

  it('maps a 400 to invalid', async () => {
    const outcome = await client(
      stubFetch(400, { detail: "ecosystem 'npm' is not supported yet" }),
    ).check('express', 'npm');

    assert.equal(outcome.kind, 'invalid');
  });

  it('reads FastAPI validation errors, which nest the message', async () => {
    const outcome = await client(
      stubFetch(422, { detail: [{ msg: 'string too short', loc: ['body'] }] }),
    ).check('');

    assert.equal(outcome.kind, 'invalid');
    assert.match(outcome.kind === 'invalid' ? outcome.reason : '', /string too short/);
  });

  it('maps a 502 to unavailable, never to a verdict', async () => {
    const outcome = await client(
      stubFetch(502, { detail: 'PyPI could not be reached' }),
    ).check('requests');

    assert.equal(outcome.kind, 'unavailable');
  });

  it('maps a 500 to unavailable', async () => {
    const outcome = await client(stubFetch(500, {})).check('requests');
    assert.equal(outcome.kind, 'unavailable');
  });

  it('treats a 200 with an unrecognisable body as unavailable', async () => {
    // A proxy or a captive portal answering 200 with HTML must not read as
    // "checked and fine".
    const outcome = await client(stubFetch(200, { hello: 'world' })).check('requests');

    assert.equal(outcome.kind, 'unavailable');
  });

  it('treats a network failure as unavailable and names the backend', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const outcome = await client(fetchImpl).check('requests');

    assert.equal(outcome.kind, 'unavailable');
    assert.match(outcome.kind === 'unavailable' ? outcome.reason : '', /127\.0\.0\.1:8000/);
  });

  it('times out rather than hanging the editor', async () => {
    const fetchImpl = (async (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      })) as unknown as typeof fetch;

    const outcome = await client(fetchImpl, 20).check('requests');

    assert.equal(outcome.kind, 'unavailable');
    assert.match(outcome.kind === 'unavailable' ? outcome.reason : '', /timed out/);
  });

  it('reports a caller-cancelled check as cancelled, not as a timeout', async () => {
    const controller = new AbortController();
    const fetchImpl = (async (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      })) as unknown as typeof fetch;

    const pending = client(fetchImpl, 5000).check('requests', 'pypi', controller.signal);
    controller.abort();
    const outcome = await pending;

    assert.equal(outcome.kind, 'unavailable');
    assert.match(outcome.kind === 'unavailable' ? outcome.reason : '', /cancelled/);
  });

  it('reports health from the liveness probe', async () => {
    assert.equal(await client(stubFetch(200, { status: 'ok' })).isHealthy(), true);
    assert.equal(await client(stubFetch(503, {})).isHealthy(), false);
  });
});

describe('LocalCache', () => {
  const ok: CheckOutcome = { kind: 'ok', report: report() };
  const down: CheckOutcome = { kind: 'unavailable', reason: 'backend is down' };

  it('returns what was stored', () => {
    const cache = new LocalCache();
    cache.set('requests', ok);

    assert.deepEqual(cache.get('requests'), ok);
  });

  it('is case-insensitive, like PyPI itself', () => {
    const cache = new LocalCache();
    cache.set('Requests', ok);

    assert.deepEqual(cache.get('requests'), ok);
  });

  it('misses on an unknown name', () => {
    assert.equal(new LocalCache().get('nothing-here'), undefined);
  });

  it('expires a successful entry after its TTL', () => {
    let now = 1_000;
    const cache = new LocalCache(100, 10, 500, () => now);
    cache.set('requests', ok);

    now = 1_099;
    assert.deepEqual(cache.get('requests'), ok);

    now = 1_101;
    assert.equal(cache.get('requests'), undefined);
  });

  it('expires a failure far sooner than a success', () => {
    // A backend that came back up must be retried in seconds, not minutes.
    let now = 1_000;
    const cache = new LocalCache(100, 10, 500, () => now);
    cache.set('requests', ok);
    cache.set('numpy', down);

    now = 1_050;
    assert.deepEqual(cache.get('requests'), ok);
    assert.equal(cache.get('numpy'), undefined);
  });

  it('evicts the oldest entry past the size limit', () => {
    const cache = new LocalCache(10_000, 10_000, 2);
    cache.set('a', ok);
    cache.set('b', ok);
    cache.set('c', ok);

    assert.equal(cache.get('a'), undefined);
    assert.deepEqual(cache.get('c'), ok);
    assert.equal(cache.size, 2);
  });

  it('shares one request between concurrent callers', async () => {
    const cache = new LocalCache();
    let calls = 0;
    const factory = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return ok;
    };

    const results = await Promise.all([
      cache.resolve('requests', factory),
      cache.resolve('requests', factory),
      cache.resolve('requests', factory),
    ]);

    assert.equal(calls, 1);
    assert.deepEqual(results, [ok, ok, ok]);
  });

  it('does not call the factory when the answer is cached', async () => {
    const cache = new LocalCache();
    cache.set('requests', ok);

    let calls = 0;
    await cache.resolve('requests', async () => {
      calls += 1;
      return ok;
    });

    assert.equal(calls, 0);
  });

  it('lets the next caller retry after an in-flight request finishes', async () => {
    const cache = new LocalCache(10_000, 0, 500);
    let calls = 0;
    const factory = async () => {
      calls += 1;
      return down;
    };

    await cache.resolve('requests', factory);
    await cache.resolve('requests', factory);

    // The failure TTL is zero here, so the second call is a real retry.
    assert.equal(calls, 2);
  });

  it('clears everything', () => {
    const cache = new LocalCache();
    cache.set('requests', ok);
    cache.clear();

    assert.equal(cache.size, 0);
    assert.equal(cache.get('requests'), undefined);
  });
});

describe('KeyedDebouncer', () => {
  const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('runs once after the delay', async () => {
    const debouncer = new KeyedDebouncer(10);
    let runs = 0;
    debouncer.schedule('doc', () => {
      runs += 1;
    });

    assert.equal(runs, 0);
    await tick(30);
    assert.equal(runs, 1);
  });

  it('collapses a burst of edits into one run', async () => {
    const debouncer = new KeyedDebouncer(20);
    let runs = 0;
    for (let index = 0; index < 5; index += 1) {
      debouncer.schedule('doc', () => {
        runs += 1;
      });
      await tick(3);
    }

    await tick(50);
    assert.equal(runs, 1);
  });

  it('keeps separate documents independent', async () => {
    const debouncer = new KeyedDebouncer(10);
    const ran: string[] = [];
    debouncer.schedule('a', () => {
      ran.push('a');
    });
    debouncer.schedule('b', () => {
      ran.push('b');
    });

    await tick(40);
    assert.deepEqual(ran.sort(), ['a', 'b']);
  });

  it('aborts a run that is already in flight when superseded', async () => {
    // The case that produces stale squiggles: the first scan is waiting on the
    // network when a new edit lands.
    const debouncer = new KeyedDebouncer(5);
    let firstWasAborted = false;

    debouncer.schedule('doc', async (signal) => {
      await tick(40);
      firstWasAborted = signal.aborted;
    });

    await tick(15); // The first run has started and is awaiting.
    debouncer.schedule('doc', () => {});

    await tick(60);
    assert.equal(firstWasAborted, true);
  });

  it('cancels a pending run outright', async () => {
    const debouncer = new KeyedDebouncer(20);
    let runs = 0;
    debouncer.schedule('doc', () => {
      runs += 1;
    });
    debouncer.cancel('doc');

    await tick(40);
    assert.equal(runs, 0);
    assert.equal(debouncer.size, 0);
  });

  it('cancels everything on shutdown', async () => {
    const debouncer = new KeyedDebouncer(20);
    let runs = 0;
    debouncer.schedule('a', () => {
      runs += 1;
    });
    debouncer.schedule('b', () => {
      runs += 1;
    });
    debouncer.cancelAll();

    await tick(40);
    assert.equal(runs, 0);
  });
});
