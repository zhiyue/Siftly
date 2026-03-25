import { NextRequest } from 'next/server'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod/v3'
import prisma from '@/lib/db'
import { ftsSearch } from '@/lib/fts'
import { extractKeywords } from '@/lib/search-utils'
import { extractBearerToken, verifyApiKey } from '@/lib/api-auth'
import { syncBookmarks, isSyncing, isSchedulerRunning } from '@/lib/x-sync'
import {
  exportAllBookmarksCsv,
  exportBookmarksJson,
  exportCategoryAsZip,
} from '@/lib/exporter'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonContent(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
}

function errorContent(message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true }
}

function safeParse(json: string | null): unknown {
  if (!json) return null
  try { return JSON.parse(json) } catch { return json }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatBookmark(b: any) {
  return {
    id: b.id,
    tweetId: b.tweetId,
    text: b.text,
    authorHandle: b.authorHandle,
    authorName: b.authorName,
    source: b.source,
    tweetCreatedAt: b.tweetCreatedAt?.toISOString() ?? null,
    categories: b.categories?.map(
      (bc: { category: { name: string; slug: string }; confidence?: number }) => ({
        name: bc.category.name,
        slug: bc.category.slug,
        ...(bc.confidence !== undefined ? { confidence: bc.confidence } : {}),
      }),
    ) ?? [],
  }
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

async function authenticate(request: Request): Promise<Response | null> {
  const token = extractBearerToken(request.headers.get('Authorization'))
  if (token) {
    const keyId = await verifyApiKey(token)
    if (!keyId) {
      return new Response(JSON.stringify({ error: 'Invalid API key' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  }
  return null // auth passed (or no token provided)
}

// ---------------------------------------------------------------------------
// Server + tool registration
// ---------------------------------------------------------------------------

function createServer(): McpServer {
  const server = new McpServer(
    { name: 'siftly', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )

  // 1. search_bookmarks
  server.tool(
    'search_bookmarks',
    'Full-text search across bookmarks using FTS5 with keyword extraction',
    {
      query: z.string().describe('Search query'),
      limit: z.number().optional().describe('Max results (default 20, max 100)'),
    },
    async ({ query, limit: rawLimit }) => {
      try {
        const limit = Math.min(rawLimit ?? 20, 100)
        const keywords = extractKeywords(query)
        if (keywords.length === 0) return errorContent('No searchable keywords in query')

        const ftsIds = await ftsSearch(keywords)

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let where: any
        if (ftsIds.length > 0) {
          where = { id: { in: ftsIds } }
        } else {
          where = {
            OR: keywords.flatMap((kw) => [
              { text: { contains: kw } },
              { semanticTags: { contains: kw } },
              { entities: { contains: kw } },
            ]),
          }
        }

        const bookmarks = await prisma.bookmark.findMany({
          where,
          take: limit,
          orderBy: ftsIds.length > 0 ? undefined : [{ tweetCreatedAt: 'desc' }],
          include: {
            categories: {
              include: { category: { select: { name: true, slug: true } } },
              orderBy: { confidence: 'desc' },
            },
          },
        })

        return jsonContent({
          query,
          keywords,
          count: bookmarks.length,
          bookmarks: bookmarks.map(formatBookmark),
        })
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err))
      }
    },
  )

  // 2. list_bookmarks
  server.tool(
    'list_bookmarks',
    'List bookmarks with optional filters, pagination and sorting',
    {
      category: z.string().optional().describe('Filter by category slug'),
      author: z.string().optional().describe('Filter by author handle'),
      source: z.string().optional().describe('Filter by source (bookmark | like)'),
      sort: z.string().optional().describe('Sort order: newest (default) or oldest'),
      limit: z.number().optional().describe('Results per page (default 20, max 100)'),
      page: z.number().optional().describe('Page number (default 1)'),
    },
    async ({ category, author, source, sort, limit: rawLimit, page: rawPage }) => {
      try {
        const limit = Math.min(rawLimit ?? 20, 100)
        const page = rawPage ?? 1
        const skip = (page - 1) * limit
        const sortDir = sort === 'oldest' ? ('asc' as const) : ('desc' as const)

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const where: any = {}
        if (source === 'bookmark' || source === 'like') where.source = source
        if (category) where.categories = { some: { category: { slug: category } } }
        if (author) where.authorHandle = author

        const [bookmarks, total] = await Promise.all([
          prisma.bookmark.findMany({
            where,
            skip,
            take: limit,
            orderBy: [{ tweetCreatedAt: sortDir }, { importedAt: sortDir }],
            include: {
              categories: {
                include: { category: { select: { name: true, slug: true } } },
                orderBy: { confidence: 'desc' },
              },
            },
          }),
          prisma.bookmark.count({ where }),
        ])

        return jsonContent({
          total,
          page,
          pages: Math.ceil(total / limit),
          bookmarks: bookmarks.map(formatBookmark),
        })
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err))
      }
    },
  )

  // 3. show_bookmark
  server.tool(
    'show_bookmark',
    'Show full details for a single bookmark by ID or tweet ID',
    {
      id: z.string().describe('Bookmark ID or tweet ID'),
    },
    async ({ id }) => {
      try {
        const bookmark = await prisma.bookmark.findFirst({
          where: { OR: [{ id }, { tweetId: id }] },
          include: {
            mediaItems: true,
            categories: {
              include: { category: { select: { id: true, name: true, slug: true, color: true } } },
              orderBy: { confidence: 'desc' },
            },
          },
        })

        if (!bookmark) return errorContent(`Bookmark not found: ${id}`)

        return jsonContent({
          id: bookmark.id,
          tweetId: bookmark.tweetId,
          text: bookmark.text,
          authorHandle: bookmark.authorHandle,
          authorName: bookmark.authorName,
          source: bookmark.source,
          tweetCreatedAt: bookmark.tweetCreatedAt?.toISOString() ?? null,
          importedAt: bookmark.importedAt.toISOString(),
          enrichedAt: bookmark.enrichedAt?.toISOString() ?? null,
          semanticTags: safeParse(bookmark.semanticTags),
          entities: safeParse(bookmark.entities),
          enrichmentMeta: safeParse(bookmark.enrichmentMeta),
          mediaItems: bookmark.mediaItems.map((m) => ({
            id: m.id,
            type: m.type,
            url: m.url,
            thumbnailUrl: m.thumbnailUrl,
            imageTags: safeParse(m.imageTags),
          })),
          categories: bookmark.categories.map((bc) => ({
            id: bc.category.id,
            name: bc.category.name,
            slug: bc.category.slug,
            color: bc.category.color,
            confidence: bc.confidence,
          })),
        })
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err))
      }
    },
  )

  // 4. get_stats
  server.tool(
    'get_stats',
    'Get library-wide statistics: bookmark counts, categories, media items',
    {},
    async () => {
      try {
        const [totalBookmarks, totalCategories, totalMedia, sourceGroups, enrichedCount] =
          await Promise.all([
            prisma.bookmark.count(),
            prisma.category.count(),
            prisma.mediaItem.count(),
            prisma.bookmark.groupBy({ by: ['source'], _count: true }),
            prisma.bookmark.count({ where: { enrichedAt: { not: null } } }),
          ])

        const sources: Record<string, number> = {}
        for (const g of sourceGroups) sources[g.source] = g._count

        return jsonContent({
          totalBookmarks,
          enrichedBookmarks: enrichedCount,
          unenrichedBookmarks: totalBookmarks - enrichedCount,
          totalCategories,
          totalMediaItems: totalMedia,
          sources,
        })
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err))
      }
    },
  )

  // 5. list_categories
  server.tool(
    'list_categories',
    'List all categories with bookmark counts',
    {},
    async () => {
      try {
        const categories = await prisma.category.findMany({
          include: { _count: { select: { bookmarks: true } } },
          orderBy: { name: 'asc' },
        })

        return jsonContent({
          count: categories.length,
          categories: categories.map((c) => ({
            id: c.id,
            name: c.name,
            slug: c.slug,
            color: c.color,
            bookmarkCount: c._count.bookmarks,
          })),
        })
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err))
      }
    },
  )

  // 6. sync_bookmarks
  server.tool(
    'sync_bookmarks',
    'Sync bookmarks from Twitter/X using stored credentials',
    {
      mode: z.string().optional().describe('Sync mode: incremental (default) or full'),
    },
    async ({ mode }) => {
      try {
        if (isSyncing()) return errorContent('A sync is already in progress')

        const [authSetting, ct0Setting] = await Promise.all([
          prisma.setting.findUnique({ where: { key: 'x_auth_token' } }),
          prisma.setting.findUnique({ where: { key: 'x_ct0' } }),
        ])

        if (!authSetting?.value || !ct0Setting?.value) {
          return errorContent('Missing Twitter/X credentials. Set x_auth_token and x_ct0 in settings.')
        }

        const syncMode = mode === 'full' ? 'full' : 'incremental'
        const result = await syncBookmarks(authSetting.value, ct0Setting.value, syncMode)
        return jsonContent(result)
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err))
      }
    },
  )

  // 7. get_sync_status
  server.tool(
    'get_sync_status',
    'Check Twitter/X sync credentials, scheduler state, and last sync time',
    {},
    async () => {
      try {
        const [authSetting, ct0Setting, intervalSetting, lastSyncSetting] = await Promise.all([
          prisma.setting.findUnique({ where: { key: 'x_auth_token' } }),
          prisma.setting.findUnique({ where: { key: 'x_ct0' } }),
          prisma.setting.findUnique({ where: { key: 'x_sync_interval' } }),
          prisma.setting.findUnique({ where: { key: 'x_last_sync' } }),
        ])

        return jsonContent({
          hasCredentials: !!(authSetting?.value && ct0Setting?.value),
          syncInterval: intervalSetting?.value ?? 'off',
          lastSync: lastSyncSetting?.value ?? null,
          schedulerRunning: isSchedulerRunning(),
        })
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err))
      }
    },
  )

  // 8. start_categorize
  server.tool(
    'start_categorize',
    'Start the AI categorization pipeline (entity extraction, vision, enrichment, categorize)',
    {
      force: z.boolean().optional().describe('Re-process all bookmarks, not just unenriched'),
    },
    async ({ force }) => {
      try {
        const baseUrl = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_URL || 'http://localhost:3000'
        const res = await fetch(`${baseUrl}/api/categorize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force: force ?? false }),
        })
        const data = await res.json()
        if (!res.ok) return errorContent(data.error ?? `HTTP ${res.status}`)
        return jsonContent(data)
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err))
      }
    },
  )

  // 9. get_categorize_status
  server.tool(
    'get_categorize_status',
    'Get current status of the AI categorization pipeline',
    {},
    async () => {
      try {
        const baseUrl = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_URL || 'http://localhost:3000'
        const res = await fetch(`${baseUrl}/api/categorize`, { method: 'GET' })
        const data = await res.json()
        return jsonContent(data)
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err))
      }
    },
  )

  // 10. export_bookmarks
  server.tool(
    'export_bookmarks',
    'Export bookmarks as CSV, JSON, or ZIP (with media files)',
    {
      type: z.enum(['csv', 'json', 'zip']).describe('Export format'),
      category: z.string().optional().describe('Category slug (required for zip export)'),
    },
    async ({ type, category }) => {
      try {
        if (type === 'csv') {
          const csv = await exportAllBookmarksCsv()
          return jsonContent({ content: csv, filename: 'bookmarks.csv' })
        }

        if (type === 'json') {
          const json = await exportBookmarksJson()
          return jsonContent({ content: json, filename: 'bookmarks.json' })
        }

        if (type === 'zip') {
          if (!category) return errorContent('Category slug is required for zip export')
          const buffer = await exportCategoryAsZip(category)
          const base64 = buffer.toString('base64')
          return jsonContent({ base64, filename: `${category}.zip` })
        }

        return errorContent(`Unknown export type: ${type}`)
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err))
      }
    },
  )

  // 11. ai_search
  server.tool(
    'ai_search',
    'AI-powered semantic search using Claude/OpenAI to understand natural language queries',
    {
      query: z.string().describe('Natural language search query'),
      limit: z.number().optional().describe('Max results (default 10)'),
    },
    async ({ query, limit }) => {
      try {
        const baseUrl = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_URL || 'http://localhost:3000'
        const res = await fetch(`${baseUrl}/api/search/ai`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, limit: limit ?? 10 }),
        })
        const data = await res.json()
        if (!res.ok) return errorContent(data.error ?? `HTTP ${res.status}`)
        return jsonContent(data)
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err))
      }
    },
  )

  return server
}

// ---------------------------------------------------------------------------
// Stateless request handler — each request gets a fresh server + transport
// ---------------------------------------------------------------------------

async function handleMcpRequest(request: Request): Promise<Response> {
  const authError = await authenticate(request)
  if (authError) return authError

  const server = createServer()
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  })

  await server.connect(transport)

  try {
    const response = await transport.handleRequest(request)
    return response
  } finally {
    // Clean up after the response is sent
    await transport.close()
    await server.close()
  }
}

// ---------------------------------------------------------------------------
// Next.js App Router exports
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest): Promise<Response> {
  return handleMcpRequest(request)
}

export async function GET(request: NextRequest): Promise<Response> {
  return handleMcpRequest(request)
}

export async function DELETE(request: NextRequest): Promise<Response> {
  return handleMcpRequest(request)
}
