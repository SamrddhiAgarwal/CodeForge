FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/execution/package.json packages/execution/package.json
RUN npm ci
COPY packages/execution packages/execution
COPY apps/worker apps/worker
RUN npm run build -w @codeforge/execution && npm run build -w apps/worker
RUN npm ci --omit=dev --workspace @codeforge/worker --workspace @codeforge/execution --include-workspace-root=false

FROM docker:29-cli AS docker-cli
FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/execution/package.json ./packages/execution/package.json
COPY --from=build /app/packages/execution/dist ./packages/execution/dist
COPY --from=build /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
USER node
CMD ["node", "apps/worker/dist/worker.js"]
