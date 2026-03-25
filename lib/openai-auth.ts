import OpenAI from 'openai'

/**
 * Resolves an OpenAI client. Auth chain:
 * 1. Override key (from request)
 * 2. DB-saved key
 * 3. OPENAI_API_KEY Workers Secret (passed via envApiKey)
 */
export function resolveOpenAIClient(options: {
  overrideKey?: string
  dbKey?: string
  baseURL?: string
  envApiKey?: string    // OPENAI_API_KEY from c.env
  envBaseURL?: string   // OPENAI_BASE_URL from c.env
} = {}): OpenAI {
  const baseURL = options.baseURL || options.envBaseURL || undefined

  if (options.overrideKey?.trim()) {
    return new OpenAI({ apiKey: options.overrideKey.trim(), ...(baseURL ? { baseURL } : {}) })
  }

  if (options.dbKey?.trim()) {
    return new OpenAI({ apiKey: options.dbKey.trim(), ...(baseURL ? { baseURL } : {}) })
  }

  const envKey = options.envApiKey?.trim()
  if (envKey) {
    return new OpenAI({ apiKey: envKey, ...(baseURL ? { baseURL } : {}) })
  }

  if (baseURL) {
    return new OpenAI({ apiKey: 'proxy', baseURL })
  }

  throw new Error('No OpenAI API key found. Add your key in Settings.')
}
