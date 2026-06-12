# HousingChoice — single ARM64 image for both processes (app + worker).
# Built via `docker buildx build --platform linux/arm64` by the deploy script in M0.5.
# docker-compose.yml overrides the command for the worker container.

# ---------- build stage ----------
FROM node:24-slim AS build
WORKDIR /srv/app

# Copy manifests first so dependency install is layer-cached.
# Note: package-lock.json is generated on the first `npm install` and committed;
# the `*` glob keeps this copy from failing before that happens.
COPY package.json package-lock.json* ./
COPY app/package.json ./app/
RUN npm ci --workspace app

# Copy app sources and tsconfigs, then compile.
COPY tsconfig.base.json ./
COPY app/tsconfig.json ./app/
COPY app/src ./app/src
RUN npm run build -w app

# ---------- runtime stage ----------
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /srv/app

# Production dependencies only.
COPY package.json package-lock.json* ./
COPY app/package.json ./app/
RUN npm ci --workspace app --omit=dev

# Compiled output from the build stage.
COPY --from=build /srv/app/app/dist ./dist

USER node
EXPOSE 8080
# Worker containers override this with ["node", "dist/worker.js"] via compose.
CMD ["node", "dist/index.js"]
