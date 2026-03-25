import { eq } from 'drizzle-orm'
import { settings } from '@/lib/schema'
import type { AppDb } from '@/lib/db'

// Module-level caches — avoids hundreds of DB roundtrips per pipeline run
let _cachedModel: string | null = null
let _modelCacheExpiry = 0

let _cachedProvider: 'anthropic' | 'openai' | null = null
let _providerCacheExpiry = 0

let _cachedOpenAIModel: string | null = null
let _openAIModelCacheExpiry = 0

const CACHE_TTL = 5 * 60 * 1000

/**
 * Get the configured Anthropic model from settings (cached for 5 minutes).
 */
export async function getAnthropicModel(db: AppDb): Promise<string> {
  if (_cachedModel && Date.now() < _modelCacheExpiry) return _cachedModel
  const rows = await db
    .select()
    .from(settings)
    .where(eq(settings.key, 'anthropicModel'))
    .limit(1)
  const model = rows[0]?.value ?? 'claude-haiku-4-5-20251001'
  _cachedModel = model
  _modelCacheExpiry = Date.now() + CACHE_TTL
  return model
}

/**
 * Get the active AI provider (cached for 5 minutes).
 */
export async function getProvider(db: AppDb): Promise<'anthropic' | 'openai'> {
  if (_cachedProvider && Date.now() < _providerCacheExpiry) return _cachedProvider
  const rows = await db
    .select()
    .from(settings)
    .where(eq(settings.key, 'aiProvider'))
    .limit(1)
  _cachedProvider = rows[0]?.value === 'openai' ? 'openai' : 'anthropic'
  _providerCacheExpiry = Date.now() + CACHE_TTL
  return _cachedProvider
}

/**
 * Get the configured OpenAI model from settings (cached for 5 minutes).
 */
export async function getOpenAIModel(db: AppDb): Promise<string> {
  if (_cachedOpenAIModel && Date.now() < _openAIModelCacheExpiry) return _cachedOpenAIModel
  const rows = await db
    .select()
    .from(settings)
    .where(eq(settings.key, 'openaiModel'))
    .limit(1)
  const model = rows[0]?.value ?? 'gpt-4.1-mini'
  _cachedOpenAIModel = model
  _openAIModelCacheExpiry = Date.now() + CACHE_TTL
  return model
}

/**
 * Get the model for the currently active provider.
 */
export async function getActiveModel(db: AppDb): Promise<string> {
  const provider = await getProvider(db)
  return provider === 'openai' ? getOpenAIModel(db) : getAnthropicModel(db)
}

/**
 * Clear all settings caches (call after settings are changed).
 */
export function invalidateSettingsCache(): void {
  _cachedModel = null
  _modelCacheExpiry = 0
  _cachedProvider = null
  _providerCacheExpiry = 0
  _cachedOpenAIModel = null
  _openAIModelCacheExpiry = 0
}
