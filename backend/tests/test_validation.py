"""Security tests for the untrusted-input boundary.

Package names come from AI-generated code and repository URLs come from
publisher-controlled metadata. Both are used to build outbound URLs, so these
tests are the ones that matter most in this codebase: everything here is an
attempt to make the service fetch something it was never meant to fetch.
"""

from __future__ import annotations

import pytest

from app.security.validation import (
    InvalidPackageName,
    canonicalize_package_name,
    parse_github_repo_url,
    validate_package_name,
)


# --- Package names ---------------------------------------------------------


@pytest.mark.parametrize(
    "name",
    [
        "requests",
        "Flask",
        "typing-extensions",
        "zope.interface",
        "ruamel.yaml",
        "backports_abc",
        "a",
        "a" * 214,
    ],
)
def test_legitimate_names_are_accepted(name):
    assert validate_package_name(name) == name


def test_surrounding_whitespace_is_trimmed():
    assert validate_package_name("  requests\t") == "requests"


@pytest.mark.parametrize(
    ("name", "attack"),
    [
        ("../etc/passwd", "path traversal"),
        ("pkg/../../secret", "path traversal"),
        ("..", "path traversal"),
        ("/absolute", "absolute path"),
        ("http://169.254.169.254/latest", "SSRF to cloud metadata"),
        ("https://evil.example/x", "SSRF to arbitrary host"),
        ("//evil.example/x", "protocol-relative SSRF"),
        ("requests\nX-Injected: 1", "header injection via LF"),
        ("requests\r\nHost: evil", "header injection via CRLF"),
        ("requests%00", "null-byte truncation"),
        ("requests?x=1", "query smuggling"),
        ("requests#frag", "fragment smuggling"),
        ("user@github.com", "authority confusion"),
        ("pkg name", "whitespace"),
        ("name#with!bad$chars", "shell/URL metacharacters"),
        ("", "empty"),
        ("   ", "blank"),
        ("-leading-hyphen", "outside PEP 508 grammar"),
        ("trailing-hyphen-", "outside PEP 508 grammar"),
        ("a" * 215, "over PyPI's 214-char limit"),
    ],
)
def test_hostile_names_are_rejected(name, attack):
    with pytest.raises(InvalidPackageName):
        validate_package_name(name)


def test_non_string_input_is_rejected():
    with pytest.raises(InvalidPackageName):
        validate_package_name(None)  # type: ignore[arg-type]


def test_name_pattern_is_anchored_against_trailing_newlines():
    """Regression guard for the \\A..\\Z anchoring in the name pattern.

    Python's ``$`` also matches immediately before a trailing newline, so a
    pattern written ``^...$`` accepts "requests\\n". ``validate_package_name``
    happens to strip that particular case, but the pattern is the layer that
    has to hold on its own -- it is reused, and strip() only removes *outer*
    whitespace, not a newline followed by more text.
    """
    from app.security.validation import _VALID_NAME

    assert _VALID_NAME.match("requests") is not None
    assert _VALID_NAME.match("requests\n") is None
    assert _VALID_NAME.match("requests\nX-Injected: 1") is None


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Requests", "requests"),
        ("Foo.Bar_baz", "foo-bar-baz"),
        ("typing_extensions", "typing-extensions"),
        ("ruamel..yaml", "ruamel-yaml"),
    ],
)
def test_canonicalization_follows_pep_503(raw, expected):
    assert canonicalize_package_name(raw) == expected


# --- Repository URLs from PyPI metadata ------------------------------------


@pytest.mark.parametrize(
    ("url", "owner", "repo"),
    [
        ("https://github.com/psf/requests", "psf", "requests"),
        ("http://github.com/psf/requests", "psf", "requests"),
        ("https://www.github.com/psf/requests/", "psf", "requests"),
        ("https://github.com/psf/requests.git", "psf", "requests"),
        ("https://github.com/psf/requests/tree/main/src", "psf", "requests"),
        ("https://github.com/psf/requests/issues", "psf", "requests"),
        ("github.com/psf/requests", "psf", "requests"),
        ("//github.com/psf/requests", "psf", "requests"),
        ("https://GITHUB.com/PSF/Requests", "PSF", "Requests"),
        ("https://github.com/psf/requests?foo=bar#x", "psf", "requests"),
    ],
)
def test_real_repository_urls_resolve(url, owner, repo):
    ref = parse_github_repo_url(url)
    assert ref is not None
    assert (ref.owner, ref.repo) == (owner, repo)


@pytest.mark.parametrize(
    ("url", "attack"),
    [
        ("http://localhost:6379/", "SSRF to a local service"),
        ("http://127.0.0.1:8000/psf/requests", "SSRF to loopback"),
        ("http://169.254.169.254/latest/meta-data/", "cloud metadata endpoint"),
        ("http://[::1]/psf/requests", "IPv6 loopback"),
        ("file:///etc/passwd", "local file read"),
        ("gopher://github.com/psf/requests", "protocol smuggling"),
        ("data:text/html,<script>", "data URI"),
        ("https://github.com.attacker.example/psf/requests", "suffix lookalike host"),
        ("https://attacker.example/github.com/psf/requests", "path lookalike"),
        ("https://user:pass@github.com/psf/requests", "credential confusion"),
        ("https://evil@github.com/psf/requests", "userinfo authority confusion"),
        ("https://github.com:8080/psf/requests", "non-standard port"),
        ("https://gitlab.com/psf/requests", "different forge"),
        ("https://github.com/psf", "no repository segment"),
        ("https://github.com/", "no path"),
        ("https://github.com/features/copilot", "GitHub site route, not a repo"),
        ("https://github.com/sponsors/psf", "GitHub site route, not a repo"),
        ("https://github.com/psf/req\nuests", "newline in path"),
        ("", "empty"),
        (None, "missing"),
    ],
)
def test_hostile_repository_urls_are_not_followed(url, attack):
    assert parse_github_repo_url(url) is None


def test_resolved_url_is_rebuilt_not_echoed():
    """Nothing from the untrusted string may survive into what we store."""
    ref = parse_github_repo_url("http://www.github.com/psf/requests/tree/main?a=1#b")
    assert ref is not None
    assert ref.html_url == "https://github.com/psf/requests"


def test_api_url_encodes_both_segments():
    ref = parse_github_repo_url("https://github.com/psf/requests")
    assert ref is not None
    assert ref.api_url("https://api.github.com") == (
        "https://api.github.com/repos/psf/requests"
    )
