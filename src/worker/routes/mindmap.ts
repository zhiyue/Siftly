import { Hono } from 'hono'
import type { Bindings } from '../index'
import { getDb } from '@/lib/db'
import { eq, desc, count as countFn } from 'drizzle-orm'
import { bookmarks, categories, bookmarkCategories } from '@/lib/schema'

interface MindMapNode {
  id: string
  type: string
  data: Record<string, unknown>
  position: { x: number; y: number }
}

interface MindMapEdge {
  id: string
  source: string
  target: string
  type?: string
  style?: Record<string, unknown>
}

interface MindMapResponse {
  nodes: MindMapNode[]
  edges: MindMapEdge[]
}

const ROOT_POSITION = { x: 0, y: 0 }
const TWEET_RADIUS = 200

const CAT_NODE_DIAMETER = 112
const CAT_NODE_GAP = 36
const CAT_MIN_RADIUS = 200

function categoryRadius(count: number): number {
  const circumference = count * (CAT_NODE_DIAMETER + CAT_NODE_GAP)
  return Math.max(CAT_MIN_RADIUS, Math.round(circumference / (2 * Math.PI)))
}

function categoryPosition(index: number, total: number, radius: number): { x: number; y: number } {
  const angle = (2 * Math.PI * index) / total - Math.PI / 2
  return {
    x: Math.round(ROOT_POSITION.x + radius * Math.cos(angle)),
    y: Math.round(ROOT_POSITION.y + radius * Math.sin(angle)),
  }
}

function tweetPosition(
  catPos: { x: number; y: number },
  index: number,
  total: number
): { x: number; y: number } {
  const angle = (2 * Math.PI * index) / Math.max(total, 1) - Math.PI / 2
  return {
    x: Math.round(catPos.x + TWEET_RADIUS * Math.cos(angle)),
    y: Math.round(catPos.y + TWEET_RADIUS * Math.sin(angle)),
  }
}

async function getBaseGraph(db: ReturnType<typeof getDb>): Promise<MindMapResponse> {
  const [[{ count: totalBookmarks }], catRows] = await Promise.all([
    db.select({ count: countFn() }).from(bookmarks),
    db
      .select({
        id: categories.id,
        name: categories.name,
        slug: categories.slug,
        color: categories.color,
        description: categories.description,
        count: countFn(),
      })
      .from(categories)
      .leftJoin(bookmarkCategories, eq(categories.id, bookmarkCategories.categoryId))
      .groupBy(categories.id)
      .orderBy(desc(countFn())),
  ])

  const rootNode: MindMapNode = {
    id: 'root',
    type: 'root',
    data: { label: 'My Bookmarks', count: totalBookmarks },
    position: ROOT_POSITION,
  }

  const radius = categoryRadius(catRows.length)
  const categoryNodes: MindMapNode[] = catRows.map((cat, index) => ({
    id: `cat-${cat.slug}`,
    type: 'category',
    data: {
      name: cat.name,
      slug: cat.slug,
      color: cat.color,
      count: cat.count,
      description: cat.description,
    },
    position: categoryPosition(index, catRows.length, radius),
  }))

  const categoryEdges: MindMapEdge[] = catRows.map((cat) => ({
    id: `edge-root-cat-${cat.slug}`,
    source: 'root',
    target: `cat-${cat.slug}`,
    type: 'chain',
    style: { stroke: cat.color, strokeWidth: 1.5, opacity: 1 },
  }))

  return {
    nodes: [rootNode, ...categoryNodes],
    edges: categoryEdges,
  }
}

async function getCategoryTweetNodes(db: ReturnType<typeof getDb>, categorySlug: string): Promise<MindMapResponse> {
  const categoryRow = await db
    .select()
    .from(categories)
    .where(eq(categories.slug, categorySlug))
    .limit(1)

  if (categoryRow.length === 0) {
    return { nodes: [], edges: [] }
  }
  const category = categoryRow[0]

  const bcRows = await db.query.bookmarkCategories.findMany({
    where: eq(bookmarkCategories.categoryId, category.id),
    orderBy: desc(bookmarkCategories.confidence),
    limit: 66,
    with: {
      bookmark: {
        columns: {
          id: true,
          tweetId: true,
          text: true,
          authorHandle: true,
          authorName: true,
          tweetCreatedAt: true,
          semanticTags: true,
        },
        with: {
          mediaItems: {
            columns: { url: true, thumbnailUrl: true, type: true, imageTags: true },
            limit: 1,
          },
        },
      },
    },
  })

  const bmItems = bcRows.map((bc) => ({ ...bc.bookmark, confidence: bc.confidence }))

  const catNodeId = `cat-${categorySlug}`
  const catPos = { x: 0, y: 0 }

  const tweetNodes: MindMapNode[] = bmItems.map((bookmark, index) => {
    const truncatedText =
      bookmark.text.length > 80
        ? bookmark.text.slice(0, 77) + '...'
        : bookmark.text

    const firstMedia = bookmark.mediaItems[0] ?? null
    const thumbnailUrl = firstMedia?.thumbnailUrl ?? (firstMedia?.type === 'photo' ? firstMedia.url : null) ?? null

    let visualSummary: string | null = null
    if (firstMedia?.imageTags) {
      try {
        const parsed = JSON.parse(firstMedia.imageTags) as Record<string, unknown>
        visualSummary = [parsed.scene, parsed.action].filter(Boolean).join(' -- ') || null
      } catch {
        visualSummary = null
      }
    }

    return {
      id: `tweet-${bookmark.tweetId}`,
      type: 'tweet',
      data: {
        tweetId: bookmark.tweetId,
        text: truncatedText,
        authorHandle: bookmark.authorHandle,
        authorName: bookmark.authorName,
        tweetUrl: `https://twitter.com/${bookmark.authorHandle}/status/${bookmark.tweetId}`,
        thumbnailUrl,
        hasMedia: firstMedia !== null,
        mediaType: firstMedia?.type ?? null,
        tweetCreatedAt: bookmark.tweetCreatedAt ?? null,
        categoryColor: category.color,
        confidence: bookmark.confidence,
        visualSummary,
      },
      position: tweetPosition(catPos, index, bmItems.length),
    }
  })

  const tweetEdges: MindMapEdge[] = bmItems.map((bookmark) => ({
    id: `edge-${catNodeId}-tweet-${bookmark.tweetId}`,
    source: catNodeId,
    target: `tweet-${bookmark.tweetId}`,
  }))

  return {
    nodes: tweetNodes,
    edges: tweetEdges,
  }
}

const route = new Hono<{ Bindings: Bindings }>()

route.get('/api/mindmap', async (c) => {
  const categorySlug = c.req.query('category')

  try {
    const db = getDb(c.env.DB)
    if (categorySlug) {
      const data = await getCategoryTweetNodes(db, categorySlug)
      return c.json(data)
    }

    const data = await getBaseGraph(db)
    return c.json(data)
  } catch (err) {
    console.error('Mindmap fetch error:', err)
    return c.json(
      { error: `Failed to build mindmap: ${err instanceof Error ? err.message : String(err)}` },
      500
    )
  }
})

export default route
