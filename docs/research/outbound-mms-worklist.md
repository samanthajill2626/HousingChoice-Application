# Outbound MMS - Phase 0 research + spike worklist

Read-only mapping against the current tree on `feat/outbound-mms`
(worktree `w:/tmp/outbound-mms`). Authoritative design:
`docs/superpowers/specs/2026-07-08-outbound-mms-design.md`. All line numbers
below are CURRENT file:line at time of research.

================================================================
## SPIKE VERDICT (the gate) - PASS
================================================================

MinIO presign + plain `fetch()` WORKS in the hermetic local stack. Proven with
a throwaway script (now deleted) that used the SAME S3 client construction
`createMediaStore` uses for local MinIO:

- `MediaStore.put`-equivalent (`@aws-sdk/lib-storage` `Upload`) of a tiny object
  to `uploads/<uuid>`, then `getSignedUrl` (GET, TTL 3600), then a plain
  `fetch()` of that URL.
- Result: **HTTP 200, bytes matched exactly, Content-Type (`image/png`)
  preserved.**

**Exact config required** (all present in `createMediaStore` already - reuse it
verbatim; do NOT construct a second client):
- `endpoint: config.mediaS3Endpoint` (local: `http://localhost:9000`)
- `forcePathStyle: true`  (REQUIRED - MinIO is path-style; virtual-host
  addressing would break)
- `region: config.awsRegion` (`us-east-1`) - must match; the SigV4 credential
  scope in the presigned URL embeds it.
- `credentials: { accessKeyId: 'local', secretAccessKey: 'locallocal' }`
  (the exported `LOCAL_S3_ACCESS_KEY` / `LOCAL_S3_SECRET_KEY`). MinIO VALIDATES
  creds, so they must match the container root user/pass (they do).

**Implementer notes for `mediaStore.presign()`:**
- `presign(key, ttl)` MUST use `this.client` (the same S3Client the store was
  built with) so the endpoint/forcePathStyle/creds/region are inherited - if you
  build a fresh client you can reintroduce the virtual-host/region mismatch.
- The generated URL contains `X-Amz-Signature`, `X-Amz-Credential`,
  `X-Amz-Date`, `X-Amz-Expires`, `X-Amz-SignedHeaders=host`. It also carries
  `x-amz-checksum-mode=ENABLED` / `X-Amz-Content-Sha256=UNSIGNED-PAYLOAD` from
  the SDK default middleware - harmless (fetch succeeded with them present).
- The presigner signs `host` only, so a plain browser/`fetch` GET (no extra
  headers) verifies cleanly. Do not add headers to the GET.
- Prod parity: with no `mediaS3Endpoint`, the client is real AWS S3 +
  instance-role creds; `getSignedUrl` against that path is standard and needs no
  special handling. The local path is the only parity risk and it PASSED.
- Gotcha (Windows/dev only, not a feature concern): a Node script that calls
  `process.exit()` right after an SDK/http op can emit a benign libuv
  `Assertion failed ... UV_HANDLE_CLOSING` on teardown. Not an S3 error; the
  assertions all passed before it. Avoid abrupt `process.exit` in any spike/test
  harness or just ignore the teardown line.

Env facts confirmed: local bucket = `hc-local-media`; endpoint injected by
`scripts/dev.mjs:143` and `scripts/e2e-session.mjs:106-107`; MinIO launched by
`scripts/s3.mjs` (`http://localhost:9000`, console `:9001`). Dep
`@aws-sdk/s3-request-presigner` installed for the spike (leave installed; do NOT
commit - it is a real feature dep the build adds anyway).

================================================================
## FILE-LEVEL WORKLIST
================================================================

### app/src/adapters/mediaStore.ts  (add presign - the ONLY s3 surface)
- `MediaStore` interface: `app/src/adapters/mediaStore.ts:19-31`
  (`put` at :21, `getStream` at :30). Add `presign(key: string, ttlSeconds:
  number): Promise<string>` here.
- `S3MediaStore` class :33-80; `put` impl :39-50 (streams via `Upload`);
  implement `presign` on this class using `getSignedUrl(this.client, new
  GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: ttlSeconds })`.
- Client construction (reuse, do not duplicate): `createMediaStore`
  :105-129; the local-endpoint branch (`forcePathStyle`, fixed creds, region)
  :116-127. `LOCAL_S3_ACCESS_KEY`/`LOCAL_S3_SECRET_KEY` :95-96.
- Bucket + config source: `config.mediaBucket` (`MEDIA_BUCKET`), guard returns
  undefined when unset (:107). Config fields: `app/src/lib/config.ts` -
  `mediaBucket` :150, `mediaS3Endpoint` :157, `awsRegion` :660, prod-guard on
  endpoint :364-368.
- Import `getSignedUrl` from `@aws-sdk/s3-request-presigner` HERE only (adapter
  rule - keep the presigner import in this one module, per spec Sec 10).

### app/src/routes/mediaUploads.ts  (NEW - the multipart upload endpoint)
- `POST /api/media/uploads`, `requireAuth`, multipart/form-data one file field.
- Stream to `mediaStore.put('uploads/<uuid>', stream, contentType)`; key
  namespace `uploads/<uuid>` (distinct from inbound mirror
  `media/<conversationId>/<sid>/<i>`).
- Validate type against `isInlineMediaType` (see mediaTypes below); 5MB/file
  cap by aborting the stream; reject empty. Response `{ key, contentType, size }`.
- Rate limit: own `createUserRateLimit` bucket, `routeKey: 'media_upload'`,
  30/min (see pattern below). Mount router in api.ts.
- Multipart parser: busboy (spec Sec 3/13 - avoid multer on Express 5). Add
  `busboy` + `@types/busboy` deps.

### app/src/routes/api.ts  (send route + retry route + upload mount)
- Router deps already hold a `mediaStore`: `createMediaStore` at :302, field
  `mediaStore?` :146, `mediaAttachmentsOf` imported :42, `createMediaStore`
  imported :15, `createUserRateLimit` imported :33.
- **Send route** `POST /conversations/:conversationId/messages`:
  - handler `router.post(...)` :649, behind `manualSendLimiter`.
  - body/mediaUrls validation :654-666 (`payload.body` :656; `mediaUrls`
    array-of-string check :657-662; "body OR mediaUrls required" 400 :663-665).
    ADD `attachmentKeys` parse/validate here (regex `^uploads/[0-9a-f-]+$`, max
    10; HeadObject each -> 400 `unknown_attachment`; sum <=5MB; re-check type
    from HeadObject metadata).
  - relay branch :671-675 (`conversation?.type === 'relay_group'` ->
    `sendRelayTeamMessage`); 1:1 `sendMessage({...})` :677-684. Thread
    presigned URLs + `attachmentKeys`/attachments into both.
- **Retry route** `POST /conversations/:conversationId/messages/:providerSid/retry`:
  - handler :706, behind the SAME `manualSendLimiter`.
  - THE LINE TO CHANGE (spec Sec 5, "presign per attempt"): :734
    ```
    ...(original.mediaUrls !== undefined && { mediaUrls: original.mediaUrls }),
    ```
    This replays stored `mediaUrls` verbatim today. Change to: when
    `mediaAttachmentsOf(original)` is non-empty, re-presign each `s3Key` FRESH
    and send those (and update stored mediaUrls); fall back to raw
    `original.mediaUrls` only when there are NO media_attachments (the e2e/raw
    seam). Original read at :713 (`messages.getByProviderSid`).
- **sendRelayTeamMessage** (team send into a group) :759-824: persists source
  once (append :798-810, type-stamp `mms` :802, `mediaUrls` persisted :809),
  enqueues `RELAY_FANOUT_JOB` :815-820. This is where a TEAM MMS's
  media_attachments must be persisted on the hub message so the fan-out can
  re-presign per leg.
- **Serve endpoint (render pipeline - NO changes needed)**:
  `GET /api/messages/:providerSid/media/:idx` :1018-1049 reads
  `mediaAttachmentsOf(message)[idx].s3Key` (:1033-1034) and streams via
  `mediaStore.getStream`. Sent media renders through THIS existing endpoint once
  `media_attachments` are persisted - zero serve/render changes.

### app/src/services/sendMessage.ts  (attachments param + persist media_attachments)
- `SendMessageInput` :133-172 (current fields: `body?`, `mediaUrls?`,
  `automated?`, `author?`, `from?`, `broadcastId?`, `retryOf?`). ADD an
  attachments param (shape `{ s3Key, contentType }[]` per spec Sec 4;
  presigned URLs go into `mediaUrls`).
- Destructure :206; adapter call :284-289 (passes `mediaUrls` :287 - already
  wired to Twilio driver). 
- **Persist** `messages.append({...})` :293-309: `type` stamps `mms` when
  `mediaUrls.length>0` :297; `mediaUrls` persisted :301. TODAY THE SEND PATH
  SETS `mediaUrls` ONLY - it does NOT set `media_attachments` (CONFIRMED - that
  is design gap #3). ADD `media_attachments: [{s3Key, contentType}]` to this
  append so sent media renders. Comment the "presigned mediaUrls are historical,
  expected to expire, never reused" rule near :301 (spec Sec 4).
- Contrast: the INBOUND mirror sets `media_attachments` (via mirrored keys) -
  `webhooks/twilio.ts` (mirror at :280 key scheme, mediaAttachmentsOf check
  :545). So today: inbound => media_attachments; outbound send => mediaUrls
  only. This is the asymmetry to close.

### app/src/lib/mediaTypes.ts  (the allowlist + helper to reuse)
- `INLINE_MEDIA_TYPES` set :17-23 = `image/jpeg, image/png, image/gif,
  image/webp, application/pdf` (exactly the spec's allowlist).
- Reuse helper: `isInlineMediaType(type)` :26-28 - use for BOTH the upload
  endpoint's content-type check AND the send-route HeadObject re-check.
- `normalizeStoredMediaType(raw)` :37-39 available if a stored type needs
  collapsing to octet-stream.

### app/src/middleware/rateLimit.ts  (createUserRateLimit pattern)
- Definition `createUserRateLimit` :174 (sliding-window, per-user, per-instance
  map; each call owns its own map - note at :150).
- Mirror pattern - `api.ts:643-648`:
  ```
  const manualSendLimiter = createUserRateLimit({
    routeKey: 'manual_send', max: config.rateLimitManualSendPerMin,
    windowMs: 60_000, logger: log,
  });
  ```
  For uploads: own bucket `routeKey: 'media_upload'`, `max: 30`, `windowMs:
  60_000`. Other usages to mirror: `voiceApi.ts:112/208`, `broadcasts.ts:369`
  (broadcasts is DEFERRED - do not touch that file).
- Create ONE limiter instance with the router (per-request creation resets the
  window - see api.ts note :641-642).

### app/src/jobs/relayFanOut.ts  (relay media both directions)
- Leg loop over `recipients`: :321-412. Per-leg adapter send at :370
  `adapter.sendMessage({ to: member.phone, from: poolNumber, body: relayBody })`
  - ADD `mediaUrls` here, presigned PER LEG from the hub message's
  `media_attachments` (legs are token-bucket paced ~1/s at :366
  `deps.tokenBucket?.acquire(1)` - presign fresh at leg time, spec Sec 7).
- **"no body -> relay nothing" guard TO REPLACE** :294-300:
  ```
  const body = typeof sourceMessage.body === 'string' ? sourceMessage.body : '';
  if (body.length === 0) {
    // Nothing to relay (e.g. MMS-only). M1.7 relays text bodies; media relay
    // is future work. Log and stop - never send an empty body.
    log.info({...}, 'relayFanOut: source has no text body - nothing relayed');
    return;
  }
  ```
  Replace: an MMS-only source must still fan out, with body from the NEW catalog
  entry `relay.media_only` (via `resolveMessage`). For media-with-text, keep the
  existing `composeRelayBody` "<name>: <body>" (`composeRelayBody` :146-149;
  `relayBody` built :317) and ride media along.
- `resolveMessage` already imported :43 (used for `relay.intro` at :185). Use it
  for `relay.media_only` with `{ name }`.
- Member-INBOUND forwarding: source messages persisted by
  `handleRelayInbound` carry mirrored `media_attachments` (keys
  `media/<conversationId>/<sid>/<i>`); the fan-out legs must presign those keys
  and forward to other members (closes the "landlord photo never reaches tenant"
  hole). Same leg loop at :321-412 handles member + team sources uniformly once
  media is read from the source's media_attachments.
- NOTE: there are TWO "media relay is future work"-class comments to remove/
  update: (1) `relayFanOut.ts:296-298` (the guard above), and (2)
  `webhooks/twilio.ts:326-329` (`handleRelayInbound` - "it does NOT yet relay
  the media ON to the other thread members ..."). Both come out when forwarding
  is real. There is NOT a separate third comment in twilio.ts; the spec's
  "twilio.ts does NOT yet relay the media" comment IS the :326-329 block.

### app/src/routes/webhooks/twilio.ts  (comment removal only)
- `handleRelayInbound` :311-369; the future-work comment :324-329; inbound media
  parse `parseInboundMediaUrls` :242-247 (used :330, :485); mirror key scheme
  `media/${conversationId}/${messageSid}/${i}` :280; mirror-on-first-delivery
  :371-374 and :715-727; `mediaAttachmentsOf` idempotency check :545. Behavior
  change lives in relayFanOut; here it is comment removal (spec Sec 10).

### app/src/messages/catalog.ts  (+ test)  new relay.media_only entry
- `MessageDef` shape :65-82; `MessageId` union :27-63 (ADD `'relay.media_only'`
  to the union, in the "Operational - relay group" group near `'relay.intro'`
  :39-40).
- Mirror the existing operational relay entry `relay.intro` :167-174 for the new
  one:
  ```
  'relay.media_only': {
    id: 'relay.media_only', class: 'operational', editable: true,
    channel: 'sms', vars: ['name'],
    default: '{name} sent an attachment.',
  },
  ```
- **catalog.test.ts invariants a new entry MUST satisfy**
  (`app/test/messages/catalog.test.ts`): (1) `def.id === map key` + non-empty
  default (:23-29); (2) every `{token}` in default declared in `vars` - `{name}`
  must be in vars (:31-37); (3) NON-editable entries must USE every declared var
  - N/A here since editable:true (:39-50); (4) class in the allowed set / channel
  in {sms,voice} (:60-68). `relay.media_only` is operational/editable with
  `{name}` used in the default => passes all. No requiresOptOut (relay is
  consent-exempt, spec Sec 9).

### dashboard/src/routes/contact/Timeline.tsx  (the shared composer - ONE change)
- `onSend` contract TODAY: `:89` `onSend?: (body: string) => Promise<void>` -
  WIDEN to `onSend?: (body: string, attachmentKeys?: string[]) => Promise<void>`.
- Draft state `:451` `const [draft, setDraft] = useState('')`; `handleSend`
  :591-615 (calls `onSend?.(text)` :605); composer JSX (textarea :727-737, send
  button :753-761, footer :743-762). Add attach control + chip row here; send
  enables on body non-empty OR attachments (button disabled logic :757).
- Attachment rendering ALREADY EXISTS (`media_attachments` bubble) :226-330
  (`attachments = msg.media_attachments ?? []` :226; gallery :286-330 using
  `messageMediaSrc(sid,i)` / `messageSid` from `./media.js` :27). So sent media
  auto-renders once persisted.
- **Keyed-remount draft mechanics**: `resetScrollKey` prop :111-115 is the
  conversation identity; the tour page keys `<ContactThread>` / channels by
  `conversationId` so a switch REMOUNTS a fresh Timeline (draft + new attachment
  chip state must be component-local so they cannot leak across channels -
  attachments ride the same local `useState` as `draft`). See TourConversation
  keys below (`key={active.conversationId}` :178, `key={activeKey}` :186).

### The FIVE onSend consumer call sites (all pass onSend into <Timeline>)
1. **ContactDetail** (`dashboard/src/routes/contact/ContactDetail.tsx`):
   - onSend passed to Timeline at `:498`.
   - onSend defined `:235-260`; core optimistic `postSend` `:211-221`
     (`sendMessage(conversationId, { body })` :213); the
     `ensureContactConversation` first-send path `:241-244` (`:243`); deferred/
     consent-retry `deferredSend` :231-234. BOTH send sites (postSend + the
     ensure path) must carry attachmentKeys.
2. **TourConversation** (`dashboard/src/routes/tours/TourConversation.tsx`):
   - `GroupChannel` onSend :222-230 (`sendMessage(conversationId,{body})` :224),
     passed to Timeline :238; Timeline at :233.
   - `ContactThread` onSend :257-265 (`sendMessage` :259), passed :272;
     Timeline :267. Keyed `key={active.conversationId}` :178.
   - `NewContactThread` onSend :294-298 (incl `ensureContactConversation` :295 +
     `sendMessage` :296), passed :305; Timeline :300. Keyed `key={activeKey}`
     :186.
   - `GroupChannel` mounted :143.
3. **ConversationDetail** (`dashboard/src/routes/conversation/ConversationDetail.tsx`):
   - onSend defined `:218`; passed to Timeline via `{...(canSend && { onSend })}`
     at `:409`; Timeline at :404.

### dashboard/src/api/endpoints.ts  (+ types.ts)
- `sendMessage` :360-368 - body type `{ body?: string; mediaUrls?: string[] }`
  :362; WIDEN to add `attachmentKeys?: string[]`.
- ADD `uploadMedia(file): Promise<{key,contentType,size}>` here. GOTCHA: the
  shared `request()` helper (`dashboard/src/api/client.ts:75-103`) is JSON-ONLY
  (always sets `Content-Type: application/json` + `JSON.stringify`, :79-82). A
  multipart upload MUST NOT use `request()` - do a raw `fetch` with a
  `FormData` body and let the browser set the multipart boundary
  (`credentials:'same-origin'`, throw `ApiError` on non-2xx to match the
  convention). Mirror ApiError parsing from client.ts.
- `retryMessage` :374-384 (unchanged client-side; server re-presigns).
- **types.ts** (`dashboard/src/api/types.ts`): `Message.media_attachments?:
  {s3Key;contentType}[]` :1187-1189 and the timeline message variant
  `media_attachments` :1256 ALREADY exist (render side is ready). `mediaUrls?`
  :1187. `SendMessageResult` :1334. Add an upload-response type + widen the
  send payload type if one is declared.

### fake-twilio/src/routes/rest.ts  (MediaUrl string|string[] normalize)
- THE LINE (`fake-twilio/src/routes/rest.ts:24`):
  ```
  const mediaUrls = typeof body['MediaUrl'] === 'string' ? [body['MediaUrl']] : undefined;
  ```
  Reads a SINGLE MediaUrl. The Twilio SDK sends repeated `MediaUrl` params for
  multi-attachment (parsed as an array). Normalize `string | string[]` so
  multi-attachment sends record faithfully. Downstream: stored :29,
  `num_media` :40.

### e2e  (extend scenarios)
- Existing MMS pattern uses the RAW mediaUrls seam via a canned fake image:
  `e2e/scenarios/steps.ts:1781-1796` (`tenantSendsPhotoId`) posts
  `mediaUrls: ['${fakeUrl}/canned/room.png']` (:1790) via `sendAsParty`, then
  asserts the timeline renders it (:1793-1794). Fake helpers:
  `sendAsParty`, `listThreads` from `e2e/fixtures/fakeTwilio.js` (imported
  steps.ts:15). listThreads messages carry `direction`/`body`/mediaUrls - assert
  media on the fake thread there (pattern at :1803-1808).
- For the NEW real-composer test: Playwright `setInputFiles` on the composer's
  `<input type=file>`. There is NO existing `setInputFiles` usage in e2e yet -
  this is new. A small fixture image should live under `e2e/fixtures/` (e.g.
  `e2e/fixtures/tiny.png`); the fake already serves `/canned/room.png` for the
  provider-side seam but Playwright's file picker needs a real on-disk file.
- outbox/thread assertions: `getOutbox` fixture (`e2e/fixtures/outbox.ts`,
  deprecated in favor of fakeTwilio) and `listThreads`; preflight requires
  `MESSAGING_RECORD_OUTBOX=1` (`e2e/support/preflight.ts:14-22`).

### media_attachments render pipeline (CONFIRMED - persist-only, zero render changes)
- RENDER: `Timeline.tsx:226,286-330` renders `msg.media_attachments` (images
  inline, PDF/other as links) using `messageMediaSrc(messageSid(msg), i)`.
- SERVE: `api.ts:1018-1049` `GET /api/messages/:providerSid/media/:idx` streams
  `mediaAttachmentsOf(message)[idx].s3Key` from `mediaStore.getStream` (authed,
  private bucket, session-gated). Helper `mediaAttachmentsOf`
  `app/src/repos/messagesRepo.ts:330`.
- => The send path only needs to PERSIST `media_attachments`
  (`services/sendMessage.ts` append). No render or serve changes.

### ASCII verify
- `tr -d '\11\12\15\40-\176' < FILE | wc -c` must print `0` for every new/added
  file (grep -P false-passes; use tr). Run over all new source + this feature's
  docs.

================================================================
## DRIFT / GAPS FLAGGED
================================================================
- **Constants**: spec Sec 9 names `OUTBOUND_MMS_MAX_MEDIA=10`,
  `OUTBOUND_MMS_MAX_FILE_BYTES=5MB`, `OUTBOUND_MMS_MAX_TOTAL_BYTES=5MB`. No such
  constants exist yet - implementer must add them (suggest a new small module or
  alongside mediaTypes.ts). Not a blocker, just not pre-existing.
- **uploadMedia cannot reuse `request()`** (JSON-only) - the spec's dashboard
  api note (Sec 10) does not call this out; flagged above as the concrete
  gotcha.
- **Retry line drift**: spec says "api.ts ~:734" for the mediaUrls replay - it
  IS currently exactly `api.ts:734`. No drift; anchor holds.
- **Two future-work comments, not three**: spec Sec 7 phrases it as separate
  "media relay is future work" comments plus a twilio.ts comment; in the current
  tree there are exactly TWO to touch - `relayFanOut.ts:296-298` and
  `webhooks/twilio.ts:326-329`. (No independent third comment.)
- **types.ts render side already done**: `Message.media_attachments` already
  exists in wire types (:1187-1189, :1256) - only the SEND payload widening +
  an upload-response type are new. Confirms "zero render changes".
- **HeadObject dependency**: the send-route attachmentKeys validation needs a
  HeadObject on each `uploads/<key>`. `MediaStore` exposes only `put`/`getStream`
  today; either add a lightweight `head(key)` to MediaStore or HeadObject via the
  same client. Flag: decide where HeadObject lives (keeping S3 SDK in the adapter
  argues for a `MediaStore.head`).
- **NO broadcast file is in any change path** - CONFIRMED. `broadcasts.ts` only
  shares the `createUserRateLimit` import (a middleware), which is NOT modified.
  Broadcasts MMS is explicitly deferred (spec Sec 2/11). Do not touch
  `app/src/routes/broadcasts.ts` or any broadcast dashboard file.
- **Dep install required on merge**: `@aws-sdk/s3-request-presigner` (installed
  for spike) + `busboy` + `@types/busboy`. `npm install` after merge.
