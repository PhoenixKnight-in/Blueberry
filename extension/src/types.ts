/**
 * The wire contract between the extension and the FastAPI backend.
 *
 * These interfaces are a hand-maintained mirror of `app/schemas/risk.py`. They
 * are kept deliberately *narrow*: only the fields the extension actually
 * renders are declared, so an additive backend change (a new detail object,
 * another signal field) cannot break compilation here. The backend's own tests
 * assert this shape, which is what makes that safe.
 */

/** The three severity states the inline warning renders. */
export type Severity = 'safe' | 'caution' | 'high_risk';

/** One fired scoring rule — the unit of explainability. */
export interface RiskSignal {
  rule_id: string;
  points: number;
  message: string;
}

/** A package name found in a document, with where it was found. */
export interface PackageCandidate {
  /** The name as written in the source text. */
  readonly name: string;
  /** Zero-based line the name appears on. */
  readonly line: number;
  /** Zero-based column the name starts at. */
  readonly startCharacter: number;
  /** Zero-based column one past the end of the name. */
  readonly endCharacter: number;
  /** What kind of statement it came from — shown in the hover. */
  readonly source: CandidateSource;
}

export type CandidateSource =
  | 'import'
  | 'from-import'
  | 'requirements'
  | 'pip-install'
  | 'pyproject'
  | 'manual';

/** A normalised request to the backend. */
export interface CheckRequest {
  package_name: string;
  ecosystem: string;
}

/** The subset of the backend's `RiskReport` the extension reads. */
export interface RiskReport {
  package_name: string;
  normalized_name: string | null;
  ecosystem: string;

  exists_on_pypi: boolean;
  github_repo_health: number | null;
  similarity_score: number | null;
  matched_package: string | null;

  final_score: number;
  severity: Severity;
  explanation: string[];
  signals: RiskSignal[];

  pypi_metadata?: PyPIMetadata | null;
  github?: GitHubCheckResult | null;
  similarity?: SimilarityResult | null;

  checked_at: string;
  duration_ms: number | null;
}

export interface PyPIMetadata {
  name: string;
  summary: string | null;
  latest_version: string | null;
  version_count: number;
  first_release_date: string | null;
  latest_release_date: string | null;
  author: string | null;
  home_page: string | null;
  project_urls: Record<string, string>;
}

export interface GitHubCheckResult {
  status: 'ok' | 'no_repository_link' | 'not_found' | 'unavailable';
  repo_full_name: string | null;
  days_since_last_commit: number | null;
  matches_package: boolean | null;
  health_score: number | null;
  rate_limited: boolean;
  detail: string | null;
  repo?: { stars: number; archived: boolean; html_url: string } | null;
}

export interface SimilarityResult {
  is_known_popular: boolean;
  is_typosquat_suspect: boolean;
  nearest_package: string | null;
  edit_distance: number | null;
  similarity_score: number | null;
}

/**
 * What the client hands back for one candidate.
 *
 * A failed check is a first-class result rather than a thrown error, because
 * the UI has something specific to say about it: "could not verify" is not the
 * same as "safe", and the developer needs to be able to tell them apart.
 */
export type CheckOutcome =
  | { readonly kind: 'ok'; readonly report: RiskReport }
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'unavailable'; readonly reason: string };

/** Extension settings, resolved from the workspace configuration. */
export interface BlueberrySettings {
  readonly enabled: boolean;
  readonly backendUrl: string;
  readonly dashboardUrl: string;
  readonly sensitivityThreshold: number;
  readonly enabledEcosystems: readonly string[];
  readonly ignoredPackages: readonly string[];
  readonly debounceMs: number;
  readonly requestTimeoutMs: number;
}
