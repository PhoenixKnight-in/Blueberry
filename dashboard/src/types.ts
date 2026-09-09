/**
 * The dashboard's view of the backend contract.
 *
 * Mirrors `app/schemas/dashboard.py`. Like the extension's copy, it declares
 * only what is rendered, so an additive backend change cannot break the build.
 */

export type Severity = 'safe' | 'caution' | 'high_risk';

/** Where a flagged package sits in the review workflow. */
export type FlagStatus = 'open' | 'ignored' | 'resolved';

/** One fired scoring rule. */
export interface RiskSignal {
  rule_id: string;
  points: number;
  message: string;
}

/** One row in the flagged-package table. */
export interface CheckSummary {
  id: number;
  package_name: string;
  normalized_name: string;
  ecosystem: string;

  final_score: number;
  severity: Severity;
  status: FlagStatus;

  exists_on_pypi: boolean;
  latest_version: string | null;

  similarity_score: number | null;
  matched_package: string | null;
  edit_distance: number | null;

  github_status: string | null;
  github_repo: string | null;
  github_repo_health: number | null;
  github_stars: number | null;
  github_archived: boolean | null;
  github_last_commit: string | null;

  duration_ms: number | null;
  checked_at: string;
  top_reason: string | null;
}

/** One stored check in full — the detail view. */
export interface CheckDetail extends CheckSummary {
  explanation: string[];
  signals: RiskSignal[];
  pypi_metadata: Record<string, unknown> | null;
  github_detail: Record<string, unknown> | null;
  similarity_detail: Record<string, unknown> | null;
  error: string | null;
}

/** A page of stored checks. */
export interface CheckPage {
  items: CheckSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface SeverityCount {
  safe: number;
  caution: number;
  high_risk: number;
}

/** The summary strip above the table. */
export interface Stats {
  total_checks: number;
  unique_packages: number;
  by_severity: SeverityCount;
  open_flags: number;
  checks_last_7_days: number;
  hallucinated_count: number;
  typosquat_count: number;
  latest_check_at: string | null;
}

/** Filters the table applies, as held in component state. */
export interface Filters {
  search: string;
  severity: Severity | '';
  status: FlagStatus | '';
  minScore: number | null;
}

/**
 * An API call's result.
 *
 * A discriminated union rather than throw/catch for the same reason the
 * extension uses one: "the backend is unreachable" is a state the UI has to
 * *render*, not an exception to swallow. An empty table and a broken backend
 * must never look the same.
 */
export type ApiResult<T> =
  | { readonly kind: 'ok'; readonly data: T }
  | { readonly kind: 'error'; readonly message: string };
