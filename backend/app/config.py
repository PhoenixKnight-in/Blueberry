"""Application configuration.

Everything environment-driven, prefixed ``BLUEBERRY_``, with an optional
``.env`` file. Two things deserve calling out:

* **The GitHub token is never hardcoded.** It is read from
  ``BLUEBERRY_GITHUB_TOKEN`` (or injected as a container secret) and lives only
  in :class:`Settings`. There is no default value, and ``.env`` is git-ignored.
* **The risk weights are configuration, not code.** Rule-based scoring is easy
  to get approximately right and hard to get exactly right, so the weights are
  tunable per-environment (``BLUEBERRY_RISK__TYPOSQUAT_DISTANCE_1=70``) and
  overridable in tests -- you can retune the engine against real package names
  without editing a single checker.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class RiskWeights(BaseModel):
    """Points each rule contributes to the final 0-100 risk score.

    Positive weights add risk; negative weights are mitigating evidence. The
    engine clamps the total to 0-100, so these do not need to sum to anything
    in particular -- they only need to be right *relative to each other*.
    """

    # --- Registry existence: the single strongest signal --------------------
    package_not_on_pypi: int = 100

    # --- Typosquatting ------------------------------------------------------
    typosquat_distance_1: int = 60
    typosquat_distance_2: int = 35

    # --- Repository linkage / health ---------------------------------------
    # No link is a passive weakness -- plenty of small, legitimate packages
    # have no GitHub -- so on its own it stays below the caution threshold.
    no_repository_link: int = 15
    # A link that goes nowhere, or to somebody else's project, is active
    # misdirection rather than an omission. Both are weighted to clear the
    # caution threshold (20) unaided, so either one raises a warning alone.
    repository_link_broken: int = 25
    repository_name_mismatch: int = 20
    repository_archived: int = 20
    repository_is_fork: int = 5
    repository_stale: int = 15
    repository_aging: int = 7
    repository_no_stars: int = 15
    repository_few_stars: int = 8

    # --- Registry trust signals --------------------------------------------
    package_very_new: int = 15
    single_release_only: int = 8
    no_author_or_maintainer: int = 5

    # --- Mitigating evidence ------------------------------------------------
    well_established_repository: int = -10


class RiskThresholds(BaseModel):
    """Score boundaries between the three severities the UI renders."""

    caution_at: int = Field(default=20, ge=0, le=100)
    high_risk_at: int = Field(default=60, ge=0, le=100)


class Settings(BaseSettings):
    """Runtime configuration for the verification backend."""

    app_name: str = "Blueberry AI Dependency Validator"
    app_version: str = "0.2.0"
    environment: str = "development"

    # --- Outbound HTTP ------------------------------------------------------
    pypi_base_url: str = "https://pypi.org/pypi"
    github_api_url: str = "https://api.github.com"
    http_timeout: float = 10.0

    # --- GitHub credentials & rate limiting ---------------------------------
    # Set BLUEBERRY_GITHUB_TOKEN in the environment (or a Docker/K8s secret).
    # Unauthenticated GitHub allows 60 requests/hour per IP; a token raises
    # that to 5000, which is the difference between a working checker and one
    # that silently returns "unknown" for every package under load.
    github_token: str | None = None
    github_max_attempts: int = 3
    github_backoff_base_seconds: float = 0.5
    # Hard ceiling on how long one request may wait on a retry. The primary
    # rate limit resets on the hour; a developer's editor cannot block that
    # long, so past this we give up and report the check as degraded rather
    # than pretending the repository is fine.
    github_max_backoff_seconds: float = 8.0

    # --- Repository health thresholds (days / stars) ------------------------
    repo_stale_after_days: int = 365
    repo_aging_after_days: int = 180
    repo_few_stars_below: int = 50
    repo_established_stars: int = 500
    package_new_within_days: int = 30

    # --- Similarity engine --------------------------------------------------
    similarity_max_distance: int = 2
    # Names of 4 characters or fewer are excluded from 2-edit matching: two
    # edits on "six" or "attrs" is most of the word, and everything short
    # would light up as a typosquat.
    similarity_short_name_length: int = 4

    # --- Redis cache --------------------------------------------------------
    redis_url: str = "redis://localhost:6379/0"
    cache_enabled: bool = True
    pypi_cache_ttl: int = 3600  # 1h -- registry metadata moves slowly.
    github_cache_ttl: int = 1800  # 30m -- stars/pushes move faster.
    # A 404 is cached far more briefly: a hallucinated name may be registered
    # by an attacker at any moment, and we must not keep calling it "missing".
    negative_cache_ttl: int = 300

    # --- Postgres persistence ------------------------------------------------
    database_url: str = "postgresql+asyncpg://blueberry:blueberry@localhost:5432/blueberry"
    database_echo: bool = False
    persistence_enabled: bool = True
    # Convenience for local dev / demos. Real deployments run Alembic.
    database_auto_create: bool = True

    # --- CORS ----------------------------------------------------------------
    # The dashboard is a separate origin (Vite dev server, or a static host),
    # so the browser will not call this API without an explicit allowlist. The
    # VS Code extension is unaffected -- it is not a browser and sends no
    # Origin header. Listed explicitly rather than "*" because the dashboard
    # will send state-changing PATCHes.
    cors_origins: list[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:4173",
        "http://127.0.0.1:4173",
    ]

    # --- Scoring (tunable without touching the checkers) --------------------
    risk: RiskWeights = Field(default_factory=RiskWeights)
    thresholds: RiskThresholds = Field(default_factory=RiskThresholds)

    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="BLUEBERRY_",
        env_nested_delimiter="__",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    """Return a cached Settings instance (FastAPI dependency-friendly)."""
    return Settings()


settings = get_settings()
