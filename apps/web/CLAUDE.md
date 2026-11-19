# apps/web: Next.js staff dashboard

@AGENTS.md

This is Next.js 16 (App Router, Turbopack). Its APIs may differ from what you remember, so check `node_modules/next/dist/docs/` before using an unfamiliar API.

## Scripts

`pnpm --filter @slotfill/web <script>`: `dev` (port 3000), `build`, `start`, `typecheck` (runs `next typegen`, then `tsc`).

## Structure

- `app/`: routes. `layout.tsx` wraps everything in `providers.tsx` (React Query). `/login` and `/mfa` are public.
- `app/(app)/`: the signed-in area. Its `layout.tsx` is the auth guard (redirects to `/login`) plus the header and nav. Every new staff page goes here. Read the tenant time zone from `useMe().data.tenant.timezone`.
- `app/(app)/dev/*`: dev-only pages. A server `page.tsx` calls `notFound()` outside development and renders a client panel.
- `components/`: shared UI (`StatusBadge`, `MessageBubble`).
- Pages: `/` (dashboard), `/appointments`, `/waitlist`, `/offers`, `/messages`, `/settings` (incl. EHR connection and SMS provider), `/team` (owners), `/login`, `/mfa`, `/forgot-password`, `/reset-password` (also invites: `?invite=1`), `/dev/ehr`, `/dev/phone`.
- `app/admin/`: the SlotFill operator console (platform admins only; its own layout and guard). The signed-in clinic layout redirects platform admins there.
- Production: `output: 'standalone'` (`docker/web.Dockerfile`); security headers in `next.config.ts`.
- `hooks/`: **one React Query hook per resource** (`useAuth`, `useAppointments`, `useDevEhr`, later `useWaitlist`, `useOffers`, …). Mutations invalidate the related query keys. The offers and messages pages poll every 10 s.
- `lib/api.ts`: `apiGet`, `apiPost` and `apiPostNoContent` call `/api/v1/*` and validate responses with `@slotfill/shared` schemas. Failures throw `ApiError(status, code)`. Don't call `fetch` directly from components.

## Rules specific to this app

- `/api/*` is proxied to the Express API by `rewrites` in `next.config.ts`, so it is same-origin and session cookies work without CORS.
- Response and request shapes come from `@slotfill/shared`. Never redefine a schema locally.
- Pages that show PHI are behind auth (Phase 1+). Never put PHI in URLs, page titles or client-side analytics.
- `/dev/*` pages (phone simulator, mock EHR) exist only when `lib/dev-tools.ts` says so: `next dev`, or a build with `NEXT_PUBLIC_DEV_TOOLS=true` (staging). `proxy.ts` (Next 16 middleware) answers 404 for `/dev/*` otherwise. Don't rely on page-level `notFound()` under the streaming signed-in layout: it renders 404 content with HTTP 200.
- Dates and times: always show them in the **tenant's** time zone using the `@slotfill/shared` time helpers (`formatDateInZone`, `formatTimeInZone`, `toDateKey`, `zonedTimeToUtc`), never the browser's local zone.
