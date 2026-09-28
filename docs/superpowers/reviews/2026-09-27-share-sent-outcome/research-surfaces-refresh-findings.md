# Share sent outcome (Branch B) - research: surfaces refresh for the plan - FINDINGS

Date: 2026-09-28. Read-only reader, nothing run. Tree: worktree
`W:\tmp\share-sent-outcome`, branch `feat/share-sent-outcome`, HEAD `cebc7d23`
(main `3f38bcc2` merged in: Stage 1b plus Cameron's two post-verdict
decisions). Every `path:line` below was read on THIS tree. Scope: the spec's
section 5 (surfaces) and section 7 (tests), everything EXCEPT the retry job,
the reconcile, the attempt-record repo and the webhook internals (another
reader); the webhook rollup is cited as an entry point only. Exact
signatures, type shapes and short excerpts: the gitignored companion
`.superpowers/sdd/research-surfaces-refresh-reference.md` (blocks S1-S57).
UNVERIFIED marks what the code read here cannot settle.

## 0. What moved since the d9cb5c04 research, and what the spec misstates

In-scope files Stage 1b touched (diff d9cb5c04..HEAD): `broadcastFanOut.ts`
(+4 lines after 1294), `webhooks/twilio.ts` (one line, 3529, no shift),
`contactTimeline.ts` (+1 after 33, +7 after 181, +2 after 460), dashboard
`api/types.ts` (+15 by the broadcast block), `Timeline.tsx`,
`deliveryStatus.ts`, `retryPromise.ts`, the harness, `selectors.md`. Every
other file cited below is unchanged since d9cb5c04.

Moved line numbers the three earlier records cite (old, then now):

- broadcastFanOut.ts: `isBroadcastRowFor` 1296-1306 now 1299-1310 (gained a
  retry_of clause, 1303); `adoptBroadcastRecipient` 1341-1479 now 1345-1483 (slot
  write 1399-1420, property rows 1460-1467, failure WARN 1469-1481);
  `recordRecipient` now 1492-1499; `finalize` 1497-1575 now 1501-1579 (re-read
  1525, open check 1530-1535, reachedAny/failedAny 1537-1538, status 1539,
  last_error 1540-1541, flip 1542, unit audit 1550-1556, emit 1559).
  `recordPropertySent` 1208-1252 and all lines before 1294 did NOT move.
- contactTimeline.ts: MAX_LANDLORD_UNITS 283 now 291; LANDLORD_FEED_TYPES
  308-313 now 316-321; `toTimelineMilestone` 652-663 now 663-673; broadcast_sent
  case 674-689 now 690-698; tenant milestone read 1282-1289 now 1292-1298;
  landlord gather 1299-1330 now 1309-1340; merge/slice 1336-1340 now 1344-1348;
  hottest-read note 1363-1366 now 1374-1375.
- dashboard/src/api/types.ts: BroadcastStats now 2965-2987; BroadcastSummary
  now 2990-3004; wire BroadcastRecipient now 3020-3042; BroadcastRecipientView
  now 3064-3080; BroadcastUpdatedEvent now 3119-3127; ListingSendRow now
  2733-2745 (each was 15 lower).
- deliveryStatus.ts: 30003 promise map 888-899 now 947-949 (new
  `RETRY_UNCONFIRMED_REASONS` 965-967); options doc 993-1000 now 1002-1025
  (gained `retryUnconfirmed`); SHARE_SKIP_REASONS/shareSkipReason 1098-1116 now
  1122-1140; `deliveryReason` 1133-1175 now 1157-1205.
- Timeline.tsx: milestone links 439-474 now 448-480; promise predicate 791-795
  now 798-802; supersession hide 2062-2076 now 2078-2085.
- Harness `twilioWebhookHarness.ts`: prior-recipients mirror 3318-3331 now
  3367-3380; listing-send double 3036-3085 now 3085-3134.
- Tests: `sendReconcile.test.ts` property-row pins 377/421/448/1818/1836/1890 now
  385/429/456/1826/1844/1898; `twilioStatusWebhook.test.ts` rollup block 244-371
  now 245-373 plus a NEW pin at 374; `contactTimeline.test.ts` landlord block
  1010-1060 now 1044-1100.
- 1b-owned facts the old records predate: the `broadcast_id` copy onto retry rows
  at `app/src/jobs/retrySend.ts:568-569`, `app/src/routes/api.ts:1769`,
  `app/src/jobs/sendReconcile.ts:902`; the root walk bound
  `RETRY_ROOT_WALK_MAX_HOPS = 16` (`app/src/services/retryChain.ts:31`), not the
  attempt cap the spec's section 0 names.

Spec statements that no longer match the tree:

- M1 (section 0, lines 84-91). The spec says a share retry's receipt is "logged
  at INFO" and pays "the rollup's one 2.5-second re-read" until B lands. At HEAD
  the rollup is SKIPPED for any row carrying `retry_of`
  (`app/src/routes/webhooks/twilio.ts:3529`, commit 3f38bcc2): no broadcast read,
  no wait, no log line; the miss line is already WARN (`twilio.ts:3904`). Pinned
  by `app/test/twilioStatusWebhook.test.ts:374`. D2 must remove that clause and
  rewrite that test; section 7's rewrite list does not name it.
- M2 (section 7, Branch A pins). Two more pins assert a FAILED slot still flags
  and flip under D1 (a keyless 30007 is a final failure):
  `app/test/broadcastsRepo.integration.test.ts:359` ("... a failed one still
  does") and `app/test/broadcastApi.test.ts:1207` ("... a failed one still is").
- M3 (section 7, hint). `dashboard/src/routes/broadcasts/BroadcastResults.test.tsx:139`
  pins the retry hint on a KEYLESS failed 30003 row (no conversationId or
  tsMsgId). Under D3 a row with no message row gets no hint: it flips too.
- M4 (section 7, SOR all-unconfirmed). `e2e/tests/dashboard-next/send-outcome-reconcile.spec.ts:491`
  pins the "Failed" pill (:534) AND the `last_error` alert "Couldn't confirm any
  text went out" (:535-537). D4 shows `last_error` under Not sent only, so the
  alert assertion flips as well.
- M5 (section 5, "the per-share route"). There is no bare GET
  `/api/broadcasts/:id`; the per-share read is GET `/api/broadcasts/:id/results`
  (`app/src/routes/broadcasts.ts:786-797`). The stats-only flag goes there.
- M6 (section 5, "the fake-twilio harness" as a slot reader). fake-twilio never
  reads slots; the in-memory double is `app/test/helpers/twilioWebhookHarness.ts`
  (broadcasts fake from :3139, prior-recipients mirror :3367-3380).
- M7 (section 8, the reconcile ownership watch item). Already closed by 1b:
  `isBroadcastRowFor` refuses any row with `retry_of`
  (`app/src/jobs/broadcastFanOut.ts:1303`) and the reconcile's owner key treats
  a `broadcast_id` row as the share's only without `retry_of`
  (`app/src/jobs/sendReconcile.ts:782-789`).
- M8 (D1 stranded shapes). `SendAttemptOutcome` also has `never_sent`
  (`app/src/repos/sendAttemptsRepo.ts:72-81`), which D1 classifies neither way.
  It appears only as a reconcile verdict (`sendReconcile.ts:399`, `:1299`) that
  leads to a re-drive, so a stored `done`/`never_sent` looks unreachable -
  UNVERIFIED here (reconcile reader).
- M9 (D5, D6 read shapes). No batch read exists: `BroadcastsRepo` has only
  `getById`/`getByIdConsistent` (`broadcastsRepo.ts:367-372`); `ListingSendsRepo`
  only `getByKey` (`listingSendsRepo.ts:91`). Both need a batch method plus
  harness doubles. `RecordActivityEventInput` has no share-id field
  (`app/src/repos/activityEventsRepo.ts:86-94`).
- M10 (section 7 e2e (b)). Exhausting a 30003-only chain takes four failed texts
  (`MAX_SEND_RETRY_ATTEMPTS = 3`, `app/src/lib/retrySendWindow.ts:35`), and each
  fake arming is single-use (`fake-twilio/src/engine/engine.ts:512-516`), so the
  test re-arms after each create lands, 10 s apart. A non-30003 code on the
  retry ends the chain at once (30003 is the only retried code,
  `app/src/services/oneToOneRetryDecision.ts:1-23`, cap `:126`).
- M11 (section 5, copy). Two of B's new label sets are composed APP-side, not
  in the dashboard (section I).

## A. The share row and its slots

- Item `BroadcastItem` (`app/src/repos/broadcastsRepo.ts:168-214`); lifecycle
  `BroadcastStatus` draft/sending/sent/failed (`:40`); `created_via?` (`:173`);
  `recipients` keyed contactId else `phone#<E164>` (`:192-196`);
  `seed_contact_ids` (`:199`), `last_error` (`:205`), `finalize_op` (`:212`),
  `stats` (`:191`).
- Slot `BroadcastRecipient` (`:136-166`), attributes today, all strings:
  `status` (queued/sent/delivered/failed/skipped, `:146`), `conversationId`
  (`:138`), `tsMsgId` (`:140`), `errorCode` (`:157`), `carrierSentAt` (`:165`).
  B's new attribute would be the sixth, a tsMsgId-shaped string.
- Reasons: `SEND_UNCONFIRMED_CODE` (imported `:35` from `lib/sendOutcome.js`);
  failed codes no_contact, transient_cap, enqueue_failed, carrier codes (doc
  `:147-157`); skip buckets by `isNoConsentCode` (`:228-230`) and
  `isOptedOutCode` (`:235-237`, a code-less skip is opted out).
- `BroadcastStats` (`:86-133`): audience, sent, delivered, failed,
  `unconfirmed?`, skipped_opted_out, skipped_no_consent, `skipped_other?`,
  queued, `sending?`. `zeroStats` (`:328-341`).
- `deriveBroadcastStats(b)` over `Pick<BroadcastItem,'recipients'|'stats'>`
  (`:270-325`): empty map returns the persisted stats (`:275`); `sent` splits on
  `carrierSentAt` (`:291-298`); `failed` EXCLUDES `send_unconfirmed`
  (`:302-305`); no default arm. Callers pass only the item: results
  (`routes/broadcasts.ts:293`), list (`:311`), emit (`broadcastFanOut.ts:230`),
  rollup (`twilio.ts:3936`, `:3981`), finalize (`broadcastFanOut.ts:1536`,
  `:1563`) - a promise-map argument is additive.
- Persisted counters: the item's `stats`, written by `create` (`:656`),
  `markSending` (`:755`), the ADD in `recordRecipientOutcome` (`:553-560`),
  `bumpStats` (`:886-927`); read only for an empty-map draft.
- Repo slot writers: `setRecipient` (`:797-843`; blind without priors, else a
  `status IN` condition, returns boolean); `recordRecipientOutcome` =
  `recordOutcome` (`:537-579`; slot + stats ADD in one conditional write; empty
  priors throw `:544-546`; condition `:568`); `closeRecipientIfQueued`
  (`:931-935`); `markSending` (`:747-773`); `markFailed` (`:989-991`) via the
  unconditional `flipStatus` (`:619-645`).
- `finalizeStatus` (`:937-983`): condition `status = sending` (`:961`), op token
  (`:943-977`). The decision is `finalize` (`broadcastFanOut.ts:1518-1579`):
  defer while any slot is queued (`:1530-1535`); reachedAny = sent + sending +
  delivered (`:1537`); failedAny = failed + unconfirmed (`:1538`); stored failed
  iff no reach and some failure (`:1539`); `last_error` (`:1540-1541`, constants
  `:157-160`).
- Fan-out writers (unchanged by B): `deferSlot` (`:541-543`); hand-off close
  (`:554-583`); `declineAtFence` blind write + `bumpStats` (`:636-670`);
  `onRejected` legacy blind arms (`:687-707`) and conditional else arm
  (`:733-747`); refusal arm (`:987-1016`); record phase (`:941-947`);
  `closeBroadcast` (`:419-479`, slot `:452`); second-unknown close (`:782-811`).
- Adoption writer: `adoptBroadcastRecipient` (`:1345-1483`), slot from queued
  only (`:1399-1420`), `skipped` when it did not move (`:1420`); called at
  `sendReconcile.ts:802`. Reconcile slot closes `sendReconcile.ts:1332-1333`,
  finalize `:1392`.
- Webhook entry point: guard `broadcastSlotMayTransition` (`twilio.ts:3840-3844`,
  refuses delivered/failed/skipped); `rollIntoBroadcast` (`:3853-3984`): match on
  conversationId + tsMsgId (`:3887-3889`), one re-read (`:3898-3906`), carrier-sent
  stamp priors `['sent']` (`:3915-3940`), terminal write priors `['queued','sent']`
  (`:3949-3958`) then a SEPARATE `bumpStats` (`:3975`), emits (`:3978-3982`).
  Called at `:3529-3545` only for a `broadcast_id` row without `retry_of`. Its
  parameters carry no promise, though the retry decision `oneToOneRetry` is in
  scope (`:3452-3467`); the enqueue-failure withdraw runs AFTER the rollup's emit
  (`:3634-3641`) and emits no `broadcast.updated`.
- Cap and size: `MAX_BROADCAST_RECIPIENTS = 1500` (`broadcastsRepo.ts:68`);
  budget comment `:56-67` (~150-200 B per slot, ~300 KB at the cap) and header
  `:13-18`; the budget lists status, conversationId, tsMsgId, errorCode and
  predates `carrierSentAt`. Enforced by the send route (`routes/broadcasts.ts:680-690`,
  `:723-735`) and `parseRecipientContactIds` (`:130-154`), which also caps
  `seed_contact_ids` on create (`:412`) and PATCH (`:850`), so one item can hold
  1500 seeds AND 1500 slots. This reader's estimate (UNVERIFIED on real items): a
  fully populated slot is about 230 B (contactId 44 chars, conversationId 41,
  tsMsgId 59, ISO 24, names, map overhead), about 350 KB at 1500 today; a
  tsMsgId-sized pointer adds about 70-75 B, so every-slot-retried is about
  460 KB at 1500 and about 305 KB at 1000. `broadcastApi.test.ts:561`, `:985`
  pin the cap by the constant.

## B. The composer flag

- Repo `priorRecipientContactIds(unitId)` (`broadcastsRepo.ts:702-745`, contract
  `:389-399`): pages byUnit (`:710-736`, `queryIndex` `:582-616`, eventually
  consistent); keeps shares whose STORED status is sent or sending (`:716`);
  adds every non-skipped slot key (`:731-732`); the catch-all returns an EMPTY
  set with a WARN (`:737-742`, return `:741`). Comment `:718-730` names B. The
  repo has no messages or attempts access (`:514-517`), so D1's row and record
  reads need new deps or a service.
- Route POST `/api/broadcasts/:id/preview` (`routes/broadcasts.ts:490-573`): the
  repo call only with a unitId (`:521-524`); per candidate
  `alreadySentThisProperty` on contactId OR `phone#<phone>` (`:547-549`);
  response `priorRecipientContactIds` (`:569`). Router deps lack messages and
  attempts repos (`:69-78`); api.ts forwards only an optional broadcasts dep
  (`app/src/routes/api.ts:1029-1043`).
- Double: `twilioWebhookHarness.ts:3367-3380` (stored-status filter + skipped
  rule, no paging, no catch). No parity test: the harness parity cases
  (`twilioWebhookHarnessRepoAdditions.integration.test.ts:735-814`) cover
  recordRecipientOutcome, closeRecipientIfQueued, finalizeStatus only.
- Repo pins (`app/test/broadcastsRepo.integration.test.ts`): `:298` "unions
  recipients KEYS of sent/sending only (NOT draft/failed)" (c-9 is a queued slot
  in a markFailed share with no record: stays unflagged, stranded); `:347` empty
  set; `:359` "... a failed one still does" (flips, M2).
- Route pins (`app/test/broadcastApi.test.ts`): `:1088` prior SENT flags c-1
  (keeps); `:1118` phone# key (keeps); `:1154` no unitId (keeps); `:1183` "is
  NOT set by a prior DRAFT/FAILED broadcast" (queued slots, no record: holds as
  stranded); `:1207` "... a failed one still is" (flips, M2).
- e2e: `share-skip-fix.spec.ts:250` failed-stays-flagged (flips; header
  `:16-22` goes stale); `:155` and `:215` keep; `broadcasts.spec.ts:96` asserts
  "Already sent" on Tasha right after a prior API send (`:124-138`,
  `:171-175`) - holds under D1 (queued in a sending share, or reached).
- Dashboard `RecipientPreview.tsx`: initial rows `:79-93` (checked =
  has_consent and (seeded or not already sent), `:91`); hand-add matches
  `priorRecipientContactIds` by contactId only (`:104-107`, `:226-240`); Select
  all skips unseeded flagged rows (`:162-168`); amber row and "Already sent" tag
  (`:407`, `:417-422`, `:446-447`). Tests `RecipientPreview.test.tsx:172`,
  `:193`, `:218`, `:290`, `:309`, `:565` feed the flag directly (keep).
- Wire `PreviewCandidate` (`dashboard/src/api/types.ts:3085-3102`),
  `PreviewResponse` (`:3110-3117`); `previewBroadcast` (`dashboard/src/api/endpoints.ts:1843-1848`).

## C. The share list and results

- List GET `/api/broadcasts` (`routes/broadcasts.ts:803-840`): limit default 50,
  max 100 (`:64-65`, `parseLimit` `:157-163`); opaque cursor (`:166-199`);
  byCreated via `list`/`listByStatus` (`:831-834`; repo `:687-695`); per row
  `toBroadcastSummary` (`:301-315`: stored status, derived stats, no
  recipients). Dashboard asks `PAGE_LIMIT = 50` (`useBroadcastsList.ts:29`,
  `:49-52`, `:92-96`).
- Per-share GET `/api/broadcasts/:broadcastId/results` (`:786-797`): eventually
  consistent `getById` (`:788`), then `enrichRecipients` (`:795`; fn `:223-258`)
  with ONE `contacts.getDisplaysByIds` BatchGet (`:231`); `toBroadcastResults`
  (`:280-298`, recipients `:294`). The stats-only flag skips `:795` and `:294`
  and still needs D1's promise reads for `retry_pending`. Fetchers
  `getBroadcastResults` (`endpoints.ts:1876-1885`), `listBroadcasts`
  (`:1801-1809`).
- `useBroadcastResults.ts`: the SSE overlay REPLACES stats wholesale at `:128`;
  400 ms debounced full refetch (`:41`, `:129-134`); terminal latch (`:64`,
  `:77`, `:126`); 2 s poll only while stored status is sending (`:46`,
  `:152-157`); no ticker.
- `useBroadcastsList.ts`: the SSE patch REPLACES stats wholesale at `:118`
  (handler `:114-123`); no debounce, no refetch (header `:2-3` says "a refetch" -
  stale).
- Emitters of `broadcast.updated`: builder `emitBroadcastProgress`
  (`broadcastFanOut.ts:226-232`), used by the pass (`:453`, `:569`, `:661`,
  `:700`, `:746`, `:792`, `:948`, `:999`), the adoption (`:1423`), finalize
  (`:1559`), the reconcile (`sendReconcile.ts:1333`); the rollup emits inline
  (`twilio.ts:3933-3937`, `:3978-3982`). Type `app/src/lib/events.ts:146-150`
  (map `:297`); SSE route `app/src/routes/api.ts:2619-2621`, `:2642`; client
  `dashboard/src/api/EventStreamProvider.tsx:194-198`, type `types.ts:3123-3127`.
- Bridge: `attachEventBridge` forwards EVERY `APP_EVENT_NAMES` entry
  (`app/src/lib/eventBridge.ts:42-45`; `events.ts:315-328`);
  `/internal/events` checks the name and a plain-object shape only
  (`app/src/routes/internal.ts:25-34`), so an optional stats field crosses.
- `presentShareLabel(status, stats?)` (`broadcastFormat.ts:97-105`): "Not sent"
  (neutral) only for stored sent, audience > 0, all skipped (`skippedTotal`
  `:113-115`); else the stored label/tone (`:74-89`): stored failed reads
  "Failed" (danger), sent + skipped + failed reads "Sent". Callers:
  `BroadcastStatusPill.tsx:26` (list `BroadcastsList.tsx:144`, results header
  `BroadcastResults.tsx:146`). Inputs are status + stats only (list rows carry
  no recipients), so D4's table must be computable from buckets.
- `StatChips.tsx:30-56` (Failed `:37`; balance note `:1-11`). Filter tabs stay
  on stored status (`BroadcastsList.tsx:20-26`); list meta "N/M delivered"
  (`:150-152`).
- Rows: `presentRecipientStatus` (`broadcastFormat.ts:130-153`);
  `shareRecipientReason` (`:162-172`) calls `deliveryReason(errorCode)` with NO
  options (`:169`); `DeliveryBadge.tsx:34-44`; `toRecipientViews` (`:193-222`)
  drops `tsMsgId` (`types.ts:3064-3080` has none), failed first.
- `deliveryStatus.ts`: `SHARE_SKIP_REASONS` (`:1122-1132`), `shareSkipReason`
  (`:1137-1140`), `deliveryReason(errorCode, opts)` (`:1157-1205`) with options
  media, relay, retryScheduled, retryUnconfirmed (`:1002-1025`); order:
  unconfirmed, promise, media, relay, base (`:1192-1201`); 30003 promise copy
  (`:947-949`), unconfirmed copy (`:965-967`). The doc `:1014-1017` says the
  property-send row omits the options - B changes that.
- Hint: `BroadcastResults.tsx:55-56` (failed, not send_unconfirmed, has
  contactId), rendered `:71-75`; that copy line (`:74`) already carries a
  non-ASCII glyph. Precedent for "the conversation would offer Retry": the
  bubble shows Retry only when failed, no live promise, no unconfirmed outcome
  (`dashboard/src/routes/contact/Timeline.tsx:1441`), and hides a failed row a
  later `retry_of` child supersedes (`:2078-2085`). SOR's 21211 pin:
  `send-outcome-reconcile.spec.ts:420`, assertion `:464` (a synchronous
  rejection has no row: flips under D3).
- Ticker precedent: `STALE_TICK_MS = 60 * 1000` (`Timeline.tsx:756`); server-
  clock snapshot + arming memo (`:2218-2226`); visibility-gated interval
  (`:2227-2248`); predicate `showsRetryPromise` (`:798-802`); bubble chip
  `:1056-1071`. Liveness `isRetryPromiseLive` (`dashboard/src/routes/contact/retryPromise.ts:43-48`,
  grace `:19`, `RETRY_OUTCOME_UNCONFIRMED` `:33`); app twin
  `app/src/lib/retrySendWindow.ts:99` (window `:15`, grace `:29`, withdrawn
  sentinel `:32`, cap `:35`, outcome `:37`); `serverNowMs`
  (`dashboard/src/api/serverClock.ts:47`).
- Dashboard types: `BroadcastStats` (`types.ts:2965-2987`; the bucket-sum
  comment `:2960-2964` must keep a `retry_pending` sub-bucket out of the sum),
  `BroadcastSummary` (`:2990-3004`), wire `BroadcastRecipient`
  (`:3020-3042`, has tsMsgId), `BroadcastResults` (`:3045-3059`),
  `BroadcastRecipientView` (`:3064-3080`).
- Pins: `broadcastFormat.test.ts:214-231` (sent + skipped + failed = "Sent"
  `:224`; failed = "Failed" `:226`), `:241-247`; `StatChips.test.tsx:33-147`
  (order `:77`), `:178` (30003 row promises nothing), `:250` (pill);
  `BroadcastResults.test.tsx:139` (M3), `:160`, `:227` (SSE overlay + refetch);
  `useBroadcastResults.test.tsx:70-160`; `BroadcastsList.test.tsx:69`. No test
  drives the list hook's SSE patch. App: `deriveBroadcastStats.test.ts:22-118`
  (sum invariant `:118`); `broadcastApi.test.ts:1247`, `:1285`.

## D. The two "Sent to N tenants" surfaces

- Writer: the finalize flip winner appends `units#<unitId>` / `broadcast_sent`
  with `broadcastId` and `tenantCount: slots.length`, unit shares only
  (`broadcastFanOut.ts:1550-1556`); `slots` is every slot (`:1530`), so failed
  and all-skipped shares get one. Audit repo is append-only
  (`app/src/repos/auditRepo.ts:17-24`, `append` `:43`, `listByEntity` `:51`). An
  unrelated `broadcasts#<id>` `broadcast_sent` (actor, count) is written at send
  start (`routes/broadcasts.ts:777-780`), no reader.
- Property Activity: GET `/api/units/:unitId/activity` (`app/src/routes/units.ts:1240-1276`),
  limit 50/100 (`:215-216`, `:240-246`), one `listByEntity` (`:1253`),
  projection keeps `broadcastId`, `tenantCount` (`:183-213`). The label is built
  CLIENT-side: `describeUnitActivity` (`dashboard/src/routes/listing/listingFormat.ts:130-136`,
  "Sent to 0 tenants" when absent), rendered `ListingDetail.tsx:821`, fetched by
  `getUnitActivity` (`endpoints.ts:1105-1114`). Units router has a ledger dep but
  no broadcasts repo (`units.ts:79`, `:288`). Comment `:1237-1239` is stale.
- Landlord timeline: label built SERVER-side in `unitAuditToMilestone`
  (`app/src/routes/contactTimeline.ts:684-699`, case `:690-698`); gather:
  byLandlord limit `MAX_LANDLORD_UNITS = 25` (`:291`, `:1314`), `limit + 1` audit
  rows per unit (`:1321-1324`), filter `LANDLORD_FEED_TYPES` (`:316-321`,
  `:1330`); merge sort `:1346`, slice `:1347` - a post-slice recount reads at most
  `limit` shares. Router deps: no broadcasts or ledger repo (`:109-140`).
- Pins: `broadcastFanOut.test.ts:268`, `:285`; `unitsApiActivity.test.ts:158`;
  `contactTimeline.test.ts:1048` (label contains "4", `:1089-1096`; share `b1`
  is absent from the world, so D5's missing-share fallback keeps it);
  `listingFormat.test.ts:180-192` (incl. "Sent to 0 tenants"); e2e
  `listing-activity.spec.ts:143`, `landlord-activity.spec.ts:122` ("Sent to 2
  tenants", both deliver: keep).

## E. The tenant "Property sent" milestone

- Writer `recordPropertySent` (`broadcastFanOut.ts:1208-1252`): `listing_sent`,
  label "Property sent", refType `unit` + refId unitId for a unit share, else
  refType `broadcast` + refId broadcastId (`:1219-1226`), best-effort
  (`:1227-1232`). Callers: `afterSend` (`:817-832`, run at `:949` after the slot
  write and the token acquire, whether or not the slot moved) and the adoption
  (sent/delivered only, `:1460-1467`).
- Stored fields: contactId, tsEventId, eventId, at, type, label, refType?,
  refId?, created_at (`activityEventsRepo.ts:65-82`, `record` `:125-148`). A
  share id exists today ONLY on a unit-less share's milestone (as refId); the
  record input has no field for it (`:86-94`).
- Readers: `toTimelineMilestone` maps the label verbatim
  (`contactTimeline.ts:663-673`), read at `:1292-1298`; `MilestonePin` renders
  it verbatim (`Timeline.tsx:467-480`), links by refType (`:448-464`); type
  `TimelineMilestone` (`types.ts:2667-2673`). So D6's words are composed in
  `contactTimeline.ts`.
- Seed history: one "Property sent" per ledger row at `sentAt`
  (`app/src/lib/seed/history.ts:995-1008`, loop `:1127`; stale cites to
  `broadcastFanOut.ts:308/309` at `:562`, `:998`); test `seedHistory.test.ts:594`.

## F. The listing-send ledger

- Table `listing_sends`: PK unitId, SK contactId, GSI `byContact` (contactId,
  sentAt), no TTL, no stream (`app/src/lib/tables.ts:403-425`, GSI `:418-424`),
  NOT marked sparse (compare byUnit `:382`); projection ALL (`:14`, `:60`).
- `gen-tables.ts` emits only index_name, hash_key, range_key per GSI
  (`app/scripts/gen-tables.ts:65-69`), so `sparse: true` changes NO generated
  Terraform (`app/test/genTables.test.ts:111-112` says so). A `tables.ts` edit is
  still a contract change for the README Deviations table (`tables.ts:17-19`,
  `README.md:25`). `tables.test.ts:86-96` pins the ledger spec, no sparse check.
- Repo `app/src/repos/listingSendsRepo.ts`: `ListingSendItem` (`:36-51`), wire
  `ListingSendRow` + `toListingSendRow` (`:60-71`, `:104-118`),
  `RecordSendInput` (`:74-81`); `recordSend` is an UNCONDITIONAL upsert (sentAt,
  via, updated_at, created_at if_not_exists, SET or REMOVE broadcastId,
  `:136-178`); `getByKey` eventually consistent, no runtime caller (`:125-133`);
  `listByUnit` base table, contactId order (`:182-190`); `listByContact`
  byContact newest first (`:192-202`).
- ONE writer: `recordPropertySent`'s `recordSend` (contactId, unitId, via
  broadcast, broadcastId) for unit shares only (`broadcastFanOut.ts:1237-1250`,
  swallowed on error); contactId is the RESOLVED contact (`:828`, `:1463`;
  `resolveContact` `:1192-1200`). Called by the pass (`:827-831`) and the
  adoption (`:1462-1466`). The webhook has no ledger or activity repo (deps
  `twilio.ts:266`, `:568`).
- Readers: GET `/api/contacts/:contactId/listings-sent`
  (`app/src/routes/contacts.ts:1160-1191`, no filter), card `TenantFile.tsx:291-315`,
  fetch `useContactFile.ts:144`; GET `/api/units/:unitId/recipients`
  (`units.ts:939-984`, base table, no filter), card `ListingDetail.tsx:1022-1052`,
  fetch `useListing.ts:185`; the tour form default = first listings-sent row
  (`ContactDetail.tsx:1160-1163`, pin `ContactDetail.test.tsx:874`); seed history
  (E). Stale comment `api.ts:590-592` ("written by the response PATCH").
- Double: `twilioWebhookHarness.ts:3085-3134`: upsert mirror; `listByUnit` in
  INSERTION order (real: contactId order); `listByContact` sorts by sentAt with no
  sparse drop. No parity test exists.
- Pins: `listingSendsRepo.integration.test.ts:56-150`; `listingSendsApi.test.ts:39-340`;
  `broadcastFanOut.test.ts:979`, `:996`, `:1009`, `:1028`, `:1042`, `:1054`
  (swallowed ledger failure), `:2510` (rows before the record close);
  `sendReconcile.test.ts:385-387`, `:429-430`, `:456-457`, `:1826-1827`,
  `:1844-1854`, `:1898-1899`; `files.test.tsx:160-253`; e2e
  `matching-entry-points.spec.ts:103`, `:192`, `e2e/scenarios/steps.ts:1058`,
  `:1162` (all after a delivering send: keep).
- Seeds: lean has no shares and no ledger rows; full: `cast.ts:671-702` (2 rows,
  individual), `matrix.ts:1261-1286` (3 rows, one `broadcast-mx-sent-01`).

## G. The ops script shape D8 copies

- `app/scripts/lib/stageClient.ts`: `resolveStageClient(target, deps, opts)`
  (`:112-177`); `--lane L` local only (prefix `hc-local-L-`, key `hclaneL`,
  `:122-141`); a bare `--env local` is the human's live stack (`:5-10`, `:140`);
  dev/prod refuse any `AWS_ENDPOINT_URL*` (`:143-151`), run the ACCOUNT GUARD on
  the `housingchoice` profile (`:154-160`), pin the regional endpoint
  (`:161-168`). `parseStageArgs` (`:186-212`) refuses unknown or repeated args
  and `--lane` off local.
- `app/scripts/enable-conversation-automation.ts`: header (target, DRY RUN
  default, `--apply`, agents only on a lane, PII) `:1-72`; result/opts
  `:91-134`; entrypoint guard `:364-367`; usage exit 2 `:374-381`;
  resolve-before-run `:386-394`; `reportEnableRun` `:351-362`, exit `:405`;
  `stage.doc.destroy()` `:415`; every write conditional (header `:30-51`).
  Census twin `app/scripts/conversation-automation-census.ts` (read-only, Scan
  `:227`, entrypoint `:374-409`, exit `:404`). Tests `app/test/stageClient.test.ts`,
  `conversationAutomationCensus.test.ts`, `enableConversationAutomation.test.ts`.
- RUNBOOK section "One-to-one conversation automation switch (2026-09-25)"
  (`RUNBOOK.md:337-366`): census, dry run, apply, then prod; "No agent runs
  either script against dev or prod" (`:366`).
- Share indexes (`tables.ts:356-383`): `byCreated` (hash `_listPartition`,
  range `created_at`, `:371-375`; repo `list` `:687-690`) - absent: rows made
  before 2026-07-08 that `app/scripts/backfill-broadcast-list-partition.ts`
  (`:1-9`, RUNBOOK `:233`) did not stamp; `byUnit` (hash unitId, sparse,
  `:376-382`; repo `listByUnit` `:697-700`) - absent: unit-less shares. Walking
  byUnit needs a unit enumeration first.

## H. Harness

- Fake 30003: `setDeliveryOutcome(request, { partyNumber, profile: { kind:
  'fail', failState, errorCode } })` (`e2e/fixtures/fakeTwilio.ts:354-372`),
  used with undelivered/30003 at `retry-send-adoption.spec.ts:365-368`. Consumed
  by the NEXT create to that party (`fake-twilio/src/engine/engine.ts:512-516`);
  progression queued, sent, failState (`fake-twilio/src/engine/delivery.ts:18-19`),
  150 ms per step, so the failure lands about 300 ms after the send (`:29-31`).
  `failNextSend` (`fakeTwilio.ts:400-419`) and `failList` (`:423-429`); arming
  order trap `retry-send-adoption.spec.ts:47-52`.
- Lane seams: `E2E_SEND_RETRY_BACKOFF_MS: '10000'` (`scripts/e2e-session.mjs:283`),
  read by `resolveSendRetryBackoffMs` for EVERY rung while `JOBS_QUEUE_URL` is
  unset (`app/src/jobs/retrySend.ts:163-185`); `E2E_SEND_RECONCILE_DELAYS_MS:
  '2000,4000,8000'` (`e2e-session.mjs:296`, read `sendReconcile.ts:210-215`).
- Lean world (`app/src/lib/seed/lean.ts:39-52`): Tasha `contact-tenant-0001`
  (2 BR, consent), Dario `contact-tenant-0002` (1 BR, conv-0002 manual);
  `unit-0001` under_application, `unit-0002` occupied - neither shareable, so
  share specs build an available unit and fresh consented tenants on unique
  numbers (never arm a seed number: an unconsumed arming survives until the
  once-per-suite reset, `fakeTwilio.ts:374-381`).
- Specs: `share-skip-fix.spec.ts` (helpers `createUnitViaApi` `:50`,
  `createTenant` `:80`, `shareViaApi` `:104`, `slotConversationId` `:131`,
  `openReviewRow` `:144`; afterAll reseed `:38-40`);
  `send-outcome-reconcile.spec.ts` (`createAvailableUnit` `:137`,
  `createConsentedTenant` `:168`, `shareViaApi` `:186`, `openResults` `:204`,
  `recipientRow` `:212`; tests `:362`, `:420`, `:491`); `broadcasts.spec.ts`
  (`:96`, `:268`); `retry-send-adoption.spec.ts` has NO share cases (it asserts
  `broadcast_id` undefined on one-to-one retries, `:400`, `:484`), but `pollRow`
  (`:192`), `expectCreateLanded` (`:215`), `expectFailureStamped` (`:233`) are the
  retry-timing precedent; `one-to-one-30003-retry.spec.ts` is the promise-chip
  precedent.
- Selectors: `e2e/support/broadcastSelectors.ts` (`statValue` `:26-33`,
  `statusPill` after it); convention row `e2e/support/selectors.md:116` (chip
  labels, pill and row scoping, "A failed row's link carries open conversation
  to retry") - B updates it for the Retrying chip and the new hint rule; the
  one-to-one promise row is `selectors.md:50`.

## I. Message copy

- The catalog is `app/src/messages/catalog.ts` ("every automated/pinned message
  the system sends", `:1-8`); AGENTS.md:324 scopes the rule to automated
  user-facing copy. None of B's new words is a message sent to a person, so
  none goes through the catalog.
- Where the words live: share labels, the Retrying chip and the hint are
  dashboard copy (`broadcastFormat.ts`, `StatChips.tsx`, `BroadcastResults.tsx`),
  like the existing staff reasons (`deliveryStatus.ts:961-963`, `:1041-1043`,
  `:1116-1117` say staff copy never goes to the catalog). But two are composed
  APP-side: the landlord "Sent to N tenants" / "No tenants reached" label
  (`contactTimeline.ts:690-698`) and the tenant milestone words (stored label
  `broadcastFanOut.ts:1223`, mapped `contactTimeline.ts:663-673`). Staff
  timeline labels, not automated sends: still not catalog copy, but not
  "dashboard-only" (M11).
- ASCII: new labels, comments and test names must be ASCII (AGENTS.md:315-317).
