# Build context is the repository root:  docker build -f projects/node/Dockerfile .
# The node depends on the workspace package projects/sdk, so both are built here.

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
COPY projects/sdk projects/sdk
COPY projects/node projects/node
RUN npm run build --prefix projects/sdk && npm run build --prefix projects/node

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
ENV NODE_CONFIG=/secrets/node.json
ENV PORT=4000
# `docker compose logs` is not a TTY, so the demo trace asks for colour explicitly.
ENV DEMO_LOG=1
ENV FORCE_COLOR=1

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/projects/sdk/package.json projects/sdk/
COPY --from=build /app/projects/sdk/dist projects/sdk/dist
COPY --from=build /app/projects/node/package.json projects/node/
COPY --from=build /app/projects/node/dist projects/node/dist

# The node only reads its config; mount the secrets directory read-only.
USER node

EXPOSE 4000

# alpine has no curl; probe through the Node runtime. The short interval matters because
# compose gates the gateway on `service_healthy`.
HEALTHCHECK --interval=5s --timeout=3s --start-period=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "projects/node/dist/main.js"]
