import { afterEach, describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import { fetchModels, parseModels } from "../lib/models.mjs"

const servers = []
afterEach(() => Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))) )

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    servers.push(server)
    server.listen(0, "127.0.0.1", () => resolve(server))
  })
}

describe("parseModels", () => {
  test("keeps upstream ids, names, and explicit limits without inventing prices", () => {
    const models = parseModels({ data: [
      { id: "gpt-4.1", name: "GPT 4.1", context_length: 128000, max_output_tokens: 8192 },
      { id: "plain" },
      { name: "missing id" },
    ] }, { id: "sub2api", api: "https://relay.invalid/v1", npm: "@ai-sdk/openai-compatible" })

    expect(models["gpt-4.1"]).toMatchObject({
      id: "gpt-4.1",
      name: "GPT 4.1",
      limit: { context: 128000, output: 8192 },
    })
    expect(models["gpt-4.1"].cost).toBeUndefined()
    expect(models.plain).toMatchObject({ id: "plain", name: "plain" })
    expect(models["missing id"]).toBeUndefined()
  })

  test("uses display_name and supports explicit nested limits", () => {
    const models = parseModels({ data: [{ id: "nested", display_name: "Nested", limits: { context: 4096, input: 3000, output: 1000 } }] }, { id: "sub2api" })
    expect(models.nested).toMatchObject({
      id: "nested",
      name: "Nested",
      limit: { context: 4096, input: 3000, output: 1000 },
    })
  })
})

test("fetchModels authenticates the configured account and maps the endpoint response", async () => {
  const server = await listen((req, res) => {
    expect(req.url).toBe("/v1/models")
    expect(req.headers.authorization).toBe("Bearer account-key")
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ data: [{ id: "model-a" }] }))
  })

  const models = await fetchModels({
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    apiKey: "account-key",
    provider: { id: "sub2api", api: "https://relay.invalid/v1", npm: "@ai-sdk/openai-compatible" },
  })
  expect(Object.keys(models)).toEqual(["model-a"])
})

test("fetchModels keeps two endpoint accounts isolated", async () => {
  const requests = []
  const server = await listen((req, res) => {
    requests.push({ path: req.url, authorization: req.headers.authorization })
    const id = req.url === "/one/models" ? "one-model" : "two-model"
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ data: [{ id }] }))
  })
  const origin = `http://127.0.0.1:${server.address().port}`

  const one = await fetchModels({ baseURL: `${origin}/one`, apiKey: "key-one", provider: { id: "sub2api" } })
  const two = await fetchModels({ baseURL: `${origin}/two`, apiKey: "key-two", provider: { id: "sub2api" } })

  expect(Object.keys(one)).toEqual(["one-model"])
  expect(Object.keys(two)).toEqual(["two-model"])
  expect(requests).toEqual([
    { path: "/one/models", authorization: "Bearer key-one" },
    { path: "/two/models", authorization: "Bearer key-two" },
  ])
})

test("fetchModels rejects failed refreshes without returning an empty model map or leaking the key", async () => {
  let calls = 0
  const server = await listen((_req, res) => {
    calls += 1
    if (calls === 1) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ data: [{ id: "last-good" }] }))
      return
    }
    res.writeHead(503, { "content-type": "text/plain" })
    res.end("temporary outage for key-to-keep")
  })
  const options = { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "key-to-keep", provider: { id: "sub2api" } }

  const previous = await fetchModels(options)
  await expect(fetchModels(options)).rejects.toThrow(/503/)
  await expect(fetchModels(options)).rejects.toThrow(/temporary outage/)
  expect(previous).toEqual(expect.objectContaining({ "last-good": expect.any(Object) }))
  try {
    await fetchModels(options)
  } catch (error) {
    expect(error.message).not.toContain("key-to-keep")
  }
})
