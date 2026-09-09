"""Endpoint tests for the dashboard API (/packages, /packages/{id}, /stats).

These are the Week 4 counterpart to ``test_api.py``: the JSON shape asserted
here is what the React dashboard is built against, so a change that breaks the
table or the detail view breaks a test rather than the demo.

No outbound HTTP is involved at all -- the dashboard only reads rows that
``POST /check`` already wrote -- so the whole file runs against in-memory
SQLite with the session dependency overridden.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from fastapi.testclient import TestClient

from app.db.models import CheckResultRecord
from app.db.session import session_dependency
from app.main import app


def _record(
    name: str,
    *,
    score: int,
    severity: str,
    status: str = "open",
    exists: bool = True,
    matched: str | None = None,
    days_ago: int = 0,
) -> CheckResultRecord:
    """A stored check row, shaped exactly as ``record_from_report`` writes one."""
    return CheckResultRecord(
        package_name=name,
        normalized_name=name.lower().replace("_", "-"),
        ecosystem="pypi",
        final_score=score,
        severity=severity,
        status=status,
        explanation=[f"{name}: first reason", f"{name}: second reason"],
        signals=[
            {"rule_id": "typosquat_distance_1", "points": score, "message": "why"}
        ],
        exists_on_pypi=exists,
        latest_version="1.0.0" if exists else None,
        similarity_score=0.85 if matched else None,
        matched_package=matched,
        edit_distance=1 if matched else None,
        github_status="ok",
        github_repo="psf/requests",
        github_repo_health=0.9,
        github_stars=54000,
        github_archived=False,
        pypi_metadata={"name": name, "latest_version": "1.0.0"},
        github_detail={"status": "ok", "repo_full_name": "psf/requests"},
        similarity_detail={"is_typosquat_suspect": bool(matched)},
        duration_ms=37,
        checked_at=datetime.now(timezone.utc) - timedelta(days=days_ago),
    )


#: The fixture corpus. Deliberately mixed across severity, status, existence
#: and age so every filter has both matching and non-matching rows to prove
#: itself against -- a filter tested on rows that all match proves nothing.
CORPUS = [
    ("requests", dict(score=0, severity="safe")),
    ("urllib3", dict(score=0, severity="safe")),
    (
        "reqeusts",
        dict(score=100, severity="high_risk", exists=False, matched="requests"),
    ),
    ("urllib4", dict(score=75, severity="high_risk", matched="urllib3")),
    ("some-obscure-lib", dict(score=35, severity="caution")),
    ("old-caution", dict(score=25, severity="caution", status="ignored", days_ago=30)),
    ("done-pkg", dict(score=80, severity="high_risk", status="resolved", days_ago=2)),
]


@pytest_asyncio.fixture
async def seeded(db_sessionmaker, monkeypatch):
    """A client whose session dependency points at a seeded SQLite database."""
    monkeypatch.setattr("app.config.settings.persistence_enabled", True)

    async with db_sessionmaker() as session:
        for name, kwargs in CORPUS:
            session.add(_record(name, **kwargs))
        await session.commit()

    async def _override():
        async with db_sessionmaker() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    app.dependency_overrides[session_dependency] = _override
    try:
        # No lifespan: the dashboard path must not need the HTTP pool, and
        # starting it here would try to reach a real Postgres.
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(session_dependency, None)


# --- GET /packages ----------------------------------------------------------


def test_list_returns_every_stored_check(seeded):
    body = seeded.get("/packages").json()

    assert body["total"] == len(CORPUS)
    assert len(body["items"]) == len(CORPUS)
    assert body["limit"] == 50
    assert body["offset"] == 0


def test_list_is_newest_first(seeded):
    items = seeded.get("/packages").json()["items"]
    timestamps = [item["checked_at"] for item in items]

    assert timestamps == sorted(timestamps, reverse=True)


def test_list_row_carries_the_top_reason(seeded):
    items = seeded.get("/packages").json()["items"]
    row = next(item for item in items if item["package_name"] == "reqeusts")

    # The table shows one line of "why" per row -- the strongest one, which the
    # engine puts first.
    assert row["top_reason"] == "reqeusts: first reason"


def test_list_rows_omit_the_detail_objects(seeded):
    """The table never renders them, so they must not be on the wire."""
    row = seeded.get("/packages").json()["items"][0]

    assert "signals" not in row
    assert "pypi_metadata" not in row
    assert "github_detail" not in row


@pytest.mark.parametrize(
    ("severity", "expected"),
    [
        ("safe", {"requests", "urllib3"}),
        ("caution", {"some-obscure-lib", "old-caution"}),
        ("high_risk", {"reqeusts", "urllib4", "done-pkg"}),
    ],
)
def test_filter_by_severity(seeded, severity, expected):
    body = seeded.get("/packages", params={"severity": severity}).json()

    assert {item["package_name"] for item in body["items"]} == expected
    assert body["total"] == len(expected)


def test_filter_by_review_status(seeded):
    body = seeded.get("/packages", params={"status": "ignored"}).json()

    assert [item["package_name"] for item in body["items"]] == ["old-caution"]


def test_filter_by_minimum_score(seeded):
    body = seeded.get("/packages", params={"min_score": 75}).json()

    assert {item["package_name"] for item in body["items"]} == {
        "reqeusts",
        "urllib4",
        "done-pkg",
    }


def test_search_is_a_substring_match(seeded):
    body = seeded.get("/packages", params={"search": "urllib"}).json()

    assert {item["package_name"] for item in body["items"]} == {"urllib3", "urllib4"}


def test_search_normalises_the_query(seeded):
    """A dashboard search for 'Requests' must find the row stored as 'requests'."""
    body = seeded.get("/packages", params={"search": "REQUESTS"}).json()

    assert {item["package_name"] for item in body["items"]} == {"requests"}


def test_search_does_not_match_a_transposed_name(seeded):
    """Substring search is not fuzzy: 'reqeusts' is found by typing it, not by
    typing 'requests'. Catching the typosquat is the similarity engine's job,
    and conflating the two here would make the filter unpredictable."""
    body = seeded.get("/packages", params={"search": "reqeu"}).json()

    assert {item["package_name"] for item in body["items"]} == {"reqeusts"}


def test_exact_package_filter_does_not_match_the_typosquat(seeded):
    body = seeded.get("/packages", params={"package_name": "requests"}).json()

    assert [item["package_name"] for item in body["items"]] == ["requests"]


def test_filters_combine(seeded):
    body = seeded.get(
        "/packages", params={"severity": "high_risk", "status": "open"}
    ).json()

    assert {item["package_name"] for item in body["items"]} == {"reqeusts", "urllib4"}


def test_total_counts_all_matches_not_just_this_page(seeded):
    """Otherwise the paginator cannot say '1-2 of 7' from a single request."""
    body = seeded.get("/packages", params={"limit": 2}).json()

    assert len(body["items"]) == 2
    assert body["total"] == len(CORPUS)


def test_pagination_walks_the_whole_set_without_repeats(seeded):
    seen: list[str] = []
    for offset in range(0, len(CORPUS), 2):
        page = seeded.get("/packages", params={"limit": 2, "offset": offset}).json()
        seen.extend(item["package_name"] for item in page["items"])

    assert sorted(seen) == sorted(name for name, _ in CORPUS)


def test_rejects_an_out_of_range_limit(seeded):
    assert seeded.get("/packages", params={"limit": 5000}).status_code == 422


def test_rejects_an_unknown_severity(seeded):
    assert seeded.get("/packages", params={"severity": "spicy"}).status_code == 422


# --- GET /packages/{id} -----------------------------------------------------


def test_detail_returns_the_full_stored_report(seeded):
    listed = seeded.get("/packages", params={"package_name": "reqeusts"}).json()
    result_id = listed["items"][0]["id"]

    body = seeded.get(f"/packages/{result_id}").json()

    assert body["package_name"] == "reqeusts"
    assert body["exists_on_pypi"] is False
    assert body["matched_package"] == "requests"
    assert body["explanation"] == ["reqeusts: first reason", "reqeusts: second reason"]
    assert body["signals"][0]["rule_id"] == "typosquat_distance_1"
    assert body["pypi_metadata"]["name"] == "reqeusts"
    assert body["github_detail"]["repo_full_name"] == "psf/requests"


def test_detail_of_a_missing_id_is_404(seeded):
    assert seeded.get("/packages/999999").status_code == 404


def test_detail_of_a_non_numeric_id_is_422(seeded):
    assert seeded.get("/packages/not-an-id").status_code == 422


# --- PATCH /packages/{id} ---------------------------------------------------


def test_status_can_be_moved_to_ignored(seeded):
    listed = seeded.get("/packages", params={"package_name": "urllib4"}).json()
    result_id = listed["items"][0]["id"]

    body = seeded.patch(f"/packages/{result_id}", json={"status": "ignored"}).json()

    assert body["status"] == "ignored"
    assert seeded.get(f"/packages/{result_id}").json()["status"] == "ignored"


def test_triage_never_edits_the_verdict(seeded):
    """The score is the engine's output; a reviewer's opinion sits beside it."""
    row = seeded.get("/packages", params={"package_name": "urllib4"}).json()["items"][0]
    result_id = row["id"]

    patched = seeded.patch(
        f"/packages/{result_id}", json={"status": "resolved"}
    ).json()

    assert patched["final_score"] == row["final_score"]
    assert patched["severity"] == row["severity"]


def test_status_must_be_one_of_the_three(seeded):
    result_id = seeded.get("/packages").json()["items"][0]["id"]

    response = seeded.patch(f"/packages/{result_id}", json={"status": "maybe"})

    assert response.status_code == 422


def test_patching_a_missing_id_is_404(seeded):
    assert seeded.patch("/packages/999999", json={"status": "open"}).status_code == 404


# --- GET /stats -------------------------------------------------------------


def test_stats_counts_the_corpus(seeded):
    body = seeded.get("/stats").json()

    assert body["total_checks"] == len(CORPUS)
    assert body["unique_packages"] == len(CORPUS)
    assert body["by_severity"] == {"safe": 2, "caution": 2, "high_risk": 3}


def test_stats_open_flags_excludes_safe_and_triaged(seeded):
    """The review queue is 'not safe, and nobody has dealt with it yet'."""
    body = seeded.get("/stats").json()

    # reqeusts + urllib4 + some-obscure-lib; old-caution is ignored,
    # done-pkg is resolved, and the two safe rows were never a flag.
    assert body["open_flags"] == 3


def test_stats_recent_window_excludes_older_checks(seeded):
    body = seeded.get("/stats").json()

    assert body["checks_last_7_days"] == len(CORPUS) - 1  # old-caution is 30d old


def test_stats_counts_hallucinations_and_typosquats(seeded):
    body = seeded.get("/stats").json()

    assert body["hallucinated_count"] == 1  # reqeusts is not on PyPI
    assert body["typosquat_count"] == 2  # reqeusts + urllib4


def test_stats_on_an_empty_database(db_sessionmaker, monkeypatch):
    """A fresh install must render zeroes, not a 500."""
    monkeypatch.setattr("app.config.settings.persistence_enabled", True)

    async def _override():
        async with db_sessionmaker() as session:
            yield session

    app.dependency_overrides[session_dependency] = _override
    try:
        body = TestClient(app).get("/stats").json()
    finally:
        app.dependency_overrides.pop(session_dependency, None)

    assert body["total_checks"] == 0
    assert body["by_severity"] == {"safe": 0, "caution": 0, "high_risk": 0}
    assert body["latest_check_at"] is None


# --- Persistence disabled ---------------------------------------------------


@pytest.mark.parametrize("path", ["/packages", "/packages/1", "/stats"])
def test_dashboard_is_503_when_history_is_off(path):
    """Better than an empty list, which reads as 'nothing has been checked'."""
    # persistence_enabled is already False via the autouse fixture.
    assert TestClient(app).get(path).status_code == 503
