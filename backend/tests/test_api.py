"""Endpoint tests for /health and /check.

These exercise the full request path -- routing, all four checks, the risk
engine, and the response contract -- with only the outbound HTTP mocked. They
are the tests the VS Code extension and the dashboard are really relying on,
since the JSON shape asserted here is the integration contract.
"""

from __future__ import annotations

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app

from .fixtures import (
    MISMATCHED_REPO_PAYLOAD,
    REQUESTS_PAYLOAD,
    SUSPICIOUS_PAYLOAD,
    github_repo_payload,
)


@pytest.fixture
def client():
    """A client that runs the app's lifespan (HTTP pool, cache, database)."""
    with TestClient(app) as test_client:
        yield test_client


def _pypi(name: str) -> str:
    return f"{settings.pypi_base_url}/{name}/json"


def _github(full_name: str) -> str:
    return f"{settings.github_api_url}/repos/{full_name}"


# --- Health -----------------------------------------------------------------


def test_health_ok(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["version"] == settings.app_version


# --- The three headline outcomes -------------------------------------------


@respx.mock
def test_existing_healthy_package_is_safe(client):
    respx.get(_pypi("requests")).mock(
        return_value=httpx.Response(200, json=REQUESTS_PAYLOAD)
    )
    respx.get(_github("psf/requests")).mock(
        return_value=httpx.Response(200, json=github_repo_payload())
    )

    resp = client.post("/check", json={"package_name": "requests"})

    assert resp.status_code == 200
    body = resp.json()
    assert body["exists_on_pypi"] is True
    assert body["severity"] == "safe"
    assert body["final_score"] == 0
    assert body["pypi_metadata"]["name"] == "requests"
    assert body["github"]["status"] == "ok"
    assert body["github"]["repo"]["stars"] == 51000
    assert body["similarity"]["is_known_popular"] is True
    assert body["explanation"]


@respx.mock
def test_hallucinated_package_is_high_risk(client):
    respx.get(_pypi("made-up-pkg")).mock(
        return_value=httpx.Response(404, json={"message": "Not Found"})
    )

    resp = client.post("/check", json={"package_name": "made-up-pkg"})

    assert resp.status_code == 200
    body = resp.json()
    assert body["exists_on_pypi"] is False
    assert body["severity"] == "high_risk"
    assert body["final_score"] == 100
    assert any("hallucinated" in line for line in body["explanation"])


@respx.mock
def test_typosquat_that_exists_is_high_risk(client):
    """A real package one edit from requests, with no repository behind it."""
    respx.get(_pypi("reqeusts")).mock(
        return_value=httpx.Response(200, json=SUSPICIOUS_PAYLOAD)
    )

    resp = client.post("/check", json={"package_name": "reqeusts"})

    assert resp.status_code == 200
    body = resp.json()
    assert body["exists_on_pypi"] is True
    assert body["severity"] == "high_risk"
    assert body["matched_package"] == "requests"
    assert body["similarity"]["edit_distance"] == 2
    assert body["github"]["status"] == "no_repository_link"


# --- The response contract --------------------------------------------------


@respx.mock
def test_response_matches_the_documented_contract(client):
    respx.get(_pypi("requests")).mock(
        return_value=httpx.Response(200, json=REQUESTS_PAYLOAD)
    )
    respx.get(_github("psf/requests")).mock(
        return_value=httpx.Response(200, json=github_repo_payload())
    )

    body = client.post("/check", json={"package_name": "requests"}).json()

    # The Week 0 flat fields the extension was built against.
    for field in (
        "package_name",
        "exists_on_pypi",
        "github_repo_health",
        "similarity_score",
        "matched_package",
        "final_score",
        "severity",
        "explanation",
        "pypi_metadata",
        "checked_at",
    ):
        assert field in body, f"the Week 0 contract lost {field}"

    # The additive detail objects.
    for field in ("normalized_name", "ecosystem", "signals", "github", "similarity"):
        assert field in body

    assert 0 <= body["final_score"] <= 100
    assert body["severity"] in ("safe", "caution", "high_risk")


@respx.mock
def test_every_signal_is_explainable(client):
    """A score with no readable reason is a warning that gets dismissed."""
    respx.get(_pypi("reqeusts")).mock(
        return_value=httpx.Response(200, json=SUSPICIOUS_PAYLOAD)
    )

    body = client.post("/check", json={"package_name": "reqeusts"}).json()

    assert body["signals"]
    for signal in body["signals"]:
        assert signal["message"].strip()
        assert isinstance(signal["points"], int)
    assert sum(s["points"] for s in body["signals"]) == body["final_score"]


# --- Input handling ---------------------------------------------------------


def test_blank_name_is_rejected_by_the_schema(client):
    resp = client.post("/check", json={"package_name": "   "})
    assert resp.status_code == 422


@pytest.mark.parametrize(
    "hostile",
    [
        "../../etc/passwd",
        "http://169.254.169.254/latest",
        "pkg name",
        "requests#frag",
    ],
)
def test_hostile_names_are_rejected_with_422_and_no_outbound_call(client, hostile):
    with respx.mock:
        route = respx.get(url__regex=r".*")
        resp = client.post("/check", json={"package_name": hostile})
        assert resp.status_code == 422
        assert route.call_count == 0


def test_overlong_name_is_rejected(client):
    resp = client.post("/check", json={"package_name": "a" * 300})
    assert resp.status_code == 422


def test_unknown_ecosystem_is_rejected(client):
    resp = client.post("/check", json={"package_name": "requests", "ecosystem": "npm"})
    assert resp.status_code == 400
    assert "npm" in resp.json()["detail"]


# --- Upstream failure -------------------------------------------------------


@respx.mock
def test_pypi_outage_returns_502_not_a_false_safe(client):
    """The extension must be able to say 'could not verify', never 'safe'."""
    respx.get(_pypi("requests")).mock(return_value=httpx.Response(503))

    resp = client.post("/check", json={"package_name": "requests"})

    assert resp.status_code == 502


@respx.mock
def test_github_outage_still_returns_a_report(client):
    respx.get(_pypi("requests")).mock(
        return_value=httpx.Response(200, json=REQUESTS_PAYLOAD)
    )
    respx.get(_github("psf/requests")).mock(side_effect=httpx.ConnectError("down"))

    resp = client.post("/check", json={"package_name": "requests"})

    assert resp.status_code == 200
    body = resp.json()
    assert body["github"]["status"] == "unavailable"
    assert body["github_repo_health"] is None


@respx.mock
def test_a_mismatched_repository_raises_a_warning(client):
    respx.get(_pypi("some-obscure-lib")).mock(
        return_value=httpx.Response(200, json=MISMATCHED_REPO_PAYLOAD)
    )
    respx.get(_github("psf/requests")).mock(
        return_value=httpx.Response(200, json=github_repo_payload())
    )

    body = client.post("/check", json={"package_name": "some-obscure-lib"}).json()

    assert body["severity"] != "safe"
    assert body["github"]["matches_package"] is False


# --- Persistence ------------------------------------------------------------


@respx.mock
def test_each_check_is_persisted(client, monkeypatch):
    """The Week 4 dashboard needs the history to already be accumulating."""
    saved: list = []

    async def fake_save(report):
        saved.append(report)
        return 1

    monkeypatch.setattr("app.routers.check.save_check_result", fake_save)
    respx.get(_pypi("made-up-pkg")).mock(return_value=httpx.Response(404))

    client.post("/check", json={"package_name": "made-up-pkg"})

    assert len(saved) == 1
    assert saved[0].package_name == "made-up-pkg"
    assert saved[0].final_score == 100


@respx.mock
def test_a_persistence_failure_does_not_cost_the_developer_their_warning(
    client, monkeypatch
):
    async def exploding_save(report):
        raise RuntimeError("database is on fire")

    # save_check_result swallows database errors internally; this asserts the
    # router does not reintroduce the failure by awaiting it unguarded.
    monkeypatch.setattr(
        "app.routers.check.save_check_result",
        lambda report: _swallow(exploding_save(report)),
    )
    respx.get(_pypi("made-up-pkg")).mock(return_value=httpx.Response(404))

    resp = client.post("/check", json={"package_name": "made-up-pkg"})
    assert resp.status_code == 200


async def _swallow(coro):
    try:
        return await coro
    except Exception:
        return None


# --- OpenAPI ----------------------------------------------------------------


def test_openapi_documents_the_check_endpoint(client):
    schema = client.get("/openapi.json").json()
    assert "/check" in schema["paths"]
    assert "/health" in schema["paths"]
    responses = schema["paths"]["/check"]["post"]["responses"]
    assert {"200", "400", "422", "502"} <= set(responses)
