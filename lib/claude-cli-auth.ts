import Anthropic from '@anthropic-ai/sdk'

/**
 * Resolves an Anthropic client. Auth chain:
 * 1. Override key (from request)
 * 2. DB-saved key
 * 3. ANTHROPIC_API_KEY Workers Secret (passed via envApiKey)
 */
export function resolveAnthropicClient(options: {
  overrideKey?: string
  dbKey?: string
  baseURL?: string
  envApiKey?: string    // ANTHROPIC_API_KEY from c.env
  envBaseURL?: string   // ANTHROPIC_BASE_URL from c.env
} = {}): Anthropic {
  const baseURL = options.baseURL || options.envBaseURL || undefined

  if (options.overrideKey?.trim()) {
    return new Anthropic({ apiKey: options.overrideKey.trim(), ...(baseURL ? { baseURL } : {}) })
  }

  if (options.dbKey?.trim()) {
    return new Anthropic({ apiKey: options.dbKey.trim(), ...(baseURL ? { baseURL } : {}) })
  }

  const envKey = options.envApiKey?.trim()
  if (envKey) {
    return new Anthropic({ apiKey: envKey, ...(baseURL ? { baseURL } : {}) })
  }

  if (baseURL) {
    return new Anthropic({ apiKey: 'proxy', baseURL })
  }

  throw new Error('No Anthropic API key found. Add your key in Settings.')
}
