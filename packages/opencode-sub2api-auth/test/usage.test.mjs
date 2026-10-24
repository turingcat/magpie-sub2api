import { afterEach, describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import { fetchUsage, parseUsage } from "../lib/usage.mjs"

const servers = []
afterEach(() => Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))) )

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    servers.push(server)
    server.listen(0, "127.0.0.1", () => resolve(server))
  })
}

describe("parseUsage", () => {
  test("maps an unrestricted wallet and subscription windows", () => {
    const usage = parseUsage({
      planName: "Pro",
      remaining: 104.89,
      unit: "USD",
      subscription: {
        daily_usage_usd: -2,
        daily_limit_usd: 100,
        weekly_usage_usd: 50,
        weekly_limit_usd: 200,
        monthly_usage_usd: 10,
        monthly_limit_usd: 500,
        weekly_window_start: "2026-10-01T06:50:40Z",
      },
    })

    expect(usage).toMatchObject({ plan: "Pro", balance: "$104.89" })
    expect(usage.windows).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "24 hours", used: 0, amount: 0, limit: 100, unit: "USD", span: 86400 }),
      expect.objectContaining({ name: "7 days", used: 25, amount: 50, limit: 200, unit: "USD", span: 604800, resetsAt: "2026-10-08T06:50:40.000Z" }),
      expect.objectContaining({ name: "30 days", used: 2, amount: 10, limit: 500, span: 2592000 }),
    ]))
  })

  test("maps quota-limited windows, clamps over-limit usage, and keeps missing reset times", () => {
    const usage = parseUsage({ rate_limits: [
      { window: "5h", limit: 10, used: 12, reset_at: "2026-10-25T00:00:00Z" },
      { window: "1d", limit: 20, used: -1 },
      { window: "7d", limit: 100, used: 5 },
      { window: "unknown", limit: 99, used: 1 },
    ] })

    expect(usage.windows).toEqual([
      expect.objectContaining({ name: "5 hours", used: 100, amount: 12, limit: 10, unit: "USD", span: 18000 }),
      expect.objectContaining({ name: "1 day", used: 0, amount: 0, limit: 20, unit: "USD", span: 86400 }),
      expect.objectContaining({ name: "7 days", used: 5, amount: 5, limit: 100, unit: "USD", span: 604800 }),
    ])
    expect(usage.windows[0].resetsAt).toBe("2026-10-25T00:00:00.000Z")
    expect(usage.windows[1].resetsAt).toBeUndefined()
  })

  test("omits a non-finite balance but accepts a wallet-only response", () => {
    expect(parseUsage({ planName: "Wallet", remaining: 8.25, unit: "credits" })).toEqual({ plan: "Wallet", balance: "8.25 credits" })
    expect(() => parseUsage({ remaining: Number.NaN, unit: "USD" })).toThrow()
  })
})

test("fetchUsage authenticates the configured account and returns wallet data", async () => {
  const server = await listen((req, res) => {
    expect(req.url).toBe("/v1/usage")
    expect(req.headers.authorization).toBe("Bearer usage-key")
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ planName: "Wallet", remaining: 12.5, unit: "USD" }))
  })

  const usage = await fetchUsage({ baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "usage-key" })
  expect(usage).toEqual({ plan: "Wallet", balance: "$12.50" })
})

test("fetchUsage keeps a temporary non-JSON failure and never echoes the key", async () => {
  const server = await listen((_req, res) => {
    res.writeHead(503, { "content-type": "text/plain" })
    res.end("upstream unavailable for usage-key")
  })

  const usage = await fetchUsage({ baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "usage-key" })
  expect(usage.signIn).toBe("kept")
  expect(usage.error).toMatch(/503/)
  expect(usage.error).not.toContain("usage-key")
})

test("fetchUsage preserves the account for network failures", async () => {
  const usage = await fetchUsage({
    baseURL: "http://127.0.0.1:9/v1",
    apiKey: "network-key",
    fetchImpl: async () => { throw new Error("network failed for network-key") },
  })
  expect(usage.signIn).toBe("kept")
  expect(usage.error).not.toContain("network-key")
})

test("fetchUsage redacts failures while reading a response body", async () => {
  const usage = await fetchUsage({
    baseURL: "http://127.0.0.1:9/v1",
    apiKey: "body-key",
    fetchImpl: async () => ({
      ok: true,
      text: async () => { throw new Error("body failed for body-key") },
    }),
  })
  expect(usage.signIn).toBe("kept")
  expect(usage.error).not.toContain("body-key")
})

test("fetchUsage expires only an explicitly invalid key response", async () => {
  const server = await listen((_req, res) => {
    res.writeHead(401, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: { code: "invalid_api_key", message: "Invalid API key" } }))
  })

  const usage = await fetchUsage({ baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "expired-key" })
  expect(usage.signIn).toBe("expired")
  expect(usage.error).not.toContain("expired-key")
})

test("fetchUsage reports malformed successful JSON as a kept account", async () => {
  const server = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end("not-json")
  })
  const usage = await fetchUsage({ baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "json-key" })
  expect(usage).toMatchObject({ signIn: "kept" })
  expect(usage.error).toMatch(/JSON/)
})
