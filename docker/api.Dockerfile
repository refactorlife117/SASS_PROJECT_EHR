# API server and worker (same image, different command). Runs TypeScript with tsx.
#   docker build -f docker/api.Dockerfile -t slotfill-api .
#   server: default CMD     worker: pnpm --filter @slotfill/api start:worker
#   release (bootstrap + migrations): pnpm --filter @slotfill/api db:release
FROM node:24-slim
RUN corepack enable pnpm && apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
# postinstall runs `prisma generate` for the api package.
RUN pnpm install --frozen-lockfile --filter "@slotfill/api..." && chown -R node:node /app
USER node
ENV NODE_ENV=production
EXPOSE 4000
CMD ["pnpm", "--filter", "@slotfill/api", "start:server"]
