"""GitHub repository checker.

Registry existence alone does not catch the third failure mode in the problem
statement: packages that *do* exist but are abandoned, hijacked, or point at a
repository that has nothing to do with them. This checker supplies that signal
in three parts:

1. **Resolve** the source repository from PyPI metadata (``project_urls``,
   falling back to ``home_page``). No link at all is itself a red flag.
2. **Inspect** it: stars, whether it is archived or disabled, and how long ago
   it was last pushed to.
3. **Corroborate** it: does the repository plausibly belong to *this* package?
   A listing pointing at an unrelated popular repo is a classic way to borrow
   someone else's reputation.

Everything the repository URL touches goes through
:mod:`app.security.validation` first -- the URL comes from package metadata
that any publisher controls, so it is as untrusted as the package name.

Authentication and rate limits
------------------------------
The token is read from ``BLUEBERRY_GITHUB_TOKEN`` and never hardcoded.
Unauthenticated GitHub allows 60 requests per hour per IP, which one busy
developer would exhaust in minutes; authenticated, it is 5000.

When the limit is hit anyway, this module does two things and refuses to do a
third. It backs off (honouring ``Retry-After`` / ``X-RateLimit-Reset``, capped
so a request never hangs waiting for an hourly reset), and it caches
aggressively so repeat lookups never spend budget. What it will not do is
report a rate-limited lookup as a healthy or a missing repository: that comes
back as :attr:`GitHubRepoStatus.UNAVAILABLE` with ``rate_limited=True``, and
the risk engine scores it as "unknown". A security checker that silently fails
open produces false negatives, which is worse than no check at all, because
the developer believes something was verified when nothing was.
"""

from __future__ import annotations

import asyncio
import logging
import random
import time
from datetime import datetime, timezone
from typing import Any

import httpx

from ..config import settings
from ..schemas.risk import (
    GitHubCheckResult,
    GitHubRepoInfo,
    GitHubRepoStatus,
    PyPIMetadata,
)
from ..security.validation import (
    GitHubRepoRef,
    canonicalize_package_name,
    parse_github_repo_url,
)
from .cache import cache, make_key

logger = logging.getLogger(__name__)

__all__ = [
    "GitHubServiceError",
    "check_github",
    "resolve_repository",
]

#: ``project_urls`` keys checked in order of how strongly they imply "this is
#: the source repository". Homepage and documentation links are last because
#: plenty of packages point those at a docs site that merely mentions GitHub.
_REPO_URL_KEYS: tuple[str, ...] = (
    "source",
    "source code",
    "sourcecode",
    "repository",
    "repo",
    "code",
    "github",
    "project-urls source",
    "issues",
    "issue tracker",
    "bug tracker",
    "bug reports",
    "tracker",
    "changelog",
    "documentation",
    "docs",
    "homepage",
    "home",
)

_RETRYABLE_STATUSES = frozenset({500, 502, 503, 504})


class GitHubServiceError(RuntimeError):
    """Raised for a GitHub failure the caller should surface as degraded."""


# ---------------------------------------------------------------------------
# Step 1 -- resolve the repository from PyPI metadata
# ---------------------------------------------------------------------------


def resolve_repository(
    metadata: PyPIMetadata | None,
) -> tuple[GitHubRepoRef | None, str | None]:
    """Find the package's GitHub repo in its PyPI metadata.

    Returns ``(ref, source_url)``, where ``source_url`` is the raw metadata URL
    the reference came from -- kept so the report can show *why* we looked at a
    given repository, which matters when the answer is "that repo is unrelated
    to this package".
    """
    if metadata is None:
        return None, None

    project_urls = metadata.project_urls or {}
    # Case-insensitive lookup: publishers write "Source", "source", "Source Code".
    lowered = {str(key).strip().lower(): value for key, value in project_urls.items()}

    for key in _REPO_URL_KEYS:
        candidate = lowered.get(key)
        ref = parse_github_repo_url(candidate)
        if ref is not None:
            return ref, candidate

    # Any remaining project_url, then home_page, as a last resort.
    for candidate in list(lowered.values()) + [metadata.home_page]:
        ref = parse_github_repo_url(candidate)
        if ref is not None:
            return ref, candidate

    return None, None


# ---------------------------------------------------------------------------
# Step 2 -- talk to the GitHub API
# ---------------------------------------------------------------------------


def _auth_headers() -> dict[str, str]:
    """Build request headers, adding the token only if one is configured."""
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": f"blueberry-validator/{settings.app_version}",
    }
    token = settings.github_token
    if token:
        # Read from the environment at call time; never logged, never echoed
        # back in a response or an error message.
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _is_rate_limited(response: httpx.Response) -> bool:
    """Distinguish a rate-limit refusal from an ordinary 403.

    GitHub answers both a spent quota and a genuine permission problem with
    403, so the headers are what actually tell them apart.
    """
    if response.status_code == 429:
        return True
    if response.status_code != 403:
        return False
    if response.headers.get("x-ratelimit-remaining") == "0":
        return True
    if response.headers.get("retry-after") is not None:
        return True
    body = (response.text or "").lower()
    return "rate limit" in body or "secondary rate" in body


def _retry_delay(response: httpx.Response, attempt: int) -> float:
    """How long to wait before the next attempt, in seconds.

    Prefers what GitHub actually tells us (``Retry-After`` for secondary
    limits, ``X-RateLimit-Reset`` for the primary one) and falls back to
    exponential backoff with jitter. Jitter matters because several editor
    windows checking the same file would otherwise retry in lockstep.
    """
    retry_after = response.headers.get("retry-after")
    if retry_after:
        try:
            return max(0.0, float(retry_after))
        except ValueError:
            pass

    reset = response.headers.get("x-ratelimit-reset")
    if reset:
        try:
            return max(0.0, float(reset) - time.time())
        except ValueError:
            pass

    base = settings.github_backoff_base_seconds
    return base * (2**attempt) + random.uniform(0, base)


async def _get_with_backoff(
    client: httpx.AsyncClient,
    url: str,
) -> httpx.Response:
    """GET ``url``, retrying transient failures and short rate-limit waits.

    Returns the final response even when it is a failure -- the caller decides
    how to represent that in the report. Raises only when no response was ever
    obtained.
    """
    headers = _auth_headers()
    last_error: Exception | None = None
    attempts = max(1, settings.github_max_attempts)

    for attempt in range(attempts):
        try:
            response = await client.get(url, headers=headers)
        except httpx.HTTPError as exc:
            last_error = exc
            if attempt == attempts - 1:
                break
            await asyncio.sleep(
                min(
                    settings.github_backoff_base_seconds * (2**attempt),
                    settings.github_max_backoff_seconds,
                )
            )
            continue

        should_retry = _is_rate_limited(response) or (
            response.status_code in _RETRYABLE_STATUSES
        )
        if not should_retry or attempt == attempts - 1:
            return response

        delay = _retry_delay(response, attempt)
        if delay > settings.github_max_backoff_seconds:
            # The primary limit resets on the hour. A developer's editor cannot
            # block that long, so stop here and let the caller report the check
            # as degraded rather than guessing at the repository's health.
            logger.warning(
                "GitHub rate limit needs %.0fs to reset, over the %.0fs cap; "
                "returning a degraded result for %s",
                delay,
                settings.github_max_backoff_seconds,
                url,
            )
            return response

        logger.info("GitHub retry %d/%d in %.1fs", attempt + 1, attempts, delay)
        await asyncio.sleep(delay)

    raise GitHubServiceError(f"GitHub request failed: {last_error}")


def _parse_datetime(raw: Any) -> datetime | None:
    if not isinstance(raw, str) or not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _build_repo_info(payload: dict[str, Any]) -> GitHubRepoInfo:
    """Map the GitHub repo payload onto our schema."""
    license_info = payload.get("license") or {}
    return GitHubRepoInfo(
        full_name=payload.get("full_name") or "",
        html_url=payload.get("html_url") or "",
        description=payload.get("description") or None,
        stars=int(payload.get("stargazers_count") or 0),
        forks=int(payload.get("forks_count") or 0),
        open_issues=int(payload.get("open_issues_count") or 0),
        subscribers=int(payload.get("subscribers_count") or 0),
        archived=bool(payload.get("archived")),
        disabled=bool(payload.get("disabled")),
        is_fork=bool(payload.get("fork")),
        created_at=_parse_datetime(payload.get("created_at")),
        pushed_at=_parse_datetime(payload.get("pushed_at")),
        updated_at=_parse_datetime(payload.get("updated_at")),
        license_name=(license_info.get("spdx_id") or license_info.get("name")) or None,
        default_branch=payload.get("default_branch") or None,
        topics=[str(t) for t in (payload.get("topics") or [])],
    )


# ---------------------------------------------------------------------------
# Step 3 -- does this repository plausibly belong to this package?
# ---------------------------------------------------------------------------


def _plausibly_matches(
    package_name: str,
    repo: GitHubRepoInfo,
    ref: GitHubRepoRef,
) -> tuple[bool, str]:
    """Judge whether ``repo`` is credibly the source for ``package_name``.

    Deliberately generous. Plenty of legitimate packages live in a repo with a
    different name (``beautifulsoup4`` at ``wention/BeautifulSoup4``, packages
    inside a monorepo), so this is evidence rather than proof: a match raises
    confidence, and only a total absence of connection is treated as a signal.
    """
    package = canonicalize_package_name(package_name)
    repo_name = canonicalize_package_name(ref.repo)
    owner = canonicalize_package_name(ref.owner)

    if repo_name == package:
        return True, f"Repository name matches the package name ({ref.full_name})."

    # python-foo / foo-python / py-foo are all common repo-naming conventions.
    stripped = repo_name
    for affix in ("python-", "py-", "-python", "-py"):
        if affix.endswith("-") and stripped.startswith(affix):
            stripped = stripped[len(affix) :]
        elif affix.startswith("-") and stripped.endswith(affix):
            stripped = stripped[: -len(affix)]
    if stripped == package:
        return True, f"Repository name matches the package name ({ref.full_name})."

    if package in repo_name or repo_name in package:
        return True, f"Repository name is consistent with the package ({ref.full_name})."

    if package == owner or package in owner:
        return True, f"Package name matches the repository owner ({ref.full_name})."

    description = canonicalize_package_name(repo.description or "")
    if package and package in description:
        return True, "The repository description names the package."

    if any(package == canonicalize_package_name(topic) for topic in repo.topics):
        return True, "The repository topics name the package."

    return (
        False,
        f"The linked repository ({ref.full_name}) has no obvious connection to "
        f"'{package_name}' -- the listing may be borrowing another project's "
        "reputation.",
    )


def _health_score(
    repo: GitHubRepoInfo,
    days_since_push: int | None,
    matches_package: bool,
) -> float:
    """Condense repository health into a single 0.0-1.0 number.

    This is a convenience for the dashboard's summary column. It is *not* what
    drives the risk score -- the risk engine reads the underlying booleans and
    counts directly, so every point it assigns stays traceable to a named rule
    rather than to an opaque composite.
    """
    if repo.archived or repo.disabled:
        return 0.0

    # Recency of the last push, worth half the score.
    if days_since_push is None:
        recency = 0.5
    elif days_since_push <= 30:
        recency = 1.0
    elif days_since_push <= 90:
        recency = 0.85
    elif days_since_push <= settings.repo_aging_after_days:
        recency = 0.6
    elif days_since_push <= settings.repo_stale_after_days:
        recency = 0.35
    else:
        recency = 0.1

    # Adoption, worth a third: log-ish buckets, since the gap between 5 and 50
    # stars means far more than the gap between 5000 and 50000.
    if repo.stars >= settings.repo_established_stars:
        adoption = 1.0
    elif repo.stars >= settings.repo_few_stars_below:
        adoption = 0.7
    elif repo.stars >= 10:
        adoption = 0.4
    elif repo.stars >= 1:
        adoption = 0.2
    else:
        adoption = 0.0

    correspondence = 1.0 if matches_package else 0.0

    score = 0.5 * recency + 0.3 * adoption + 0.2 * correspondence
    if repo.is_fork:
        score *= 0.8
    return round(min(1.0, max(0.0, score)), 4)


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


async def check_github(
    package_name: str,
    metadata: PyPIMetadata | None,
    client: httpx.AsyncClient | None = None,
    use_cache: bool = True,
) -> GitHubCheckResult:
    """Resolve and inspect the GitHub repository behind a package.

    Never raises for an upstream problem: an unreachable or rate-limited
    GitHub comes back as :attr:`GitHubRepoStatus.UNAVAILABLE`, which the risk
    engine reports as unknown rather than scoring as either safe or risky.
    """
    ref, source_url = resolve_repository(metadata)

    if ref is None:
        return GitHubCheckResult(
            status=GitHubRepoStatus.NO_REPOSITORY_LINK,
            source_url=None,
            detail=(
                "No GitHub repository is linked from the package's PyPI metadata."
            ),
        )

    cache_key = make_key("github", ref.full_name.lower())
    if use_cache:
        cached = await cache.get_model(cache_key, GitHubCheckResult)
        if cached is not None:
            return cached

    url = ref.api_url(settings.github_api_url)

    owns_client = client is None
    if client is None:
        client = httpx.AsyncClient(timeout=settings.http_timeout)

    try:
        response = await _get_with_backoff(client, url)
    except GitHubServiceError as exc:
        # Not cached: a transport failure says nothing about the repository.
        return GitHubCheckResult(
            status=GitHubRepoStatus.UNAVAILABLE,
            source_url=source_url,
            repo_full_name=ref.full_name,
            detail=f"Could not reach GitHub to verify {ref.full_name}: {exc}",
        )
    finally:
        if owns_client:
            await client.aclose()

    result = _interpret_response(response, package_name, ref, source_url)

    if use_cache and result.status in (GitHubRepoStatus.OK, GitHubRepoStatus.NOT_FOUND):
        ttl = (
            settings.github_cache_ttl
            if result.status is GitHubRepoStatus.OK
            else settings.negative_cache_ttl
        )
        await cache.set_model(cache_key, result, ttl)

    return result


def _interpret_response(
    response: httpx.Response,
    package_name: str,
    ref: GitHubRepoRef,
    source_url: str | None,
) -> GitHubCheckResult:
    """Turn a final GitHub response into a check result."""
    if _is_rate_limited(response):
        return GitHubCheckResult(
            status=GitHubRepoStatus.UNAVAILABLE,
            source_url=source_url,
            repo_full_name=ref.full_name,
            rate_limited=True,
            detail=(
                "GitHub rate limit reached, so repository health could not be "
                "verified. Set BLUEBERRY_GITHUB_TOKEN to raise the limit from "
                "60 to 5000 requests per hour."
            ),
        )

    if response.status_code == 404:
        return GitHubCheckResult(
            status=GitHubRepoStatus.NOT_FOUND,
            source_url=source_url,
            repo_full_name=ref.full_name,
            matches_package=False,
            health_score=0.0,
            detail=(
                f"The linked repository {ref.html_url} does not exist or is "
                "private."
            ),
        )

    if response.status_code != 200:
        return GitHubCheckResult(
            status=GitHubRepoStatus.UNAVAILABLE,
            source_url=source_url,
            repo_full_name=ref.full_name,
            detail=f"Unexpected GitHub status {response.status_code} for {ref.full_name}.",
        )

    try:
        payload = response.json()
    except ValueError:
        return GitHubCheckResult(
            status=GitHubRepoStatus.UNAVAILABLE,
            source_url=source_url,
            repo_full_name=ref.full_name,
            detail=f"Malformed GitHub response for {ref.full_name}.",
        )

    if not isinstance(payload, dict):
        return GitHubCheckResult(
            status=GitHubRepoStatus.UNAVAILABLE,
            source_url=source_url,
            repo_full_name=ref.full_name,
            detail=f"Unexpected GitHub payload for {ref.full_name}.",
        )

    repo = _build_repo_info(payload)

    days_since_push: int | None = None
    if repo.pushed_at is not None:
        delta = datetime.now(timezone.utc) - repo.pushed_at
        days_since_push = max(0, delta.days)

    matches, match_reason = _plausibly_matches(package_name, repo, ref)

    return GitHubCheckResult(
        status=GitHubRepoStatus.OK,
        source_url=source_url,
        repo_full_name=repo.full_name or ref.full_name,
        repo=repo,
        days_since_last_commit=days_since_push,
        matches_package=matches,
        match_reason=match_reason,
        health_score=_health_score(repo, days_since_push, matches),
    )
