# Implementation plan - Today as the daily checklist (tracker #31)

- Spec (the contract - read it in full before Task S1.1):
  `docs/superpowers/specs/2026-10-23-today-checklist-design.md` (r6, APPROVED
  by Cameron 2026-10-24 with the backfill added). "Spec N.N" means its
  numbered sections; writers are W1-W8 (spec 7.3).
- Branch `feat/today-checklist`, worktree `W:\tmp\today-checklist`, cut from
  main @970a29b9. Mission records:
  `docs/superpowers/reviews/2026-10-23-feat-today-checklist/`.
- Spec review: 4 rounds -
  `docs/superpowers/reviews/2026-10-23-feat-today-checklist/design-review/adjudications.md`.
- Status: PLAN v1 (2026-10-24). Sections 0-4 are BINDING and written by the
  planner; slice sections 5-11 (S1-S7) are opus section drafts assembled verbatim.
  Section 4 (planner rulings PR1-PR40) wins over any slice text it
  contradicts. "Plan section N" always means this file's top-level sections.

## 0. Ground rules for this plan

- Every task is TDD: write the test, run it RED (and confirm it is red for
  the stated reason), implement, run it GREEN, commit. One commit per task
  unless the task says otherwise. A case marked (PIN) is a regression pin
  already green on unchanged code; every task still has at least one real
  RED case, except a task the plan marks comment-only or docs-only.
- Setup, once, before S1: if the worktree has no `node_modules`, run
  `npm ci` at the worktree root (bare; expect exit 0). Never symlink another
  worktree's node_modules. No new dependency is added by this plan.
- Commits: a separate bare `git status` read first, check
  `W:\AI Projects\Housing Choice\HC Application\.git\worktrees\today-checklist\MERGE_HEAD`
  is absent, explicit paths only (never `git add -A`), ASCII message ending
  with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  (or the authoring model's name). Use repeated `-m` arguments, or a message
  file OUTSIDE the worktree.
- Every new/touched line in code, comments, tests, copy and docs is ASCII.
  Check: `tr -d '\11\12\15\40-\176' < FILE | wc -c` prints 0 for a new file;
  for a pre-existing file that already carries non-ASCII (`routes/today.ts`
  holds `'Stuck — needs a check'` and a header arrow; many dashboard files
  carry em dashes), only ADDED lines must be ASCII:
  `git diff -U0 -- FILE | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c`
  prints 0. Never "fix" a pre-existing non-ASCII string a test pins.
- Never rewrite source with PowerShell `Get-Content | -replace | Set-Content`.
  Use the Edit tool. The Edit/Write tools DECODE `\u` escapes - after any
  edit near one, grep that the six-character escape survived.
- Run app tests from `app/` with `npx vitest run test/<file>`, dashboard
  tests from `dashboard/` with `npx vitest run src/<path>`, e2e only through
  the e2e workspace (`npm run e2e`, or `npm run e2e:session` + the
  Playwright MCP). Never pipe a test or gate command. App vitest runs need
  DynamoDB Local (`npm run db:start` STARTS it; never RESTART the shared
  container - it wipes local data; ask the human).
  `ALLOW_SKIP_DYNAMO_TESTS=1` is allowed ONLY for a pure-file red/green step,
  never for a gate. If the environment exports `AWS_ACCESS_KEY_ID`, run app
  tests as `env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY ...`.
- Never touch the live stack (`:5174` / `:8080`). Never run anything against
  AWS dev or prod: the backfill (S6) runs only against a hermetic lane
  (`--env local --lane <L>`), and only in S7.
- Never edit dashboard/app source while this worktree's e2e suite runs (it
  serves the source live). Never commit during it.
- Line numbers are hints against main @970a29b9; the QUOTED text is the
  anchor. Where an earlier task changed a region, re-read the current text
  and apply the change ON TOP of it - never revert an earlier task.
- Slice reports: `docs/superpowers/reviews/2026-10-23-feat-today-checklist/slices/S<n>-report.md`,
  ASCII, findings only (what the tree held that the plan got wrong, risks,
  watch-item results), citing code by `file:line`. A slice with nothing to
  report writes one line saying so. Commit it with explicit paths when the
  slice ends.
- Code blocks under list bullets carry the bullet's indent in this file.
  Strip that indent before using a block as an Edit anchor or as
  replacement text; the target file's own indentation is the authority.

## 1. Global constraints (from the spec; the spec wins on any doubt)

- Page order (spec 2): Needs you now; Identify these contacts; Past tours
  needing an outcome; Tours to book; Quiet shares; Relay groups to close;
  Placements; then a dashed divider and "At a glance" (Tours today, AI
  suggestions as one collapsed line). Unreplied is REMOVED (server and
  dashboard). Unmatched email is NOT added.
- Subtitle, exactly: "Clear every section above the line and today's
  checklist is done. New messages are in the Inbox."
- Help lines, exactly (spec 2.2): Identify, Tours to book, Quiet shares. No
  help line on the others.
- Every section shows 5 rows; "Show all N" expands in place, then "Show
  fewer". Quiet shares counts PROPERTY lines. Past tours keeps its Past-tab
  link beside its Show all button. Expansion is page state only.
- "All caught up" only when every checklist section (1-7) is empty AND
  settled AND none is unavailable AND the load is not the fallback. At a
  glance never blocks it and still renders below it.
- Section failure (spec 2.5): quiet shares and Tours to book are each
  computed in their own try/catch; any throw makes only that section
  unavailable, WARN with ids/counts only, route still 200. The dashboard
  shows "We couldn't load <section>." for it; on the fallback, ONE line
  "Some sections can't load right now.".
- Wire (spec 3): `TodayGroup` = needs_you_now | identify | tours_to_book |
  tours_today | follow_ups | ai_suggestions. `TodayItem.at?` and
  `TodayItem.unitLabel?` on tour rows only. `TodayResponse.quietShares` and
  `TodayResponse.toursToBook` as specced.
- Quiet rule (spec 6.1): quietSince = max(sentAt, heard if later, reached if
  later); threshold 48h (replied) / 120h (no_reply), fixed durations;
  shown when `now - quietSince >= threshold`. Candidates are exactly the
  Follow up core's waiting rows. Shares never move `last_reached_out_at`.
- The Follow up tab (`GET /api/broadcasts/follow-ups`) output is byte-for-
  byte unchanged.
- `last_heard_from_at` never moves on outbound. `last_reached_out_at` is
  never displayed.
- Stamps are best-effort: a failed stamp never fails, delays (beyond its
  awaited conditional write) or retries a send. One live event per send
  operation (spec 7.3).
- No Terraform, no GSI, no new table, no deploy, no dev/prod data write, no
  seed change (lean and full worlds byte-stable).

## 2. Work map (build order; each slice ends with its report and commit)

| Slice | Scope | Depends on |
|---|---|---|
| S1 | The signal: `last_reached_out_at` on ContactItem/RecipientDisplay/projection/SERVER_OWNED; `touchLastReachedOut`; `getRecipientDisplaysByIds` `consistentRead`; `recordStaffOutreach` helper; `conversationsRepo.getByIdConsistent`; harness and hand-rolled fakes; harness records `contact.updated` | - |
| S2 | Direct writers W1, W2, W3, W6, W8 and their events; no-stamp tests for every other `sendMessage` caller; inbound order fixes (inbound email, masked relay call); `tour.updated` on both tour-create paths | S1 |
| S3 | Relay and group writers W4, W5, W7; an event bus in `relayFanOut`; the after-loop fresh-read `conversation.updated`; no-stamp tests (30003 rung, non-intro announcements, reconcile adoption, dev intro replay) | S1 |
| S4 | Today server: Follow up core split; quiet-shares builder; `today.ts` (Unreplied removal, type-filter-first unread pass, `identify`, `tours_to_book`, tours_today `at`/`unitLabel`, unit labels, quiet shares, failure isolation); router deps and wiring; server tests | S1 |
| S5 | Dashboard Today: types mirror, `useToday` statuses, section components, 5-row limit, option C, At a glance, help lines, All caught up, fallback (`buildToday`), past-tours order and labeling; dashboard tests | S4 |
| S6 | Backfill script `app/scripts/backfill-last-reached-out.ts` + tests + RUNBOOK entry | S1 |
| S7 | e2e: new Today checklist spec, every existing spec that pins the old page, perf route terminals; a lane rehearsal of the backfill; docs (GLOSSARY, 2026-06-16 spec note, issues, events doc comments) | S1-S6 |
| S8 | Final: one main sync, the five bare gates, gate report | S1-S7 |

S2, S3, S4 and S6 touch disjoint files except where section 4 names a
shared file (PR37); build them in the order above anyway (one builder, one
tree).

## 3. Watch items (each is checked and the result recorded in a slice report)

- WI1 Follow up tab byte-identity (S4): `app/test/followUpsApi.test.ts` and
  `app/test/followUps.test.ts` pass with only the additive fake changes
  S1 makes; add one regression case that a set `last_reached_out_at`
  changes nothing in the Follow up route body.
- WI2 `sendMessage` contacts wiring (S2, PR9): moving the router's
  `contacts` construction above the service must not change which repo any
  other consumer gets. Record the before/after construction order.
- WI3 The whisper-gate no-await rule (S2, PR13): nothing awaited between
  the press-1 stamp and `sendTwiml`. A reviewer reads the diff of that
  handler line by line; record it.
- WI4 One event per send (S2, S3): every writer test counts the emitted
  events, not just their presence. Record the counts per writer.
- WI5 Relay continuation passes (S3): each fan-out continuation pass is its
  own job and may emit its own after-loop event. Record the number of
  passes a 30-member post takes in the test world.
- WI6 Reconcile re-drive (S3, PR17): a re-driven team-post leg stamps
  (it is the staff post going out for the first time to that member).
  Record that the test proves a manual 30003 rung does NOT.
- WI7 Today read budget (S4): record the Query counts one Today load makes
  in the harness for the spec 6.5 cost note and the new issue (S7).
- WI8 Eventual consistency (S4): Today's contacts batch is consistent
  (PR6); the units and listing-sends reads are not. DynamoDB Local is
  always consistent, so no test can see this; record it only.
- WI9 Lean seed byte-stability: no seed file is edited by this plan. If a
  test seems to need one, STOP and report.
- WI10 `TODAY_PAST_TOURS_CAP` (S5, PR30): record whether it is still used
  after S5; if not, it is removed with its pin.
- WI11 The fallback (S5): record when `buildToday` runs (only a 404 from
  GET /api/today) and that it never shows "All caught up".
- WI12 Backfill (S6/S7): the agent runs it only on a hermetic lane. The
  RUNBOOK says Cameron runs dev then prod after the deploy, dry run first.
- WI13 e2e named-flake list is EMPTY (AGENTS.md): any failing named spec is
  a regression to diagnose, not a re-run.

## 4. Planner rulings (binding; win over slice text)

### The signal (S1)

- PR1 `ContactItem` (`app/src/repos/contactsRepo.ts` beside
  `last_heard_from_at` ~230) gains `last_reached_out_at?: string` with a doc
  comment: "ISO. The latest instant staff followed up with this contact
  (message, email, call). Outbound only; shares and automated sends never
  move it. Written only by touchLastReachedOut. See spec
  2026-10-23-today-checklist-design.md 7." `RecipientDisplay` (~401) gains
  the same optional field. `RECIPIENT_PROJECTION` (~1098) gains
  `#lastReachedOutAt` mapped to `last_reached_out_at`. The exact-projection
  pin in `app/test/caseworkerRepoParity.integration.test.ts` (~459) is
  updated, deliberately.
- PR2 `touchLastReachedOut(contactId: string, at: string): Promise<'written' | 'skipped' | 'failed'>`
  on the `ContactsRepo` interface (beside `touchLastHeardFrom` ~978) and in
  the implementation (beside ~2007), a copy of `touchLastHeardFrom` with the
  attribute name `last_reached_out_at` (name token `#lro`) and its own log
  messages. Same pointer-row refusal, `normalizeInstant`, conditional
  forward-only UpdateItem, never throws.
- PR3 `getRecipientDisplaysByIds(ids, opts?: { requireComplete?: boolean; consistentRead?: boolean })`:
  the implementation (~1369) passes `consistentRead` through to
  `batchGetByIds` exactly as `getManyByIds` (~1376) does. The pin in
  `contactsRepoConsistentBatchRead.test.ts` (~98-107, no ConsistentRead
  when not asked) stays; add the positive case there.
- PR4 `SERVER_OWNED_CONTACT_FIELDS` (`app/src/routes/contacts.ts` ~312)
  gains `'last_reached_out_at'`. Tests: create and PATCH each refuse it with
  the existing message.
- PR5 New module `app/src/services/staffOutreach.ts`:
  ```ts
  export interface StaffOutreachStamp { contactId: string; at: string }
  export async function recordStaffOutreach(
    deps: { contacts: Pick<ContactsRepo, 'touchLastReachedOut'>; log: Logger },
    stamps: readonly StaffOutreachStamp[],
  ): Promise<string[]>   // the contactIds whose stamp was 'written'
  ```
  It drops stamps with an empty contactId, keeps the LATEST `at` per
  contactId (compare `Date.parse`), calls `touchLastReachedOut` once per
  contact (sequential is fine; at most a relay roster), never throws (a
  rejected promise from a fake is caught and treated as 'failed'), logs
  ERROR `{ contactId }` only on 'failed'. Its doc comment states the rule:
  every outbound writer decides stamp or no stamp explicitly; the writer
  table lives in the spec, section 7.3; an agent that sends as staff in the
  future calls this. Callers emit their own event (PR8) - the helper emits
  nothing.
- PR6 `conversationsRepo.getByIdConsistent(conversationId)`: a GetCommand
  with `ConsistentRead: true`, same return type and pointer handling as
  `getById` (~1124). Interface + implementation + the harness fake (which
  returns the same as `getById`). Used ONLY to build the after-loop
  `conversation.updated` payloads (PR17, PR21).
- PR7 Fakes: the harness `contactsRepo` (`app/test/helpers/twilioWebhookHarness.ts`)
  gains `touchLastReachedOut`, a twin of its `touchLastHeardFrom` fake
  (~2633-2647) that records into a new `world.reachedOutTouches` array and
  applies forward-only to `world.contacts`; its `projectRecipient`
  (~2240-2251) copies the new field; its `getRecipientDisplaysByIds`
  accepts and ignores `consistentRead` but records the opts into a new
  `world.recipientDisplayCalls` array. The harness event recorder
  (~617-623) also records `contact.updated` into `world.emitted`. Every
  hand-rolled full `ContactsRepo` fake that does not compile without the new
  method gets a throwing stub (`throw new Error('not used')`) EXCEPT where
  a slice's test needs a recording one. `app/test/followUps.test.ts`
  `RECIPIENT_ATTRS` (~46) gains the field.
- PR8 Events. `contact.updated` (`{ contactId }`, already in
  `AppEventMap`/`ALL_APP_EVENTS` and already bridged) is the per-contact
  event; its doc comment in `app/src/lib/events.ts` (~296-314) gains the new
  emitters (S7 does the comment; S2/S3 do the code). A writer emits it ONLY
  when `recordStaffOutreach` returned that contactId as written.

### Direct writers (S2)

- PR9 `SendMessageInput` (`app/src/services/sendMessage.ts` ~292) gains
  `staffOutreach?: true` with a doc comment ("set ONLY by the staff send and
  staff Retry routes; never by automated, share or machine-retry callers").
  After a successful `messages.append` (~689), when `staffOutreach === true`
  and the judged `contact` (`heldRecipient ?? phoneContact`, ~511) is
  defined, the service calls `recordStaffOutreach` with
  `{ contactId: contact.contactId, at: <the appended row's providerTs> }`.
  If written, it emits `contact.updated` for that contactId AFTER its
  existing `conversation.updated` emit (~738), so it is the last event of
  the send. `createSendMessageService` gets the router's contacts repo:
  in `app/src/routes/api.ts` the `contacts` construction (~709) moves above
  the service construction (~694-703) and is passed as `contactsRepo`.
- PR10 W1: the 1:1 route (`api.ts` ~1564, inside the MMS batch loop
  ~1541-1599) passes `staffOutreach: true` on the FIRST batch only
  (`i === 0`), so a multi-batch MMS stamps and emits once.
- PR11 W2: the Retry route (`api.ts` ~1872) passes `staffOutreach: true`
  only when `original.broadcast_id === undefined`.
- PR12 W3: `sendEmailMessage` (`app/src/services/sendEmailMessage.ts`),
  after `adapter.send` resolves (~470) - SES accepted - stamps
  `{ contactId: input.contactId, at: nowIso }` (the row's providerTs), and
  after its `emitPersisted('sent')` (~533) emits `contact.updated` when
  written. A send that throws stamps nothing. The service's deps already
  carry the contacts repo and events.
- PR13 W6: `resolveOutboundTarget` (`app/src/routes/webhooks/voice.ts`
  ~1305-1321) returns `contactId?: string` (the `findByPhone` contact it
  already reads). In the whisper-gate outbound accept branch, the press-1
  instant is hoisted into `const dialAt = new Date().toISOString()` and
  used for both `answeredAt` and the stamp. AFTER `sendTwiml(res, vr)`
  (~1727) the handler starts, without awaiting before the response:
  `const work = stampOutboundDial({ contacts, log, events }, target.contactId, dialAt)`
  (a local async function: recordStaffOutreach, then `contact.updated` when
  written; it never rejects) and hands it to a new optional router dep
  `afterResponse?: (work: Promise<void>) => void` (on
  `TwilioVoiceWebhookDeps` ~321; default: attach a `.catch` that logs and
  drop it). Tests pass `afterResponse` to capture and await the promise.
  Nothing new runs between the press-1 stamp and `sendTwiml`. No stamp on
  any refusal branch (unresolved target, voice opt-out, DNC cancel) and
  none in `originateCall`.
- PR14 W8: `app/src/routes/dev.ts` gains `touchFixtureReachedOut`, the
  outbound twin of `touchFixtureHeardFrom` (~827-846): for an OUTBOUND
  fixture row whose author is `teammate`, resolve the thread's one-to-one
  contact (the same thread-participant -> phone -> email order
  `attributeInbound` uses, `lib/heardFrom.ts` ~94-104; extract a shared
  `oneToOneThreadContactId` helper there if it avoids duplication) and
  stamp it at the row's providerTs; emit `contact.updated` via the
  module's `appEvents` when written. Both seams
  (`/__dev/voice/transcript-fixture`, `/__dev/extraction/message-fixture`,
  every branch that today calls `touchFixtureHeardFrom`) call it for
  outbound rows. The injectable `heardFromRepos` dep type gains
  `touchLastReachedOut`.
- PR15 Inbound order fixes (spec 8, verified by the writer map):
  (a) `app/src/services/inboundEmail.ts` emits `conversation.updated`
  (~770) BEFORE `touchLastHeardFrom` (~833): add a `contact.updated` emit
  for that contact immediately after the touch when it returns 'written'
  (do not reorder the existing emits). The unmatched-email re-ingest reuses
  this path and inherits it. (b) The masked relay call paths in
  `routes/webhooks/voice.ts` (~1122 refused, ~1220 bridged) move
  `last_heard_from_at` and emit no event Today hears: add the same
  post-touch `contact.updated` when 'written'. Every other inbound path is
  already ordered correctly; S2 records the table in its report. Dev
  fixtures: no change.
- PR16 Tour create emits `tour.updated` (`{ tourId, status }`, the shape
  at `routes/tours.ts` ~1656): (a) POST /api/tours after `tours.create`
  (~367), before the 201; (b) the Interested outcome route
  (`routes/units.ts` ~1564) after `createdTour` (~1656) - `UnitsRouterDeps`
  (~126) gains `events?: EventBus` (default `appEvents`), passed from
  `api.ts` (~1000). The pin at `app/test/toursApi.test.ts` ~1395 ("create
  does not emit") is INVERTED deliberately.

### Relay and group writers (S3)

- PR17 W4 (`app/src/jobs/relayFanOut.ts`). `RelayLegSendOutcome` (~1767)
  gains `sentAt: string` on the `'sent'`, `'sent_unrecorded'` and
  `'stranded'`-with-`afterSend: true` arms (the provider-accepted
  instant, `result.providerTs`). In the fan-out loop (~1520-1617), when
  `payload.senderKey === TEAM_SENDER_KEY` and the outcome is one of those
  three arms and `member.contactId` is set, push
  `{ contactId: member.contactId, at: outcome.sentAt }` to a local list.
  NOTHING is added inside `sendOneRelayLeg`. After the loop (at the "relay
  fan-out complete" log ~1632), call `recordStaffOutreach` once; if any
  contact was written, read the thread with `getByIdConsistent` and emit
  ONE `conversation.updated` built with `toConversationUpdatedEvent` from
  that read (skip the emit, WARN, if the read returns nothing or throws).
  No `touchLastActivity`. A re-driven team leg from `sendReconcile`
  (~1710-1722) and the flush of posts queued while connecting
  (`services/relayQueuedMessages.ts` ~93-96) go through this loop and
  stamp - intended. The 30003 rung (`jobs/relayRetryLeg.ts` ~836 calls
  `sendOneRelayLeg` directly) does not.
- PR18 `RelayFanOutJobDeps` (~848) and `RelayFanOutExecutionDeps` (~1219)
  gain `events?: EventBus`, defaulted to `appEvents` the way
  `jobs/relayRetryLeg.ts` (~168-174, ~410-432) does; `worker.ts` passes
  `events: appEvents` where it registers the handler. The worker's existing
  event bridge (`lib/eventBridge.ts`, attached in `worker.ts` ~45-61)
  carries the event to the API; no bridge change.
- PR19 W5 (`app/src/services/groupSend.ts`): the slot-seeding loop
  (~607-638) collects the phones it seeds `excluded` into a local set.
  After the row append (~651-686) and BEFORE the existing
  `conversation.updated` emit (~718), stamp every resolved member
  (`resolved[].contact` defined) whose phone is not in that set, at
  `posted.dateCreated` normalized with `normalizeInstant`. No new event
  (the existing emit follows the stamp).
- PR20 W7: `RelayAnnouncementInput` (`services/relayAnnouncements.ts`
  ~114-144) gains `staffAuthored?: true`. `relayFanOut.ts` sets it ONLY in
  the edited-intro branch (`edited.length > 0`, ~1090-1095) and also
  passes its `events` dep into that `sendRelayAnnouncement` call
  (~1126-1141). In the member loop (~266-381), after a successful send
  (~322), when `input.staffAuthored === true` and `input.persist !== false`
  and `member.contactId` is set, collect `{ contactId, at: result.providerTs }`.
  After the loop: `recordStaffOutreach`, then, when written, ONE
  `conversation.updated` from `getByIdConsistent` (as PR17). The default
  intro, member added, group closed, tour reminder kinds, and the dev
  `/__dev/relay/replay-intros` (`persist: false`) never stamp.
- PR21 S3 no-stamp tests: the 30003 relay rung, a non-intro announcement,
  the default intro, the reconcile relay adoption (`adoptRelay`), a member
  inbound relay, and a suppressed member (no leg) each leave
  `world.reachedOutTouches` empty for that contact.

### Today server (S4)

- PR22 Follow up core. `app/src/services/followUps.ts` exports
  `collectWaitingFollowUps(deps: FollowUpsDeps, opts?: { consistentRead?: boolean }): Promise<{ rows: WaitingFollowUp[]; truncated: boolean }>`
  where `WaitingFollowUp = { item: FollowUpItem; recipient: RecipientDisplay }`
  - the current body of `buildFollowUps` up to (not including) the final
  sort/byUnit step, with `opts.consistentRead` passed to the one
  `getRecipientDisplaysByIds` call alongside `requireComplete: true`.
  `buildFollowUps(deps)` becomes the core (no opts) plus the existing sort
  and `byUnit` projection; its output is byte-identical (WI1).
  `FollowUpsDeps.contacts` stays `Pick<ContactsRepo, 'getRecipientDisplaysByIds'>`.
- PR23 Quiet shares builder: new `app/src/services/quietShares.ts`, pure:
  ```ts
  export const QUIET_REPLIED_MS = 48 * 60 * 60 * 1000;
  export const QUIET_NO_REPLY_MS = 120 * 60 * 60 * 1000;
  export function buildQuietShares(rows: readonly WaitingFollowUp[], now: number):
    { properties: QuietShareProperty[]; people: number }
  ```
  For each row with `item.outcome` 'replied' or 'no_reply': quietSince =
  max of `item.sentAt`, `recipient.last_heard_from_at` when later,
  `recipient.last_reached_out_at` when later (unparseable values ignored);
  shown when `now - quietSince >= threshold`. Person = `{ contactId, name:
  item.name, type: item.type, role: item.role, state: item.outcome,
  quietSince: <ISO> }` (omit `role` when undefined). Group by
  `item.unitId` with `unitLabel: item.unitLabel`. Order and `people`
  exactly spec 6.2/6.3/3. The wire types `QuietShareProperty` /
  `QuietSharePerson` are declared in `routes/today.ts` beside
  `TodayResponse` and imported by the builder (type-only import).
- PR24 `TodayRouterDeps` gains `unitsRepo?` and `listingSendsRepo?`
  (defaults built like the others). `api.ts` (~1285-1301) passes the
  existing `units` (~686) and `listingSends` (~646). Alias the units
  repo's `isDeleted` import (`isDeleted as isUnitDeleted`) - contactsRepo
  already exports an `isDeleted` that `today.ts` imports.
  `app/test/todayUnmatchedNonRegression.test.ts` `TODAY_TABLES` gains the
  tables the new reads need (units, listing_sends, tours if not present).
- PR25 Unit labels: a per-request memoized `unitLabelOf(unitId)` in the
  handler, modeled on the placement cache (~388-400): `getById`, then
  `formatAddress(unit.address) || unitId`; a throw or a missing/deleted
  unit logs WARN `{ unitId }` once and returns the unitId. Used by
  tours_today and tours_to_book.
- PR26 Unread pass (spec 4, 5.2). In the collect loop (~704-787) the FIRST
  test becomes `if (conv.type !== 'unknown_1to1') continue;` (replacing
  `isOneToOneBucket` there). Then the deleted-contact skip (unchanged).
  Then the owner test, REPLACING the #30 Inactive skip (~748-781): when
  `ownerId` is defined and `getContact(ownerId)` returns a contact, keep the
  thread only if `owner.type === 'unknown' && owner.status !== 'inactive'`;
  an unresolved owner keeps today's behavior. The unreplied emit branch
  (~843-875), the `unreplied` array, `unreadRowKeyOf`'s `'unreplied'`
  arm, the `unreplied:` log count and every comment naming Unreplied as a
  Today section go. The "feed Unreplied (tracker #31 owns that section)"
  comment (~769-770, and ~756) is rewritten: typed threads feed only the
  Inbox.
- PR27 Identify rows: the unread unknown rows and the triage-partition rows
  keep their exact current row shape except `group: 'identify'`. Sort:
  `created_at` of the row's contact ascending (Date.parse); a contact with
  no parseable `created_at` last; ties by refId. The unread pass already
  holds the owner contact; the triage pass holds the contact. A row whose
  contact is unresolved sorts as "no created_at".
- PR28 Tours to book (spec 5.4), in its own try/catch:
  `tours.listByStatus('requested')`; skip deleted tenants (the existing
  `isDeletedContact`); row `{ group: 'tours_to_book', refType: 'tour',
  refId: tourId, who: <tenant label, the tours_today rule>, why:
  unitLabelOf(unitId), urgency, at: createdAt, unitLabel }` where urgency =
  "Requested today" when whole days (floor of (now - createdAt) / 86400000)
  is 0, "Requested 1 day ago" for 1, "Requested N days ago" otherwise. No
  `tag`. Order: `createdAt` ascending, ties by tourId. `toursToBook` =
  'unavailable' (and no rows) on any throw.
- PR29 tours_today rows gain `at: scheduledAt` and `unitLabel`; sort by
  `scheduledAt` ascending, then who, then refId (replacing the who-first
  sort ~1071-1081). Row why/tag unchanged.
- PR30 Quiet shares in the route: in its own try/catch,
  `collectWaitingFollowUps({ units, listingSends, tours, contacts, log, now }, { consistentRead: true })`
  then `buildQuietShares`; response `quietShares: { status: 'ok',
  properties, people, truncated }` or `{ status: 'unavailable' }`. WARN on
  throw with counts only. Response item order: needs_you_now, identify,
  tours_to_book, tours_today, follow_ups, ai_suggestions. The header
  comment's spec citation (~9-11) adds this spec as superseding the
  grouping rules.

### Dashboard (S5)

- PR31 Types: `dashboard/src/api/types.ts` mirrors the server wire exactly
  (spec 3); `quietShares?` and `toursToBook?` are OPTIONAL on the
  dashboard type (an older backend omits them) and a missing value is
  treated as unavailable.
- PR32 `useToday` exposes `quietShares: QuietSharesState` and
  `toursToBookStatus: 'ok' | 'unavailable'`; a fallback load sets both
  unavailable. Its SSE subscriptions already cover placement,
  conversation, suggestion, tour and contact events; no new subscription.
- PR33 One shared section component (in `dashboard/src/routes/today/`)
  renders heading `<h2>` with the count, the optional help line, the list
  with accessible name = the heading text WITHOUT the count (so
  `getByRole('list', { name: 'Tours to book' })` works), the first 5 rows,
  and the "Show all N" / "Show fewer" button (`aria-expanded`). Every
  checklist section and both At a glance parts use it. The heading text
  includes the count as a separate element so the list name stays exact.
  Headings: "Needs you now", "Identify these contacts", "Past tours needing
  an outcome", "Tours to book", "Quiet shares", "Relay groups to close",
  "Placements"; At a glance: "Tours today"; the AI line reads "AI
  suggestions for N contacts" ("1 contact" singular) and its opened list is
  named "AI suggestions".
- PR34 Quiet shares UI per spec 6.2/6.3: property line button with
  `aria-expanded`, its people list named "People waiting on <unitLabel>";
  open state in a `Map<unitId, boolean>` held in component state, seeded
  once (first property open) the first time properties arrive; later
  properties default folded; survives refetches. Person row links to the
  contact page (`hrefFor` contact). Copy exactly spec 6.2. `truncated`
  shows "Showing the first 100 properties".
- PR35 Past tours (spec 5.3) in `useTodayPastTours.ts`: label EVERY row
  (not only the first 5), skip deleted tenants; order in-range rows by
  `scheduledAt` ascending (ties tourId) then off-range rows in the loader's
  order. "In-range" uses the SAME predicate `selectPastTours`
  (`dashboard/src/routes/tours/useTours.ts` ~200-212) uses - export it or a
  helper from `useTours.ts` rather than re-deriving; the Past tab's own
  order is unchanged. The section's count = labeled rows; the Past-tab
  link keeps `past.total`.
- PR36 `buildToday.ts` (fallback): drop `unreplied` (and its GROUP_ORDER
  entry), emit the unknown_1to1 rows with `group: 'identify'` (copy and
  rule unchanged), and give GROUP_ORDER the new groups.

### Shared files and backfill (S6) and e2e (S7)

- PR37 Shared files across slices: `app/src/routes/api.ts` (S2 PR9/PR10/
  PR11/PR16; S4 PR24) and `app/test/helpers/twilioWebhookHarness.ts` (S1
  only). S4 re-reads `api.ts` after S2 and anchors on current text.
- PR38 Backfill rule picks (spec 7.5, from the code map):
  - Staff-edited intro: BODY MATCH. Count a row when `author === 'system'
    && relay_sender_key === 'system' && thread.type === 'relay_group' &&
    thread.intro_body` is non-empty `&& row.body === thread.intro_body`;
    stamp each slot that has a `sid` at `slot.sentAt`.
  - Tour reminder / nudge Send now: EXCLUDE by body. A 1:1 candidate row is
    excluded when its body equals one of the four `nudge.*` catalog
    defaults (resolved at script start through the message catalog), or
    equals the `sentBody` of a tour reminder whose `sentAt` lies in the
    window; report `excluded_nudge_body`, `excluded_reminder_body`, and
    within the latter how many also matched in time (`providerTs` within
    10 minutes after `sentAt`).
  - Email: count when `delivery_status` is sent/delivered/undelivered OR
    `ses_message_id` is present; skip failed; skip queued without
    `ses_message_id`.
  - Calls: `answered_at` or `call_outcome` present; instant =
    `answered_at` when present, else the row's providerTs.
  - Relay team posts: slots keyed by contactId (no `phone#` prefix) with a
    `sid` and `sentAt`; instant = `slot.sentAt`. Known gap, accepted and
    recorded in the RUNBOOK entry: a post QUEUED more than 14 days ago
    whose legs went out inside the window is below the key floor.
  - Group-text posts: slots not `excluded`; phone -> contact via the
    thread roster `participants` first, then a memoized `findByPhone`;
    instant = the row's providerTs.
  - 1:1 text/email recipient: `recipient_contact_id`, else the thread's
    contact (participants contactId, then `findByPhone`, then
    `findByEmail`, the `attributeInbound` order).
  - Key-condition Query per thread: `conversationId = :c AND tsMsgId >= :floor`,
    floor = (now - 14 days - 1 hour) ISO; each row re-checked with
    `normalizeInstant(splitTsMsgId(tsMsgId).providerTs) >= now - 14 days`.
  - Usage: `npx tsx app/scripts/backfill-last-reached-out.ts --env <local|dev|prod> [--lane <L>] [--apply]`
    (no package.json script, like its twin). RUNBOOK entry right after
    the "Last heard from: the backfill" entry (~527-551), same six steps,
    "Cameron runs it; an agent never runs it against dev or prod".
- PR39 e2e: one NEW spec `e2e/tests/dashboard-next/today-checklist.spec.ts`
  that builds its own state on the lean world (it seeds no listing sends,
  tours or unknown contacts): section order; a no_reply quiet share
  (`/__dev/listing-send-fixture` with `sentAt` 6 days ago) and a replied
  one (sent 5 days ago + an inbound `/__dev/extraction/message-fixture`
  3 days ago, polled until `last_heard_from_at` is set - the
  `follow-up-tab.spec.ts` pattern); the person drops off live after a staff
  text from the UI; Tours to book shows a requested tour (POST /api/tours
  without `scheduledAt`) and drops it after booking. Existing specs updated
  deliberately (never weakened): `unknown-caller-triage`, `unknown-inactive`,
  `conversation-fact-extraction` (open the AI line first),
  `caseworkers` (~551: assert the intent of the original - the AI line is
  ABSENT when there are none, not a vacuous zero-count on a hidden list),
  `scenarios/participant-names` (new vehicle: a requested tour for the
  tenant, so the renamed name shows in Tours to book), `today-past-tours`
  (oldest first; 5 rows + "Show all N" + the Past-tab link),
  `e2e/scenarios/steps.ts` ('Follow-ups due' -> 'Placements'),
  `e2e/performance/routes.ts` `TODAY_TERMINAL` (new headings; also fix the
  stale 'Group texts to close'). S7 re-greps for every reader before it
  starts and records the list.
- PR40 Server test inversions (S4), deliberate: in `app/test/todayApi.test.ts`
  the #30 cases where an ACTIVE team member's (~1037-1043, ~1089-1110), a
  re-typed tenant's (~1123-1168) and an Inactive partner's (~1170-1178)
  unknown_1to1 thread emitted a row now emit NO row; every Unreplied
  assertion is removed or re-pointed at the Inbox-only rule; the
  participant-names-through-Today case (~1993-2047) moves to a vehicle
  Today still shows (a tours_to_book or identify row). Each inversion is
  named in the S4 report.
