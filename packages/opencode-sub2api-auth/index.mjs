import { normalizeBaseURL } from "./lib/endpoint.mjs"
import { fetchModels } from "./lib/models.mjs"
import { fetchUsage } from "./lib/usage.mjs"

export const PROVIDER_ID = "sub2api"
const PROVIDER_NAME = "Sub2API"
const API_NPM = "@ai-sdk/openai-compatible"

function accountConfig(auth) {
  if (!auth || typeof auth !== "object") throw new Error("not signed in to Sub2API")
  const baseURL = auth.metadata?.baseURL ?? auth.baseURL
  const apiKey = typeof auth.key === "string" ? auth.key : ""
  if (!baseURL || !apiKey) throw new Error("Sub2API account is missing a base URL or API key")
  return { baseURL: normalizeBaseURL(baseURL), apiKey }
}

function accountLabel(baseURL) {
  const url = new URL(baseURL)
  return `${url.host}${url.pathname || "/"}`
}

function baseURLPrompt() {
  return {
    type: "text",
    key: "baseURL",
    message: "Sub2API OpenAI-compatible Base URL",
    placeholder: "https://relay.example/v1",
    validate(value) {
      try {
        normalizeBaseURL(value)
        return undefined
      } catch (error) {
        return error?.message || "Enter an absolute HTTP(S) base URL"
      }
    },
  }
}

function siteNamePrompt() {
  return {
    type: "text",
    key: "siteName",
    message: "Site name (optional; shown instead of Sub2API)",
    placeholder: "Home site",
  }
}

export async function Sub2APIAuthPlugin() {
  return {
    config: async (config) => {
      config.provider ??= {}
      const existing = config.provider[PROVIDER_ID] ?? {}
      config.provider[PROVIDER_ID] = {
        ...existing,
        name: PROVIDER_NAME,
        npm: API_NPM,
        models: existing.models && typeof existing.models === "object" && !Array.isArray(existing.models) ? { ...existing.models } : {},
      }
    },

    auth: {
      provider: PROVIDER_ID,
      methods: [
        {
          type: "api",
          label: "API key",
          prompts: [baseURLPrompt(), siteNamePrompt()],
          authorize: async (inputs = {}) => {
            try {
              const baseURL = normalizeBaseURL(inputs.baseURL)
              const siteName = typeof inputs.siteName === "string" ? inputs.siteName.trim().slice(0, 80) : ""
              const email = siteName || accountLabel(baseURL)
              return { type: "success", metadata: { baseURL, email, ...(siteName ? { siteName } : {}) } }
            } catch (error) {
              return { type: "failed", error: error?.message || "Invalid Sub2API base URL" }
            }
          },
        },
      ],
      loader: async (getAuth) => {
        const { baseURL, apiKey } = accountConfig(await getAuth())
        return { baseURL, apiKey }
      },
      usage: async (getAuth) => {
        try {
          return await fetchUsage(accountConfig(await getAuth()))
        } catch (error) {
          return { error: error?.message || "Sub2API usage is unavailable", signIn: "kept" }
        }
      },
    },

    provider: {
      id: PROVIDER_ID,
      models: async (provider, { auth }) => {
        const account = accountConfig(auth)
        return fetchModels({ ...account, provider: provider ?? { id: PROVIDER_ID, npm: API_NPM } })
      },
    },
  }
}

export default Sub2APIAuthPlugin
