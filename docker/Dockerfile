# syntax=docker/dockerfile:1
# Unified FeedEater build. Select the image with --target api|worker|web
# (dev compose uses `target:`; CI builds with docker/build-push-action).

# ---- deps: install from the lockfile --------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/module-sdk/package.json packages/module-sdk/
COPY modules/example/package.json modules/example/
COPY modules/slack/package.json modules/slack/
COPY modules/system/package.json modules/system/
RUN npm ci

# ---- build: shared workspace compilation -----------------------------------
FROM deps AS build
COPY . .
RUN npm run -w @feedeater/core build \
 && npm run -w @feedeater/module-sdk build \
 && npm run -w @feedeater/db generate \
 && npm run -w @feedeater/db build

# ---- per-app build variants (mirror the original per-image builds) ----------
FROM build AS build-api
RUN npm run -w @feedeater/module-example build \
 && npm run -w @feedeater/module-slack build \
 && npm run -w @feedeater/api build

FROM build AS build-worker
RUN npm run -w @feedeater/module-example build \
 && npm run -w @feedeater/module-slack build \
 && npm run -w @feedeater/module-system build \
 && npm run -w @feedeater/worker build

FROM build AS build-web
RUN npm run -w @feedeater/web build

# ---- final images ------------------------------------------------------------
FROM node:20-alpine AS api
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build-api /app/package.json ./package.json
COPY --from=build-api /app/node_modules ./node_modules
COPY --from=build-api /app/packages/core/package.json ./packages/core/package.json
COPY --from=build-api /app/packages/core/dist ./packages/core/dist
COPY --from=build-api /app/packages/db/package.json ./packages/db/package.json
COPY --from=build-api /app/packages/db/dist ./packages/db/dist
COPY --from=build-api /app/packages/db/prisma ./packages/db/prisma
COPY --from=build-api /app/modules ./modules
COPY --from=build-api /app/apps/api/package.json ./apps/api/package.json
COPY --from=build-api /app/apps/api/dist ./apps/api/dist
EXPOSE 4000
WORKDIR /app/apps/api
CMD ["node", "dist/index.js"]

FROM node:20-alpine AS worker
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build-worker /app/node_modules ./node_modules
COPY --from=build-worker /app/packages/core/package.json ./packages/core/package.json
COPY --from=build-worker /app/packages/core/dist ./packages/core/dist
COPY --from=build-worker /app/packages/db/package.json ./packages/db/package.json
COPY --from=build-worker /app/packages/db/dist ./packages/db/dist
COPY --from=build-worker /app/modules ./modules
COPY --from=build-worker /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=build-worker /app/apps/worker/dist ./apps/worker/dist
WORKDIR /app/apps/worker
CMD ["node", "dist/index.js"]

FROM node:20-alpine AS web
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build-web /app/node_modules ./node_modules
COPY --from=build-web /app/apps/web/.next ./apps/web/.next
COPY --from=build-web /app/apps/web/public ./apps/web/public
COPY --from=build-web /app/apps/web/package.json ./apps/web/package.json
COPY --from=build-web /app/apps/web/next.config.js ./apps/web/next.config.js
EXPOSE 3000
WORKDIR /app/apps/web
CMD ["npm", "run", "start"]
