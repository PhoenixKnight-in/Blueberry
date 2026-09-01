"""The risk-report contract shared between backend, extension, and dashboard.

All four checks are live now, so every field below is populated for real. The
Week 1 field names (``exists_on_pypi``, ``github_repo_health``,
``similarity_score``, ``matched_package``) are kept exactly as they were, so the
extension built against the Week 0 contract keeps working -- the new detail
objects (``github``, ``similarity``) are purely additive.
"""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum

from pydantic import BaseModel, Field, field_validator


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Severity(str, Enum):
    """The three severity states the inline warning and dashboard render."""

    SAFE = "safe"
    CAUTION = "caution"
    HIGH_RISK = "high_risk"


class CheckRequest(BaseModel):
    """Body of ``POST /check`` -- a single package name to verify."""

    package_name: str = Field(
        ...,
        min_length=1,
        max_length=214,  # PyPI enforces a 214-character maximum.
        description="The package name to verify, as it appears in code / pip install.",
        examples=["requests", "reqeusts", "totally-made-up-pkg"],
    )
    ecosystem: str = Field(
        default="pypi",
        description="Package ecosystem. Only pypi is supported in phase one.",
    )

    @field_validator("package_name")
    @classmethod
    def _strip(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("package_name must not be blank")
        return stripped


# ---------------------------------------------------------------------------
# PyPI
# ---------------------------------------------------------------------------


class PyPIMetadata(BaseModel):
    """Metadata pulled from the PyPI JSON API for an existing package."""

    name: str
    summary: str | None = None
    latest_version: str | None = None
    version_count: int = 0
    first_release_date: datetime | None = None
    latest_release_date: datetime | None = None
    author: str | None = None
    author_email: str | None = None
    maintainer: str | None = None
    maintainer_email: str | None = None
    home_page: str | None = None
    project_urls: dict[str, str] = Field(default_factory=dict)

    @property
    def has_attribution(self) -> bool:
        """Whether the listing names anyone at all.

        Checks the e-mail fields too: packaging metadata 2.1+ encourages
        ``author_email`` in the form ``Name <addr>`` and leaves ``author``
        empty, so reading only ``author`` would report most modern packages --
        including requests itself -- as anonymous.
        """
        return any(
            (self.author, self.author_email, self.maintainer, self.maintainer_email)
        )


class PyPICheckResult(BaseModel):
    """Result of the PyPI existence check for one package."""

    exists: bool
    metadata: PyPIMetadata | None = None


# ---------------------------------------------------------------------------
# GitHub
# ---------------------------------------------------------------------------


class GitHubRepoStatus(str, Enum):
    """Why the GitHub check ended up where it did.

    ``UNAVAILABLE`` is deliberately distinct from ``NOT_FOUND``: "we could not
    reach GitHub" must never be scored the same as "the repository does not
    exist", or a rate-limited checker would start inventing risk.
    """

    OK = "ok"
    NO_REPOSITORY_LINK = "no_repository_link"
    NOT_FOUND = "not_found"
    UNAVAILABLE = "unavailable"


class GitHubRepoInfo(BaseModel):
    """The subset of the GitHub repo payload the risk engine actually uses."""

    full_name: str
    html_url: str
    description: str | None = None
    stars: int = 0
    forks: int = 0
    open_issues: int = 0
    subscribers: int = 0
    archived: bool = False
    disabled: bool = False
    is_fork: bool = False
    created_at: datetime | None = None
    pushed_at: datetime | None = Field(
        default=None,
        description="Last push to any branch -- the proxy for last commit date.",
    )
    updated_at: datetime | None = None
    license_name: str | None = None
    default_branch: str | None = None
    topics: list[str] = Field(default_factory=list)


class GitHubCheckResult(BaseModel):
    """Result of resolving and inspecting the package source repository."""

    status: GitHubRepoStatus
    source_url: str | None = Field(
        default=None,
        description="The PyPI metadata URL the repository was resolved from.",
    )
    repo_full_name: str | None = None
    repo: GitHubRepoInfo | None = None

    days_since_last_commit: int | None = None
    matches_package: bool | None = Field(
        default=None,
        description="Whether the repo plausibly belongs to this package.",
    )
    match_reason: str | None = None

    health_score: float | None = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description="0.0 = abandoned or unrelated, 1.0 = active and clearly matching.",
    )
    rate_limited: bool = Field(
        default=False,
        description="True when the result is degraded by a GitHub rate limit.",
    )
    detail: str | None = None


# ---------------------------------------------------------------------------
# Similarity
# ---------------------------------------------------------------------------


class SimilarityMatch(BaseModel):
    """One near-match against the curated popular-package list."""

    package: str
    distance: int
    similarity: float = Field(ge=0.0, le=1.0)


class SimilarityResult(BaseModel):
    """Result of the Levenshtein comparison against high-traffic names."""

    is_known_popular: bool = Field(
        default=False,
        description="The name IS one of the popular packages -- never a squat.",
    )
    is_typosquat_suspect: bool = False
    nearest_package: str | None = None
    edit_distance: int | None = None
    similarity_score: float | None = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description="1.0 = identical, 0.0 = nothing in common.",
    )
    matches: list[SimilarityMatch] = Field(
        default_factory=list,
        description="All candidates within the edit-distance threshold.",
    )


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------


class RiskSignal(BaseModel):
    """One fired rule -- the unit of explainability.

    A developer should be able to read this list and reconstruct the score by
    hand. That is the whole argument for rule-based scoring over a learned
    model in a security tool.
    """

    rule_id: str
    points: int
    message: str


class RiskAssessment(BaseModel):
    """What the risk engine returns: a score plus why."""

    final_score: int = Field(ge=0, le=100)
    severity: Severity
    signals: list[RiskSignal] = Field(default_factory=list)

    @property
    def explanation(self) -> list[str]:
        return [signal.message for signal in self.signals]


# ---------------------------------------------------------------------------
# The report
# ---------------------------------------------------------------------------


class RiskReport(BaseModel):
    """The full risk report -- one per checked package.

    Rendered by both the inline warning in the extension and the dashboard.
    """

    package_name: str
    normalized_name: str | None = None
    ecosystem: str = "pypi"

    # --- Signals (flat fields: the Week 0 contract, unchanged) -------------
    exists_on_pypi: bool
    github_repo_health: float | None = None
    similarity_score: float | None = None
    matched_package: str | None = None

    # --- Combined result ---------------------------------------------------
    final_score: int = Field(
        ...,
        ge=0,
        le=100,
        description="0 = safe, 100 = maximum risk.",
    )
    severity: Severity
    explanation: list[str] = Field(
        default_factory=list,
        description="Human-readable reasons behind the score, strongest first.",
    )
    signals: list[RiskSignal] = Field(
        default_factory=list,
        description="The same reasons, with rule ids and point values attached.",
    )

    # --- Detail / provenance -----------------------------------------------
    pypi_metadata: PyPIMetadata | None = None
    github: GitHubCheckResult | None = None
    similarity: SimilarityResult | None = None
    checked_at: datetime = Field(default_factory=_utcnow)
    duration_ms: int | None = None
