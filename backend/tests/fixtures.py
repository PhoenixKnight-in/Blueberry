"""Fixture payloads used across the checker tests.

Trimmed down but structurally faithful to the real PyPI and GitHub APIs, so the
parsers are exercised against the shapes they will see in production.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone


def _iso(days_ago: int) -> str:
    """An ISO-8601 timestamp N days in the past, in GitHub's format."""
    moment = datetime.now(timezone.utc) - timedelta(days=days_ago)
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


# --- PyPI ------------------------------------------------------------------

# A real, healthy package (shape mirrors https://pypi.org/pypi/requests/json).
REQUESTS_PAYLOAD = {
    "info": {
        "name": "requests",
        "summary": "Python HTTP for Humans.",
        "version": "2.31.0",
        "author": "Kenneth Reitz",
        "maintainer": None,
        "home_page": "https://requests.readthedocs.io",
        "project_urls": {
            "Homepage": "https://requests.readthedocs.io",
            "Source": "https://github.com/psf/requests",
        },
    },
    "releases": {
        "2.0.0": [
            {"upload_time_iso_8601": "2013-09-24T13:00:00.000000Z"},
        ],
        "2.31.0": [
            {"upload_time_iso_8601": "2023-05-22T15:12:00.000000Z"},
            {"upload_time_iso_8601": "2023-05-22T15:12:30.000000Z"},
        ],
    },
}

# A package that exists but shows every low-reputation trait at once: brand
# new, one release, no author, and no source repository anywhere.
SUSPICIOUS_PAYLOAD = {
    "info": {
        "name": "reqeusts",
        "summary": "Fast HTTP library",
        "version": "0.0.1",
        "author": None,
        "maintainer": None,
        "home_page": None,
        "project_urls": {},
    },
    "releases": {
        "0.0.1": [{"upload_time_iso_8601": _iso(2)}],
    },
}

# Exists, well established, but its listing points at somebody else's repo.
MISMATCHED_REPO_PAYLOAD = {
    "info": {
        "name": "some-obscure-lib",
        "summary": "A library",
        "version": "1.2.0",
        "author": "Someone",
        "maintainer": None,
        "home_page": None,
        "project_urls": {"Source": "https://github.com/psf/requests"},
    },
    "releases": {
        "1.0.0": [{"upload_time_iso_8601": _iso(700)}],
        "1.2.0": [{"upload_time_iso_8601": _iso(400)}],
    },
}

# Points its Source at a host we must never follow.
SSRF_PROJECT_URLS_PAYLOAD = {
    "info": {
        "name": "evil-pkg",
        "summary": "Nothing to see here",
        "version": "1.0.0",
        "author": "Anonymous",
        "maintainer": None,
        "home_page": "http://169.254.169.254/latest/meta-data/",
        "project_urls": {
            "Source": "http://localhost:6379/",
            "Homepage": "https://github.com.attacker.example/psf/requests",
        },
    },
    "releases": {"1.0.0": [{"upload_time_iso_8601": _iso(500)}]},
}


# --- GitHub ----------------------------------------------------------------


def github_repo_payload(
    full_name: str = "psf/requests",
    stars: int = 51000,
    pushed_days_ago: int = 5,
    archived: bool = False,
    fork: bool = False,
    description: str | None = "A simple, yet elegant, HTTP library.",
    created_days_ago: int = 4000,
) -> dict:
    """Build a GitHub repo payload with the traits a test cares about."""
    owner, _, name = full_name.partition("/")
    return {
        "full_name": full_name,
        "name": name,
        "owner": {"login": owner},
        "html_url": f"https://github.com/{full_name}",
        "description": description,
        "stargazers_count": stars,
        "forks_count": max(0, stars // 5),
        "open_issues_count": 12,
        "subscribers_count": max(0, stars // 50),
        "archived": archived,
        "disabled": False,
        "fork": fork,
        "created_at": _iso(created_days_ago),
        "pushed_at": _iso(pushed_days_ago),
        "updated_at": _iso(pushed_days_ago),
        "license": {"spdx_id": "Apache-2.0", "name": "Apache License 2.0"},
        "default_branch": "main",
        "topics": ["http", "python"],
    }
