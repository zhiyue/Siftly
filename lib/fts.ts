/**
 * SQLite FTS5 virtual table for fast full-text search across bookmarks.
 * FTS5 uses Porter stemming and tokenization — much faster than LIKE '%keyword%' table scans.
 *
 * Uses D1 binding directly (not Drizzle) because FTS5 virtual tables are not supported
 * by Drizzle's schema API. The table is rebuilt after enrichment runs. At search time it
 * provides ranked ID lists that replace the LIKE-based keyword conditions in the search route.
 */

import { gt, asc } from 'drizzle-orm'
import { bookmarks } from '@/lib/schema'
import type { AppDb } from '@/lib/db'

const FTS_TABLE = 'bookmark_fts'

export async function ensureFtsTable(d1: D1Database): Promise<void> {
  await d1.prepare(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(
      bookmark_id UNINDEXED,
      text,
      semantic_tags,
      entities,
      image_tags,
      tokenize='porter unicode61'
    )
  `).run()
}

/**
 * Rebuild the FTS5 table from all bookmarks. Uses cursor-based pagination
 * and D1 batch() to stay within D1's ~100 statement batch limit.
 * Call after import or enrichment runs.
 */
export async function rebuildFts(d1: D1Database, db: AppDb): Promise<void> {
  await ensureFtsTable(d1)
  await d1.prepare(`DELETE FROM ${FTS_TABLE}`).run()

  // D1 batch() limit is ~100 statements per call
  const PAGE_SIZE = 100
  let cursor: string | undefined

  while (true) {
    const rows = await db.query.bookmarks.findMany({
      where: cursor ? gt(bookmarks.id, cursor) : undefined,
      orderBy: asc(bookmarks.id),
      limit: PAGE_SIZE,
      columns: {
        id: true,
        text: true,
        semanticTags: true,
        entities: true,
      },
      with: { mediaItems: { columns: { imageTags: true } } },
    })

    if (rows.length === 0) break

    const stmts = rows.map((b) => {
      const imageTagsText = b.mediaItems
        .map((m) => m.imageTags ?? '')
        .filter(Boolean)
        .join(' ')
      return d1.prepare(
        `INSERT INTO ${FTS_TABLE}(bookmark_id, text, semantic_tags, entities, image_tags) VALUES (?, ?, ?, ?, ?)`
      ).bind(b.id, b.text, b.semanticTags ?? '', b.entities ?? '', imageTagsText)
    })

    await d1.batch(stmts)
    cursor = rows[rows.length - 1].id
  }
}

/**
 * Search FTS5 table for bookmarks matching the given keywords.
 * Returns bookmark IDs ordered by relevance rank.
 * Returns [] on error (caller should fall back to LIKE queries).
 */
export async function ftsSearch(d1: D1Database, keywords: string[]): Promise<string[]> {
  if (keywords.length === 0) return []

  try {
    await ensureFtsTable(d1)

    const terms = keywords
      .map((kw) => kw.replace(/["*()]/g, ' ').trim())
      .filter((kw) => kw.length >= 2)

    if (terms.length === 0) return []

    const matchQuery = terms.join(' OR ')

    const { results } = await d1.prepare(
      `SELECT bookmark_id FROM ${FTS_TABLE} WHERE ${FTS_TABLE} MATCH ? ORDER BY rank LIMIT 150`
    ).bind(matchQuery).all<{ bookmark_id: string }>()

    return results.map((r) => r.bookmark_id)
  } catch {
    // FTS table may not be populated yet or query has syntax error — fall back gracefully
    return []
  }
}
