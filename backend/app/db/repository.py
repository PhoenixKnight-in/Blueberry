"""Reads and writes for persisted check results.

The query helpers here are what the Week 4 dashboard endpoints will call, so
the pagination and filtering the UI needs (by package, by severity, newest
first) is settled at the persistence layer rather than being reinvented in a
router later.
"""

from __future__ import annotations

import logging

from datetime import datetime, timedelta, timezone

from sqlalchemy import distinct, func, select
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
    "count_check_results",
    "set_check_status",
    "collect_stats",
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


def _apply_filters(
    statement,
    *,
    package_name: str | None = None,
    severity: str | None = None,
    status: str | None = None,
    min_score: int | None = None,
    search: str | None = None,
):
    """Apply the dashboard's filters to a select over check results.

    Shared by the list and the count so a paginator can never report a total
    that was computed under different filters than the rows beside it.
    """
    if package_name:
        statement = statement.where(
            CheckResultRecord.normalized_name == canonicalize_package_name(package_name)
        )
    if severity:
        statement = statement.where(CheckResultRecord.severity == severity)
    if status:
        statement = statement.where(CheckResultRecord.status == status)
    if min_score is not None:
        statement = statement.where(CheckResultRecord.final_score >= min_score)
    if search:
        # Substring match on the normalised name: the dashboard search box is
        # a filter, not a lookup, so "req" should find "requests" and
        # "reqeusts" alike. Normalised on both sides so 'Requests' matches.
        pattern = f"%{canonicalize_package_name(search)}%"
        statement = statement.where(CheckResultRecord.normalized_name.like(pattern))
    return statement


async def list_check_results(
    session: AsyncSession,
    *,
    package_name: str | None = None,
    severity: str | None = None,
    status: str | None = None,
    min_score: int | None = None,
    search: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> list[CheckResultRecord]:
    """List stored results, newest first (``GET /packages``).

    Filters are applied on the normalised name so a dashboard search for
    ``Requests`` finds rows recorded as ``requests``.
    """
    statement = _apply_filters(
        select(CheckResultRecord),
        package_name=package_name,
        severity=severity,
        status=status,
        min_score=min_score,
        search=search,
    )
    # id descending as the tiebreaker: several checks can share a timestamp at
    # the resolution Postgres stores, and an unstable sort would let a row
    # appear on two pages of the same paginated read.
    statement = statement.order_by(
        CheckResultRecord.checked_at.desc(), CheckResultRecord.id.desc()
    )
    statement = statement.limit(max(1, min(limit, 500))).offset(max(0, offset))

    result = await session.execute(statement)
    return list(result.scalars().all())


async def count_check_results(
    session: AsyncSession,
    *,
    package_name: str | None = None,
    severity: str | None = None,
    status: str | None = None,
    min_score: int | None = None,
    search: str | None = None,
) -> int:
    """Count stored results under the same filters as :func:`list_check_results`."""
    statement = _apply_filters(
        select(func.count()).select_from(CheckResultRecord),
        package_name=package_name,
        severity=severity,
        status=status,
        min_score=min_score,
        search=search,
    )
    return int((await session.execute(statement)).scalar_one())


async def set_check_status(
    session: AsyncSession,
    result_id: int,
    status: str,
) -> CheckResultRecord | None:
    """Move one stored check through the review workflow.

    Returns the updated record, or ``None`` if no such row exists.
    """
    record = await session.get(CheckResultRecord, result_id)
    if record is None:
        return None
    record.status = status
    await session.flush()
    return record


async def collect_stats(session: AsyncSession) -> dict:
    """Aggregate the numbers behind the dashboard's summary strip.

    Deliberately a handful of aggregate queries rather than one giant one:
    each is independently readable, they all hit the same small table, and the
    dashboard asks for them once per page load, not per row.
    """
    total = int(
        (await session.execute(select(func.count()).select_from(CheckResultRecord)))
        .scalar_one()
    )

    unique = int(
        (
            await session.execute(
                select(func.count(distinct(CheckResultRecord.normalized_name)))
            )
        ).scalar_one()
    )

    severity_rows = (
        await session.execute(
            select(CheckResultRecord.severity, func.count())
            .group_by(CheckResultRecord.severity)
        )
    ).all()
    by_severity = {severity: int(count) for severity, count in severity_rows}

    open_flags = int(
        (
            await session.execute(
                select(func.count())
                .select_from(CheckResultRecord)
                .where(CheckResultRecord.status == "open")
                .where(CheckResultRecord.severity != "safe")
            )
        ).scalar_one()
    )

    since = datetime.now(timezone.utc) - timedelta(days=7)
    recent = int(
        (
            await session.execute(
                select(func.count())
                .select_from(CheckResultRecord)
                .where(CheckResultRecord.checked_at >= since)
            )
        ).scalar_one()
    )

    hallucinated = int(
        (
            await session.execute(
                select(func.count())
                .select_from(CheckResultRecord)
                .where(CheckResultRecord.exists_on_pypi.is_(False))
            )
        ).scalar_one()
    )

    typosquats = int(
        (
            await session.execute(
                select(func.count())
                .select_from(CheckResultRecord)
                .where(CheckResultRecord.matched_package.is_not(None))
            )
        ).scalar_one()
    )

    latest = (
        await session.execute(select(func.max(CheckResultRecord.checked_at)))
    ).scalar_one()

    return {
        "total_checks": total,
        "unique_packages": unique,
        "by_severity": {
            "safe": by_severity.get("safe", 0),
            "caution": by_severity.get("caution", 0),
            "high_risk": by_severity.get("high_risk", 0),
        },
        "open_flags": open_flags,
        "checks_last_7_days": recent,
        "hallucinated_count": hallucinated,
        "typosquat_count": typosquats,
        "latest_check_at": latest,
    }
