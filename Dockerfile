# --- Backend build stage ---
FROM node:22-alpine AS builder

# Native addon compilation dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
COPY vendor/ vendor/
RUN npm ci

COPY tsconfig.json ./
# `npm run build` fires the prebuild guards (scripts/guard-*.js|mjs); without
# scripts/ the build dies on MODULE_NOT_FOUND before tsc runs.
COPY scripts/ scripts/
COPY src/ src/
RUN npm run build

# --- Web SPA build stage ---
FROM node:22-alpine AS web-builder

WORKDIR /app

# Install ALL deps (including devDeps for TypeScript types)
COPY web/package.json web/package-lock.json ./web/
RUN npm install --prefix web

COPY web/tsconfig.json web/vite.config.ts ./web/
COPY web/src/ ./web/src/
COPY web/index.html ./web/
RUN npm run build --prefix web

# --- Runtime stage ---
FROM node:22-alpine

# better-sqlite3 runtime native deps (libc++, etc.)
RUN apk add --no-cache python3 make g++ libstdc++

WORKDIR /app

COPY package.json package-lock.json ./
COPY vendor/ vendor/
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist/ dist/
COPY --from=web-builder /app/web/dist/ web/dist/

# Create non-root user and ensure data dir exists
RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
  && mkdir -p /data /secrets /config \
  && chown appuser:appgroup /data /secrets /config

USER appuser

ENV DATA_DIR=/data
ENV SECRETS_DIR=/secrets
ENV AGENTS_FILE=/config/agents.json
ENV PORT=3000

EXPOSE ${PORT}

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3000}/health || exit 1

ENTRYPOINT ["node", "dist/index.js"]
