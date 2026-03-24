import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  transpilePackages: ['@prisma/client', '@prisma/adapter-d1'],
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*.twimg.com',
      },
    ],
  },
}

export default nextConfig
