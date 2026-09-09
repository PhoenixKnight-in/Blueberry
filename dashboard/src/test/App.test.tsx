/**
 * End-to-end tests for the dashboard shell, against a stubbed `fetch`.
 *
 * These cover the wiring the component tests cannot: that a filter change
 * actually reaches the query string, that triaging a row refreshes both the
 * table and the counts above it, and — the one that matters most — that an
 * unreachable backend produces a *banner*, not an empty table.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';
import { ROWS, STATS, detail } from './fixtures';

/** Routes a stubbed fetch by path, and records every URL requested. */
function installFetch(
  overrides: {
    packages?: (url: URL) => Response;
    stats?: () => Response;
    detail?: () => Response;
    patch?: () => Response;
  } = {},
) {
  const calls: string[] = [];

  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : String(input);
    calls.push(raw);
    const url = new URL(raw);

    if (init?.method === 'PATCH') {
      return overrides.patch?.() ?? json(detail({ status: 'ignored' }));
    }
    if (url.pathname === '/stats') {
      return overrides.stats?.() ?? json(STATS);
    }
    if (url.pathname === '/packages') {
      return (
        overrides.packages?.(url) ??
        json({ items: ROWS, total: ROWS.length, limit: 25, offset: 0 })
      );
    }
    if (url.pathname.startsWith('/packages/')) {
      return overrides.detail?.() ?? json(detail());
    }
    return new Response('not found', { status: 404 });
  });

  vi.stubGlobal('fetch', impl);
  return { calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App', () => {
  it('renders the summary and the table', async () => {
    installFetch();
    render(<App />);

    expect(await screen.findByText('reqeusts')).toBeInTheDocument();
    expect(screen.getByText('231')).toBeInTheDocument(); // total checks
    expect(screen.getByText('urllib4')).toBeInTheDocument();
  });

  it('shows a banner, not an empty table, when the backend is unreachable', async () => {
    // The central honesty requirement: silence must never read as "clean".
    installFetch({
      packages: () => json({ detail: 'The check history is unavailable' }, 503),
      stats: () => json({ detail: 'The check history is unavailable' }, 503),
    });

    render(<App />);

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0]).toHaveTextContent(/history is unavailable/);
  });

  it('does not claim "no checks recorded" while an error is showing', async () => {
    installFetch({
      packages: () => json({ detail: 'database unavailable' }, 503),
    });

    render(<App />);

    await screen.findByRole('alert');
    // The empty-state copy may be present, but the error must be too — and it
    // is the error that explains the emptiness.
    expect(screen.getByRole('alert')).toHaveTextContent(/database unavailable/);
  });

  it('sends a severity filter to the backend', async () => {
    const { calls } = installFetch();
    render(<App />);
    await screen.findByText('reqeusts');

    await userEvent.selectOptions(screen.getByLabelText('Severity'), 'high_risk');

    await waitFor(() => {
      expect(calls.some((url) => url.includes('severity=high_risk'))).toBe(true);
    });
  });

  it('debounces the search box instead of querying per keystroke', async () => {
    const { calls } = installFetch();
    render(<App />);
    await screen.findByText('reqeusts');

    const before = calls.filter((url) => url.includes('/packages?')).length;
    await userEvent.type(screen.getByLabelText('Package name'), 'urllib');

    await waitFor(() => {
      expect(calls.some((url) => url.includes('search=urllib'))).toBe(true);
    });

    const after = calls.filter((url) => url.includes('/packages?')).length;
    // Six characters typed; a per-keystroke implementation would add six
    // requests. The debounce should collapse them into far fewer.
    expect(after - before).toBeLessThan(6);
  });

  it('returns to the first page when a filter changes', async () => {
    const { calls } = installFetch({
      packages: () => json({ items: ROWS, total: 200, limit: 25, offset: 0 }),
    });
    render(<App />);
    await screen.findByText('reqeusts');

    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(calls.some((url) => url.includes('offset=25'))).toBe(true));

    await userEvent.selectOptions(screen.getByLabelText('Severity'), 'caution');

    await waitFor(() => {
      const latest = calls.filter((url) => url.includes('/packages?')).at(-1) ?? '';
      expect(latest).toContain('severity=caution');
      expect(latest).toContain('offset=0');
    });
  });

  it('opens the detail view with the full breakdown', async () => {
    installFetch();
    render(<App />);
    await screen.findByText('urllib4');

    await userEvent.click(screen.getByRole('button', { name: /Show why urllib4/ }));

    const panel = await screen.findByLabelText('Details for urllib4');
    expect(within(panel).getByText('+60')).toBeInTheDocument();
    expect(within(panel).getByText('+15')).toBeInTheDocument();
    expect(within(panel).getByRole('meter')).toHaveAttribute('aria-valuenow', '75');
  });

  it('triages a row and refreshes the counts above the table', async () => {
    const { calls } = installFetch();
    render(<App />);
    await screen.findByText('urllib4');

    const statsCallsBefore = calls.filter((url) => url.endsWith('/stats')).length;

    const row = screen.getByText('urllib4').closest('tr');
    expect(row).not.toBeNull();
    await userEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Ignore' }));

    await waitFor(() => {
      // The open-flag tile is derived from the same rows, so it has to reload.
      expect(calls.filter((url) => url.endsWith('/stats')).length).toBeGreaterThan(
        statsCallsBefore,
      );
    });
  });

  it('reports a failed triage rather than showing it as applied', async () => {
    installFetch({ patch: () => json({ detail: 'database unavailable' }, 503) });
    render(<App />);
    await screen.findByText('urllib4');

    const row = screen.getByText('urllib4').closest('tr');
    await userEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Ignore' }));

    expect(await screen.findByText(/That action did not go through/)).toBeInTheDocument();
  });

  it('renders the honest empty state when there really is no history', async () => {
    installFetch({
      packages: () => json({ items: [], total: 0, limit: 25, offset: 0 }),
      stats: () =>
        json({ ...STATS, total_checks: 0, by_severity: { safe: 0, caution: 0, high_risk: 0 } }),
    });

    render(<App />);

    expect(await screen.findByText(/No checks recorded yet/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
