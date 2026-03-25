import { Hono } from 'hono'
import type { Bindings } from '../index'

const CACHE_HEADERS = {
  'Cache-Control': 'public, max-age=86400',
}

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

function isPrivateUrl(raw: string): boolean {
  try {
    const { protocol, hostname } = new URL(raw)
    if (protocol !== 'http:' && protocol !== 'https:') return true
    if (hostname === 'localhost' || hostname === '0.0.0.0') return true
    if (/^127\./.test(hostname)) return true
    if (/^10\./.test(hostname)) return true
    if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname)) return true
    if (/^192\.168\./.test(hostname)) return true
    if (/^169\.254\./.test(hostname)) return true
    if (hostname === '::1' || /^\[::1\]$/.test(hostname)) return true
    if (/^fd[0-9a-f]{2,}:/i.test(hostname)) return true
    return false
  } catch {
    return true
  }
}

function syntheticTitle(finalUrl: string, siteName: string): string {
  try {
    const { hostname, pathname } = new URL(finalUrl)
    const host = hostname.replace(/^www\./, '')

    if ((host === 'x.com' || host === 'twitter.com') && pathname.startsWith('/i/article')) {
      return 'Article on X'
    }
    if (host === 'x.com' || host === 'twitter.com') {
      return 'View on X'
    }
    if (siteName) return `Article on ${siteName}`
  } catch { /* ignore */ }
  return ''
}

function extractMeta(html: string, ...patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const match = html.match(pattern)
    if (match?.[1]) return decodeHtmlEntities(match[1].trim())
  }
  return ''
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
}

async function fetchXArticlePreview(tweetId: string): Promise<{
  title: string; description: string; image: string; siteName: string; domain: string; url: string
} | null> {
  try {
    const res = await fetch(
      `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=x`,
      { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(8000) },
    )
    if (!res.ok) return null
    const data = await res.json() as {
      article?: {
        rest_id?: string
        title?: string
        preview_text?: string
        cover_media?: { media_info?: { original_img_url?: string } }
      }
      card?: {
        name?: string
        binding_values?: Record<string, { string_value?: string; image_value?: { url?: string } }>
      }
      user?: { name?: string; screen_name?: string; profile_image_url_https?: string }
    }

    if (data.article?.title) {
      const articleId = data.article.rest_id || tweetId
      return {
        title: data.article.title,
        description: data.article.preview_text || '',
        image: data.article.cover_media?.media_info?.original_img_url || '',
        siteName: data.user?.name || 'X',
        domain: 'x.com',
        url: `https://x.com/i/article/${articleId}`,
      }
    }

    if (data.card?.binding_values) {
      const bv = data.card.binding_values
      const cardTitle = bv.title?.string_value
      if (cardTitle) {
        return {
          title: cardTitle,
          description: bv.description?.string_value || '',
          image: bv.thumbnail_image_original?.image_value?.url
            || bv.thumbnail_image?.image_value?.url
            || bv.summary_photo_image_original?.image_value?.url
            || bv.summary_photo_image?.image_value?.url
            || '',
          siteName: bv.vanity_url?.string_value || data.user?.name || 'X',
          domain: bv.domain?.string_value || 'x.com',
          url: bv.card_url?.string_value || bv.url?.string_value || `https://x.com/i/status/${tweetId}`,
        }
      }
    }

    return null
  } catch {
    return null
  }
}

const route = new Hono<{ Bindings: Bindings }>()

route.get('/api/link-preview', async (c) => {
  const url = c.req.query('url')
  if (!url) {
    return c.json({ error: 'url required' }, 400)
  }

  if (isPrivateUrl(url)) {
    return c.json({ error: 'Invalid URL' }, 400)
  }

  const rawTweetId = c.req.query('tweetId')
  const tweetId = rawTweetId && /^\d+$/.test(rawTweetId) ? rawTweetId : null

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    })

    if (!res.ok) {
      return c.json({ error: `HTTP ${res.status}` }, 502)
    }

    if (isPrivateUrl(res.url)) {
      return c.json({ error: 'Invalid URL' }, 400)
    }

    const reader = res.body?.getReader()
    if (!reader) return c.json({ error: 'no body' }, 502)

    let html = ''
    let bytes = 0
    while (bytes < 50_000) {
      const { done, value } = await reader.read()
      if (done) break
      html += new TextDecoder().decode(value)
      bytes += value.length
      if (html.includes('</head>')) break
    }
    reader.cancel().catch(() => {})

    let finalUrl = res.url

    const titleTagMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
    const titleTagText = titleTagMatch?.[1]?.trim() ?? ''
    if (
      titleTagText.match(/^https?:\/\//) &&
      (() => { try { return new URL(finalUrl).hostname.includes('t.co') } catch { return false } })()
    ) {
      finalUrl = titleTagText
    }

    const domain = (() => {
      try { return new URL(finalUrl).hostname.replace(/^www\./, '') } catch { return '' }
    })()

    const isXDomain = domain === 'x.com' || domain === 'twitter.com'

    if (isXDomain && tweetId) {
      const articleData = await fetchXArticlePreview(tweetId)
      if (articleData) {
        return c.json(articleData, { headers: CACHE_HEADERS })
      }
    }

    const title = extractMeta(
      html,
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i,
      /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i,
    )

    const description = extractMeta(
      html,
      /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i,
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i,
    )

    const image = extractMeta(
      html,
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
    )

    const siteName = extractMeta(
      html,
      /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i,
    )

    if (isXDomain && tweetId && !image && (!title || /^(Article on X|View on X|post \/ X|X)$/i.test(title))) {
      const articleData = await fetchXArticlePreview(tweetId)
      if (articleData) {
        return c.json(articleData, { headers: CACHE_HEADERS })
      }
    }

    const resolvedTitle = title || syntheticTitle(finalUrl, siteName)

    return c.json(
      { title: resolvedTitle, description, image, siteName, domain, url: finalUrl },
      { headers: CACHE_HEADERS },
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'preview failed'
    return c.json({ error: msg }, { status: 502, headers: CACHE_HEADERS })
  }
})

export default route
