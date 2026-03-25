import { Hono } from 'hono'
import type { Bindings } from '../index'
import { getMedia } from '@/lib/r2'

const ALLOWED_HOSTS = new Set([
  'pbs.twimg.com',
  'video.twimg.com',
  'ton.twimg.com',
  'abs.twimg.com',
  'unavatar.io',
])

function isAllowedUrl(urlStr: string): boolean {
  try {
    const { protocol, hostname } = new URL(urlStr)
    return protocol === 'https:' && ALLOWED_HOSTS.has(hostname)
  } catch {
    return false
  }
}

function getFilename(urlStr: string, contentType: string): string {
  try {
    const pathname = new URL(urlStr).pathname
    const last = pathname.split('/').pop()?.split('?')[0] ?? ''
    if (last.includes('.')) return last
  } catch { /* ignore */ }
  if (contentType.includes('mp4')) return 'video.mp4'
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return 'photo.jpg'
  if (contentType.includes('png')) return 'photo.png'
  if (contentType.includes('gif')) return 'animation.gif'
  if (contentType.includes('webp')) return 'photo.webp'
  return 'media.bin'
}

const route = new Hono<{ Bindings: Bindings }>()

// GET /api/media — twimg proxy
route.get('/api/media', async (c) => {
  const mediaUrl = c.req.query('url')
  const isDownload = c.req.query('download') === '1'

  if (!mediaUrl) {
    return c.json({ error: 'Missing url parameter' }, 400)
  }

  if (!isAllowedUrl(mediaUrl)) {
    return c.json({ error: 'URL not allowed' }, 403)
  }

  try {
    const rangeHeader = c.req.header('range')

    const upstream = await fetch(mediaUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Referer': 'https://twitter.com/',
        'Origin': 'https://twitter.com',
        'Accept': '*/*',
        ...(rangeHeader ? { 'Range': rangeHeader } : {}),
      },
    })

    if (!upstream.ok) {
      return new Response(null, { status: upstream.status })
    }

    const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream'
    const responseHeaders: Record<string, string> = {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
    }

    const contentRange = upstream.headers.get('content-range')
    if (contentRange) responseHeaders['Content-Range'] = contentRange
    const contentLength = upstream.headers.get('content-length')
    if (contentLength) responseHeaders['Content-Length'] = contentLength

    if (isDownload) {
      const filename = getFilename(mediaUrl, contentType)
      responseHeaders['Content-Disposition'] = `attachment; filename="${filename}"`
    }

    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders })
  } catch (err) {
    console.error('Media proxy error:', err)
    return c.json({ error: 'Upstream fetch failed' }, 502)
  }
})

// GET /api/r2/* — R2 object proxy
route.get('/api/r2/*', async (c) => {
  const path = c.req.path
  // Strip "/api/r2/" prefix to get the object key
  const objectKey = path.replace(/^\/api\/r2\//, '')

  if (!objectKey) {
    return c.json({ error: 'Not found' }, 404)
  }

  const object = await getMedia(c.env.MEDIA_BUCKET, objectKey)
  if (!object) {
    return c.json({ error: 'Not found' }, 404)
  }

  const headers = new Headers()
  headers.set('Content-Type', object.httpMetadata?.contentType ?? 'application/octet-stream')
  headers.set('Cache-Control', 'public, max-age=31536000, immutable')

  return new Response(object.body, { headers })
})

export default route
