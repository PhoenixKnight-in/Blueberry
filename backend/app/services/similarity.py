"""Typosquat detection by Levenshtein distance against high-traffic names.

This targets the second failure mode in the problem statement: a malicious
package published one character away from a popular one, betting that a human
or a model will make exactly that substitution. Levenshtein distance is the
right tool because it models precisely that mistake -- the minimum number of
single-character insertions, deletions, or substitutions between two names.

The check is pure string work against an in-process corpus, so it needs no
external API and cannot fail, rate-limit, or time out. That is why it runs
first in the pipeline: ``reqeusts`` is worth flagging even in the moment when
PyPI and GitHub are both unreachable.

Two rules keep the false-positive rate sane:

* **An exact match is never a typosquat.** If the name IS ``requests``, it is
  the real package -- the corpus is a whitelist as much as a comparison set.
* **Short names only match at distance 1.** Two edits on a five-letter name is
  most of the word; without this, ``attrs`` flags ``arrow`` and every three-
  letter package in the ecosystem looks like a squat.
"""

from __future__ import annotations

from ..config import settings
from ..data.popular_packages import POPULAR_PACKAGES, POPULAR_PACKAGE_SET
from ..schemas.risk import SimilarityMatch, SimilarityResult
from ..security.validation import canonicalize_package_name

__all__ = ["bounded_levenshtein", "levenshtein_distance", "check_similarity"]


def levenshtein_distance(left: str, right: str) -> int:
    """Return the unbounded Levenshtein edit distance between two strings."""
    result = bounded_levenshtein(left, right, max_distance=max(len(left), len(right)))
    # With a max equal to the longest string the bound can never be exceeded.
    assert result is not None  # noqa: S101 - invariant, not input validation
    return result


def bounded_levenshtein(left: str, right: str, max_distance: int) -> int | None:
    """Levenshtein distance, or ``None`` if it provably exceeds ``max_distance``.

    The corpus is scanned once per request, so the early exits matter more than
    the asymptotics:

    * a length difference greater than ``max_distance`` is already a lower
      bound on the distance, so those candidates are rejected without any
      matrix work at all;
    * within a row, if every cell already exceeds ``max_distance``, no later
      row can come back under it, so the computation stops there.

    Only two rows of the matrix are kept, making this O(len(left)) in memory.
    """
    if left == right:
        return 0
    if abs(len(left) - len(right)) > max_distance:
        return None
    if not left:
        return len(right) if len(right) <= max_distance else None
    if not right:
        return len(left) if len(left) <= max_distance else None

    # Iterate over the shorter string in the inner loop for a narrower row.
    if len(left) > len(right):
        left, right = right, left

    previous_row = list(range(len(left) + 1))

    for right_index, right_char in enumerate(right, start=1):
        current_row = [right_index]
        row_minimum = right_index

        for left_index, left_char in enumerate(left, start=1):
            deletion = previous_row[left_index] + 1
            insertion = current_row[left_index - 1] + 1
            substitution = previous_row[left_index - 1] + (left_char != right_char)
            cell = min(deletion, insertion, substitution)
            current_row.append(cell)
            if cell < row_minimum:
                row_minimum = cell

        # Every remaining row can only add to this minimum, so once the whole
        # row is over budget the pair cannot come back under the threshold.
        if row_minimum > max_distance:
            return None

        previous_row = current_row

    distance = previous_row[-1]
    return distance if distance <= max_distance else None


def _similarity_ratio(name: str, candidate: str, distance: int) -> float:
    """Normalise an edit distance to a 0.0-1.0 similarity for display.

    The dashboard shows this as a percentage ("92% similar to requests"), which
    is easier to reason about than a raw edit count on names of differing
    length.
    """
    longest = max(len(name), len(candidate))
    if longest == 0:
        return 1.0
    return round(max(0.0, 1.0 - distance / longest), 4)


def _max_distance_for(name: str) -> int:
    """The edit-distance threshold to use for a name of this length."""
    if len(name) <= settings.similarity_short_name_length:
        return min(1, settings.similarity_max_distance)
    return settings.similarity_max_distance


def check_similarity(
    package_name: str,
    corpus: tuple[str, ...] = POPULAR_PACKAGES,
) -> SimilarityResult:
    """Compare ``package_name`` against the popular-package corpus.

    Args:
        package_name: The (already validated) name to check.
        corpus: Override the reference list -- used by the tests, and the seam
            for swapping in a larger or ecosystem-specific list later.

    Returns:
        A :class:`SimilarityResult`. ``is_typosquat_suspect`` is True only for
        a near-match, never for an exact one.
    """
    name = canonicalize_package_name(package_name.strip())

    if not name:
        return SimilarityResult()

    # An exact hit is the legitimate package itself. Short-circuiting here also
    # keeps popular names that are close to each other (pypdf / pypdf2,
    # psycopg / psycopg2) from flagging one another.
    if name in POPULAR_PACKAGE_SET or name in corpus:
        return SimilarityResult(
            is_known_popular=True,
            is_typosquat_suspect=False,
            nearest_package=name,
            edit_distance=0,
            similarity_score=1.0,
            matches=[SimilarityMatch(package=name, distance=0, similarity=1.0)],
        )

    max_distance = _max_distance_for(name)
    matches: list[SimilarityMatch] = []

    for candidate in corpus:
        distance = bounded_levenshtein(name, candidate, max_distance)
        if distance is None or distance == 0:
            continue
        matches.append(
            SimilarityMatch(
                package=candidate,
                distance=distance,
                similarity=_similarity_ratio(name, candidate, distance),
            )
        )

    if not matches:
        return SimilarityResult(is_typosquat_suspect=False)

    # Closest first; on a tie prefer the higher similarity ratio (i.e. the
    # longer, more specific name), then alphabetical order so the result is
    # deterministic across runs.
    matches.sort(key=lambda m: (m.distance, -m.similarity, m.package))
    nearest = matches[0]

    return SimilarityResult(
        is_known_popular=False,
        is_typosquat_suspect=True,
        nearest_package=nearest.package,
        edit_distance=nearest.distance,
        similarity_score=nearest.similarity,
        matches=matches,
    )
