"""Tests for Postgres persistence of check results.

Run against in-memory SQLite through the same models and the same DDL path, so
the schema is exercised without a database container. The Postgres-specific
part -- ``JSONB`` -- is declared as a dialect variant precisely so this works.

What the Week 4 dashboard needs from this layer is that a check is durable and
that history can be listed and filtered, so those are what is asserted.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.db.models import CheckResultRecord
from app.db.repository import (
    get_check_result,
    list_check_results,
    record_from_report,
    save_check_result,
)
from app.schemas.risk import (
    GitHubCheckResult,
    GitHubRepoInfo,
    GitHubRepoStatus,
    PyPICheckResult,
    PyPIMetadata,
    RiskReport,
    Severity,
    SimilarityResult,
)
from app.services.pipeline import build_report


def _report(
    name: str = "reqeusts",
    severity: Severity = Severity.HIGH_RISK,
    checked_at: datetime | None = None,
) -> RiskReport:
    """A full report with every check populated, as the pipeline produces."""
    pypi = PyPICheckResult(
        exists=True,
        metadata=PyPIMetadata(
            name=name,
            summary="A library",
            latest_version="0.0.1",
            version_count=1,
            first_release_date=datetime(2026, 8, 1, tzinfo=timezone.utc),
            project_urls={"Source": "https://github.com/psf/requests"},
        ),
    )
    github = GitHubCheckResult(
        status=GitHubRepoStatus.OK,
        source_url="https://github.com/psf/requests",
        repo_full_name="psf/requests",
        repo=GitHubRepoInfo(
            full_name="psf/requests",
            html_url="https://github.com/psf/requests",
            stars=51000,
            archived=False,
            pushed_at=datetime(2026, 8, 20, tzinfo=timezone.utc),
        ),
        days_since_last_commit=5,
        matches_package=False,
        match_reason="No obvious connection.",
        health_score=0.8,
    )
    similarity = SimilarityResult(
        is_typosquat_suspect=True,
        nearest_package="requests",
        edit_distance=2,
        similarity_score=0.75,
    )
    report = build_report(
        package_name=name,
        pypi=pypi,
        github=github,
        similarity=similarity,
        duration_ms=42,
    )
    if checked_at is not None:
        report.checked_at = checked_at
    return report


# --- Mapping ----------------------------------------------------------------


def test_report_is_flattened_onto_the_row():
    record = record_from_report(_report())

    assert record.package_name == "reqeusts"
    assert record.normalized_name == "reqeusts"
    assert record.ecosystem == "pypi"
    assert record.exists_on_pypi is True
    assert record.latest_version == "0.0.1"
    assert record.severity == Severity.HIGH_RISK.value
    assert record.final_score > 0
    assert record.matched_package == "requests"
    assert record.edit_distance == 2
    assert record.github_repo == "psf/requests"
    assert record.github_stars == 51000
    assert record.github_archived is False
    assert record.github_repo_health == 0.8
    assert record.duration_ms == 42


def test_the_explanation_is_stored_not_just_the_score():
    """A scoring change must be evaluable against what was actually said."""
    record = record_from_report(_report())
    assert record.explanation, "the human-readable reasons must be persisted"
    assert record.signals
    assert all({"rule_id", "points", "message"} <= set(s) for s in record.signals)


def test_the_normalized_name_is_stored_for_lookups():
    record = record_from_report(_report(name="Requests"))
    assert record.package_name == "Requests"
    assert record.normalized_name == "requests"


def test_a_report_with_no_github_check_still_maps():
    report = build_report(
        package_name="made-up-pkg",
        pypi=PyPICheckResult(exists=False),
        similarity=SimilarityResult(),
    )
    record = record_from_report(report)
    assert record.exists_on_pypi is False
    assert record.github_status is None
    assert record.github_stars is None
    assert record.final_score == 100


# --- Round trip -------------------------------------------------------------


async def test_a_result_survives_a_round_trip(db_sessionmaker):
    async with db_sessionmaker() as session:
        session.add(record_from_report(_report()))
        await session.commit()

    async with db_sessionmaker() as session:
        stored = await get_check_result(session, 1)

    assert stored is not None
    assert stored.package_name == "reqeusts"
    assert stored.severity == "high_risk"
    # The JSON columns must come back as structured data, not as strings.
    assert isinstance(stored.explanation, list)
    assert isinstance(stored.signals, list)
    assert isinstance(stored.pypi_metadata, dict)


async def test_history_lists_newest_first(db_sessionmaker):
    now = datetime.now(timezone.utc)
    async with db_sessionmaker() as session:
        for days_ago in (5, 1, 3):
            session.add(
                record_from_report(_report(checked_at=now - timedelta(days=days_ago)))
            )
        await session.commit()

    async with db_sessionmaker() as session:
        rows = await list_check_results(session)

    assert len(rows) == 3
    timestamps = [row.checked_at for row in rows]
    assert timestamps == sorted(timestamps, reverse=True)


async def test_history_can_be_filtered_by_package(db_sessionmaker):
    async with db_sessionmaker() as session:
        session.add(record_from_report(_report(name="reqeusts")))
        session.add(record_from_report(_report(name="requests")))
        await session.commit()

    async with db_sessionmaker() as session:
        rows = await list_check_results(session, package_name="reqeusts")

    assert len(rows) == 1
    assert rows[0].package_name == "reqeusts"


async def test_package_filter_is_case_insensitive(db_sessionmaker):
    """A dashboard search for Requests must find rows stored as requests."""
    async with db_sessionmaker() as session:
        session.add(record_from_report(_report(name="Requests")))
        await session.commit()

    async with db_sessionmaker() as session:
        rows = await list_check_results(session, package_name="REQUESTS")

    assert len(rows) == 1


async def test_history_can_be_filtered_by_severity(db_sessionmaker):
    async with db_sessionmaker() as session:
        session.add(record_from_report(_report()))
        session.add(
            record_from_report(
                build_report(
                    package_name="requests",
                    pypi=PyPICheckResult(
                        exists=True,
                        metadata=PyPIMetadata(name="requests", version_count=150),
                    ),
                    similarity=SimilarityResult(is_known_popular=True),
                )
            )
        )
        await session.commit()

    async with db_sessionmaker() as session:
        risky = await list_check_results(session, severity="high_risk")
        safe = await list_check_results(session, severity="safe")

    assert len(risky) == 1 and risky[0].package_name == "reqeusts"
    assert len(safe) == 1 and safe[0].package_name == "requests"


async def test_listing_is_paginated(db_sessionmaker):
    async with db_sessionmaker() as session:
        now = datetime.now(timezone.utc)
        for index in range(5):
            session.add(
                record_from_report(_report(checked_at=now - timedelta(minutes=index)))
            )
        await session.commit()

    async with db_sessionmaker() as session:
        page_one = await list_check_results(session, limit=2)
        page_two = await list_check_results(session, limit=2, offset=2)

    assert len(page_one) == 2 and len(page_two) == 2
    assert {row.id for row in page_one}.isdisjoint({row.id for row in page_two})


async def test_limit_is_capped_so_one_request_cannot_dump_the_table(db_sessionmaker):
    async with db_sessionmaker() as session:
        session.add(record_from_report(_report()))
        await session.commit()

    async with db_sessionmaker() as session:
        # Must not raise, and must not honour an unbounded limit.
        rows = await list_check_results(session, limit=10_000)

    assert len(rows) == 1


# --- Failure handling -------------------------------------------------------


async def test_a_database_outage_does_not_fail_the_check(monkeypatch):
    """Losing history is acceptable; refusing to warn a developer is not."""
    monkeypatch.setattr("app.config.settings.persistence_enabled", True)
    monkeypatch.setattr(
        "app.config.settings.database_url",
        "postgresql+asyncpg://nobody:nobody@127.0.0.1:1/nothing",
    )

    from app.db import session as session_module

    session_module.reset_engine_for_tests()
    try:
        assert await save_check_result(_report()) is None
    finally:
        session_module.reset_engine_for_tests()


async def test_persistence_can_be_switched_off(monkeypatch):
    monkeypatch.setattr("app.config.settings.persistence_enabled", False)
    assert await save_check_result(_report()) is None


# --- Schema -----------------------------------------------------------------


def test_dashboard_query_columns_are_indexed():
    """The Week 4 views are 'recent checks' and 'this package's history'."""
    index_columns = {
        tuple(column.name for column in index.columns)
        for index in CheckResultRecord.__table__.indexes
    }
    assert ("checked_at",) in index_columns
    assert ("normalized_name", "checked_at") in index_columns
    assert ("severity",) in index_columns


def test_json_columns_use_jsonb_on_postgres():
    from sqlalchemy.dialects import postgresql

    column = CheckResultRecord.__table__.c.explanation
    compiled = column.type.compile(dialect=postgresql.dialect())
    assert compiled == "JSONB"
