# Sub2API Provider Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax tracking.

**Goal:** Build a public, installable OpenCode/Magpie provider plugin with provider ID `sub2api` that discovers models, forwards OpenAI-compatible requests, and reports Sub2API wallet and rate-limit usage for multiple independent accounts.

**Architecture:** Keep all Sub2API-specific behavior in a small ESM package under `packages/opencode-sub2api-auth/`. Pure endpoint, model, and usage modules own normalization and parsing; the plugin entry composes them into the OpenCode v1 `config`, `auth`, and `provider.models` hooks. The plugin never writes Magpie files; the host owns credential persistence and request proxying. Magpie core cutover remains a documented integration step because this repository intentionally contains only the community plugin.

**Tech Stack:** JavaScript ESM, Bun/Node built-in `fetch`, `node:test`/Bun test runner, no runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-24-sub2api-provider-plugin-design.md`

## Global Constraints

- Final plugin/provider ID is exactly `sub2api`; do not publish a `sub2api-plugin` variant.
- The package lives at `packages/opencode-sub2api-auth/` and uses a fixed local path or Git commit for initial installation, never `@latest`.
- Accept only absolute `http`/`https` base URLs; preserve nested paths and reject credentials, query strings, fragments, empty hosts, and endpoint paths (`/models`, `/usage`, `/chat/completions`, `/responses`, `/messages`).
- Derive only `{baseURL}/models`, `{baseURL}/chat/completions`, and `{baseURL}/usage` after normalization.
- Never log, URL-encode, or include an API key in an error message or query string.
- A model-list failure throws and preserves the host's last good list; it must not return an empty map.
- A malformed or failed usage read is unknown, never a fabricated zero balance; transient failures return `signIn: "kept"` and only explicit invalid/revoked-key responses return `signIn: "expired"`.
- Usage windows are `5 hours`, `1 day`, `7 days`, `24 hours`, `30 days`, and `7 days` with the spans and clamping rules defined by the design spec.
- No runtime dependency is added unless the implementation proves a built-in API insufficient.
- Automated tests use fake HTTP servers and never call a live Sub2API/TFlow endpoint.

## Review Focus

- URL input containing credentials, query/fragment data, or a terminal endpoint path must be rejected without leaking the input in a thrown message.
- Two stored accounts with different base URLs must use their own model and usage endpoints and Bearer keys; no module-level account state may cross-contaminate them.
- A successful model list followed by a failed refresh must throw while leaving the previous model map available to the host.
- A usage response with a missing reset timestamp, negative/over-limit usage, or wallet-only data must produce a truthful card rather than drop the valid window or show `$0.00`.
- Non-JSON, non-2xx, and network failures must be bounded and key-free; only a verified invalid/revoked-key response may expire the account.

---

### Task 1: Package scaffold and endpoint contract

**Files:**
- Create: `packages/opencode-sub2api-auth/package.json`
- Create: `packages/opencode-sub2api-auth/lib/endpoint.mjs`
- Create: `packages/opencode-sub2api-auth/test/endpoint.test.mjs`

**Interfaces:**
- Produces `normalizeBaseURL(value: unknown): string`, which later tasks use before deriving `/models`, `/usage`, or request endpoints.

- [ ] **Step 1: Write the failing tests**

```js
import { describe, expect, test } from "bun:test"
import { normalizeBaseURL } from "../lib/endpoint.mjs"

describe("normalizeBaseURL", () => {
  test("trims trailing slashes and preserves a nested path", () => {
    expect(normalizeBaseURL(" https://relay.example/api/v1/// ")).toBe("https://relay.example/api/v1")
  })

  test("accepts a self-hosted LAN HTTP endpoint", () => {
    expect(normalizeBaseURL("http://192.168.1.20:8000/v1/")).toBe("http://192.168.1.20:8000/v1")
  })

  test("rejects credentials, query strings, fragments, and derived endpoint paths", () => {
    for (const value of [
      "https://user@relay.example/v1",
      "https://relay.example/v1?token=secret",
      "https://relay.example/v1#models",
      "https://relay.example/v1/models",
      "https://relay.example/v1/chat/completions",
    ]) expect(() => normalizeBaseURL(value)).toThrow()
  })
})
```

- [ ] **Step 2: Run the endpoint test and verify it fails**

Run: `bun test packages/opencode-sub2api-auth/test/endpoint.test.mjs`

Expected: FAIL because `lib/endpoint.mjs` does not exist yet.

- [ ] **Step 3: Implement the minimal endpoint normalizer**

```js
const DERIVED = new Set(["models", "usage", "chat", "responses", "messages"])

export function normalizeBaseURL(value) {
  if (typeof value !== "string") throw new TypeError("base URL must be a string")
  const raw = value.trim()
  const url = new URL(raw)
  if (!/^https?:$/.test(url.protocol) || !url.hostname) throw new Error("base URL must be absolute HTTP(S)")
  if (url.username || url.password || url.search || url.hash) throw new Error("base URL must not contain credentials, query, or fragment")
  const parts = url.pathname.split("/").filter(Boolean)
  if (DERIVED.has(parts.at(-1)?.toLowerCase())) throw new Error("base URL must not be a derived endpoint")
  url.pathname = parts.length ? `/${parts.join("/")}` : ""
  url.href = url.href.replace(/\/$/, "")
  return url.toString().replace(/\/$/, "")
}

export function endpoint(baseURL, suffix) {
  return `${normalizeBaseURL(baseURL)}/${suffix.replace(/^\/+/, "")}`
}
```

- [ ] **Step 4: Run the endpoint tests and package metadata check**

Run: `bun test packages/opencode-sub2api-auth/test/endpoint.test.mjs`

Expected: all endpoint tests pass, including the LAN HTTP case.

- [ ] **Step 5: Commit the scaffold**

```bash
git add packages/opencode-sub2api-auth
git commit -m "feat: add sub2api plugin package scaffold"
```

### Task 2: OpenAI-compatible model parsing and discovery

**Files:**
- Create: `packages/opencode-sub2api-auth/lib/models.mjs`
- Create: `packages/opencode-sub2api-auth/test/models.test.mjs`

**Interfaces:**
- Produces `parseModels(payload, provider): object`, mapping only supplied model ID/name/context/output fields to OpenCode model objects.
- Produces `fetchModels({ baseURL, apiKey, provider, fetchImpl }): Promise<object>`, which calls `GET {baseURL}/models` with `Authorization: Bearer <apiKey>` and throws bounded errors on any failed response.

- [ ] **Step 1: Write failing parser and fake-server tests**

```js
import { afterEach, describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import { fetchModels, parseModels } from "../lib/models.mjs"

test("parseModels keeps upstream ids, names, and explicit limits without inventing prices", () => {
  const models = parseModels({ data: [
    { id: "gpt-4.1", name: "GPT 4.1", context_length: 128000, max_output_tokens: 8192 },
    { id: "plain" },
  ] }, { id: "sub2api", api: "https://relay.invalid/v1", npm: "@ai-sdk/openai-compatible" })
  expect(models["gpt-4.1"]).toMatchObject({ id: "gpt-4.1", name: "GPT 4.1", limit: { context: 128000, output: 8192 } })
  expect(models["gpt-4.1"].cost).toBeUndefined()
  expect(models.plain).toMatchObject({ id: "plain", name: "plain" })
})

test("fetchModels authenticates the configured account and rejects non-JSON failures", async () => {
  const server = createServer((req, res) => {
    expect(req.url).toBe("/v1/models")
    expect(req.headers.authorization).toBe("Bearer account-key")
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ data: [{ id: "model-a" }] }))
  }).listen(0)
  try {
    const models = await fetchModels({ baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "account-key", provider: { id: "sub2api" } })
    expect(Object.keys(models)).toEqual(["model-a"])
  } finally { server.close() }
})
```

- [ ] **Step 2: Run the model tests and verify they fail**

Run: `bun test packages/opencode-sub2api-auth/test/models.test.mjs`

Expected: FAIL because the parser and fetcher are not defined.

- [ ] **Step 3: Implement the parser and bounded fetcher**

Use the normalized endpoint helper, accept only an object payload with a `data` array, skip entries without a non-empty string `id`, use `name` or `display_name` or the ID for display, and map numeric context/output fields only when finite. Throw an error containing the HTTP status and a bounded safe vendor message for non-2xx responses; never include the API key.

- [ ] **Step 4: Add account-isolation and transient-failure tests**

Use one fake server that records two different base URLs/keys and assert each call receives only its own Bearer key. Add a test where the server first returns a model list and then returns 503; assert the second `fetchModels` call rejects (the provider hook will retain the host's prior list rather than receive `{}`).

- [ ] **Step 5: Run all model tests**

Run: `bun test packages/opencode-sub2api-auth/test/models.test.mjs`

Expected: all parser, authentication, isolation, and failure tests pass.

- [ ] **Step 6: Commit model discovery**

```bash
git add packages/opencode-sub2api-auth/lib/models.mjs packages/opencode-sub2api-auth/test/models.test.mjs
git commit -m "feat: discover sub2api models per account"
```

### Task 3: Usage normalization and error semantics

**Files:**
- Create: `packages/opencode-sub2api-auth/lib/usage.mjs`
- Create: `packages/opencode-sub2api-auth/test/usage.test.mjs`

**Interfaces:**
- Produces `parseUsage(payload): { plan?, balance?, windows? }`, supporting unrestricted wallet/subscription and `rate_limits` responses.
- Produces `fetchUsage({ baseURL, apiKey, fetchImpl }): Promise<object>`, which calls `/usage`, parses JSON, and returns host-compatible error/sign-in semantics.

- [ ] **Step 1: Write failing pure usage tests**

```js
import { describe, expect, test } from "bun:test"
import { parseUsage } from "../lib/usage.mjs"

test("maps an unrestricted wallet and subscription windows", () => {
  const usage = parseUsage({ planName: "Pro", remaining: 104.89, unit: "USD", subscription: {
    daily_usage_usd: -2, daily_limit_usd: 100, weekly_usage_usd: 50, weekly_limit_usd: 200,
    monthly_usage_usd: 10, monthly_limit_usd: 500, weekly_window_start: "2026-10-01T06:50:40Z",
  } })
  expect(usage).toMatchObject({ plan: "Pro", balance: "$104.89" })
  expect(usage.windows).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "24 hours", used: 0, amount: 0, limit: 100, span: 86400 }),
    expect.objectContaining({ name: "7 days", used: 25, limit: 200, span: 604800, resetsAt: "2026-10-08T06:50:40.000Z" }),
  ]))
})

test("maps quota-limited windows, clamps over-limit usage, and keeps missing reset times", () => {
  const usage = parseUsage({ rate_limits: [
    { window: "5h", limit: 10, used: 12 },
    { window: "1d", limit: 20, used: -1 },
    { window: "7d", limit: 100, used: 5 },
  ] })
  expect(usage.windows).toEqual([
    expect.objectContaining({ name: "5 hours", used: 100, amount: 12, limit: 10, span: 18000 }),
    expect.objectContaining({ name: "1 day", used: 0, amount: 0, span: 86400 }),
    expect.objectContaining({ name: "7 days", used: 5, span: 604800 }),
  ])
})
```

- [ ] **Step 2: Run usage tests and verify they fail**

Run: `bun test packages/opencode-sub2api-auth/test/usage.test.mjs`

Expected: FAIL because `lib/usage.mjs` does not exist.

- [ ] **Step 3: Implement pure parsing**

Implement numeric finite checks, USD/other-unit balance formatting, 0–100 usage clamping, positive-limit filtering, the `weekly_window_start + 7 days` reset, and the exact `rate_limits` window table. Throw when neither a finite balance nor a usable window is present.

- [ ] **Step 4: Add HTTP and error-semantics tests**

Use a fake HTTP server to assert `/usage` and Bearer auth. Cover successful wallet-only data, malformed JSON, non-2xx JSON with a bounded safe message, a network refusal returning `signIn: "kept"`, and an explicit `401 {"error":{"message":"Invalid API key"}}` returning `signIn: "expired"`. Assert neither errors nor serialized results contain the key.

- [ ] **Step 5: Run all usage tests**

Run: `bun test packages/opencode-sub2api-auth/test/usage.test.mjs`

Expected: all pure parser and HTTP/error tests pass.

- [ ] **Step 6: Commit usage handling**

```bash
git add packages/opencode-sub2api-auth/lib/usage.mjs packages/opencode-sub2api-auth/test/usage.test.mjs
git commit -m "feat: parse sub2api usage and quota windows"
```

### Task 4: Compose the OpenCode/Magpie plugin entry

**Files:**
- Create: `packages/opencode-sub2api-auth/index.mjs`
- Modify: `packages/opencode-sub2api-auth/package.json`
- Create: `packages/opencode-sub2api-auth/test/plugin.test.mjs`

**Interfaces:**
- Produces the async default export `Sub2APIAuthPlugin({ client }): Promise<{config, auth, provider}>`.
- `config(cfg)` registers provider ID `sub2api`, name `Sub2API`, npm `@ai-sdk/openai-compatible`, and a harmless empty model seed.
- `auth.methods[0]` asks for a Base URL and returns normalized metadata; `auth.loader(getAuth)` returns the account's normalized `baseURL` and API key; `auth.usage(getAuth)` delegates to `fetchUsage`.
- `provider.models(provider, { auth })` delegates to `fetchModels` and returns a model map or throws.

- [ ] **Step 1: Write failing plugin contract tests**

```js
import { expect, test } from "bun:test"
import Sub2APIAuthPlugin from "../index.mjs"

test("registers the exact sub2api provider ID and API-key flow", async () => {
  const hooks = await Sub2APIAuthPlugin({})
  const cfg = {}
  await hooks.config(cfg)
  expect(cfg.provider.sub2api.name).toBe("Sub2API")
  expect(hooks.auth.provider).toBe("sub2api")
  expect(hooks.auth.methods[0].prompts[0].key).toBe("baseURL")
  const result = await hooks.auth.methods[0].authorize({ baseURL: " https://relay.example/v1/ " })
  expect(result).toMatchObject({ type: "success", metadata: { baseURL: "https://relay.example/v1" } })
})

test("loader keeps accounts independent", async () => {
  const hooks = await Sub2APIAuthPlugin({})
  const one = await hooks.auth.loader(async () => ({ type: "api", key: "one", metadata: { baseURL: "https://one.example/v1" } }))
  const two = await hooks.auth.loader(async () => ({ type: "api", key: "two", metadata: { baseURL: "https://two.example/v1" } }))
  expect(one).toMatchObject({ baseURL: "https://one.example/v1", apiKey: "one" })
  expect(two).toMatchObject({ baseURL: "https://two.example/v1", apiKey: "two" })
})
```

- [ ] **Step 2: Run plugin tests and verify they fail**

Run: `bun test packages/opencode-sub2api-auth/test/plugin.test.mjs`

Expected: FAIL because the plugin entry does not exist.

- [ ] **Step 3: Implement the entry with no file-system access**

Use the pure modules from Tasks 1–3. Keep `provider.models` strict: never convert a fetch error into `{}`. Keep `config` additive so user model overrides remain intact. Derive the account label from the normalized URL host/path (the key slot still separates duplicate accounts), and expose only the documented API-key method.

- [ ] **Step 4: Add a full fake-server plugin smoke test**

Start two local HTTP servers, sign in two accounts through the loader shape, call `provider.models` and `auth.usage` for both, and assert model IDs, usage plans, endpoint paths, and Bearer headers stay independent. Verify the config provider uses `@ai-sdk/openai-compatible` and no model has invented prices.

- [ ] **Step 5: Run the package test suite**

Run: `bun test packages/opencode-sub2api-auth/test`

Expected: every endpoint, model, usage, and plugin contract test passes.

- [ ] **Step 6: Commit plugin composition**

```bash
git add packages/opencode-sub2api-auth/index.mjs packages/opencode-sub2api-auth/package.json packages/opencode-sub2api-auth/test/plugin.test.mjs
git commit -m "feat: expose sub2api as an OpenCode provider plugin"
```

### Task 5: User documentation and cutover checklist

**Files:**
- Create: `packages/opencode-sub2api-auth/README.md`
- Create: `docs/implementation.md`

**Interfaces:**
- Documents the install/configure flow, supported response shapes, security boundaries, migration ordering, rollback, and exact verification commands without claiming Magpie core cutover happened in this repository.

- [ ] **Step 1: Write documentation acceptance checks**

Search the new docs for the exact provider ID (`sub2api`), endpoint examples, `rate_limits`, `signIn: "kept"`, `signIn: "expired"`, the no-`@latest` rule, the native-preset removal prerequisite, and the rollback procedure. The checks should fail until both documents exist.

- [ ] **Step 2: Write concise package README and implementation record**

The README must show local/Git installation, the Base URL format, account behavior, model/usage response contracts, no-key-logging guarantee, fake-server test command, and the requirement to remove Magpie's native preset before activating the final ID. `docs/implementation.md` must record completed package files, deferred Magpie-main integration edits, migration order, acceptance criteria, and commands actually run.

- [ ] **Step 3: Run docs and package verification**

Run:

```sh
test -f packages/opencode-sub2api-auth/README.md
test -f docs/implementation.md
rg -n 'sub2api|rate_limits|signIn: "kept"|signIn: "expired"|@latest|native|rollback' packages/opencode-sub2api-auth/README.md docs/implementation.md
bun test packages/opencode-sub2api-auth/test
```

Expected: all file checks, required terms, and package tests pass.

- [ ] **Step 4: Commit documentation**

```bash
git add packages/opencode-sub2api-auth/README.md docs/implementation.md
git commit -m "docs: document sub2api plugin implementation and cutover"
```

### Task 6: Final verification and public repository sync

**Files:**
- Verify: all tracked files in the repository

- [ ] **Step 1: Run the complete local verification**

```sh
bun test packages/opencode-sub2api-auth/test
node --check packages/opencode-sub2api-auth/index.mjs
node --check packages/opencode-sub2api-auth/lib/endpoint.mjs
node --check packages/opencode-sub2api-auth/lib/models.mjs
node --check packages/opencode-sub2api-auth/lib/usage.mjs
git diff --check
```

Expected: all commands exit 0 with no whitespace errors.

- [ ] **Step 2: Inspect requirements against the design**

Confirm the final plugin ID is `sub2api`, no native Magpie files were silently modified, model discovery throws on failure, usage errors never fabricate zero, and no test uses a live vendor URL.

- [ ] **Step 3: Commit any verification-only fixes**

```bash
git add .
git commit -m "chore: verify sub2api provider plugin"
```

- [ ] **Step 4: Push and verify the public GitHub repository**

```bash
git push origin main
gh repo view turingcat/magpie-sub2api --json nameWithOwner,isPrivate,url,defaultBranchRef
```

Expected: `nameWithOwner` is `turingcat/magpie-sub2api`, `isPrivate` is `false`, and the default branch is `main`.

---

## Coverage and Known Boundary

The plugin package and its parsers are implemented here. Magpie-main's native `sub2api` preset removal, legacy `sub2APIKeyLimits` audit, account migration, and GUI/integration tests remain a separate cutover change in `/Users/turingcat/Project/magpie`; activating this plugin before that owner change would intentionally produce Magpie's guarded `sub2api-plugin` variant and is not accepted.
