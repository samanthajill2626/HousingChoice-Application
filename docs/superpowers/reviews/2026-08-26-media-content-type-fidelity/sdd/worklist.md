# Merged research worklist - media-content-type-fidelity

Verified against live tree @9df132c5 (merge-base with main = 3c2962a4, main unmoved).
Three read-only readers (app / dashboard / fake-twilio+e2e), 2026-08-26.
All plan anchors verified byte-exact unless corrected below. The plan's code
blocks were hand-traced in design review R2/R3 and re-spot-checked here.

## PLAN-VS-TREE CORRECTIONS (bake into slice briefs)

C1. TASK 6 MISCONFIG GUARD PREDICATE IS WRONG IN THE PLAN (R3's least-reviewed
    section, as the mission predicted). The plan says: assert
    twilioApiKeySid/Secret/AccountSid present, "which is exactly what makes the
    adapter factory choose the Twilio driver". FALSE on the live tree:
    createMessagingAdapter (app/src/adapters/messaging.ts:1162-1193) chooses on
    `config.messagingDriver === 'console'` vs else - a discriminator string
    (config.ts:618: env.MESSAGING_DRIVER ?? (nodeEnv==='production' ? 'twilio'
    : 'console')). Fields-present with MESSAGING_DRIVER unset on a non-prod
    shell still yields the CONSOLE driver -> undefined for every media ->
    "all aged out" green exit - the exact failure the guard exists to prevent.
    CORRECT GUARD (CLI wrapper, before the scan): require
    `config.messagingDriver === 'twilio'` AND the twilio* fields present
    (loadConfig fail-fasts the fields when driver=twilio, incl TWILIO_AUTH_TOKEN
    - config.ts:623-629, so the driver check is the load-bearing half).
    Record this deviation in the slice report + handback.

C2. TASK 3 REAL COORDINATES: the serve handler is api.ts:2251-2309. Header
    block to replace is :2291-2296 (stored/inline/Content-Type/disposition).
    PRESERVE :2297-2298 (nosniff+CSP - plan re-states them), :2299-2301
    (Content-Length passthrough), :2303 (Cache-Control), and UPDATE :2304
    log.info from `inline` to `tier: resolved.tier`. Anchor by content, not
    line numbers.

C3. TASK 5 IMPLEMENTER COUNT: EIGHT MessagingAdapter structural implementers
    (not "four"): messaging.ts:573 TwilioMessagingDriver + :1003
    ConsoleMessagingDriver (real impls), and SIX test literals:
    app/test/helpers/twilioWebhookHarness.ts:3344,
    app/test/scheduledSendSuppression.test.ts:333,
    app/test/sendMessage.test.ts:286, app/test/tourReminders.test.ts:1453,
    app/test/relayWarm.test.ts:59, app/test/poolNumbers.test.ts:174/207/213.
    MediaStore: S3MediaStore (mediaStore.ts:138) + literal at
    twilioWebhookHarness.ts:3425.
    IMMUNE - do NOT edit: poolNumbersAdmin.test.ts:688,
    twilioEventsWebhook.test.ts:194 (casts); mediaMirror.ts:44 +
    voiceTranscripts.ts:123 (Pick<> types - do not widen);
    unitMediaServe.test.ts:32, mmsSendGuard.test.ts:6,
    inboundEmail.test.ts:284, sendEmailMessage.test.ts:98,
    apiRoutes.test.ts:628 (casts); emailMedia.test.ts:13,
    mmsMediaRoutes.test.ts:11, sendEmailMessage.test.ts:47 (Partial<>).
    NOTE: createInboundMailRawStore reuses S3MediaStore and inherits
    setContentType - harmless, nothing calls it there; do not special-case.

C4. messaging.test.ts's real makeDriver (:293-303) ALSO passes
    `logger: createLogger({ destination: createLogCapture().stream })`. The
    plan's driverWith omits logger - fine only if the constructor makes it
    optional; let typecheck decide, add logger if required.

C5. TASK 4: MediaGallery.tsx:9 is `import type { CommsMediaItem }` - adding
    isInlineRenderable needs a value import (second statement or convert).
    FIFTH do-not-move pin: dashboard/src/routes/contact/files.test.tsx:328
    `getByRole('img', { name: /Attachment/i })` rides MediaGallery's hardcoded
    alt="Attachment" (:44) - do not touch that alt.

C6. TASK 8: docs/issues/media-serve-stored-xss.md carries stale anchors
    (:10 refs + body: api.ts:813-820 -> now 2291-2296; twilio.ts:234-236 ->
    normalize moved to services/mediaMirror.ts:104; messagesRepo.ts:329-337 ->
    mediaAttachmentsOf now ~:1001; app.ts:70-72 -> :113-118; api.ts:752 ->
    :2220). Update the FRONTMATTER refs line to current anchors; leave the
    dated Resolution body intact; the amendment notes current locations.

C7. TASK 6 RUNBOOK env requirements (T8 too): the script imports loadConfig at
    module load; operator shell needs MESSAGING_DRIVER=twilio +
    TWILIO_ACCOUNT_SID/TWILIO_API_KEY_SID/TWILIO_API_KEY_SECRET/
    TWILIO_AUTH_TOKEN/TWILIO_MESSAGING_SERVICE_SID + MEDIA_BUCKET (target
    env's bucket) + the hcAws AWS profile. Prod datapoint for sizing: 11
    media-bearing messages as of 2026-08-18 (RUNBOOK:260).

## VERIFIED ANCHORS (byte-exact quotes live in the reader returns; keys only)

- mediaTypes.ts (141 lines): exports at :23 IMAGE, :31 INLINE, :37
  isInlineMediaType, :45 isImageMediaType, :56 normalizeStoredMediaType
  (`isInlineMediaType(raw) ? raw!.trim().toLowerCase() : 'application/octet-stream'`),
  :65 TWILIO_DELIVERABLE, :72 isTwilioDeliverableType, :89 planMmsMedia,
  :115 EMAIL_ATTACHMENT_TYPES, :130 isEmailAttachmentType, :140 EMAIL_MAX.
- Importers of mediaTypes: api.ts:23 (isInline+isTwilioDeliverable+normalize;
  normalize UNUSED - confirmed), mmsMedia.ts:15, units.ts:26,
  unitMediaServe.ts:24, emailMedia.ts:16, mediaMirror.ts:24 (normalize,
  called :104), inboundEmail.ts:63 (normalize, called :677),
  sendEmailMessage.ts:25; tests: mediaTypes.test.ts:4-8,
  mediaTypes.plan.test.ts:2-7, emailMedia.test.ts:10,
  sendEmailMessage.test.ts:15. isInlineMediaType callers: mmsMedia.ts:78
  (outbound gate - NEVER widen), api.ts:2292 (serve - replaced by T3),
  inside normalizeStoredMediaType (:57). No others.
- apiRoutes.test.ts: makeMediaApp :600-632 (opts.message via getByProviderSid;
  opts.object.contentType only - filename flows via message record, which is
  what the plan's mediaMessage helper does - OK); get helper :634-638;
  toBeUndefined at :648 (:image inline test) and :661 (PDF inline test);
  contrast :672 toMatch(/^attachment/). mmsMedia.test.ts:229 third hit.
  Scoped grep = exactly 3 hits; repo-wide 4th = unitMediaServe.test.ts:77
  (DIFFERENT route - do not touch).
- mediaMirror.test.ts: silent :20, flakyAdapter :23-38, storeSpy :40-50,
  first mirrorMediaSet test call shape :76-89, TARGETS :52-55.
- inboundEmail.test.ts:970-991: makeWorld+mime attachments harness; :988 pins
  x-weird -> octet-stream (STAYS TRUE - x-weird is opaque).
- messagesRepo.ts: annotateMessage iface :1209 impl :2503, putMediaPointers
  iface :1225 impl :2553-2557; info log :2528-2537; best-effort pointer
  try/catch :2544-2550; mediaPointerSk :206-209 ARRAY-POSITION based;
  mediaPointerItems :228-246 writes content_type :243 + filename :244.
- mediaMirror.ts: inboundMediaKey :67-69; put at :110 with normalize :104.
- webhooks/twilio.ts: parseInboundMediaUrls :440-448 (skips empties);
  compacted successes-only append :496-497; targets built :486-490 from
  params MediaContentType{i}.
- jobs/mediaMirror.ts:147-160: dedupe-by-s3Key APPEND to existing.
- backfill-media-pointers.ts: opts bag :40-47, scan loop :55-75
  (FilterExpression attribute_exists(media_attachments) OR
  attribute_exists(media_s3_keys)), CLI tail :80-97 (invokedDirectly).
- import-apply.ts: hcAws import :29-34; guarded doc client :248-257
  (assertHousingChoiceAccount + hcCredentials + marshallOptions
  removeUndefinedValues:true "must match lib/dynamo.ts").
- hcAws.mjs exports confirmed: HC_ACCOUNT_ID/HC_PROFILE/HC_REGION/
  hcCredentials/assertHousingChoiceAccount (+stateBucketName/STACK_ENVS).
- S3MediaStore: positional ctor (bucket, client) :138-142; MediaStore iface
  :72-135 (7 members); CreateMediaStoreDeps :281-285 {config?, client?};
  createMediaStore :304-308 -> buildS3Client(config,...) :317-332 (endpoint/
  forcePathStyle for local; hard-throws endpoint in prod). NO
  PutObjectCommand/CopyObjectCommand anywhere in app/src yet - setContentType
  is the first CopyObjectCommand (import alongside existing commands at
  mediaStore.ts:8).
- TwilioClientLike :390-399 messages: {create} plain object (not callable).
- Serve route today :2291-2304: quoted in C2.
- resolveAttachmentKeys guard :527-531 isTwilioDeliverableType; retry presign
  :1589-1597.
- Config: twilioAccountSid :148, twilioApiKeySid :150, twilioApiKeySecret
  :151 (env at :1294-1296); messagingDriver :618; fail-fast :623-629.
- No backfill:* npm script anywhere (confirmed). RUNBOOK npx tsx convention
  :206,:232,:242,:257,:260.
- docs/issues/relay-forwards-undeliverable-media.md EXISTS (D3 filed).
  _TEMPLATE.md exists.
- INVARIANT SWEEP (writers of S3 object content-type) - exhaustive, matches
  spec 7.1: mediaMirror.ts:110 (normalize), inboundEmail.ts:679 (normalize),
  mmsMedia.ts:83 presign (guard :78) + :143 transcode literal, emailMedia.ts:82
  presign (guard :65), units.ts:543 presign (guard :516) + :766 rendition
  literal + :686 confirm re-check, voice.ts:1995 'audio/mpeg',
  seed/media.ts:121-128. NOTHING ELSE. Readers who branch: api.ts:2291-2293
  (target), unitMediaServe.ts:61-62 (do not widen), api.ts:527-531,
  units.ts:686/:702, mmsMedia.ts:108-110, emailMedia.ts:107-108,
  sendEmailMessage.ts:323-324. Silent propagators: messagesRepo :243 pointer
  rows, contacts.ts:1373 gallery API, emailMime.ts:103 -> adapters/email.ts:75
  (outbound MIME part type), jobs/mediaMirror.ts:73, inboundEmail.ts:555 log.
  relayFanOut.ts:494-509 presigns with NO type filter (D3, no change).

## DASHBOARD (reader B - zero drift)

- media.ts 43 lines; single type-only import; exports messageSid :14,
  messageMediaSrc :21, CommsMediaItem :25, toCommsMediaItem :36. Append-clean.
- media.test.ts:2 imports {messageMediaSrc, messageSid, toCommsMediaItem}.
- Timeline.tsx: import './media.js' :52; glyphs :604-608 fromCodePoint;
  attachmentLabel :610-617; map loop :638-641 predicate :640; img call site
  :649-655 (label at :652 with isPdf=false); isPdf :658 (exact ===
  'application/pdf'); file-link label :667. No-sid count-chip short-circuit
  :629-635 never touches contentType.
- MediaGallery.tsx: type-only import :9; predicate :36; alt="Attachment" :44
  (files.test.tsx:328 pins - do not touch); literal emoji :56 (pre-existing
  non-ASCII - LEAVE); props inline anonymous type :12-28; non-image tile has
  NO visible text (aria-hidden glyph; name via title=contentType).
- Pins (FIVE): Timeline.test.tsx:552 (img alt), :555 (PDF link name),
  Timeline.email.test.tsx:87 (filename text), :88 + :107 (octet-stream bare
  "Attachment N" - fixtures :81,:104), files.test.tsx:328.
- mmsWith template: Timeline.test.tsx:538-558 (MESSAGE_OUT spread at :47-59,
  tsMsgId '2026-06-08T09:20:00#SM123'); renderTimeline :15-31 (MemoryRouter).
- MediaGallery.test.tsx DOES NOT EXIST; harness precedent files.test.tsx:1-18;
  MediaGallery needs NO router (Card's EmptyRow renders bare <p>), but
  MemoryRouter harmless.
- Timeline consumers (fix rides free): ConversationDetail.tsx:32/480,
  GroupTextView :21/448, PlacementConversation :55/320, TourConversation
  :44/467, ContactCommsPane :26/319. MediaGallery consumers: TenantFile,
  LandlordFile, PartnerFile, UnknownFile (identical call shape).
- Optimistic rows hardcode octet-stream (useContactTimeline.ts:306,
  useRelayThread.ts:253) -> land on bare "Attachment N" (opaque) - unchanged;
  no work.
- Composer-side branches read local File.type (Timeline:2189,:1615,
  EmailComposer:415,:212) - OUT OF SCOPE, unaffected.
- Dashboard vitest: config in dashboard/vite.config.ts:116-126 (jsdom,
  setupFiles, relative include) - MUST run `cd dashboard && npx vitest run
  ...`. Frozen clock 2026-07-01 in setup.
- Mirror-comment precedent: dashboard/src/lib/consentCopy.ts:1-6 (fullest),
  endpoints.ts:619-620 (terse).

## FAKE-TWILIO + E2E (reader C)

- inferMediaContentType signer.ts:26-39 (path-only suffix match; add .vcf ->
  'text/vcard' before final return).
- Canned MMS surface (ignore the canned-RECORDING cluster in src/server.ts):
  assets fake-twilio/web/public/canned/ (kitchen.png 2142B, room.png 3664B,
  lease-doc.pdf 600B); registry web/src/assets/canned/index.ts:19-37
  (CannedAsset {id,url,label}; cannedUrl(file) -> `${origin}/canned/${file}`;
  isImageAsset :47 raster regex - .vcf false -> renders as doc glyph);
  pinning test index.test.ts (EXT map :10 {room:'png',kitchen:'png',
  'lease-doc':'pdf'} - ADD 'contact-card':'vcf' or expected URL becomes
  .undefined; tests pin URL pathname + isImageAsset + label round-trip;
  NOTHING pins content types - the signer branch is on the implementer).
- Registry is browser-UI only; e2e path hardcodes URLs. MediaContentType{i}
  comes from inferMediaContentType(url) (signer.ts:51-56) -> webhook
  /webhooks/twilio/sms -> app targets :486-490. Fake's own static serve of
  .vcf will say text/x-vcard (express mime) - IRRELEVANT, app uses the param.
- Serving: from web/dist via express.static (server.ts:231-247); vite copies
  public/ verbatim (no publicDir override; registry header comment :1-9
  explains why NOT via src/assets). e2e-session builds web UI at boot;
  restartBackend() REUSES dist - a warm session will not see a new asset
  without full session restart. Single-spec run boots hermetic stack via
  webServer (playwright.config.ts:183-207, reuseExistingServer: !CI; lane
  adoption via e2e/.artifacts/lane.json).
- 1:1 inbound-MMS template: e2e/scenarios/steps.ts:2200-2209
  (ensureParty then sendAsParty({from: t.phone, to: APP_NUMBER, body,
  mediaUrls:[`${fakeUrl}/canned/room.png`]})); fixtures
  e2e/fixtures/fakeTwilio.ts sendAsParty :166-184 (omit `to` -> APP_NUMBER
  '+15550009999' = 1:1), registerParty :153-156. Conventional contact:
  TASHA '+15550100001' = contact-tenant-0001 (lean seed) - navigate
  `${NEXT}/contacts/contact-tenant-0001`.
- Timeline locator: page.getByRole('region', {name: 'Communications and
  activity'}) (14 call sites; source Timeline.tsx:1973).
- devLogin helper: outbound-mms.spec.ts:53-61 (+expectTodayReady from
  e2e/support/today.ts).
- Header-assert precedent: mms-transcode.spec.ts:71-76 fetchedContentType
  (request.get + res.headers()['content-type']). Relative href resolves
  against dashboard Vite baseURL which proxies /api with origin-verify;
  session cookie rides along.
- Config: testDir './tests' auto-includes; workers:1 fullyParallel:false
  (path order = run order); retries:0; trace on-first-retry (= NOTHING on
  gate failure); timeout 60s; expect 15s. Zero-error-line asserts immune
  (group-text-conversion windowed+filtered; group-text-reply-all
  msg-filtered; our spec creates no relay group and sorts after both).
- mutationCatalog: mutating verbs only, scans dashboard/src excluding tests;
  T4's changes add no request calls - INERT (count stays 108).

## SLICING (sequential, one implementer child each)

S1 = T1+T2 (lib resolver + filename builder)  S2 = T3 (serve route)
S3 = T4 (dashboard)  S4 = T5 (adapters)  S5 = T6 (backfill)
S6 = T7 (fake-twilio + e2e)  S7 = T8 (docs)
