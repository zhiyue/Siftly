import { NextRequest, NextResponse } from 'next/server'

export function middleware(request: NextRequest): NextResponse {
  const username = process.env.SIFTLY_USERNAME?.trim()
  const password = process.env.SIFTLY_PASSWORD?.trim()

  if (!username || !password) return NextResponse.next()

  if (request.nextUrl.pathname === '/api/import/bookmarklet') {
    return NextResponse.next()
  }

  const authHeader = request.headers.get('Authorization')

  // Bearer tokens pass through middleware — validated at route level
  if (authHeader?.startsWith('Bearer ')) {
    return NextResponse.next()
  }

  if (authHeader?.startsWith('Basic ')) {
    try {
      const decoded = atob(authHeader.slice(6))
      const colonIdx = decoded.indexOf(':')
      if (colonIdx !== -1) {
        const user = decoded.slice(0, colonIdx)
        const pass = decoded.slice(colonIdx + 1)
        if (user === username && pass === password) {
          return NextResponse.next()
        }
      }
    } catch {}
  }

  return new NextResponse('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Siftly"' },
  })
}

export const config = {
  matcher: [
    '/((?!_next/|favicon.ico|icon.svg).*)',
  ],
}
