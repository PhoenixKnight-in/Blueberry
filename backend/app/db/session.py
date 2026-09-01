"""Async SQLAlchemy engine and session management.

The engine is created lazily on first use, so importing the app -- in a test,
in a CLI, in the OpenAPI generator -- never opens a database connection.

Like the cache, the database is treated as non-essential to answering a check:
if Postgres is down the verification still runs and the developer still gets a
warning; only the history is lost. That tradeoff is deliberate. This is a tool
sitting in an editor's completion path, and refusing to tell someone a package
is hallucinated because an audit row could not be written would be the wrong
call.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from ..config import settings
from .models import Base

logger = logging.getLogger(__name__)

_engine: AsyncEngine | None = None
_sessionmaker: async_sessionmaker[AsyncSession] | None = None


def get_engine() -> AsyncEngine:
    """Return the process-wide async engine, creating it on first call."""
    global _engine
    if _engine is None:
        _engine = create_async_engine(
            settings.database_url,
            echo=settings.database_echo,
            pool_pre_ping=True,  # survive a Postgres restart without a 500.
            future=True,
        )
    return _engine


def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    """Return the process-wide session factory."""
    global _sessionmaker
    if _sessionmaker is None:
        _sessionmaker = async_sessionmaker(
            bind=get_engine(),
            expire_on_commit=False,  # objects stay usable after commit.
            class_=AsyncSession,
        )
    return _sessionmaker


@asynccontextmanager
async def get_session() -> AsyncIterator[AsyncSession]:
    """Yield a session, committing on success and rolling back on error."""
    factory = get_sessionmaker()
    async with factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def init_db() -> bool:
    """Create tables if they do not exist. Returns True on success.

    A convenience for local development and the demo. Production migrations are
    Alembic's job -- this only ever adds missing tables and never alters an
    existing one.
    """
    if not settings.persistence_enabled or not settings.database_auto_create:
        return False
    try:
        engine = get_engine()
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        logger.info("Database schema ready.")
        return True
    except (SQLAlchemyError, OSError) as exc:
        logger.warning(
            "Could not initialise the database (%s); checks will still run, "
            "but results will not be persisted.",
            exc,
        )
        return False


async def shutdown_db() -> None:
    """Dispose of the engine's connection pool (called from the lifespan)."""
    global _engine, _sessionmaker
    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _sessionmaker = None


def reset_engine_for_tests() -> None:
    """Drop the cached engine so a test can point at a different database."""
    global _engine, _sessionmaker
    _engine = None
    _sessionmaker = None
