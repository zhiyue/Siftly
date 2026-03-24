import { getCloudflareContext } from '@opennextjs/cloudflare'

function getBucket(): R2Bucket {
  const { env } = getCloudflareContext()
  return env.MEDIA_BUCKET
}

export async function uploadMedia(
  key: string,
  data: ArrayBuffer | ReadableStream | Uint8Array,
  contentType: string
): Promise<void> {
  const bucket = getBucket()
  await bucket.put(key, data, {
    httpMetadata: { contentType },
  })
}

export async function getMedia(key: string): Promise<R2ObjectBody | null> {
  const bucket = getBucket()
  return bucket.get(key)
}

export async function deleteMedia(key: string): Promise<void> {
  const bucket = getBucket()
  await bucket.delete(key)
}

export function mediaKey(bookmarkId: string, filename: string): string {
  return `media/${bookmarkId}/${filename}`
}
