FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/execution/package.json packages/execution/package.json
RUN npm ci
COPY packages/execution packages/execution
COPY apps/api apps/api
RUN npm run build -w @codeforge/execution && npm run build -w apps/api
RUN npm ci --omit=dev --workspace @codeforge/api --workspace @codeforge/execution --include-workspace-root=false

FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/execution/package.json ./packages/execution/package.json
COPY --from=build /app/packages/execution/dist ./packages/execution/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
USER node
EXPOSE 3001
CMD ["node", "apps/api/dist/server.js"]
