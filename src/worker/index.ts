import { Hono } from 'hono'
import { cors } from 'hono/cors'

import stats from './routes/stats'
import bookmarks from './routes/bookmarks'
import categories from './routes/categories'
import categorize from './routes/categorize'
import importRoutes from './routes/import'
import importLive from './routes/import-live'
import search from './routes/search'
import settings from './routes/settings'
import analyze from './routes/analyze'
import exportRoute from './routes/export'
import media from './routes/media'
import mindmap from './routes/mindmap'
import linkPreview from './routes/link-preview'

export type Bindings = {
  DB: D1Database
  MEDIA_BUCKET: R2Bucket
  PIPELINE_DO: DurableObjectNamespace
  ANTHROPIC_API_KEY: string
  OPENAI_API_KEY: string
  ANTHROPIC_BASE_URL: string
  OPENAI_BASE_URL: string
  ASSETS: Fetcher
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/api/*', cors())

app.get('/api/health', (c) => c.json({ ok: true }))

// Mount all API routes
app.route('/', stats)
app.route('/', bookmarks)
app.route('/', categories)
app.route('/', categorize)
app.route('/', importRoutes)
app.route('/', importLive)
app.route('/', search)
app.route('/', settings)
app.route('/', analyze)
app.route('/', exportRoute)
app.route('/', media)
app.route('/', mindmap)
app.route('/', linkPreview)

// SPA fallback — serve index.html for all non-API, non-asset routes.
// In production, wrangler's "not_found_handling": "single-page-application" handles this.
// This catch-all ensures it also works in local dev.
app.get('*', async (c) => {
  return c.env.ASSETS.fetch(new Request(new URL('/', c.req.url)))
})

export default app
export { PipelineDO } from '../../lib/pipeline-do'
