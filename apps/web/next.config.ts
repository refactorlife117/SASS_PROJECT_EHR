import type { NextConfig } from 'next';

const apiUrl = process.env.API_URL ?? 'http://localhost:4000';

const nextConfig: NextConfig = {
  transpilePackages: ['@slotfill/shared'],
  // Same-origin /api/* so session cookies work without CORS.
  rewrites: () => Promise.resolve([{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }]),
};

export default nextConfig;
