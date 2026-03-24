import { NextRequest, NextResponse } from 'next/server'
import { getCloudflareContext } from '@opennextjs/cloudflare'
import { getDb } from '@/lib/db'
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
import { getPipelineStateManager } from '@/lib/pipeline-do'
import type { PipelineState } from '@/lib/pipeline-do'

// ── State manager ────────────────────────────────────────────────────
// Uses the in-process globalThis state manager. Within a single Worker
// isolate this provides consistent state across requests. For a single-
// user self-hosted app this is sufficient; the pipeline runs within one
// isolate's lifetime and ctx.waitUntil() keeps it alive.

const psm = getPipelineStateManager()

// ── Handlers ─────────────────────────────────────────────────────────

export async function GET(): Promise<NextResponse> {
  const state = psm.getState()
  return NextResponse.json({
    status: state.status,
    stage: state.stage,
    done: state.done,
    total: state.total,
    stageCounts: state.stageCounts,
    lastError: state.lastError,
    error: state.error,
  })
}

export async function DELETE(): Promise<NextResponse> {
  const state = psm.getState()
  if (state.status !== 'running') {
    return NextResponse.json({ error: 'No pipeline running' }, { status: 409 })
  }
  psm.stop()
  return NextResponse.json({ stopped: true })
}

const CAT_BATCH_SIZE = 25

export async function POST(request: NextRequest): Promise<NextResponse> {
  const state = psm.getState()
  if (state.status === 'running' || state.status === 'stopping') {
    return NextResponse.json({ error: 'Categorization is already running' }, { status: 409 })
  }

  let body: { bookmarkIds?: string[]; apiKey?: string; force?: boolean } = {}
  try {
    const text = await request.text()
    if (text.trim()) body = JSON.parse(text)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const prisma = getDb()
  const { bookmarkIds = [], apiKey, force = false } = body

  // Save API key if provided
  if (apiKey && typeof apiKey === 'string' && apiKey.trim() !== '') {
    const currentProvider = await getProvider()
    const keySlot = currentProvider === 'openai' ? 'openaiApiKey' : 'anthropicApiKey'
    await prisma.setting.upsert({
      where: { key: keySlot },
      update: { value: apiKey.trim() },
      create: { key: keySlot, value: apiKey.trim() },
    })
  }

  // Count total bookmarks to process
  let total = 0
  try {
    if (bookmarkIds.length > 0) {
      total = bookmarkIds.length
    } else if (force) {
      total = await prisma.bookmark.count()
    } else {
      total = await prisma.bookmark.count({ where: { enrichedAt: null } })
    }
  } catch {
    total = 0
  }

  // Resolve the API key from DB before entering the background task
  const provider = await getProvider()
  const keyName = provider === 'openai' ? 'openaiApiKey' : 'anthropicApiKey'
  const dbApiKey =
    (await prisma.setting.findUnique({ where: { key: keyName } }))?.value?.trim() || ''

  // Mark pipeline as running
  psm.start(total)

  // Run pipeline in background via ctx.waitUntil — keeps the Worker alive
  // past the initial response so the pipeline can complete.
  const { ctx } = getCloudflareContext()
  ctx.waitUntil(
    runPipeline({ bookmarkIds, force, dbApiKey, total })
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

  return NextResponse.json({ status: 'started', total })
}

// ── Pipeline runner ──────────────────────────────────────────────────

function updateState(update: Partial<PipelineState>): void {
  psm.setState(update)
}

async function runPipeline(opts: {
  bookmarkIds: string[]
  force: boolean
  dbApiKey: string
  total: number
}): Promise<boolean> {
  const { bookmarkIds, force, dbApiKey } = opts
  const prisma = getDb()
  const counts = { visionTagged: 0, entitiesExtracted: 0, enriched: 0, categorized: 0 }

  let client: AIClient | null = null
  try {
    client = await resolveAIClient({ dbKey: dbApiKey })
  } catch {
    console.warn('No SDK client available — will rely on configured keys')
  }

  await seedDefaultCategories()

  if (force) {
    await prisma.mediaItem.updateMany({ where: { imageTags: '{}' }, data: { imageTags: null } })
    await prisma.bookmark.updateMany({ where: { semanticTags: '[]' }, data: { semanticTags: null } })
  }

  // Stage 1: Entity extraction (free, fast — no API calls)
  if (!psm.shouldAbort()) {
    updateState({ stage: 'entities' })
    counts.entitiesExtracted = await backfillEntities((n) => {
      counts.entitiesExtracted = n
      updateState({ stageCounts: { ...counts } })
    }, () => psm.shouldAbort()).catch((err) => {
      console.error('Entity extraction error:', err)
      return counts.entitiesExtracted
    })
    updateState({ stageCounts: { ...counts } })
  }

  // Stage 2: Parallel pipeline — vision + enrichment + categorize per bookmark
  if (!psm.shouldAbort()) {
    let bookmarkIdsToProcess: string[]
    if (bookmarkIds.length > 0) {
      bookmarkIdsToProcess = bookmarkIds
    } else if (force) {
      const all = await prisma.bookmark.findMany({ select: { id: true }, orderBy: { id: 'asc' } })
      bookmarkIdsToProcess = all.map((b) => b.id)
    } else {
      const unprocessed = await prisma.bookmark.findMany({
        where: { enrichedAt: null },
        select: { id: true },
        orderBy: { id: 'asc' },
      })
      bookmarkIdsToProcess = unprocessed.map((b) => b.id)
    }

    const runTotal = bookmarkIdsToProcess.length
    updateState({ stage: 'parallel', done: 0, total: runTotal, stageCounts: { ...counts } })

    // Load category metadata once
    const dbCategories = await prisma.category.findMany({
      select: { slug: true, name: true, description: true },
    })
    const allSlugs = dbCategories.map((c) => c.slug)
    const categoryDescriptions = Object.fromEntries(
      dbCategories.map((c) => [c.slug, c.description?.trim() || c.name]),
    )
    const model = await getActiveModel()

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
          const rows = await prisma.bookmark.findMany({
            where: { id: { in: ids } },
            select: BOOKMARK_SELECT,
          })
          const batch = rows.map(mapBookmarkForCategorization)
          try {
            const results = await categorizeBatch(batch, client, categoryDescriptions, allSlugs)
            await writeCategoryResults(results)
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

    // Process bookmarks sequentially. Workers have limited concurrent CPU time,
    // so we avoid the runWithConcurrency parallel approach used in Node.js.
    // Processing one at a time is simpler and avoids overwhelming the isolate.
    for (const bookmarkId of bookmarkIdsToProcess) {
      if (psm.shouldAbort()) break

      const bm = await prisma.bookmark.findUnique({
        where: { id: bookmarkId },
        select: {
          id: true,
          text: true,
          semanticTags: true,
          entities: true,
          mediaItems: {
            where: { type: { in: ['photo', 'gif', 'video'] } },
            select: { id: true, url: true, thumbnailUrl: true, type: true, imageTags: true },
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
            { id: media.id, url: media.url, thumbnailUrl: media.thumbnailUrl, type: media.type },
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
        const imageTags = anyVisionRan
          ? (
              await prisma.mediaItem.findMany({
                where: { bookmarkId: bm.id, type: { in: ['photo', 'gif', 'video'] } },
                select: { imageTags: true },
              })
            )
              .map((m) => m.imageTags)
              .filter((t): t is string => t !== null && t !== '' && t !== '{}')
          : bm.mediaItems
              .map((m) => m.imageTags)
              .filter((t): t is string => t !== null && t !== '' && t !== '{}')

        if (imageTags.length === 0 && bm.text.length < 20) {
          await prisma.bookmark.update({ where: { id: bm.id }, data: { semanticTags: '[]' } })
        } else {
          let entities: BookmarkForEnrichment['entities'] = undefined
          if (bm.entities) {
            try {
              entities = JSON.parse(bm.entities) as BookmarkForEnrichment['entities']
            } catch { /* ignore */ }
          }
          try {
            const results = await enrichBatchSemanticTags(
              [{ id: bm.id, text: bm.text, imageTags, entities }],
              client,
            )
            const result = results[0]
            if (result?.tags.length) {
              await prisma.bookmark.update({
                where: { id: bm.id },
                data: {
                  semanticTags: JSON.stringify(result.tags),
                  enrichmentMeta: JSON.stringify({
                    sentiment: result.sentiment,
                    people: result.people,
                    companies: result.companies,
                  }),
                },
              })
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
    await rebuildFts().catch((err) => console.error('FTS rebuild error:', err))
  }

  return wasStopped
}
