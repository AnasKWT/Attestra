# Attestra services image: one image, three services. Build from the repository root:
#   docker build -f services/Dockerfile -t attestra-services .
# and pick the service with the compose `command` (default: relayer):
#   command: ["node", "--import", "tsx", "src/main.ts", "keeper"]

# ---- build: the SDK's dist (the services import @attestra/sdk)
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/sdk/package.json packages/sdk/
COPY services/package.json services/
RUN pnpm install --frozen-lockfile --filter @attestra/sdk
COPY packages/sdk packages/sdk
RUN pnpm --filter @attestra/sdk build

# ---- run: production dependencies only
FROM node:22-alpine
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/sdk/package.json packages/sdk/
COPY services/package.json services/
RUN pnpm install --frozen-lockfile --prod --filter @attestra/services... && pnpm store prune
COPY --from=build /app/packages/sdk/dist packages/sdk/dist
COPY services/src services/src
COPY services/tsconfig.json services/
COPY services/scripts services/scripts
WORKDIR /app/services
RUN mkdir -p .data && chown -R node:node .data
USER node
# Small heap: each service holds little state.
ENV NODE_OPTIONS=--max-old-space-size=96
EXPOSE 5200 5400 5500
CMD ["node", "--import", "tsx", "src/main.ts", "relayer"]
