<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-07-09).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.

# Outbound MMS - attach and send media everywhere staff send SMS

Date: 2026-07-08
Status: Approved design, ready for implementation
Branch: feat/outbound-mms (worktree w:/tmp/outbound-mms)
Author: Claude (brainstormed with Cameron)

NOTE ON TEXT: this spec and ALL new code, comments, UI copy, and docs written
for this feature must be plain ASCII (no em dashes, curly quotes, arrows, or
other non-ASCII characters) unless a hard requirement forces otherwise.

## 1. Problem

Staff can only send TEXT. Inbound MMS is fully built (authed fetch, SSRF
guards, 25MB cap, S3 mirror, timeline + gallery rendering), and the outbound
provider seam is ~wired for 1:1 (route validates mediaUrls -> service persists
and stamps type 'mms' -> Twilio driver passes mediaUrl), but:

1. No composer offers an attach control (the shared Timeline composer's
   contract is onSend(body) - body only).
2. No upload endpoint exists; the media bucket is fully private; the serve
   route is auth-only; presigning does not exist (no s3-request-presigner
   dependency). Twilio fetches MediaUrl from the public internet in prod, so
   nothing we store is reachable by it today.
3. Outbound media would be INVISIBLE even if sent: the timeline renders
   media_attachments ({s3Key, contentType}), which only the inbound mirror
   populates - the send path stores raw mediaUrls only.
4. The relay fan-out DROPS media in both directions: a team MMS into a group
   persists on the hub message but member legs go out body-only (an MMS-only
   send relays NOTHING - relayFanOut.ts guard "media relay is future work"),
   and a member's inbound MMS is mirrored to the hub but never forwarded to
   the other members.

Filed issue: docs/issues/outbound-mms-send-path.md (resolved by this work).

## 2. Decisions (Cameron, 2026-07-08)

1. Scope: the shared conversation composer surfaces (contact 1:1, tour page
   channels, relay group view) + FULL relay media in both directions.
   Broadcasts DEFERRED (file broadcast-mms; the broadcasts area also has
   in-flight work by another agent right now).
2. Media source v1: upload from device only. File follow-up issues for
   forwarding received media and attaching unit photos (unit.media are
   free-form EXTERNAL URLs - hotlink-fragile; document that caveat in the
   issue).
3. Twilio fetch mechanism: PRESIGNED S3 GET URLs (new dependency
   @aws-sdk/s3-request-presigner). Bucket stays fully private; no new public
   surface on the app.
4. PRESIGN PER ATTEMPT - the hard rule Cameron confirmed: presigned URLs are
   NEVER persisted or replayed. The durable truth is the s3Key in
   media_attachments; every send attempt (composer send, each relay fan-out
   leg, the retry route) presigns FRESH at that moment. Rationale: Twilio
   fetches media ONCE at message processing and caches on its side (carrier
   delivery retries never touch S3), but a RESEND is a new create call and a
   new fetch - a stored URL would be an expired token 24 hours later. The
   existing retry route replays stored mediaUrls verbatim (api.ts ~:734) and
   MUST change to re-presign from media_attachments.
5. TTL: 1 hour (generous margin over Twilio's fetch-at-processing window;
   still short-lived exposure).

## 3. Upload endpoint (new)

POST /api/media/uploads - authed (requireAuth), multipart/form-data with one
file field per request.

- Parser: a small streaming multipart dependency (busboy or equivalent);
  stream straight to the media bucket via the existing MediaStore.put
  (@aws-sdk/lib-storage Upload) - never buffer the whole file in memory.
- Key scheme: uploads/<uuid> (a NEW namespace, distinct from the inbound
  mirror's media/<conversationId>/<sid>/<i>). The uuid is server-generated.
- Validation: content type must pass the existing inline allowlist
  (lib/mediaTypes.ts: jpeg/png/gif/webp/pdf); size cap 5MB per file (the
  carrier MMS budget - deliberately tighter than the 25MB inbound mirror
  cap), enforced by aborting the stream past the limit; reject empty files.
- Response: { key, contentType, size }.
- Rate limit: per-user sliding window via the existing createUserRateLimit
  middleware, its own bucket, 30/min (mirrors the manual-send ceiling).
- IAM: already grants PutObject on the media bucket (verified) - NO infra
  change.
- Cleanup: uploads that never get attached to a send are orphans; v1 accepts
  this (they are private, small, capped). Note a future lifecycle rule as a
  line in the filed broadcast-mms... no - note it in the resolution of
  outbound-mms-send-path as a known accepted leftover, not a new issue.

## 4. Send contract

POST /api/conversations/:id/messages gains optional attachmentKeys: string[]
alongside the existing body/mediaUrls:

- Validation: array of strings, each matching ^uploads/[0-9a-f-]+$ (the
  client can never point the server at arbitrary bucket keys), max 10 keys;
  server HeadObjects each key (404 -> 400 unknown_attachment) and sums sizes
  <= 5MB total (carrier limit). Content types re-checked against the
  allowlist from HeadObject metadata.
- A send requires body OR attachmentKeys (or the legacy raw mediaUrls, which
  REMAINS as the internal/e2e seam - dashboard never uses it).
- Server flow: presign each key (GET, TTL 1h) -> adapter mediaUrls; persist
  media_attachments: [{s3Key, contentType}] on the message (closing gap #3 -
  sent media renders through the EXISTING authed serve endpoint + timeline
  attachment rendering with zero render-side changes); type stamps 'mms' as
  today.
- services/sendMessage.ts: accept an attachments param ({s3Key, contentType,
  presignedUrl}[] or equivalent shape chosen at implementation), pass
  presigned URLs to the adapter, persist media_attachments + mediaUrls (the
  presigned values in mediaUrls are historical record of what was sent; they
  are EXPECTED to expire and are never reused - comment this).
- Rate limit: rides the existing manual-send 30/min budget (same route).
- Logging: NEVER log presigned URLs (they are bearer tokens); log s3Key +
  count only.

## 5. Retry route (the re-presign rule)

POST /api/conversations/:id/messages/:providerSid/retry currently replays
original.mediaUrls verbatim. Change: when the message has media_attachments,
re-presign each s3Key fresh and send with those URLs (+ update the stored
mediaUrls to the new values); only fall back to replaying raw mediaUrls for
messages WITHOUT media_attachments (the e2e/raw seam). A retry 24 hours later
must work; a unit test pins that the retried send's URLs differ from the
originals and derive from the s3Keys.

## 6. Composer (one change, every conversation surface)

The shared Timeline composer (dashboard/src/routes/contact/Timeline.tsx):

- New attach control next to the existing controls: file input with
  accept="image/jpeg,image/png,image/gif,image/webp,application/pdf" and
  capture-friendly on mobile (accept="image/*" semantics for camera; final
  accept string chosen at implementation to allow both camera and PDF).
- Upload-on-select: each picked file immediately POSTs to /api/media/uploads;
  the composer shows a chip row (thumbnail for images where cheap, filename/
  size otherwise) with per-chip progress and a remove (x) control. Upload
  errors surface inline on the chip (retry by re-picking).
- Client-side pre-checks mirror the server: type allowlist, 5MB/file, max 10,
  total <= 5MB (the composer knows sizes from upload responses).
- Contract widening: onSend?: (body: string, attachmentKeys?: string[]) - all
  consumers updated: ContactDetail (both send sites incl. the
  ensureContactConversation path), TourConversation (GroupChannel,
  ContactThread, NewContactThread), ConversationDetail group view. Send
  enables when body is non-empty OR attachments exist.
- Optimistic bubble: shows the attachment chips/count immediately; the real
  attachment rendering appears when the server row lands (media_attachments
  via the authed serve endpoint - existing pipeline).
- Draft/channel safety: attachment chips are composer-local state and must
  follow the same keyed-remount rules as the text draft (the tour page keys
  ContactThread by conversationId precisely so drafts cannot leak across
  channels - attachments ride the same state).

## 7. Relay media - both directions

app/src/jobs/relayFanOut.ts:

- Team send into a group: the fan-out leg loop reads the HUB message's
  media_attachments and presigns each s3Key PER LEG at leg-send time (legs
  are token-bucket paced ~1/s and retryable - presigning once up front risks
  expiry on a long roster or retry; fresh TTL per attempt is the rule).
  adapter.sendMessage gains mediaUrls on the leg call.
- MMS-only sends: the "no body -> relay nothing" guard is REPLACED. Body for
  a media-only relayed message comes from a NEW message-catalog entry (per
  the message-catalog rule - no hard-coded copy):
    id: relay.media_only, class: operational, channel: sms, editable: true,
    vars: ['name'], default: "{name} sent an attachment."
  For a media message WITH text, the existing "Name: body" compose is
  unchanged and media rides along.
- Member inbound MMS forwarding: handleRelayInbound already mirrors inbound
  media to media/<conversationId>/<sid>/<i>; the fan-out legs for a member
  message now presign those mirrored keys and forward them to the other
  members (closing the "landlord sends a photo, tenant never sees it" hole).
  The twilio.ts "does NOT yet relay the media ON" comment comes out.
- The intro job stays text-only. delivery_recipients semantics unchanged.

## 8. Fake-twilio fidelity

- fake-twilio/src/routes/rest.ts reads a SINGLE MediaUrl string today; the
  Twilio SDK sends repeated MediaUrl params for multi-attachment (parsed as
  an array). Normalize string | string[] so multi-attachment sends record
  faithfully.
- The fake NEVER fetches outbound media (verified) - presigned MinIO URLs
  just need to be valid URLs. The fake-phones UI renders unknown-extension
  URLs as an attachment link (acceptable for dev; no change required).
- Local dev: MediaStore's MinIO config (endpoint + fixed creds) must work
  with the presigner (path-style addressing). Phase 0 verifies this early -
  it is the one local-parity risk.

## 9. Limits, compliance, security

- New encoded constants: OUTBOUND_MMS_MAX_MEDIA = 10,
  OUTBOUND_MMS_MAX_FILE_BYTES = 5MB, OUTBOUND_MMS_MAX_TOTAL_BYTES = 5MB
  (carrier reality; the 25MB inbound mirror cap is unrelated and unchanged).
- Types: the existing inline allowlist (jpeg/png/gif/webp/pdf). PDF delivery
  is carrier-flaky in the wild; allowed but not guaranteed - one line in the
  composer helper text is NOT needed (keep UI quiet); document in the spec
  only.
- A2P: MMS rides the existing informational campaign; no compliance-copy
  changes; relay.media_only is operational catalog copy (no opt-out floor -
  relay is consent-exempt per the compliance model).
- Security: client supplies only uploads/-namespaced keys minted by our own
  upload endpoint (regex-validated) - the client can never make Twilio fetch
  an arbitrary URL through us, and never presign arbitrary bucket keys. The
  authed serve endpoint and private bucket posture are unchanged. Presigned
  URLs are bearer tokens: 1h TTL, never logged, never persisted as the
  source of truth.
- Kill switch: smsSendingEnabled refusal paths unchanged (service + adapter
  already refuse).

## 10. Data plumbing summary (what changes where)

- app/src/routes/api.ts: send route attachmentKeys validation + presign +
  media_attachments persist; retry route re-presign; upload router mount.
- app/src/routes/mediaUploads.ts (new): the multipart upload endpoint.
- app/src/adapters/mediaStore.ts: add a presign(key, ttl) method (the ONLY
  s3 surface; keeps s3-request-presigner imports in one module).
- app/src/services/sendMessage.ts: attachments param; persist
  media_attachments; comment the expired-URLs-are-history rule.
- app/src/jobs/relayFanOut.ts: leg media presign + media-only body via
  catalog; app/src/messages/catalog.ts: relay.media_only entry.
- app/src/routes/webhooks/twilio.ts: comment removal (member-forwarding now
  real; behavior itself lives in relayFanOut).
- dashboard: Timeline composer attach UI + widened onSend; five consumer
  call sites; api/endpoints.ts uploadMedia() + sendMessage attachmentKeys;
  api/types.ts wire types.
- fake-twilio/src/routes/rest.ts: MediaUrl array normalize.
- Dependencies: @aws-sdk/s3-request-presigner, busboy (+ @types/busboy).
  Merge note: npm install required.
- NO schema/table/GSI changes. NO terraform (IAM PutObject already granted).

## 11. Issues to file / resolve in this branch

File:
- mms-forward-received-media (improvement, low): re-send media already in a
  contact's gallery (privacy design needed - ID photos live there).
- mms-attach-unit-photos (improvement, low): attach unit photos; CAVEAT
  unit.media are free-form external URLs (hotlink fragility, no size
  guarantee) - needs a mirror-to-our-bucket step or acceptance of flakiness.
- broadcast-mms (improvement, med): per-recipient media on broadcasts (job,
  template model, composer preview, cost/throughput implications); deferred
  partly to avoid colliding with in-flight broadcasts work.
Resolve (dated notes):
- outbound-mms-send-path (this feature; note the accepted orphan-uploads
  leftover and the deferred broadcast scope).

## 12. Testing

- app unit: upload validation (type/size/empty/stream-abort); send-route
  attachmentKeys validation (regex, count, HeadObject 404, total size);
  media_attachments persisted on send; adapter receives presigned URLs
  (assert X-Amz-Signature-style query present); RETRY RE-PRESIGNS (retried
  URLs differ from originals and derive from s3Keys - the Cameron rule,
  pinned); relay legs carry media per attempt; media-only relay uses the
  relay.media_only catalog body (and catalog.test invariants cover the new
  entry); member-inbound forwarding legs presign mirrored keys; presigned
  URLs never logged (log-capture assertion on the send path).
- dashboard unit: attach chips (add/remove/progress/error), client-side
  caps, onSend carries keys, send-enable logic (body OR attachments),
  optimistic bubble, keyed-remount attachment-draft isolation on the tour
  channels.
- fake-twilio unit: MediaUrl string|string[] normalization.
- e2e (extend scenarios): 1:1 attach+send from the contact page via the REAL
  file input (Playwright setInputFiles with a small fixture image) ->
  assert the fake outbox/thread records the media URL AND the timeline
  renders the sent attachment (authed serve); group MMS -> both member fake
  threads receive legs with media; member sends a photo to the pool ->
  the OTHER member's fake thread gets the forwarded media; MMS-only group
  send delivers with the catalog body. Mobile: composer attach control
  usable at 360px (no horizontal scroll).
- Local-parity check in Phase 0/2.5: MinIO presign generates a URL and a
  plain fetch of it succeeds inside the hermetic stack.
- ASCII sweep over every new/added file.

## 13. Risks

- MinIO presigner compatibility (path-style addressing, fixed creds) - the
  one local-parity unknown; verify FIRST in Phase 0 with a spike script.
- Multipart parsing on Express 5 (busboy is framework-agnostic; avoid
  multer unless verified Express-5-safe).
- The shared composer touches EVERY conversation surface - regression risk
  concentrated in Timeline.tsx; the keyed-remount draft rules must extend to
  attachment state (tour channel switch must not leak chips across tabs).
- Presign TTL vs long fan-outs/retries: mitigated by presign-per-attempt
  (the design rule); never presign a batch up front.
- Another agent's in-flight broadcasts work: this feature must not touch
  broadcast files at all.
- Twilio caches sent media on its infrastructure (same as inbound, in
  reverse) - accepted; noted for the privacy picture.
