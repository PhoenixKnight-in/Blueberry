/**
 * The dashboard shell.
 *
 * Holds the state that more than one component needs — the filters, the page
 * offset, the selected row — and nothing else. Everything that renders is a
 * small component below this one, per the coding-standards document's rule
 * against a single Dashboard component that does everything.
 *
 * One behaviour worth stating outright: an unreachable backend renders a
 * banner *above* the table, not an empty table. "Nothing has been flagged" and
 * "we could not ask" are opposite conclusions, and a reviewer must never be
 * shown the first when the second is true.
 */

import { useCallback, useEffect, useState } from 'react';

import { ErrorBanner } from './components/ErrorBanner';
import { FilterBar } from './components/FilterBar';
import { FlaggedPackageTable } from './components/FlaggedPackageTable';
import { PackageDetail } from './components/PackageDetail';
import { Pagination } from './components/Pagination';
import { StatsBar } from './components/StatsBar';
import { usePackages, useStats } from './hooks/useDashboardData';
import {
  API_BASE_URL,
  PAGE_SIZE,
  fetchPackageDetail,
  updatePackageStatus,
} from './services/api';
import type { CheckDetail, FlagStatus, Filters } from './types';

const NO_FILTERS: Filters = { search: '', severity: '', status: '', minScore: null };

function hasActiveFilters(filters: Filters): boolean {
  return (
    filters.search.trim() !== '' ||
    filters.severity !== '' ||
    filters.status !== '' ||
    filters.minScore !== null
  );
}

export function App() {
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<CheckDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { page, loading, error, reload } = usePackages(filters, offset);
  const { stats, loading: statsLoading, error: statsError, reload: reloadStats } =
    useStats();

  /** Any filter change returns to the first page — page 4 of the old result
      set is meaningless against the new one. */
  const handleFilterChange = useCallback((next: Filters) => {
    setFilters(next);
    setOffset(0);
  }, []);

  // Load the selected row's full record.
  useEffect(() => {
    if (selectedId === null) {
      setDetail(null);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;

    void (async () => {
      setDetailLoading(true);
      const result = await fetchPackageDetail(selectedId, { signal: controller.signal });
      if (cancelled) {
        return;
      }
      if (result.kind === 'ok') {
        setDetail(result.data);
        setActionError(null);
      } else {
        setActionError(result.message);
      }
      setDetailLoading(false);
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [selectedId]);

  const handleStatusChange = useCallback(
    async (id: number, status: FlagStatus) => {
      setBusyId(id);
      const result = await updatePackageStatus(id, status);
      setBusyId(null);

      if (result.kind === 'error') {
        setActionError(result.message);
        return;
      }

      setActionError(null);
      // The row's status changed, and so did the open-flag count above it.
      reload();
      reloadStats();
      if (selectedId === id) {
        setDetail(result.data);
      }
    },
    [reload, reloadStats, selectedId],
  );

  const rows = page?.items ?? [];
  const total = page?.total ?? 0;

  return (
    <div className="app">
      <header className="app__header">
        <h1 className="app__title">Blueberry — flagged packages</h1>
        <span className="app__meta">{API_BASE_URL}</span>
      </header>
      <p className="app__subtitle">
        Every package the VS Code extension has checked, with the reasons behind each
        score.
      </p>

      {statsError ? (
        <ErrorBanner
          title="Could not load the summary"
          detail={statsError}
          onRetry={reloadStats}
        />
      ) : null}

      <StatsBar stats={stats} loading={statsLoading} />

      <section className="section" aria-label="Flagged packages">
        <FilterBar filters={filters} onChange={handleFilterChange} />

        {error ? (
          <ErrorBanner
            title="Could not load the check history"
            detail={error}
            onRetry={reload}
          />
        ) : null}

        {actionError ? (
          <ErrorBanner title="That action did not go through" detail={actionError} />
        ) : null}

        <FlaggedPackageTable
          rows={rows}
          loading={loading}
          selectedId={selectedId}
          busyId={busyId}
          onSelect={setSelectedId}
          onStatusChange={handleStatusChange}
          filtersActive={hasActiveFilters(filters)}
        />

        <Pagination
          total={total}
          offset={offset}
          limit={PAGE_SIZE}
          loading={loading}
          onOffsetChange={setOffset}
        />
      </section>

      <PackageDetail
        detail={detail}
        loading={detailLoading}
        onClose={() => setSelectedId(null)}
      />
    </div>
  );
}
