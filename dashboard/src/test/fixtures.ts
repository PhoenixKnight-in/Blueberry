/**
 * Fixture rows for the dashboard tests.
 *
 * Deliberately the four outcomes from the backend's own README — a safe
 * package, a hallucinated one, a typosquat that exists, and one whose listing
 * points at somebody else's repository — so the UI is exercised against the
 * shapes the pipeline actually produces.
 */

import type { CheckDetail, CheckSummary, Stats } from '../types';

export function summary(overrides: Partial<CheckSummary> = {}): CheckSummary {
  return {
    id: 1,
    package_name: 'requests',
    normalized_name: 'requests',
    ecosystem: 'pypi',
    final_score: 0,
    severity: 'safe',
    status: 'open',
    exists_on_pypi: true,
    latest_version: '2.31.0',
    similarity_score: null,
    matched_package: null,
    edit_distance: null,
    github_status: 'ok',
    github_repo: 'psf/requests',
    github_repo_health: 0.98,
    github_stars: 54000,
    github_archived: false,
    github_last_commit: '2026-08-20T10:00:00Z',
    duration_ms: 37,
    checked_at: '2026-09-09T09:00:00Z',
    top_reason: null,
    ...overrides,
  };
}

export const HALLUCINATED = summary({
  id: 2,
  package_name: 'reqeusts',
  normalized_name: 'reqeusts',
  final_score: 100,
  severity: 'high_risk',
  exists_on_pypi: false,
  latest_version: null,
  matched_package: 'requests',
  similarity_score: 0.875,
  edit_distance: 2,
  github_status: null,
  github_repo: null,
  github_repo_health: null,
  github_stars: null,
  top_reason: "'reqeusts' is not published on PyPI — it looks hallucinated.",
});

export const TYPOSQUAT = summary({
  id: 3,
  package_name: 'urllib4',
  normalized_name: 'urllib4',
  final_score: 75,
  severity: 'high_risk',
  matched_package: 'urllib3',
  similarity_score: 0.8571,
  edit_distance: 1,
  github_status: 'no_repository_link',
  github_repo: null,
  github_repo_health: null,
  github_stars: null,
  top_reason: "'urllib4' is a single character away from 'urllib3'.",
});

export const MISMATCHED = summary({
  id: 4,
  package_name: 'some-obscure-lib',
  normalized_name: 'some-obscure-lib',
  final_score: 35,
  severity: 'caution',
  status: 'ignored',
  top_reason: 'The linked repository does not belong to this package.',
});

export const ROWS: CheckSummary[] = [HALLUCINATED, TYPOSQUAT, MISMATCHED, summary()];

export function detail(overrides: Partial<CheckDetail> = {}): CheckDetail {
  return {
    ...TYPOSQUAT,
    explanation: [
      "'urllib4' is a single character away from 'urllib3'.",
      'The listing links no source repository.',
    ],
    signals: [
      {
        rule_id: 'typosquat_distance_1',
        points: 60,
        message: "'urllib4' is a single character away from 'urllib3'.",
      },
      {
        rule_id: 'no_repository_link',
        points: 15,
        message: 'The listing links no source repository.',
      },
    ],
    pypi_metadata: { name: 'urllib4', latest_version: '1.0.0' },
    github_detail: { status: 'no_repository_link' },
    similarity_detail: { is_typosquat_suspect: true, edit_distance: 1 },
    error: null,
    ...overrides,
  };
}

export const STATS: Stats = {
  total_checks: 231,
  unique_packages: 88,
  by_severity: { safe: 180, caution: 31, high_risk: 20 },
  open_flags: 12,
  checks_last_7_days: 64,
  hallucinated_count: 7,
  typosquat_count: 9,
  latest_check_at: '2026-09-09T09:00:00Z',
};
