# S3 report - relay and group writers W4, W5, W7

S3_BASE: db412659. Commits, in order: 59b58a6f (S3.1, W4), d8256cc2 (S3.2,
W5), 51aa1148 (S3.3, W7), then this report. Line numbers below are at
51aa1148 (this report commit changes no code).

## What the tree held that the plan got wrong

- No anchor drift. Every S3.1-S3.3 old text matched verbatim and uniquely
  (the Edit tool enforces uniqueness); S2 touched none of the S3 files. The
  plan's line hints were off only by the lines S1/S2 and earlier S3 tasks
  added.
- S1 names (S3.1 Step 0) all matched the plan's assumptions; no mapping was
  needed: `recordStaffOutreach` / `StaffOutreachStamp`
  (`app/src/services/staffOutreach.ts:24`, `:45`),
  `ConversationsRepo.getByIdConsistent` (`app/src/repos/conversationsRepo.ts:570`,
  impl `:1139`, harness `app/test/helpers/twilioWebhookHarness.ts:695`),
  `world.reachedOutTouches` `{ contactId, at, outcome }` (harness `:540`),
  whose fake answers 'skipped' for a contact not in `world.contacts`
  (harness `:2686-2700`), and `contact.updated` in `world.emitted`
  (harness `:644`).

## Divergences taken (each named; none changes behavior)

- PR55 over slice text 3j: the plan's 3j adds a local
  `const sentAt = result!.providerTs;` inside `sendOneRelayLeg`. Not taken:
  PR55 (binding) says only the three return statements set it and "nothing
  else there changes". The two record-arm literals carry
  `sentAt: result!.providerTs` inline instead, so the whole diff inside
  `sendOneRelayLeg` is exactly three return lines:
  `app/src/jobs/relayFanOut.ts:2306` (sent), `:2368` (sent_unrecorded),
  `:2370` (stranded, afterSend). Same values as the plan's text.
- WL-5 (worklist wins): two cases added beyond the plan, each RED first -
  `relayFanOut.test.ts:4068` "W4 a team post whose every stamp is skipped (no
  contact items) emits NO conversation.updated and makes no fresh read" and
  `relayAnnouncements.test.ts:657` "a staff intro whose every stamp is skipped
  (no contact items) emits no extra event and makes no fresh read". RED seen:
  touches `[]` (expected three / two 'skipped').
- WL-6 (worklist wins): `relayAnnouncements.test.ts:579` makes the
  `sendPreparedMessage` spy return a FIXED provider instant per leg
  (`2026-01-02T03:04:05.001Z` Alice, `.002Z` Bob) and asserts the stamps equal
  those instants, not `legAt(...)`. `at: providerTs` (the row's own const,
  `app/src/services/relayAnnouncements.ts:279`) cannot pass in place of
  `result.providerTs` (`:392`). The relayFanOut W7 case keeps `legAt`.
- The S3.1 and S3.3 commit messages carry one extra `-m` paragraph naming
  WL-5 / WL-6. Message text only.

## C1 - no worker.ts / registerHandlers.ts edit (PR54)

- `registerHandlers.ts:64` registers the fan-out with no `events`; both
  relay.fanOut and relay.intro default their bus with `events ??= appEvents`
  (`relayFanOut.ts:974`, `:1083`), the relayRetryLeg pattern
  (`app/src/jobs/relayRetryLeg.ts:410`, `:416`). The worker attaches the
  bridge to that singleton (`app/src/worker.ts:46-48`,
  `attachEventBridge(appEvents, ...)`); `app/src/index.ts:56` (in-process
  path) calls the same registrar, where the singleton is the app's own SSE
  bus. Read only; neither file changed.

## C2 and C3 - RelayLegSendOutcome.sentAt

- `sentAt?: string` on the flat interface with a doc comment naming the three
  arms (`relayFanOut.ts:1849-1855`). Set in exactly three return literals of
  `sendOneRelayLeg` (`:2306`, `:2368`, `:2370`); nothing else in that unit
  changed (no dep, read, write or stamp). The loop gates on the kind AND
  `outcome.sentAt !== undefined` (`:1589-1599`). The 30003 rung never reads
  it: `git grep -n "sentAt" -- app/src/jobs/relayRetryLeg.ts` prints nothing.

## WI4 - events per writer (counted, as the tests prove them)

| Writer | Test (file:line) | Events added by S3 |
|---|---|---|
| W4 team post | relayFanOut.test.ts:3819 | exactly 1 conversation.updated per pass that wrote >= 1 stamp; 0 contact.updated; no touchLastActivity (`world.touches` empty) |
| W4 fresh-read payload | relayFanOut.test.ts:3843 | 1, read once AFTER all 3 stamps, carries the table's unread_count (1), not the snapshot's |
| W4 nothing written | relayFanOut.test.ts:4068 (WL-5) | 0, and no getByIdConsistent call |
| W4 fresh read missing / throws | relayFanOut.test.ts:4042 (it.each) | 0, ONE WARN `{ conversationId, written: 3 }`, no ERROR; stamps stand |
| W4 member inbound relay | relayFanOut.test.ts:3897 (PIN) | 0 |
| W4 multi-batch relay MMS | (R-5 below) | N after-loop events for N batches |
| W5 group text | groupSend.test.ts:1402, :1463 | 0 added; the send's existing message.persisted + conversation.updated follow every stamp (`emittedBefore === 0`), also when the stamp rejects |
| W7 staff-edited intro | relayAnnouncements.test.ts:579; relayFanOut.test.ts:4081 (through the job) | 1 added conversation.updated after the loop, after the existing pre-loop conversation.updated + message.persisted (exact list of 3); 0 contact.updated |
| W7 nothing written | relayAnnouncements.test.ts:657 (WL-5) | 0 added (exact list of 2), no fresh read |
| W7 other kinds / persist:false | relayAnnouncements.test.ts:674, :688 (PINs) | 0 added; persist:false emits nothing at all |

The relay team-send route's own post-time events are unchanged (S3 does not
touch `app/src/routes/api.ts`).

R-5 (WORKLIST, recorded here as worded there):
- R-5 (E1-7) A multi-batch relay MMS (api.ts ~1439-1482) is N fan-out jobs,
  so W4 emits N after-loop events (forward-only stamps, harmless). WI4
  table in the S3 report.
  (At 51aa1148 the batch loop is `api.ts:1462-1491`; each pass calls
  `sendRelayTeamMessage` at `:1464`, which enqueues its own fan-out at
  `:2096`.)

## WI5 - fan-out passes

- relayFanOut.test.ts:4009 "WI5 a 30-member team post goes out in ONE pass
  with ONE event; a transient continuation is its own pass with its own
  event": the first pass attempts all 30 members (29 sent, 1 carried on an
  injected 429) and emits 1 event; the continuation (its own job, attempt 2)
  sends the 30th and emits its own: 2 passes, 2 events. With no transient
  failure a 30-member post is ONE pass: the loop has no per-pass member cap
  (`relayFanOut.ts:1555-1663`), and the after-loop stamp runs before any
  continuation is scheduled (`:1696-1702`, before `:1704`).
- [PR88] One after-loop `conversation.updated` per fan-out PASS is the
  accepted reading of spec 7.3's "one per staff send": continuation passes
  exist only for deferred members and are bounded.

## [PR93] the stranded + afterSend arm stamps

- A deliberate widening of spec 7.3 W4: the provider accepted the text; only
  the slot or hand-off write failed. Proven by relayFanOut.test.ts:3914 "W4
  sent_unrecorded and a stranded leg whose send is KNOWN both stamp; an
  UNKNOWN outcome does not" (alice sent_unrecorded, bob stranded-afterSend,
  carol unknown -> exactly alice and bob, each at their leg's providerTs).
  The backfill (S6) cannot see such a leg (no slot sid); the S6 RUNBOOK entry
  notes it.
- Same class for W7 (finding): the W7 collection sits right after the
  provider accepted the leg (`relayAnnouncements.ts:390-393`), BEFORE the
  slot write (`:415`) and the relaysid pointer (`:425`), as plan 3b places
  it, so an intro leg whose record write threw still stamps. The backfill's
  intro rule (PR38: slots with a `sid`) cannot see that leg either. S6/S7
  may name it beside PR93 in the RUNBOOK entry.

## WI6 - re-drive stamps, the 30003 rung and the adoption do not

- relayFanOut.test.ts:3978 "WI6 a team leg the reconcile re-drives (the
  enqueueRedrive envelope) stamps that member": the exact relay-leg payload
  `enqueueRedrive` builds (`app/src/jobs/sendReconcile.ts:1714-1726`, pinned
  by sendReconcile.test.ts:2365 "15 relay never_sent") sends Bob once, the
  record ends done/sent attemptNo 2 redriveCount 1, ONE stamp at his leg's
  instant, ONE event.
- relayRetryLeg.test.ts:736 "a rung that resends a TEAM post leg never stamps
  last_reached_out_at (PIN)": the rung (`relayRetryLeg.ts:836` calls
  `sendOneRelayLeg` directly) sends Bob and stamps nothing, no
  contact.updated.
- sendReconcile.test.ts:2209 "a relay-leg adoption of a TEAM post never stamps
  last_reached_out_at (PIN)": `adoptRelay` (`sendReconcile.ts:1026`) adopts the
  delivered leg (record done/adopted) and stamps nothing.
- A reconcile re-drive of a 30003 RUNG goes to relay.retryLeg
  (`sendReconcile.ts:1728-1736`), not the fan-out, so it never stamps either.

## Accepted residue (PR56)

- A record-phase failure whose hand-off fence is LOST returns
  `{ kind: 'skipped_terminal' }` after a known send (`relayFanOut.ts:2369`):
  the text went out but the member is not stamped; the takeover's reconcile
  adoption does not stamp either.
- The relay.memberAdded call keeps its default bus (`relayFanOut.ts:1212`,
  unchanged; PR20 names only the intro).

## PR21 no-stamp coverage

- 30003 rung: relayRetryLeg.test.ts:736 (PIN).
- Non-intro announcements (member added, group closed, a tour reminder) and
  the composed intro, service level: relayAnnouncements.test.ts:674 (PIN);
  through the jobs: relayFanOut.test.ts:4108 "W7 the composed DEFAULT intro
  never stamps" (RED first: 0 events before the intro passed its bus) and
  :4133 "W7 (PIN) a member-added announcement never stamps".
- Dev intro replay (persist:false): relayAnnouncements.test.ts:688 (PIN),
  relayFanOut.test.ts:4121 (PIN).
- `adoptRelay`: sendReconcile.test.ts:2209 (PIN).
- Member inbound relay: relayFanOut.test.ts:3897 (PIN).
- Suppressed member (no leg) and a phone-only member (no contact item):
  relayFanOut.test.ts:3878 (W4); relayAnnouncements.test.ts:624 (W7, plus a
  member whose send threw); groupSend.test.ts:1429 (W5, slot seeded
  excluded).

## RED / GREEN per task

- S3.1 RED (relayFanOut, relayRetryLeg, sendReconcile): 10 failed | 457
  passed - the 8 plan cases (the it.each counts 2) plus WL-5, each on the
  stated assertion (touches `[]`; freshRead 0 calls; `touch?.at` undefined;
  29-touch length 0; no 'written' touch). PINs green. GREEN (plus
  relayQueuedMessages, relayApi, relayAnnouncements): 6 files, 549 passed.
- S3.2 RED (groupSend): 5 failed | 48 passed, each on `f.reachedOut` `[]`;
  "stamps nothing when the post fails" and every pre-existing case green.
  GREEN (plus groupGuardrailWiring, groupSendRoute): 3 files, 68 passed.
- S3.3 RED (relayAnnouncements, relayFanOut): 5 failed | 186 passed -
  relayAnnouncements :579, :624, :657 on touches `[]`; relayFanOut :4081 on
  touches `[]`, :4108 on conversationUpdates length 0 (the missing bus
  pass-through). PINs green. GREEN (plus devRelayReplay, relayIntroBody,
  relayIntroFallbackJob, tourReminders, relayApi): 7 files, 413 passed.

## Deliberate test changes

- No pre-existing assertion was changed or weakened.
- `app/test/groupSend.test.ts` `makeFakes` (plan S3.2 1a, additive): the
  `Fakes.reachedOut` record, the `touchLastReachedOut` override, a recording
  `touchLastReachedOut` on the contacts fake, and `contact.updated` added to
  the recorded event names. Every pre-existing case stayed green with exactly
  its old event list.
- `app/test/relayFanOut.test.ts`: the "W7 cases (Task S3.3) are inserted
  above this line." marker written in S3.1 was replaced by the W7 cases in
  S3.3, as the plan's 1b does.

## Suites that now stamp through the harness without asserting it

- Team posts with seeded contacts (`app/test/relayApi.test.ts`, registration
  at `:225` with no `events`) and the edited intro on an owned group
  (`relayFanOut.test.ts:3558` "an operator-edited intro_body still wins over
  the tour variant"): their after-loop event goes to the `appEvents`
  singleton, which nothing there reads. Both green in the S3.3 GREEN run and
  in the app workspace run; so are placementsRelay, relayQueuedMessages,
  tourReminders, devRelayReplay and groupSendRoute.

## Gates (fast gates only, as briefed)

- `npm run typecheck` (bare, root): exit 0 after S3.1, S3.2, S3.3 and at
  S3.4.
- S3.4 Step 1: `staffAuthored` hits only `relayAnnouncements.ts:133`, `:332`
  and `relayFanOut.ts:1110`, `:1115`, `:1161`; the no-stamp grep over
  relayRetryLeg, sendReconcile, tourReminders, relayGroups, broadcastFanOut
  and retrySend printed nothing (exit 1); no `sentAt` in relayRetryLeg.ts.
- App workspace once (`cd app; npx vitest run`, redirected to a log): exit
  0; Test Files 531 passed (531); Tests 11299 passed | 1 skipped (11300)
  (S2's 11271 + the 28 S3 cases); duration 126.99s. No red file, so no
  re-run. No `[dynamoAdmin]` line (the only matches are the
  `dynamoAdminRetry.test.ts` file name). AWS_* variables: none exported.
- eslint on the slice's 8 .ts files: exit 0, no output. No baseline needed.
- ASCII: `git diff -U0 db412659 -- app | grep '^+' | tr ...` = 0; groupSend.ts
  and groupSend.test.ts whole-file = 0. `\u` escape counts unchanged in every
  touched file (sendReconcile.test.ts base 3, now 3; all others 0).
- WI9: no seed file touched (`git diff --stat db412659..HEAD` lists only the
  8 S3 files).

## Recorded residue (WORKLIST, as worded there)

- R-7 (E2-8) The worker's after-loop conversation.updated is built fresh but
  delivered over the fire-and-forget bridge, so an API-side event can
  overtake it; ThreadUnreadToggle / ContactDetail set unread from the
  payload. The fresh read narrows, not closes, the window - same residue as
  the existing worker emits. S3 report.
- R-10 (E1-1) team_member contact on a relay roster calling / texting from
  their own cell is staff reaching contacts and is not stamped. Rare. S3
  report.
  (In code: a member's relayed text carries that member's own sender key,
  so `teamPost` is false - `relayFanOut.ts:1553`.)

## Risks and notes for later slices

- The after-loop stamp is awaited before a continuation is scheduled; its
  cost is one conditional UpdateItem per written contact, sequential (PR5:
  at most a roster), plus one consistent GetItem. Never throws:
  `recordStaffOutreach` catches per touch, `stampRelayOutreach` catches the
  read (`relayAnnouncements.ts:207-223`), and the bus isolates listeners
  (`app/src/lib/events.ts:381-387`).
- `stampRelayOutreach` emits only when a stamp was written
  (`relayAnnouncements.ts:204-206`); a pass whose members all have no
  contact item (or are already stamped as late) is silent (WL-5).
- S6 consistency: a team-post slot's `sentAt` is `result.providerTs`
  (`relayFanOut.ts:2279`), the instant W4 stamps; a group-text row's
  providerTs is `posted.dateCreated` (`groupSend.ts:662`), the instant W5
  stamps after `normalizeInstant` (`:718`); a staff-edited intro slot's
  `sentAt` is the leg's `result.providerTs` (`relayAnnouncements.ts:418`),
  the instant W7 stamps (`:392`).
- S7 (events doc comments): S3 adds two `conversation.updated` emitters - the
  fan-out's after-loop event (`relayFanOut.ts:1696-1702`) and the
  announcement's after-loop event (`relayAnnouncements.ts:457-463`), both
  through `stampRelayOutreach` (`:194`). Neither emits `contact.updated`. S3
  edited no comment in `app/src/lib/events.ts`.

## S3 contract later slices rely on

- `RelayLegSendOutcome.sentAt?: string` (`relayFanOut.ts:1855`), set only on
  sent / sent_unrecorded / stranded-afterSend.
- `RelayFanOutJobDeps.events?: EventBus` (`relayFanOut.ts:901`), defaulted to
  `appEvents` in the fan-out and intro handlers (`:974`, `:1083`);
  `RelayFanOutExecutionDeps.events?: EventBus` (`:1255`).
- `RelayAnnouncementInput.staffAuthored?: true`
  (`relayAnnouncements.ts:133`), set only by the relay.intro edited branch
  (`relayFanOut.ts:1115`, spread `:1161`); the intro call now passes the
  job's bus (`:1152`).
- New export `stampRelayOutreach(deps: { contacts:
  Pick<ContactsRepo, 'touchLastReachedOut'>; conversations:
  Pick<ConversationsRepo, 'getByIdConsistent'>; events: EventBus; log:
  Logger }, conversationId, stamps): Promise<string[]>`
  (`relayAnnouncements.ts:194`) - the written contactIds; emits ONE
  fresh-read conversation.updated when any was written; never throws.
- `GroupSendServiceDeps.contactsRepo` widened to
  `Pick<ContactsRepo, 'findByPhone' | 'touchLastReachedOut'>`
  (`groupSend.ts:229`); its callers (`api.ts:724`, groupGuardrailWiring,
  groupSend tests) all satisfy it.
