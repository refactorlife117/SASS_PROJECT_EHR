import { NextResponse } from 'next/server';
import { devToolsEnabled } from '@/lib/dev-tools';

/**
 * Dev-only pages must not exist in production builds. Answer 404 before rendering: the signed-in
 * layout streams a shell first, so a page-level notFound() would arrive with a 200 status.
 */
export function proxy() {
  if (devToolsEnabled) return NextResponse.next();
  return new NextResponse('Not found', { status: 404 });
}

export const config = { matcher: '/dev/:path*' };
