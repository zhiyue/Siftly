import OpenAI from 'openai'
import { getCloudflareContext } from '@opennextjs/cloudflare'

/**
 * Resolves an OpenAI client. Auth chain:
 * 1. Override key (from request)
 * 2. DB-saved key
 * 3. OPENAI_API_KEY Workers Secret
 */
export function resolveOpenAIClient(options: {
  overrideKey?: string
  dbKey?: string
  baseURL?: string
} = {}): OpenAI {
  const { env } = getCloudflareContext()
  const baseURL = options.baseURL || env.OPENAI_BASE_URL || undefined

  if (options.overrideKey?.trim()) {
    return new OpenAI({ apiKey: options.overrideKey.trim(), ...(baseURL ? { baseURL } : {}) })
  }

  if (options.dbKey?.trim()) {
    return new OpenAI({ apiKey: options.dbKey.trim(), ...(baseURL ? { baseURL } : {}) })
  }

  const envKey = env.OPENAI_API_KEY?.trim()
  if (envKey) {
    return new OpenAI({ apiKey: envKey, ...(baseURL ? { baseURL } : {}) })
  }

  if (baseURL) {
    return new OpenAI({ apiKey: 'proxy', baseURL })
  }

  throw new Error('No OpenAI API key found. Add your key in Settings.')
}
