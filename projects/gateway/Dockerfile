# Build context is the repository root:  docker build -f projects/gateway/Dockerfile .
# The image also carries the login page (projects/idpFront, built here with Vite) and serves it at / and /login.

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
COPY projects/gateway projects/gateway
COPY projects/idpFront projects/idpFront
RUN npm run build --prefix projects/sdk && npm run build --prefix projects/gateway && npx --prefix projects/idpFront vite build projects/idpFront

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
ENV PORT=3000
ENV GROUP_CONFIG=/secrets/group.json
ENV LOGIN_DIST=/app/ui
# `docker compose logs` is not a TTY, so the demo trace asks for colour explicitly.
ENV DEMO_LOG=1
ENV FORCE_COLOR=1

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/projects/sdk/package.json projects/sdk/
COPY --from=build /app/projects/sdk/dist projects/sdk/dist
COPY --from=build /app/projects/gateway/package.json projects/gateway/
COPY --from=build /app/projects/gateway/dist projects/gateway/dist
COPY --from=build /app/projects/idpFront/dist ui
# CREDITS_FILE lives here; a volume mounted over it keeps the image's ownership.
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 3000

# alpine has no curl; probe through the Node runtime.
HEALTHCHECK --interval=5s --timeout=3s --start-period=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "projects/gateway/dist/main.js"]
