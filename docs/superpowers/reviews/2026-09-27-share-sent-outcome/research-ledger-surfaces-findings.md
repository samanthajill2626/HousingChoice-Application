# Research: the listing-send ledger and the surfaces that say a property was sent

Date: 2026-09-27. Reader: read-only research for the share-skip-fix Branch B
("counted as sent") planner. Code: `W:\tmp\share-sent-outcome` = main @d9cb5c04
(clean). Every claim cites `file:line` as read at that commit. UNVERIFIED marks
anything not provable from the repository. Verbatim excerpts backing these
claims (with their source paths and line numbers) are in the gitignored scratch
file `.superpowers/sdd/research-ledger-surfaces-reference.md`.

Vocabulary (documentation/GLOSSARY.md:24-31): code/data say `unit`; staff
surfaces (the property page, the contact page, the timelines) say "property";
tenants say "home". "Property sent", "Properties sent", "Sent to tenants" and
"Sent to N tenants" are all staff copy, so "property" is the correct word there.

---

## 0. Headline

1. The ledger (`listing_sends`) has NO status, flag, delete or TTL: a row, once
   written, counts forever. Nothing in the codebase can un-count a pair today.
2. Exactly ONE runtime writer exists: `recordPropertySent`
   (app/src/jobs/broadcastFanOut.ts:1208-1252), called by the fan-out's success
   path and by the send.reconcile adoption of a sent/delivered message. It
   writes the `listing_sent` milestone AND the ledger row together.
3. The fan-out writes both AFTER the A2P token acquire, which follows the slot
   write (broadcastFanOut.ts:941-949, 817-831), while a carrier failure callback
   may land any time after the send. The ledger upsert is unconditional
   (app/src/repos/listingSendsRepo.ts:164-172). Any un-count put in the
   callback can therefore be overwritten by the later upsert - the hermetic
   fake fails a message about 300 ms after the send
   (fake-twilio/src/engine/delivery.ts:18-19, 28-30).
4. No failure path touches either row: the status webhook rolls a failure into
   the broadcast slot and stats only (app/src/routes/webhooks/twilio.ts:3853-3984)
   and has no activity-event or ledger repo at all. That is the whole cause of
   the open issue `tenant-timeline-property-sent-milestone-after-failed-delivery`.
5. Retries are invisible to shares: both the automatic 30003 retry
   (app/src/jobs/retrySend.ts:317-328) and the staff Retry
   (app/src/routes/api.ts:1676-1688) re-send with `retryOf` but WITHOUT
   `broadcastId`, so the retry row has no `broadcast_id`, its receipts never
   reach the slot (twilio.ts:3529), and a `failed` slot is terminal anyway
   (twilio.ts:3840-3844).
6. Prerequisite 4 of the stub (the `retrySend` adoption, SOR Stage 1b) is NOT
   on main: retrySend.ts has no send-attempt record, and
   `docs/issues/retry-send-lost-under-job-marker.md` is `status: open`
   (line 6). That issue states Stage 1b keys the retry's attempt record on "the
   ORIGINAL message and the retry rung (not on a recipient of an owner)" - a
   second record family per share recipient.
7. SOR's send-attempt record expires 30 days after its last claim/re-arm and
   never records a delivery (app/src/repos/sendAttemptsRepo.ts:10-15, 47-48,
   187-189; the webhook, retrySend and the staff Retry never touch it). It
   cannot be the durable source of "any attempt delivered" or of repaired
   history; the only durable per-(share, recipient) record is the broadcast
   slot.
8. The property Activity "Sent to N tenants" counts EVERY recipient slot
   (skipped, failed and unconfirmed included) and is written even when the share
   finalizes `failed` (broadcastFanOut.ts:1526-1552). The audit trail is
   append-only (app/src/repos/auditRepo.ts:36-52), so history can only be
   relabeled at read time.
9. No matching / audience code reads the ledger today, and `getByKey` has no
   runtime caller (only its integration test and the harness fake). The
   Amendment No. 1 "at scale, direct lookup" reader is UNVERIFIED (not in code).
10. Three different "sent" notions coexist: the ledger/milestone (accepted
    once, never retracted), the composer's "Already sent" (non-skipped slots of
    `sent`/`sending` shares, read from `broadcasts`, not the ledger:
    app/src/repos/broadcastsRepo.ts:702-745), and the Activity count (all slots).

---

## 1. The ledger: `listing_sends`

### 1.1 Table (app/src/lib/tables.ts:402-425)

- PK `unitId`, SK `contactId`: one row per (unit, contact) pair (tables.ts:410-417).
- GSI `byContact`: hash `contactId`, range `sentAt` (tables.ts:418-424), projection
  ALL for every GSI (tables.ts:60).
- No `ttlAttribute`, no stream (the spec object at tables.ts:415-425 has neither;
  tables.ts:414 says "No stream"). Rows never expire.
- Items are flexible documents: only the key and the GSI key attributes are
  contractual (tables.ts:5-8; listingSendsRepo.ts:20-21), so new item fields need
  no tables.ts or Terraform change. Changing tables.ts is a contract change that
  must be logged in the README Deviations table (tables.ts:10-19).

### 1.2 Item fields (listingSendsRepo.ts:36-51)

`unitId`, `contactId`, `sentAt` (ISO, "when the property was (most recently)
sent"), `via` (`'broadcast' | 'individual'`, :33), optional `broadcastId`,
`created_at`, `updated_at`. No status, no flag, no per-share history.

- Runtime writes only `via: 'broadcast'` (broadcastFanOut.ts:1242). `'individual'`
  appears only in seeds (app/src/lib/seed/cast.ts:676, 699;
  app/src/lib/seed/matrix.ts:1275, 1282) and a test
  (app/test/contactsBatchReads.test.ts:151). Individual sends ARE seeded
  broadcasts (app/src/routes/units.ts:929-932).

### 1.3 `recordSend` semantics (listingSendsRepo.ts:136-178)

- One `UpdateCommand` with `SET sentAt, via, updated_at = :now,
  created_at = if_not_exists(created_at, :now)` (:144-149), plus `SET broadcastId`
  when supplied else `REMOVE broadcastId` (:156-161).
- NO `ConditionExpression` (:164-172): an unconditional upsert. "Idempotent" means
  one row per pair only; a re-run moves `sentAt`/`updated_at` to the new "now"
  (:137-138) and overwrites `broadcastId` with the latest caller's.
- So `sentAt`/`broadcastId` always describe the LATEST recordSend call (latest
  provider-accepted share), never the latest COUNTED share. Earlier shares of
  the same pair are not remembered anywhere on the row (header :14-19).

### 1.4 Reads

- `getByKey(unitId, contactId)`: GetItem, eventually consistent (:125-133).
  Runtime callers: NONE. Only app/test/listingSendsRepo.integration.test.ts:112-120
  and the harness fake (app/test/helpers/twilioWebhookHarness.ts:3072-3075).
- `listByUnit(unitId)`: base-table Query paged to exhaustion via `queryAll`
  (:182-190), no `ScanIndexForward`, so rows come back ascending by `contactId`
  (the SK) - NOT by date. `queryAll` pages on the key, never the count, and caps
  at 100 pages (app/src/lib/dynamoPaging.ts:20, 40-49).
- `listByContact(contactId)`: `byContact` GSI Query, `ScanIndexForward: false`
  (newest `sentAt` first), paged to exhaustion (:192-202). GSI reads are
  eventually consistent (no consistent option on a GSI - DynamoDB rule).

### 1.5 Can a row be un-counted today?

No. The interface has `recordSend`, `getByKey`, `listByUnit`, `listByContact`
only (:83-96); no code deletes or updates a row other than `recordSend`
(grep of `recordSend|listing_sends|listingSends.` over app/src, app/scripts,
scripts: only broadcastFanOut.ts:1239 writes). No TTL (1.1). There is no field a
reader could filter on.

### 1.6 What "a counted pair describes its latest counted share (date and id)" needs

- The row must know which OTHER shares of the pair still count, because un-counting
  the latest share must fall back to an earlier counted share's date and id. The
  row has no such memory (1.3). Two sources exist:
  - on the row: a per-share map (e.g. broadcastId -> date/state), bounded by the
    number of shares of one unit to one tenant; or
  - at write time: `broadcasts.listByUnit(unitId)` (byUnit GSI, paged;
    broadcastsRepo.ts:697-700) and each share's slot for this contact. Each share
    item carries its whole recipients map, up to 1500 slots
    (broadcastsRepo.ts:56-68).
- DynamoDB update expressions cannot compute "max date over a map" or "any entry
  counted", so a map-based row needs read-modify-write under an optimistic
  condition (e.g. on `updated_at`, which every recordSend already bumps,
  listingSendsRepo.ts:147, or a new version counter).
- `sentAt` is the byContact range key, so it IS the "Properties sent" order and
  the tour form's default property (3.1). Whether "date" means the share's first
  accepted attempt or the attempt that counted (a later retry) is not decided by
  the stub (open question Q5).
- The dashboard never renders `sentAt`, `broadcastId` or `via`: both roster cards
  show only the identity link and a tour chip (dashboard/src/routes/contact/Card.tsx:218-240)
  and use `sentAt` only in React keys (TenantFile.tsx:308, ListingDetail.tsx:1040).

---

## 2. Writers

### 2.1 The one writer: `recordPropertySent` (broadcastFanOut.ts:1202-1252)

- Writes the milestone first: `activityEvents.record({ type: 'listing_sent',
  label: 'Property sent', refType: hasUnit ? 'unit' : 'broadcast',
  refId: hasUnit ? unitId : broadcastId })` (:1219-1226).
- Then, ONLY when the share has a unitId, `listingSends.recordSend({ contactId,
  unitId, via: 'broadcast', broadcastId })` (:1237-1244).
- Both best-effort: a throw is logged at ERROR and swallowed (:1227-1232, :1245-1250).
  A swallowed ledger failure is never retried - a permanent gap the repair could
  fill (pinned by app/test/broadcastFanOut.test.ts:1054-1084).
- The comment at :1214 says "a delivered property"; the call actually runs at
  dispatch (below), not on delivery.
- `contactId` is the RESOLVED contact's id (:828, :1459), so a slot keyed
  `phone#<E164>` (app/src/routes/broadcasts.ts:738-741) lands in the ledger under
  whatever contact held that phone at send time (resolveContact,
  broadcastFanOut.ts:1192-1200).

### 2.2 Call site 1: the fan-out success path

Order inside one recipient (broadcastFanOut.ts:931-958, 817-832):
1. `sendMessage(...)` returns (provider accepted; row appended with `broadcast_id`).
2. Slot `queued -> sent` + stats in one conditional write (:941-947), then the
   progress emit (:948).
3. `afterSend` (:949): A2P token acquire FIRST (:822-826), then
   `recordPropertySent` (:827-831).
4. `finishAttempt(... 'sent')` on the send-attempt record (:950).

Facts that matter for D6:
- The ledger is written at "dispatch + token wait", before any carrier callback
  is known. The slot's own `sent` is "stamped at DISPATCH ... EARLIER than the
  carrier's own sent" (broadcastsRepo.ts:141-146).
- The token acquire precedes the ledger write. The bucket starts full with
  capacity = the per-second rate (app/src/worker.ts:92-106; default 1/s,
  .env.example:131), so the gap is ~0 for the first recipient of a burst and up
  to ~1 s for the next ones. The code itself says a delivery callback "can fire
  within the ~1s token gap" (:932-935).
- `afterSend` runs even when the slot write did NOT move (:941-949 - it is not
  gated on `recorded.moved`). A takeover race (a reconcile adopting the same
  attempt) can therefore record the milestone twice: activity events are never
  deduped (app/src/repos/activityEventsRepo.ts:9-14, 125-141).

### 2.3 Call site 2: the reconcile adoption (SOR D15)

- `adoptBroadcastRecipient` moves the slot from `queued` only (:1403-1416; returns
  `skipped` without property rows when the slot did not move) and calls
  `recordPropertySent` only when the adopted slot is not `failed`
  (:1456-1464, "A message the carrier says never arrived must not count as a
  property sent"). An adopted failure writes no property rows (:1465-1478).
- Wired by app/src/jobs/sendReconcile.ts:346-347 and called at :614-630.
  The stub's "SOR's adoption writes the row only when it adopts as sent or
  delivered" matches the code.
- Unresolved closes (`send_unconfirmed`), re-drive refusals and enqueue failures
  close the slot `failed` and write no property rows (sendReconcile.ts:921-942,
  broadcastFanOut.ts:554-583, 782-811). So "do not count `send_unconfirmed` in
  the ledger" is today's behavior.

### 2.4 Paths that do NOT write the ledger or the milestone

- The status webhook's broadcast rollup (twilio.ts:3520-3545, 3853-3984): slot +
  stats only. `grep activityEvents|ListingSends` on twilio.ts: no match.
- Fan-out rejections, refusals, fences, deferrals, cap closes
  (broadcastFanOut.ts:636-774, 987-1016, 419-479): slot only.
- `retrySend` (retrySend.ts:303-328) and the staff Retry route
  (api.ts:1567-1697): no `broadcastId`, no property rows.
- The Quo import and every ops script: no `activity_events` / `listing_sends`
  reference under app/src/lib/import or app/scripts.
- Dev seams (app/src/routes/dev.ts): only a roster-actions tick builds an
  activity repo (:467-485); nothing writes the ledger.

### 2.5 Seeds

| Fixture | Ledger rows | listing_sent milestones |
|---|---|---|
| lean.ts (byte-stable e2e world) | none | none |
| cast.ts:671-702, 1574-1577 (full only) | 2 rows, `via: 'individual'`, no broadcastId | generated by history.ts |
| matrix.ts:1261-1286 (full only) | 3 rows: 1 `via: 'broadcast'` backed by `broadcast-mx-sent-01`, 2 `individual` | hand-authored :1338, superseded by history for covered contacts (history.ts:1130-1139) |
| history.ts:996-1009, 1127 (full + live) | - | ONE `listing_sent` "Property sent" per ledger row, at `sentAt` |
| performance.ts:129-138 / performanceSeed.ts:47-56 | none (no `listing_sends` table key) | none |

- Profiles: lean = SEED only; full = lean + cast + matrix, then historyItems
  regenerates `activity_events` (app/src/lib/seed/index.ts:117-144).
- `broadcast-mx-sent-01` has ONE slot, `delivered`, with no conversationId/tsMsgId
  (matrix.ts:1230-1232) - it cannot be followed to a message.
- Performance broadcasts: slots `delivered` / `failed` (`synthetic_failure`) /
  `queued`, no message pointers (performance.ts:986-993, 1013-1049); the perf
  seed test pins an empty ledger (app/test/performanceSeed.integration.test.ts:326-327).
- cast.ts:110 defines `listingSendId`, which nothing uses.

---

## 3. Readers

### 3.1 Tenant page "Properties sent" + the tour form default

- API: `GET /api/contacts/:contactId/listings-sent` (app/src/routes/contacts.ts:1154-1191):
  404 for unknown/pointer contacts, then `listByContact` (newest-first by
  `sentAt`), then ONE `tours.listByTenant` Query to attach a tour chip
  (best-effort), projected by `toListingSendRow` (listingSendsRepo.ts:104-118). No
  filter, no re-sort, no share read.
- Dashboard: `getContactListingsSent` (dashboard/src/api/endpoints.ts:1384-1395);
  card "Properties sent" renders rows in wire order (TenantFile.tsx:291-315).
- Tour form default property: `rows[0]?.unitId` of the same slice
  (ContactDetail.tsx:1156-1163), i.e. the pair with the newest `sentAt`. Pinned by
  dashboard/src/routes/contact/ContactDetail.test.tsx:874-898.
- Consequence today: a later share whose text then FAILED still moves the pair to
  the top and becomes the tour default, because `sentAt` was refreshed at
  acceptance and nothing reverts it (1.3, 2.4).

### 3.2 Property page "Sent to tenants"

- API: `GET /api/units/:unitId/recipients` (units.ts:934-984): 404 for unknown
  unit, `listByUnit` (order = contactId ascending, 1.4), ONE `tours.listByUnit`
  Query for chips, ONE `contacts.getDisplaysByIds` BatchGet for names. No filter.
- Dashboard: `getUnitRecipients` (endpoints.ts:1074-1085); passed through unsorted
  (useListing.ts:174-189, 204-216); card at ListingDetail.tsx:1022-1052.

### 3.3 Tenant timeline "Property sent" milestone

- Read by `GET /api/contacts/:id/timeline`: `activityEvents.listByContact(contactId,
  { limit: limit + 1, before })` merged with the contact's messages
  (app/src/routes/contactTimeline.ts:1282-1289), mapped verbatim by
  `toTimelineMilestone` (:652-663). The dashboard renders the stored label and
  deep-links by refType (`unit` -> `/listings/<id>`, `broadcast` ->
  `/broadcasts/<id>`) (dashboard/src/routes/contact/Timeline.tsx:439-474).
- Why it still says "sent" after a failed delivery: it is an append-only row
  written at dispatch (2.2); the failure callback updates only the slot and stats
  (2.4); the activity repo has no update or delete (activityEventsRepo.ts:102-110).
- The row carries NO broadcastId for a unit-targeted share (refType `unit`,
  refId unitId, :1224-1225), so a later retraction cannot find "this share's"
  milestone by key: it would have to search the contact's partition by
  (type, refId, time), or the writer must keep the event's key (`record()`
  returns the item with `tsEventId`, activityEventsRepo.ts:125-147, but
  recordPropertySent discards it, broadcastFanOut.ts:1220-1226).
- Granularity: one milestone per (share, recipient) accepted; one ledger row per
  (unit, contact) pair; a unit-less share (unitId is optional on the draft route,
  broadcasts.ts:393-407) writes a milestone with refType `broadcast` and NO
  ledger row (broadcastFanOut.ts:1217-1251).
- Volume note: the roster-actions job scans up to 10 pages x 25 of a contact's
  activity events (app/src/jobs/rosterActions.ts:236-237, 270-294); any design
  that ADDS events per share (e.g. a "not sent" event) spends that budget.

### 3.4 Landlord timeline "Sent to N tenants" pins

- Built server-side from `units#<unitId>` `broadcast_sent` audit rows: 1 byLandlord
  Query (limit 25) + 1 audit Query per owned unit (limit + 1 rows)
  (contactTimeline.ts:1299-1330; MAX_LANDLORD_UNITS = 25 at :283;
  LANDLORD_FEED_TYPES :308-313).
- Each pin is synthesized with `type: 'listing_sent'` (a colour bucket),
  `label: "Sent to N tenant(s)"` from `tenantCount`, refType `broadcast`
  (:680-689). A design that filters or retracts by `type === 'listing_sent'` must
  not assume every such pin is a stored milestone.
- This route is one of the dashboard's hottest reads: the contact page and both
  one-to-one tabs refetch it on every debounced SSE burst (contactTimeline.ts:1363-1366).

### 3.5 The composer's "Already sent" (D5(a); reads broadcasts, not the ledger)

- `priorRecipientContactIds(unitId)`: pages the byUnit GSI, keeps shares whose
  status is `sent` or `sending`, and adds every slot key that is not `skipped`
  (broadcastsRepo.ts:702-745, rule at :716 and :731). A `failed` share is excluded
  whole; `failed` slots of a `sent` share still count (interim rule, comment
  :718-730).
- Used by the preview route for `alreadySentThisProperty` (broadcasts.ts:516-524,
  547-549) and returned as `priorRecipientContactIds` (:569). Mirrored in the
  harness (twilioWebhookHarness.ts:3318).
- Pinned by e2e/tests/dashboard-next/share-skip-fix.spec.ts:250-285 (a 30007
  failure in a `sent` share stays "Already sent" - the test Branch B must flip)
  and broadcasts.spec.ts:174.
- Open issue `unconfirmed-share-invites-resend` (status open) asks that a
  `send_unconfirmed` slot count here whatever the share's status.

### 3.6 Matching / audience resolution

- No reader. `grep listingSends` over app/src finds only the fan-out, the
  reconcile wiring, the two routes, api.ts wiring and the perf readers
  (performanceSeed.ts:169). app/src/services/audienceResolution.ts has no ledger or
  broadcast-history read. `getByKey` is unused at runtime (1.4).
- The Amendment No. 1 "matching reads it at scale" reader: UNVERIFIED (no code, no
  in-repo document describes it; the only mention is the stub itself,
  docs/superpowers/specs/2026-09-25-share-sent-outcome-design.md:59).

### 3.7 Tests and specs that pin today's behavior

- Ledger repo: app/test/listingSendsRepo.integration.test.ts:56-150 (upsert,
  created_at preserved, both directions, getByKey, newest-first).
- Routes: app/test/listingSendsApi.test.ts:38-141 (both routes), :143-161 (same row
  both ways), :163-299 (tour chips), :301-320 (the old response PATCH is gone),
  :322+ (upsert).
- Fan-out: app/test/broadcastFanOut.test.ts:978-1006 (milestone per sent
  recipient, none for skipped), :1008-1052 (ledger rows, none unit-less / skipped),
  :1054-1084 (ledger failure swallowed), :2510-2546 (ADV-6: one milestone + one row
  after a record-close throw).
- Reconcile: app/test/sendReconcile.test.ts:377-379, 421-422, 448-449 (rows only on
  sent/delivered adoption), :1818-1819, :1836-1846 (unit-less adoption: milestone,
  no row), :1890-1891.
- Other: app/test/contactsBatchReads.test.ts:151, app/test/repoPagingWiring.test.ts:58-65,
  app/test/tables.test.ts:86, app/test/genTables.test.ts:82,
  app/test/seedHistory.test.ts:594-607, app/test/seedMatrix.test.ts:237-242,
  app/test/performanceSeed.integration.test.ts:326-327; the harness fake
  twilioWebhookHarness.ts:3036-3085 (its `listByUnit` returns insertion order, not
  contactId order - a small divergence from the real repo).
- Dashboard: dashboard/src/routes/contact/files.test.tsx:160-223,
  ContactDetail.test.tsx:874-898 (tour default = newest `sentAt`).
- e2e: e2e/tests/dashboard-next/matching-entry-points.spec.ts:163-189 and :246-267
  (poll the two APIs, then the cards), e2e/scenarios/steps.ts:1035-1070 and
  :1160-1165 (listings-sent + the "Property sent" link), listing-activity.spec.ts:195-209
  (both recipients land). None asserts an un-count.
- Hermetic seams a Branch B spec can use: `setDeliveryOutcome` fail profile
  (e2e/fixtures/fakeTwilio.ts:354-373; fail lands at ~300 ms,
  fake-twilio/src/engine/delivery.ts:18-19, 28-30) and the lane's
  `E2E_SEND_RETRY_BACKOFF_MS: '10000'` (scripts/e2e-session.mjs:283;
  honored only with JOBS_QUEUE_URL unset, retrySend.ts:92-117).

---

## 4. The property Activity entry "Sent to N tenants"

### 4.1 Writer: `finalize` (broadcastFanOut.ts:1497-1575)

- Only the writer that wins the `sending -> sent|failed` flip appends
  `units#<unitId>` / `broadcast_sent` with `{ broadcastId, tenantCount: slots.length }`
  (:1538-1552). `slots` is every recipient slot (:1526), so N includes skipped,
  failed and unconfirmed recipients.
- It is written for a `failed` finalize too (the append is gated only on `won` and
  a unitId). An all-skipped share finalizes `sent` (:1532-1535; pinned
  broadcastFanOut.test.ts:2622-2626) and still gets "Sent to N tenants". These
  are the conformance-review finding 3 the stub cites (stub :39-47).
- Unit-less shares write none (:1546; test :285-294).
- A second, unrelated `broadcast_sent` row is appended to `broadcasts#<id>` at send
  start with `{ actor, count }` (broadcasts.ts:777-780). Nothing reads
  `broadcasts#` audit rows (grep: writers only, broadcasts.ts:463, 777, 889).
- The audit repo is append-only: `append`, `transactPut`, `listByEntity` only
  (auditRepo.ts:36-78). History cannot be rewritten.

### 4.2 Readers

- `GET /api/units/:unitId/activity` (units.ts:1229-1276): one `listByEntity` Query,
  `limit` default 50, max 100 (units.ts:215-216, 240-246, 1253); projection keeps
  `broadcastId` and `tenantCount` (:183-213). The dashboard asks with the default
  (endpoints.ts:1105-1114). Label built client-side:
  `Sent to ${n} tenant(s)`, `n = 0` when absent (dashboard/src/routes/listing/listingFormat.ts:130-136;
  pinned listingFormat.test.ts:180-191, including "Sent to 0 tenants").
- Landlord timeline (3.4): label built server-side (contactTimeline.ts:680-689).
- Neither reads any share item today.

### 4.3 Cost of a per-share recount at render time

- Property Activity: one share read per `broadcast_sent` row in the page (at most
  the page size, 50 by default), batchable in one BatchGetItem (up to 100 keys).
- Landlord timeline: the interleave gathers up to 25 units x (limit + 1) audit rows
  BEFORE the merge (contactTimeline.ts:1304-1325) and slices to `limit` after
  (:1336-1340). A recount done after the slice costs at most `limit` share reads
  (default 50); done before the slice it could cost up to 25 x 51. Multiply by the
  SSE-driven refetch rate (3.4).
- Each share item carries its full recipients map, sized ~150-200 B per slot, up to
  1500 slots (~300 KB) (broadcastsRepo.ts:13-18, 56-68). A read is billed on the
  whole item size whatever the ProjectionExpression (DynamoDB billing rule, not in
  this repo - UNVERIFIED here). Typical shares are small (the matching page's
  one-to-one send is one recipient), so typical cost is one small read per entry.
- What the recount can derive: the slot statuses via `deriveBroadcastStats`
  (broadcastsRepo.ts:239-325). It cannot see retries (5.1), so a 30003 recipient
  whose retry delivered counts as failed unless the slot learns of the retry.
- Branch A's share label (`presentShareLabel`, dashboard/src/routes/broadcasts/broadcastFormat.ts:91-115)
  is the existing presentation-only derivation a relabel could reuse.

---

## 5. Data sources for the D6 repair

All tables are on-demand (tables.ts:14-15). The precedent scripts for a
dry-run-first, Cameron-run pass are app/scripts/conversation-automation-census.ts
(D1, Scan at :227) and app/scripts/enable-conversation-automation.ts (D2, Scan at
:339, every write conditional, header :1-40), sharing the stage/credential
resolver app/scripts/lib/stageClient.ts:1-30.

| Source | Key / index | Access pattern | Bounds and caveats |
|---|---|---|---|
| Ledger rows | PK unitId, SK contactId; GSI byContact | Enumerate ALL: Scan (no all-rows index), or a Query per unitId after enumerating units | O(table). No history per row (1.3). Seed-only `individual` rows have no share to judge. |
| Shares | GSI byUnit (sparse, unit-targeted only; broadcastsRepo.ts:697-700); GSI byCreated (single partition `_listPartition = 'broadcasts'`, tables.ts:371-375) | Query per unit, or one partition Query over all shares; GetItem by id | Keyed Queries, not Scans. Rows created before byCreated lack `_listPartition` until backfilled (tables.ts:368-370). Each item <= ~300 KB. |
| Slot | `recipients.<contactKey>` on the share (broadcastsRepo.ts:135-166, 193-196) | Read with the share | Durable, no TTL. Holds ONE attempt (`conversationId`, `tsMsgId`), `status`, `errorCode`, `carrierSentAt`. `failed` is terminal (twilio.ts:3840-3844). contactKey may be `phone#<E164>`. |
| Original message | messages PK conversationId, SK tsMsgId (`<provider ISO ts>#<SID>`, messagesRepo.ts:3-8) | GetItem from the slot's pointers; or `sid#<SID>` pointer GetItem (messagesRepo.ts:10-15) | `delivery_status` is forward-only, terminal never regresses (messagesRepo.ts:112-142). Carries `broadcast_id`, `recipient_contact_id`, `retry_due_at`. |
| Retry lineage | `retry_of` = tsMsgId of the attempt retried, `retry_attempt`, `retry_window_start`, written at append only (messagesRepo.ts:1037-1052, 2536-2545) | NO index on retry_of: messages has no GSI (tables.ts:211). Query the conversation partition with `tsMsgId > <original>` and filter `retry_of`; follow the chain hop by hop | A retry row has NO `broadcast_id` (5.1). Chains: auto retries up to 3 (retrySend.ts:51), staff Retries unbounded, each pointing at the attempt it retried (retrySend.ts:174, 325; api.ts:1574, 1685). A FilterExpression does not reduce the read cost of the thread tail. |
| Send-attempt records | messages PK `sendattempt#broadcast#<broadcastId>`, SK hashed contactKey (sendAttemptsRepo.ts:43-46, 176-181) | One Query per share | Only shares sent since SOR Stage 1 deployed (merged at 79b9479e; deploy date UNVERIFIED), only for 30 days after the last claim/re-arm (:47-48, 187-189, 258-259, 394-395). Outcomes sent/rejected/refused/adopted/unresolved/... (:55-64); no delivery, no one-to-one retries. |
| listing_sent milestones | activity_events PK contactId, SK `<at>#<eventId>`, no GSI (tables.ts:397-400) | Query per contact (filter type), or Scan | No broadcastId on unit-targeted milestones; match to a share only by (contact, unit, time). Not deduped (2.2). |
| Activity count rows | audit_events PK `units#<unitId>` (tables.ts:291-301) | Query per unit | Append-only; `tenantCount = slots.length`. |

Concurrency tokens for "never erase a live delivery or a post-deploy attempt":
- Ledger: `updated_at` is bumped by every `recordSend` (listingSendsRepo.ts:147), so a
  condition on the value the census read skips any row touched after the census.
- Slots: condition on the slot's own fields (`recipients.#ck.#status`, `tsMsgId`).
  The share item's `updated_at` is NOT a reliable token: `setRecipient` writes the
  slot without touching `updated_at` (broadcastsRepo.ts:824-833), and the webhook's
  `carrierSentAt` stamp uses it with no stats bump (twilio.ts:3923-3930).

Table sizes: UNVERIFIED (not knowable from the repo).

### 5.1 Why the retry half is hard (code facts)

- The retry row is appended in the SAME conversation with `retry_of` but without
  `broadcast_id` (retrySend.ts:317-328, api.ts:1676-1688, sendMessage.ts:330-336,
  658-663; messagesRepo.ts:2535-2545).
- Its receipts never reach a share: the rollup requires `message.broadcast_id`
  (twilio.ts:3529) and matches the slot by the ORIGINAL's conversationId + tsMsgId
  (:3887-3889).
- The open issue `broadcast-30003-retry-never-updates-slot` (status open) records the
  same, and names Branch B or the retrySend adoption as its closer.
- A pre-branch retry whose lineage was never written (a crash between send and
  annotate) is invisible to a lineage walk - the stub's accepted residual (stub
  :77-78). Since RSW, lineage is written at append (messagesRepo.ts:2536-2540), so
  that window applies to rows written before RSW merged.

---

## 6. The minimal schema change for D6, and what must change with it

### 6.1 Minimal row change (no tables.ts change needed for new fields, 1.1)

- A `counted` flag (or status) on the row, with ABSENT read as counted so legacy
  rows need no backfill and seeds stay valid.
- Per-share memory so a pair can fall back to its latest still-counted share (1.6):
  e.g. `shares.<broadcastId> = { at, attempt (tsMsgId), state, eventKey? }`.
  tsMsgIds sort by provider timestamp (messagesRepo.ts:3-8), so "a newer attempt"
  is expressible in a condition (`<` on the stored tsMsgId) - which is what makes
  the write order-independent against the callback (headline 3).
- Keep `sentAt` + `broadcastId` as the latest COUNTED share, maintained by
  read-modify-write under a condition (1.6).
- Hiding un-counted rows, two options:
  - keep `sentAt` and filter in `listByContact` / `listByUnit` (FilterExpression;
    `queryAll` is filter-safe, dynamoPaging.ts:45-47; un-counted rows are still read
    and billed); or
  - REMOVE `sentAt` on un-count so the byContact GSI drops the row (sparse by
    attribute absence is this codebase's documented convention, tables.ts:32-33,
    49-52); `listByUnit` (base table) still needs a filter. This changes what the
    contractual byContact GSI means (document it; tables.ts:10-19).
- Storing the milestone's key per share (`eventKey`) is what makes a per-share
  retraction a keyed write; the activity repo needs a new delete/update method
  (it has none, activityEventsRepo.ts:102-110).

### 6.2 Every consumer that changes with it

- app/src/repos/listingSendsRepo.ts (item type, recordSend, both lists, getByKey,
  toListingSendRow) and its fake (twilioWebhookHarness.ts:3036-3085).
- Writers: recordPropertySent (broadcastFanOut.ts:1208-1252) and its two callers
  (:827-831, :1456-1463); plus NEW un-count writers that do not exist today: the
  status webhook's rollup (twilio.ts:3949-3983, which would need a ledger and an
  activity repo injected - it has neither), and whatever records retry outcomes
  against the share (retrySend.ts / the staff Retry route / Stage 1b).
- Readers: contacts.ts:1160-1191, units.ts:939-984 (only if un-counted rows are not
  hidden by the GSI option or the repo).
- Dashboard: none if the server hides un-counted rows (both cards render the wire
  as-is, and never show sentAt/broadcastId, 1.6). dashboard/src/api/types.ts:2718-2730
  only if the wire shape gains a field.
- Seeds: none if absent = counted. history.ts:1000-1009 must skip an un-counted row
  if a seed ever carries one (it emits one "Property sent" per ledger row).
- tables.ts / Terraform: only for a new GSI (none required by 6.1).
- Tests: every file in 3.7.

### 6.3 Seed fixtures that would need the new field

Only if the field is REQUIRED (absent != counted): cast.ts:672-679, 695-702;
matrix.ts:1263-1284. Neither lean.ts nor performance.ts has ledger rows. A seeded
un-counted example would be new in the full world, and history.ts:1000-1009 would
have to skip it. Keep lean unchanged unless a spec needs it (lean is the
byte-stable e2e world, AGENTS.md).

---

## 7. Gaps between the stub (D5(c), D6, D6 repair, I9) and the code

- G1 (D6 "attempt is SOR's send-attempt record"): SOR's record is per
  (broadcast, contactKey) for the ORIGINAL send only, TTL-reaped after 30 days,
  and never learns of deliveries or one-to-one retries (headline 7). Stage 1b is
  not built; the issue says it keys retries on the original message + rung,
  i.e. a different record family (headline 6). "Every attempt belongs to the share
  that started it" then needs a join from the rung record (or the retry row) to
  the original message's `broadcast_id`.
- G2 ("per-recipient record is bounded (newest attempt plus a delivered flag)"):
  if it lives on the slot, the share item's budget is ~150-200 B x 1500 slots of a
  400 KB item (broadcastsRepo.ts:56-68). At the upper estimate, adding ~70 B per
  slot (a second tsMsgId plus a flag) gives 1500 x 270 B = ~405 KB before the rest
  of the item. Size it, or lower the cap. (Arithmetic from the repo's own
  estimates; real slot sizes UNVERIFIED.)
- G3 (I9 "a recorded outcome leaves failed only through a newly sent attempt"):
  every slot writer treats `failed` as terminal (twilio.ts:3840-3844;
  recordRecipientOutcome priors, broadcastsRepo.ts:537-579). A new failed ->
  sent/delivered transition and the retry's share attribution are both new work.
- G4 (D6 "order-independent against the carrier callback"): the only writer is an
  unconditional upsert running after the token wait (headline 3). Needs per-attempt
  conditions or tombstones; the existing fake timing will exercise the race.
- G5 (D6 "a counted pair describes its latest counted share"): no per-share memory
  on the row (1.3, 1.6).
- G6 (the issue's "retract on a final failure"): the milestone has no share id, no
  key kept, no delete API (3.3); and one pair can have several milestones (one per
  share) while the ledger has one row.
- G7 (D5(c) "one share read per entry, bounded by shares per property"): true for
  the property Activity page; on the landlord timeline it holds only if the recount
  runs after the merge/slice (4.3). The count also needs the retry fix (G3) to be
  right for 30003-then-delivered recipients.
- G8 (D5(c) must also relabel): the stored `tenantCount` counts all slots and is
  written for failed/all-skipped shares (4.1); only a render-time derivation (or a
  new superseding audit row, which the paged landlord interleave would have to
  dedupe) can relabel existing history.
- G9 (D6 repair "records historical retry attempts against their shares"): the
  durable home cannot be SOR's record (TTL, G1); the slot is the only durable
  per-(share, recipient) place (5). History older than RSW may lack lineage (5.1).
- G10 (D5(a)): the composer reads `broadcasts`, not the ledger (3.5); a ledger fix
  alone does not move "Already sent".
- G11 (prerequisites): 1-3 are merged (git log: a9f411f3 "RSW + Branch A merged",
  79b9479e SOR); 4 is not (headline 6).
- G12 (an un-count written from a slot or a message must hit the SAME ledger key):
  the ledger key is the contact resolved at send time (2.1). A slot key may be
  `phone#<E164>`, and the message row's `recipient_contact_id` is recorded only
  while that contact holds the thread's number (broadcastFanOut.ts:1316-1320,
  1380), so a later writer can derive a different contactId than the one the
  ledger row was written under.

## 8. Open questions for the planner

- Q1. Where does "any attempt delivered" live durably - the slot, the ledger's
  per-share map, or both (G1, G2, G9)?
- Q2. Is the un-count written by the webhook (needs new repo wiring and the
  order-independence condition), by a reconciler over slots, or both?
- Q3. Does a failed slot with a live `retry_due_at` count (the stub's open item)?
  Note `retry_due_at` is on the MESSAGE row (twilio.ts:3462-3467), not on the slot;
  the share results row cannot see it today (dashboard/src/routes/broadcasts/StatChips.test.tsx:173).
- Q4. Milestone policy: retract (delete/relabel by stored key), write later (on a
  counted outcome), or derive "Property sent" pins at read time from the ledger
  (byContact supports a bounded `sentAt < :before` Query, but only the LATEST share
  per pair would show, and stored historical milestones would need filtering)?
- Q5. What "date" a counted pair shows: the share's first acceptance, or the
  attempt that counted (a retry that delivered minutes later)?
- Q6. Hide un-counted rows by filter or by a sparse byContact (6.1)?
- Q7. Unit-less shares: milestone-only; does the rule apply to their milestone too?
- Q8. The repair census: Scan the ledger, or walk shares via byCreated/byUnit and
  derive the ledger from slots (which also fills rows lost to swallowed writes, 2.1)?
- Q9. Amendment No. 1's reader: confirm the access pattern (getByKey per pair, a
  per-unit Query, or a batch) before fixing the row shape (3.6).

## 9. Stale comments and drift noticed (not Branch B scope unless touched)

- app/src/routes/api.ts:574-576 says the ledger is "written by the response PATCH";
  that route is gone (app/test/listingSendsApi.test.ts:301-320).
- app/src/routes/units.ts:1237-1239 says property sends audit under `broadcasts#` and
  "don't appear here"; finalize writes `units#` `broadcast_sent`
  (broadcastFanOut.ts:1546-1548) and this route projects it (units.ts:155, 209).
- broadcastFanOut.ts:1214 "a delivered property" - written at dispatch (2.2).
- app/src/lib/seed/history.ts:562, 998 and app/test/seedHistory.test.ts:599 cite
  `broadcastFanOut.ts:308/309`; the writer is now at :1208-1252.
- GLOSSARY drift: the tour form's field is labeled "Unit" to staff
  (dashboard/src/routes/tours/ScheduleTourForm.tsx:367; ContactDetail.test.tsx:895);
  tables.ts:109-115 names a building-level `propertyId` / `byProperty`, while the
  GLOSSARY reserves "building"/"parcel" for a parent (GLOSSARY.md:56-64).
