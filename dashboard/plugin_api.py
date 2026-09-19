"""Provider Copy — backend routes for the provider-copy desktop plugin.

Copies provider credentials — the ``provider``-category env vars (API keys and
their base-URL overrides) — from one Hermes profile into other profiles as a
ONE-TIME, explicit, user-initiated copy. Never a live inheritance: after the
call each profile owns its own values, and nothing reads across profiles at
runtime (#111724 / #113425 keep that contract).

Safety invariants (the same rules the create-time "Copy API keys" mirror uses):

* messaging channel keys are never copied — two profiles sharing one Telegram /
  Discord bot token would collide over the same bot identity;
* ``auth.json`` is never consulted — single-use OAuth grants must not fork (a
  copied grant's first refresh strands one of the two stores);
* fill-missing by default; ``overwrite: true`` is the explicit opt-in for key
  rotation;
* values never leave the machine or cross back in a response — only key NAMES.

Routes mount at ``/api/plugins/provider-copy/``. The module runs inside the
dashboard/gateway process (imported only when the plugin is in
``plugins.enabled``), so it can import the hermes-agent codebase directly.
Every helper import is defensive: on an install that predates a helper the
plugin degrades rather than failing to load.
"""

from __future__ import annotations

import contextlib
import logging
import threading
from typing import Any, Dict, Iterator, List, Optional

from fastapi import APIRouter, HTTPException, Request

log = logging.getLogger("hermes.plugins.provider_copy")

router = APIRouter()

# One copy at a time: two windows racing the same targets would interleave
# read-modify-write cycles over the same .env files.
_WRITE_LOCK = threading.RLock()


# ---------------------------------------------------------------------------
# Profile plumbing
# ---------------------------------------------------------------------------


def _profiles():
    from hermes_cli import profiles

    return profiles


def _resolve_profile(name: Optional[str]) -> str:
    """Canonical, existing profile key. Raises ValueError for a bad name."""
    profiles = _profiles()
    canon = profiles.normalize_profile_name((name or "").strip())
    profiles.validate_profile_name(canon)
    if not profiles.profile_exists(canon):
        raise ValueError(f"Unknown profile: {name!r}")
    return canon


@contextlib.contextmanager
def _scoped(profile: Optional[str]) -> Iterator[None]:
    """Run inside *profile*'s HERMES_HOME (and its secret scope when the
    dashboard's own scoping helper is importable — that is what keeps
    ``get_secret`` fail-closed while another profile is being read/written)."""
    scope_factory = None
    try:
        from hermes_cli.web_server_profiles import _config_profile_scope as scope_factory
    except Exception:  # pragma: no cover - install predates the helper
        scope_factory = None

    if scope_factory is not None:
        with scope_factory(profile):
            yield
        return

    if not profile or str(profile).strip().lower() in ("", "current"):
        yield
        return

    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    token = set_hermes_home_override(str(_profiles().get_profile_dir(_resolve_profile(profile))))
    try:
        yield
    finally:
        reset_hermes_home_override(token)


def _write_scope(profile: str):
    """Scoped + the dashboard's config mutation lock when available — the same
    nesting every core config-writing handler uses. Falls back to plain scope."""
    try:
        from hermes_cli.web_routers._common import config_write_scope

        return config_write_scope(profile)
    except Exception:  # pragma: no cover - install predates the helper
        return _scoped(profile)


def _load_env() -> Dict[str, str]:
    from hermes_cli.config import load_env

    return load_env()


_SAVER = None


def _save_credential(key: str, value: str) -> None:
    """Write a credential exactly like a manual Providers-page save does (env +
    config.yaml mirror reconciliation + credential-pool materialization)."""
    global _SAVER
    if _SAVER is None:
        try:
            from hermes_cli.credential_lifecycle import save_provider_env_credential

            _SAVER = save_provider_env_credential
        except Exception:  # pragma: no cover - install predates the lifecycle
            from hermes_cli.config import save_env_value

            _SAVER = save_env_value
    _SAVER(key, value)


def _channel_keys() -> frozenset:
    try:
        from hermes_cli.web_server_messaging import _channel_managed_env_keys

        return frozenset(_channel_managed_env_keys())
    except Exception:  # pragma: no cover
        return frozenset()


def _provider_copyable_env(env: Dict[str, str]) -> Dict[str, str]:
    """Provider-category credentials in *env* that are safe to duplicate."""
    try:
        from hermes_cli.config import OPTIONAL_ENV_VARS as _OPTIONAL
    except Exception:  # pragma: no cover
        _OPTIONAL = {}

    catalog: Dict[str, Any] = {}
    try:
        from hermes_cli.web_routers.config_env import _catalog_provider_env_metadata

        catalog = _catalog_provider_env_metadata()
    except Exception:  # pragma: no cover
        catalog = {}

    channel_keys = _channel_keys()
    copyable: Dict[str, str] = {}
    for key, value in (env or {}).items():
        if not value or key in channel_keys:
            continue
        info = _OPTIONAL.get(key) or {}
        category = info.get("category") or (catalog.get(key) or {}).get("category", "")
        if category == "provider":
            copyable[key] = value
    return copyable


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


def _profile_option(info: Any) -> Dict[str, Any]:
    name = str(getattr(info, "name", "") or "")
    label = (
        str(getattr(info, "bot_title", "") or "")
        or str(getattr(info, "display_name", "") or "")
        or name
    )
    return {"name": name, "label": label, "is_default": bool(getattr(info, "is_default", False))}


def _list_profiles():
    """``list_profiles`` with the lazy skill count when the install has it.

    The kwarg only gates the (off-request) skill walk; older installs simply
    count synchronously, so fall back rather than fail the page."""
    profiles = _profiles()
    try:
        return profiles.list_profiles(lazy_skill_count=True)
    except TypeError:  # install predates the kwarg (e.g. pre-#114041)
        return profiles.list_profiles()


def _profile_options() -> List[Dict[str, Any]]:
    return [_profile_option(info) for info in _list_profiles()]


def _request_profile(request: Optional[Request]) -> Optional[str]:
    """The ``?profile=`` the desktop REST door carries (the app's active profile)."""
    if request is None:
        return None
    value = (request.query_params.get("profile") or "").strip()
    return value or None


def _pick_source(request: Optional[Request], explicit: Optional[str]) -> str:
    """Explicit pick > the app's active profile > ``default``."""
    for candidate in (explicit, _request_profile(request)):
        if not candidate:
            continue
        try:
            return _resolve_profile(candidate)
        except ValueError:
            continue
    return "default"


@router.get("/profiles")
def list_profiles_route() -> Dict[str, Any]:
    """Profile picker options (name + display label)."""
    return {"profiles": _profile_options()}


@router.get("/overview")
def overview(request: Request, source: Optional[str] = None) -> Dict[str, Any]:
    """Eligible source keys + one row per target profile (missing/present)."""
    source_canon = _pick_source(request, source)
    with _scoped(source_canon):
        copyable = _provider_copyable_env(_load_env())

    targets: List[Dict[str, Any]] = []
    for option in _profile_options():
        name = option["name"]
        if name == source_canon:
            continue
        row: Dict[str, Any] = {**option, "missing": [], "present": [], "error": None}
        try:
            with _scoped(name):
                target_env = _load_env()
            row["present"] = sorted(k for k in copyable if target_env.get(k))
            row["missing"] = sorted(k for k in copyable if not target_env.get(k))
        except Exception as exc:  # an unreadable profile must not kill the list
            log.warning("provider-copy: could not read profile %r: %s", name, exc)
            row["error"] = str(exc)
        targets.append(row)

    return {
        "source": source_canon,
        "profiles": _profile_options(),
        "keys": sorted(copyable),
        "targets": targets,
    }


@router.post("/copy")
def copy(request: Request, body: Dict[str, Any]) -> Dict[str, Any]:
    """One-time copy of the source profile's provider credentials into *targets*."""
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Expected a JSON object body.")

    source_canon = _pick_source(request, body.get("source"))

    raw_targets = body.get("targets") or []
    if not isinstance(raw_targets, list):
        raise HTTPException(status_code=400, detail="targets must be a list of profile names.")

    requested: List[str] = []
    seen: set = set()
    for raw in raw_targets:
        name = str(raw or "").strip()
        if name and name.casefold() not in seen:
            seen.add(name.casefold())
            requested.append(name)
    if not requested:
        raise HTTPException(status_code=400, detail="Pick at least one profile to copy to.")

    target_canons: List[str] = []
    for name in requested:
        try:
            canon = _resolve_profile(name)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if canon != source_canon and canon not in target_canons:
            target_canons.append(canon)
    if not target_canons:
        raise HTTPException(status_code=400, detail="The source profile cannot be a target.")

    overwrite = bool(body.get("overwrite", False))

    with _scoped(source_canon):
        copyable = _provider_copyable_env(_load_env())

    results: List[Dict[str, Any]] = []
    with _WRITE_LOCK:
        for canon in target_canons:
            entry: Dict[str, Any] = {
                "profile": canon,
                "copied": [],
                "skipped": [],
                "failed": [],
                "error": None,
            }
            try:
                with _write_scope(canon):
                    target_env = _load_env()
                    for key, value in copyable.items():
                        existing = target_env.get(key)
                        if existing and (existing == value or not overwrite):
                            entry["skipped"].append(key)
                            continue
                        try:
                            _save_credential(key, value)
                            entry["copied"].append(key)
                        except Exception as exc:
                            entry["failed"].append({"key": key, "error": str(exc)})
            except Exception as exc:
                entry["error"] = str(exc)
            results.append(entry)

    return {
        "ok": True,
        "source": source_canon,
        "keys": sorted(copyable),
        "results": results,
    }
