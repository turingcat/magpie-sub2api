const DISALLOWED_TERMINAL_PATHS = new Set(["models", "usage", "responses", "messages"])

export function normalizeBaseURL(value) {
  if (typeof value !== "string") throw new TypeError("base URL must be a string")
  const raw = value.trim()
  if (!raw) throw new Error("base URL is required")

  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error("base URL must be an absolute HTTP(S) URL")
  }

  if (!/^https?:$/.test(url.protocol) || !url.hostname) {
    throw new Error("base URL must be an absolute HTTP(S) URL")
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("base URL must not contain credentials, query, or fragment")
  }

  const parts = url.pathname.split("/").filter(Boolean)
  const last = parts.at(-1)?.toLowerCase()
  const previous = parts.at(-2)?.toLowerCase()
  if (DISALLOWED_TERMINAL_PATHS.has(last) || (previous === "chat" && last === "completions")) {
    throw new Error("base URL must not be a derived endpoint")
  }

  const path = parts.length ? `/${parts.join("/")}` : ""
  return `${url.origin}${path}`
}

export function endpoint(baseURL, suffix) {
  if (typeof suffix !== "string" || !suffix.trim()) throw new TypeError("endpoint suffix is required")
  return `${normalizeBaseURL(baseURL)}/${suffix.replace(/^\/+/, "")}`
}
