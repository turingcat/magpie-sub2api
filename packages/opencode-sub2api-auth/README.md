# Sub2API OpenCode Provider

`@magpie-community/opencode-sub2api-auth` is an OpenCode v1 provider plugin for self-hosted [Sub2API](https://github.com/turingcat/sub2api) instances. Its supported target is the Magpie plugin host: it exposes the exact provider ID `sub2api`, discovers models from each account's own endpoint, uses the host's normal OpenAI-compatible request path, and converts Sub2API usage responses into Magpie allowance cards.

Magpie calls the account-scoped `provider.models` hook after sign-in. Standalone OpenCode v1 has no auth available during its config hook and may skip dynamic model hooks for a provider that is not in `models.dev`; it can therefore show zero models unless you preconfigure model IDs manually. Use Magpie for dynamic discovery, multiple accounts, usage cards, and the complete contract.

## Install

During the initial rollout, install a local checkout or a pinned Git commit. Do not use `@latest` while the provider ID cutover is staged:

```json
{
  "plugin": [
    "/absolute/path/to/magpie-sub2api/packages/opencode-sub2api-auth"
  ]
}
```

After the package is reviewed and published, pin an exact package version instead of a floating tag.

## Sign in

The plugin has one API-key method:

1. **Sub2API OpenAI-compatible Base URL**, for example `https://relay.example/v1` or `http://192.168.1.20:8000/v1`.
2. **Account label (optional)**, used to distinguish two keys pointed at the same normalized endpoint.
3. **API key**, entered through OpenCode or Magpie's normal credential prompt.

The URL is normalized before it is saved. Credentials, query strings, fragments, and already-derived paths such as `/models`, `/usage`, `/chat/completions`, `/responses`, and `/messages` are rejected. A saved account is logically equivalent to:

```json
{
  "type": "api",
  "key": "<secret>",
  "metadata": {
    "baseURL": "https://relay.example/v1",
    "email": "relay.example/v1"
  }
}
```

`email` is only a display label. It is never sent to Sub2API. Supply a different optional label when two accounts use the same base URL; otherwise the normalized host/path is used. Multiple accounts are independent: each account has its own base URL, key, model list, usage response, and failure state.

## Endpoints and requests

The plugin derives endpoints only after URL normalization:

- `GET {baseURL}/models`
- `POST {baseURL}/chat/completions` (provided by `@ai-sdk/openai-compatible` and the OpenCode host)
- `GET {baseURL}/usage`

Model and usage discovery send `Authorization: Bearer <key>`. The loader returns the normalized `baseURL` and key to the host, so chat, streaming, and tool-call requests use the same account endpoint without a provider-specific Go transport.

## Model discovery

The plugin accepts an OpenAI-compatible response with `data[]` entries. It keeps the upstream model ID and display name and maps explicit context/input/output limits when the upstream provides them. It does not invent prices or capabilities. A malformed, empty, or failed model response throws; it never returns an empty map that would hide a previously working model list.

## Usage responses

Both Sub2API response families are supported.

### Unrestricted wallet/subscription

```json
{
  "planName": "Pro",
  "remaining": 104.89,
  "unit": "USD",
  "subscription": {
    "daily_usage_usd": 2,
    "daily_limit_usd": 100,
    "weekly_usage_usd": 50,
    "weekly_limit_usd": 200,
    "monthly_usage_usd": 10,
    "monthly_limit_usd": 500,
    "weekly_window_start": "2026-10-01T06:50:40Z"
  }
}
```

The result contains `$104.89` and positive daily, weekly, and monthly windows. Usage is clamped to 0-100 percent. A valid weekly start becomes a reset seven days later; an invalid or absent timestamp is left unset.

### Key-limited rate windows

```json
{
  "rate_limits": [
    { "window": "5h", "limit": 10, "used": 2, "reset_at": "2026-10-25T00:00:00Z" },
    { "window": "1d", "limit": 20, "used": 0 },
    { "window": "7d", "limit": 100, "used": 5 }
  ]
}
```

Recognized windows are `5h` (5 hours), `1d` (1 day), and `7d` (7 days). Each window reports the non-negative amount used, limit, USD unit, and a clamped percentage. A missing `reset_at` does not discard a valid window.

## Failure and security behavior

- Non-JSON, unusable, or temporary usage responses return an error with `signIn: "kept"`; they never become a fabricated zero balance.
- Only an explicit 401/403 response identifying an invalid, revoked, or expired API key returns `signIn: "expired"`.
- Error messages are bounded and redact the configured key. The key is never logged or put in a URL query string.
- Ordinary custom providers are not probed for `/usage`; the hook runs only for this plugin's accounts.

## Provider-ID cutover

The final ID is `sub2api`. Before enabling a live account in Magpie, remove or disable Magpie's native `sub2api` preset/plan-quota ownership in the cutover build. Otherwise Magpie intentionally guards the collision by showing `sub2api-plugin`, which is not the target contract.

Recommended order:

1. Run this package's tests and a local fake-server smoke test.
2. Remove the native preset and Sub2API-specific plan-quota reader in Magpie.
3. Install this package from a fixed local path or commit.
4. Sign in through the normal UI with the self-hosted base URL and key.
5. Verify models, chat, streaming, tool calls, and usage cards.
6. Rewrite `tflow-online/<model>` references to `sub2api/<model>` with a JSON-aware migration.
7. Remove the old custom provider and the usage-only workaround only after the plugin serves traffic.

If a smoke test fails, turn the plugin off and restore the timestamped Magpie backup. Keep the new plugin account backed up; do not delete `plugin-auth.json` wholesale.

## Development

No runtime dependency is required. Run the fake-server/unit suite with:

```sh
bun test packages/opencode-sub2api-auth/test
```

The tests never call a live Sub2API or TFlow endpoint.
