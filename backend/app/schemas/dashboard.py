"""The dashboard contract: what ``GET /packages`` and ``GET /stats`` return.

Kept separate from :mod:`app.schemas.risk` because it describes a different
thing. ``RiskReport`` is the answer to "is this package safe?", computed live
and sent to the editor. The models here describe *stored history* -- rows that
already have an id, a review status, and a place in a paginated list -- which
is the only thing the dashboard ever reads.

The split matters for the flat list view: sending a full ``RiskReport`` per row
would ship three nested detail objects the table never renders, so the list
returns :class:`CheckSummary` and the detail view returns
:class:`CheckDetail`.
"""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum

from pydantic import BaseModel, Field, field_validator

from .risk import RiskSignal, Severity


def _as_utc(value: datetime | None) -> datetime | None:
    """Stamp UTC onto a naive timestamp.

    Postgres hands back timezone-aware datetimes, but SQLite -- which the tests
    and the local demo run on -- has no timezone type and returns them naive.
    Serialised without an offset, ``2026-09-09T17:24:29`` is read by the
    browser as *local* time, so the dashboard would show a check that just ran
    as hours old. Everything is stored in UTC, so saying so is the fix.
    """
    if value is not None and value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value

__all__ = [
    "FlagStatus",
    "CheckSummary",
    "CheckDetail",
    "CheckPage",
    "SeverityCount",
    "StatsResponse",
    "StatusUpdate",
]


class FlagStatus(str, Enum):
    """Where a flagged package sits in the review workflow.

    Straight from the design document's ``flagged_packages.status``. Every
    check starts ``open``; a reviewer moves it to ``ignored`` (a false positive
    or an accepted risk) or ``resolved`` (dealt with -- package removed or
    replaced).
    """

    OPEN = "open"
    IGNORED = "ignored"
    RESOLVED = "resolved"


class CheckSummary(BaseModel):
    """One row in the dashboard's flagged-package table."""

    model_config = {"from_attributes": True}

    id: int
    package_name: str
    normalized_name: str
    ecosystem: str

    final_score: int = Field(ge=0, le=100)
    severity: Severity
    status: FlagStatus

    exists_on_pypi: bool
    latest_version: str | None = None

    similarity_score: float | None = None
    matched_package: str | None = None
    edit_distance: int | None = None

    github_status: str | None = None
    github_repo: str | None = None
    github_repo_health: float | None = None
    github_stars: int | None = None
    github_archived: bool | None = None
    github_last_commit: datetime | None = None

    duration_ms: int | None = None
    checked_at: datetime

    # The table shows one line of "why" per row; the rest is behind the detail
    # view. Strongest-first ordering in the engine means [0] is the right one.
    top_reason: str | None = None

    @field_validator("checked_at", "github_last_commit")
    @classmethod
    def _stamp_utc(cls, value: datetime | None) -> datetime | None:
        return _as_utc(value)

    @classmethod
    def from_record(cls, record) -> "CheckSummary":
        """Build a summary from a :class:`CheckResultRecord`."""
        explanation = record.explanation or []
        return cls.model_validate(
            {
                **{
                    field: getattr(record, field)
                    for field in cls.model_fields
                    if field != "top_reason"
                },
                "top_reason": explanation[0] if explanation else None,
            }
        )


class CheckDetail(CheckSummary):
    """One stored check in full -- the dashboard's package detail view.

    Additive over :class:`CheckSummary`, so the table and the detail view share
    a single row component for everything they have in common.
    """

    explanation: list[str] = Field(default_factory=list)
    signals: list[RiskSignal] = Field(default_factory=list)

    pypi_metadata: dict | None = None
    github_detail: dict | None = None
    similarity_detail: dict | None = None
    error: str | None = None

    @classmethod
    def from_record(cls, record) -> "CheckDetail":
        """Build a detail view from a :class:`CheckResultRecord`."""
        summary = CheckSummary.from_record(record)
        return cls(
            **summary.model_dump(),
            explanation=list(record.explanation or []),
            signals=[RiskSignal(**signal) for signal in (record.signals or [])],
            pypi_metadata=record.pypi_metadata,
            github_detail=record.github_detail,
            similarity_detail=record.similarity_detail,
            error=record.error,
        )


class CheckPage(BaseModel):
    """A page of stored checks, plus enough context to render a paginator.

    ``total`` is the count *after* filtering, so the UI can say "showing 1-50
    of 231 high-risk results" without a second request.
    """

    items: list[CheckSummary]
    total: int
    limit: int
    offset: int

    @property
    def has_more(self) -> bool:
        return self.offset + len(self.items) < self.total


class SeverityCount(BaseModel):
    """How many stored checks landed in each severity band."""

    safe: int = 0
    caution: int = 0
    high_risk: int = 0


class StatsResponse(BaseModel):
    """The dashboard's summary strip.

    One request, because these numbers are read together and every one of them
    is a cheap aggregate over the same table.
    """

    total_checks: int = 0
    unique_packages: int = 0
    by_severity: SeverityCount = Field(default_factory=SeverityCount)
    open_flags: int = Field(
        default=0,
        description="Checks above 'safe' that nobody has ignored or resolved yet.",
    )
    checks_last_7_days: int = 0
    hallucinated_count: int = Field(
        default=0,
        description="Checks where the package did not exist on PyPI at all.",
    )
    typosquat_count: int = Field(
        default=0,
        description="Checks that matched a popular package name within the "
        "edit-distance threshold.",
    )
    latest_check_at: datetime | None = None

    @field_validator("latest_check_at")
    @classmethod
    def _stamp_utc(cls, value: datetime | None) -> datetime | None:
        return _as_utc(value)


class StatusUpdate(BaseModel):
    """Body of ``PATCH /packages/{id}`` -- a reviewer's triage decision."""

    status: FlagStatus
