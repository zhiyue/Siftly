import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'
import { extractBearerToken, verifyApiKey } from '@/lib/api-auth'

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const token = extractBearerToken(request.headers.get('Authorization'))
  if (token) {
    const keyId = await verifyApiKey(token)
    if (!keyId) return NextResponse.json({ error: 'Invalid API key' }, { status: 401 })
  }

  const { id } = await params
  try {
    await prisma.apiKey.delete({ where: { id } })
    return NextResponse.json({ deleted: true })
  } catch {
    return NextResponse.json({ error: 'API key not found' }, { status: 404 })
  }
}
