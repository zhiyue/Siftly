/// <reference types="@cloudflare/workers-types" />

/**
 * Cloudflare Workers environment bindings.
 * This interface is declared globally by @opennextjs/cloudflare (cloudflare-context.d.ts)
 * and merged here with our app-specific bindings.
 */
interface CloudflareEnv {
  DB: D1Database
  MEDIA_BUCKET: R2Bucket
  PIPELINE_DO: DurableObjectNamespace
  ANTHROPIC_API_KEY: string
  OPENAI_API_KEY: string
  ANTHROPIC_BASE_URL: string
  OPENAI_BASE_URL: string
}
