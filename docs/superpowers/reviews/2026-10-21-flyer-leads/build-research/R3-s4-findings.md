# R3 delta findings - S4 (plan section 8, Tasks 4.1-4.5)

Reader: R3 (build research, phase 1). Live tree: W:\tmp\flyer-leads
(feat/flyer-leads @031a46d6; app/dashboard/e2e code identical to b7959e2a).
Rules: .superpowers/sdd/research/RESEARCH-RULES.md. Reference (anchor counts,
importer lists, byte-exact regions): .superpowers/sdd/research/R3-s4-reference.md.
Read: spec rev 6; plan sections 0-4; plan section 7 (S3, the names S4 calls);
plan section 8 (S4) line by line; R2-s3-findings.md (S3 holds: 0 BLOCKER,
0 MAJOR, so every S3 name S4 relies on is built as plan 2.1-2.4 and section 7
define it).

Counts: BLOCKER 0, MAJOR 0, MINOR 3, NOTE 5.

Static compile + logic check - what was checked and holds (no finding):

- Every name the S4 code calls exists in the live tree with the signature the
  plan uses, or is created by S3 exactly as section 7 writes it:
  - `createActivityEventsRepo(deps: RepoDeps = {})` (`activityEventsRepo.ts:134`;
    `RepoDeps` = `{ doc?, env?: NodeJS.ProcessEnv, logger? }`,
    `conversationsRepo.ts:532-538`); factory locals are `doc`, `table`, `log`
    (`:135-137`) as 3a uses them; `record` spreads `refType`/`refId` only when
    defined in BOTH the real repo (`:152-153`) and the fake (harness `:3576-3577`),
    so every `not.toHaveProperty('refType')` holds.
  - `queryAll<T>(doc, input, { logger })` (`lib/dynamoPaging.ts:29-56`) builds a
    NEW `QueryCommand({ ...input, ExclusiveStartKey })` per page, so
    `ConsistentRead` rides every page and the AR12 stub sees two distinct inputs
    with `requests[1].ExclusiveStartKey` = the cursor; the KEY ends the walk.
  - `activity_events` = hash `contactId`, range `tsEventId`, no GSIs
    (`lib/tables.ts:397-400`); SK `<at>#<eventId>` (`activityEventsRepo.ts:130-132`),
    so `tsEventId > :since` makes an event AT sinceIso count (window-edge
    cases hold for the real Query and the fake's string compare alike). The
    FilterExpression binds `:ref` only when used (no unused-value
    ValidationException).
  - `contacts.findByPhone(phone): Promise<ContactItem | undefined>`
    (`contactsRepo.ts:745`; real `:1287-1314` returns the first byPhone hit,
    deleted or not - GSI projection ALL, `infra/modules/dynamodb/main.tf:57`);
    contacts `isDeleted` (`contactsRepo.ts:412`) vs units `isDeleted`
    (`unitsRepo.ts:587`, already imported at `public.ts:46`) - the
    `isContactDeleted` alias is required and correct.
  - `ContactItem` requires only `contactId` + `type` and has an index signature
    (`contactsRepo.ts:113-377`); `last_heard_from_at` is the field the
    listings-sent route reads (`routes/contacts.ts:1327`).
  - `conversationTypeFor(contact: ContactItem | undefined)` at
    `lib/voiceMasking.ts:28-39` (landlord/tenant/partner, else unknown_1to1).
  - `ConversationsRepo.createOrGetByParticipantPhone(phone, type)` (`:560`),
    `setParticipantsIfAbsent` (`:714-717`), `touchLastActivity(id, preview, ts):
    Promise<ConversationItem>` (`:670-674`; real impl `:1626-1660` SETs status
    open, ALL_NEW, undefined preview leaves the stored one),
    `incrementUnread(id): Promise<number>` (`:719`, real `:1742-1757`). The
    real create-or-get adopts the phone claim's conversation even when CLOSED
    (`:1314-1330`), so R1 #6's spy test guards a real path.
  - `toConversationUpdatedEvent(item: ConversationItem)` at `lib/events.ts:89`
    (fields `conversationId, last_activity_at, unread_count, preview?, type,
    participant_display_name`); `EventBus.emit<K>(event, payload: AppEventMap[K])`
    (`:334-341`); `appEvents` (`:378`); production composition injects no bus
    (`app/src/index.ts:112`), so the default IS the SSE route's bus.
  - `formatAddress` (`lib/address.ts:112-126`): `{ line1: '12 Oak St', city:
    'Atlanta', state: 'GA', zip: '30303' }` -> `12 Oak St, Atlanta, GA 30303`;
    without zip -> `9 Pine Rd, Decatur, GA`; undefined -> `''` (unitId
    fallback). The FLYER_LABEL / unit-2 label strings are exact.
  - `CONSENT_VERSION = 'ctia-2026-06'` (`lib/smsCompliance.ts:91`, imported at
    `public.ts:43`); `AuditRepo.append(entityKey, eventType, payload?:
    Record<string, unknown>)` (`repos/auditRepo.ts:43`); route logs pino-style
    `log.<level>({...}, msg)` on `deps.logger` = the app logger
    (`app.ts:108`, `:192-200`) = the harness capture at level info
    (`twilioWebhookHarness.ts:5648`).
  - `ShareLedgerDeps` (`services/shareLedger.ts:33-36`); S3's
    `applyFlyerShareEntry` / `FlyerShareResult` / INFO line text /
    `seedFlyerSignUp(repo, { unitId, contactId, signedUpAt })` match S4's calls
    and string asserts verbatim (plan section 7 Task 3.3); `ledgerEntryFor(...,
    undefined, { kind: 'accepted' })` emits no `conversationId` key and
    `countedAt` = the ISO before `#` (`shareLedger.ts:49-58`,
    `shareAttemptOrder.ts:32-38`), so `flyerEntry(iso)` toEquals hold.
- Harness (`app/test/helpers/twilioWebhookHarness.ts`): option param is
  `opts` (`:5601`); `HarnessOptions` (`:5469-5590`) has `env` and the
  `relayGroupsNow` anchor (`:5538-5542`); the `public:` block (`:5761-5785`)
  passes the SAME world objects the tests spy on (`contactsRepo`,
  `conversationsRepo`, and after 3f `activityEventsRepo`, `listingSendsRepo`),
  and the public send service shares `world.conversationsRepo` + `world.events`
  (so a new contact's welcome is one `world.touches` entry with a body, then
  its own `conversation.updated`). FakeWorld shapes: `touches {conversationId,
  previewText, ts}` (`:300`), `unreadIncrements: string[]` (`:304`),
  `emitted {event, payload}` (`:409`, populated by bus listeners `:615-623`),
  `conversations: Map` (`:268`), `units: Map` (`:415`), `contacts`,
  `auditEvents {entityKey, event_type, actorId?, payload?}` (`:294-299`; extra
  keys non-enumerable, `:2657-2667`), `listingSends`, `toursRepo`. Fake
  create-or-get reuses an OPEN thread by phone only, any type (`:653-669`);
  fake touch returns the stored image BY REFERENCE and sets status open
  (`:673-687`); fake increment returns the new count (`:714-725`); fake
  findByPhone returns the first phone match (`:2254-2263`).
- Every Edit anchor S4 quotes occurs exactly once where the plan says
  (public.ts, activityEventsRepo.ts, the harness, the conformance suite,
  publicIntake, backfill test, contactTimeline EOF, the integration test);
  counts in the reference file. All 152 S4 code fences are at column 0 with
  content at the target file's own indentation (finding 4).
- NodeNext / strict / `noUncheckedIndexedAccess` (no
  `exactOptionalPropertyTypes`, `tsconfig.base.json`): every relative import has
  `.js`; no type-only import is used as a value; every indexed read uses `?.`
  or feeds an `expect`; `let flyerUnit: UnitItem | undefined` and `let touched`
  (assigned in try, catch returns) are definitely assigned; `unitId` narrows to
  `string` in the ledger branch; the `Partial<UnitItem>` / `Partial<ContactItem>`
  spreads type. No missing await.
- Logic vs rulings: AR3/AR8 (one `now()` after the welcome feeding window,
  pin `at`, touch `ts`, `signedUpAt`; one event for an existing contact; the
  LAST event carries the count for a new one - the welcome's own event is
  first and every new-contact assertion uses `.at(-1)`), AR11, AR12, R1 #6 -
  all implemented as ruled. No S4 test makes two flyer sign-ups on one pair at
  the same instant (S3's equal-instant `'refused'`).
- Expected REDs hold (the opt-out refusal is a `SendRefusedError`,
  `sendMessage.ts:121`, so the retargeted publicIntake case is red today; the
  kill switch throws before any touch, `:472-475`), except the reason wording
  in finding 1.
- Still compiles: `ActivityEventsRepo` has exactly two full implementers (the
  real factory and the harness fake); every other site takes the type or
  `Pick<..., 'record'>` (list in the reference); no Record / switch /
  `satisfies` over `ActivityEventType` in app/src, app/scripts, app/test; no
  app-dashboard drift test over the milestone union (the dashboard keeps its
  own, S5). `createPublicRouter` / `PublicRouterDeps` are used only by
  `app.ts` and the harness `public:` block. The only reader of the
  `housing_fair_signup` payload is `app/scripts/backfill-join-housing-authority.ts:226-229`
  (`signupVersion === 2` only). Only `publicIntake.test.ts` and
  `rateLimitClientKey.test.ts` post the endpoint; publicIntake `:166` and
  `:1161` are the only tests that expected an existing contact to be welcomed,
  and Task 4.2 rewrites both; no other test asserts touches / unread / emitted /
  activity events after a sign-up. The limiter store is per app instance
  (`middleware/rateLimit.ts:174`), so ~60 posts per file never accumulate.

## 1. MINOR - Task 4.4 Step 2: the CURRENT-decline case goes red on the S3 INFO-line assertion, not on `captured(...)`

Plan location: section 8, Task 4.4 Step 2 ("the decline / non-tenant /
ledger-failure cases fail on their captured(...) log assertion").

Before Task 4.4's implementation no ledger call happens, so in
`'a CURRENT decline holds: ...'` every assertion up to the INFO line passes
(flyer entry absent, sentAt SENT_AT, not_interested, one pin, unread 1) and the
first failure is
`capture.lines.some((l) => l['msg'] === 'share ledger: flyer entry not written - the pair holds a current decline')`
(false), one line BEFORE the `captured(...)` assertion. Plan section 0 asks the
builder to confirm each RED is red for the stated reason.

Correction: in Step 2 say the decline case fails on its share-ledger INFO-line
assertion; the non-tenant cases fail on `captured(...)` and the failure case on
its `ledger` step line, as written.

## 2. MINOR - spec section 5 "a new contact on the flyer ... the welcome refused: still the pin and unread" is tested on /join only

Plan location: section 8, Task 4.3 Step 1a, case
`'a NEW contact whose welcome is refused still gets the pin and the unread mark'`;
section D row "Spec 5 new contact on the flyer; welcome refused | 4.3 + 4.4".

That case posts `signupBody()` (no unitId), so it pins the /join label. The
spec bullet is the FLYER new-contact case: a refused welcome must still yield
the flyer pin (unit ref) and the unread mark - and, by D7, the flyer entry
(the ledger runs whatever the welcome did). Same code path, so it will pass;
it is a coverage gap against the spec list, not a defect.

Correction: in Task 4.3 make that case `seedUnit(world)` +
`post(app, signupBody({ unitId: 'unit-1' }))` and expect
`expect.objectContaining({ label: FLYER_LABEL, refType: 'unit', refId: 'unit-1' })`;
in Task 4.4 add one D7 case (or extend `'a NEW contact on a flyer: ...'` to an
`it.each` over `{}` / `{ SMS_SENDING_ENABLED: 'false' }`) asserting
`world.sent` length 1 / 0 and the `flyer` entry at `T0_ISO` either way.

## 3. MINOR - plan 8 B misquotes the backfill test's `event` helper

Plan location: section 8 B, "Tests to change", the
`app/test/backfillJoinHousingAuthority.test.ts` bullet (`:72-77`).

The plan quotes the helper as `({ entityKey: 'contacts#c-lead', ts: ..., event_type, ...payload })`
(payload spread at the TOP level). Live `backfillJoinHousingAuthority.test.ts:72-77`
nests it: `...(payload !== undefined && { payload })`. That nesting is what
the reader needs (`e.payload['signupVersion']`), and Task 4.5 Step 1c's code is
correct as written. Only the fact line is wrong.

Correction: fix the quoted fact; no code change.

## 4. NOTE - S4's code blocks are written at the target indent: use them as written, do not strip

Plan location: section 0 (R1 #13: "Code blocks under list bullets carry the
bullet's indent ... Strip that indent"); every S4 task.

R2 finding 1 shows three S3 blocks where that rule misleads. In S4 all 152
fences start at column 0 and every block's content is already at the target
file's own indentation (spot-checked about 25 Edit anchors against the live
lines, e.g. harness `:3586-3592` at 8 spaces, publicIntake `:1205-1210` at 10,
public.ts `:372-378` at 6, conformance `:1265-1270` at 10/8/6/4/2/0). Stripping
two spaces would break every one of them.

Correction (optional): one sentence at the head of section 8 C: "S4 blocks
are not bullet-indented; use them verbatim."

## 5. NOTE - the four new router-dep defaults are the production path and no app test exercises them

Plan location: plan 2.6 (defaults); Task 4.3 Step 3c, Task 4.4 Step 3c.

The harness injects `activityEventsRepo`, `listingSendsRepo`, `events` and
`now`, so the defaults (`createActivityEventsRepo`, `createListingSendsRepo`,
`appEvents`, `Date.now`) never run under vitest - yet production injects no
`public` deps (`app/src/index.ts:112`), so they ARE what ships. The plan's
default code is correct (and `appEvents` is the SSE route's bus). But a
regression such as `deps.events ?? createEventBus()` would pass every app
test: the live re-sort on open dashboards would be lost while reload reads
stay right, so S6's e2e catches it only if it watches a live inbox rather
than reloading (D6.3: "so open dashboards still re-sort the bumped row").

Correction (optional, cheap): one case that mounts `createPublicRouter` on a
bare express app (JSON parser + supertest) with the harness's own world
wiring MINUS `events`, subscribes to `appEvents` ('conversation.updated'),
posts one existing-contact sign-up and expects exactly one event
(unsubscribe in `finally`). Otherwise accept.

## 6. NOTE - AR8 #2's "one clock reading, AFTER the welcome" is not pinned by any test

Plan location: section 4 AR8 #2; Task 4.3 Step 3e (block (3a)).

The injected clock is constant within one request, so an implementation that
reads `now()` before the welcome, or twice, passes every S4 test. The visible
half - the mark's touch after the welcome's touch - IS pinned
(`world.touches` order `[false, true]` in the new-contact flyer case).

Correction (optional): in `harness()`, use `publicNow: vi.fn(() => clock.ms)`
and, in the new-contact flyer case, assert one call per post and that its
`invocationCallOrder` is after a spy on `world.adapter.sendMessage` (or the
public send service). Otherwise accept: the plan's code places the read
correctly.

## 7. NOTE - an unnamed reader of the unread mark: Today (Invariant E lists only the inbox and the unread feed)

Plan location: plan 3.1 Invariant E ("Readers: inbox, unread feed"); spec
section 4 surfaces; Tasks 4.2-4.3 (the thread type and the mark).

`dashboard/src/routes/today/buildToday.ts:305-316` files EVERY 1:1 thread with
`unread_count > 0` under "Unreplied" with `why: conv.preview ?? 'Unread message'`,
and `:287-303` files every OPEN `unknown_1to1` thread under needs-you-now
(the untriaged item, `:297`, attention true) whatever its unread count. After
S4:
- every NEW sign-up appears on Today as Unreplied, and its "why" is the
  welcome body - our own outbound text (the thread's preview);
- an existing contact's sign-up appears as Unreplied with the thread's last
  preview, which may be staff's own last text; a no-thread landlord / partner
  reads "Unread message";
- an existing `unknown` contact with NO thread now gets an `unknown_1to1`
  thread (`conversationTypeFor`, Task 4.2 3d) and therefore a needs-you-now
  untriaged item with no inbound behind it (before S4 that contact got a
  `tenant_1to1` thread and the welcome).

This is consistent with the spec's accepted inbox rule (D6.3: the row is
unread and on top, the preview stays the newest message) and with "in front
of staff", so no S4 code change is proposed. But the binding invariant table
does not name this reader, no e2e covers it (R6 reference: the only e2e Today
mention is `scenarios/participant-names.spec.ts:46`), and Sam will see it daily.

Correction: add Today (`buildToday.ts:287-316`) to Invariant E's readers as a
watch item; name it in the S4 slice report and in the handback so Cameron /
Sam know a new sign-up's Today line reads as "Unreplied: <welcome text>".

## 8. NOTE - one more residual for the S4 slice report: the 24-hour cap is keyed on the PIN, not on the bump

Plan location: section 8 E "Watch items / residuals" (which already records
"the audit cannot tell a repeat skip from a failed pin").

D6.1 keys the cap on a `signed_up` pin, and D6.4 makes the pin and the mark
independent best-effort steps (AR8 #4). So:
- pin written + touch failed: every same-source sign-up for the next 24 hours
  is a repeat, so the thread is NEVER marked unread for them;
- pin failed + mark written: the next same-source sign-up is not a repeat and
  bumps again.
The audit has no field for the mark, so only the
`housing-fair signup step failed` line (step `touch` / `increment`) records
the first case. Spec-defined fields and order (D6 steps 1-3); no change -
one line in the S4 slice report beside the existing residual.
