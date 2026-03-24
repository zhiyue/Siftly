import { NextRequest, NextResponse } from 'next/server'
import { getMedia } from '@/lib/r2'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ key: string[] }> }
): Promise<NextResponse> {
  const { key } = await params
  const objectKey = key.join('/')

  const object = await getMedia(objectKey)
  if (!object) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const headers = new Headers()
  headers.set('Content-Type', object.httpMetadata?.contentType ?? 'application/octet-stream')
  headers.set('Cache-Control', 'public, max-age=31536000, immutable')

  return new NextResponse(object.body, { headers })
}
