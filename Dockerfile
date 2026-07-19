# --- Backend build stage ---
FROM node:22-alpine AS builder

# Native addon compilation dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
COPY vendor/ vendor/

# Prebuild cache warmer: download better-sqlite3 prebuilt binary before npm ci
# so prebuild-install skips native compile. Arch-agnostic and non-fatal:
# if no prebuilt exists for this ABI/arch the build falls through to native
# compilation. See INF-46.
RUN VERSION=$(node -p "require('./package.json').dependencies['better-sqlite3'].replace(/^[\^~]/, '')") \
  && ABI=$(node -p "process.versions.modules") \
  && ARCH=$(case $(uname -m) in aarch64|arm64) echo arm64 ;; x86_64|amd64) echo x64 ;; *) echo unknown ;; esac) \
  && URL="https://github.com/WiseLibs/better-sqlite3/releases/download/v${VERSION}/better-sqlite3-v${VERSION}-node-v${ABI}-linuxmusl-${ARCH}.tar.gz" \
  && CACHE_FILE="$(node -p "require('crypto').createHash('sha512').update('${URL}').digest('hex').slice(0, 6)")"-$(echo "better-sqlite3-v${VERSION}-node-v${ABI}-linuxmusl-${ARCH}.tar.gz" | sed 's/[^a-zA-Z0-9.]/-/g') \
  && mkdir -p /root/.npm/_prebuilds \
  && curl -fsSL "${URL}" -o "/root/.npm/_prebuilds/${CACHE_FILE}" \
  || echo "Prebuild cache: no prebuilt for ABI ${ABI}/${ARCH}, will compile natively"

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

# Same prebuild cache warm for the runtime stage (each FROM gets its own
# layer — builder's cache is not inherited).
RUN VERSION=$(node -p "require('./package.json').dependencies['better-sqlite3'].replace(/^[\^~]/, '')") \
  && ABI=$(node -p "process.versions.modules") \
  && ARCH=$(case $(uname -m) in aarch64|arm64) echo arm64 ;; x86_64|amd64) echo x64 ;; *) echo unknown ;; esac) \
  && URL="https://github.com/WiseLibs/better-sqlite3/releases/download/v${VERSION}/better-sqlite3-v${VERSION}-node-v${ABI}-linuxmusl-${ARCH}.tar.gz" \
  && CACHE_FILE="$(node -p "require('crypto').createHash('sha512').update('${URL}').digest('hex').slice(0, 6)")"-$(echo "better-sqlite3-v${VERSION}-node-v${ABI}-linuxmusl-${ARCH}.tar.gz" | sed 's/[^a-zA-Z0-9.]/-/g') \
  && mkdir -p /root/.npm/_prebuilds \
  && curl -fsSL "${URL}" -o "/root/.npm/_prebuilds/${CACHE_FILE}" \
  || echo "Prebuild cache: no prebuilt for ABI ${ABI}/${ARCH}, will compile natively"

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
