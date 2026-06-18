# HousingChoice — single ARM64 image for both processes (app + worker).
# Built via `docker buildx build --platform linux/arm64` by scripts/deploy.mjs.
# docker-compose.yml overrides the command for the worker container.

# ---------- build stage ----------
FROM node:24-slim AS build
WORKDIR /srv/app

# Copy ALL workspace manifests first so dependency install is layer-cached.
# npm ci validates the lockfile against every workspace named in the root
# package.json.
COPY package.json package-lock.json ./
COPY app/package.json ./app/
COPY dashboard/package.json ./dashboard/
# App + dashboard deps + the root devDependencies (typescript lives at the
# root). The dashboard (react/vite) is built below and shipped as static
# files only — its node_modules never reach the runtime stage.
RUN npm ci --workspace app --workspace dashboard --include-workspace-root

# Copy app sources and tsconfigs, then compile.
COPY tsconfig.base.json ./
COPY app/tsconfig.json ./app/
COPY app/src ./app/src
RUN npm run build -w app

# Dashboard: vite-build the shell; the app serves dashboard/dist as static
# files with SPA index fallback (DASHBOARD_DIST_DIR below). (dashboard-legacy
# stays in the repo for local :5173 use but is no longer shipped.)
COPY dashboard/index.html dashboard/vite.config.ts dashboard/tsconfig.json ./dashboard/
COPY dashboard/src ./dashboard/src
RUN npm run build -w dashboard

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

# Built dashboard assets, served statically by the app (app/src/app.ts reads
# DASHBOARD_DIST_DIR; unset = no static serving, as in local dev).
COPY --from=build /srv/app/dashboard/dist ./public
ENV DASHBOARD_DIST_DIR=/srv/app/public

USER node
EXPOSE 8080
# Worker containers override this with ["node", "dist/worker.js"] via compose.
CMD ["node", "dist/index.js"]
