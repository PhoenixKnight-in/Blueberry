"""SQLAlchemy models for persisted check results.

One row per completed check. The row is intentionally denormalised -- flat
columns for everything the dashboard will filter or sort on, JSON blobs for the
detail it only renders -- because the query pattern is known and narrow: list
recent checks, filter by severity or name, open one.

JSON columns use ``JSONB`` on Postgres (indexable, binary) and fall back to
plain ``JSON`` elsewhere, which keeps the SQLite path usable for tests and
local runs without a database container.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    Index,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

#: JSONB where available, JSON everywhere else.
JSONVariant = JSON().with_variant(JSONB(), "postgresql")


class Base(DeclarativeBase):
    """Declarative base for all Blueberry tables."""


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class CheckResultRecord(Base):
    """A single package verification, exactly as it was reported."""

    __tablename__ = "check_results"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    # --- Identity -----------------------------------------------------------
    package_name: Mapped[str] = mapped_column(String(214), nullable=False)
    # PEP 503 form -- what lookups and grouping key on, so 'Requests' and
    # 'requests' are one package in the dashboard rather than two.
    normalized_name: Mapped[str] = mapped_column(String(214), nullable=False)
    ecosystem: Mapped[str] = mapped_column(String(32), nullable=False, default="pypi")

    # --- Verdict ------------------------------------------------------------
    final_score: Mapped[int] = mapped_column(Integer, nullable=False)
    severity: Mapped[str] = mapped_column(String(16), nullable=False)
    explanation: Mapped[list] = mapped_column(JSONVariant, nullable=False, default=list)
    signals: Mapped[list] = mapped_column(JSONVariant, nullable=False, default=list)

    # --- Individual check outcomes (flat, so the dashboard can filter) ------
    exists_on_pypi: Mapped[bool] = mapped_column(Boolean, nullable=False)
    latest_version: Mapped[str | None] = mapped_column(String(64), nullable=True)

    similarity_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    matched_package: Mapped[str | None] = mapped_column(String(214), nullable=True)
    edit_distance: Mapped[int | None] = mapped_column(Integer, nullable=True)

    github_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    github_repo: Mapped[str | None] = mapped_column(String(255), nullable=True)
    github_repo_health: Mapped[float | None] = mapped_column(Float, nullable=True)
    github_stars: Mapped[int | None] = mapped_column(Integer, nullable=True)
    github_archived: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    github_last_commit: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # --- Detail / provenance ------------------------------------------------
    pypi_metadata: Mapped[dict | None] = mapped_column(JSONVariant, nullable=True)
    github_detail: Mapped[dict | None] = mapped_column(JSONVariant, nullable=True)
    similarity_detail: Mapped[dict | None] = mapped_column(JSONVariant, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)

    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    checked_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        # The dashboard's two default views: "recent checks" and "this
        # package's history". Both are covered without a table scan.
        Index("ix_check_results_checked_at", "checked_at"),
        Index("ix_check_results_name_checked_at", "normalized_name", "checked_at"),
        Index("ix_check_results_severity", "severity"),
    )

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"<CheckResultRecord {self.package_name!r} "
            f"score={self.final_score} severity={self.severity}>"
        )
