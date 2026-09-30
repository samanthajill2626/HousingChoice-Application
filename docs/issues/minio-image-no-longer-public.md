---
id: minio-image-no-longer-public
title: The local S3 container's image (minio/minio) can no longer be pulled anonymously, so a fresh machine cannot start the e2e stack or npm run dev --local
type: bug
severity: high
status: open
area: tooling/local-dev
created: 2026-09-30
refs: scripts/s3.mjs:106, scripts/e2e-session.mjs:716, scripts/dev.mjs:301, app/scripts/s3-create.ts, app/scripts/seed-smoke.mjs:64, e2e/README.md
---

**Problem.** `npm run s3:start` creates the `hc-s3-local` container with a
bare `docker run ... minio/minio server /data` (`scripts/s3.mjs:106`), which
means `minio/minio:latest` from Docker Hub. That image is no longer publicly
available. Observed 2026-09-30 on Cameron's new PC (Docker 29.8.1):

- `docker manifest inspect minio/minio:latest` -> `denied: requested access
  to the resource is denied` / `unauthorized: authentication required`.
- `https://hub.docker.com/v2/repositories/minio/minio/` -> HTTP 404.
- The other published location, `quay.io/minio/minio:latest`, answers
  `no such manifest`, and the quay tag API requires authentication.

A `docker login` does not help: the repository is gone from public view, so a
free account is refused the same way. Machines that pulled the image before
it disappeared keep working from their local cache, which is why nobody saw
this until the PC migration.

Blast radius: `npm run e2e` (gate 4) and `npm run e2e:session` both call
`ensureS3Started()` (`scripts/e2e-session.mjs:716`), and so does the local
dev loop (`scripts/dev.mjs:301`). On a machine without the cached image,
gate 4 cannot run at all. `npm test` does not need the container.

**Workaround (no code change).** Copy the cached image from a machine that
still has it. On that machine: `docker save minio/minio:latest -o
W:\tmp\minio-image.tar`; on the new one: `docker load -i
W:\tmp\minio-image.tar`, then `npm run s3:start`. This only works while some
machine still holds a copy.

**Suggested fix.** Point `scripts/s3.mjs` at an S3-compatible image that is
publicly pullable and PINNED to a tag or digest (not `latest`), so the next
disappearance is a visible, dated change instead of a silent breakage.
Candidates to evaluate: a maintained community rebuild of MinIO, or another
local S3 stand-in. Whatever replaces it must still satisfy:

- the same env-driven root credentials (`MINIO_ROOT_USER` /
  `MINIO_ROOT_PASSWORD` in `scripts/s3.mjs`) or an equivalent the launchers
  can pass;
- path-style S3 on `:9000` with SigV4 (`app/scripts/seed-smoke.mjs` HEADs
  objects with the AWS SDK);
- bucket creation via `app/scripts/s3-create.ts`, and the health wait in
  `scripts/s3.mjs` (today it polls MinIO's `/minio/health/live`);
- streamed uploads and CopyObject as the media code uses them.

Prove it with a full `npm run e2e` on a machine that has never held the old
image, update the MinIO mentions in `e2e/README.md` and any setup notes, and
record the choice (license, and why this image) in this file's resolution.
