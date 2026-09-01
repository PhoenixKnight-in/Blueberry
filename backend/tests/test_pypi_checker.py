"""Unit tests for the PyPI checker service.

The external HTTP call is mocked with ``respx`` so the tests are fast and
deterministic. Name-validation behaviour is covered in depth in
``test_validation.py``; what is asserted here is that the checker actually
routes through it before touching the network.
"""

from __future__ import annotations

from datetime import datetime, timezone

import httpx
import pytest
import respx

from app.config import settings
from app.services.pypi_checker import (
    InvalidPackageName,
    PyPIServiceError,
    check_pypi,
    validate_package_name,
)

from .fixtures import REQUESTS_PAYLOAD


def _url(name: str) -> str:
    return f"{settings.pypi_base_url}/{name}/json"


# --- Existence -------------------------------------------------------------


@respx.mock
async def test_existing_package_is_found_with_metadata():
    respx.get(_url("requests")).mock(
        return_value=httpx.Response(200, json=REQUESTS_PAYLOAD)
    )

    result = await check_pypi("requests", use_cache=False)

    assert result.exists is True
    assert result.metadata is not None
    assert result.metadata.name == "requests"
    assert result.metadata.latest_version == "2.31.0"
    assert result.metadata.version_count == 2
    assert result.metadata.author == "Kenneth Reitz"
    assert result.metadata.summary == "Python HTTP for Humans."
    # Dates parsed from the earliest / latest upload times.
    assert result.metadata.first_release_date == datetime.fromisoformat(
        "2013-09-24T13:00:00+00:00"
    )
    assert result.metadata.latest_release_date == datetime.fromisoformat(
        "2023-05-22T15:12:30+00:00"
    )
    assert result.metadata.project_urls["Source"] == "https://github.com/psf/requests"


@respx.mock
async def test_nonexistent_package_returns_exists_false():
    respx.get(_url("totally-made-up-pkg-xyz")).mock(
        return_value=httpx.Response(404, json={"message": "Not Found"})
    )

    result = await check_pypi("totally-made-up-pkg-xyz", use_cache=False)

    assert result.exists is False
    assert result.metadata is None


@respx.mock
async def test_release_dates_are_timezone_aware():
    """Naive timestamps would silently break the 'how old is this' rules."""
    payload = {
        "info": {"name": "x", "version": "1.0"},
        "releases": {"1.0": [{"upload_time": "2024-01-01T00:00:00"}]},
    }
    respx.get(_url("x")).mock(return_value=httpx.Response(200, json=payload))

    result = await check_pypi("x", use_cache=False)

    assert result.metadata is not None
    assert result.metadata.first_release_date is not None
    assert result.metadata.first_release_date.tzinfo is not None


@respx.mock
async def test_a_package_with_no_releases_is_still_parsed():
    payload = {"info": {"name": "empty", "version": None}, "releases": {}}
    respx.get(_url("empty")).mock(return_value=httpx.Response(200, json=payload))

    result = await check_pypi("empty", use_cache=False)

    assert result.exists is True
    assert result.metadata is not None
    assert result.metadata.version_count == 0
    assert result.metadata.first_release_date is None


@respx.mock
async def test_non_string_project_urls_are_dropped():
    """PyPI metadata is publisher-controlled and not always well-formed."""
    payload = {
        "info": {
            "name": "odd",
            "version": "1.0",
            "project_urls": {"Source": "https://github.com/a/b", "Weird": None},
        },
        "releases": {},
    }
    respx.get(_url("odd")).mock(return_value=httpx.Response(200, json=payload))

    result = await check_pypi("odd", use_cache=False)

    assert result.metadata is not None
    assert result.metadata.project_urls == {"Source": "https://github.com/a/b"}


# --- Error handling --------------------------------------------------------


@respx.mock
async def test_unexpected_status_raises_service_error():
    respx.get(_url("flaky")).mock(return_value=httpx.Response(503))

    with pytest.raises(PyPIServiceError):
        await check_pypi("flaky", use_cache=False)


@respx.mock
async def test_network_failure_raises_service_error():
    respx.get(_url("requests")).mock(side_effect=httpx.ConnectError("boom"))

    with pytest.raises(PyPIServiceError):
        await check_pypi("requests", use_cache=False)


@respx.mock
async def test_malformed_json_raises_service_error():
    respx.get(_url("requests")).mock(
        return_value=httpx.Response(200, content=b"not json")
    )

    with pytest.raises(PyPIServiceError):
        await check_pypi("requests", use_cache=False)


@respx.mock
async def test_shared_client_is_used_and_left_open():
    respx.get(_url("requests")).mock(
        return_value=httpx.Response(200, json=REQUESTS_PAYLOAD)
    )

    async with httpx.AsyncClient() as client:
        result = await check_pypi("requests", client=client, use_cache=False)
        assert result.exists is True
        assert not client.is_closed


# --- Input validation (untrusted package names) ----------------------------


@pytest.mark.parametrize(
    "bad_name",
    [
        "",
        "   ",
        "../etc/passwd",
        "pkg/../../secret",
        "has space",
        "name#with!bad$chars",
        "http://169.254.169.254/latest",
        "requests\nX-Injected: 1",
        "a" * 215,
    ],
)
async def test_invalid_names_are_rejected_before_any_network_call(bad_name):
    with respx.mock:
        route = respx.get(url__regex=r".*")
        with pytest.raises(InvalidPackageName):
            await check_pypi(bad_name, use_cache=False)
        assert route.call_count == 0, "a rejected name must never reach the network"


@pytest.mark.parametrize(
    "good_name",
    ["requests", "Flask", "typing-extensions", "zope.interface", "ruamel.yaml"],
)
def test_valid_names_pass_validation(good_name):
    assert validate_package_name(good_name) == good_name
