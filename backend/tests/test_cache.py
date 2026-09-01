"""Tests for the Redis cache layer.

Two properties matter here, and only one of them is "it caches":

* it saves round trips and rate-limit budget on repeat lookups, and
* it is never able to break a check. A cache outage must degrade to a miss.
"""

from __future__ import annotations

import httpx
import pytest
import respx

from app.config import settings
from app.schemas.risk import PyPICheckResult
from app.services.cache import RedisCache, make_key
from app.services.github_checker import check_github
from app.services.pypi_checker import check_pypi

from .fixtures import REQUESTS_PAYLOAD, github_repo_payload


def _pypi_url(name: str) -> str:
    return f"{settings.pypi_base_url}/{name}/json"


def _github_api(full_name: str) -> str:
    return f"{settings.github_api_url}/repos/{full_name}"


# --- Keys -------------------------------------------------------------------


def test_keys_are_namespaced_and_versioned():
    key = make_key("pypi", "requests")
    assert key.startswith("blueberry:pypi:")
    assert key.endswith(":requests")


def test_different_namespaces_do_not_collide():
    assert make_key("pypi", "requests") != make_key("github", "requests")


# --- Round trip -------------------------------------------------------------


async def test_pypi_result_is_served_from_cache_on_the_second_call(fake_cache):
    with respx.mock:
        route = respx.get(_pypi_url("requests")).mock(
            return_value=httpx.Response(200, json=REQUESTS_PAYLOAD)
        )

        first = await check_pypi("requests")
        second = await check_pypi("requests")

    assert route.call_count == 1, "the second lookup should not re-hit PyPI"
    assert first.model_dump() == second.model_dump()


async def test_cache_key_is_the_normalized_name(fake_cache):
    """Requests and requests are one package, so they share one cache entry."""
    with respx.mock:
        respx.get(_pypi_url("Requests")).mock(
            return_value=httpx.Response(200, json=REQUESTS_PAYLOAD)
        )
        route = respx.get(_pypi_url("requests")).mock(
            return_value=httpx.Response(200, json=REQUESTS_PAYLOAD)
        )

        await check_pypi("Requests")
        await check_pypi("requests")

    assert route.call_count == 0, "the second spelling should hit the same entry"


async def test_github_result_is_cached_by_repo_not_by_package(fake_cache):
    """Two packages in one monorepo should cost one GitHub request."""
    from app.schemas.risk import PyPIMetadata

    metadata = PyPIMetadata(
        name="requests", project_urls={"Source": "https://github.com/psf/requests"}
    )

    with respx.mock:
        route = respx.get(_github_api("psf/requests")).mock(
            return_value=httpx.Response(200, json=github_repo_payload())
        )

        await check_github("requests", metadata)
        await check_github("requests", metadata)

    assert route.call_count == 1


async def test_negative_results_use_the_short_ttl(fake_cache, monkeypatch):
    """A hallucinated name may be registered by an attacker at any moment.

    Caching "does not exist" for an hour would keep telling developers a
    now-malicious package is merely imaginary.
    """
    assert settings.negative_cache_ttl < settings.pypi_cache_ttl

    with respx.mock:
        respx.get(_pypi_url("made-up-pkg")).mock(return_value=httpx.Response(404))
        await check_pypi("made-up-pkg")

    ttl = await fake_cache._client.ttl(make_key("pypi", "made-up-pkg"))
    assert 0 < ttl <= settings.negative_cache_ttl


async def test_use_cache_false_forces_a_fresh_lookup(fake_cache):
    with respx.mock:
        route = respx.get(_pypi_url("requests")).mock(
            return_value=httpx.Response(200, json=REQUESTS_PAYLOAD)
        )
        await check_pypi("requests")
        await check_pypi("requests", use_cache=False)

    assert route.call_count == 2


# --- Degradation ------------------------------------------------------------


async def test_an_unreachable_redis_does_not_break_a_check(monkeypatch):
    """The whole point: a cache outage makes us slower, never wrong."""
    broken = RedisCache(url="redis://127.0.0.1:1/0", enabled=True)
    monkeypatch.setattr("app.services.pypi_checker.cache", broken)

    with respx.mock:
        respx.get(_pypi_url("requests")).mock(
            return_value=httpx.Response(200, json=REQUESTS_PAYLOAD)
        )
        result = await check_pypi("requests")

    assert result.exists is True
    assert broken.enabled is False, "the cache should mark itself degraded"


async def test_a_corrupt_cache_entry_is_treated_as_a_miss(fake_cache):
    await fake_cache.set(make_key("pypi", "requests"), "{not valid json", ttl=60)

    with respx.mock:
        route = respx.get(_pypi_url("requests")).mock(
            return_value=httpx.Response(200, json=REQUESTS_PAYLOAD)
        )
        result = await check_pypi("requests")

    assert route.call_count == 1
    assert result.exists is True


async def test_a_cache_entry_from_an_older_schema_is_discarded(fake_cache):
    """A deploy must not read yesterday's incompatible payload back out."""
    await fake_cache.set(make_key("pypi", "requests"), '{"unexpected": true}', ttl=60)
    assert await fake_cache.get_model(make_key("pypi", "requests"), PyPICheckResult) is None


async def test_disabled_cache_never_stores_anything(fake_cache, monkeypatch):
    monkeypatch.setattr(fake_cache, "_enabled", False)
    await fake_cache.set("blueberry:test:v1:x", "value", ttl=60)
    assert await fake_cache.get("blueberry:test:v1:x") is None


async def test_rate_limited_github_is_not_cached(fake_cache, monkeypatch):
    """Caching a rate-limit answer would extend one outage into thirty minutes."""
    from app.schemas.risk import GitHubRepoStatus, PyPIMetadata

    monkeypatch.setattr(settings, "github_max_backoff_seconds", 0.0)
    metadata = PyPIMetadata(
        name="requests", project_urls={"Source": "https://github.com/psf/requests"}
    )

    with respx.mock:
        route = respx.get(_github_api("psf/requests")).mock(
            side_effect=[
                httpx.Response(
                    403,
                    headers={"x-ratelimit-remaining": "0", "x-ratelimit-reset": "9999999999"},
                    json={"message": "API rate limit exceeded"},
                ),
                httpx.Response(200, json=github_repo_payload()),
            ]
        )

        limited = await check_github("requests", metadata)
        recovered = await check_github("requests", metadata)

    assert limited.status is GitHubRepoStatus.UNAVAILABLE
    assert recovered.status is GitHubRepoStatus.OK
    assert route.call_count == 2
