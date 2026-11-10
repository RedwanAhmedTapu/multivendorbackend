# ── Multivendorbackend — production Dockerfile ──────────────────────────
#
# NOTE ON WHY THIS RUNS .ts FILES DIRECTLY:
# tsconfig.json has "noEmit": true and imports use .ts extensions
# (allowImportingTsExtensions). That means `tsc` never produces a dist/
# folder — the project was never actually wired to compile to plain JS,
# despite package.json's old "start": "node dist/index.js". Rather than
# silently failing in production, this image runs the TypeScript source
# directly with `tsx` (fast esbuild-based TS runtime), which understands
# ESM + .ts import extensions natively. If you later fix the build to emit
# real JS, swap the final CMD back to `node dist/server.js`.

# ---------- Stage 1: install dependencies ----------
FROM node:20-alpine AS deps
WORKDIR /app

# Needed for bcrypt/sharp native builds on alpine
RUN apk add --no-cache python3 make g++ vips-dev

COPY package.json package-lock.json ./
RUN npm ci

# ---------- Stage 2: generate Prisma client ----------
FROM deps AS prisma-generate
WORKDIR /app
COPY prisma ./prisma
RUN npx prisma generate

# ---------- Stage 3: runtime image ----------
FROM node:20-alpine AS runner
WORKDIR /app

RUN apk add --no-cache vips \
    && addgroup -S nodejs && adduser -S nodejs -G nodejs

ENV NODE_ENV=production

COPY --from=prisma-generate /app/node_modules ./node_modules
COPY --from=prisma-generate /app/prisma ./prisma
COPY package.json ./
COPY tsconfig.json ./
COPY src ./src

# Runtime writes to /app/uploads — make sure it exists and is writable by
# the non-root user before dropping privileges.
RUN mkdir -p uploads && chown -R nodejs:nodejs /app

USER nodejs

EXPOSE 5000

# Basic container-level healthcheck against the root route in server.ts.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-5000}/ || exit 1

CMD ["npx", "tsx", "src/server.ts"]
