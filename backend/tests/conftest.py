"""Shared test setup.

The suite runs with no Redis and no Postgres container: the cache is pointed at
``fakeredis`` and the database at in-memory SQLite. That keeps the tests fast
and offline, and it means CI does not need the compose stack to verify the
scoring logic -- which is the part that will be edited most often.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.db.models import Base
from app.services.cache import RedisCache


@pytest.fixture(autouse=True)
def disable_cache(monkeypatch):
    """Default to a cache-free world.

    Most tests assert on what the checkers ask the network for, and a cache
    silently answering the second call would make those assertions lie. Tests
    that are specifically about caching opt back in via ``fake_cache``.
    """
    from app.services import cache as cache_module

    monkeypatch.setattr(cache_module.cache, "_enabled", False)
    monkeypatch.setattr(cache_module.cache, "_client", None)


@pytest.fixture
def fake_cache(monkeypatch):
    """Swap in a fakeredis-backed cache and return it."""
    import fakeredis.aioredis

    from app.services import cache as cache_module

    instance = RedisCache(enabled=True)
    instance._client = fakeredis.aioredis.FakeRedis(decode_responses=True)

    monkeypatch.setattr(cache_module, "cache", instance)
    monkeypatch.setattr("app.services.pypi_checker.cache", instance)
    monkeypatch.setattr("app.services.github_checker.cache", instance)
    return instance


@pytest.fixture(autouse=True)
def disable_persistence(monkeypatch):
    """Keep the API tests from reaching for a database."""
    monkeypatch.setattr("app.config.settings.persistence_enabled", False)


@pytest_asyncio.fixture
async def db_sessionmaker():
    """An in-memory SQLite database with the real schema applied.

    Same models, same DDL path as Postgres -- only the dialect differs, which
    is exactly why the JSON columns are declared with a ``JSONB`` variant
    rather than as raw ``JSONB``.
    """
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    factory = async_sessionmaker(bind=engine, expire_on_commit=False)
    try:
        yield factory
    finally:
        await engine.dispose()
