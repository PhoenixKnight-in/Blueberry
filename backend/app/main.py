"""FastAPI application entrypoint.

Run locally with::

    uvicorn app.main:app --reload

from inside the ``backend/`` directory.

The lifespan owns the three process-wide resources -- the HTTP client, the
Redis pool, and the database engine -- so connections are created once and
pooled across requests instead of being rebuilt per check. None of the three is
allowed to prevent startup: a missing Redis or Postgres degrades the service
(no caching, no history) but the checks still run.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .db.session import init_db, shutdown_db
from .routers import check, health, packages
from .services.cache import cache

logging.basicConfig(
    level=logging.DEBUG if settings.environment == "development" else logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
)

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Open shared resources on startup, close them on shutdown."""
    app.state.http_client = httpx.AsyncClient(
        timeout=settings.http_timeout,
        # PyPI and GitHub are both hit on nearly every check; keeping the
        # connections warm removes a TLS handshake from the hot path.
        limits=httpx.Limits(max_connections=50, max_keepalive_connections=20),
    )

    if not settings.github_token:
        logger.warning(
            "No BLUEBERRY_GITHUB_TOKEN is set. GitHub allows only 60 "
            "unauthenticated requests per hour, so repository checks will "
            "start reporting 'unavailable' under load."
        )

    await init_db()

    try:
        yield
    finally:
        await app.state.http_client.aclose()
        await cache.close()
        await shutdown_db()


def create_app() -> FastAPI:
    """Application factory -- keeps app construction testable."""
    app = FastAPI(
        title=settings.app_name,
        version=settings.app_version,
        description=(
            "Verification backend for the Blueberry AI Dependency Validator. "
            "Runs four checks over a package name -- PyPI existence, GitHub "
            "repository health, Levenshtein typosquat similarity, and a "
            "rule-based risk engine -- and returns an explainable risk report."
        ),
        lifespan=lifespan,
    )

    # The dashboard runs on its own origin; without this the browser blocks
    # every call to /packages before it reaches the router.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PATCH", "OPTIONS"],
        allow_headers=["Content-Type"],
    )

    app.include_router(health.router)
    app.include_router(check.router)
    app.include_router(packages.router)

    return app


app = create_app()
