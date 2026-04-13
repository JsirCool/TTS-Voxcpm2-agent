# ============================================================
# TTS Agent Harness — Multi-stage Dockerfile
# Runs FastAPI (8100) + Next.js (3010) in one container
# ============================================================

# --- Stage 1: Build Next.js ---
FROM node:20-alpine AS web-builder
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --ignore-scripts
COPY web/ ./
ENV NEXT_PUBLIC_API_URL=http://localhost:8100
RUN npm run build

# --- Stage 2: Python runtime ---
FROM python:3.11-slim

# System deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg curl supervisor \
    && rm -rf /var/lib/apt/lists/*

# Node.js for Next.js standalone
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python deps
COPY server/pyproject.toml ./server/
RUN pip install --no-cache-dir -e ./server 2>/dev/null || pip install --no-cache-dir ./server

# Copy server code
COPY server/ ./server/

# Copy Next.js standalone build
COPY --from=web-builder /app/web/.next/standalone ./web-standalone/
COPY --from=web-builder /app/web/.next/static ./web-standalone/web/.next/static
COPY --from=web-builder /app/web/public ./web-standalone/web/public

# Supervisor config
COPY deploy/supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -f http://localhost:3010/ && curl -f http://localhost:8100/episodes || exit 1

EXPOSE 3010 8100

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
