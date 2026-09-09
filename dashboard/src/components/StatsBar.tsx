/**
 * The summary strip: a KPI row plus the severity distribution.
 *
 * Reads top-down as a triage question — how much has been checked, how much of
 * it is still waiting on somebody, and what the two attack patterns Blueberry
 * exists to catch actually cost this codebase.
 */

import type { Stats } from '../types';
import { asCount, relativeTime, absoluteTime } from '../utils/format';
import { SeverityBar } from './SeverityBar';
import { StatTile } from './StatTile';

interface StatsBarProps {
  readonly stats: Stats | null;
  readonly loading: boolean;
}

export function StatsBar({ stats, loading }: StatsBarProps) {
  if (loading && !stats) {
    return <div className="loading">Loading summary…</div>;
  }
  if (!stats) {
    return null;
  }

  return (
    <section className="section" aria-label="Summary">
      <div className="stats">
        <StatTile
          label="Checks recorded"
          value={asCount(stats.total_checks)}
          hint={`${asCount(stats.unique_packages)} distinct packages`}
        />
        <StatTile
          label="Open flags"
          value={asCount(stats.open_flags)}
          hint="Not safe, not yet triaged"
          emphasis={stats.open_flags > 0}
        />
        <StatTile
          label="Hallucinated"
          value={asCount(stats.hallucinated_count)}
          hint="Never published to PyPI"
        />
        <StatTile
          label="Typosquat suspects"
          value={asCount(stats.typosquat_count)}
          hint="Close to a popular name"
        />
        <StatTile
          label="Last 7 days"
          value={asCount(stats.checks_last_7_days)}
          hint={
            stats.latest_check_at
              ? `latest ${relativeTime(stats.latest_check_at)}`
              : 'no checks yet'
          }
        />
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <h2 className="section__title">Severity distribution</h2>
        <SeverityBar counts={stats.by_severity} />
        <p className="app__meta" style={{ marginTop: 10, marginBottom: 0 }}>
          <span title={absoluteTime(stats.latest_check_at)}>
            Last check {relativeTime(stats.latest_check_at)}.
          </span>
        </p>
      </div>
    </section>
  );
}
