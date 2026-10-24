# Sub2API Provider Plugin Design

**Status:** Approved direction; implementation not started

**Date:** 2026-10-24

**Target:** Magpie provider plugin with final Provider ID `sub2api`

## 1. Decision

Move the local Sub2API provider, model discovery, request forwarding, and
usage/quota presentation into an OpenCode provider plugin. The plugin will be
installed through Magpie's existing Bun plugin host and will expose the final
provider ID `sub2api`.

The plugin will not be implemented as a `plugins/` Go runtime plugin. That
runtime currently extends window and gateway services; it does not expose a
stable seam for registering providers or quota readers. OpenCode provider
plugins already have the required seams:

- `auth.methods` and `auth.loader` for credentials and per-account endpoints;
- `provider.models` for model discovery;
- the provider fetch path for chat/streaming requests;
- `auth.usage` for Usage-page allowance cards.

The final target is:

```text
Provider plugin ID: sub2api
Display name:      Sub2API
One endpoint:      one plugin account
Model reference:   sub2api/<model>
Credential store:  plugin-auth.json
Usage source:      plugin auth.usage -> Magpie plugin_usage.go
```

## 2. Important provider-ID constraint

This checkout currently contains a core preset with the same ID in
`internal/provider/presets.go`. Magpie's `PluginID()` treats a plugin whose ID
is also a core preset as a plugin-backed variant and may expose it as
`sub2api-plugin`. That is not the desired final contract.

Therefore the migration order is mandatory:

1. Build and test the plugin package and its pure parsers without installing
   the final account into the live configuration.
2. Remove or disable the native `sub2api` preset/plan-quota path in the
   Magpie build used for cutover.
3. Start Magpie with the plugin ID `sub2api` and create the plugin account.
4. Migrate model and routing references from the old custom provider to
   `sub2api/<model>`.
5. Remove the old custom provider and the local usage-only workaround.

The plugin must not be accepted in a state where its public ID is silently
rewritten to `sub2api-plugin`. If a staged test still includes the old core
preset, use an isolated test fixture or a temporary branch with the preset
removed; do not publish a second public ID and migrate it later.

## 3. Context and current implementation

The current branch has native Sub2API support in:

- `internal/provider/presets.go`: an endpoint-based `sub2api` preset;
- `internal/provider/planquota.go`: explicit preset recognition, `/usage`
  URL derivation, unrestricted wallet/subscription parsing, balance plumbing;
- `internal/provider/sub2api_usage.go`: key-limited `rate_limits` parsing;
- `internal/provider/planquota_test.go` and
  `internal/provider/sub2api_usage_test.go`: response and integration tests.

The local `usage-cards` plugin is a different design. It creates usage-only
providers, hard-codes the TFlow endpoint, and also duplicates MiniMax usage.
It was forced to use a separate provider ID to avoid stealing the user's
`tflow-online` custom provider. That workaround is useful evidence for this
design, but it is not the target architecture: a real provider plugin must
also own model discovery and request forwarding.

The existing Magpie plugin runtime already supplies the remaining core path:

- `internal/plugin/host.js` loads `baseURL`, `apiKey`, and `fetch` from an
  account's loader;
- `internal/provider/plugins.go` maps plugin models and forwards requests;
- `internal/provider/plugin_usage.go` turns `auth.usage` into native quota
  cards and routing allowances.

## 4. Goals

1. Provide a self-hosted Sub2API provider without a Magpie core fork for
   provider-specific request and quota logic.
2. Support multiple self-hosted Sub2API instances as independent plugin
   accounts.
3. Discover each account's models from its own `/v1/models` endpoint.
4. Forward Chat Completions requests through each account's configured base
   URL and Bearer key.
5. Display unrestricted wallet/subscription balances and quota-limited
   `rate_limits` windows on Magpie's existing Usage page, tray, and routing
   surfaces.
6. Preserve safe failure behavior: an unreadable or malformed response is
   unknown, not an artificial zero balance.
7. Permit a reversible migration from the current `tflow-online` custom
   provider and local `usage-cards` workaround.

## 5. Non-goals

- Do not add a generic JSON expression language for arbitrary quota APIs.
- Do not probe `/usage` for ordinary custom providers.
- Do not add a second usage-only provider for TFlow or MiniMax.
- Do not modify Sub2API server behavior.
- Do not change Magpie's Usage-page rendering or quota history format.
- Do not preserve the old `tflow-online/<model>` model prefix; the target
  prefix is `sub2api/<model>`.
- Do not solve CAPTCHA or vendor-side account recovery in the plugin.

## 6. Target architecture

```text
Agent request
    |
    v
Magpie gateway
    |
    v
plugin://sub2api/v1/chat/completions
    |
    v
pluginFetch -> auth.loader(account)
    |
    +--> baseURL = account.metadata.baseURL
    +--> Authorization: Bearer account.key
    |
    v
<baseURL>/chat/completions

Usage page
    |
    v
plugin auth.usage(account)
    |
    v
<baseURL>/usage
    |
    v
plugin Usage { plan, balance, windows }
    |
    v
Magpie plugin_usage.go -> Usage page / tray / routing
```

The plugin provider is a normal Magpie provider from the user's point of
view. The difference is ownership: the account and endpoint live in the
plugin host, while Magpie still owns routing, protocol conversion, quota
history, and presentation.

## 7. Package layout

The first implementation should live in this design project under:

```text
packages/opencode-sub2api-auth/
├── package.json
├── index.mjs
├── lib/
│   ├── endpoint.mjs
│   ├── models.mjs
│   └── usage.mjs
├── test/
│   ├── endpoint.test.mjs
│   ├── models.test.mjs
│   └── usage.test.mjs
└── README.md
```

The package can later be published as
`@magpie-community/opencode-sub2api-auth`. The initial local installation
should use a fixed local path or Git commit, not `@latest`.

`package.json` should declare an OpenCode plugin entry point and no dependency
that is not required by the parser or HTTP client. The package must not write
Magpie's files directly; the host owns credential persistence, locking, and
atomic writes.

## 8. Authentication and account model

The plugin exposes one API-key method with a preceding Base URL prompt:

```text
1. Sub2API OpenAI-compatible Base URL
2. API key
```

`authorize(inputs)` validates and normalizes the URL, then returns metadata.
The API key is supplied through Magpie's normal API-key field and is stored by
the host. A stored account has this logical shape:

```json
{
  "type": "api",
  "key": "<secret>",
  "metadata": {
    "baseURL": "https://relay.example.com/v1",
    "email": "relay.example.com"
  }
}
```

`email` is only the host's account display label; it is not sent to Sub2API.
If two accounts use the same host, the plugin should ask for an optional
label or derive a stable suffix so Magpie can keep them separate.

The plugin must support more than one account. Each account has its own:

- endpoint;
- key;
- model list;
- usage response;
- proxy selection and failure state.

The plugin must never log the key, include it in model/usage errors, or put it
in a URL query string.

## 9. Endpoint normalization

`normalizeBaseURL()` is a small, pure function with these rules:

- accept absolute `http` and `https` URLs;
- trim surrounding whitespace and trailing `/`;
- preserve nested paths such as `/api/v1`;
- reject credentials, query strings, fragments, and empty hosts;
- accept local/LAN HTTP because self-hosted Sub2API commonly runs there;
- reject an endpoint that already ends in `/models`, `/usage`,
  `/chat/completions`, `/responses`, or `/messages` instead of guessing a
  base URL.

Examples:

```text
https://tflow.online/v1       -> https://tflow.online/v1
https://relay.example/api/v1/ -> https://relay.example/api/v1
http://192.168.1.20:8000/v1/ -> http://192.168.1.20:8000/v1
```

The plugin derives endpoints only after normalization:

```text
GET  {baseURL}/models
POST {baseURL}/chat/completions
GET  {baseURL}/usage
```

## 10. Model discovery and request forwarding

`provider.models(provider, { auth })` calls the account's `/models` endpoint
with `Authorization: Bearer <key>` and maps the OpenAI-compatible `data[]`
list to OpenCode model objects.

The first implementation should retain only fields that the upstream
actually supplies: model ID, display name, and any explicit context/output
limits. It must not invent token prices or capabilities. Magpie's catalog can
fill known metadata later.

If model discovery fails after a previous successful list, throw the error so
the host keeps the last good list and reports the failure. Returning `{}` on a
transient error would incorrectly make all models disappear.

The loader returns the normalized `baseURL` and API key. Because the provider
uses `@ai-sdk/openai-compatible`, Magpie's host adds the standard Bearer
header. No Go-side Sub2API transport or provider-specific signer is needed.

## 11. Usage contract

The usage hook calls `{baseURL}/usage` and supports both response families
already handled by the current core branch.

### 11.1 Unrestricted wallet/subscription mode

Input fields:

- `planName`;
- optional numeric `remaining` and `unit`;
- `subscription.daily_*`, `weekly_*`, and `monthly_*` fields;
- optional `weekly_window_start`.

Output rules:

- `remaining` plus `USD` becomes `$%.2f`;
- another unit becomes `<amount> <unit>`;
- missing or non-finite balance is omitted, never rendered as `$0.00`;
- each positive limit creates a window;
- `used` is `used_amount / limit * 100`, clamped to `0..100`;
- `amount` is the used amount and `limit` is the window limit;
- daily, weekly, and monthly spans are 24 hours, 7 days, and 30 days;
- weekly reset is `weekly_window_start + 7 days` when the timestamp is valid;
- a wallet-only response still returns a balance card with no windows.

### 11.2 Quota-limited `rate_limits` mode

Recognized windows:

| Sub2API | Magpie display | Span |
| --- | --- | --- |
| `5h` | `5 hours` | 5 hours |
| `1d` | `1 day` | 24 hours |
| `7d` | `7 days` | 7 days |

For each positive `limit`:

```text
amount = max(used, 0)
used%  = clamp(amount / limit * 100, 0, 100)
unit   = USD
```

`reset_at` is parsed when valid. A missing reset time does not remove a
valid window; it simply leaves `resetsAt` empty. This is important for a key
window that has not started yet.

### 11.3 Error semantics

- Non-2xx responses become a bounded error message containing status and a
  vendor-provided safe message, but never a key.
- Non-JSON responses are errors.
- A JSON response with neither a usable balance nor a usable window is an
  error.
- A temporary network error returns `signIn: "kept"` so the account remains
  usable and the previous card can stand.
- Only an explicit, verified invalid/revoked-key response may return
  `signIn: "expired"`.

## 12. Core changes and ownership after cutover

The plugin becomes the source of truth for Sub2API-specific behavior. The
following core changes are required before the final `sub2api` Provider ID is
activated:

1. Remove the native `sub2api` preset from `internal/provider/presets.go`.
2. Remove the `preset == "sub2api"` branch, URL derivation, and parser from
   `internal/provider/planquota.go`.
3. Remove the optional balance plumbing added only for the native Sub2API
   reader if no remaining plan reader uses it.
4. Remove or update the corresponding native tests and fixtures.
5. Audit `internal/provider/sub2api_usage.go` and the
   `sub2APIKeyLimits` path in `balance.go`/`key_allowance.go`.

The last item is conditional. If no saved provider still uses a Sub2API
Balance URL, remove the special path. If another user-facing legacy flow
depends on it, keep that generic Balance URL compatibility path temporarily,
but it must not be the implementation used by the new plugin provider.

MiniMax's real core plan reader remains. Only the duplicate MiniMax account
from the local usage-only plugin is removed.

## 13. Local migration

All migration steps must be reversible and must create timestamped backups
before writing:

```text
~/.config/magpie/providers.json
~/.config/magpie/plugin-auth.json
~/.config/magpie/plugin-providers.json
~/.config/magpie/plugins.json
~/.config/magpie/logins.json
~/.config/magpie/quotas.json
```

Migration sequence:

1. Export the existing `tflow-online` endpoint, key, selected models, proxy,
   and routing references without printing the key.
2. Build and test the plugin parsers and host fixture.
3. Remove the native `sub2api` preset/reader in the cutover build.
4. Install the plugin package with a fixed local path or commit.
5. Add a `sub2api` plugin account for `https://tflow.online/v1` through the
   normal Magpie UI. Re-entering the key through the UI is preferred because
   the host applies its locking and atomic-write rules.
6. Verify `/models`, chat, streaming, tool calls, and `/usage`.
7. Rewrite provider/model references from `tflow-online/<model>` to
   `sub2api/<model>` in routing groups, agent model selections, hidden-model
   lists, gateway-key model scopes, and saved prices.
8. Remove the old `tflow-online` custom provider only after the plugin is
   serving requests successfully.
9. Disable and remove the local `usage-cards` plugin. Sign out/remove its
   `tflow-usage` and duplicate `minimax-cn` accounts through Magpie rather
   than deleting credential files by hand.
10. Refresh Usage cards and verify exactly one Sub2API card and one real
    MiniMax card remain.

The migration must not globally replace arbitrary text in configuration.
Use a JSON-aware script with before/after validation and keep the backups
until the rollback window closes.

## 14. Rollback

If any plugin smoke test fails:

1. turn off the `sub2api` plugin;
2. restore the `tflow-online` provider and old model references from backup;
3. restore the old usage-card path only if needed;
4. leave the new plugin account backed up, but do not expose its key in logs;
5. do not delete `plugin-auth.json` wholesale.

The important reason for removing the core preset before the final plugin
activation is that the target ID then has one owner. Rollback restores the
previous owner from backup instead of running two Providers with the same ID.

## 15. Verification plan

### Plugin unit tests

Use Bun/Node tests with no real network for:

- Base URL normalization and rejection cases;
- unrestricted balance-only response;
- daily/weekly/monthly windows;
- weekly reset calculation;
- quota-limited `5h`/`1d`/`7d` windows;
- null, zero, negative, over-limit, and malformed values;
- HTTP errors and non-JSON responses;
- safe error redaction.

### Plugin host integration tests

Use a local fake HTTP server and assert:

- each account calls its own `/models` and `/usage` endpoint;
- every request carries `Authorization: Bearer <key>`;
- two accounts remain separate;
- model discovery failure keeps the last good list;
- usage failure does not fabricate a zero quota;
- chat and streaming requests reach the configured endpoint.

### Magpie integration tests

Run against an isolated HOME and Bun cache:

```sh
go test -tags nogui ./internal/plugin ./internal/provider
go test -tags nogui ./internal/provider -run 'Plugin|Quota|Allowance'
```

Run the affected GUI tests in Chromium and WebKit, including narrow widths.
The final cleanup must also run the repository's full Go suite and the
required cross-platform builds. Automated tests must never call the real
TFlow/Sub2API endpoint; the real self-hosted instance is only for a manual
sandbox smoke test.

### Acceptance criteria

- Final plugin Provider ID is exactly `sub2api`, not `sub2api-plugin`.
- A new account lists models from its configured endpoint.
- Chat, streaming, and tool calls use the account's endpoint and key.
- Unrestricted and quota-limited usage cards display correctly.
- Multiple endpoints produce independent accounts and cards.
- Ordinary custom Providers are never probed for `/usage`.
- No duplicate TFlow or MiniMax usage-only cards remain.
- A malformed/failed usage read never becomes a fabricated zero balance.
- Turning the plugin off and restoring the backup returns the old setup.

## 16. Documentation updates

After implementation, update the owning references:

- `docs/integrating.md`: install and configure the Sub2API provider plugin;
- `docs/subsystems/provider-plugins.md`: describe the plugin-owned model,
  request, and usage paths;
- `docs/subsystems/providers-accounts.md`: remove native Sub2API ownership
  claims and document plugin accounts;
- the plugin's `README.md`: endpoint format, response modes, migration,
  security, and supported fields.

The PR description must state the before/after ownership change, the required
Provider-ID cutover order, the compatibility decision for legacy
`sub2APIKeyLimits`, and the exact verification commands that were run.

