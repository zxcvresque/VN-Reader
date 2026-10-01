FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack pnpm install --frozen-lockfile

FROM dependencies AS build
COPY tsconfig*.json vite.config.ts index.html ./
COPY src ./src
RUN corepack pnpm build

FROM node:24-bookworm-slim AS accounts
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack pnpm install --frozen-lockfile --prod
COPY server/accounts.mjs server/accountService.mjs ./server/
RUN mkdir -p /data && chown node:node /data
USER node
ENV VN_ACCOUNT_DATABASE_PATH=/data/accounts.sqlite3 VN_ACCOUNT_HOST=0.0.0.0 VN_ACCOUNT_PORT=3005
CMD ["node", "server/accountService.mjs"]

FROM caddy:2-alpine AS web
COPY --from=build /app/dist /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile
