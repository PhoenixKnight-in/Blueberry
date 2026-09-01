"""Pydantic schemas -- the shared API contract (Week 0, extended in Week 2)."""

from .risk import (
    CheckRequest,
    GitHubCheckResult,
    GitHubRepoInfo,
    GitHubRepoStatus,
    PyPICheckResult,
    PyPIMetadata,
    RiskAssessment,
    RiskReport,
    RiskSignal,
    Severity,
    SimilarityMatch,
    SimilarityResult,
)

__all__ = [
    "CheckRequest",
    "GitHubCheckResult",
    "GitHubRepoInfo",
    "GitHubRepoStatus",
    "PyPICheckResult",
    "PyPIMetadata",
    "RiskAssessment",
    "RiskReport",
    "RiskSignal",
    "Severity",
    "SimilarityMatch",
    "SimilarityResult",
]
