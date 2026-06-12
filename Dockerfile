# HousingChoice — single ARM64 image for both processes (app + worker).
# Built via `docker buildx build --platform linux/arm64` by scripts/deploy.mjs.
# docker-compose.yml overrides the command for the worker container.

# ---------- build stage ----------
FROM node:24-slim AS build
WORKDIR /srv/app

# Copy ALL workspace manifests first so dependency install is layer-cached.
# npm ci validates the lockfile against every workspace named in the root
# package.json, so dashboard/package.json must be present even though no
# dashboard code is built here.
COPY package.json package-lock.json ./
COPY app/package.json ./app/
COPY dashboard/package.json ./dashboard/
# App deps + the root devDependencies (typescript lives at the root); the
# dashboard workspace (react/vite) is not installed.
RUN npm ci --workspace app --include-workspace-root

# Copy app sources and tsconfigs, then compile.
COPY tsconfig.base.json ./
COPY app/tsconfig.json ./app/
COPY app/src ./app/src
RUN npm run build -w app

# ---------- runtime stage ----------
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /srv/app

# Production dependencies only (root has no prod deps; app's are hoisted here).
COPY package.json package-lock.json ./
COPY app/package.json ./app/
COPY dashboard/package.json ./dashboard/
RUN npm ci --workspace app --omit=dev && npm cache clean --force

# Compiled output from the build stage.
COPY --from=build /srv/app/app/dist ./dist

USER node
EXPOSE 8080
# Worker containers override this with ["node", "dist/worker.js"] via compose.
CMD ["node", "dist/index.js"]
