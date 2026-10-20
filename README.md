# Claude Code Proxy

A local proxy exposing Anthropic-style message endpoints for independently added Claude, Kimi, Codex, Grok, Antigravity, MiMo Code, and Meta Muse Code connections. Add multiple accounts from the dashboard; Argon currently supports one system-account connection. Clients such as SillyTavern should use their Anthropic/Claude API mode.

Claude routes forward structured Anthropic requests. CLI adapters translate conversations into CLI sessions and return text/reasoning as Anthropic-style JSON or server-sent events.

## Quick start

Use Node.js 22 or newer. First copy `server/config.example.txt` to `server/config.txt` and adjust your local settings. `config.txt` is intentionally ignored by Git. Then, from the repository directory:

```sh
npm ci
npm start
```

On Windows, use `run-tray.bat` for a background proxy with a notification-area icon. `run.bat` remains available for a normal console, and `run.sh` works on Unix. Settings are read from your local `server/config.txt`; the archive includes `server/config.example.txt` as a starting point. The default listen address is `127.0.0.1:42069`.

The account dashboard opens automatically at `http://127.0.0.1:42069/dashboard/`. Use it to check saved authentication, sign in, refresh Claude credentials, or reset one Claude account and sign in again. Each account has separate login state and token storage.

For CLI-backed routes, install the relevant CLI first. The dashboard can launch supported CLI sign-in flows in a separate terminal; the CLI owns its credentials. The proxy does not install CLIs. A missing CLI, unavailable model, or expired CLI login is returned as a request error.

## Adding and removing connections

Click **+ Add provider**, choose a provider, optionally name the connection, then click **Add connection**. Use its **Sign in** button and copy the URL from that card into your client. You can add Claude repeatedly for three, four, or more subscriptions, and add separate Kimi, Codex, Grok, MiMo, and Muse accounts. Argon is limited to one connection because its CLI uses shared OS keyring authentication. Changes take effect immediately and survive a restart.

Argon remains available in the provider picker. While an Argon connection exists, its option is disabled with an explanation; after removal it can be added again using the same system sign-in. Additional isolated Argon subscriptions would require an upstream account-isolation mechanism or separate OS users. See [the official CLI authentication description](https://github.com/google-antigravity/antigravity-cli#authentication).

The first start after this update imports the existing eight cards. Existing Claude token files, CLI sign-ins, configuration, and URLs are preserved. Remove cards you do not need; an empty collection stays empty across restarts. Re-adding a provider creates a fresh connection with a new URL; independent providers also get a fresh profile.

New connections use stable URLs such as `/v1/connections/claude-<uuid>`. The client appends `/messages`. New Kimi connections use K3 256K by default; append `/kimi-1m` to that connection's base URL for K3, or `/kimi-256k` for the explicit 256K route.

The registry is saved in `server/data/connections.json`. For providers supporting independent accounts, new credentials and CLI configuration belong under `server/data/profiles/<connection-id>`. These files are ignored by version control. New Claude accounts never borrow Claude Code credentials. New independent CLI accounts receive their own home, provider-specific directories, and XDG directories; inherited provider keys and authentication overrides are removed from their child environment. Sign-in and message requests use the same profile. Codex uses file-based credential storage for these accounts. CLI integrations remain dependent on the installed CLI's profile support, not OS isolation.

On Windows, **Sign in** opens the official CLI in the connection's profile. Finish there and close the terminal. A normal terminal login still manages your ordinary CLI account, not these separate profiles. Chat adapters such as Kimi RP and MiMo RP remain usable for messages; login uses the official CLI. If it is installed outside PATH, set `<provider>_auth_command` to its full executable path. The existing MiMo connection also honors `mimo_auth_command`. Independent CLI sign-in buttons currently require Windows; on other systems, run the CLI with the connection's profile environment.

**Remove** disables the card and its URL, invalidates pending proxy OAuth callbacks, and prevents future requests on that connection. Requests already in progress may finish. Saved credentials and profile files are retained; removal does not revoke the provider's session. Sign out of a Claude account before removing it if you also want its saved proxy tokens cleared.

Provider defaults still come from `server/config.txt`; new connections snapshot their model and reasoning settings when added. MiMo's dashboard model selector saves separately for each new connection. The original MiMo card continues saving to `server/config.txt` for compatibility.

## Account dashboard

MiMo's card includes a **Model** selector for **MiMo v2.6 Pro** and **MiMo v2.6 Flash**. Choosing a model saves it in that connection's registry settings (or `mimo_model` in `server/config.txt` for the original MiMo card) and applies it to new requests immediately, without restarting. In-flight requests keep their original model. The choice survives a restart; a failed file save leaves the active model unchanged. Custom models configured manually remain active until you choose one of the listed models. Pro Ultraspeed is excluded from this selector because [current Token Plans do not include it](https://mimo.mi.com/docs/en-US/quick-start/faq/token-plan/desktop-guide).

- Start the proxy with `run-tray.bat`, `run.bat`, `run.sh`, or `npm start`, then use the browser dashboard. Closing the browser does not stop the proxy. In tray mode, use the tray menu to stop it; in console mode, close the proxy terminal. Set `auto_open_browser=false` to suppress the console launcher's browser opening.
- Claude cards are independent. **Refresh credentials** attempts an OAuth refresh without a restart. If a refresh token is revoked or login is broken, use **Reset & sign in** and paste the authorization code from Anthropic. Only that account's proxy credentials and pending login attempts are cleared; other accounts, provider settings, and prompt-cache handling are unchanged.
- Reset and sign-out also disable that account's Claude Code fallback until a successful new proxy sign-in, even after a restart. They do not delete the Claude Code CLI's credentials. Requests already in flight can still finish; these actions affect future authentication and do not revoke the provider's session globally.
- Claude's green status means its saved tokens are locally valid and unexpired, not that an online account check succeeded. MiMo's **Signed in** status means its saved Xiaomi credential passed an online model-list check. Other CLI **Saved / unverified** statuses mean local credential evidence exists, not that the provider will accept it. Missing, expired, unreadable, and unsupported checks are shown separately. Status polling does not send model prompts or make paid test requests.
- CLI sign-in opens the official CLI's login flow where supported. Complete it in that terminal and refresh the dashboard. Sign-in for an imported CLI connection uses the ordinary CLI account and can affect other tools using that account; new independent connections use their own profiles. The dashboard deliberately has no button to delete third-party CLI credentials.
- Copy a card's proxy URL into SillyTavern's **Claude/Anthropic** mode. The GUI does not change the message protocol or provider routing.

The dashboard is restricted to loopback connections even if message routes are configured for LAN use. Its controls require same-origin requests and a custom header; an optional proxy key is required when configured and is kept only in browser memory. No provider tokens are sent to the browser. Provider-managed authentication windows and terminals remain separate from the dashboard.

The original standalone login pages remain available at `http://localhost:42069/auth/login` and `http://localhost:42069/auth/claude2/login`.

Windows login buttons use fixed CLI commands: `kimi login`, `codex login`, `grok login`, `mimo auth login`, and interactive `muse` (use `/login` if needed). Argon currently shows status guidance only because an automatic login command is not verified; use its own account controls. On other operating systems the dashboard still manages Claude, but CLI sign-in instructions replace terminal-launch buttons. Missing CLIs are not installed automatically. Except for MiMo's online check, stored CLI credentials are detected by file/environment presence only, so keychain-based or custom authentication may show **Not verified** even when the CLI works.

MiMo credentials follow the CLI's directory rules on every operating system: `MIMOCODE_HOME/data/auth.json` when set, otherwise `XDG_DATA_HOME/mimocode/auth.json`, defaulting to `~/.local/share/mimocode/auth.json` (including Windows). `MIMOCODE_AUTH_CONTENT` takes precedence, with invalid JSON falling back to the file as it does in the CLI. The dashboard checks the saved `xiaomi` credential using `GET /v1/models` at its official MiMo endpoint, including its saved Token Plan region. Credentials stay on the server and are never forwarded to custom hosts or redirects. Verification times out after five seconds and is cached for fifteen seconds; **Refresh status** forces a fresh check. Credential changes invalidate the cache. A rejected credential shows **Not signed in**; connection failures, rate limits, and unsupported credentials/endpoints show **Not verified**. This verifies authentication, not remaining quota or access to a particular model.

## Windows tray and startup

Double-click `run-tray.bat`. The tray starts Node.js in the background without keeping a console window open. Double-click the notification-area icon, or choose **Open Dashboard**, to manage accounts. Windows may put the icon in the notification area's overflow menu.

- **Start proxy** and **Stop proxy** control only the child process started by this tray. An unrelated server or a proxy started separately is never terminated automatically. Stop a console-launched copy before switching it to tray mode.
- **Exit tray** stops its owned proxy and removes the icon. Stopping with requests in progress asks for confirmation. Shutdown allows a short grace period, then disconnects remaining requests so the existing provider cleanup can run.
- **Start with Windows** controls a per-user Startup shortcut. It starts quietly after this Windows account signs in, not before sign-in or as a system service. No administrator account or PowerShell execution-policy change is required. Uncheck the menu item to disable it.
- The startup shortcut remembers the full Node.js and installation paths. If you move the proxy or replace Node.js at another path, disable and re-enable startup from the new location. An installation-specific mutex prevents duplicate trays for the same folder.

Startup can also be managed explicitly from PowerShell in the project folder:

```powershell
.\windows\SetStartup.ps1 -Enable
.\windows\SetStartup.ps1 -Status
.\windows\SetStartup.ps1 -Disable
```

Tray mode uses an available PowerShell host and .NET Windows Forms, with no new Node dependencies. The launcher prefers installed PowerShell 7 and can also find the existing Codex-bundled PowerShell runtime; startup remembers the exact executable. It respects that host's script execution policy and does not bypass or change it. If scripts are prohibited by your administrator, use console mode or ask the administrator about running this trusted local script. The tray discards proxy stdout/stderr instead of saving log files; use `run.bat` when you intentionally need live console diagnostics.

## Recent request activity

The dashboard shows up to 100 recent message requests, newest first, and refreshes the feed every five seconds while visible. Each row contains only a generated ID, a server-generated connection identifier, start time, elapsed time, HTTP status, streaming flag, and a fixed outcome/error category. It records no prompts, replies, model strings, preset names, headers, credentials, query strings, or raw error text.

This activity feed exists only in process memory: it is not written to disk or browser storage, and disappears when the proxy stops. **Clear activity** removes rows without cancelling requests. Dashboard polling, sign-ins, and health checks do not populate the feed. The activity endpoints have the same loopback-only, same-origin and optional proxy-key protection as account controls.

**Completed** describes completed HTTP transport, not a guarantee that the model produced a useful reply. Explicit provider errors and cancellations are tracked even after streaming headers were sent. Raw Claude SSE is forwarded unchanged and not inspected for content or embedded error events.

These privacy promises apply to the new activity feed and tray logging. Third-party CLIs may independently retain their own session history/transcripts; their existing storage policies are unchanged. The proxy still passes conversation content to the chosen provider to generate a response, and some existing adapters use temporary working files.

## Endpoints

In SillyTavern, copy the base URL from the connection's dashboard card into the custom endpoint. The client appends `/messages`. New connections use `http://localhost:42069/v1/connections/<connection-id>`; the original imported connections retain the URLs below while those connections exist.

| Backend | Custom endpoint | Model selection |
| --- | --- | --- |
| Claude 1 | `http://localhost:42069/v1` | Request `model` |
| Claude 2 | `http://localhost:42069/v1/claude2` | Request `model` |
| Claude preset | `http://localhost:42069/v1/<preset>` | Request `model`; named preset from `server/presets` |
| Kimi K3 256K | `http://localhost:42069/v1/kimi` or `/v1/kimi-256k` | `kimi-code/k3-256k` |
| Kimi K3 | `http://localhost:42069/v1/kimi-1m` | `kimi-code/k3` |
| Codex | `http://localhost:42069/v1/codex` | `codex_model` |
| Grok | `http://localhost:42069/v1/grok` | `grok_model` |
| Argon | `http://localhost:42069/v1/argon` | `argon_model` |
| MiMo | `http://localhost:42069/v1/mimo` | `mimo_model`, otherwise the CLI's reported MiMo default |
| Meta Muse | `http://localhost:42069/v1/muse` | `muse_model`, otherwise the CLI's default Meta model |

Send a JSON object containing a nonempty `messages` array, with `user` or `assistant` roles. `system` is a separate top-level field. Set `stream: true` for SSE.

CLI adapters support conversational text. Image/tool content and nonempty tool declarations are rejected, and prior assistant reasoning is not replayed as dialogue. Sampling settings, `max_tokens`, and stop sequences are accepted for frontend compatibility but are not forwarded to the CLI. Select a model available to the corresponding CLI account.

Codex runs with a read-only sandbox and supported CLI feature gates that disable command execution, browser/computer tools, apps, plugins, and delegation. The adapter also disables inherited MCP servers and rejects tool-operation events. These controls depend on the installed CLI protocol and are not operating-system isolation; keep this proxy in the intended local environment.

Argon uses a separate temporary workspace per request with a conversational agent profile. Its answer streams normally. When the CLI saves a matching completed transcript, available reasoning may arrive after the answer, before the stream ends. Missing or unusable reasoning logs do not prevent the answer from completing.

`GET /health` reports server availability and the active-request count, not provider authentication or model availability. Tray-launched instances also report a non-secret installation identifier for safe launcher coordination.

## MiMo and Meta Muse setup

These routes use the official local CLIs and the selected connection's sign-in; they do not extract browser credentials or use unofficial web-chat endpoints. They are independent of the Claude connections and do not change Claude prompt caching. The terminal commands below set up the original imported CLI connections; use the dashboard's **Sign in** button for each new independent connection.

- MiMo: install the Windows CLI with `npm install -g @mimo-ai/cli`, then run `mimo auth login` and choose the intended account and Token Plan or pay-as-you-go authorization. See [Xiaomi's MiMo Code setup](https://mimo.mi.com/docs/en-US/tokenplan/integration/mimo-code).
- Meta Muse: follow the [official Muse Code installation](https://dev.meta.ai/docs/muse-code), then run `muse` and complete sign-in (or `/login` in an existing interactive session). Muse uses `META_API_KEY` before stored API keys or browser sign-in, so check that environment variable if you intend to use a browser-authenticated subscription. See [Meta's authentication documentation](https://dev.meta.ai/docs/muse-code/auth).

Restart the proxy after installing a CLI or manually changing `server/config.txt`. MiMo model changes made through the dashboard take effect immediately. In SillyTavern's Claude/Anthropic mode, set the custom endpoint to `http://localhost:42069/v1/mimo` or `http://localhost:42069/v1/muse`. Both routes support JSON and SSE text/reasoning responses and cancel their CLI process when the client disconnects or the request times out. CLI account access and billing remain controlled by the provider; the proxy does not create a subscription or choose a different account on failure.

These are chat-only adapters: model tools are disabled and tool-operation events are rejected. They still run local CLI software under your Windows account, not inside an operating-system security boundary. Keep the CLI's own settings and integrations trusted; inherited configuration may initialize MCP servers or other startup integrations. Provider-managed policies remain in effect. Do not use an untrusted CLI configuration for this proxy.

MiMo's ACP default can differ from the model chosen during login. Use the dashboard's MiMo model selector for v2.6 Pro or Flash. For other models, set `mimo_model` in `server/config.txt` to the full `xiaomi/...` or `mimo/...` ID available to your account and restart the proxy. The adapter refuses an implicit `ultraspeed` default rather than risk selecting an unintended paid model. It also refuses unavailable models or non-MiMo providers instead of falling back. An explicit setting must match the CLI's advertised model list; authorization and billing still depend on your CLI account.

Meta Muse requires Muse Code **1.4.10 or newer**, using version 1 of its session protocol. The adapter starts a new memory-only session, disables the model's tools, and requires the CLI to confirm the requested approval policy. `muse_model` overrides the CLI default; `muse_effort` accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `ultra`, subject to the selected model's support. `muse_reasoning_mode` selects `summary` (default), `raw`, `both`, or `none`; it controls which reasoning the proxy returns, not the model's reasoning budget. Available token and cache-usage counters are preserved.

## Local access and LAN use

The default configuration listens only on loopback. To expose the proxy beyond this computer, explicitly set a non-loopback `host` and configure `proxy_api_key` or the `CLAUDE_PROXY_KEY` environment variable. Startup rejects non-loopback binding without a key.

For SillyTavern running on this PC, keep the proxy on `127.0.0.1` even when you open SillyTavern remotely over Tailscale. SillyTavern's backend connects to the proxy locally; the proxy does not need a public or Tailscale listener.

Clients can provide the proxy key using `X-Proxy-Key`, `Authorization: Bearer <key>`, or `x-api-key`. `X-Proxy-Key` keeps proxy authentication separate from an upstream Anthropic credential. The proxy key is never an upstream provider token.

Browser requests from `localhost`, `127.0.0.1`, and `::1` are allowed by default. Add other origins as an exact comma-separated list in `allowed_origins`, including scheme and port. Requests without an `Origin` header remain usable by desktop clients. Origin checks also apply to preflight and authentication requests.

When a proxy key is enabled, account administration and message requests require it. Health and login pages remain public; OAuth callbacks are validated using account-bound, expiring, single-use PKCE state.

The Docker Compose configuration publishes the container only on the host's `127.0.0.1:42069`. Set `CLAUDE_PROXY_KEY` in your shell before running `docker compose up`; Compose requires it because the server listens on `0.0.0.0` inside the container. The environment variable `CLAUDE_PROXY_HOST` overrides the file's host setting for this case. CLI executables and their authenticated environment must be available inside the container to use CLI-backed routes.

## Configuration

`server/config.txt` uses `key=value` entries. A minimal local configuration is:

```ini
port=42069
host=127.0.0.1
log_level=INFO
auto_open_browser=false
fallback_to_claude_code=true
filter_sampling_params=false
max_body_bytes=16777216
body_timeout_ms=30000
```

| Setting | Purpose |
| --- | --- |
| `host`, `port` | Listen address and TCP port |
| `proxy_api_key` | Proxy access key; required for non-loopback binding |
| `allowed_origins` | Additional exact browser origins, comma-separated |
| `max_body_bytes` | Maximum JSON body size in bytes; default 16 MiB |
| `body_timeout_ms` | Maximum time to receive the body; default 30 seconds |
| `claude_timeout_ms` | Claude upstream request timeout; default five minutes |
| `oauth_timeout_ms` | OAuth token exchange/refresh timeout; default 30 seconds |
| `log_level` | `TRACE`, `DEBUG`, `INFO`, `WARN`, or `ERROR` |
| `auto_open_browser` | Open the account dashboard at startup; default enabled |
| `fallback_to_claude_code` | Allow primary-account Claude Code credential fallback |
| `filter_sampling_params` | Resolve incompatible simultaneous Claude sampling parameters |

CLI configuration is independent of the Claude accounts:

| Provider | Settings |
| --- | --- |
| Kimi | `kimi_command`, `kimi_args`, `kimi_work_dir`, `kimi_timeout_ms` |
| Codex | `codex_command`, `codex_args`, `codex_model`, `codex_effort`, `codex_reasoning_summary`, `codex_reasoning_mode`, `codex_work_dir`, `codex_timeout_ms` |
| Grok | `grok_command`, `grok_args`, `grok_model`, `grok_work_dir`, `grok_timeout_ms` |
| Argon | `argon_command`, `argon_model`, `argon_timeout_ms` |
| MiMo | `mimo_command`, `mimo_args`, `mimo_model`, `mimo_work_dir`, `mimo_timeout_ms` |
| Meta Muse | `muse_command`, `muse_model`, `muse_effort`, `muse_reasoning_mode`, `muse_timeout_ms` |

Use a full executable path when the proxy cannot find the CLI. Standard npm-generated Windows Node launchers (including MiMo's `mimo.cmd`) are resolved to their JavaScript entry point and launched directly with Node, preserving literal arguments without passing them through `cmd.exe`. Native executables and custom wrappers keep their existing behavior. Argon requires native `agy.exe` on Windows rather than a `.cmd` or `.bat` wrapper. CLI timeouts default to five minutes. Model names must match models available to the installed CLI.

MiMo defaults to `mimo acp` and creates a fresh child directory under `mimo_work_dir` (or the operating-system temporary directory) for each request. The parent directory must already exist. Existing CLI account storage is preserved; the temporary chat workspace is removed after the owned process exits.

MiMo Code may make an auxiliary title-generation request using its formatting-only `StructuredOutput` helper; the actual conversation model receives no tools. This CLI-managed request can consume additional tokens. MiMo responses use zero usage counters because its ACP interface does not expose reliable request totals; zero here does not mean the provider charged no tokens.

Muse defaults to `muse serve` with fixed chat-only flags and a fresh temporary workspace. Its command arguments are deliberately not user-overridable; use `muse_command` to select the executable. It preserves the normal CLI sign-in and configuration rather than copying account credentials into the workspace.

## Claude authentication and caching

The original Claude 1 connection uses `/auth/*`; Claude 2 uses `/auth/claude2/*`. New Claude connections use `/auth/<connection-id>/*`. Each exposes `login`, `get-url`, `callback`, `status`, and `logout`. Callbacks accept GET query parameters or POST JSON. Logout accepts GET for existing clients and POST.

The original OAuth tokens remain under the user's `.claude-code-proxy` directory: `tokens.json` for Claude 1 and `tokens-claude2.json` for Claude 2. New Claude connections store tokens in `server/data/profiles/<connection-id>/oauth/tokens.json`. Only the original Claude 1 connection can use Claude Code credential fallback. Logging in or out invalidates the affected account's cached authentication without changing other accounts.

Explicit sign-out writes a per-account `.signed-out` marker next to the token file before removing the saved tokens. This prevents an old token or Claude Code fallback from silently reconnecting a signed-out account. A successful new sign-in removes the marker. Use the dashboard rather than manually deleting files.

An explicit upstream `x-api-key` applies only to that request. Otherwise the route uses its own OAuth store, followed by optional Claude Code fallback for the primary account. A rejected explicit token is not retried using a saved account. OAuth expiration is checked on each request, with concurrent refreshes coordinated per account.

The Claude request transformer preserves cache markers and beta headers, retains the existing removal of cache-control TTL fields on system/messages, and avoids modifying the original request during retries. A retry sends the same prepared JSON bytes. Prompt caching still depends on stable prompt prefixes and suitable client cache-control breakpoints; changes to the prefix can prevent cache hits.

Keep tokens, local credentials, and code backups out of version control. Patterns are included in `.gitignore`; keep your local configuration, account profiles, and custom prompt presets untracked. Already-tracked secrets must be removed from tracking separately. The dependency lockfile is tracked for reproducible `npm ci` installs.

## Development and tests

```sh
npm test
npm run test:node
npm run test:unit
npm run test:coverage
```

`npm test` runs the OAuth Jest suite and every `server/*.node-test.cjs` suite. Tests use synthetic credentials and mocked CLI processes. Router tests call the real exported handler with in-memory request/response streams, avoiding a localhost-port dependency.

`server/server.js` exports `createApp(options)`, `createServer(options)`, and `startServer(options)`. Importing it does not listen or start cleanup timers. `createApp` accepts configuration, accounts, provider handlers, a Claude request class, CLI authentication service, activity store, and a logger for isolated tests of production routing. `Dashboard.js` serves only allowlisted assets from `server/dashboard` and dispatches account actions; `CliAuth.js` handles local CLI detection and interactive login launching. `RequestActivity.js` is a bounded metadata-only observer; `tray-server.js` provides the tray's owned-stdin shutdown protocol and safe configuration discovery.

Provider adapters live in `server/providers`; Claude requests, OAuth, and Argon transcript reading are separate modules. Test routing through `createApp` and CLI protocols using injected process streams.


`ConnectionRegistry.js` owns the provider catalog, connection IDs, migration, and atomic persistence. `ConnectionProfiles.js` supplies per-connection CLI environments, auth services, and adapter handlers. Tests can inject a registry, `cliAuthFactory`, and `providerFactory` into `createApp`; default `createApp` instances use an in-memory registry, while `startServer` loads the persistent registry.

