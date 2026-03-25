export async function uploadMedia(
  bucket: R2Bucket,
  key: string,
  data: ArrayBuffer | ReadableStream | Uint8Array,
  contentType: string
): Promise<void> {
  await bucket.put(key, data, {
    httpMetadata: { contentType },
  })
}

export async function getMedia(bucket: R2Bucket, key: string): Promise<R2ObjectBody | null> {
  return bucket.get(key)
}

export async function deleteMedia(bucket: R2Bucket, key: string): Promise<void> {
  await bucket.delete(key)
}

export function mediaKey(bookmarkId: string, filename: string): string {
  return `media/${bookmarkId}/${filename}`
}
