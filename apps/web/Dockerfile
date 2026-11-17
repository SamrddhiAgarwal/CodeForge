FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/execution/package.json packages/execution/package.json
RUN npm ci
COPY packages/execution packages/execution
COPY apps/web apps/web
RUN npm run build -w @codeforge/execution && npm run build -w apps/web

FROM caddy:2-alpine
COPY --from=build /app/apps/web/dist /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile
RUN mkdir -p /data/caddy /config/caddy && chown -R 10001:10001 /data /config
USER 10001:10001
EXPOSE 80 443
