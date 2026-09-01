"""The verification pipeline: all four checks, one report.

Execution order is dictated by the dependency graph, not by the order the
checks are listed anywhere:

    similarity ──┐
                 ├──> risk engine ──> RiskReport ──> Postgres
    PyPI ────────┴──> GitHub ────────┘

Similarity and PyPI are independent, so they run **concurrently** with
``asyncio.gather``. GitHub cannot: the repository URL it inspects comes out of
the PyPI metadata, so it is a genuine data dependency and must follow.

Running the independent pair concurrently instead of sequentially is the actual
payoff of choosing an async framework -- the request costs one round trip
rather than two, and adding a fifth independent check later costs nothing.
Sharing a single ``httpx.AsyncClient`` across them matters for the same reason:
connection pooling and TLS reuse across PyPI and GitHub.

The pipeline also decides what happens when a check fails. Similarity cannot
fail. PyPI failing is fatal to the report -- there is nothing to say about a
package we could not look up. GitHub failing is not: it degrades to "unknown",
which the risk engine scores as zero points rather than guessing.
"""

from __future__ import annotations

import asyncio
import logging
import time

import httpx

from ..config import settings
from ..schemas.risk import (
    GitHubCheckResult,
    PyPICheckResult,
    RiskReport,
    SimilarityResult,
)
from ..security.validation import canonicalize_package_name, validate_package_name
from . import risk_engine
from .github_checker import check_github
from .pypi_checker import PyPIServiceError, check_pypi
from .similarity import check_similarity

logger = logging.getLogger(__name__)

__all__ = ["run_pipeline", "build_report"]


async def _run_similarity(package_name: str) -> SimilarityResult:
    """Run the (synchronous, in-process) similarity check off the event loop.

    The corpus is small enough that this takes well under a millisecond, but
    ``to_thread`` keeps a pure-CPU loop out of the event loop so it cannot
    stall the concurrent PyPI request -- and it stays correct if the corpus
    grows to thousands of names later.
    """
    return await asyncio.to_thread(check_similarity, package_name)


async def run_pipeline(
    package_name: str,
    ecosystem: str = "pypi",
    client: httpx.AsyncClient | None = None,
    use_cache: bool = True,
) -> RiskReport:
    """Run every available check for one package and score the result.

    Args:
        package_name: The untrusted name to verify.
        ecosystem: Currently only ``pypi``; recorded on the report.
        client: Optional shared HTTP client, reused across both outbound calls.
        use_cache: Set False to bypass Redis for both registry lookups.

    Returns:
        A fully populated :class:`RiskReport`.

    Raises:
        InvalidPackageName: if the name fails validation (before any I/O).
        PyPIServiceError: if the registry itself could not be reached.
    """
    started = time.perf_counter()

    # Validate once, up front, for the whole pipeline. Nothing downstream
    # builds a URL from a name that has not been through here.
    name = validate_package_name(package_name)
    normalized = canonicalize_package_name(name)

    owns_client = client is None
    if client is None:
        client = httpx.AsyncClient(timeout=settings.http_timeout)

    try:
        # --- Stage 1: the independent checks, concurrently -----------------
        pypi_result, similarity_result = await asyncio.gather(
            check_pypi(name, client=client, use_cache=use_cache),
            _run_similarity(name),
        )

        # --- Stage 2: the check that depends on stage 1 --------------------
        github_result: GitHubCheckResult | None = None
        if pypi_result.exists:
            github_result = await check_github(
                name,
                pypi_result.metadata,
                client=client,
                use_cache=use_cache,
            )
        # A package that is not on PyPI has no metadata and therefore no
        # repository to resolve -- skipping the call saves a pointless round
        # trip and, more importantly, a slot in the GitHub rate-limit budget.
    finally:
        if owns_client:
            await client.aclose()

    duration_ms = int((time.perf_counter() - started) * 1000)

    return build_report(
        package_name=name,
        normalized_name=normalized,
        ecosystem=ecosystem,
        pypi=pypi_result,
        github=github_result,
        similarity=similarity_result,
        duration_ms=duration_ms,
    )


def build_report(
    package_name: str,
    pypi: PyPICheckResult,
    normalized_name: str | None = None,
    ecosystem: str = "pypi",
    github: GitHubCheckResult | None = None,
    similarity: SimilarityResult | None = None,
    duration_ms: int | None = None,
) -> RiskReport:
    """Assemble the response from the check outputs plus the engine's verdict.

    Pure and synchronous, so the exact report the API returns can be asserted
    in a test from three hand-built check results and no I/O at all.
    """
    assessment = risk_engine.assess(
        package_name=package_name,
        pypi=pypi,
        github=github,
        similarity=similarity,
    )

    return RiskReport(
        package_name=package_name,
        normalized_name=normalized_name or canonicalize_package_name(package_name),
        ecosystem=ecosystem,
        exists_on_pypi=pypi.exists,
        github_repo_health=github.health_score if github else None,
        similarity_score=similarity.similarity_score if similarity else None,
        matched_package=(
            similarity.nearest_package
            if similarity and similarity.is_typosquat_suspect
            else None
        ),
        final_score=assessment.final_score,
        severity=assessment.severity,
        explanation=assessment.explanation,
        signals=assessment.signals,
        pypi_metadata=pypi.metadata,
        github=github,
        similarity=similarity,
        duration_ms=duration_ms,
    )
