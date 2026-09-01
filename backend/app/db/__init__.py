"""Postgres persistence for check results.

Every ``POST /check`` is written here, which is what makes the Week 4 dashboard
possible: listing and filtering historical results needs the history to already
exist by the time that endpoint is built. Storing the full report (score,
severity, explanation, and the raw signals) rather than just PyPI metadata also
means a scoring change can be evaluated against what the engine actually said
at the time.
"""

from .models import Base, CheckResultRecord
from .repository import list_check_results, save_check_result
from .session import get_session, init_db, shutdown_db

__all__ = [
    "Base",
    "CheckResultRecord",
    "get_session",
    "init_db",
    "list_check_results",
    "save_check_result",
    "shutdown_db",
]
