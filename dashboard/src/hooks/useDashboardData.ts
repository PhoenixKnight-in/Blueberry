/**
 * Data loading for the dashboard.
 *
 * Two hooks, because the table and the summary strip have different lifetimes:
 * the table reloads on every filter change and page turn, while the stats only
 * need refreshing when something is actually triaged.
 *
 * Both follow the same two rules:
 *
 * - **Every request is abortable**, and a superseded response is discarded.
 *   Typing in the search box fires a request per keystroke, and without this
 *   an early slow response can land after a later fast one and paint stale
 *   rows.
 * - **An error is state, not an exception.** It is returned alongside the
 *   data so the UI can show a banner *and* whatever it last had, rather than
 *   an empty table that reads as "nothing was ever flagged".
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchPackages, fetchStats } from '../services/api';
import type { CheckPage, Filters, Stats } from '../types';

/** How long to wait after the last keystroke before querying. */
export const SEARCH_DEBOUNCE_MS = 300;

interface PackagesState {
  readonly page: CheckPage | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly reload: () => void;
}

/**
 * Load one page of flagged packages for the current filters.
 *
 * @param filters The table's filter state.
 * @param offset Row offset of the page to load.
 */
export function usePackages(filters: Filters, offset: number): PackagesState {
  const [page, setPage] = useState<CheckPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  // Serialised so the effect re-runs on a *value* change rather than on every
  // new object identity React hands it.
  const filterKey = JSON.stringify(filters);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    const timer = setTimeout(async () => {
      setLoading(true);
      const result = await fetchPackages(JSON.parse(filterKey) as Filters, offset, {
        signal: controller.signal,
      });

      if (cancelled) {
        return;
      }
      if (result.kind === 'ok') {
        setPage(result.data);
        setError(null);
      } else {
        setError(result.message);
      }
      setLoading(false);
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [filterKey, offset, nonce]);

  return { page, loading, error, reload };
}

interface StatsState {
  readonly stats: Stats | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly reload: () => void;
}

/** Load the summary strip. */
export function useStats(): StatsState {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const mounted = useRef(true);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();

    void (async () => {
      setLoading(true);
      const result = await fetchStats({ signal: controller.signal });
      if (!mounted.current) {
        return;
      }
      if (result.kind === 'ok') {
        setStats(result.data);
        setError(null);
      } else {
        setError(result.message);
      }
      setLoading(false);
    })();

    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [nonce]);

  return { stats, loading, error, reload };
}
