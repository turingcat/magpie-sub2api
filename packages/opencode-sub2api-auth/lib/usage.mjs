import { endpoint, normalizeBaseURL } from "./endpoint.mjs"

const MAX_ERROR_LENGTH = 240
const RATE_WINDOWS = [
  { id: "5h", name: "5 hours", span: 5 * 60 * 60 },
  { id: "1d", name: "1 day", span: 24 * 60 * 60 },
  { id: "7d", name: "7 days", span: 7 * 24 * 60 * 60 },
]

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value))
}

function dateISO(value) {
  if (value === undefined || value === null || value === "") return ""
  const date = typeof value === "number"
    ? new Date(Math.abs(value) < 1e11 ? value * 1000 : value)
    : new Date(value)
  return Number.isNaN(date.getTime()) ? "" : date.toISOString()
}

function errorText(payload) {
  if (!payload || typeof payload !== "object") return ""
  if (typeof payload.error === "string") return payload.error
  if (payload.error && typeof payload.error === "object") {
    if (typeof payload.error.message === "string") return payload.error.message
    if (typeof payload.error.detail === "string") return payload.error.detail
  }
  for (const key of ["message", "detail", "error_description"]) {
    if (typeof payload[key] === "string") return payload[key]
  }
  return ""
}

function errorCode(payload) {
  if (!payload || typeof payload !== "object") return ""
  if (typeof payload.code === "string" || typeof payload.code === "number") return String(payload.code)
  if (payload.error && typeof payload.error === "object") {
    for (const key of ["code", "type", "status"]) {
      if (typeof payload.error[key] === "string" || typeof payload.error[key] === "number") return String(payload.error[key])
    }
  }
  return ""
}

function bounded(value, secret = "") {
  let text = typeof value === "string" ? value : ""
  if (secret) text = text.split(secret).join("[redacted]")
  return text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_LENGTH)
}

function authRefused(status, payload, text) {
  if (status !== 401 && status !== 403) return false
  const haystack = `${errorCode(payload)} ${errorText(payload)} ${text}`.toLowerCase()
  return /invalid[_ -]?(?:api[_ -]?)?key/.test(haystack)
    || /(?:invalid|revoked|expired)[^a-z0-9]*(?:api[_ -]?key|token|credential)/.test(haystack)
    || /(?:api[_ -]?key|token|credential)[^a-z0-9]*(?:invalid|revoked|expired)/.test(haystack)
}

function formatBalance(value, unit) {
  const amount = finiteNumber(value)
  if (amount === undefined) return ""
  const label = typeof unit === "string" ? unit.trim() : ""
  return !label || label.toUpperCase() === "USD"
    ? `$${amount.toFixed(2)}`
    : `${amount.toFixed(2)} ${label}`
}

function unrestrictedWindows(subscription) {
  if (!subscription || typeof subscription !== "object") return []
  const definitions = [
    ["24 hours", "daily_usage_usd", "daily_limit_usd", 24 * 60 * 60],
    ["7 days", "weekly_usage_usd", "weekly_limit_usd", 7 * 24 * 60 * 60],
    ["30 days", "monthly_usage_usd", "monthly_limit_usd", 30 * 24 * 60 * 60],
  ]
  const windows = []
  for (const [name, usageKey, limitKey, span] of definitions) {
    const limit = finiteNumber(subscription[limitKey])
    if (limit === undefined || limit <= 0) continue
    const amount = Math.max(0, finiteNumber(subscription[usageKey]) ?? 0)
    windows.push({ name, used: clamp(amount / limit * 100, 0, 100), amount, limit, unit: "USD", span })
  }
  const weekly = windows.find((window) => window.name === "7 days")
  const weeklyStart = dateISO(subscription.weekly_window_start)
  if (weekly && weeklyStart) weekly.resetsAt = new Date(Date.parse(weeklyStart) + 7 * 24 * 60 * 60 * 1000).toISOString()
  return windows
}

function limitedWindows(rateLimits) {
  if (!Array.isArray(rateLimits)) return []
  const windows = []
  for (const definition of RATE_WINDOWS) {
    const raw = rateLimits.find((candidate) => candidate && candidate.window === definition.id)
    const limit = finiteNumber(raw?.limit)
    if (limit === undefined || limit <= 0) continue
    const amount = Math.max(0, finiteNumber(raw?.used) ?? 0)
    const window = { name: definition.name, used: clamp(amount / limit * 100, 0, 100), amount, limit, unit: "USD", span: definition.span }
    const reset = dateISO(raw?.reset_at)
    if (reset) window.resetsAt = reset
    windows.push(window)
  }
  return windows
}

export function parseUsage(payload) {
  if (!payload || typeof payload !== "object") throw new Error("usage response was not an object")

  const result = {}
  if (typeof payload.planName === "string" && payload.planName.trim()) result.plan = payload.planName.trim()
  const balance = formatBalance(payload.remaining, payload.unit)
  if (balance) result.balance = balance

  let windows = limitedWindows(payload.rate_limits)
  if (!windows.length) windows = unrestrictedWindows(payload.subscription)
  if (windows.length) result.windows = windows

  if (!result.balance && !result.windows) throw new Error("usage response had no usable balance or windows")
  return result
}

export async function fetchUsage({ baseURL, apiKey, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== "function") return { error: "fetch is unavailable", signIn: "kept" }

  let response
  let text
  try {
    const normalized = normalizeBaseURL(baseURL)
    response = await fetchImpl(endpoint(normalized, "usage"), {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
    })
    text = await response.text()
  } catch (error) {
    return { error: bounded(error?.message || "usage request failed", apiKey), signIn: "kept" }
  }
  let payload = null
  let parseError = false
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    parseError = true
  }

  if (!response.ok) {
    const detail = errorText(payload) || bounded(text, apiKey) || response.statusText || "request failed"
    return {
      error: `usage request failed (${response.status}): ${bounded(detail, apiKey)}`,
      signIn: authRefused(response.status, payload, text) ? "expired" : "kept",
    }
  }
  if (parseError) return { error: "usage response was not valid JSON", signIn: "kept" }

  try {
    return parseUsage(payload)
  } catch (error) {
    return { error: bounded(error?.message || "usage response was unusable", apiKey), signIn: "kept" }
  }
}

export { RATE_WINDOWS }
