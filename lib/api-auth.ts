import { createHash, randomBytes } from 'crypto'
import prisma from '@/lib/db'

const KEY_PREFIX = 'siftly_'

export function generateApiKey(): { key: string; keyHash: string; prefix: string } {
  const raw = randomBytes(16).toString('hex')
  const key = `${KEY_PREFIX}${raw}`
  const keyHash = hashKey(key)
  const prefix = key.slice(0, 12)
  return { key, keyHash, prefix }
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

export async function verifyApiKey(token: string): Promise<string | null> {
  if (!token.startsWith(KEY_PREFIX)) return null

  const keyHash = hashKey(token)
  const apiKey = await prisma.apiKey.findUnique({ where: { keyHash } })
  if (!apiKey) return null

  const now = new Date()
  if (!apiKey.lastUsedAt || now.getTime() - apiKey.lastUsedAt.getTime() > 5 * 60 * 1000) {
    prisma.apiKey.update({
      where: { id: apiKey.id },
      data: { lastUsedAt: now },
    }).catch(() => {})
  }

  return apiKey.id
}

export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null
  return authHeader.slice(7).trim()
}
