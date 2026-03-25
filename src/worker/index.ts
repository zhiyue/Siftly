import { Hono } from 'hono'
import { cors } from 'hono/cors'

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

// SPA fallback — serve index.html for all non-API, non-asset routes.
// In production, wrangler's "not_found_handling": "single-page-application" handles this.
// This catch-all ensures it also works in local dev.
app.get('*', async (c) => {
  return c.env.ASSETS.fetch(new Request(new URL('/', c.req.url)))
})

export default app
// PipelineDO export will be enabled in Task H6
// export { PipelineDO } from '../../lib/pipeline-do'
