/**
 * Dev-only pages (mock EHR, phone simulator) exist in `next dev` and in builds made with
 * NEXT_PUBLIC_DEV_TOOLS=true (staging). Production images are built without it, so the pages 404.
 * Inlined at build time.
 */
export const devToolsEnabled =
  process.env.NODE_ENV === 'development' || process.env.NEXT_PUBLIC_DEV_TOOLS === 'true';
