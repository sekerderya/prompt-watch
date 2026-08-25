# Production image for apps/web.
#
# The dev image (Dockerfile.dev) bind-mounts the repo and runs `next dev`, which
# is fine for the Quickstart but is not something to put on a network. This
# builds a real production bundle instead, and runs it as a non-root user.

# ---------- deps: resolve workspace dependencies from the lockfile ----------
FROM node:20-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/
COPY packages/sdk/package.json ./packages/sdk/
COPY examples/basic-node-app/package.json ./examples/basic-node-app/

RUN npm ci

# ---------- builder: compile the SDK and the Next.js app ----------
FROM node:20-alpine AS builder
WORKDIR /app

# Brings node_modules (root and any nested workspace ones) across in one step,
# so this does not depend on how npm chose to hoist.
COPY --from=deps /app ./
# node_modules is excluded by .dockerignore, so this adds sources without
# clobbering what was just installed.
COPY . .

# Prisma's generated client must exist before `next build` typechecks the routes.
RUN npx prisma generate --schema=apps/web/prisma/schema.prisma
RUN npm run build --workspace=packages/sdk
RUN npm run build --workspace=apps/web

# Drop dev dependencies now that everything is compiled.
RUN npm prune --omit=dev --workspaces --include-workspace-root

# ---------- runner: the shipped image ----------
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app ./

USER nextjs
EXPOSE 3000

# Hits the endpoint that actually touches the database, so an image with a
# broken connection reports unhealthy instead of merely "process is alive".
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/apps/web
# Schema changes are applied before the server accepts traffic.
CMD ["sh", "-c", "npx prisma migrate deploy --schema=./prisma/schema.prisma && npm run start"]
