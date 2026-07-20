# lemonade-pi-plugin

Pi.dev extension that registers [Lemonade](https://github.com/lemonade-sdk/lemonade) — a local LLM server with GPU/NPU acceleration — as a custom provider in Pi.

After install, type `/login` in Pi, pick **Lemonade** from the OAuth selector, confirm or override the server URL, optionally enter an API key, then all models exposed by your server are registered automatically.

## Features

- **Built-in `/login` integration** — appears as a "Lemonade" choice in Pi's OAuth selector. No custom slash commands needed.
- **UDP beacon discovery** — listens for Lemonade's broadcast on port `13305` (the same channel `lemonade scan` uses) and finds local *and* LAN servers automatically.
- **HTTP fallback** — scans `localhost:13305`, `8000`, `1234`, `9000`, `8080` if no beacon arrives.
- **API key support** — prompted during login, stored by Pi in `~/.pi/agent/auth.json`, sent as `Authorization: Bearer …` on every request.
- **Model admin** — `/lemonade` for status, health, list, models, load, unload, pull, delete, refresh, discover, change-ctx.

## Install

### Via Pi (git)

```bash
pi install git:github.com/lemonade-sdk/lemonade-pi-plugin@main
```

### Local (development)

Symlink the repo into Pi's extension directory:

```bash
git clone https://github.com/lemonade-sdk/lemonade-pi-plugin.git
cd lemonade-pi-plugin
./scripts/install.sh
```

The installer creates `~/.pi/agent/extensions/lemonade-provider` as a symlink to the repo.

## Usage

1. Make sure a Lemonade server is running somewhere reachable. On the same machine: `lemond` (defaults to port 13305). On the LAN: any host already running `lemond` will be discovered automatically.
2. Start Pi: `pi`
3. Type `/login` → pick **Lemonade** from the selector.
4. The extension prompts you in order:
   - **Server selection** — if one server was found, press Enter to accept; if multiple, type the number; if none, type a URL (default: `http://localhost:8000`).
   - **API key** — **Do not leave this blank.** Enter a dummy value (e.g., `lemonade`) or paste your actual key. Even if your local server does not enforce authentication, the underlying Pi client wrapper requires a non-empty string to pass its internal validation rules.
5. After verification, the extension registers every model the server reports, and it appears in Pi's model picker under "Lemonade".

### Discovery details

Lemonade broadcasts a JSON beacon every ~1s on UDP `13305`:
```json
{"service":"lemonade","hostname":"my-host","url":"http://192.168.1.5:13305/api/v1/"}
```
The extension binds to `0.0.0.0:13305` with `SO_REUSEADDR` (so it coexists with `lemonade scan` running in parallel) and listens for ~2.5 seconds during login. Both loopback and LAN broadcasts are captured.

## Admin command: `/lemonade`

Once logged in, you can manage the connected server without leaving Pi:

| Command | What it does |
|---|---|
| `/lemonade status` | Server health: version, currently loaded model, all loaded models, WebSocket port |
| `/lemonade health` | Server health (rich): detailed display with backend info, recipe options, model limits |
| `/lemonade models` / `list` | List every model the server knows about, with size, recipe, and context window |
| `/lemonade load <id>` | Load a model into memory (`POST /api/v1/load`) |
| `/lemonade unload [id]` | Unload one model, or all loaded models if no id |
| `/lemonade pull <id>` | Download a model (`POST /api/v1/pull`) |
| `/lemonade delete <id>` | Delete a model from disk (`POST /api/v1/delete`) |
| `/lemonade refresh` | Re-fetch the model list and re-register the provider in Pi |
| `/lemonade discover` | Print every Lemonade server visible via beacon + HTTP scan |
| `/lemonade change-ctx <ctx_size> [model]` | Change context size for a loaded model (supports `32k`, `64k`, `1m`, etc.) |

## How it works

The extension registers a Pi provider named `lemonade` with an `oauth` block:
- `oauth.name = "Lemonade"` — what shows in `/login`.
- `oauth.login(callbacks)` — runs the discovery + prompt flow above.
- `oauth.refreshToken(creds)` — re-fetches the model list and re-registers the provider, so newly pulled models show up after a Pi reload without re-running `/login`.
- `oauth.getApiKey(creds)` — returns the stored API key for the `Authorization: Bearer …` header.

The connection details (`baseUrl`, `apiKey`, `serverName`) are encoded as JSON in the OAuth `refresh` field. Pi handles persistence in `~/.pi/agent/auth.json`.

The Pi-side API call goes through Lemonade's OpenAI-compatible `/v1/chat/completions` endpoint. The extension uses `api: "openai-completions"` in the provider config.

## Project layout

```
lemonade-pi-plugin/
├── extensions/
│   └── index.ts          Extension entry point (thin, imports from lib/)
├── lib/
│   ├── types.ts          Shared type/interface definitions
│   ├── constants.ts      Provider IDs, ports, TTLs
│   ├── credentials.ts    OAuth credential encoding/decoding
│   ├── url-helpers.ts    URL building and auth header helpers
│   ├── discovery.ts      UDP beacon + HTTP port scanning
│   ├── http.ts           /health and /models API calls
│   ├── models.ts         Model mapping (Lemonade → Pi shape)
│   ├── provider.ts       Provider (re-)registration
│   ├── oauth.ts          /login OAuth flow
│   ├── health.ts         Rich health formatter (used by /lemonade health)
│   ├── change-ctx.ts     Context size change for loaded models
│   └── admin.ts          /lemonade admin command
├── scripts/
│   ├── install.sh        Symlink the repo into ~/.pi/agent/extensions/
│   └── publish.sh        npm version bump + publish
├── package.json          Pi package manifest (pi.extensions field)
├── tsconfig.json
└── README.md
```

`pi.extensions` in `package.json` tells Pi which file to load. No build step required — Pi loads `.ts` directly via [jiti](https://github.com/unjs/jiti).

## Troubleshooting

**"Lemonade" doesn't appear in /login.** Restart Pi (or `/reload`). Confirm the symlink exists: `ls -la ~/.pi/agent/extensions/lemonade-provider`.

**No servers discovered.** Confirm `lemond` is running: `curl http://localhost:13305/api/v1/health`. Confirm port 13305 isn't blocked by a local firewall (UDP). The HTTP fallback should still find a localhost server even if the beacon is blocked.

**Models don't appear in the picker after login.** Run `/lemonade refresh`. If still empty, check `/lemonade models` — if the server reports models there but Pi doesn't show them, your provider model list might be stale; a full Pi restart will re-trigger the OAuth refresh.

**API key isn't being sent.** Re-run `/login` and pick Lemonade again, paste the key when prompted. Verify with `/lemonade status` — if it returns 401, the key is wrong; if it returns the server health, you're authenticated.

## License

MIT
