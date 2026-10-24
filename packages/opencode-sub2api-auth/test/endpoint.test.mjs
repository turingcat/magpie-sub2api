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
    ]) {
      expect(() => normalizeBaseURL(value)).toThrow()
    }
  })
})
