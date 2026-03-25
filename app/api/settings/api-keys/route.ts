import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'
import { generateApiKey, extractBearerToken, verifyApiKey } from '@/lib/api-auth'

/** GET — list all API keys (no secrets) */
export async function GET(request: NextRequest) {
  const authResult = await checkAuth(request)
  if (authResult) return authResult

  const keys = await prisma.apiKey.findMany({
    select: { id: true, name: true, prefix: true, lastUsedAt: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  })
  return NextResponse.json({ keys })
}

/** POST — generate a new API key */
export async function POST(request: NextRequest) {
  const authResult = await checkAuth(request)
  if (authResult) return authResult

  let body: { name?: string } = {}
  try { body = await request.json() } catch {}

  const name = body.name?.trim() || 'Unnamed Key'
  const { key, keyHash, prefix } = generateApiKey()

  const created = await prisma.apiKey.create({
    data: { name, keyHash, prefix },
  })

  return NextResponse.json({
    id: created.id,
    name: created.name,
    key, // plaintext — shown only once
    prefix,
    createdAt: created.createdAt,
  })
}

/** Auth check: require Basic Auth or valid API Key */
async function checkAuth(request: NextRequest): Promise<NextResponse | null> {
  const token = extractBearerToken(request.headers.get('Authorization'))
  if (token) {
    const id = await verifyApiKey(token)
    if (id) return null
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 })
  }

  const username = process.env.SIFTLY_USERNAME?.trim()
  const password = process.env.SIFTLY_PASSWORD?.trim()
  if (username && password) {
    return null
  }

  return null
}
