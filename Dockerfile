# HousingChoice — single ARM64 image for both processes (app + worker).
# Built via `docker buildx build --platform linux/arm64` by scripts/deploy.mjs.
# docker-compose.yml overrides the command for the worker container.

# ---------- build stage ----------
# --platform=$BUILDPLATFORM: run this stage NATIVE on the building machine
# (amd64 on the dev PC) instead of under QEMU ARM emulation — its outputs
# (tsc JS + vite static files) are arch-neutral, and the emulated build was
# the dominant cost of every deploy. Only the runtime stage is arm64.
FROM --platform=$BUILDPLATFORM node:24-slim AS build
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
# files with SPA index fallback (DASHBOARD_DIST_DIR below).
COPY dashboard/index.html dashboard/vite.config.ts dashboard/tsconfig.json ./dashboard/
COPY dashboard/src ./dashboard/src
# publicDir owns the service worker, badge, and both static icon destination
# families. The manifest is runtime-owned by /app-identity. Vite copies public/
# to the dist root, so it must be in the context before the build. Missing it
# silently drops the worker and icons. Keep in step with .dockerignore.
COPY dashboard/public ./dashboard/public
RUN npm run build -w dashboard
# Fail the BUILD if the PWA assets did not land, rather than discovering it on a
# phone. A local `npm run build` cannot catch this - it has the real public/.
RUN test -f dashboard/dist/sw.js \
  && test -f dashboard/dist/icons/icon-192.png \
  && test -f dashboard/dist/icons/icon-512.png \
  && test -f dashboard/dist/icons/icon-maskable-512.png \
  && test -f dashboard/dist/icons/icon-nonprod-192.png \
  && test -f dashboard/dist/icons/icon-nonprod-512.png \
  && test -f dashboard/dist/icons/icon-nonprod-maskable-512.png

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
