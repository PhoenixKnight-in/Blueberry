/**
 * The full scoring breakdown for one stored check.
 *
 * The design document calls this "see exactly why it was flagged", and that is
 * the whole brief: the score, the three checks that fed it, and every rule
 * that contributed a point. Nothing here is summarised — the summary is the
 * table row the reader clicked to get here.
 */

import type { CheckDetail } from '../types';
import {
  absoluteTime,
  asCount,
  asPercent,
  relativeTime,
  statusLabel,
} from '../utils/format';
import { RiskScoreCard } from './RiskScoreCard';
import { SignalList } from './SignalList';

interface PackageDetailProps {
  readonly detail: CheckDetail | null;
  readonly loading: boolean;
  readonly onClose: () => void;
}

/** One label/value pair in the facts list. */
function Fact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <li>
      <span className="detail__fact-label">{label}</span>
      <span className="detail__fact-value">{value}</span>
    </li>
  );
}

/** How the GitHub check ended up, in words. */
function githubSummary(detail: CheckDetail): string {
  switch (detail.github_status) {
    case 'ok':
      return detail.github_repo ?? 'repository found';
    case 'no_repository_link':
      return 'no repository linked';
    case 'not_found':
      return 'the linked repository does not exist';
    case 'unavailable':
      // Never scored, and it matters that a reader knows that: an
      // unreachable GitHub contributes zero points rather than being guessed.
      return 'GitHub could not be reached (not scored)';
    default:
      return 'not checked';
  }
}

export function PackageDetail({ detail, loading, onClose }: PackageDetailProps) {
  if (loading && !detail) {
    return (
      <section className="card detail">
        <div className="loading">Loading details…</div>
      </section>
    );
  }
  if (!detail) {
    return null;
  }

  return (
    <section className="card detail" aria-label={`Details for ${detail.package_name}`}>
      <div className="detail__header">
        <h2 className="detail__name">{detail.package_name}</h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>

      <RiskScoreCard score={detail.final_score} severity={detail.severity} />

      <div className="detail__grid" style={{ marginTop: 20 }}>
        <div>
          <h3 className="section__title">The three checks</h3>
          <ul className="detail__facts">
            <Fact
              label="On PyPI"
              value={
                detail.exists_on_pypi
                  ? `yes${detail.latest_version ? ` (v${detail.latest_version})` : ''}`
                  : 'NO — this package does not exist'
              }
            />
            <Fact label="GitHub" value={githubSummary(detail)} />
            <Fact
              label="Repository health"
              value={asPercent(detail.github_repo_health)}
            />
            <Fact label="Stars" value={asCount(detail.github_stars)} />
            <Fact
              label="Closest popular name"
              value={
                detail.matched_package
                  ? `${detail.matched_package} (${detail.edit_distance} edit${
                      detail.edit_distance === 1 ? '' : 's'
                    }, ${asPercent(detail.similarity_score)} similar)`
                  : 'no close match'
              }
            />
          </ul>
        </div>

        <div>
          <h3 className="section__title">Provenance</h3>
          <ul className="detail__facts">
            <Fact label="Ecosystem" value={detail.ecosystem} />
            <Fact label="Normalised name" value={detail.normalized_name} />
            <Fact label="Review status" value={statusLabel(detail.status)} />
            <Fact
              label="Checked"
              value={`${relativeTime(detail.checked_at)} (${absoluteTime(detail.checked_at)})`}
            />
            <Fact
              label="Check duration"
              value={detail.duration_ms === null ? '—' : `${detail.duration_ms} ms`}
            />
          </ul>
        </div>
      </div>

      <div style={{ marginTop: 20 }}>
        <h3 className="section__title">Why this score</h3>
        <SignalList signals={detail.signals} finalScore={detail.final_score} />
      </div>

      {detail.error ? (
        <p className="app__meta" style={{ marginTop: 16 }}>
          Recorded error: {detail.error}
        </p>
      ) : null}
    </section>
  );
}
