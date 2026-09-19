# Provider Copy — a Hermes plugin

**Copy the provider keys you set on one profile onto your other profiles — a one-time, explicit copy.**

Running many bots means setting the same provider key again and again, profile
by profile. This plugin puts a **Provider Copy** page in the Hermes desktop app:
pick the profile that has the keys, tick the bots that need them, press *Copy
keys*. Done once — after that every profile owns its own values and nothing is
linked.

## What travels — and what never does

| | |
|---|---|
| ✅ Provider API keys (the `provider` category) | e.g. `OPENCODE_GO_API_KEY`, `GLM_API_KEY`, `MINIMAX_API_KEY` |
| ✅ Provider base-URL overrides | same category, for custom endpoints |
| ❌ OAuth sign-ins (`auth.json`) | a copied single-use grant forks token state — the first refresh in either store strands the other |
| ❌ Messaging bot tokens | two profiles sharing one Telegram/Discord bot token collide over the same bot identity |

Fill-missing by default: only keys a bot doesn't have yet are copied. "Replace
existing values" is the explicit opt-in when you're rotating a key.

This is deliberately a copy, not a sync: profiles stay independent islands
(hermes-agent #111724 / #113425), and nothing reads across profiles at runtime.
If you rotate a key later, run the copy again.

## Install

### From the plugin catalog

*Hermes desktop → Capabilities → Plugins → Install*, or:

```bash
hermes plugins install provider-copy
```

Then flip the two switches (see below).

### Manually

Copy this package into your Hermes home:

```bash
git clone https://github.com/tobenwarrior/hermes-provider-copy \
  ~/.hermes/plugins/provider-copy
```

(or copy the folder there by hand).

### Enable

Both halves are opt-in, on purpose:

1. **Backend** — add the plugin to `plugins.enabled` in `~/.hermes/config.yaml`
   (or run `hermes plugins enable provider-copy`), then restart the app so the
   backend routes mount:
   ```yaml
   plugins:
     enabled:
       - provider-copy
   ```
2. **Desktop half** — the app copies `desktop/plugin.js` into
   `~/.hermes/desktop-plugins/provider-copy/` automatically. In the app, open
   **Capabilities → Plugins**, press **Rescan** if the row isn't there yet, and
   toggle **Provider Copy** on.

You'll now have a **Provider Copy** row in the sidebar, and `⌘K → Provider
Copy` opens the same page.

## How it works

```
provider-copy/
├── plugin.yaml               # agent-half manifest (no tools/hooks — the agent side is the backend route)
├── dashboard/
│   ├── manifest.json         # mounts plugin_api.py at /api/plugins/provider-copy/
│   └── plugin_api.py         # GET /overview + POST /copy — the whole mechanism
└── desktop/
    └── plugin.js             # the page + sidebar row + ⌘K command (ESM, no build)
```

* The page calls `ctx.rest('/overview')` and renders the checkboxes; pressing
  *Copy keys* calls `ctx.rest('/copy', …)`.
* The backend runs inside the dashboard process, reads the source profile's
  `.env` under its own scope, and writes each target under
  `config_write_scope` through `save_provider_env_credential` — byte-for-byte
  the same lifecycle a manual save on that profile's Providers page runs.
* Values never cross back over the wire: the responses carry key *names* only.

## Requirements

- Hermes desktop app with the desktop plugin SDK (any current version) and the
  dashboard plugin mount (`plugins.enabled`).
- Local profiles. The plugin operates on the local Hermes home; it is not
  meaningful for profiles served by a remote backend.

## Development

There is no build step. The desktop half is plain ESM — edit
`desktop/plugin.js`, and the plugin hot-reloads when the app's copied file
changes (or press Rescan in Capabilities → Plugins). The backend mounts at app
startup; restart the app after changing `plugin_api.py`.

## Tests

Backend (uses a fabricated `HERMES_HOME` in a tmp dir — never touches real profiles):

```bash
/path/to/hermes/venv/bin/python -m pytest tests/ -q
```

Desktop half (pure node, no dependencies — rewrites the SDK imports to stubs exactly
like the app's runtime loader does, then exercises `register()` and every page state):

```bash
node tests/desktop_plugin_test.mjs
```

## License

MIT — see [LICENSE](LICENSE).
