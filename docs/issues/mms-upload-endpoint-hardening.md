---
id: mms-upload-endpoint-hardening
title: "MMS upload endpoint hardening: early-abort over-size requests, skip zero-byte puts, abort removed-chip uploads"
type: improvement
severity: low
status: open
area: app
created: 2026-07-09
refs: app/src/routes/mediaUploads.ts:139, app/src/routes/mediaUploads.ts:133, dashboard/src/routes/contact/Timeline.tsx:646
---

**Problem (review findings, 2026-07-09 - all bounded, none blocking).** Three
rough edges on the new outbound-MMS upload path:

1. Over-size uploads read the ENTIRE request body before answering 413: on
   busboy 'limit' the handler destroys its own stream and drains, but never
   req.destroy()s early - storage is bounded (busboy stops past 5MB) but a
   session can force large ingress reads (30/min x arbitrarily large bodies)
   on the single instance. Trade-off was a clean 413 vs early reset; an early
   abort after flushing the response is preferable.
2. A zero-byte file still runs MediaStore.put to completion (committing an
   empty uploads/<uuid> object) before finish() rejects with empty_file - an
   orphan per attempt. The empty-file test asserts the 400 but not zero puts.
3. Removing a composer chip mid-upload does not abort the in-flight fetch -
   the finished object becomes an orphan in uploads/ (no AbortController
   wired).

All three fall under (or adjacent to) the accepted orphan-uploads leftover
noted in the outbound-mms-send-path resolution; this issue exists so the
hardening is tracked rather than folklore.

**Suggested fix.** (1) After writing the 413, destroy the request socket.
(2) Defer starting the put until the first byte arrives, or delete the object
when finish() rejects. (3) Wire an AbortController from chip-remove to the
upload fetch. A periodic uploads/ lifecycle sweep (S3 lifecycle rule on the
prefix) would subsume the orphan cases wholesale.
