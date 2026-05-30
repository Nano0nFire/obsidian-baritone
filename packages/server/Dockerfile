# syntax=docker/dockerfile:1

FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/server/package.json packages/server/package.json
COPY apps/plugin/package.json apps/plugin/package.json
COPY tsconfig.base.json tsconfig.base.json
RUN npm ci

COPY packages/shared packages/shared
COPY packages/server packages/server
RUN npm run build --workspace @obsidian-sync/shared \
  && npm run build --workspace @obsidian-sync/server \
  && npm pkg set scripts.migrate="node dist/db/migrate.js" scripts.cli="node dist/cli.js" --workspace @obsidian-sync/server \
  && npm prune --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    SERVER_PORT=3000

RUN apk add --no-cache wget \
  && addgroup -S obsync -g 10001 \
  && adduser -S obsync -u 10001 -G obsync

COPY --from=builder --chown=obsync:obsync /app/package.json /app/package-lock.json ./
COPY --from=builder --chown=obsync:obsync /app/node_modules ./node_modules
COPY --from=builder --chown=obsync:obsync /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder --chown=obsync:obsync /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder --chown=obsync:obsync /app/packages/server/package.json ./packages/server/package.json
COPY --from=builder --chown=obsync:obsync /app/packages/server/dist ./packages/server/dist

USER obsync
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider "http://127.0.0.1:${SERVER_PORT}/readyz" || exit 1

CMD ["npm", "run", "start", "--workspace", "@obsidian-sync/server"]
