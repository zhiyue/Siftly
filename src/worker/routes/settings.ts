import { Hono } from 'hono'
import type { Bindings } from '../index'
import { getDb } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { settings } from '@/lib/schema'
import { invalidateSettingsCache } from '@/lib/settings'
import { resolveAnthropicClient } from '@/lib/claude-cli-auth'
import { resolveOpenAIClient } from '@/lib/openai-auth'

function maskKey(raw: string | null): string | null {
  if (!raw) return null
  if (raw.length <= 8) return '********'
  return `${raw.slice(0, 6)}${'*'.repeat(raw.length - 10)}${raw.slice(-4)}`
}

const ALLOWED_ANTHROPIC_MODELS = [
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
] as const

const ALLOWED_OPENAI_MODELS = [
  'gpt-4.1-mini',
  'gpt-4.1',
  'gpt-4.1-nano',
  'o4-mini',
  'o3',
  'claude-haiku-4-5',
  'claude-sonnet-4-5',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
] as const

async function getSetting(db: ReturnType<typeof getDb>, key: string) {
  const rows = await db.select().from(settings).where(eq(settings.key, key)).limit(1)
  return rows[0] ?? null
}

async function upsertSetting(db: ReturnType<typeof getDb>, key: string, value: string) {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
}

const route = new Hono<{ Bindings: Bindings }>()

// GET /api/settings
route.get('/api/settings', async (c) => {
  try {
    const db = getDb(c.env.DB)
    const [anthropic, anthropicModel, provider, openai, openaiModel, xClientId, xClientSecret] = await Promise.all([
      getSetting(db, 'anthropicApiKey'),
      getSetting(db, 'anthropicModel'),
      getSetting(db, 'aiProvider'),
      getSetting(db, 'openaiApiKey'),
      getSetting(db, 'openaiModel'),
      getSetting(db, 'x_oauth_client_id'),
      getSetting(db, 'x_oauth_client_secret'),
    ])

    return c.json({
      provider: provider?.value ?? 'anthropic',
      anthropicApiKey: maskKey(anthropic?.value ?? null),
      hasAnthropicKey: anthropic !== null,
      anthropicModel: anthropicModel?.value ?? 'claude-haiku-4-5-20251001',
      openaiApiKey: maskKey(openai?.value ?? null),
      hasOpenaiKey: openai !== null,
      openaiModel: openaiModel?.value ?? 'gpt-4.1-mini',
      xOAuthClientId: maskKey(xClientId?.value ?? null),
      xOAuthClientSecret: maskKey(xClientSecret?.value ?? null),
      hasXOAuth: !!xClientId?.value,
    })
  } catch (err) {
    console.error('Settings GET error:', err)
    return c.json(
      { error: `Failed to fetch settings: ${err instanceof Error ? err.message : String(err)}` },
      500
    )
  }
})

// POST /api/settings (used as PUT equivalent)
route.post('/api/settings', async (c) => {
  let body: {
    anthropicApiKey?: string
    anthropicModel?: string
    provider?: string
    openaiApiKey?: string
    openaiModel?: string
    openaiBaseUrl?: string
    anthropicBaseUrl?: string
    xOAuthClientId?: string
    xOAuthClientSecret?: string
  } = {}
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const db = getDb(c.env.DB)
  const { anthropicApiKey, anthropicModel, provider, openaiApiKey, openaiModel } = body

  if (provider !== undefined) {
    if (provider !== 'anthropic' && provider !== 'openai') {
      return c.json({ error: 'Invalid provider' }, 400)
    }
    await upsertSetting(db, 'aiProvider', provider)
    invalidateSettingsCache()
    return c.json({ saved: true })
  }

  if (anthropicModel !== undefined) {
    if (!(ALLOWED_ANTHROPIC_MODELS as readonly string[]).includes(anthropicModel)) {
      return c.json({ error: 'Invalid Anthropic model' }, 400)
    }
    await upsertSetting(db, 'anthropicModel', anthropicModel)
    invalidateSettingsCache()
    return c.json({ saved: true })
  }

  if (openaiModel !== undefined) {
    if (!(ALLOWED_OPENAI_MODELS as readonly string[]).includes(openaiModel)) {
      return c.json({ error: 'Invalid OpenAI model' }, 400)
    }
    await upsertSetting(db, 'openaiModel', openaiModel)
    invalidateSettingsCache()
    return c.json({ saved: true })
  }

  if (anthropicApiKey !== undefined) {
    if (typeof anthropicApiKey !== 'string' || anthropicApiKey.trim() === '') {
      return c.json({ error: 'Invalid anthropicApiKey value' }, 400)
    }
    try {
      await upsertSetting(db, 'anthropicApiKey', anthropicApiKey.trim())
      invalidateSettingsCache()
      return c.json({ saved: true })
    } catch (err) {
      console.error('Settings POST (anthropic) error:', err)
      return c.json(
        { error: `Failed to save: ${err instanceof Error ? err.message : String(err)}` },
        500
      )
    }
  }

  if (openaiApiKey !== undefined) {
    if (typeof openaiApiKey !== 'string' || openaiApiKey.trim() === '') {
      return c.json({ error: 'Invalid openaiApiKey value' }, 400)
    }
    try {
      await upsertSetting(db, 'openaiApiKey', openaiApiKey.trim())
      invalidateSettingsCache()
      return c.json({ saved: true })
    } catch (err) {
      console.error('Settings POST (openai) error:', err)
      return c.json(
        { error: `Failed to save: ${err instanceof Error ? err.message : String(err)}` },
        500
      )
    }
  }

  if (body.openaiBaseUrl !== undefined) {
    await upsertSetting(db, 'openaiBaseUrl', body.openaiBaseUrl.trim())
    invalidateSettingsCache()
    return c.json({ saved: true })
  }

  if (body.anthropicBaseUrl !== undefined) {
    await upsertSetting(db, 'anthropicBaseUrl', body.anthropicBaseUrl.trim())
    invalidateSettingsCache()
    return c.json({ saved: true })
  }

  const { xOAuthClientId, xOAuthClientSecret } = body
  const xKeys: { key: string; value: string | undefined }[] = [
    { key: 'x_oauth_client_id', value: xOAuthClientId },
    { key: 'x_oauth_client_secret', value: xOAuthClientSecret },
  ]
  const xToSave = xKeys.filter((k) => k.value !== undefined && k.value.trim() !== '')
  if (xToSave.length > 0) {
    try {
      for (const { key, value } of xToSave) {
        await upsertSetting(db, key, value!.trim())
      }
      return c.json({ saved: true })
    } catch (err) {
      console.error('Settings POST (X OAuth) error:', err)
      return c.json(
        { error: `Failed to save: ${err instanceof Error ? err.message : String(err)}` },
        500,
      )
    }
  }

  return c.json({ error: 'No setting provided' }, 400)
})

// DELETE /api/settings
route.delete('/api/settings', async (c) => {
  let body: { key?: string } = {}
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const allowed = ['anthropicApiKey', 'openaiApiKey', 'x_oauth_client_id', 'x_oauth_client_secret']
  if (!body.key || !allowed.includes(body.key)) {
    return c.json({ error: 'Invalid key' }, 400)
  }

  const db = getDb(c.env.DB)
  await db.delete(settings).where(eq(settings.key, body.key))
  invalidateSettingsCache()
  return c.json({ deleted: true })
})

// POST /api/settings/test — validate API key
route.post('/api/settings/test', async (c) => {
  let body: { provider?: string } = {}
  try {
    const text = await c.req.text()
    if (text.trim()) body = JSON.parse(text)
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  const provider = body.provider ?? 'anthropic'
  const db = getDb(c.env.DB)

  if (provider === 'anthropic') {
    const rows = await db.select().from(settings).where(eq(settings.key, 'anthropicApiKey')).limit(1)
    const dbKey = rows[0]?.value?.trim()

    let client
    try {
      client = resolveAnthropicClient({
        dbKey,
        baseURL: c.env.ANTHROPIC_BASE_URL || undefined,
      })
    } catch {
      return c.json({ working: false, error: 'No API key found. Add one in Settings.' })
    }

    try {
      await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 5,
        messages: [{ role: 'user', content: 'hi' }],
      })
      return c.json({ working: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const friendly = msg.includes('401') || msg.includes('invalid_api_key')
        ? 'Invalid API key'
        : msg.includes('403')
        ? 'Key does not have permission'
        : msg.slice(0, 120)
      return c.json({ working: false, error: friendly })
    }
  }

  if (provider === 'openai') {
    const rows = await db.select().from(settings).where(eq(settings.key, 'openaiApiKey')).limit(1)
    const dbKey = rows[0]?.value?.trim()

    let client
    try {
      client = resolveOpenAIClient({
        dbKey,
        baseURL: c.env.OPENAI_BASE_URL || undefined,
      })
    } catch {
      return c.json({ working: false, error: 'No OpenAI API key found. Add one in Settings.' })
    }

    try {
      await client.chat.completions.create({
        model: 'gpt-4.1-mini',
        max_tokens: 5,
        messages: [{ role: 'user', content: 'hi' }],
      })
      return c.json({ working: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const friendly = msg.includes('401') || msg.includes('invalid_api_key')
        ? 'Invalid API key'
        : msg.includes('403')
        ? 'Key does not have permission'
        : msg.slice(0, 120)
      return c.json({ working: false, error: friendly })
    }
  }

  return c.json({ error: 'Unknown provider' }, 400)
})

export default route
