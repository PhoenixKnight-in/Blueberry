"""Tests for the GitHub checker.

All GitHub HTTP is mocked with ``respx``, so the suite is offline, fast, and --
importantly for a component whose whole job is surviving rate limits -- able to
reproduce a 403 quota exhaustion on demand.
"""

from __future__ import annotations

import httpx
import pytest
import respx

from app.config import settings
from app.schemas.risk import GitHubRepoStatus, PyPIMetadata
from app.services.github_checker import (
    _auth_headers,
    check_github,
    resolve_repository,
)

from .fixtures import github_repo_payload


def _api(full_name: str) -> str:
    return f"{settings.github_api_url}/repos/{full_name}"


def _metadata(**overrides) -> PyPIMetadata:
    defaults = dict(
        name="requests",
        project_urls={"Source": "https://github.com/psf/requests"},
        home_page="https://requests.readthedocs.io",
    )
    defaults.update(overrides)
    return PyPIMetadata(**defaults)


# --- Step 1: resolving the repo from PyPI metadata -------------------------


def test_source_url_is_preferred_over_homepage():
    ref, source = resolve_repository(
        _metadata(
            project_urls={
                "Homepage": "https://github.com/someone/docs-site",
                "Source": "https://github.com/psf/requests",
            }
        )
    )
    assert ref is not None
    assert ref.full_name == "psf/requests"
    assert source == "https://github.com/psf/requests"


@pytest.mark.parametrize("key", ["Source", "source", "Source Code", "Repository", "Code", "GitHub"])
def test_common_project_url_keys_are_recognised(key):
    ref, _ = resolve_repository(
        _metadata(project_urls={key: "https://github.com/psf/requests"})
    )
    assert ref is not None and ref.full_name == "psf/requests"


def test_home_page_is_the_last_resort():
    ref, source = resolve_repository(
        _metadata(project_urls={}, home_page="https://github.com/psf/requests")
    )
    assert ref is not None
    assert source == "https://github.com/psf/requests"


def test_no_github_link_resolves_to_nothing():
    ref, source = resolve_repository(
        _metadata(project_urls={"Homepage": "https://example.com"}, home_page=None)
    )
    assert ref is None and source is None


def test_missing_metadata_resolves_to_nothing():
    assert resolve_repository(None) == (None, None)


@pytest.mark.parametrize(
    "hostile",
    [
        "http://localhost:6379/",
        "http://169.254.169.254/latest/meta-data/",
        "file:///etc/passwd",
        "https://github.com.attacker.example/psf/requests",
    ],
)
def test_hostile_metadata_urls_are_never_resolved(hostile):
    """The repo URL is publisher-controlled, so it is untrusted input too."""
    ref, _ = resolve_repository(
        _metadata(project_urls={"Source": hostile}, home_page=hostile)
    )
    assert ref is None


# --- Step 2: talking to the API --------------------------------------------


@respx.mock
async def test_healthy_repository_is_parsed():
    respx.get(_api("psf/requests")).mock(
        return_value=httpx.Response(200, json=github_repo_payload())
    )

    result = await check_github("requests", _metadata(), use_cache=False)

    assert result.status is GitHubRepoStatus.OK
    assert result.repo is not None
    assert result.repo.full_name == "psf/requests"
    assert result.repo.stars == 51000
    assert result.repo.archived is False
    assert result.repo.license_name == "Apache-2.0"
    assert result.days_since_last_commit is not None
    assert result.days_since_last_commit <= 6
    assert result.matches_package is True
    assert (result.health_score or 0) > 0.9


@respx.mock
async def test_archived_repository_is_reported():
    respx.get(_api("psf/requests")).mock(
        return_value=httpx.Response(200, json=github_repo_payload(archived=True))
    )
    result = await check_github("requests", _metadata(), use_cache=False)
    assert result.repo is not None and result.repo.archived is True
    assert result.health_score == 0.0


@respx.mock
async def test_missing_repository_is_not_found_not_unavailable():
    """The distinction the risk engine depends on."""
    respx.get(_api("psf/requests")).mock(return_value=httpx.Response(404))
    result = await check_github("requests", _metadata(), use_cache=False)
    assert result.status is GitHubRepoStatus.NOT_FOUND
    assert result.health_score == 0.0


async def test_package_with_no_repo_link_short_circuits_without_a_call():
    result = await check_github(
        "lib", _metadata(project_urls={}, home_page=None), use_cache=False
    )
    assert result.status is GitHubRepoStatus.NO_REPOSITORY_LINK
    assert result.repo is None


@respx.mock
async def test_network_failure_degrades_to_unavailable_and_never_raises():
    respx.get(_api("psf/requests")).mock(side_effect=httpx.ConnectError("boom"))
    result = await check_github("requests", _metadata(), use_cache=False)
    assert result.status is GitHubRepoStatus.UNAVAILABLE
    assert result.repo is None


@respx.mock
async def test_malformed_json_degrades_to_unavailable():
    respx.get(_api("psf/requests")).mock(
        return_value=httpx.Response(200, content=b"not json")
    )
    result = await check_github("requests", _metadata(), use_cache=False)
    assert result.status is GitHubRepoStatus.UNAVAILABLE


# --- Rate limiting ----------------------------------------------------------


@respx.mock
async def test_exhausted_rate_limit_is_reported_not_hidden(monkeypatch):
    """A rate-limited check must never read as 'repository is fine'.

    Failing open here would produce a false negative: the developer is told the
    package was verified when nothing was checked at all.
    """
    monkeypatch.setattr(settings, "github_max_backoff_seconds", 0.0)
    respx.get(_api("psf/requests")).mock(
        return_value=httpx.Response(
            403,
            headers={"x-ratelimit-remaining": "0", "x-ratelimit-reset": "9999999999"},
            json={"message": "API rate limit exceeded"},
        )
    )

    result = await check_github("requests", _metadata(), use_cache=False)

    assert result.status is GitHubRepoStatus.UNAVAILABLE
    assert result.rate_limited is True
    assert result.health_score is None
    assert "BLUEBERRY_GITHUB_TOKEN" in (result.detail or "")


@respx.mock
async def test_a_transient_rate_limit_is_retried_and_then_succeeds(monkeypatch):
    monkeypatch.setattr(settings, "github_backoff_base_seconds", 0.0)
    monkeypatch.setattr(settings, "github_max_backoff_seconds", 5.0)

    route = respx.get(_api("psf/requests")).mock(
        side_effect=[
            httpx.Response(
                403,
                headers={"x-ratelimit-remaining": "0", "retry-after": "0"},
                json={"message": "rate limit"},
            ),
            httpx.Response(200, json=github_repo_payload()),
        ]
    )

    result = await check_github("requests", _metadata(), use_cache=False)

    assert route.call_count == 2
    assert result.status is GitHubRepoStatus.OK


@respx.mock
async def test_server_errors_are_retried(monkeypatch):
    monkeypatch.setattr(settings, "github_backoff_base_seconds", 0.0)
    route = respx.get(_api("psf/requests")).mock(
        side_effect=[
            httpx.Response(503),
            httpx.Response(200, json=github_repo_payload()),
        ]
    )
    result = await check_github("requests", _metadata(), use_cache=False)
    assert route.call_count == 2
    assert result.status is GitHubRepoStatus.OK


@respx.mock
async def test_a_403_that_is_not_a_rate_limit_is_not_retried(monkeypatch):
    """An ordinary permission error should not burn the retry budget."""
    monkeypatch.setattr(settings, "github_backoff_base_seconds", 0.0)
    route = respx.get(_api("psf/requests")).mock(
        return_value=httpx.Response(403, json={"message": "Forbidden"})
    )
    result = await check_github("requests", _metadata(), use_cache=False)
    assert route.call_count == 1
    assert result.status is GitHubRepoStatus.UNAVAILABLE
    assert result.rate_limited is False


@respx.mock
async def test_a_long_reset_is_not_waited_on(monkeypatch):
    """An hourly reset is longer than any editor request can block for."""
    monkeypatch.setattr(settings, "github_max_backoff_seconds", 1.0)
    route = respx.get(_api("psf/requests")).mock(
        return_value=httpx.Response(
            429,
            headers={"retry-after": "3600"},
            json={"message": "rate limit"},
        )
    )
    result = await check_github("requests", _metadata(), use_cache=False)
    assert route.call_count == 1
    assert result.rate_limited is True


# --- Authentication ---------------------------------------------------------


def test_no_authorization_header_without_a_token(monkeypatch):
    monkeypatch.setattr(settings, "github_token", None)
    assert "Authorization" not in _auth_headers()


def test_token_is_read_from_settings_never_hardcoded(monkeypatch):
    monkeypatch.setattr(settings, "github_token", "ghp_test_token")
    headers = _auth_headers()
    assert headers["Authorization"] == "Bearer ghp_test_token"
    assert headers["Accept"] == "application/vnd.github+json"
    assert headers["X-GitHub-Api-Version"] == "2022-11-28"


def test_no_token_literal_appears_in_the_source_tree():
    """Guards against a token being pasted in during debugging."""
    import pathlib
    import re

    # GitHub's own token formats: classic, fine-grained, OAuth, and app tokens.
    token_pattern = re.compile(r"gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}")
    app_root = pathlib.Path(__file__).resolve().parent.parent / "app"

    for path in app_root.rglob("*.py"):
        assert not token_pattern.search(path.read_text(encoding="utf-8")), path


@respx.mock
async def test_request_carries_the_token(monkeypatch):
    monkeypatch.setattr(settings, "github_token", "ghp_secret")
    route = respx.get(_api("psf/requests")).mock(
        return_value=httpx.Response(200, json=github_repo_payload())
    )
    await check_github("requests", _metadata(), use_cache=False)
    assert route.calls[0].request.headers["authorization"] == "Bearer ghp_secret"


# --- Step 3: does the repo actually belong to this package? -----------------


@respx.mock
async def test_unrelated_repository_is_flagged_as_a_mismatch():
    """A listing borrowing a popular project's reputation."""
    respx.get(_api("psf/requests")).mock(
        return_value=httpx.Response(200, json=github_repo_payload())
    )

    result = await check_github(
        "some-obscure-lib",
        _metadata(name="some-obscure-lib"),
        use_cache=False,
    )

    assert result.status is GitHubRepoStatus.OK
    assert result.matches_package is False
    assert "no obvious connection" in (result.match_reason or "")


@respx.mock
@pytest.mark.parametrize(
    ("package", "repo"),
    [
        ("requests", "psf/requests"),
        ("dateutil", "dateutil/dateutil"),
        ("yaml", "yaml/pyyaml"),  # py- prefix convention
        ("slugify", "un33k/python-slugify"),  # python- prefix convention
        ("Flask", "pallets/flask"),  # case-insensitive
        ("typing_extensions", "python/typing-extensions"),  # separator-insensitive
    ],
)
async def test_conventional_repository_names_still_count_as_a_match(package, repo):
    respx.get(_api(repo)).mock(
        return_value=httpx.Response(200, json=github_repo_payload(full_name=repo))
    )
    result = await check_github(
        package,
        _metadata(name=package, project_urls={"Source": f"https://github.com/{repo}"}),
        use_cache=False,
    )
    assert result.matches_package is True, result.match_reason


@respx.mock
async def test_a_fork_lowers_the_health_score():
    respx.get(_api("psf/requests")).mock(
        return_value=httpx.Response(200, json=github_repo_payload(fork=True))
    )
    forked = await check_github("requests", _metadata(), use_cache=False)

    respx.get(_api("psf/requests")).mock(
        return_value=httpx.Response(200, json=github_repo_payload(fork=False))
    )
    original = await check_github("requests", _metadata(), use_cache=False)

    assert (forked.health_score or 0) < (original.health_score or 0)


@respx.mock
async def test_stale_repository_scores_worse_than_an_active_one():
    respx.get(_api("psf/requests")).mock(
        return_value=httpx.Response(
            200, json=github_repo_payload(pushed_days_ago=900, stars=20)
        )
    )
    stale = await check_github("requests", _metadata(), use_cache=False)

    respx.get(_api("psf/requests")).mock(
        return_value=httpx.Response(
            200, json=github_repo_payload(pushed_days_ago=2, stars=20)
        )
    )
    active = await check_github("requests", _metadata(), use_cache=False)

    assert (stale.health_score or 0) < (active.health_score or 0)
    assert (stale.days_since_last_commit or 0) > 800
