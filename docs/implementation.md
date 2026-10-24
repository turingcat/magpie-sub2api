# Sub2API Provider Plugin Implementation

Status: implemented in this repository on 2026-10-24.

This document records the implementation of the approved design in `docs/superpowers/specs/2026-10-24-sub2api-provider-plugin-design.md`. The repository is the public GitHub project `turingcat/magpie-sub2api` and contains the community OpenCode/Magpie plugin package. It does not silently modify the separate Magpie checkout at `/Users/turingcat/Project/magpie`.

## Delivered package

`packages/opencode-sub2api-auth/` contains:

- `package.json`: ESM package metadata and the `index.mjs` entry point, with no runtime dependencies.
- `index.mjs`: provider ID `sub2api`, API-key sign-in with a Base URL prompt, account loader, dynamic model hook, and usage hook.
- `lib/endpoint.mjs`: pure HTTP(S) base URL normalization and endpoint derivation.
- `lib/models.mjs`: OpenAI-compatible `data[]` parsing and authenticated `/models` discovery.
- `lib/usage.mjs`: unrestricted wallet/subscription and key-limited `rate_limits` parsing plus bounded HTTP error semantics.
- `test/*.test.mjs`: fake-server and pure parser tests for URL safety, account isolation, model retention, usage windows, and sign-in state.
- `README.md`: installation, endpoint, response, security, migration, and rollback guidance.

The loader returns the normalized account endpoint and API key to `@ai-sdk/openai-compatible`; request forwarding remains owned by the OpenCode/Magpie host. This keeps the package free of Magpie file writes and provider-specific Go transport.

## Behavior implemented

- Accepts local/LAN HTTP and public HTTPS URLs, preserves nested paths, and rejects credentials, query strings, fragments, and derived endpoint paths.
- Calls each account's own `/models` and `/usage` endpoint with its own Bearer key.
- Keeps upstream model IDs/names and explicit limits only; no synthetic prices are added.
- Throws on model-list failure so the host can keep the last good list.
- Displays wallet balances and 24-hour, 7-day, and 30-day subscription windows.
- Displays 5-hour, 1-day, and 7-day `rate_limits` windows, including windows with no reset timestamp.
- Clamps usage percentages to 0-100 and omits unknown balances instead of rendering `$0.00`.
- Preserves accounts on temporary usage failures (`signIn: "kept"`) and expires only explicit invalid/revoked-key responses.
- Redacts keys from bounded error messages and never sends them in query strings.

## Verification run

The implementation was developed test-first. Each package task began with a failing import/contract test, followed by the minimal implementation and a passing task suite.

```sh
bun test packages/opencode-sub2api-auth/test/endpoint.test.mjs
# 3 pass, 0 fail

bun test packages/opencode-sub2api-auth/test/models.test.mjs
# 5 pass, 0 fail

bun test packages/opencode-sub2api-auth/test/usage.test.mjs
# 8 pass, 0 fail

bun test packages/opencode-sub2api-auth/test
# 19 pass, 0 fail
```

All HTTP tests use local fake servers. No live Sub2API, TFlow, or external vendor endpoint is contacted.

## Magpie cutover boundary

The final provider ID is intentionally `sub2api`, but Magpie must have one owner for that ID. The following changes belong in the separate Magpie-main cutover build and are not included in this plugin repository:

1. Remove the native `sub2api` preset from `internal/provider/presets.go`.
2. Remove the `preset == "sub2api"` URL/parser branch from `internal/provider/planquota.go`.
3. Audit `internal/provider/sub2api_usage.go` and the `sub2APIKeyLimits` path in `balance.go`/`key_allowance.go`; keep only generic compatibility if another legacy flow still needs it.
4. Add Magpie integration coverage for plugin models, chat/streaming/tool calls, usage cards, routing, multiple accounts, and the exact `sub2api` ID.
5. Update Magpie's owning references in `docs/integrating.md`, `docs/subsystems/provider-plugins.md`, and `docs/subsystems/providers-accounts.md`.

Until that build is deployed, installing the plugin alongside the native preset may be shown by Magpie as the guarded `sub2api-plugin` variant. That staged state is not accepted as the final contract.

## Migration and rollback

Create timestamped backups of `providers.json`, `plugin-auth.json`, `plugin-providers.json`, `plugins.json`, `logins.json`, and `quotas.json` before changing a live Magpie configuration. Export the existing `tflow-online` endpoint, selected models, proxy, and routing references without printing its key. Add the plugin account through the normal UI, verify `/models`, chat, streaming, tool calls, and `/usage`, then rewrite only known JSON provider/model fields from `tflow-online/<model>` to `sub2api/<model>`. Remove the old custom provider and usage-only plugin after the new account serves requests and exactly one Sub2API usage card remains.

For rollback, disable the plugin, restore the old provider and model references from the timestamped backup, and keep the new plugin account archived. Never delete `plugin-auth.json` wholesale.

## Acceptance status

The plugin package meets the package-level design acceptance criteria. Magpie-main ownership cutover and live-instance smoke verification remain explicit follow-up work because changing those files would modify a different checkout and could create a duplicate provider owner.
