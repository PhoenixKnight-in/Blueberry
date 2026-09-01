"""Reads and writes for persisted check results.

The query helpers here are what the Week 4 dashboard endpoints will call, so
the pagination and filtering the UI needs (by package, by severity, newest
first) is settled at the persistence layer rather than being reinvented in a
router later.
"""

from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..schemas.risk import RiskReport
from ..security.validation import canonicalize_package_name
from .models import CheckResultRecord
from .session import get_session

logger = logging.getLogger(__name__)

__all__ = [
    "record_from_report",
    "save_check_result",
    "get_check_result",
    "list_check_results",
]


def record_from_report(report: RiskReport) -> CheckResultRecord:
    """Flatten a :class:`RiskReport` into a database row.

    Kept as a standalone function so it can be unit-tested without a database
    and reused by any future bulk-import path.
    """
    github = report.github
    repo = github.repo if github else None
    similarity = report.similarity

    return CheckResultRecord(
        package_name=report.package_name,
        normalized_name=report.normalized_name
        or canonicalize_package_name(report.package_name),
        ecosystem=report.ecosystem,
        final_score=report.final_score,
        severity=report.severity.value,
        explanation=list(report.explanation),
        signals=[signal.model_dump() for signal in report.signals],
        exists_on_pypi=report.exists_on_pypi,
        latest_version=(
            report.pypi_metadata.latest_version if report.pypi_metadata else None
        ),
        similarity_score=report.similarity_score,
        matched_package=report.matched_package,
        edit_distance=similarity.edit_distance if similarity else None,
        github_status=github.status.value if github else None,
        github_repo=github.repo_full_name if github else None,
        github_repo_health=report.github_repo_health,
        github_stars=repo.stars if repo else None,
        github_archived=repo.archived if repo else None,
        github_last_commit=repo.pushed_at if repo else None,
        pypi_metadata=(
            report.pypi_metadata.model_dump(mode="json")
            if report.pypi_metadata
            else None
        ),
        github_detail=github.model_dump(mode="json") if github else None,
        similarity_detail=similarity.model_dump(mode="json") if similarity else None,
        duration_ms=report.duration_ms,
        checked_at=report.checked_at,
    )


async def save_check_result(report: RiskReport) -> int | None:
    """Persist a report. Returns the new row id, or ``None`` if not stored.

    Best effort by design: a database problem is logged and swallowed, because
    the developer waiting on an inline warning should still get their answer.
    The warning in the log is the signal that history is being lost.
    """
    if not settings.persistence_enabled:
        return None

    record = record_from_report(report)
    try:
        async with get_session() as session:
            session.add(record)
            await session.flush()
            return record.id
    except (SQLAlchemyError, OSError) as exc:
        logger.warning(
            "Could not persist the check result for %r: %s",
            report.package_name,
            exc,
        )
        return None


async def get_check_result(
    session: AsyncSession,
    result_id: int,
) -> CheckResultRecord | None:
    """Fetch one stored result by id (the future ``GET /packages/{id}``)."""
    return await session.get(CheckResultRecord, result_id)


async def list_check_results(
    session: AsyncSession,
    *,
    package_name: str | None = None,
    severity: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> list[CheckResultRecord]:
    """List stored results, newest first (the future ``GET /packages``).

    Filters are applied on the normalised name so a dashboard search for
    ``Requests`` finds rows recorded as ``requests``.
    """
    statement = select(CheckResultRecord).order_by(CheckResultRecord.checked_at.desc())

    if package_name:
        statement = statement.where(
            CheckResultRecord.normalized_name == canonicalize_package_name(package_name)
        )
    if severity:
        statement = statement.where(CheckResultRecord.severity == severity)

    statement = statement.limit(max(1, min(limit, 500))).offset(max(0, offset))

    result = await session.execute(statement)
    return list(result.scalars().all())
