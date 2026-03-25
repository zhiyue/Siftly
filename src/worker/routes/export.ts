import { Hono } from 'hono'
import type { Bindings } from '../index'
import { getDb } from '@/lib/db'
import { exportAllBookmarksCsv, exportBookmarksJson, exportCategoryAsZip } from '@/lib/exporter'

const route = new Hono<{ Bindings: Bindings }>()

route.get('/api/export', async (c) => {
  const type = c.req.query('type')
  const categorySlug = c.req.query('category')

  if (!type) {
    return c.json(
      { error: 'Missing required query param: type (csv | json | zip)' },
      400
    )
  }

  const db = getDb(c.env.DB)

  if (type === 'csv') {
    try {
      const csv = await exportAllBookmarksCsv(db)
      return new Response(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="bookmarks.csv"',
        },
      })
    } catch (err) {
      console.error('CSV export error:', err)
      return c.json(
        { error: `Failed to export CSV: ${err instanceof Error ? err.message : String(err)}` },
        500
      )
    }
  }

  if (type === 'json') {
    try {
      const json = await exportBookmarksJson(db)
      return new Response(json, {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': 'attachment; filename="bookmarks.json"',
        },
      })
    } catch (err) {
      console.error('JSON export error:', err)
      return c.json(
        { error: `Failed to export JSON: ${err instanceof Error ? err.message : String(err)}` },
        500
      )
    }
  }

  if (type === 'zip') {
    try {
      let zipBuffer: Uint8Array

      if (categorySlug) {
        zipBuffer = await exportCategoryAsZip(db, categorySlug)
        const safeSlug = categorySlug.replace(/[^a-z0-9-_]/gi, '_')
        return new Response(new Uint8Array(zipBuffer), {
          status: 200,
          headers: {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="bookmarks-${safeSlug}.zip"`,
          },
        })
      }

      // ZIP of all bookmarks
      const json = await exportBookmarksJson(db)
      const JSZip = (await import('jszip')).default
      const zip = new JSZip()
      zip.file('bookmarks.json', json)
      zipBuffer = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })

      return new Response(new Uint8Array(zipBuffer), {
        status: 200,
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': 'attachment; filename="bookmarks-all.zip"',
        },
      })
    } catch (err) {
      console.error('ZIP export error:', err)
      return c.json(
        { error: `Failed to export ZIP: ${err instanceof Error ? err.message : String(err)}` },
        500
      )
    }
  }

  return c.json(
    { error: `Unknown export type: ${type}. Use csv, json, or zip.` },
    400
  )
})

export default route
