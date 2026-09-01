"""Validation / sanitisation of every untrusted string that becomes a URL.

Two distinct untrusted inputs flow through this service:

1. **The package name.** It originates in AI-generated code -- the user pastes
   whatever Copilot suggested -- and is interpolated into the PyPI JSON API
   path. An unvalidated string there is a textbook SSRF / path-traversal
   surface (``../../``, an absolute ``http://169.254.169.254/...``, a newline
   smuggling a second header, a ``@evil.com`` authority).
2. **The repository URL from PyPI metadata.** Anyone can publish a package
   whose ``project_urls`` point anywhere they like. Following that blindly
   would let a package author aim our server-side HTTP client at an internal
   address -- the same SSRF surface, one hop further out.

Both are handled here, allowlist-first: a value is rejected unless it matches
a known-good grammar, rather than accepted unless it matches a known-bad
pattern. Validation happens *before* any URL is built, so a malformed value can
never reach the network layer at all.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import quote, urlsplit

__all__ = [
    "GitHubRepoRef",
    "InvalidPackageName",
    "canonicalize_package_name",
    "parse_github_repo_url",
    "validate_package_name",
]


class InvalidPackageName(ValueError):
    """Raised when a package name fails validation before any network call."""


# PyPI's own rule for a valid distribution name (PEP 508 / PEP 503). Anchored
# with \A..\Z rather than ^..$ on purpose: ``$`` also matches before a trailing
# newline, so "requests\nX-Injected: 1" would sneak past a ``^...$`` pattern.
_VALID_NAME = re.compile(r"\A[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\Z")

# PyPI enforces a 214-character maximum on distribution names.
MAX_PACKAGE_NAME_LENGTH = 214

_SEPARATOR_RUN = re.compile(r"[-_.]+")

# GitHub's rules: owners are <=39 chars of alphanumerics and single hyphens;
# repository names allow dots and underscores too.
_GH_OWNER = re.compile(r"\A[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\Z")
_GH_REPO = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9._-]{0,99}\Z")

_GITHUB_HOSTS = frozenset({"github.com", "www.github.com"})

# First path segments that are GitHub site routes, not user/org accounts. A URL
# like https://github.com/features/copilot would otherwise "resolve" to the
# non-existent repo features/copilot and be scored as a broken repo link.
_RESERVED_OWNERS = frozenset(
    {
        "about", "apps", "blog", "collections", "contact", "customer-stories",
        "enterprise", "events", "explore", "features", "git", "issues",
        "login", "marketplace", "new", "notifications", "orgs", "pricing",
        "pulls", "readme", "search", "security", "sessions", "settings",
        "showcases", "signup", "site", "sponsors", "stars", "topics",
        "trending",
    }
)


def canonicalize_package_name(package_name: str) -> str:
    """Return the PEP 503 normalised form of a name (lowercase, ``-`` runs).

    ``Foo.Bar_baz`` and ``foo-bar-baz`` are the same distribution to PyPI, so
    this is the form used for cache keys, database lookups, and the similarity
    comparison -- otherwise ``Requests`` and ``requests`` would be treated as
    two different packages and cached (and scored) twice.
    """
    return _SEPARATOR_RUN.sub("-", package_name).lower()


def validate_package_name(package_name: str) -> str:
    """Return the trimmed name if valid, else raise :class:`InvalidPackageName`.

    Call this before building *any* URL from a package name. It rejects path
    traversal, absolute URLs, whitespace, CR/LF header injection, and anything
    else outside PyPI's name grammar.
    """
    if not isinstance(package_name, str):
        raise InvalidPackageName(
            f"package name must be a string, got {type(package_name).__name__}"
        )

    name = package_name.strip()
    if not name:
        raise InvalidPackageName("package name must not be blank")
    if len(name) > MAX_PACKAGE_NAME_LENGTH:
        raise InvalidPackageName(
            f"package name exceeds PyPI's {MAX_PACKAGE_NAME_LENGTH}-character limit"
        )
    if not _VALID_NAME.match(name):
        raise InvalidPackageName(f"invalid package name: {package_name!r}")
    return name


def quote_path_segment(value: str) -> str:
    """Percent-encode an already-validated value for use in a URL path.

    Validation alone is the real control; this is defence in depth so that a
    future relaxation of the grammar cannot silently become a path injection.
    """
    return quote(value, safe="")


@dataclass(frozen=True)
class GitHubRepoRef:
    """A validated ``owner/repo`` pair extracted from an untrusted URL."""

    owner: str
    repo: str

    @property
    def full_name(self) -> str:
        return f"{self.owner}/{self.repo}"

    @property
    def html_url(self) -> str:
        """The canonical repository URL, rebuilt from validated parts.

        Rebuilt rather than echoed back, so nothing from the original untrusted
        string (query, fragment, credentials) survives into what we store or
        show the developer.
        """
        return f"https://github.com/{self.owner}/{self.repo}"

    def api_url(self, api_base_url: str) -> str:
        """The GitHub REST URL for this repo, with both segments encoded."""
        owner = quote_path_segment(self.owner)
        repo = quote_path_segment(self.repo)
        return f"{api_base_url.rstrip('/')}/repos/{owner}/{repo}"


def parse_github_repo_url(raw_url: str | None) -> GitHubRepoRef | None:
    """Extract a validated ``owner/repo`` from a PyPI-supplied URL.

    Returns ``None`` -- never raises -- for anything that is not unambiguously
    a GitHub repository URL. A package pointing at GitLab, at an internal host,
    or at ``https://github.com/features/copilot`` is simply "no resolvable
    GitHub repo", which the risk engine treats as a missing-repository signal.
    """
    if not raw_url or not isinstance(raw_url, str):
        return None

    candidate = raw_url.strip()
    if not candidate or any(c in candidate for c in "\r\n\t"):
        return None

    # Accept the common scheme-less forms ("github.com/psf/requests") by
    # normalising them before parsing, so a legitimate repo is not missed.
    if candidate.startswith("//"):
        candidate = f"https:{candidate}"
    elif "://" not in candidate:
        candidate = f"https://{candidate}"

    try:
        parts = urlsplit(candidate)
    except ValueError:
        return None

    # Allowlist: https/http only. Blocks file://, ftp://, gopher://, data:.
    if parts.scheme not in ("https", "http"):
        return None

    # netloc must be exactly an allowed host: no userinfo (``user@github.com``
    # credential confusion), no explicit port, no case tricks.
    if parts.netloc.lower() not in _GITHUB_HOSTS:
        return None

    segments = [s for s in parts.path.split("/") if s]
    if len(segments) < 2:
        return None

    owner, repo = segments[0], segments[1]
    if repo.lower().endswith(".git"):
        repo = repo[: -len(".git")]

    if owner.lower() in _RESERVED_OWNERS:
        return None
    if not _GH_OWNER.match(owner) or not _GH_REPO.match(repo):
        return None
    if repo in (".", ".."):
        return None

    return GitHubRepoRef(owner=owner, repo=repo)
