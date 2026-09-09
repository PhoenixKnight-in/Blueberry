"""Dashboard endpoints -- the read side of the check history.

``POST /check`` writes one row per verification; everything here reads those
rows back. The split is deliberate: the extension only ever calls ``/check``
and never needs a database to be reachable, while the dashboard only ever
calls these and never triggers an outbound registry request. Neither client
can slow the other down.

Routes:

* ``GET  /packages``      -- paginated, filterable list (the table)
* ``GET  /packages/{id}`` -- one stored check in full (the detail view)
* ``PATCH /packages/{id}`` -- move a flag through open/ignored/resolved
* ``GET  /stats``         -- the summary strip above the table
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..db import repository
from ..db.session import session_dependency
from ..schemas.dashboard import (
    CheckDetail,
    CheckPage,
    CheckSummary,
    FlagStatus,
    StatsResponse,
    StatusUpdate,
)
from ..schemas.risk import Severity

logger = logging.getLogger(__name__)

router = APIRouter(tags=["dashboard"])

_DB_UNAVAILABLE = (
    "The check history is unavailable: the database could not be reached. "
    "Package verification itself is unaffected."
)


def _require_persistence() -> None:
    """Reject dashboard reads when history is switched off entirely.

    A 503 with an explanation beats an empty list, which the dashboard would
    render as the honest-looking but wrong "no packages have been checked yet".
    """
    if not settings.persistence_enabled:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Persistence is disabled, so there is no check history to read.",
        )


Session = Depends(session_dependency)


@router.get(
    "/packages",
    response_model=CheckPage,
    summary="List stored check results, newest first",
    responses={503: {"description": "History storage is unavailable"}},
)
async def list_packages(
    session: AsyncSession = Session,
    search: str | None = Query(
        default=None,
        max_length=214,
        description="Substring match on the package name.",
    ),
    package_name: str | None = Query(
        default=None,
        max_length=214,
        description="Exact match on the normalised package name.",
    ),
    severity: Severity | None = Query(default=None),
    flag_status: FlagStatus | None = Query(
        default=None,
        alias="status",
        description="Review state: open, ignored, or resolved.",
    ),
    min_score: int | None = Query(default=None, ge=0, le=100),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> CheckPage:
    """Return one page of stored checks, plus the total under the same filters."""
    _require_persistence()

    filters = {
        "package_name": package_name,
        "severity": severity.value if severity else None,
        "status": flag_status.value if flag_status else None,
        "min_score": min_score,
        "search": search,
    }

    try:
        records = await repository.list_check_results(
            session, limit=limit, offset=offset, **filters
        )
        total = await repository.count_check_results(session, **filters)
    except (SQLAlchemyError, OSError) as exc:
        logger.warning("Dashboard list query failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=_DB_UNAVAILABLE,
        ) from exc

    return CheckPage(
        items=[CheckSummary.from_record(record) for record in records],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.get(
    "/packages/{result_id}",
    response_model=CheckDetail,
    summary="Fetch one stored check in full",
    responses={
        404: {"description": "No stored check with that id"},
        503: {"description": "History storage is unavailable"},
    },
)
async def get_package(
    result_id: int,
    session: AsyncSession = Session,
) -> CheckDetail:
    """Return the complete stored report for one check, signals included."""
    _require_persistence()

    try:
        record = await repository.get_check_result(session, result_id)
    except (SQLAlchemyError, OSError) as exc:
        logger.warning("Dashboard detail query failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=_DB_UNAVAILABLE,
        ) from exc

    if record is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No stored check with id {result_id}.",
        )

    return CheckDetail.from_record(record)


@router.patch(
    "/packages/{result_id}",
    response_model=CheckDetail,
    summary="Triage a flagged package (open / ignored / resolved)",
    responses={
        404: {"description": "No stored check with that id"},
        503: {"description": "History storage is unavailable"},
    },
)
async def update_package_status(
    result_id: int,
    payload: StatusUpdate,
    session: AsyncSession = Session,
) -> CheckDetail:
    """Record a reviewer's decision about one flagged check.

    The score itself is never edited -- it is the output of the engine and
    reproducing it is the whole point. Only the review state moves, so the
    original verdict stays auditable next to the decision made about it.
    """
    _require_persistence()

    try:
        record = await repository.set_check_status(
            session, result_id, payload.status.value
        )
    except (SQLAlchemyError, OSError) as exc:
        logger.warning("Dashboard status update failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=_DB_UNAVAILABLE,
        ) from exc

    if record is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No stored check with id {result_id}.",
        )

    return CheckDetail.from_record(record)


@router.get(
    "/stats",
    response_model=StatsResponse,
    summary="Aggregate counts for the dashboard summary strip",
    responses={503: {"description": "History storage is unavailable"}},
)
async def get_stats(session: AsyncSession = Session) -> StatsResponse:
    """Return the handful of totals shown above the flagged-package table."""
    _require_persistence()

    try:
        raw = await repository.collect_stats(session)
    except (SQLAlchemyError, OSError) as exc:
        logger.warning("Dashboard stats query failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=_DB_UNAVAILABLE,
        ) from exc

    return StatsResponse.model_validate(raw)
