"""Backend tests for the provider-copy plugin (``dashboard/plugin_api.py``).

Runs against a fabricated HERMES_HOME (tmp) so the copy is exercised end to
end without touching real profiles:

    /path/to/hermes/venv/bin/python -m pytest tests/ -q
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from starlette.requests import Request

HERE = Path(__file__).resolve().parents[1]
API_FILE = HERE / "dashboard" / "plugin_api.py"


def _load_api():
    spec = importlib.util.spec_from_file_location("provider_copy_plugin_api", API_FILE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _request(query: str = "") -> Request:
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/",
            "root_path": "",
            "scheme": "http",
            "query_string": query.encode(),
            "headers": [],
            "client": ("127.0.0.1", 1234),
            "server": ("127.0.0.1", 8000),
        }
    )


@pytest.fixture()
def world(tmp_path, monkeypatch):
    home = tmp_path / "hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))

    (home / "config.yaml").write_text("plugins:\n  enabled:\n    - provider-copy\n", encoding="utf-8")
    (home / ".env").write_text(
        "GLM_API_KEY=glm-secret-123\n"
        "OPENCODE_GO_API_KEY=oc-secret-456\n"
        "MINIMAX_API_KEY=mini-secret-789\n"
        "TELEGRAM_BOT_TOKEN=telegram-secret\n"
        "HERMES_MAX_ITERATIONS=40\n",
        encoding="utf-8",
    )
    for name, env in {
        "alpha": "ANTHROPIC_API_KEY=alpha-own\n",
        "beta": "GLM_API_KEY=old-glm\nANTHROPIC_API_KEY=keep\n",
        "gamma": "",
        "epsilon": "HERMES_MAX_ITERATIONS=5\n",
    }.items():
        profile = home / "profiles" / name
        profile.mkdir(parents=True)
        (profile / ".env").write_text(env, encoding="utf-8")

    return SimpleNamespace(home=home, api=_load_api())


def _read_env(home: Path, profile: str | None = None) -> dict:
    path = (home / ".env") if profile is None else (home / "profiles" / profile / ".env")
    out = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            out[key.strip()] = value.strip()
    return out


def test_overview_selects_provider_keys_and_excludes_channels(world):
    overview = world.api.overview(_request())
    assert overview["source"] == "default"
    assert overview["keys"] == ["GLM_API_KEY", "MINIMAX_API_KEY", "OPENCODE_GO_API_KEY"]
    assert "TELEGRAM_BOT_TOKEN" not in overview["keys"]
    assert "HERMES_MAX_ITERATIONS" not in overview["keys"]


def test_overview_lists_profiles_and_marks_missing(world):
    overview = world.api.overview(_request())
    names = sorted(p["name"] for p in overview["profiles"])
    assert names == ["alpha", "beta", "default", "epsilon", "gamma"]
    targets = {t["name"]: t for t in overview["targets"]}
    assert "default" not in targets
    assert targets["beta"]["present"] == ["GLM_API_KEY"]
    assert sorted(targets["beta"]["missing"]) == ["MINIMAX_API_KEY", "OPENCODE_GO_API_KEY"]
    assert len(targets["alpha"]["missing"]) == 3


def test_copy_fills_missing_and_reports_per_target(world):
    result = world.api.copy(
        _request(),
        {"source": "default", "targets": ["alpha", "beta", "gamma"], "overwrite": False},
    )
    by = {r["profile"]: r for r in result["results"]}
    assert sorted(by) == ["alpha", "beta", "gamma"]
    assert sorted(by["alpha"]["copied"]) == ["GLM_API_KEY", "MINIMAX_API_KEY", "OPENCODE_GO_API_KEY"]
    assert by["beta"]["skipped"] == ["GLM_API_KEY"]
    assert sorted(by["beta"]["copied"]) == ["MINIMAX_API_KEY", "OPENCODE_GO_API_KEY"]
    assert not by["gamma"]["failed"]

    alpha = _read_env(world.home, "alpha")
    assert alpha["GLM_API_KEY"] == "glm-secret-123"
    assert alpha["ANTHROPIC_API_KEY"] == "alpha-own"
    assert "TELEGRAM_BOT_TOKEN" not in alpha

    beta = _read_env(world.home, "beta")
    assert beta["GLM_API_KEY"] == "old-glm"  # fill-missing keeps the local value
    assert beta["MINIMAX_API_KEY"] == "mini-secret-789"
    assert beta["OPENCODE_GO_API_KEY"] == "oc-secret-456"


def test_copy_overwrite_replaces_existing(world):
    result = world.api.copy(_request(), {"source": "default", "targets": ["beta"], "overwrite": True})
    assert sorted(result["results"][0]["copied"]) == ["GLM_API_KEY", "MINIMAX_API_KEY", "OPENCODE_GO_API_KEY"]
    assert _read_env(world.home, "beta")["GLM_API_KEY"] == "glm-secret-123"


def test_copy_rejects_bad_requests(world):
    from fastapi import HTTPException

    for body in (
        {"source": "default", "targets": ["nope"], "overwrite": False},
        {"source": "default", "targets": [], "overwrite": False},
        {"source": "default", "targets": ["default"], "overwrite": False},
    ):
        with pytest.raises(HTTPException) as excinfo:
            world.api.copy(_request(), body)
        assert excinfo.value.status_code == 400


def test_keyless_source_copies_nothing(world):
    result = world.api.copy(_request(), {"source": "epsilon", "targets": ["alpha"], "overwrite": False})
    assert result["source"] == "epsilon"
    assert result["keys"] == []
    assert result["results"][0]["copied"] == []
    assert result["results"][0]["skipped"] == []


def test_profile_query_defaults_the_source(world):
    overview = world.api.overview(_request("profile=beta"))
    assert overview["source"] == "beta"


def test_values_never_return_in_overview_or_copy(world):
    overview = world.api.overview(_request())
    result = world.api.copy(_request(), {"source": "default", "targets": ["alpha"], "overwrite": True})
    blob = json.dumps(overview) + json.dumps(result)
    for secret in ("glm-secret-123", "oc-secret-456", "mini-secret-789", "telegram-secret"):
        assert secret not in blob
