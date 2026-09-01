"""PyPI existence + metadata checker.

The cheapest, highest-signal network check: a single call to the PyPI JSON API
tells us whether a package name actually exists, which directly addresses the
first failure mode -- hallucinated packages invented by an AI.

Everything is ``async`` so the pipeline can fan the independent checks out
concurrently, and results are cached in Redis (keyed by the PEP 503 normalised
name) so a team repeatedly checking the same popular packages does not re-hit
the registry every time.

Name validation lives in :mod:`app.security.validation` and runs *before* the
URL is built -- see that module for why.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import httpx

from ..config import settings
from ..schemas.risk import PyPICheckResult, PyPIMetadata
from ..security.validation import (
    InvalidPackageName,
    canonicalize_package_name,
    quote_path_segment,
    validate_package_name,
)
from .cache import cache, make_key

__all__ = [
    "InvalidPackageName",
    "PyPIServiceError",
    "check_pypi",
    "validate_package_name",
]


class PyPIServiceError(RuntimeError):
    """Raised when PyPI returns an unexpected response or is unreachable."""


def _parse_release_dates(
    releases: dict[str, list[dict[str, Any]]],
) -> tuple[datetime | None, datetime | None]:
    """Return (first_release, latest_release) upload times across all releases."""
    times: list[datetime] = []
    for files in releases.values():
        if not isinstance(files, list):
            continue
        for file_info in files:
            if not isinstance(file_info, dict):
                continue
            raw = file_info.get("upload_time_iso_8601") or file_info.get("upload_time")
            if not raw:
                continue
            try:
                # Normalise the trailing 'Z' that fromisoformat rejects on <3.11.
                parsed = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
            except (ValueError, AttributeError):
                continue
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            times.append(parsed)
    if not times:
        return None, None
    return min(times), max(times)


def _build_metadata(payload: dict[str, Any]) -> PyPIMetadata:
    """Map the raw PyPI JSON payload onto our metadata schema."""
    info: dict[str, Any] = payload.get("info", {}) or {}
    releases: dict[str, Any] = payload.get("releases", {}) or {}

    first_release, latest_release = _parse_release_dates(releases)

    raw_urls = info.get("project_urls") or {}
    project_urls = {
        str(key): str(value)
        for key, value in raw_urls.items()
        if isinstance(value, str)
    }

    return PyPIMetadata(
        name=info.get("name") or "",
        summary=info.get("summary") or None,
        latest_version=info.get("version") or None,
        version_count=len(releases),
        first_release_date=first_release,
        latest_release_date=latest_release,
        author=info.get("author") or None,
        author_email=info.get("author_email") or None,
        maintainer=info.get("maintainer") or None,
        maintainer_email=info.get("maintainer_email") or None,
        home_page=info.get("home_page") or None,
        project_urls=project_urls,
    )


async def check_pypi(
    package_name: str,
    client: httpx.AsyncClient | None = None,
    use_cache: bool = True,
) -> PyPICheckResult:
    """Check whether ``package_name`` exists on PyPI and pull its metadata.

    Args:
        package_name: The (untrusted) package name to verify.
        client: Optional shared ``AsyncClient``. Passing one is preferred in
            production so connections are pooled across checks.
        use_cache: Set False to force a fresh registry lookup.

    Returns:
        ``PyPICheckResult`` with ``exists=False`` on a 404, or ``exists=True``
        plus parsed metadata on success.

    Raises:
        InvalidPackageName: if the name fails validation (no network call made).
        PyPIServiceError: on network failure or an unexpected status code.
    """
    name = validate_package_name(package_name)
    normalized = canonicalize_package_name(name)

    cache_key = make_key("pypi", normalized)
    if use_cache:
        cached = await cache.get_model(cache_key, PyPICheckResult)
        if cached is not None:
            return cached

    # The name is validated above; encoding it as well is defence in depth.
    url = f"{settings.pypi_base_url}/{quote_path_segment(name)}/json"

    owns_client = client is None
    if client is None:
        client = httpx.AsyncClient(timeout=settings.http_timeout)

    try:
        response = await client.get(url, headers={"Accept": "application/json"})
    except httpx.HTTPError as exc:  # timeout, connection error, etc.
        raise PyPIServiceError(f"PyPI request failed for {name!r}: {exc}") from exc
    finally:
        if owns_client:
            await client.aclose()

    if response.status_code == 404:
        result = PyPICheckResult(exists=False, metadata=None)
        if use_cache:
            # Short TTL: an attacker can register a hallucinated name at any
            # moment, and a long-lived "does not exist" would keep telling
            # developers a now-malicious package is merely imaginary.
            await cache.set_model(cache_key, result, settings.negative_cache_ttl)
        return result

    if response.status_code != 200:
        raise PyPIServiceError(
            f"unexpected PyPI status {response.status_code} for {name!r}"
        )

    try:
        payload = response.json()
    except ValueError as exc:
        raise PyPIServiceError(f"malformed PyPI JSON for {name!r}: {exc}") from exc

    if not isinstance(payload, dict):
        raise PyPIServiceError(f"unexpected PyPI payload shape for {name!r}")

    result = PyPICheckResult(exists=True, metadata=_build_metadata(payload))
    if use_cache:
        await cache.set_model(cache_key, result, settings.pypi_cache_ttl)
    return result
