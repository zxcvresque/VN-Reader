FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack pnpm install --frozen-lockfile

FROM dependencies AS build
COPY tsconfig*.json vite.config.ts index.html ./
COPY src ./src
# The form pages share validation and conditional logic with the server.
COPY server/formLogic.mjs server/formLogic.d.mts server/indiaDistricts.mjs ./server/
COPY public ./public
RUN corepack pnpm build

FROM node:24-bookworm-slim AS accounts
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack pnpm install --frozen-lockfile --prod
COPY server/accounts.mjs server/accountService.mjs server/adminStore.mjs server/notifications.mjs server/operatorEvents.json \
     server/formLogic.mjs server/indiaDistricts.mjs server/formsStore.mjs server/formsRoutes.mjs server/formsBackup.mjs server/formsSeed.mjs \
     server/linkPreview.mjs server/seo.mjs ./server/
# The page shell, so form links can carry their own title, description and picture.
COPY --from=build /app/dist/index.html ./web/index.html
RUN chmod 755 /app /app/server /app/web \
 && chmod 644 /app/package.json /app/server/* /app/web/index.html \
 && mkdir -p /data && chown node:node /data
USER node
ENV VN_ACCOUNT_DATABASE_PATH=/data/accounts.sqlite3 VN_ACCOUNT_HOST=0.0.0.0 VN_ACCOUNT_PORT=3005
CMD ["node", "server/accountService.mjs"]

FROM caddy:2-alpine AS web
COPY --from=build /app/dist /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile
