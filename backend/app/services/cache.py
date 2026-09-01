"""Redis cache in front of the PyPI and GitHub lookups.

Two things justify a cache here, both from the project's own tech-stack
rationale:

* **Repeat traffic.** A team all pulling the same AI suggestions checks
  ``requests`` and ``numpy`` over and over. Serving those from Redis keeps the
  inline warning fast enough to sit in an editor's completion path.
* **Rate-limit budget.** GitHub allows 5000 authenticated requests an hour.
  Spending that budget re-asking about the same twenty popular repositories is
  the fastest way to turn the checker into a source of false negatives.

**Cache failure is never check failure.** Every operation here degrades to a
miss if Redis is down or misconfigured. A cache outage should make the tool
slower, never make it stop verifying packages -- so the connection is created
lazily, errors are swallowed after one warning, and the caller cannot tell the
difference except in latency.
"""

from __future__ import annotations

import logging
from typing import Any, TypeVar

from redis import asyncio as aioredis
from redis.exceptions import RedisError

from ..config import settings

logger = logging.getLogger(__name__)

T = TypeVar("T")

#: Bumped when a cached payload's shape changes, so a deploy that changes the
#: schema does not read yesterday's incompatible JSON back out of Redis.
CACHE_SCHEMA_VERSION = "v1"

_KEY_PREFIX = "blueberry"


def make_key(namespace: str, identifier: str) -> str:
    """Build a namespaced cache key, e.g. ``blueberry:pypi:v1:requests``."""
    return f"{_KEY_PREFIX}:{namespace}:{CACHE_SCHEMA_VERSION}:{identifier}"


class RedisCache:
    """A thin, failure-tolerant async wrapper around Redis.

    Holds one lazily-created connection pool for the process. Deliberately not
    a context manager per call: the pool is shared for the app's lifetime and
    closed once on shutdown.
    """

    def __init__(self, url: str | None = None, enabled: bool | None = None) -> None:
        self._url = url if url is not None else settings.redis_url
        self._enabled = settings.cache_enabled if enabled is None else enabled
        self._client: aioredis.Redis | None = None
        self._degraded = False

    @property
    def enabled(self) -> bool:
        return self._enabled and not self._degraded

    async def _get_client(self) -> aioredis.Redis | None:
        if not self.enabled:
            return None
        if self._client is None:
            try:
                self._client = aioredis.from_url(
                    self._url,
                    encoding="utf-8",
                    decode_responses=True,
                    socket_connect_timeout=2,
                    socket_timeout=2,
                )
            except (RedisError, ValueError) as exc:
                self._mark_degraded(exc)
                return None
        return self._client

    def _mark_degraded(self, exc: Exception) -> None:
        """Log once, then stop trying -- a noisy log is its own outage."""
        if not self._degraded:
            logger.warning(
                "Redis cache unavailable (%s); continuing without caching. "
                "Checks still run, they just re-hit PyPI/GitHub every time.",
                exc,
            )
        self._degraded = True

    async def get(self, key: str) -> str | None:
        """Return the cached raw string, or ``None`` on a miss or any error."""
        client = await self._get_client()
        if client is None:
            return None
        try:
            return await client.get(key)
        except (RedisError, OSError) as exc:
            self._mark_degraded(exc)
            return None

    async def set(self, key: str, value: str, ttl: int) -> None:
        """Store ``value`` under ``key`` for ``ttl`` seconds. Best effort."""
        client = await self._get_client()
        if client is None or ttl <= 0:
            return
        try:
            await client.set(key, value, ex=ttl)
        except (RedisError, OSError) as exc:
            self._mark_degraded(exc)

    async def delete(self, key: str) -> None:
        """Drop a key (used by tests and by manual cache invalidation)."""
        client = await self._get_client()
        if client is None:
            return
        try:
            await client.delete(key)
        except (RedisError, OSError) as exc:
            self._mark_degraded(exc)

    async def get_model(self, key: str, model: type[T]) -> T | None:
        """Read a cached pydantic model, treating corrupt JSON as a miss.

        A cached value that no longer parses (an old schema, a truncated write)
        must not raise into a check -- it is simply a miss, and the fresh
        lookup overwrites it.
        """
        raw = await self.get(key)
        if raw is None:
            return None
        try:
            return model.model_validate_json(raw)  # type: ignore[attr-defined]
        except Exception as exc:  # noqa: BLE001 - any parse failure is a miss
            logger.debug("Discarding unparseable cache entry %s: %s", key, exc)
            return None

    async def set_model(self, key: str, value: Any, ttl: int) -> None:
        """Serialise and store a pydantic model."""
        try:
            payload = value.model_dump_json()
        except Exception as exc:  # noqa: BLE001 - never fail a check on this
            logger.debug("Could not serialise value for %s: %s", key, exc)
            return
        await self.set(key, payload, ttl)

    async def close(self) -> None:
        """Release the connection pool (called from the app lifespan)."""
        if self._client is not None:
            try:
                await self._client.aclose()
            except (RedisError, OSError):  # pragma: no cover - shutdown path
                pass
            finally:
                self._client = None


#: Process-wide cache instance. Imported by the checkers; replaceable in tests.
cache = RedisCache()
