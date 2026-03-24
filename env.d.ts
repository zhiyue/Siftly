// env.d.ts
interface CloudflareEnv {
  DB: D1Database
  MEDIA_BUCKET: R2Bucket
  PIPELINE_DO: DurableObjectNamespace
  ANTHROPIC_API_KEY: string
  OPENAI_API_KEY: string
  ANTHROPIC_BASE_URL: string
  OPENAI_BASE_URL: string
  ASSETS: Fetcher
}

declare module '@opennextjs/cloudflare' {
  export function getCloudflareContext(): {
    env: CloudflareEnv
    cf: IncomingRequestCfProperties
    ctx: ExecutionContext
  }
}
