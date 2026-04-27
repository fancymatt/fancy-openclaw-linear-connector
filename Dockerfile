# --- Build stage ---
FROM node:22-alpine AS builder

# Native addon compilation dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# --- Runtime stage ---
FROM node:22-alpine

# better-sqlite3 runtime native deps (libc++, etc.)
RUN apk add --no-cache python3 make g++ libstdc++

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist/ dist/

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
