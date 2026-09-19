"""Provider Copy — agent-side half.

The feature is all dashboard (``dashboard/plugin_api.py``) and desktop
(``desktop/plugin.js``) work: routes under ``/api/plugins/provider-copy/`` and a
picker page in the app. There is no agent-side tool, hook, or command surface,
so this module registers nothing — it exists so the plugin loads as a
first-class agent plugin (the loader requires a ``register()``) and so
``plugins.enabled`` can gate the backend mount.
"""


def register(ctx):  # noqa: ARG001 — no agent-side surface to register
    """No-op: everything lives in the dashboard and desktop halves."""
