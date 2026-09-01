"""Tests for the rule-based risk engine.

Every test here builds check results by hand -- no HTTP, no mocks, no async.
That is the payoff of keeping scoring in its own module: the weights can be
swept against real package profiles in a fast, deterministic suite, which is
what makes the weights tunable in practice rather than only in principle.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.config import RiskThresholds, RiskWeights
from app.schemas.risk import (
    GitHubCheckResult,
    GitHubRepoInfo,
    GitHubRepoStatus,
    PyPICheckResult,
    PyPIMetadata,
    Severity,
    SimilarityMatch,
    SimilarityResult,
)
from app.services import risk_engine


def _days_ago(days: int) -> datetime:
    return datetime.now(timezone.utc) - timedelta(days=days)


def _metadata(**overrides) -> PyPIMetadata:
    defaults = dict(
        name="requests",
        summary="Python HTTP for Humans.",
        latest_version="2.31.0",
        version_count=150,
        first_release_date=_days_ago(4000),
        latest_release_date=_days_ago(30),
        author="Kenneth Reitz",
        maintainer=None,
        home_page="https://requests.readthedocs.io",
        project_urls={"Source": "https://github.com/psf/requests"},
    )
    defaults.update(overrides)
    return PyPIMetadata(**defaults)


def _healthy_github(**overrides) -> GitHubCheckResult:
    repo_defaults = dict(
        full_name="psf/requests",
        html_url="https://github.com/psf/requests",
        description="A simple, yet elegant, HTTP library.",
        stars=51000,
        forks=9000,
        archived=False,
        disabled=False,
        is_fork=False,
        created_at=_days_ago(4000),
        pushed_at=_days_ago(5),
    )
    repo_defaults.update(overrides.pop("repo", {}))
    result_defaults = dict(
        status=GitHubRepoStatus.OK,
        source_url="https://github.com/psf/requests",
        repo_full_name=repo_defaults["full_name"],
        repo=GitHubRepoInfo(**repo_defaults),
        days_since_last_commit=5,
        matches_package=True,
        match_reason="Repository name matches the package name (psf/requests).",
        health_score=1.0,
    )
    result_defaults.update(overrides)
    return GitHubCheckResult(**result_defaults)


def _squat(target: str = "requests", distance: int = 1) -> SimilarityResult:
    similarity = round(1 - distance / len(target), 4)
    return SimilarityResult(
        is_typosquat_suspect=True,
        nearest_package=target,
        edit_distance=distance,
        similarity_score=similarity,
        matches=[
            SimilarityMatch(package=target, distance=distance, similarity=similarity)
        ],
    )


# --- The dominant rule: not in the registry --------------------------------


def test_hallucinated_package_scores_maximum():
    result = risk_engine.assess(
        "totally-made-up-pkg",
        PyPICheckResult(exists=False),
        similarity=SimilarityResult(),
    )
    assert result.final_score == 100
    assert result.severity is Severity.HIGH_RISK
    assert any("not found on PyPI" in line for line in result.explanation)
    assert any("hallucinated" in line for line in result.explanation)


def test_missing_package_still_reports_the_likely_intended_one():
    """The most useful thing to say about a hallucinated name.

    'Does not exist, and the closest real package is requests' is what lets a
    developer fix the suggestion instead of just discarding the warning.
    """
    result = risk_engine.assess(
        "reqeusts",
        PyPICheckResult(exists=False),
        similarity=_squat("requests", distance=2),
    )
    assert result.final_score == 100
    assert any("requests" in line for line in result.explanation)


def test_missing_package_skips_repository_rules():
    """No metadata means no repository -- those rules must not double-count."""
    result = risk_engine.assess("nope-xyz", PyPICheckResult(exists=False))
    rule_ids = {signal.rule_id for signal in result.signals}
    assert rule_ids == {"package_not_on_pypi"}


# --- The happy path ---------------------------------------------------------


def test_healthy_package_is_safe_and_explains_why():
    result = risk_engine.assess(
        "requests",
        PyPICheckResult(exists=True, metadata=_metadata()),
        github=_healthy_github(),
        similarity=SimilarityResult(is_known_popular=True, similarity_score=1.0),
    )
    assert result.severity is Severity.SAFE
    assert result.final_score == 0  # clamped up from the mitigating -10
    assert any("actively maintained" in line for line in result.explanation)


def test_score_never_goes_below_zero():
    """Mitigating weights must not let a package earn negative risk."""
    result = risk_engine.assess(
        "requests",
        PyPICheckResult(exists=True, metadata=_metadata()),
        github=_healthy_github(),
    )
    assert result.final_score >= 0


# --- Typosquatting ----------------------------------------------------------


def test_one_edit_typosquat_is_high_risk_even_though_it_exists():
    """The package is real -- that is precisely what makes it dangerous."""
    result = risk_engine.assess(
        "reqeusts",
        PyPICheckResult(exists=True, metadata=_metadata(name="reqeusts")),
        github=_healthy_github(),
        similarity=_squat("requests", distance=1),
    )
    assert result.severity is Severity.HIGH_RISK
    assert result.final_score >= 60
    assert any("single character away" in line for line in result.explanation)


def test_repository_health_cannot_discount_a_typosquat():
    """A squatter can just point their listing at the victim's repository.

    Repository health is evidence about maintenance, not about whether the name
    impersonates another package -- so the mitigating rule must not fire here,
    or the check would soften exactly the case it exists to catch.
    """
    result = risk_engine.assess(
        "reqeusts",
        PyPICheckResult(exists=True, metadata=_metadata()),
        github=_healthy_github(),  # 51k stars, pushed 5 days ago
        similarity=_squat("requests", distance=1),
    )
    rule_ids = {s.rule_id for s in result.signals}
    assert "well_established_repository" not in rule_ids
    assert result.severity is Severity.HIGH_RISK


def test_two_edit_typosquat_is_caution_not_high_risk():
    result = risk_engine.assess(
        "reqeusts",
        PyPICheckResult(exists=True, metadata=_metadata()),
        github=_healthy_github(),
        similarity=_squat("requests", distance=2),
    )
    assert result.severity is Severity.CAUTION


# --- Repository health ------------------------------------------------------


def test_no_repository_link_adds_risk():
    result = risk_engine.assess(
        "some-lib",
        PyPICheckResult(exists=True, metadata=_metadata(project_urls={})),
        github=GitHubCheckResult(status=GitHubRepoStatus.NO_REPOSITORY_LINK),
    )
    assert "no_repository_link" in {s.rule_id for s in result.signals}
    assert result.final_score > 0


def test_broken_repository_link_outweighs_a_missing_one():
    """A link to a repo that is not there is worse than no link at all."""
    missing = risk_engine.assess(
        "lib",
        PyPICheckResult(exists=True, metadata=_metadata()),
        github=GitHubCheckResult(status=GitHubRepoStatus.NO_REPOSITORY_LINK),
    )
    broken = risk_engine.assess(
        "lib",
        PyPICheckResult(exists=True, metadata=_metadata()),
        github=GitHubCheckResult(
            status=GitHubRepoStatus.NOT_FOUND, repo_full_name="ghost/lib"
        ),
    )
    assert broken.final_score > missing.final_score


def test_archived_repository_is_flagged():
    result = risk_engine.assess(
        "requests",
        PyPICheckResult(exists=True, metadata=_metadata()),
        github=_healthy_github(repo={"archived": True}),
    )
    messages = " ".join(result.explanation)
    assert "archived" in messages
    assert "security fixes" in messages


def test_stale_repository_is_flagged_as_abandoned():
    result = risk_engine.assess(
        "requests",
        PyPICheckResult(exists=True, metadata=_metadata()),
        github=_healthy_github(
            repo={"pushed_at": _days_ago(900)}, days_since_last_commit=900
        ),
    )
    assert "repository_stale" in {s.rule_id for s in result.signals}


def test_aging_repository_scores_less_than_a_stale_one():
    aging = risk_engine.assess(
        "requests",
        PyPICheckResult(exists=True, metadata=_metadata()),
        github=_healthy_github(
            repo={"pushed_at": _days_ago(200), "stars": 100},
            days_since_last_commit=200,
        ),
    )
    stale = risk_engine.assess(
        "requests",
        PyPICheckResult(exists=True, metadata=_metadata()),
        github=_healthy_github(
            repo={"pushed_at": _days_ago(900), "stars": 100},
            days_since_last_commit=900,
        ),
    )
    assert aging.final_score < stale.final_score


def test_repository_that_does_not_match_the_package_is_flagged():
    """Borrowing a popular project's repo to look legitimate."""
    result = risk_engine.assess(
        "some-obscure-lib",
        PyPICheckResult(exists=True, metadata=_metadata()),
        github=_healthy_github(
            matches_package=False,
            match_reason="The linked repository (psf/requests) has no obvious "
            "connection to 'some-obscure-lib'.",
        ),
    )
    assert "repository_name_mismatch" in {s.rule_id for s in result.signals}


def test_archived_repository_does_not_also_get_the_stale_penalty():
    """Archived already says 'unmaintained'; stale would double-count it."""
    result = risk_engine.assess(
        "requests",
        PyPICheckResult(exists=True, metadata=_metadata()),
        github=_healthy_github(
            repo={"archived": True, "pushed_at": _days_ago(900)},
            days_since_last_commit=900,
        ),
    )
    rule_ids = {s.rule_id for s in result.signals}
    assert "repository_archived" in rule_ids
    assert "repository_stale" not in rule_ids


# --- Fail-closed behaviour --------------------------------------------------


def test_unreachable_github_scores_zero_points_and_says_so():
    """The single most important rule in this module.

    Scoring an unreachable GitHub as risky would flag half the ecosystem
    during an outage. Scoring it as healthy would hide real problems -- a false
    negative in a security tool is worse than no check at all, because the
    developer believes something was verified. So: no points, and say it.
    """
    result = risk_engine.assess(
        "requests",
        PyPICheckResult(exists=True, metadata=_metadata()),
        github=GitHubCheckResult(
            status=GitHubRepoStatus.UNAVAILABLE,
            rate_limited=True,
            detail="GitHub rate limit reached, so repository health could not "
            "be verified.",
        ),
    )
    unavailable = [s for s in result.signals if s.rule_id == "github_unavailable"]
    assert len(unavailable) == 1
    assert unavailable[0].points == 0
    assert "rate limit" in unavailable[0].message


def test_rate_limited_github_does_not_change_the_score():
    pypi = PyPICheckResult(exists=True, metadata=_metadata())
    without = risk_engine.assess("requests", pypi, github=None)
    degraded = risk_engine.assess(
        "requests",
        pypi,
        github=GitHubCheckResult(
            status=GitHubRepoStatus.UNAVAILABLE, rate_limited=True
        ),
    )
    assert without.final_score == degraded.final_score


# --- Registry trust signals -------------------------------------------------


def test_brand_new_single_release_package_accumulates_risk():
    result = risk_engine.assess(
        "brand-new-lib",
        PyPICheckResult(
            exists=True,
            metadata=_metadata(
                version_count=1,
                first_release_date=_days_ago(2),
                latest_release_date=_days_ago(2),
                author=None,
                maintainer=None,
                project_urls={},
            ),
        ),
        github=GitHubCheckResult(status=GitHubRepoStatus.NO_REPOSITORY_LINK),
    )
    rule_ids = {s.rule_id for s in result.signals}
    assert {"package_very_new", "single_release_only", "no_author_or_maintainer"} <= rule_ids
    assert result.severity is not Severity.SAFE


# --- Explainability ---------------------------------------------------------


def test_signals_sum_to_the_final_score():
    """The developer must be able to reconstruct the number by hand."""
    result = risk_engine.assess(
        "reqeusts",
        PyPICheckResult(exists=True, metadata=_metadata(version_count=1)),
        github=_healthy_github(repo={"stars": 3, "pushed_at": _days_ago(700)},
                               days_since_last_commit=700),
        similarity=_squat("requests", distance=1),
    )
    assert sum(s.points for s in result.signals) == result.final_score


def test_explanation_is_ordered_strongest_signal_first():
    """The inline warning often has room for exactly one line."""
    result = risk_engine.assess(
        "reqeusts",
        PyPICheckResult(exists=True, metadata=_metadata(version_count=1)),
        github=_healthy_github(repo={"stars": 0}),
        similarity=_squat("requests", distance=1),
    )
    points = [abs(s.points) for s in result.signals]
    assert points == sorted(points, reverse=True)
    assert "typosquat" in result.signals[0].rule_id


def test_every_signal_carries_a_human_readable_message():
    result = risk_engine.assess(
        "reqeusts",
        PyPICheckResult(exists=True, metadata=_metadata(version_count=1)),
        github=_healthy_github(repo={"stars": 0}),
        similarity=_squat("requests", distance=1),
    )
    for signal in result.signals:
        assert signal.message.strip()
        assert signal.rule_id
        # A rule id is a debugging handle, never the user-facing text.
        assert signal.message != signal.rule_id


def test_a_safe_package_still_gets_an_explanation():
    result = risk_engine.assess(
        "requests",
        PyPICheckResult(exists=True, metadata=_metadata()),
    )
    assert result.explanation, "an empty explanation tells the developer nothing"


# --- Tunability -------------------------------------------------------------


def test_weights_can_be_overridden_without_touching_a_checker():
    """The whole reason the engine is its own module."""
    pypi = PyPICheckResult(exists=True, metadata=_metadata())
    similarity = _squat("requests", distance=2)

    lenient = risk_engine.assess(
        "reqeusts", pypi, similarity=similarity,
        weights=RiskWeights(typosquat_distance_2=5),
    )
    strict = risk_engine.assess(
        "reqeusts", pypi, similarity=similarity,
        weights=RiskWeights(typosquat_distance_2=95),
    )

    assert lenient.severity is Severity.SAFE
    assert strict.severity is Severity.HIGH_RISK


def test_severity_thresholds_can_be_overridden():
    pypi = PyPICheckResult(exists=True, metadata=_metadata())
    similarity = _squat("requests", distance=2)  # 35 points by default

    default = risk_engine.assess("reqeusts", pypi, similarity=similarity)
    tightened = risk_engine.assess(
        "reqeusts", pypi, similarity=similarity,
        thresholds=RiskThresholds(caution_at=10, high_risk_at=30),
    )

    assert default.severity is Severity.CAUTION
    assert tightened.severity is Severity.HIGH_RISK


@pytest.mark.parametrize(
    ("score", "expected"),
    [
        (0, Severity.SAFE),
        (19, Severity.SAFE),
        (20, Severity.CAUTION),
        (59, Severity.CAUTION),
        (60, Severity.HIGH_RISK),
        (100, Severity.HIGH_RISK),
    ],
)
def test_severity_boundaries(score, expected):
    assert risk_engine.severity_for(score) is expected


def test_engine_performs_no_io():
    """A pure function of its inputs -- no client, no await, no network."""
    import inspect

    source = inspect.getsource(risk_engine)
    for forbidden in ("httpx", "async def", "await ", "requests.get"):
        assert forbidden not in source, f"the risk engine must not do I/O ({forbidden})"


def test_modern_metadata_attribution_is_recognised():
    """Packaging metadata 2.1+ puts the name in author_email, not author.

    Reading only ``author`` reported requests itself as anonymous, which would
    add noise to nearly every modern package's report.
    """
    result = risk_engine.assess(
        "requests",
        PyPICheckResult(
            exists=True,
            metadata=_metadata(
                author=None,
                author_email="Kenneth Reitz <me@kennethreitz.org>",
                maintainer=None,
            ),
        ),
    )
    assert "no_author_or_maintainer" not in {s.rule_id for s in result.signals}


def test_a_listing_with_no_attribution_at_all_is_still_flagged():
    result = risk_engine.assess(
        "anon-lib",
        PyPICheckResult(
            exists=True,
            metadata=_metadata(
                author=None, author_email=None, maintainer=None, maintainer_email=None
            ),
        ),
    )
    assert "no_author_or_maintainer" in {s.rule_id for s in result.signals}
