# Build context is the repository root:  docker build -f projects/rp/Dockerfile .
# The relying party uses only public OAuth client libraries; no workspace package is needed.

# ---- build: TypeScript -> dist/ ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY projects/sdk/package.json projects/sdk/
COPY projects/protocol/package.json projects/protocol/
COPY projects/node/package.json projects/node/
COPY projects/distKey/package.json projects/distKey/
COPY projects/gateway/package.json projects/gateway/
COPY projects/idpFront/package.json projects/idpFront/
COPY projects/rp/package.json projects/rp/
RUN npm ci
COPY projects/rp projects/rp
RUN npm run build --prefix projects/rp

# ---- deps: production dependencies only ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY projects/sdk/package.json projects/sdk/
COPY projects/protocol/package.json projects/protocol/
COPY projects/node/package.json projects/node/
COPY projects/distKey/package.json projects/distKey/
COPY projects/gateway/package.json projects/gateway/
COPY projects/idpFront/package.json projects/idpFront/
COPY projects/rp/package.json projects/rp/
RUN npm ci --omit=dev

# ---- runtime ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/projects/rp/package.json projects/rp/
COPY --from=build /app/projects/rp/dist projects/rp/dist

USER node
EXPOSE 3001

# alpine has no curl; probe through the Node runtime.
HEALTHCHECK --interval=5s --timeout=3s --start-period=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3001) + '/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "projects/rp/dist/main.js"]
