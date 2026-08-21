from fastapi import FastAPI
from pydantic import BaseModel
from typing import Optional

app = FastAPI(title="Blueberry Mock Backend")

class CheckRequest(BaseModel):
    name: str
    version: Optional[str] = None
    ecosystem: str = "pypi"

FIXTURES = {
    "reqeusts": {
        "exists_on_registry": False,
        "risk_score": 92,
        "severity": "high",
        "reasons": [
            "Package not found on PyPI",
            "98% similarity to popular package 'requests'"
        ]
    },
    "flask": {
        "exists_on_registry": True,
        "risk_score": 5,
        "severity": "safe",
        "reasons": [
            "Verified on PyPI",
            "Active GitHub repository with recent commits"
        ]
    }
}

DEFAULT_FIXTURE = {
    "exists_on_registry": True,
    "risk_score": 45,
    "severity": "caution",
    "reasons": [
        "No matching GitHub repository found",
        "Low download count for its age"
    ]
}

@app.post("/check")
def check_package(req: CheckRequest):
    fixture = FIXTURES.get(req.name.lower(), DEFAULT_FIXTURE)
    return {"package": req.name, **fixture}