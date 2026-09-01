"""Tests for the Levenshtein typosquat engine.

No mocking anywhere: the engine is pure string work over an in-process corpus,
which is exactly why it can run first in the pipeline.
"""

from __future__ import annotations

import pytest

from app.data.popular_packages import POPULAR_PACKAGES
from app.services.similarity import (
    bounded_levenshtein,
    check_similarity,
    levenshtein_distance,
)


# --- The distance function itself ------------------------------------------


@pytest.mark.parametrize(
    ("left", "right", "expected"),
    [
        ("requests", "requests", 0),
        ("requests", "reqeusts", 2),  # transposition = 2 edits
        ("requests", "request", 1),  # deletion
        ("requests", "requestss", 1),  # insertion
        ("requests", "reqvests", 1),  # substitution
        ("kitten", "sitting", 3),
        ("", "abc", 3),
        ("abc", "", 3),
        ("", "", 0),
        ("numpy", "numpi", 1),
    ],
)
def test_levenshtein_distance_is_correct(left, right, expected):
    assert levenshtein_distance(left, right) == expected
    # Distance is symmetric; the row-swapping optimisation must not break that.
    assert levenshtein_distance(right, left) == expected


def test_bounded_variant_returns_none_past_the_threshold():
    assert bounded_levenshtein("requests", "reqeusts", 2) == 2
    assert bounded_levenshtein("requests", "reqeusts", 1) is None
    assert bounded_levenshtein("abcdefgh", "zzzzzzzz", 2) is None


def test_length_difference_short_circuits_without_scanning():
    # 5 characters apart cannot possibly be within 2 edits.
    assert bounded_levenshtein("a", "abcdef", 2) is None


# --- The check ---------------------------------------------------------------


@pytest.mark.parametrize(
    "name", ["requests", "numpy", "flask", "boto3", "python-dateutil"]
)
def test_popular_packages_are_never_flagged(name):
    """The corpus is a whitelist as much as a comparison set."""
    result = check_similarity(name)
    assert result.is_known_popular is True
    assert result.is_typosquat_suspect is False
    assert result.similarity_score == 1.0


@pytest.mark.parametrize(
    "variant",
    [
        "PyYAML",  # case only
        "pyyaml",
        "PYYAML",
        "Python_DateUtil",  # case + separator
        "python.dateutil",
        "PYTHON-DATEUTIL",
    ],
)
def test_popular_package_matching_is_case_and_separator_insensitive(variant):
    """PyYAML and pyyaml are one distribution, not a 2-edit typosquat.

    Note the boundary: separators are equivalent to each other, but not to
    *nothing*. ``py_yaml`` normalises to ``py-yaml``, which PyPI really does
    treat as a different project from ``pyyaml`` -- so that one is correctly
    reported as a near-match rather than as the package itself.
    """
    assert check_similarity(variant).is_known_popular is True


def test_inserting_a_separator_is_a_different_package_and_stays_flagged():
    result = check_similarity("py_yaml")
    assert result.is_known_popular is False
    assert result.is_typosquat_suspect is True
    assert result.nearest_package == "pyyaml"


@pytest.mark.parametrize(
    ("squat", "target"),
    [
        ("reqeusts", "requests"),
        ("requsts", "requests"),
        ("urlib3", "urllib3"),
        ("numpi", "numpy"),
        ("pandsa", "pandas"),
        ("djago", "django"),
        ("beautifulsoup", "beautifulsoup4"),
        ("scikit-lern", "scikit-learn"),
        ("cryptograpy", "cryptography"),
    ],
)
def test_near_misses_are_flagged_with_the_intended_package(squat, target):
    result = check_similarity(squat)
    assert result.is_typosquat_suspect is True
    assert result.nearest_package == target
    assert result.edit_distance in (1, 2)
    assert 0.0 < (result.similarity_score or 0) < 1.0


def test_unrelated_names_are_not_flagged():
    result = check_similarity("totally-made-up-package-xyz")
    assert result.is_typosquat_suspect is False
    assert result.nearest_package is None
    assert result.matches == []


def test_short_names_only_match_at_distance_one():
    """Two edits on a three-letter name is most of the word.

    Without this rule every short package in the ecosystem reads as a squat of
    every other one.
    """
    # 'six' is in the corpus; 'sax' is one edit away and is still flagged.
    assert check_similarity("sax").edit_distance == 1
    # 'zzz' is 3 edits from 'six' and must not be reported at all.
    assert check_similarity("zzz").is_typosquat_suspect is False


def test_matches_are_ordered_closest_first():
    result = check_similarity("reqeusts")
    distances = [match.distance for match in result.matches]
    assert distances == sorted(distances)
    assert result.nearest_package == result.matches[0].package


def test_result_is_deterministic_across_runs():
    first = check_similarity("panda")
    second = check_similarity("panda")
    assert first.model_dump() == second.model_dump()


def test_custom_corpus_is_the_tuning_seam():
    """Detection can be retuned by editing the list, not the checker."""
    result = check_similarity("acmelib", corpus=("acme-lib", "acmelibs"))
    assert result.is_typosquat_suspect is True
    assert result.nearest_package in ("acme-lib", "acmelibs")


def test_empty_name_is_handled():
    assert check_similarity("   ").is_typosquat_suspect is False


# --- The corpus --------------------------------------------------------------


def test_corpus_is_normalized_and_deduplicated():
    """A corpus entry that is not PEP 503 normalised silently never matches."""
    from app.security.validation import canonicalize_package_name

    assert len(POPULAR_PACKAGES) == len(set(POPULAR_PACKAGES))
    for name in POPULAR_PACKAGES:
        assert canonicalize_package_name(name) == name, name


def test_corpus_is_large_enough_to_be_useful():
    assert len(POPULAR_PACKAGES) > 200
