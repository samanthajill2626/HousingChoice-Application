# Plan review round 1 - reviewer B (adversarial, plan-blind)

Plan: `docs/superpowers/plans/2026-10-24-today-checklist.md` (PLAN v1).
Spec: `docs/superpowers/specs/2026-10-23-today-checklist-design.md` (r6).
Tree: `feat/today-checklist` @718194dc (main @970a29b9 plus docs). Read-only;
no tests run.

## Method and what held up

- Every "old:" / "Anchor" block in the plan was checked mechanically against
  the current tree and against earlier plan replacement blocks (a script that
  normalizes whitespace and looks for the block, line-contiguous, in every
  app/dashboard/e2e/docs file). All but ten matched; the ten were all blocks
  containing `[U+xxxx]` placeholders or text an earlier plan task writes, and
  each was confirmed by hand (for example plan L11445 is S4.4's L9659
  replacement). No dead anchor was found.
- Spot-checked against code and found accurate: the writer map (every
  `messages.append` caller in `app/src` - `sendMessage.ts:689`,
  `sendEmailMessage.ts:395`, `groupSend.ts:651`, `relayAnnouncements.ts:229`,
  `originateCall.ts:171`, `broadcastFanOut.ts:1409`, `sendReconcile.ts:923`,
  `api.ts:1950/2042`, `dev.ts:904/1112`, the inbound webhooks, and the relay
  30003 rung `twilio.ts:3077`); `RelayLegSendOutcome` and its three return
  literals (`relayFanOut.ts:1767-1790`, `:2240`, `:2302`, `:2304`); the
  whisper-gate outbound branch (`voice.ts:1559-1728`) and
  `resolveOutboundTarget` (`voice.ts:1305-1321`); the inbound heard-from
  order (`twilio.ts:961/1076`, `:1388/1421`, `:2192/2225`, `:2695/2768`
  touch-before-emit; the email and masked-call exceptions PR15 names); the
  tour create paths (`tours.ts:367`, `units.ts:1654`, the only two
  `tours.create(` callers); `SERVER_OWNED_CONTACT_FIELDS` (`contacts.ts:309-323`);
  the JIT consent gate firing only for an existing contact
  (`sendMessage.ts:543-559`); the twin backfill's entry guard
  (`backfill-last-heard-from.ts:269-270`, safe to import); the e2e readers of
  the old headings (every file `grep` finds is either a task or listed in
  S7.1's "comments, still true" row, plan L20032).
- Coverage: every spec section 1-11 maps to a task (S1-S8 coverage tables
  hold up on spot checks). The findings below are what does not.

## Findings

### 1. [MEDIUM] The Today reads that carry spec 8's "live" promises are GSI Queries; WI8 names the wrong reads and no test can see it

What is wrong. Spec 8 promises that a tour create "appears in Tours to book
and the person leaves Quiet shares live", and the S7.2 e2e asserts "requested
tours appear live ... and a booked one leaves live" (plan L20896). Both
depend on one refetch fired 300 ms after the `tour.updated` emit
(`dashboard/src/routes/today/useToday.ts:39`, trailing debounce `:129-132`).
That refetch reads:
- Tours to book: `tours.listByStatus('requested')` - the `byStatus` GSI
  (`app/src/repos/toursRepo.ts:441-456`);
- the Quiet shares outcome for the pair: `tours.listByUnit` inside the
  Follow up core (`app/src/services/followUps.ts:150`) - the `byUnit` GSI
  (`toursRepo.ts:422-424` via `queryGsi`, `:355-368`).
A GSI cannot be read consistently; immediately after the PutItem / PATCH it
can still return the pre-write state, and nothing re-triggers a refetch. WI8
(plan L149-151) instead says "the units and listing-sends reads are not"
consistent. `listingSends.listByUnit` is a BASE-table Query
(`app/src/repos/listingSendsRepo.ts:473-484`), and the tours GSIs - the ones
that decide these two promises - are not mentioned. DynamoDB Local is always
consistent, so the S7.2 "live" tests pass in the hermetic lane whatever prod
does.

What it implies. In prod a newly requested tour can fail to appear (or a
booked one fail to leave, or an Interested person stay in Quiet shares) until
the next unrelated event or a reload, while the plan's tests report the live
behavior as proven. The plan should at minimum correct WI8 to name the
`byStatus` / `byUnit` / units `byStatus` GSIs, record the residue against
spec 8 in a slice report and the handback, and not claim the e2e proves prod
liveness. (A mitigation - for example a second debounced refetch after a
`tour.updated` - is a planner/human call; not proposed here as scope.)

### 2. [MEDIUM] Verbatim slice drafts contradict binding rulings and are not amended; a literal builder executes the wrong text

What is wrong. Plan L12-16 says sections 5-11 are "opus section drafts
assembled verbatim" and section 4 wins "over any slice text it contradicts".
The assembly rulings PR41-PR80 (L538-654) then list ~40 points where the
drafts disagree with the tree or each other, but the draft code was left as
written. A builder who "has never seen the conversation" must notice and
merge each one by hand, inside TDD steps whose GREEN can still pass. Concrete
cases:
- PR60 vs S4.1 Step 1 (L8172-8173) and S4.7 Step 1 (L12438-12439). S1 binds
  `world.recipientDisplayCalls` entries as `{ contactIds, opts? }` (S1.3,
  L1821). S4's WI1 pin `for (const opts of world.recipientDisplayCalls)
  expect(opts?.consistentRead).toBeUndefined()` then reads a property the
  entry never has, so at RUNTIME it passes vacuously - the Follow up tab
  could start sending `consistentRead: true` and the byte-identity watch item
  would stay green. Only `tsc -p tsconfig.test.json` (the app `typecheck`,
  `app/package.json:13`) rejects it, and that runs at S4.8, after S4.1 has
  been committed as GREEN.
- PR77 vs the S5 cross-slice note (L13254-13257: "the eight lists above minus
  'AI suggestions'" includes Tours today) - S7.11 follows PR77, but S5's note
  is still there for a builder reading S5.
- PR14 (author `teammate` gate) vs PR46 (struck); PR18 (`worker.ts` passes
  `events`) vs PR54 (no edit); PR35 (export the `selectPastTours` predicate)
  vs PR63 (there is none; export `isOffRangePastTour`); PR6 "same pointer
  handling" vs PR45.

What it implies. The plan does not stand on its own: correctness depends on
the builder cross-referencing section 4 for every step. At least one
divergence (the WI1 pin) produces a silently weaker test at the task's own
GREEN. Each ruling that changes slice text should be applied to the slice
text (or the slice step should say "apply PRnn: replace X with Y").

### 3. [LOW] W2: a staff Retry of an automated or system-copy row stamps, contrary to spec 7.2

What is wrong. PR11 (L248-249) passes `staffOutreach: true` on every Retry
except a share text (`original.broadcast_id === undefined`). The Retry route
re-sends ANY failed outbound row (`api.ts:1702-1890`), and the timeline
offers Retry on any failure (`dashboard/src/routes/contact/Timeline.tsx`,
`isFailure`). So a staff Retry of a failed missed-call auto-text, welcome
text, reminder or nudge (their rows carry `automated: true`, persisted on
every row the wrapper appends, `sendMessage.ts:305-313`) - or of a reminder /
nudge "Send now" row - stamps `last_reached_out_at`. Spec 7.2 says automated
copy never counts and reasons that "Send now" does not count because the copy
is the system's. The spec's W2 row is literal ("EXCEPT a retry of a share
text"), and the plan copies it without noticing the conflict.

What it implies. Rare, but a never-replied person drops out of Quiet shares
for 5 days because staff retried a system text. Either gate W2 on
`original.automated !== true` (the "Send now" case still needs the body rule
the backfill uses) or record the spec-literal choice for the planner. The
backfill (PR38) counts the same manual-retry rows, so whatever is chosen
should be applied to both.

### 4. [LOW] PR25 turns a soft-deleted unit into a raw unitId and a WARN on every Today load

What is wrong. PR25 (L385-389): "a throw or a missing/deleted unit logs WARN
`{ unitId }` once and returns the unitId". Spec 3 says the label is
`formatAddress(unit.address) || unitId` and degrades to the unitId only on a
FAILED lookup. A requested tour on a property that was later soft-deleted is
neither failed nor missing; Tours to book has no age limit (spec 5.4), so
that row shows an internal id to the VA indefinitely, and "once" is per
request - every Today load and every SSE refetch of every open dashboard
WARNs again.

What it implies. Use the address for a deleted-but-present unit (as the
Follow up formatter would) and reserve the unitId + WARN for a throw or a
genuinely absent item; or state why a deleted unit should read as an id.

### 5. [LOW] The type-filter-first unread pass stops hitting its cap, so the byUnread walk now runs to exhaustion on most loads; the cost is not recorded

What is wrong. The collect loop stops paging only at the cap
(`app/src/routes/today.ts:786`, lazy iterator, comment `:668`). Today the kept
set is every 1:1 bucket thread, so a busy unread index stops after 100 kept
rows. Under PR26 only `unknown_1to1` threads are kept (prod: about 8, spec
5.2), so the walk reads the whole byUnread index, up to the raw budget
(`UNREAD_WALK_LIMIT`, 2000, `today.ts:725`), on every load and every SSE
refetch, and the "underfilled" WARN (`today.ts:801-811`) fires whenever the
index exceeds the budget. Spec 6.5 and WI7 count only the Follow up core;
the WI7 harness case pins `unreadPages: 1` on a near-empty world (L12594).

What it implies. Not a correctness bug (the skipped threads cost no contact
read), but the per-load read cost grows in a way the cost issue S7.14 files
will not mention. Record it in WI7 / the new issue.

### 6. [LOW] PR17 stamps the `stranded`-after-send arm, an unflagged widening of spec W4 that the backfill cannot mirror

What is wrong. Spec 7.3 W4 stamps "when a leg of a team post comes back sent
or `sent_unrecorded`". PR17 / PR55 add `stranded` with `afterSend: true`
(`relayFanOut.ts:2304`), which is a record-phase failure - the slot write did
not land. S3's contradictions (L6039-6067) discuss the type shape but never
say this departs from the spec. The backfill's relay rule needs a slot with
`sid` and `sentAt` (PR38 L492-495), which a stranded leg may lack, so live
and backfill disagree on exactly that arm.

What it implies. Defensible (the provider accepted the text), but it should
be recorded as a deliberate deviation from spec 7.3 and its backfill gap
noted, so a spec-conformance reviewer does not have to re-derive it.

### 7. [LOW] S2.2 leaves a known-false comment in the shared harness and an unexamined behavior change in its default send path

What is wrong. After S2.2 the /api router's default send service reads the
router's `contacts` (in the harness, `world.contactsRepo`) where it used to
build its own real repo. The S2 cross-slice note (L3009-3014) says the
harness comment at `app/test/helpers/twilioWebhookHarness.ts:5590-5596`
("resolves its own contacts repo against real DynamoDB") "becomes stale" and
"the planner may fold a one-line comment fix into S7 or leave it"; no task
does. The same swap also means the deleted, opt-out and JIT consent gates
(`sendMessage.ts:511-559`) now judge world contacts on any harness test that
drives the default 1:1 send path; WI2 records only construction order. A
grep found few such suites (`relayApi`, `relayQueuedMessages` use the relay
path; `apiRoutes`, `rateLimit`, `retrySendAttempt` inject a service), so the
risk is small, but the plan asserts rather than checks it.

What it implies. Fix the comment in the task that causes it (or let S7 own
it explicitly), and have S2.2 name the harness suites that reach the default
1:1 send path so WI2 is a check, not a note.

### 8. [LOW] S6 C1 cites a reconcile adoption that does not exist

What is wrong. S6 C1 (L17663-17665) says the backfill also counts "the
reconcile's adoption of a ONE-TO-ONE staff send whose append failed". The
reconcile's owner kinds are `broadcast`, `relay_leg`, `relay_rung` and
`retry_send` only (`app/src/jobs/sendReconcile.ts:184-201`, `:247-263`);
`adoptRetry` writes `retry_of` / `retry_attempt` / `retry_window_start`
(`sendReconcile.ts:867-930`), which the backfill excludes as a machine retry.

What it implies. The S6 report would record a category that cannot occur.
Harmless to the code; correct the note so the RUNBOOK and report do not
describe a non-existent recovery path.
