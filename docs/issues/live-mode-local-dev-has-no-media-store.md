---
id: live-mode-local-dev-has-no-media-store
title: Live-mode local dev (npm run dev) has no media store - photo/MMS upload 503s locally against the real dev backend
type: improvement
severity: med
status: open
area: app
created: 2026-07-21
refs: scripts/dev.mjs, app/src/routes/units.ts, app/src/routes/mmsMedia.ts
---

**Problem.** `npm run dev` (live mode: local app + worker against the real
hc-dev DynamoDB backend) never gets a `MEDIA_BUCKET`: it is a
terraform/deploy-managed Parameter Store key, deliberately absent from
`.env.dev`, and dev.mjs only auto-wires the MinIO store (`hc-local-media` +
`MEDIA_S3_ENDPOINT`) when `mode === 'local'`. So in live mode
`createMediaStore` returns undefined and every media surface degrades: unit
photo presign/confirm and MMS attachment presign answer 503 ("Photo storage
isn't available right now"), photo display resolves url-absent, inbound MMS
mirroring is skipped. Hit by Cameron 2026-07-21 testing photo upload on the
:5174 live stack. All prior unit-photos live QA ran in hermetic/e2e stacks, so
the gap was never visible.

**Suggested fix.** Decide the live-mode media posture, then wire it:

- Mirror-true option: live mode targets the REAL dev media bucket
  (`MEDIA_BUCKET=hc-dev-media-<acct>`, no endpoint override; the housingchoice
  AWS profile signs presigns). Server-side ops and `<img>` presigned-GET
  display work as-is; the browser's direct presigned-POST upload additionally
  needs `http://localhost:5174` added to the dev `s3_media` CORS
  `dashboard_origins` (small dev-only terraform + apply). Photos uploaded
  locally then really exist for deployed dev and vice versa - consistent with
  live mode's "true mirror" philosophy.
- NOT recommended: pointing live mode at local MinIO - it writes keys into
  REAL dev DynamoDB that the deployed stack can never resolve (splits the
  photo universe).

Until then the workaround is the hermetic stack (`npm run dev -- --local
--mock --seeded`), where MinIO is auto-wired. Consider folding the decision
into the photos-via-CloudFront design (it reshapes the read path and leaves
CORS upload-only anyway).
