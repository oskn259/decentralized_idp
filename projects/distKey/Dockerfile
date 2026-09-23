# Build context is the repository root:  docker build -f projects/distKey/Dockerfile .
# One-shot command, not a server: no HEALTHCHECK. It runs as uid 1000, so the mounted
# output directory must be writable by that uid.

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
COPY projects/distKey projects/distKey
RUN npm run build --prefix projects/sdk && npm run build --prefix projects/distKey

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

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/projects/sdk/package.json projects/sdk/
COPY --from=build /app/projects/sdk/dist projects/sdk/dist
COPY --from=build /app/projects/distKey/package.json projects/distKey/
COPY --from=build /app/projects/distKey/dist projects/distKey/dist
USER node
ENTRYPOINT ["node", "projects/distKey/dist/main.js"]
CMD ["--help"]
