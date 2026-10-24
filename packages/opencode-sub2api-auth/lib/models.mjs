import { endpoint, normalizeBaseURL } from "./endpoint.mjs"

const MAX_ERROR_LENGTH = 240

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function firstNumber(...values) {
  return values.map(finiteNumber).find((value) => value !== undefined)
}

function messageFromBody(body) {
  if (!body || typeof body !== "object") return ""
  const error = body.error
  if (typeof error === "string") return error
  if (error && typeof error === "object" && typeof error.message === "string") return error.message
  for (const key of ["message", "detail", "error_description"]) {
    if (typeof body[key] === "string") return body[key]
  }
  return ""
}

function boundedMessage(value, secret = "") {
  let text = typeof value === "string" ? value : ""
  if (secret) text = text.split(secret).join("[redacted]")
  return text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_LENGTH)
}

function authRefused(status, payload, text) {
  if (status !== 401 && status !== 403) return false
  const error = payload?.error
  const code = typeof payload?.code === "string" || typeof payload?.code === "number"
    ? String(payload.code)
    : error && typeof error === "object" && (typeof error.code === "string" || typeof error.code === "number")
      ? String(error.code)
      : error && typeof error === "object" && typeof error.type === "string"
        ? error.type
        : ""
  const haystack = `${code} ${messageFromBody(payload)} ${text}`.toLowerCase()
  return /invalid[_ -]?(?:api[_ -]?)?key/.test(haystack)
    || /(?:invalid|revoked|expired)[^a-z0-9]*(?:api[_ -]?key|token|credential)/.test(haystack)
    || /(?:api[_ -]?key|token|credential)[^a-z0-9]*(?:invalid|revoked|expired)/.test(haystack)
}

function modelError(message, signIn) {
  const error = new Error(message)
  if (signIn) error.signIn = signIn
  return error
}

function modelLimit(raw) {
  const nested = raw.limits && typeof raw.limits === "object" ? raw.limits : {}
  const legacy = raw.limit && typeof raw.limit === "object" ? raw.limit : {}
  const limit = {}
  const context = firstNumber(raw.context_length, raw.context_window, raw.max_context_tokens, raw.context, nested.context, legacy.context)
  const input = firstNumber(raw.max_input_tokens, nested.input, legacy.input)
  const output = firstNumber(raw.max_output_tokens, raw.max_tokens, nested.output, legacy.output)
  if (context !== undefined) limit.context = context
  if (input !== undefined) limit.input = input
  if (output !== undefined) limit.output = output
  return Object.keys(limit).length ? limit : undefined
}

export function parseModels(payload, provider = {}) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.data)) {
    throw new Error("models response did not contain data[]")
  }

  const models = {}
  for (const raw of payload.data) {
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.id.trim()) continue
    const id = raw.id.trim()
    const name = typeof raw.name === "string" && raw.name.trim()
      ? raw.name.trim()
      : typeof raw.display_name === "string" && raw.display_name.trim()
        ? raw.display_name.trim()
        : id
    const discovered = {
      id,
      name,
      api: {
        id,
        url: typeof provider.api === "string" ? provider.api : "",
        npm: typeof provider.npm === "string" && provider.npm ? provider.npm : "@ai-sdk/openai-compatible",
      },
    }
    const limit = modelLimit(raw)
    if (limit) discovered.limit = limit
    if (typeof raw.reasoning === "boolean") discovered.capabilities = { reasoning: raw.reasoning }

    const configured = provider.models && typeof provider.models === "object" && !Array.isArray(provider.models)
      && provider.models[id] && typeof provider.models[id] === "object"
      ? provider.models[id]
      : {}
    const entry = {
      ...discovered,
      ...configured,
      id,
      api: { ...discovered.api, ...(configured.api && typeof configured.api === "object" ? configured.api : {}) },
    }
    if (discovered.limit || configured.limit) entry.limit = { ...(discovered.limit ?? {}), ...(configured.limit ?? {}) }
    if (discovered.capabilities || configured.capabilities) {
      entry.capabilities = { ...(discovered.capabilities ?? {}), ...(configured.capabilities ?? {}) }
    }
    models[id] = entry
  }

  if (!Object.keys(models).length) throw new Error("models response contained no usable models")
  return models
}

export async function fetchModels({ baseURL, apiKey, provider = {}, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable")
  const normalized = normalizeBaseURL(baseURL)
  let response
  let text
  try {
    response = await fetchImpl(endpoint(normalized, "models"), {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
    })
    text = await response.text()
  } catch (error) {
    throw new Error(`models request failed: ${boundedMessage(error?.message || "network error", apiKey) || "network error"}`)
  }
  let payload
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    if (!response.ok) {
      throw modelError(
        `models request failed (${response.status}): ${boundedMessage(text, apiKey) || "non-JSON response"}`,
        authRefused(response.status, null, text) ? "expired" : "",
      )
    }
    throw modelError("models response was not valid JSON")
  }
  if (!response.ok) {
    const detail = messageFromBody(payload) || boundedMessage(text, apiKey) || response.statusText || "request failed"
    throw modelError(
      `models request failed (${response.status}): ${boundedMessage(detail, apiKey)}`,
      authRefused(response.status, payload, text) ? "expired" : "",
    )
  }
  return parseModels(payload, provider)
}
