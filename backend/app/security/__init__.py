"""Security primitives shared by every checker.

Package names reach this backend from AI-generated code, and repository URLs
reach it from PyPI metadata that any package author can set. Both are
**untrusted input**, and both are used to build outbound URLs — so validation
lives in its own module that the checkers must go through, rather than being
re-implemented (and eventually forgotten) in each one.
"""

from .validation import (
    GitHubRepoRef,
    InvalidPackageName,
    canonicalize_package_name,
    parse_github_repo_url,
    validate_package_name,
)

__all__ = [
    "GitHubRepoRef",
    "InvalidPackageName",
    "canonicalize_package_name",
    "parse_github_repo_url",
    "validate_package_name",
]
