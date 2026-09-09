/**
 * Tests for the API layer.
 *
 * Two things are being pinned down. First, the query string: the backend
 * validates `severity` and `status` as enums, so sending an empty string for
 * "no filter" is a 422 rather than a wider search — a mistake that would only
 * show up as a broken filter in the UI. Second, that no failure is ever
 * silently turned into data.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  API_BASE_URL,
  buildQuery,
  fetchPackageDetail,
  fetchPackages,
  fetchStats,
  updatePackageStatus,
} from '../services/api';
import type { Filters } from '../types';
import { ROWS, STATS, detail } from './fixtures';

const NO_FILTERS: Filters = { search: '', severity: '', status: '', minScore: null };

/** A `fetch` stub returning one canned JSON response. */
function jsonFetch(status: number, body: unknown) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

describe('buildQuery', () => {
  it('omits every empty filter', () => {
    const query = buildQuery(NO_FILTERS, 0);

    expect(query).toBe('limit=25&offset=0');
  });

  it('never sends an empty severity, which the backend rejects as a 422', () => {
    expect(buildQuery(NO_FILTERS, 0)).not.toContain('severity');
    expect(buildQuery(NO_FILTERS, 0)).not.toContain('status');
  });

  it('includes the filters that are set', () => {
    const query = buildQuery(
      { search: 'urllib', severity: 'high_risk', status: 'open', minScore: 60 },
      50,
    );
    const params = new URLSearchParams(query);

    expect(params.get('search')).toBe('urllib');
    expect(params.get('severity')).toBe('high_risk');
    expect(params.get('status')).toBe('open');
    expect(params.get('min_score')).toBe('60');
    expect(params.get('offset')).toBe('50');
  });

  it('trims the search term', () => {
    expect(new URLSearchParams(buildQuery({ ...NO_FILTERS, search: '  urllib  ' }, 0)).get('search')).toBe(
      'urllib',
    );
  });

  it('keeps a zero minimum score, which is a real filter', () => {
    // `0` is falsy but meaningful; only `null` means "no filter".
    expect(buildQuery({ ...NO_FILTERS, minScore: 0 }, 0)).toContain('min_score=0');
  });
});

describe('fetchPackages', () => {
  it('returns the page on success', async () => {
    const body = { items: ROWS, total: ROWS.length, limit: 25, offset: 0 };
    const result = await fetchPackages(NO_FILTERS, 0, { fetchImpl: jsonFetch(200, body) });

    expect(result.kind).toBe('ok');
    expect(result.kind === 'ok' && result.data.total).toBe(ROWS.length);
  });

  it('requests the packages endpoint on the configured backend', async () => {
    const spy = jsonFetch(200, { items: [], total: 0, limit: 25, offset: 0 });
    await fetchPackages(NO_FILTERS, 0, { fetchImpl: spy });

    expect(spy).toHaveBeenCalledWith(
      `${API_BASE_URL}/packages?limit=25&offset=0`,
      expect.anything(),
    );
  });

  it('surfaces the backend detail on a 503 instead of returning empty rows', async () => {
    // The distinction the whole dashboard hangs on: "we could not ask" must
    // never render as "nothing was flagged".
    const result = await fetchPackages(NO_FILTERS, 0, {
      fetchImpl: jsonFetch(503, { detail: 'The check history is unavailable' }),
    });

    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.message).toMatch(/history is unavailable/);
  });

  it('reports a network failure and names the backend', async () => {
    const failing = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const result = await fetchPackages(NO_FILTERS, 0, { fetchImpl: failing });

    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.message).toContain(API_BASE_URL);
  });

  it('falls back to the status code when the error body is not JSON', async () => {
    const html = vi.fn(async () => new Response('<html>502</html>', { status: 502 })) as
      unknown as typeof fetch;

    const result = await fetchPackages(NO_FILTERS, 0, { fetchImpl: html });

    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.message).toMatch(/502/);
  });
});

describe('fetchPackageDetail', () => {
  it('requests one stored check by id', async () => {
    const spy = jsonFetch(200, detail());
    const result = await fetchPackageDetail(3, { fetchImpl: spy });

    expect(spy).toHaveBeenCalledWith(`${API_BASE_URL}/packages/3`, expect.anything());
    expect(result.kind).toBe('ok');
  });

  it('reports a 404 rather than rendering a blank detail panel', async () => {
    const result = await fetchPackageDetail(999, {
      fetchImpl: jsonFetch(404, { detail: 'No stored check with id 999.' }),
    });

    expect(result.kind).toBe('error');
  });
});

describe('fetchStats', () => {
  it('returns the summary', async () => {
    const result = await fetchStats({ fetchImpl: jsonFetch(200, STATS) });

    expect(result.kind).toBe('ok');
    expect(result.kind === 'ok' && result.data.open_flags).toBe(12);
  });
});

describe('updatePackageStatus', () => {
  it('PATCHes the new status', async () => {
    const spy = jsonFetch(200, detail({ status: 'ignored' }));
    await updatePackageStatus(3, 'ignored', { fetchImpl: spy });

    expect(spy).toHaveBeenCalledWith(
      `${API_BASE_URL}/packages/3`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ status: 'ignored' }),
      }),
    );
  });

  it('returns the updated record', async () => {
    const result = await updatePackageStatus(3, 'resolved', {
      fetchImpl: jsonFetch(200, detail({ status: 'resolved' })),
    });

    expect(result.kind).toBe('ok');
    expect(result.kind === 'ok' && result.data.status).toBe('resolved');
  });

  it('reports a failed triage rather than pretending it worked', async () => {
    const result = await updatePackageStatus(3, 'resolved', {
      fetchImpl: jsonFetch(503, { detail: 'database unavailable' }),
    });

    expect(result.kind).toBe('error');
  });
});
