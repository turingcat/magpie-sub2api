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
  expect(hooks.auth.methods[0].prompts[1].key).toBe("label")
  const result = await hooks.auth.methods[0].authorize({ baseURL: " https://relay.example/v1/ ", label: "Home relay" })
  expect(result).toMatchObject({ type: "success", metadata: { baseURL: "https://relay.example/v1", email: "Home relay" } })
  const derived = await hooks.auth.methods[0].authorize({ baseURL: "https://relay.example/v1" })
  expect(derived.metadata.email).toBe("relay.example/v1")
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
    const isOne = req.headers.authorization === "Bearer one-key"
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
  const oneAuth = auth("one-key", `${origin}/v1`)
  const twoAuth = auth("two-key", `${origin}/v1`)
  const oneModels = await hooks.provider.models(oneProvider, { auth: oneAuth })
  const twoModels = await hooks.provider.models(twoProvider, { auth: twoAuth })
  const oneUsage = await hooks.auth.usage(async () => oneAuth, oneProvider)
  const twoUsage = await hooks.auth.usage(async () => twoAuth, twoProvider)

  expect(Object.keys(oneModels)).toEqual(["one-model"])
  expect(Object.keys(twoModels)).toEqual(["two-model"])
  expect(oneUsage).toMatchObject({ plan: "One Plan", balance: "$4.00" })
  expect(twoUsage).toMatchObject({ plan: "Two Plan", balance: "$8.00" })
  expect(requests).toEqual([
    { path: "/v1/models", authorization: "Bearer one-key" },
    { path: "/v1/models", authorization: "Bearer two-key" },
    { path: "/v1/usage", authorization: "Bearer one-key" },
    { path: "/v1/usage", authorization: "Bearer two-key" },
  ])
})

test("loader options drive chat, streaming, and tool-call request shapes", async () => {
  const requests = []
  const server = await listen(async (req, res) => {
    const body = await new Promise((resolve, reject) => {
      let text = ""
      req.setEncoding("utf8")
      req.on("data", (chunk) => { text += chunk })
      req.on("end", () => resolve(text ? JSON.parse(text) : null))
      req.on("error", reject)
    })
    requests.push({ path: req.url, authorization: req.headers.authorization, body })
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write("data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n")
    res.end("data: [DONE]\n\n")
  })
  const hooks = await Sub2APIAuthPlugin({})
  const loaded = await hooks.auth.loader(async () => auth("chat-key", `http://127.0.0.1:${server.address().port}/v1`))
  const body = {
    model: "model-a",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
    tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
  }
  const response = await fetch(`${loaded.baseURL}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${loaded.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })

  expect(response.ok).toBe(true)
  expect(await response.text()).toContain("[DONE]")
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({ path: "/v1/chat/completions", authorization: "Bearer chat-key" })
  expect(requests[0].body).toMatchObject({ model: "model-a", stream: true, tools: [{ type: "function" }] })
})
