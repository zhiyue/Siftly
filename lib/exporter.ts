import JSZip from 'jszip'
import { eq, desc, inArray } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { bookmarks, categories, bookmarkCategories, mediaItems } from '@/lib/schema'

interface BookmarkRow {
  id: string
  tweetId: string
  text: string
  authorHandle: string
  authorName: string
  source: string
  tweetCreatedAt: string | null
  importedAt: string
  mediaItems: MediaItemRow[]
  categories: CategoryJoin[]
}

interface MediaItemRow {
  id: string
  type: string
  url: string
  thumbnailUrl: string | null
  localPath: string | null
}

interface CategoryJoin {
  category: {
    name: string
    slug: string
    color: string
  }
}

async function fetchBookmarksFull(bookmarkIds?: string[]): Promise<BookmarkRow[]> {
  const db = getDb()
  const rows = await db.query.bookmarks.findMany({
    where: bookmarkIds && bookmarkIds.length > 0
      ? inArray(bookmarks.id, bookmarkIds)
      : undefined,
    orderBy: desc(bookmarks.importedAt),
    with: {
      mediaItems: true,
      categories: {
        with: { category: true },
      },
    },
  })

  return rows.map((b) => ({
    id: b.id,
    tweetId: b.tweetId,
    text: b.text,
    authorHandle: b.authorHandle,
    authorName: b.authorName,
    source: b.source,
    tweetCreatedAt: b.tweetCreatedAt,
    importedAt: b.importedAt,
    mediaItems: b.mediaItems.map((m) => ({
      id: m.id,
      type: m.type,
      url: m.url,
      thumbnailUrl: m.thumbnailUrl,
      localPath: m.localPath,
    })),
    categories: b.categories.map((bc) => ({
      category: {
        name: bc.category.name,
        slug: bc.category.slug,
        color: bc.category.color,
      },
    })),
  }))
}

async function fetchBookmarksForCategory(categorySlug: string): Promise<BookmarkRow[]> {
  const db = getDb()

  // First, get the bookmark IDs in this category
  const bcRows = await db
    .select({ bookmarkId: bookmarkCategories.bookmarkId })
    .from(bookmarkCategories)
    .innerJoin(categories, eq(bookmarkCategories.categoryId, categories.id))
    .where(eq(categories.slug, categorySlug))

  const ids = bcRows.map((r) => r.bookmarkId)
  if (ids.length === 0) return []

  return fetchBookmarksFull(ids)
}

function formatCsvField(value: string): string {
  const escaped = value.replace(/"/g, '""')
  return `"${escaped}"`
}

function buildCsvRow(fields: string[]): string {
  return fields.map(formatCsvField).join(',')
}

async function downloadFile(url: string): Promise<Uint8Array | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) return null
    const arrayBuffer = await response.arrayBuffer()
    return new Uint8Array(arrayBuffer)
  } catch {
    return null
  }
}

function urlToFilename(url: string, index: number, ext: string): string {
  try {
    const parsed = new URL(url)
    const segments = parsed.pathname.split('/')
    const last = segments[segments.length - 1]
    if (last && last.includes('.')) return last
  } catch {
    // fall through
  }
  return `media_${index}${ext}`
}

function mediaExtension(type: string, url: string): string {
  if (type === 'video') return '.mp4'
  if (type === 'gif') return '.mp4'
  if (url.endsWith('.jpg') || url.endsWith('.jpeg')) return '.jpg'
  if (url.endsWith('.png')) return '.png'
  if (url.endsWith('.webp')) return '.webp'
  return '.jpg'
}

export async function exportCategoryAsZip(categorySlug: string): Promise<Uint8Array> {
  const db = getDb()
  const categoryRow = await db
    .select()
    .from(categories)
    .where(eq(categories.slug, categorySlug))
    .limit(1)

  if (categoryRow.length === 0) {
    throw new Error(`Category not found: ${categorySlug}`)
  }

  const bookmarkRows = await fetchBookmarksForCategory(categorySlug)

  const zip = new JSZip()
  const mediaFolder = zip.folder('media')

  const manifestRows: string[] = [
    buildCsvRow(['tweetId', 'text', 'author', 'url', 'categories', 'date']),
  ]

  let mediaIndex = 0
  for (const bookmark of bookmarkRows) {
    const tweetUrl = `https://twitter.com/${bookmark.authorHandle}/status/${bookmark.tweetId}`
    const categoryNames = bookmark.categories.map((c) => c.category.name).join('; ')
    const dateStr = bookmark.tweetCreatedAt ?? ''

    manifestRows.push(
      buildCsvRow([
        bookmark.tweetId,
        bookmark.text,
        bookmark.authorHandle,
        tweetUrl,
        categoryNames,
        dateStr,
      ])
    )

    for (const item of bookmark.mediaItems) {
      const ext = mediaExtension(item.type, item.url)
      const filename = urlToFilename(item.url, mediaIndex, ext)
      mediaIndex++

      const fileData = await downloadFile(item.url)
      if (fileData && mediaFolder) {
        mediaFolder.file(filename, fileData)
      }
    }
  }

  zip.file('manifest.csv', manifestRows.join('\n'))

  const buffer = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
  return buffer
}

export async function exportAllBookmarksCsv(): Promise<string> {
  const bookmarkRows = await fetchBookmarksFull()

  const headers = buildCsvRow([
    'tweetId',
    'text',
    'authorHandle',
    'source',
    'categories',
    'tweetCreatedAt',
    'mediaUrls',
  ])

  const rows = bookmarkRows.map((bookmark) => {
    const cats = bookmark.categories.map((c) => c.category.name).join('; ')
    const mediaUrls = bookmark.mediaItems.map((m) => m.url).join('; ')
    const dateStr = bookmark.tweetCreatedAt ?? ''

    return buildCsvRow([
      bookmark.tweetId,
      bookmark.text,
      bookmark.authorHandle,
      bookmark.source,
      cats,
      dateStr,
      mediaUrls,
    ])
  })

  return [headers, ...rows].join('\n')
}

export async function exportBookmarksJson(bookmarkIds?: string[]): Promise<string> {
  const bookmarkRows = await fetchBookmarksFull(bookmarkIds)

  const output = bookmarkRows.map((bookmark) => ({
    tweetId: bookmark.tweetId,
    text: bookmark.text,
    authorHandle: bookmark.authorHandle,
    authorName: bookmark.authorName,
    source: bookmark.source,
    tweetCreatedAt: bookmark.tweetCreatedAt ?? null,
    importedAt: bookmark.importedAt,
    categories: bookmark.categories.map((c) => ({
      name: c.category.name,
      slug: c.category.slug,
      color: c.category.color,
    })),
    mediaItems: bookmark.mediaItems.map((m) => ({
      type: m.type,
      url: m.url,
      thumbnailUrl: m.thumbnailUrl,
    })),
  }))

  return JSON.stringify(output, null, 2)
}
