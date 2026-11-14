# Attestra agent image. Build from the repository root:
#   docker build -f apps/agent/Dockerfile -t attestra-agent .

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/mcp/package.json packages/mcp/
COPY apps/agent/package.json apps/agent/
RUN pnpm install --frozen-lockfile --filter @attestra/agent...
COPY packages/sdk packages/sdk
RUN pnpm --filter attestra build
COPY packages/mcp packages/mcp
RUN pnpm --filter attestra-mcp build

FROM node:22-alpine
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/mcp/package.json packages/mcp/
COPY apps/agent/package.json apps/agent/
RUN pnpm install --frozen-lockfile --prod --filter @attestra/agent... && pnpm store prune
COPY --from=build /app/packages/sdk/dist packages/sdk/dist
COPY --from=build /app/packages/mcp/dist packages/mcp/dist
COPY apps/agent/src apps/agent/src
COPY apps/agent/tsconfig.json apps/agent/

WORKDIR /app/apps/agent
USER node
ENV NODE_OPTIONS=--max-old-space-size=128
EXPOSE 5300
CMD ["node", "--import", "tsx", "src/main.ts"]
