import { NextRequest, NextResponse } from 'next/server'
import { eq, desc, inArray } from 'drizzle-orm'
import { getDb, getD1 } from '@/lib/db'
import { bookmarks, categories, settings } from '@/lib/schema'
import { ftsSearch } from '@/lib/fts'
import { AIClient, resolveAIClient } from '@/lib/ai-client'
import { getActiveModel, getProvider } from '@/lib/settings'
import { extractKeywords } from '@/lib/search-utils'

// ─── Cache ────────────────────────────────────────────────────────────────────
interface CacheEntry { results: unknown; expiresAt: number }
const searchCache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 5 * 60 * 1000

function getCached(key: string): unknown | null {
  const entry = searchCache.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) { searchCache.delete(key); return null }
  return entry.results
}
function setCache(key: string, results: unknown): void {
  if (searchCache.size >= 100) searchCache.delete(searchCache.keys().next().value!)
  searchCache.set(key, { results, expiresAt: Date.now() + CACHE_TTL_MS })
}

// ─── Module-level caches (avoid DB roundtrips on every search) ────────────────
let _apiKey: string | null = null
let _apiKeyExpiry = 0
let _categoriesCache: { slug: string; name: string; description: string | null }[] | null = null
let _categoriesCacheExpiry = 0

async function getDbApiKey(): Promise<string> {
  if (_apiKey !== null && Date.now() < _apiKeyExpiry) return _apiKey
  const db = getDb()
  const provider = await getProvider()
  const keyName = provider === 'openai' ? 'openaiApiKey' : 'anthropicApiKey'
  const rows = await db.select().from(settings).where(eq(settings.key, keyName)).limit(1)
  const fromDb = rows[0]?.value?.trim() ?? ''
  _apiKey = fromDb
  _apiKeyExpiry = Date.now() + 60_000
  return _apiKey
}
async function getAllCategories() {
  if (_categoriesCache && Date.now() < _categoriesCacheExpiry) return _categoriesCache
  const db = getDb()
  _categoriesCache = await db
    .select({ slug: categories.slug, name: categories.name, description: categories.description })
    .from(categories)
  _categoriesCacheExpiry = Date.now() + 2 * 60 * 1000
  return _categoriesCache
}

/**
 * Map query intent signals to category slugs using cached category list.
 */
async function detectIntentCategories(query: string): Promise<string[]> {
  const q = query.toLowerCase()
  const slugs = new Set<string>()

  const allCats = await getAllCategories()

  const INTENT_SIGNALS: Array<{ pattern: RegExp; slugHints: string[] }> = [
    {
      pattern: /meme|funny|humor|laugh|lol|joke|hilarious|comedy|satire|roast|viral|dank|wholesome|cringe|based|skit|parody/i,
      slugHints: ['funny-memes'],
    },
    {
      pattern: /crypto|bitcoin|btc|eth|sol|defi|nft|trading|chart|invest|token|wallet|blockchain|altcoin|memecoin|pump|dump|yield|staking|airdrop|web3|dex|liquidity|portfolio|stocks|options|macro|economy|dollar|inflation|fed|interest rate/i,
      slugHints: ['finance-crypto'],
    },
    {
      pattern: /code|coding|developer|programming|github|software|api|framework|library|debug|deploy|devops|backend|frontend|fullstack|typescript|javascript|python|rust|golang|java|swift|css|html|sql|cli|terminal|bash|docker|kubernetes|ci.?cd|open.?source|repo|pull request|lint/i,
      slugHints: ['dev-tools'],
    },
    {
      pattern: /\bai\b|llm|gpt|claude|openai|anthropic|gemini|mistral|llama|model|prompt|agent|machine learning|neural|deep learning|embedding|rag|fine.?tun|inference|transformer|diffusion|multimodal|copilot|cursor|midjourney|stable diffusion|image gen/i,
      slugHints: ['ai-resources'],
    },
    {
      pattern: /design|ui\b|ux\b|figma|typography|branding|logo|visual|color palette|layout|wireframe|prototype|tailwind|animation|motion|font|icon|component|design system|saas ui/i,
      slugHints: ['design'],
    },
    {
      pattern: /productivity|focus|habit|workflow|time management|system|note.?taking|task|pkm|second brain|obsidian|notion|roam|logseq|journaling|calendar|routine|morning|discipline|deep work|async/i,
      slugHints: ['productivity'],
    },
    {
      pattern: /news|breaking|announcement|launch|update|thread|essay|opinion|analysis|report|geopolitic|politic|regulation|lawsuit|acquisition|ipo|funding|raised|series/i,
      slugHints: ['news'],
    },
  ]

  for (const { pattern, slugHints } of INTENT_SIGNALS) {
    if (pattern.test(q)) {
      for (const hint of slugHints) {
        for (const cat of allCats) {
          if (
            cat.slug === hint ||
            cat.slug.includes(hint.split('-')[0]) ||
            cat.name.toLowerCase().includes(hint.replace(/-/g, ' ')) ||
            (cat.description && cat.description.toLowerCase().includes(hint.split('-')[0]))
          ) {
            slugs.add(cat.slug)
          }
        }
      }
    }
  }

  return Array.from(slugs)
}

/** Build a rich, readable index entry for a bookmark */
function buildIndexEntry(b: {
  id: string
  tweetId: string
  text: string
  authorHandle: string
  authorName: string
  semanticTags: string | null
  entities: string | null
  mediaItems: { type: string; imageTags: string | null }[]
  categories: { confidence: number; category: { slug: string; name: string } }[]
}): string {
  const lines: string[] = [`[${b.id}]`]

  lines.push(`text: ${b.text.slice(0, 350)}`)

  for (const m of b.mediaItems) {
    if (!m.imageTags || m.imageTags === '{}') {
      lines.push(`media: [${m.type}]`)
      continue
    }
    try {
      const p = JSON.parse(m.imageTags) as Record<string, unknown>
      const parts: string[] = [`type=${m.type}`]
      if (p.style) parts.push(`style=${p.style}`)
      if (p.scene) parts.push(`scene=${p.scene}`)
      if (p.action) parts.push(`action=${p.action}`)
      if (p.mood) parts.push(`mood=${p.mood}`)
      if (p.meme_template) parts.push(`meme=${p.meme_template}`)
      if (Array.isArray(p.text_ocr) && (p.text_ocr as string[]).length)
        parts.push(`ocr="${(p.text_ocr as string[]).join(' | ').slice(0, 250)}"`)
      if (Array.isArray(p.people) && (p.people as string[]).length)
        parts.push(`people=${(p.people as string[]).join(', ')}`)
      if (Array.isArray(p.objects) && (p.objects as string[]).length)
        parts.push(`objects=${(p.objects as string[]).slice(0, 8).join(', ')}`)
      if (Array.isArray(p.tags) && (p.tags as string[]).length)
        parts.push(`vtags=${(p.tags as string[]).slice(0, 25).join(', ')}`)
      lines.push(`media: ${parts.join(' | ')}`)
    } catch {
      lines.push(`media: [${m.type}] ${m.imageTags.slice(0, 200)}`)
    }
  }

  if (b.semanticTags && b.semanticTags !== '[]') {
    try {
      const tags = JSON.parse(b.semanticTags) as string[]
      if (tags.length) lines.push(`ai_tags: ${tags.slice(0, 35).join(', ')}`)
    } catch { /* ignore */ }
  }

  if (b.entities) {
    try {
      const ent = JSON.parse(b.entities) as { hashtags?: string[]; tools?: string[]; mentions?: string[] }
      const parts: string[] = []
      if (ent.hashtags?.length) parts.push(`#${ent.hashtags.slice(0, 10).join(' #')}`)
      if (ent.tools?.length) parts.push(`tools: ${ent.tools.join(', ')}`)
      if (ent.mentions?.length) parts.push(`mentions: @${ent.mentions.slice(0, 5).join(' @')}`)
      if (parts.length) lines.push(parts.join(' | '))
    } catch { /* ignore */ }
  }

  if (b.categories.length) {
    const cats = b.categories
      .filter((c) => c.confidence >= 0.5)
      .map((c) => `${c.category.name}(${c.confidence.toFixed(1)})`)
      .join(', ')
    if (cats) lines.push(`categories: ${cats}`)
  }

  return lines.join('\n')
}

// ─── Main handler ─────────────────────────────────────────────────────────────
export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: { query?: string; category?: string } = {}
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const db = getDb()
  const d1 = getD1()
  const { query, category } = body
  if (!query?.trim()) return NextResponse.json({ error: 'Query required' }, { status: 400 })

  const apiKey = await getDbApiKey()

  const cacheKey = `${query.trim().toLowerCase()}::${category ?? ''}`
  const cached = getCached(cacheKey)
  if (cached) return NextResponse.json(cached)

  let client: AIClient
  try {
    client = await resolveAIClient({ dbKey: apiKey })
  } catch {
    return NextResponse.json({ error: 'No API key configured. Add an API key in Settings.' }, { status: 400 })
  }
  const model = await getActiveModel()

  // ── Step 1: Smart candidate selection ─────────────────────────────────────
  const keywords = extractKeywords(query)
  const intentSlugs = category ? [] : await detectIntentCategories(query)
  const MAX_CANDIDATES = 150

  // Build category filter for raw SQL
  let categoryFilterSql = ''
  const categoryFilterParams: string[] = []
  if (category) {
    categoryFilterSql = 'AND b.id IN (SELECT bc.bookmarkId FROM BookmarkCategory bc JOIN Category c ON bc.categoryId = c.id WHERE c.slug = ?)'
    categoryFilterParams.push(category)
  }

  // Try FTS5 first (fast, ranked by relevance); fall back to LIKE on error/empty
  const ftsIds = keywords.length > 0 ? await ftsSearch(keywords) : []
  const useFts = ftsIds.length > 0

  // Fetch keyword hits
  let keywordHitIds: string[] = []
  if (keywords.length > 0) {
    if (useFts) {
      // Filter FTS IDs by category if needed
      if (category && ftsIds.length > 0) {
        const placeholders = ftsIds.map(() => '?').join(', ')
        const result = await d1
          .prepare(
            `SELECT b.id FROM Bookmark b WHERE b.id IN (${placeholders}) ${categoryFilterSql} LIMIT ?`
          )
          .bind(...ftsIds, ...categoryFilterParams, MAX_CANDIDATES)
          .all<{ id: string }>()
        keywordHitIds = result.results.map((r) => r.id)
      } else {
        keywordHitIds = ftsIds.slice(0, MAX_CANDIDATES)
      }
    } else {
      // LIKE-based fallback
      const likeConditions = keywords.map(() =>
        '(b.text LIKE ? OR b.semanticTags LIKE ? OR b.entities LIKE ?)'
      ).join(' OR ')
      const likeParams = keywords.flatMap((kw) => [`%${kw}%`, `%${kw}%`, `%${kw}%`])
      const result = await d1
        .prepare(
          `SELECT b.id FROM Bookmark b WHERE (${likeConditions}) ${categoryFilterSql} ORDER BY b.enrichedAt DESC, b.tweetCreatedAt DESC LIMIT ?`
        )
        .bind(...likeParams, ...categoryFilterParams, MAX_CANDIDATES)
        .all<{ id: string }>()
      keywordHitIds = result.results.map((r) => r.id)
    }
  }

  // Fetch intent hits
  let intentHitIds: string[] = []
  if (intentSlugs.length > 0) {
    const slugPlaceholders = intentSlugs.map(() => '?').join(', ')
    const result = await d1
      .prepare(
        `SELECT b.id FROM Bookmark b WHERE b.id IN (SELECT bc.bookmarkId FROM BookmarkCategory bc JOIN Category c ON bc.categoryId = c.id WHERE c.slug IN (${slugPlaceholders})) ${categoryFilterSql} ORDER BY b.enrichedAt DESC, b.tweetCreatedAt DESC LIMIT 80`
      )
      .bind(...intentSlugs, ...categoryFilterParams)
      .all<{ id: string }>()
    intentHitIds = result.results.map((r) => r.id)
  }

  // Merge and dedup
  const seen = new Set<string>()
  const mergedIds: string[] = []
  for (const id of [...keywordHitIds, ...intentHitIds]) {
    if (!seen.has(id)) { seen.add(id); mergedIds.push(id) }
  }

  // If still very few candidates, pull a recent sample
  let allIds = mergedIds
  if (allIds.length < 20) {
    const fallbackResult = await d1
      .prepare(
        `SELECT b.id FROM Bookmark b WHERE 1=1 ${categoryFilterSql} ORDER BY b.enrichedAt DESC, b.tweetCreatedAt DESC LIMIT ?`
      )
      .bind(...categoryFilterParams, MAX_CANDIDATES)
      .all<{ id: string }>()
    const fallbackSeen = new Set(allIds)
    for (const r of fallbackResult.results) {
      if (!fallbackSeen.has(r.id)) { fallbackSeen.add(r.id); allIds.push(r.id) }
    }
    allIds = allIds.slice(0, MAX_CANDIDATES)
  }

  if (allIds.length === 0) {
    return NextResponse.json({ bookmarks: [], explanation: 'No bookmarks found.' })
  }

  // Hydrate with full relational data
  const bookmarkRows = await db.query.bookmarks.findMany({
    where: inArray(bookmarks.id, allIds),
    columns: {
      id: true, tweetId: true, text: true, authorHandle: true, authorName: true,
      tweetCreatedAt: true, importedAt: true, semanticTags: true, entities: true,
    },
    with: {
      mediaItems: { columns: { id: true, type: true, url: true, thumbnailUrl: true, imageTags: true } },
      categories: {
        with: { category: { columns: { id: true, name: true, slug: true, color: true } } },
      },
    },
  })

  if (bookmarkRows.length === 0) {
    return NextResponse.json({ bookmarks: [], explanation: 'No bookmarks found.' })
  }

  // ── Step 2: Build rich search index ───────────────────────────────────────
  const indexEntries = bookmarkRows.map(buildIndexEntry)

  // ── Step 3: Compose prompt ─────────────────────────────────────────────────
  const prompt = `You are an expert semantic search engine for a personal Twitter/X bookmark knowledge base. Find bookmarks that genuinely match what the user wants — even when exact words don't appear.

USER QUERY: "${query}"
${category ? `RESTRICTED TO CATEGORY: "${category}"` : ''}

HOW TO SEARCH:
1. Understand INTENT first: what topic, emotion, visual, or use-case is the user after?
2. Check ALL fields — the ai_tags field contains pre-computed semantic context and is highly reliable
3. Consider synonyms and indirect matches: "identity verification problems" matches "bad KYC practices"
4. For visual/meme queries: weight media fields heavily (scene, action, ocr text IN the image, vtags)
5. Indirect signals count: if categories say "finance-crypto(0.9)" and query is about investing → likely relevant
6. Score generously for semantic neighbors (0.4+), reserve 0.9+ for clear matches

BOOKMARK FORMAT:
[bookmark_id]
text: tweet text (most direct signal)
media: type | style | scene | action | mood | meme=template | ocr="text inside image" | objects | vtags=visual tags
ai_tags: AI-generated search tags (pre-computed, highly reliable)
#hashtags | tools: detected tools/products | @mentions
categories: assigned categories with confidence scores

BOOKMARKS (${bookmarkRows.length} total):
${indexEntries.join('\n---\n')}

Return ONLY valid JSON — no markdown, no prose outside the JSON object:
{
  "queryIntent": "one phrase describing what the user wants",
  "matches": [
    { "id": "bookmark_id", "score": 0.0-1.0, "reason": "≤10 words why it matches" }
  ],
  "explanation": "one sentence summarizing what was found and why"
}

Constraints:
- Up to 15 matches, sorted by score descending
- Minimum score 0.30 — be generous for semantically close matches
- Never repeat an id
- Only return ids from the list above
- reason must be specific, not generic ("shows bitcoin price crash chart" not "related to crypto")`

  let aiResponse: { queryIntent?: string; matches: { id: string; score: number; reason: string }[]; explanation: string } = { matches: [], explanation: 'No results found.' }

  const parseSearchResponse = (rawText: string): typeof aiResponse => {
    const jsonMatch = rawText.match(/\{[\s\S]*\}/)
    return jsonMatch
      ? (JSON.parse(jsonMatch[0]) as typeof aiResponse)
      : { matches: [], explanation: 'No results found.' }
  }

  try {
    const response = await client.createMessage({
      model,
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    })
    const rawText = response.text ?? '{}'
    aiResponse = parseSearchResponse(rawText)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error('AI search error:', errMsg)
    return NextResponse.json({ error: `AI search failed: ${errMsg}` }, { status: 500 })
  }

  // ── Step 4: Hydrate results ────────────────────────────────────────────────
  const bookmarkById = new Map(bookmarkRows.map((b) => [b.id, b]))
  const matchMap = new Map(aiResponse.matches.map((m) => [m.id, m]))

  const results = aiResponse.matches
    .sort((a, b) => b.score - a.score)
    .map((match) => {
      const b = bookmarkById.get(match.id)
      if (!b) return null
      return {
        id: b.id,
        tweetId: b.tweetId,
        text: b.text,
        authorHandle: b.authorHandle,
        authorName: b.authorName,
        tweetCreatedAt: b.tweetCreatedAt ?? null,
        importedAt: b.importedAt,
        mediaItems: b.mediaItems.map((m) => ({
          id: m.id, type: m.type, url: m.url, thumbnailUrl: m.thumbnailUrl, imageTags: m.imageTags ?? null,
        })),
        categories: b.categories.map((bc) => ({
          id: bc.category.id, name: bc.category.name, slug: bc.category.slug,
          color: bc.category.color, confidence: bc.confidence,
        })),
        aiScore: matchMap.get(b.id)?.score ?? 0,
        aiReason: matchMap.get(b.id)?.reason ?? '',
      }
    })
    .filter(Boolean)

  const responseData = { bookmarks: results, explanation: aiResponse.explanation }
  setCache(cacheKey, responseData)
  return NextResponse.json(responseData)
}
