# Attestra indexer image. Build from the repository root:
#   docker build -f apps/indexer/Dockerfile -t attestra-indexer .

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/sdk/package.json packages/sdk/

COPY apps/indexer/package.json apps/indexer/
RUN pnpm install --frozen-lockfile --filter @attestra/indexer...
COPY packages/sdk packages/sdk
RUN pnpm --filter @attestra/sdk build


FROM node:22-alpine
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/sdk/package.json packages/sdk/

COPY apps/indexer/package.json apps/indexer/
RUN pnpm install --frozen-lockfile --prod --filter @attestra/indexer... && pnpm store prune
COPY --from=build /app/packages/sdk/dist packages/sdk/dist

COPY apps/indexer/src apps/indexer/src
COPY apps/indexer/tsconfig.json apps/indexer/
COPY apps/indexer/migrations apps/indexer/migrations
COPY deployments deployments
WORKDIR /app/apps/indexer
USER node
ENV NODE_OPTIONS=--max-old-space-size=128
EXPOSE 5100
CMD ["node", "--import", "tsx", "src/main.ts"]
