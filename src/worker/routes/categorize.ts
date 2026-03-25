import { Hono } from 'hono'
import type { Bindings } from '../index'
import { getDb } from '@/lib/db'
import { eq, isNull, inArray, asc, count as countFn } from 'drizzle-orm'
import { bookmarks, categories, mediaItems, settings } from '@/lib/schema'
import { AIClient, resolveAIClient } from '@/lib/ai-client'
import { getActiveModel, getProvider } from '@/lib/settings'
import {
  seedDefaultCategories,
  categorizeBatch,
  mapBookmarkForCategorization,
  writeCategoryResults,
  BOOKMARK_SELECT,
} from '@/lib/categorizer'
import {
  analyzeItem,
  enrichBatchSemanticTags,
  BookmarkForEnrichment,
} from '@/lib/vision-analyzer'
import { backfillEntities } from '@/lib/rawjson-extractor'
import { rebuildFts } from '@/lib/fts'
import type { PipelineState } from '@/lib/pipeline-state'

const CAT_BATCH_SIZE = 25

const route = new Hono<{ Bindings: Bindings }>()

/** Get a singleton DO stub from Hono context */
function getStub(env: Bindings) {
  const id = env.PIPELINE_DO.idFromName('singleton')
  return env.PIPELINE_DO.get(id)
}

// GET /api/categorize — pipeline status
route.get('/api/categorize', async (c) => {
  const stub = getStub(c.env)
  const resp = await stub.fetch(new Request('https://do/status'))
  return c.json(await resp.json())
})

// DELETE /api/categorize — stop pipeline
route.delete('/api/categorize', async (c) => {
  const stub = getStub(c.env)
  const resp = await stub.fetch(new Request('https://do/stop', { method: 'POST' }))
  const data = await resp.json()
  if (resp.status !== 200) return c.json(data, resp.status as 409)
  return c.json(data)
})

// POST /api/categorize — start pipeline
route.post('/api/categorize', async (c) => {
  let body: { bookmarkIds?: string[]; apiKey?: string; force?: boolean } = {}
  try {
    const text = await c.req.text()
    if (text.trim()) body = JSON.parse(text)
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const d1 = c.env.DB
  const db = getDb(d1)
  const bucket = c.env.MEDIA_BUCKET
  const env = c.env
  const { bookmarkIds = [], apiKey, force = false } = body

  // Save API key if provided
  if (apiKey && typeof apiKey === 'string' && apiKey.trim() !== '') {
    const currentProvider = await getProvider(db)
    const keySlot = currentProvider === 'openai' ? 'openaiApiKey' : 'anthropicApiKey'
    await db
      .insert(settings)
      .values({ key: keySlot, value: apiKey.trim() })
      .onConflictDoUpdate({ target: settings.key, set: { value: apiKey.trim() } })
  }

  // Count total bookmarks to process
  let total = 0
  try {
    if (bookmarkIds.length > 0) {
      total = bookmarkIds.length
    } else if (force) {
      const [row] = await db.select({ count: countFn() }).from(bookmarks)
      total = row.count
    } else {
      const [row] = await db
        .select({ count: countFn() })
        .from(bookmarks)
        .where(isNull(bookmarks.enrichedAt))
      total = row.count
    }
  } catch {
    total = 0
  }

  // Resolve the API key from DB before entering the background task
  const provider = await getProvider(db)
  const keyName = provider === 'openai' ? 'openaiApiKey' : 'anthropicApiKey'
  const dbApiKeyRows = await db
    .select()
    .from(settings)
    .where(eq(settings.key, keyName))
    .limit(1)
  const dbApiKey = dbApiKeyRows[0]?.value?.trim() || ''

  // Start via DO
  const stub = getStub(c.env)
  const startResp = await stub.fetch(new Request('https://do/start', {
    method: 'POST',
    body: JSON.stringify({ total }),
    headers: { 'Content-Type': 'application/json' },
  }))
  if (startResp.status === 409) {
    return c.json(await startResp.json(), 409)
  }

  // Run pipeline in background via ctx.waitUntil
  c.executionCtx.waitUntil(
    runPipeline({ bookmarkIds, force, dbApiKey, total, d1, bucket, env, stub })
      .then(async (wasStopped) => {
        await stub.fetch(new Request('https://do/finish', {
          method: 'POST',
          body: JSON.stringify({ wasStopped }),
          headers: { 'Content-Type': 'application/json' },
        }))
      })
      .catch(async (err) => {
        console.error('Pipeline error:', err)
        await stub.fetch(new Request('https://do/finish', {
          method: 'POST',
          body: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
          headers: { 'Content-Type': 'application/json' },
        }))
      }),
  )

  return c.json({ status: 'started', total })
})

// ── DO helpers ──────────────────────────────────────────────────────

async function updateState(stub: DurableObjectStub, update: Partial<PipelineState>): Promise<void> {
  await stub.fetch(new Request('https://do/update', {
    method: 'POST',
    body: JSON.stringify(update),
    headers: { 'Content-Type': 'application/json' },
  }))
}

async function shouldAbort(stub: DurableObjectStub): Promise<boolean> {
  const resp = await stub.fetch(new Request('https://do/status'))
  const state = (await resp.json()) as PipelineState
  return state.status === 'stopping'
}

// ── Pipeline runner ──────────────────────────────────────────────────

async function runPipeline(opts: {
  bookmarkIds: string[]
  force: boolean
  dbApiKey: string
  total: number
  d1: D1Database
  bucket: R2Bucket
  env: Bindings
  stub: DurableObjectStub
}): Promise<boolean> {
  const { bookmarkIds, force, dbApiKey, d1, bucket, env, stub } = opts
  const db = getDb(d1)
  const counts = { visionTagged: 0, entitiesExtracted: 0, enriched: 0, categorized: 0 }

  let client: AIClient | null = null
  try {
    client = await resolveAIClient({ db, dbKey: dbApiKey, env })
  } catch {
    console.warn('No SDK client available -- will rely on configured keys')
  }

  await seedDefaultCategories(db)

  if (force) {
    await db
      .update(mediaItems)
      .set({ imageTags: null })
      .where(eq(mediaItems.imageTags, '{}'))
    await db
      .update(bookmarks)
      .set({ semanticTags: null })
      .where(eq(bookmarks.semanticTags, '[]'))
  }

  // Stage 1: Entity extraction (free, fast -- no API calls)
  if (!(await shouldAbort(stub))) {
    await updateState(stub, { stage: 'entities' })
    counts.entitiesExtracted = await backfillEntities(db, (n) => {
      counts.entitiesExtracted = n
      // Fire-and-forget update to avoid blocking the callback
      updateState(stub, { stageCounts: { ...counts } }).catch(() => {})
    }, () => shouldAbort(stub)).catch((err) => {
      console.error('Entity extraction error:', err)
      return counts.entitiesExtracted
    })
    await updateState(stub, { stageCounts: { ...counts } })
  }

  // Stage 2: Parallel pipeline -- vision + enrichment + categorize per bookmark
  if (!(await shouldAbort(stub))) {
    let bookmarkIdsToProcess: string[]
    if (bookmarkIds.length > 0) {
      bookmarkIdsToProcess = bookmarkIds
    } else if (force) {
      const all = await db
        .select({ id: bookmarks.id })
        .from(bookmarks)
        .orderBy(asc(bookmarks.id))
      bookmarkIdsToProcess = all.map((b) => b.id)
    } else {
      const unprocessed = await db
        .select({ id: bookmarks.id })
        .from(bookmarks)
        .where(isNull(bookmarks.enrichedAt))
        .orderBy(asc(bookmarks.id))
      bookmarkIdsToProcess = unprocessed.map((b) => b.id)
    }

    const runTotal = bookmarkIdsToProcess.length
    await updateState(stub, { stage: 'parallel', done: 0, total: runTotal, stageCounts: { ...counts } })

    // Load category metadata once
    const dbCategories = await db
      .select({ slug: categories.slug, name: categories.name, description: categories.description })
      .from(categories)
    const allSlugs = dbCategories.map((c) => c.slug)
    const categoryDescriptions = Object.fromEntries(
      dbCategories.map((c) => [c.slug, c.description?.trim() || c.name]),
    )
    const model = await getActiveModel(db)

    // Categorization queue
    const catPending: string[] = []
    let catFlushing = false

    async function drainCategorizeQueue(final = false): Promise<void> {
      if (final) {
        while (catFlushing) {
          await new Promise<void>((resolve) => setTimeout(resolve, 50))
        }
      } else if (catFlushing || catPending.length < CAT_BATCH_SIZE) {
        return
      }

      catFlushing = true
      try {
        while (catPending.length > 0) {
          if (!final && catPending.length < CAT_BATCH_SIZE) break
          const ids = catPending.splice(0, CAT_BATCH_SIZE)
          if (ids.length === 0) break
          const rows = await db.query.bookmarks.findMany({
            where: inArray(bookmarks.id, ids),
            columns: BOOKMARK_SELECT,
            with: { mediaItems: { columns: { imageTags: true } } },
          })
          const batch = rows.map(mapBookmarkForCategorization)
          try {
            const results = await categorizeBatch(db, batch, client, categoryDescriptions, allSlugs)
            await writeCategoryResults(d1, db, results)
            counts.categorized += ids.length
            await updateState(stub, { stageCounts: { ...counts } })
          } catch (catErr) {
            console.error('[parallel] categorize batch error:', catErr)
          }
        }
      } finally {
        catFlushing = false
      }
    }

    let processedCount = 0

    for (const bookmarkId of bookmarkIdsToProcess) {
      if (await shouldAbort(stub)) break

      const bm = await db.query.bookmarks.findFirst({
        where: eq(bookmarks.id, bookmarkId),
        columns: {
          id: true,
          text: true,
          semanticTags: true,
          entities: true,
        },
        with: {
          mediaItems: {
            where: inArray(mediaItems.type, ['photo', 'gif', 'video']),
            columns: { id: true, bookmarkId: true, url: true, thumbnailUrl: true, type: true, imageTags: true },
          },
        },
      })
      if (!bm) continue

      // Vision: analyze any untagged media items
      let anyVisionRan = false
      for (const media of bm.mediaItems) {
        if (await shouldAbort(stub)) break
        if (media.imageTags !== null) continue
        try {
          await analyzeItem(
            db,
            bucket,
            { id: media.id, bookmarkId: media.bookmarkId, url: media.url, thumbnailUrl: media.thumbnailUrl, type: media.type },
            client!,
            model,
          )
          anyVisionRan = true
          counts.visionTagged++
          await updateState(stub, { stageCounts: { ...counts } })
        } catch (err) {
          console.warn('[parallel] vision failed for', media.id, err instanceof Error ? err.message : err)
        }
      }

      // Enrichment: generate semantic tags if not already done
      if (!bm.semanticTags) {
        const imgTags = anyVisionRan
          ? (
              await db
                .select({ imageTags: mediaItems.imageTags })
                .from(mediaItems)
                .where(eq(mediaItems.bookmarkId, bm.id))
            )
              .map((m) => m.imageTags)
              .filter((t): t is string => t !== null && t !== '' && t !== '{}')
          : bm.mediaItems
              .map((m) => m.imageTags)
              .filter((t): t is string => t !== null && t !== '' && t !== '{}')

        if (imgTags.length === 0 && bm.text.length < 20) {
          await db.update(bookmarks).set({ semanticTags: '[]' }).where(eq(bookmarks.id, bm.id))
        } else {
          let entities: BookmarkForEnrichment['entities'] = undefined
          if (bm.entities) {
            try {
              entities = JSON.parse(bm.entities) as BookmarkForEnrichment['entities']
            } catch { /* ignore */ }
          }
          try {
            const results = await enrichBatchSemanticTags(
              db,
              [{ id: bm.id, text: bm.text, imageTags: imgTags, entities }],
              client,
            )
            const result = results[0]
            if (result?.tags.length) {
              await db
                .update(bookmarks)
                .set({
                  semanticTags: JSON.stringify(result.tags),
                  enrichmentMeta: JSON.stringify({
                    sentiment: result.sentiment,
                    people: result.people,
                    companies: result.companies,
                  }),
                })
                .where(eq(bookmarks.id, bm.id))
              counts.enriched++
              await updateState(stub, { stageCounts: { ...counts } })
            }
          } catch (err) {
            console.warn('[parallel] enrichment failed for', bm.id, err instanceof Error ? err.message : err)
          }
        }
      }

      // Queue for categorization
      catPending.push(bm.id)
      processedCount++
      await updateState(stub, { done: processedCount, stageCounts: { ...counts } })
      await drainCategorizeQueue()
    }

    // Drain remaining items
    await drainCategorizeQueue(true)
  }

  // Stage 3: FTS rebuild
  const wasStopped = await shouldAbort(stub)
  if (!wasStopped) {
    await updateState(stub, { stage: 'fts' })
    await rebuildFts(d1, db).catch((err) => console.error('FTS rebuild error:', err))
  }

  return wasStopped
}

export default route
