"""``POST /check`` -- verify a single package and return a RiskReport.

The router stays thin on purpose: validate the request, run the pipeline,
persist the outcome, return the report. All four checks and every scoring
decision live in :mod:`app.services`, which is what lets them be tested
without going through HTTP.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request, status

from ..db.repository import save_check_result
from ..schemas.risk import CheckRequest, RiskReport
from ..security.validation import InvalidPackageName
from ..services.pipeline import run_pipeline
from ..services.pypi_checker import PyPIServiceError

logger = logging.getLogger(__name__)

# Starlette renamed HTTP_422_UNPROCESSABLE_ENTITY to ..._CONTENT and deprecated
# the old name, but the new one does not exist on the versions this project
# still supports. The numeric code is stable across both, and it is the same
# 422 FastAPI already returns for request-body validation failures.
HTTP_422_UNPROCESSABLE = 422

router = APIRouter(tags=["check"])


@router.post(
    "/check",
    response_model=RiskReport,
    summary="Verify a package and return its risk report",
    responses={
        400: {"description": "Unsupported ecosystem"},
        422: {"description": "The package name failed validation"},
        502: {"description": "PyPI could not be reached"},
    },
)
async def check_package(payload: CheckRequest, request: Request) -> RiskReport:
    """Run every verification check for one package name and score the result."""
    if payload.ecosystem != "pypi":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"ecosystem '{payload.ecosystem}' is not supported yet (pypi only).",
        )

    # Reuse the app-wide HTTP client when the lifespan created one, so PyPI and
    # GitHub connections are pooled across requests rather than per request.
    client = getattr(request.app.state, "http_client", None)

    try:
        report = await run_pipeline(
            payload.package_name,
            ecosystem=payload.ecosystem,
            client=client,
        )
    except InvalidPackageName as exc:
        raise HTTPException(
            status_code=HTTP_422_UNPROCESSABLE,
            detail=str(exc),
        ) from exc
    except PyPIServiceError as exc:
        # Upstream registry problem -- surface as 502, not a 500. The extension
        # can then say "could not verify" instead of "safe", which is the whole
        # point of not failing open in a security tool.
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc

    # Best effort, and deliberately after the report exists: a persistence
    # failure must not cost the developer their warning.
    await save_check_result(report)

    return report
