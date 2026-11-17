import path from 'node:path';
import type { NextConfig } from 'next';

const apiUrl = process.env.API_URL ?? 'http://localhost:4000';

const nextConfig: NextConfig = {
  transpilePackages: ['@slotfill/shared'],
  // Self-contained server bundle for the Docker image (node apps/web/server.js).
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  poweredByHeader: false,
  // Same-origin /api/* so session cookies work without CORS. In AWS the load balancer routes /api/*
  // to the API service directly, so this only matters for `next dev` / single-host setups.
  rewrites: () => Promise.resolve([{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }]),
  headers: () =>
    Promise.resolve([
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
        ],
      },
    ]),
};

export default nextConfig;
