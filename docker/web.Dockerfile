# Next.js staff app (standalone server).
#   docker build -f docker/web.Dockerfile -t slotfill-web .
#   staging (keeps /dev pages): --build-arg NEXT_PUBLIC_DEV_TOOLS=true
FROM node:24-slim AS build
RUN corepack enable pnpm
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
ARG NEXT_PUBLIC_DEV_TOOLS=false
ENV NEXT_PUBLIC_DEV_TOOLS=$NEXT_PUBLIC_DEV_TOOLS NEXT_TELEMETRY_DISABLED=1
RUN pnpm install --frozen-lockfile --filter "@slotfill/web..." && pnpm --filter @slotfill/web build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
