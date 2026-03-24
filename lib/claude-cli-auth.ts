import Anthropic from '@anthropic-ai/sdk'
import { getCloudflareContext } from '@opennextjs/cloudflare'

/**
 * Resolves an Anthropic client. Auth chain:
 * 1. Override key (from request)
 * 2. DB-saved key
 * 3. ANTHROPIC_API_KEY Workers Secret
 */
export function resolveAnthropicClient(options: {
  overrideKey?: string
  dbKey?: string
  baseURL?: string
} = {}): Anthropic {
  const { env } = getCloudflareContext()
  const baseURL = options.baseURL || env.ANTHROPIC_BASE_URL || undefined

  if (options.overrideKey?.trim()) {
    return new Anthropic({ apiKey: options.overrideKey.trim(), ...(baseURL ? { baseURL } : {}) })
  }

  if (options.dbKey?.trim()) {
    return new Anthropic({ apiKey: options.dbKey.trim(), ...(baseURL ? { baseURL } : {}) })
  }

  const envKey = env.ANTHROPIC_API_KEY?.trim()
  if (envKey) {
    return new Anthropic({ apiKey: envKey, ...(baseURL ? { baseURL } : {}) })
  }

  if (baseURL) {
    return new Anthropic({ apiKey: 'proxy', baseURL })
  }

  throw new Error('No Anthropic API key found. Add your key in Settings.')
}
