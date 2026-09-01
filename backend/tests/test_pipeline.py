"""Tests for the four-check pipeline.

The behaviour worth pinning down here is not "does it call things" but the
orchestration decisions: what runs concurrently, what is skipped, and what
happens when one check fails while the others succeed.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest
import respx

from app.config import settings
from app.schemas.risk import GitHubRepoStatus, Severity
from app.security.validation import InvalidPackageName
from app.services.pipeline import run_pipeline
from app.services.pypi_checker import PyPIServiceError

from .fixtures import (
    MISMATCHED_REPO_PAYLOAD,
    REQUESTS_PAYLOAD,
    SSRF_PROJECT_URLS_PAYLOAD,
    SUSPICIOUS_PAYLOAD,
    github_repo_payload,
)


def _pypi(name: str) -> str:
    return f"{settings.pypi_base_url}/{name}/json"


def _github(full_name: str) -> str:
    return f"{settings.github_api_url}/repos/{full_name}"


# --- The happy path ---------------------------------------------------------


@respx.mock
async def test_healthy_package_runs_all_four_checks():
    respx.get(_pypi("requests")).mock(
        return_value=httpx.Response(200, json=REQUESTS_PAYLOAD)
    )
    respx.get(_github("psf/requests")).mock(
        return_value=httpx.Response(200, json=github_repo_payload())
    )

    report = await run_pipeline("requests", use_cache=False)

    assert report.exists_on_pypi is True
    assert report.github is not None and report.github.status is GitHubRepoStatus.OK
    assert report.similarity is not None and report.similarity.is_known_popular
    assert report.severity is Severity.SAFE
    assert report.final_score == 0
    assert report.explanation
    assert report.duration_ms is not None


# --- Concurrency ------------------------------------------------------------


@respx.mock
async def test_pypi_and_similarity_run_concurrently(monkeypatch):
    """The independent checks overlap instead of queueing.

    This is the whole reason for choosing an async framework, so it is asserted
    directly: the similarity check must complete *while* the PyPI request is
    still in flight, not after it returns.
    """
    from app.services.similarity import check_similarity

    order: list[str] = []

    def recording_similarity(name):
        order.append("similarity")
        return check_similarity(name)

    monkeypatch.setattr(
        "app.services.pipeline.check_similarity", recording_similarity
    )

    async def slow_pypi(request):
        order.append("pypi:start")
        await asyncio.sleep(0.05)
        order.append("pypi:end")
        return httpx.Response(200, json=SUSPICIOUS_PAYLOAD)

    respx.get(_pypi("reqeusts")).mock(side_effect=slow_pypi)

    report = await run_pipeline("reqeusts", use_cache=False)

    # Sequential execution would give ["pypi:start", "pypi:end", "similarity"].
    assert order == ["pypi:start", "similarity", "pypi:end"]
    assert report.similarity is not None
    assert report.similarity.nearest_package == "requests"


@respx.mock
async def test_one_shared_http_client_serves_both_outbound_calls():
    """Connection pooling across PyPI and GitHub, not a client per call."""
    respx.get(_pypi("requests")).mock(
        return_value=httpx.Response(200, json=REQUESTS_PAYLOAD)
    )
    respx.get(_github("psf/requests")).mock(
        return_value=httpx.Response(200, json=github_repo_payload())
    )

    async with httpx.AsyncClient() as client:
        report = await run_pipeline("requests", client=client, use_cache=False)

        assert report.exists_on_pypi is True
        assert report.github is not None
        # Checked inside the block: a pipeline that closed a borrowed client
        # would break the next request served by the app-wide pool.
        assert not client.is_closed, "the pipeline must not close a borrowed client"


# --- Dependency ordering ----------------------------------------------------


@respx.mock
async def test_github_is_skipped_when_the_package_does_not_exist():
    """No metadata means no repository, and a saved rate-limit slot."""
    respx.get(_pypi("totally-made-up-pkg")).mock(return_value=httpx.Response(404))
    github_route = respx.get(url__regex=r".*api\.github\.com.*")

    report = await run_pipeline("totally-made-up-pkg", use_cache=False)

    assert github_route.call_count == 0
    assert report.exists_on_pypi is False
    assert report.github is None
    assert report.final_score == 100
    assert report.severity is Severity.HIGH_RISK


@respx.mock
async def test_a_hallucinated_name_still_reports_the_likely_intended_package():
    respx.get(_pypi("reqeusts")).mock(return_value=httpx.Response(404))

    report = await run_pipeline("reqeusts", use_cache=False)

    assert report.exists_on_pypi is False
    assert report.similarity is not None
    assert report.similarity.nearest_package == "requests"
    assert any("requests" in line for line in report.explanation)


# --- Failure isolation ------------------------------------------------------


@respx.mock
async def test_a_github_outage_does_not_stop_the_report():
    """Losing one signal degrades the report; it does not fail the request."""
    respx.get(_pypi("requests")).mock(
        return_value=httpx.Response(200, json=REQUESTS_PAYLOAD)
    )
    respx.get(_github("psf/requests")).mock(side_effect=httpx.ConnectError("down"))

    report = await run_pipeline("requests", use_cache=False)

    assert report.github is not None
    assert report.github.status is GitHubRepoStatus.UNAVAILABLE
    assert report.exists_on_pypi is True
    assert any("GitHub" in line for line in report.explanation)


@respx.mock
async def test_a_pypi_outage_fails_the_request(monkeypatch):
    """There is nothing honest to say about a package we could not look up."""
    respx.get(_pypi("requests")).mock(return_value=httpx.Response(503))

    with pytest.raises(PyPIServiceError):
        await run_pipeline("requests", use_cache=False)


async def test_validation_happens_before_any_network_call():
    with respx.mock:
        route = respx.get(url__regex=r".*")
        with pytest.raises(InvalidPackageName):
            await run_pipeline("../../etc/passwd", use_cache=False)
        assert route.call_count == 0


# --- Realistic end-to-end profiles ------------------------------------------


@respx.mock
async def test_a_typosquat_that_exists_is_high_risk():
    """The dangerous case: the package is real, which is the whole point."""
    respx.get(_pypi("reqeusts")).mock(
        return_value=httpx.Response(200, json=SUSPICIOUS_PAYLOAD)
    )

    report = await run_pipeline("reqeusts", use_cache=False)

    assert report.exists_on_pypi is True
    assert report.severity is Severity.HIGH_RISK
    assert report.matched_package == "requests"
    assert report.github is not None
    assert report.github.status is GitHubRepoStatus.NO_REPOSITORY_LINK


@respx.mock
async def test_a_package_borrowing_someone_elses_repo_is_flagged():
    respx.get(_pypi("some-obscure-lib")).mock(
        return_value=httpx.Response(200, json=MISMATCHED_REPO_PAYLOAD)
    )
    respx.get(_github("psf/requests")).mock(
        return_value=httpx.Response(200, json=github_repo_payload())
    )

    report = await run_pipeline("some-obscure-lib", use_cache=False)

    assert report.github is not None
    assert report.github.matches_package is False
    assert "repository_name_mismatch" in {s.rule_id for s in report.signals}
    assert report.severity is not Severity.SAFE


@respx.mock
async def test_hostile_project_urls_are_never_fetched():
    """An SSRF attempt planted in publisher-controlled metadata."""
    respx.get(_pypi("evil-pkg")).mock(
        return_value=httpx.Response(200, json=SSRF_PROJECT_URLS_PAYLOAD)
    )
    # Any request to anything other than PyPI is a failure.
    localhost = respx.get(url__regex=r".*(localhost|127\.0\.0\.1|169\.254).*")
    lookalike = respx.get(url__regex=r".*attacker\.example.*")

    report = await run_pipeline("evil-pkg", use_cache=False)

    assert localhost.call_count == 0
    assert lookalike.call_count == 0
    assert report.github is not None
    assert report.github.status is GitHubRepoStatus.NO_REPOSITORY_LINK


# --- The report contract ----------------------------------------------------


@respx.mock
async def test_flat_fields_stay_consistent_with_the_detail_objects():
    """The extension reads the flat fields; the dashboard reads the details."""
    respx.get(_pypi("requests")).mock(
        return_value=httpx.Response(200, json=REQUESTS_PAYLOAD)
    )
    respx.get(_github("psf/requests")).mock(
        return_value=httpx.Response(200, json=github_repo_payload())
    )

    report = await run_pipeline("requests", use_cache=False)

    assert report.github is not None and report.similarity is not None
    assert report.github_repo_health == report.github.health_score
    assert report.similarity_score == report.similarity.similarity_score
    assert report.explanation == [s.message for s in report.signals]


@respx.mock
async def test_matched_package_is_only_set_for_a_suspected_squat():
    """A popular package is not 'matched' against itself in the warning."""
    respx.get(_pypi("requests")).mock(
        return_value=httpx.Response(200, json=REQUESTS_PAYLOAD)
    )
    respx.get(_github("psf/requests")).mock(
        return_value=httpx.Response(200, json=github_repo_payload())
    )

    report = await run_pipeline("requests", use_cache=False)

    assert report.similarity is not None and report.similarity.is_known_popular
    assert report.matched_package is None


@respx.mock
async def test_the_name_is_normalized_on_the_report():
    respx.get(_pypi("Requests")).mock(
        return_value=httpx.Response(200, json=REQUESTS_PAYLOAD)
    )
    respx.get(_github("psf/requests")).mock(
        return_value=httpx.Response(200, json=github_repo_payload())
    )

    report = await run_pipeline("Requests", use_cache=False)

    assert report.package_name == "Requests"
    assert report.normalized_name == "requests"
