"""The rule-based risk score engine.

This module is deliberately the only place that decides what a signal is
*worth*. The checkers report facts -- "not on PyPI", "archived", "one edit from
requests" -- and this engine turns facts into points. Nothing here performs
I/O, so the whole engine is a pure function of its three inputs and can be
re-tuned against a list of real package names in a unit test, with no network,
no mocks, and no changes to any checker.

That separation is the point. Weighting a missing repository against a high
similarity score is exactly the kind of decision that only gets right once
there is a working system to test against, and the weights live in
:class:`app.config.RiskWeights` so tuning is a config change rather than an
edit to scoring logic.

Explainability
--------------
Every point that lands in the final score comes from a named rule that also
produces a sentence. A developer reading "no matching GitHub repository, 92%
similar to requests" can act immediately; a developer reading "risk: 74"
cannot. In a security tool, a warning nobody understands is a warning that
gets dismissed, so the explanation is a required output, not a debug aid.
"""

from __future__ import annotations

from datetime import datetime, timezone

from ..config import RiskThresholds, RiskWeights, settings
from ..schemas.risk import (
    GitHubCheckResult,
    GitHubRepoStatus,
    PyPICheckResult,
    RiskAssessment,
    RiskSignal,
    Severity,
    SimilarityResult,
)

__all__ = ["assess", "severity_for"]


def severity_for(score: int, thresholds: RiskThresholds | None = None) -> Severity:
    """Map a 0-100 score onto the three severities the UI renders."""
    limits = thresholds or settings.thresholds
    if score >= limits.high_risk_at:
        return Severity.HIGH_RISK
    if score >= limits.caution_at:
        return Severity.CAUTION
    return Severity.SAFE


def _days_since(moment: datetime | None) -> int | None:
    if moment is None:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return max(0, (datetime.now(timezone.utc) - moment).days)


class _SignalCollector:
    """Accumulates fired rules so the score and the explanation stay in sync.

    Both outputs are built from the same list by construction, which rules out
    the failure mode where the score says one thing and the explanation says
    another.
    """

    def __init__(self, weights: RiskWeights) -> None:
        self.weights = weights
        self.signals: list[RiskSignal] = []

    def fire(self, rule_id: str, message: str) -> None:
        """Record a rule whose points come from the configured weights."""
        points = int(getattr(self.weights, rule_id))
        self.signals.append(RiskSignal(rule_id=rule_id, points=points, message=message))

    def note(self, rule_id: str, message: str) -> None:
        """Record a zero-point observation.

        Used for things the developer should read but that must not move the
        score -- above all "GitHub was unreachable", which is an absence of
        evidence, not evidence of risk.
        """
        self.signals.append(RiskSignal(rule_id=rule_id, points=0, message=message))

    @property
    def total(self) -> int:
        return sum(signal.points for signal in self.signals)


# ---------------------------------------------------------------------------
# Individual rule groups
# ---------------------------------------------------------------------------


def _score_similarity(
    collector: _SignalCollector,
    package_name: str,
    similarity: SimilarityResult | None,
) -> None:
    """Typosquatting rules."""
    if similarity is None or not similarity.is_typosquat_suspect:
        return

    nearest = similarity.nearest_package
    distance = similarity.edit_distance
    percent = round((similarity.similarity_score or 0.0) * 100)

    if distance == 1:
        collector.fire(
            "typosquat_distance_1",
            f"'{package_name}' is a single character away from '{nearest}' "
            f"({percent}% similar), a widely used package. This is the exact "
            "pattern typosquatting relies on -- confirm you did not mean "
            f"'{nearest}'.",
        )
    elif distance == 2:
        collector.fire(
            "typosquat_distance_2",
            f"'{package_name}' is two edits away from '{nearest}' "
            f"({percent}% similar), a widely used package. Confirm this is the "
            "package you intended.",
        )


def _score_pypi_metadata(
    collector: _SignalCollector,
    pypi: PyPICheckResult,
) -> None:
    """Registry trust signals for a package that does exist."""
    metadata = pypi.metadata
    if metadata is None:
        return

    age_days = _days_since(metadata.first_release_date)
    if age_days is not None and age_days <= settings.package_new_within_days:
        collector.fire(
            "package_very_new",
            f"First published {age_days} day(s) ago. Newly registered names "
            "are common for both hallucination-bait and squatted packages.",
        )

    if metadata.version_count == 1:
        collector.fire(
            "single_release_only",
            "Only one release has ever been published, so there is no "
            "maintenance track record to judge.",
        )

    if not metadata.has_attribution:
        collector.fire(
            "no_author_or_maintainer",
            "The PyPI listing names no author or maintainer, in any field.",
        )


def _score_github(
    collector: _SignalCollector,
    github: GitHubCheckResult | None,
    typosquat_suspected: bool = False,
) -> None:
    """Repository linkage and health rules.

    ``typosquat_suspected`` suppresses the mitigating rule only. A healthy
    repository is evidence about how well a project is maintained; it is not
    evidence about whether its *name* is impersonating another package, and a
    squatter can trivially point their listing at the victim's repository (or
    farm stars on their own). Letting repository health discount a name-based
    finding would soften exactly the case the check exists to catch.
    """
    if github is None:
        return

    if github.status is GitHubRepoStatus.UNAVAILABLE:
        # Explicitly zero points. Scoring an unreachable GitHub as risky would
        # flag half the ecosystem during an outage; scoring it as safe would
        # hide real problems. Say so instead, and let the developer weigh it.
        collector.note(
            "github_unavailable",
            github.detail
            or "GitHub could not be reached, so repository health is unknown.",
        )
        return

    if github.status is GitHubRepoStatus.NO_REPOSITORY_LINK:
        collector.fire(
            "no_repository_link",
            "The PyPI listing links no GitHub source repository, so the code "
            "being installed cannot be inspected before it runs.",
        )
        return

    if github.status is GitHubRepoStatus.NOT_FOUND:
        collector.fire(
            "repository_link_broken",
            github.detail
            or "The linked source repository does not exist or is private.",
        )
        return

    repo = github.repo
    if repo is None:  # pragma: no cover - OK always carries a repo
        return

    if repo.archived or repo.disabled:
        state = "archived" if repo.archived else "disabled"
        collector.fire(
            "repository_archived",
            f"The source repository {repo.full_name} is {state} on GitHub -- "
            "it is no longer maintained and will not receive security fixes.",
        )

    if github.matches_package is False:
        collector.fire(
            "repository_name_mismatch",
            github.match_reason
            or "The linked repository does not appear to belong to this package.",
        )

    if repo.is_fork:
        collector.fire(
            "repository_is_fork",
            f"{repo.full_name} is a fork rather than the original project.",
        )

    days = github.days_since_last_commit
    if days is not None and not repo.archived:
        if days > settings.repo_stale_after_days:
            collector.fire(
                "repository_stale",
                f"No commits in {days} days ({days // 365} year(s)) -- the "
                "project looks abandoned.",
            )
        elif days > settings.repo_aging_after_days:
            collector.fire(
                "repository_aging",
                f"Last commit was {days} days ago; development has slowed.",
            )

    if repo.stars == 0:
        collector.fire(
            "repository_no_stars",
            f"{repo.full_name} has no stars, so the project has no visible "
            "community adoption.",
        )
    elif repo.stars < settings.repo_few_stars_below:
        collector.fire(
            "repository_few_stars",
            f"{repo.full_name} has only {repo.stars} stars, indicating limited "
            "community adoption.",
        )

    # Mitigating evidence, so a healthy package's report explains why it is
    # considered safe instead of just showing an empty list.
    established = (
        not typosquat_suspected
        and repo.stars >= settings.repo_established_stars
        and days is not None
        and days <= settings.repo_aging_after_days
        and not repo.archived
        and github.matches_package is not False
    )
    if established:
        collector.fire(
            "well_established_repository",
            f"{repo.full_name} is actively maintained with {repo.stars:,} "
            f"stars and a commit in the last {days} days.",
        )


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def assess(
    package_name: str,
    pypi: PyPICheckResult,
    github: GitHubCheckResult | None = None,
    similarity: SimilarityResult | None = None,
    weights: RiskWeights | None = None,
    thresholds: RiskThresholds | None = None,
) -> RiskAssessment:
    """Combine the check outputs into a score plus a human-readable rationale.

    Args:
        package_name: The name as the developer wrote it (used in messages).
        pypi: Registry existence and metadata. Required -- it is the spine of
            the assessment.
        github: Repository health, or ``None`` if the check did not run.
        similarity: Typosquat comparison, or ``None`` if it did not run.
        weights: Override the configured weights. This is the tuning seam:
            tests sweep weights over real package names without touching any
            checker.
        thresholds: Override the severity boundaries.

    Returns:
        A :class:`RiskAssessment` whose ``signals`` sum to ``final_score``
        (before clamping to 0-100).
    """
    collector = _SignalCollector(weights or settings.risk)

    # A name that is not in the registry is the strongest signal available and
    # ends the assessment: there is no repository to inspect and no metadata to
    # weigh. The similarity result is still reported, because "does not exist,
    # and it is one edit from requests" is the single most useful thing we can
    # tell a developer looking at an AI suggestion.
    if not pypi.exists:
        collector.fire(
            "package_not_on_pypi",
            f"'{package_name}' was not found on PyPI. It may be a hallucinated "
            "package name that does not exist -- do not install it.",
        )
        if similarity is not None and similarity.is_typosquat_suspect:
            collector.note(
                "hallucination_near_match",
                f"The closest real package is '{similarity.nearest_package}' "
                f"({round((similarity.similarity_score or 0) * 100)}% similar) "
                "-- that is most likely what was intended.",
            )
        return _finalize(collector, thresholds)

    typosquat_suspected = bool(similarity and similarity.is_typosquat_suspect)

    _score_similarity(collector, package_name, similarity)
    _score_github(collector, github, typosquat_suspected=typosquat_suspected)
    _score_pypi_metadata(collector, pypi)

    if not collector.signals:
        collector.note(
            "no_risk_signals",
            f"'{package_name}' exists on PyPI and no risk signals were raised.",
        )

    return _finalize(collector, thresholds)


def _finalize(
    collector: _SignalCollector,
    thresholds: RiskThresholds | None,
) -> RiskAssessment:
    """Clamp the total and order the explanation by impact."""
    score = max(0, min(100, collector.total))

    # Strongest signal first: that is the line the inline warning shows when it
    # only has room for one.
    signals = sorted(collector.signals, key=lambda s: (-abs(s.points), s.rule_id))

    return RiskAssessment(
        final_score=score,
        severity=severity_for(score, thresholds),
        signals=signals,
    )
