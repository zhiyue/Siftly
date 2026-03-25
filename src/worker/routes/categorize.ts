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
import { getPipelineStateManager } from '@/lib/pipeline-state'
import type { PipelineState } from '@/lib/pipeline-state'

const psm = getPipelineStateManager()

const CAT_BATCH_SIZE = 25

const route = new Hono<{ Bindings: Bindings }>()

// GET /api/categorize — pipeline status
route.get('/api/categorize', async (c) => {
  const state = psm.getState()
  return c.json({
    status: state.status,
    stage: state.stage,
    done: state.done,
    total: state.total,
    stageCounts: state.stageCounts,
    lastError: state.lastError,
    error: state.error,
  })
})

// DELETE /api/categorize — stop pipeline
route.delete('/api/categorize', async (c) => {
  const state = psm.getState()
  if (state.status !== 'running') {
    return c.json({ error: 'No pipeline running' }, 409)
  }
  psm.stop()
  return c.json({ stopped: true })
})

// POST /api/categorize — start pipeline
route.post('/api/categorize', async (c) => {
  const state = psm.getState()
  if (state.status === 'running' || state.status === 'stopping') {
    return c.json({ error: 'Categorization is already running' }, 409)
  }

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

  // Mark pipeline as running
  psm.start(total)

  // Run pipeline in background via ctx.waitUntil
  c.executionCtx.waitUntil(
    runPipeline({ bookmarkIds, force, dbApiKey, total, d1, bucket, env })
      .then((wasStopped) => {
        psm.finish({ wasStopped })
      })
      .catch((err) => {
        console.error('Pipeline error:', err)
        psm.finish({
          error: err instanceof Error ? err.message : String(err),
        })
      }),
  )

  return c.json({ status: 'started', total })
})

// ── Pipeline runner ──────────────────────────────────────────────────

function updateState(update: Partial<PipelineState>): void {
  psm.setState(update)
}

async function runPipeline(opts: {
  bookmarkIds: string[]
  force: boolean
  dbApiKey: string
  total: number
  d1: D1Database
  bucket: R2Bucket
  env: Bindings
}): Promise<boolean> {
  const { bookmarkIds, force, dbApiKey, d1, bucket, env } = opts
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
  if (!psm.shouldAbort()) {
    updateState({ stage: 'entities' })
    counts.entitiesExtracted = await backfillEntities(db, (n) => {
      counts.entitiesExtracted = n
      updateState({ stageCounts: { ...counts } })
    }, () => psm.shouldAbort()).catch((err) => {
      console.error('Entity extraction error:', err)
      return counts.entitiesExtracted
    })
    updateState({ stageCounts: { ...counts } })
  }

  // Stage 2: Parallel pipeline -- vision + enrichment + categorize per bookmark
  if (!psm.shouldAbort()) {
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
    updateState({ stage: 'parallel', done: 0, total: runTotal, stageCounts: { ...counts } })

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
            updateState({ stageCounts: { ...counts } })
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
      if (psm.shouldAbort()) break

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
        if (psm.shouldAbort()) break
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
          updateState({ stageCounts: { ...counts } })
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
              updateState({ stageCounts: { ...counts } })
            }
          } catch (err) {
            console.warn('[parallel] enrichment failed for', bm.id, err instanceof Error ? err.message : err)
          }
        }
      }

      // Queue for categorization
      catPending.push(bm.id)
      processedCount++
      updateState({ done: processedCount, stageCounts: { ...counts } })
      await drainCategorizeQueue()
    }

    // Drain remaining items
    await drainCategorizeQueue(true)
  }

  // Stage 3: FTS rebuild
  const wasStopped = psm.shouldAbort()
  if (!wasStopped) {
    updateState({ stage: 'fts' })
    await rebuildFts(d1, db).catch((err) => console.error('FTS rebuild error:', err))
  }

  return wasStopped
}

export default route
