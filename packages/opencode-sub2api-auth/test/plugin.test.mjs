import { afterEach, describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import Sub2APIAuthPlugin from "../index.mjs"

const servers = []
afterEach(() => Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))) )

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    servers.push(server)
    server.listen(0, "127.0.0.1", () => resolve(server))
  })
}

function auth(key, baseURL) {
  return { type: "api", key, metadata: { baseURL } }
}

test("registers the exact sub2api provider ID and API-key flow", async () => {
  const hooks = await Sub2APIAuthPlugin({})
  const cfg = {}
  await hooks.config(cfg)

  expect(cfg.provider.sub2api).toMatchObject({ name: "Sub2API", npm: "@ai-sdk/openai-compatible" })
  expect(hooks.auth.provider).toBe("sub2api")
  expect(hooks.auth.methods).toHaveLength(1)
  expect(hooks.auth.methods[0].type).toBe("api")
  expect(hooks.auth.methods[0].prompts[0].key).toBe("baseURL")
  const result = await hooks.auth.methods[0].authorize({ baseURL: " https://relay.example/v1/ " })
  expect(result).toMatchObject({ type: "success", metadata: { baseURL: "https://relay.example/v1" } })
  expect(result.metadata.email).toBe("relay.example/v1")
  expect(await hooks.auth.methods[0].authorize({ baseURL: "https://relay.example/v1/models" })).toMatchObject({ type: "failed" })
})

test("loader keeps accounts independent", async () => {
  const hooks = await Sub2APIAuthPlugin({})
  const one = await hooks.auth.loader(async () => auth("one", "https://one.example/v1"))
  const two = await hooks.auth.loader(async () => auth("two", "https://two.example/v1"))

  expect(one).toMatchObject({ baseURL: "https://one.example/v1", apiKey: "one" })
  expect(two).toMatchObject({ baseURL: "https://two.example/v1", apiKey: "two" })
})

test("models and usage hooks use each account's endpoint and key", async () => {
  const requests = []
  const server = await listen((req, res) => {
    requests.push({ path: req.url, authorization: req.headers.authorization })
    const isOne = req.url.startsWith("/one/")
    const body = req.url.endsWith("/models")
      ? { data: [{ id: isOne ? "one-model" : "two-model", name: isOne ? "One" : "Two" }] }
      : { planName: isOne ? "One Plan" : "Two Plan", remaining: isOne ? 4 : 8, unit: "USD" }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  })
  const origin = `http://127.0.0.1:${server.address().port}`
  const hooks = await Sub2APIAuthPlugin({})

  const oneProvider = { id: "sub2api", api: "", npm: "@ai-sdk/openai-compatible" }
  const twoProvider = { id: "sub2api", api: "", npm: "@ai-sdk/openai-compatible" }
  const oneAuth = auth("one-key", `${origin}/one/v1`)
  const twoAuth = auth("two-key", `${origin}/two/v1`)
  const oneModels = await hooks.provider.models(oneProvider, { auth: oneAuth })
  const twoModels = await hooks.provider.models(twoProvider, { auth: twoAuth })
  const oneUsage = await hooks.auth.usage(async () => oneAuth, oneProvider)
  const twoUsage = await hooks.auth.usage(async () => twoAuth, twoProvider)

  expect(Object.keys(oneModels)).toEqual(["one-model"])
  expect(Object.keys(twoModels)).toEqual(["two-model"])
  expect(oneUsage).toMatchObject({ plan: "One Plan", balance: "$4.00" })
  expect(twoUsage).toMatchObject({ plan: "Two Plan", balance: "$8.00" })
  expect(requests).toEqual([
    { path: "/one/v1/models", authorization: "Bearer one-key" },
    { path: "/two/v1/models", authorization: "Bearer two-key" },
    { path: "/one/v1/usage", authorization: "Bearer one-key" },
    { path: "/two/v1/usage", authorization: "Bearer two-key" },
  ])
})
