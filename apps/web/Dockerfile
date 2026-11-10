# Attestra site image (for running the whole stack locally; production hosting is Vercel).
#   docker build -f apps/web/Dockerfile -t attestra-web .
# NEXT_PUBLIC_* values are baked in at build time.

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
ARG NEXT_PUBLIC_NEAR_NETWORK=testnet
ARG NEXT_PUBLIC_INDEXER_URL=http://localhost:5100
ARG NEXT_PUBLIC_RELAYER_URL=http://localhost:5200
ARG NEXT_PUBLIC_AGENT_URL=http://localhost:5300
ARG NEXT_PUBLIC_KEEPER_URL=http://localhost:5400
ARG NEXT_PUBLIC_TOPUP_URL=http://localhost:5500
ENV NEXT_PUBLIC_NEAR_NETWORK=$NEXT_PUBLIC_NEAR_NETWORK NEXT_PUBLIC_INDEXER_URL=$NEXT_PUBLIC_INDEXER_URL NEXT_PUBLIC_RELAYER_URL=$NEXT_PUBLIC_RELAYER_URL \
    NEXT_PUBLIC_AGENT_URL=$NEXT_PUBLIC_AGENT_URL NEXT_PUBLIC_KEEPER_URL=$NEXT_PUBLIC_KEEPER_URL NEXT_PUBLIC_TOPUP_URL=$NEXT_PUBLIC_TOPUP_URL \
    NEXT_OUTPUT=standalone NEXT_TELEMETRY_DISABLED=1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/mcp/package.json packages/mcp/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @attestra/web...
COPY packages/sdk packages/sdk
COPY packages/mcp packages/mcp
RUN pnpm --filter @attestra/sdk build && pnpm --filter @attestra/mcp build
COPY apps/web apps/web
RUN pnpm --filter @attestra/web build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3100 HOSTNAME=0.0.0.0
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static apps/web/.next/static
USER node
EXPOSE 3100
CMD ["node", "apps/web/server.js"]
