# R2 code review - feat/today-checklist (tracker #31)

Reviewer: R2 (fresh; Claude Opus 5.5), 2026-10-24. Tree `W:\tmp\today-checklist`,
branch `feat/today-checklist`, HEAD b41088cd, base main @970a29b9. Contract:
spec r8 (`docs/superpowers/specs/2026-10-23-today-checklist-design.md`). Inputs
read: R1-spec-conformance.md, R1-adversarial.md, R1-adjudications.md,
FW1-report.md, the FW1 diff package (8ddf72e5..b41088cd) and the live tree.

Method: the current source was read (not only the diff) for the Today route,
the Follow up core, the Quiet shares builder, the dashboard Today page and its
hooks, the W1/W2/W3/W4/W7 writers and the backfill planner. Every finding
below was reproduced with a throwaway test that FAILED on the current code,
run bare from its workspace, quoted here, then deleted. No existing file was
edited, nothing was committed, no suite or e2e session was started. At the
end `git status --short` lists only this record.

Counts: HIGH 0, MEDIUM 0, LOW 2, INFO 1. Nothing loses, duplicates, strands
or misdirects a send.

---

## 1. What round 1 missed

### R2-2 - LOW - CONFIRMED - a per-section "unavailable" refetch, or a fallback refetch, still resets the viewer's Today state

Location:
- dashboard/src/routes/today/Today.tsx:484-488 (Tours to book swaps
  `UnavailableSection` for `ItemsSection`, two component types at one slot)
- dashboard/src/routes/today/Today.tsx:489 (`fallback ? null : <QuietSharesSection/>`
  unmounts Quiet shares on a fallback load)
- dashboard/src/routes/today/QuietShares.tsx:147-157 (`openByUnit` / `seeded`
  are component state), :159-167 (the 'unavailable' branch returns a tree
  without the LimitedList)
- dashboard/src/routes/today/TodaySection.tsx:65 (`expanded` is LimitedList
  state)

Behavior: FW1-1 keeps the page mounted when a whole GET /api/today fails. Two
other live-refetch transitions still unmount the per-viewer state, the same
defect class R1A-2 / R1SC-1 raised:

(a) A refetch where ONE section is unavailable (the route answers 200; spec
2.5 - any throw inside the Tours to book or Quiet shares computation) replaces
that section's list with "We couldn't load ...". When the next refetch brings
it back, its "Show all N" expansion is gone: Tours to book collapses to 5
rows, and Quiet shares' "Show all N properties" collapses to 5 property lines
(its open/folded choices do survive - QuietSharesSection stays mounted). This
path is not rarer than the one FW1-1 fixed: Quiet shares runs the Follow up
core on every load (tens of Queries at 10-way concurrency and a
`requireComplete` contacts BatchGet, followUps.ts:193-199, which throws on
unprocessed keys), and Tours to book is the section most likely to sit past
5 rows (prod 13).

(b) A refetch answered 404 (the client fallback, spec 3.1) unmounts
QuietSharesSection; the next server load remounts it and re-seeds: the first
property opens again and every other choice folds.

Why wrong: spec 6.3 ("After that, the viewer's choices are kept by unitId
across live refetches"), spec 2.1 ("Expansion is per-viewer page state only
(lost on reload; not stored)"), plan PR34 - the rules R1-adjudications FW1-1
enforced, on paths its scope left out.

Evidence: dashboard/src/routes/today/zz-r2-2.test.tsx (deleted), the real
useToday under the real page (Today.refetch.test.tsx's harness; the api
barrel and useTodayPastTours mocked), `cd W:/tmp/today-checklist/dashboard &&
npx vitest run src/routes/today/zz-r2-2.test.tsx`:

    x Tours to book: a Show all expansion survives one refetch where the section was unavailable
      -> expected [ ...(5) ] to have a length of 7 but got 5
    x Quiet shares: "Show all 7 properties" survives one refetch where the section was unavailable
      -> expected [ <button ...(5)>...(3)</button>, ...(4) ] to have a length of 7 but got 5
    x Quiet shares: open/folded choices survive one FALLBACK refetch (a 404)
      -> expect(element).toHaveAttribute("aria-expanded", "false")
         Received: aria-expanded="true"
    Test Files  1 failed (1)
         Tests  3 failed (3)

(each case asserted `getToday` was called 3 times and waited for the
section's own unavailable copy or the fallback line before recovering).

Fix: keep the per-viewer state above the branches. Either lift LimitedList's
`expanded` into a Today-level map keyed by the section label (passed down as
`expanded` / `onToggle`), and lift QuietShares' `seeded` / `openByUnit` the
same way; or keep the components mounted and render the unavailable copy (and
the fallback's nothing) inside them. Commit the three cases above.

### R2-3 - INFO - CONFIRMED - the 404 fallback still lists one person twice in Identify

Location: dashboard/src/routes/today/buildToday.ts:263-281 (one identify row
per unknown_1to1 THREAD, refId = the thread's participant contactId; no
de-dupe), rendered by dashboard/src/routes/today/TodaySection.tsx:73 (key
`contact:<id>`).

Behavior: R1A-1's shape, closed on the server by FW1-2, remains on the client
fallback: an unknown contact with a phone thread and an email thread gets two
rows under one React key, and "Show all N" counts them twice. Spec 3.1 keeps
the fallback's own copy and unread rule, not a per-thread row count. The
fallback runs only when GET /api/today 404s, so this is effectively dead in
prod - INFO.

Evidence: dashboard/src/routes/today/zz-r2-4.test.ts (deleted), pure
`buildTodayFromSources`:

    x one unknown contact with a phone thread and an email thread is one Identify row
      -> expected [ 'contact:ct-1', 'contact:ct-1' ] to deeply equal [ 'contact:ct-1' ]
    Tests  1 failed (1)

Fix: a Set of emitted identify refIds in the fallback loop (first thread
wins), or record it as accepted fallback residue.

---

## 2. The FW1 diff, reviewed cold

### R2-1 - LOW - CONFIRMED - FW1-2's identity de-dupe keeps the unread row unconditionally, so the person's only Identify row can be blank or out of order

Location:
- app/src/routes/today.ts:1034 (`emittedIdentifyContactIds.add`), :1040
  (`who: whoOfConversation(conv, owner)`), :1045 (`at: createdAtRank(owner)`)
- app/src/routes/today.ts:1140 (the triage pass now skips that contactId)
- app/src/routes/today.ts:1345-1352 (`whoOfConversation` returns '' for an
  email thread with no display name and an unnamed or unresolved owner)

Behavior: when both passes meet one contact, FW1-2 keeps the unread pass's
row and drops the triage row. The two rows differ exactly where FW1-2's change
lands (an email thread is the only kept thread that records no phone):
- `who`: the unread row reads nameFromContact(owner), else the thread's
  display name, else the thread's phone - '' for an email thread. The dropped
  triage row read nameFromContact(contact), else the contact's phone, else the
  id. So an unnamed unknown contact whose newest thread is an email thread now
  has ONE row with a blank `who`, although their phone (and here a display
  name on their phone thread) is known. Before FW1 the same person had two
  rows, one of them named (R1A-1's evidence: two `contact:c-dupe` rows).
- order: when the unread pass could not read the owner (getContact degrades a
  failed read to undefined, today.ts:472-477), its row ranks +Infinity and
  sorts LAST, with who '' even for a NAMED contact; the dropped triage row
  carried the contact's created_at and name. A transient read failure now
  moves the oldest unknown contact to the bottom of Identify, unnamed.
This is the FW1-report's "display residue" (item 1). Judged: real, and wider
than the report says - it also changes order (5.2: oldest first), not only
`who`. Narrow (an email-newest or email-only unknown, or a failed point
read), no send impact - LOW.

Why wrong: spec 5.2 ("Row text unchanged: who + 'New unknown contact'";
"Order: oldest first by the contact's created_at"); the de-dupe was meant to
remove a duplicate (adjudication FW1-2), not to replace the row that named
and ranked the person with one that does neither. The pre-existing pin
todayApi.test.ts:743-781 already treats "the email thread's blank `who`" as
the row not to keep.

Evidence:
- app/test/zz-r2-1.test.ts (deleted), FW1-2's own fixture (c-dupe: phone
  +15550108888 on the contact, a phone thread named 'Dee Dupe', a NEWER email
  thread with no display name), `cd W:/tmp/today-checklist/app && npx vitest
  run test/zz-r2-1.test.ts`:

      x FW1-2 fixture (email thread newest): the one remaining row still names the person
        -> expected [ '' ] to not deeply equal [ '' ]
      Tests  1 failed (1)

- app/test/zz-r2-3.test.ts (deleted): c-old (named 'Olda', created
  2026-01-01, an unread email thread) and c-new (named 'Newt', created
  2026-06-01), with `contactsRepo.getById('c-old')` throwing once:

      x the oldest contact stays first when its unread email thread could not read the owner
        -> expected [ 'c-new', 'c-old' ] to deeply equal [ 'c-old', 'c-new' ]
      Tests  1 failed (1)

Fix: MERGE instead of skip. When the triage pass meets a contactId the unread
pass emitted, keep one row but take the better fields: `who` from
nameFromContact(contact) ?? formatPhoneForDisplay(contact.phone) when the
unread row's `who` is '' (or its owner was unresolved), and the triage
contact's createdAtRank when the unread row's rank is +Infinity (re-sort runs
after both passes, so this is a field update on the kept Ranked entry). A
cheaper partial fix - `whoOfConversation` falling back to the owner's phone
before '' - covers only the resolved-owner case. Pin `who` and order in the
FW1-2 tests, not only the keys (they cannot see this today).

### FW1-1, cold (useToday / Today.tsx) - no defect beyond R2-2

Walked as interleavings against useToday.ts:152-170:
- first load fails (prev 'loading') -> 'error', flag false; a later good
  refetch -> 'ready', flag false; a later failing refetch while still 'error'
  stays 'error'. Never 'error' with the flag set.
- good load L1, refetch R2 fails -> 'ready' + flag, L1's data kept; R3 good
  -> flag cleared. An event during a failed state schedules a refetch as
  before (debounce untouched), so recovery is automatic.
- abort races: R3 starting aborts R2's controller, so a late R2 failure or
  success is discarded by the `signal.aborted` checks (:158, :161); the flag
  can only be set or cleared by the newest request.
- fallback: a 404 refetch whose fallback succeeds clears the flag
  (source 'fallback'); one whose fallback reads fail sets it. The fallback's
  own unmount is R2-2(b).
- Today.tsx: the note occupies a fixed child slot (`refreshFailed ? <p/> :
  null`, :464), so later siblings keep their positions and no section
  remounts when it appears or clears. "All caught up" requires
  `!refreshFailed` (:438-439). The settling spinner beside the note
  (FW1-report item 2) needs past tours still 'idle' after a good load plus a
  failed refetch - harmless, agreed.
- Tests can fail: Today.refetch.test.tsx's `failThenRecover` waits for an
  alert and then its absence and pins `getToday` x3, so it cannot pass on a
  missed refetch; on the old hook the full-page error is the alert and the
  state assertions fail (the FW1 RED is consistent with this). The
  useToday.test.tsx cases fail on the old hook through `refresh-failed`
  'missing' / status 'error'.

### FW1-2 relay opt-out half - no defect

`optOutContactIds` (today.ts:795, :815, :843) is checked before the member's
reads and filled only on emit, so a member one group does not confirm is
still judged by the next. The surviving row's who, why, tag, refId and `at`
(now) equal the dropped duplicate's except `entry.name` when the contact has
no name; Needs you now's order is unchanged (duplicates were adjacent under
one key). Order and count verified by reading; no throwaway needed.

### FW1-3 / FW1-4 tests - can fail

Each pin drives its real writer and was mutation-proven RED in FW1-report;
re-read here: the share-adoption pin asserts the adopted row's broadcast_id
and automated plus the done/adopted record before the empty touch list, the
no-property broadcast pin asserts the outbound row exists, the import and
seed pins assert the written world is present before asserting absence - none
can pass on an empty table. The three drop-off rows ride the existing table
whose first assertion is the person present.

---

## 3. Adjudication challenges

- FW1 scope, FW1-1: PARTLY DISAGREE. The ruling cites spec 6.3, 2.1 and PR34
  but scoped the fix to a failed request; the same rules break on a
  per-section unavailable refetch and on a fallback refetch (R2-2). Extend
  FW1-1 rather than file it.
- FW1-2 scope: AGREE with the de-dupe; DISAGREE with "skip" as the mechanism
  (R2-1: it should merge).
- R1A-3 (past tours label every row): AGREE. Spec 5.3 binds labeling every
  Past row ("so Show all N counts the rows Today actually qualifies") and
  states the reload cost; lazy labeling would make Show all count unqualified
  rows. The cost is now recorded in docs/issues/today-quiet-shares-read-cost.md.
- R1A-4 (outbound attribution by the phone holder): AGREE. Spec 7.3 W1 names
  "the judged recipient (heldRecipient ?? phoneContact)"; moving the stamp is a
  spec change. RUNBOOK.md:563 now names the divergence; it belongs in the
  handback for Cameron.
- R1A-6 (pre-deploy Send-now Retry): AGREE. PR108 accepts it; the RUNBOOK text
  matches the backfill code (backfill-last-reached-out.ts:415-420 and the
  body rule at :283-287 exclude the Retry and a Retry of it).
- R1SC-4 (no count on the two section WARNs): AGREE. today.ts:757 and :1271
  carry `err` and `section` only; spec 2.5's "ids and counts only" is a PII
  ceiling both meet, and the quiet-shares core throws before any count exists.
- FW1-5 (R1A-5 comment only): AGREE with the plan's PR90 / WI8 ruling; the
  comment at today.ts:721-727 is accurate. Note for the handback: spec 8's
  "appears in Tours to book live" rests on GSI propagation inside one ~300 ms
  debounce; the e2e live check cannot see that (DynamoDB Local is synchronous).

---

## 4. FW1 verdicts

- FW1-1: REAL for the failed-request path (R1A-2 / R1SC-1's probes are now
  committed and pass); NOT CLOSED for the per-section unavailable and fallback
  paths (R2-2).
- FW1-2: REAL - both duplicate shapes are gone (one row per person in
  Identify and in the relay opt-out rows) - with a residue it introduced
  (R2-1: the kept row can be blank and sort last).
- FW1-3: REAL - five behavioral no-stamp pins, each mutation-proven.
- FW1-4: REAL - the three drop-off rows, each mutation-proven.
- FW1-5: REAL - the comment states the residue correctly.
- FW1-6: REAL - RUNBOOK.md:563 and the issue paragraph match the code (live W1
  stamps heldRecipient ?? findByPhone, sendMessage.ts:532 / :770-777; the
  backfill uses recipient_contact_id, else the roster-first rule,
  backfill-last-reached-out.ts:453-455).

---

## Swept, no finding

- useToday refreshFailed lifecycle, abort races and the Today.tsx slot
  positions (section 2 above).
- Today route: the 100 + 100 Identify caps; type filter, deleted skip and
  owner test ahead of the unread cap; tours_today time / tenant / tourId order;
  tours_to_book oldest-first with +Infinity last; the +Infinity tie handling
  in `byUrgency`; Tours to book and Quiet shares each in their own try/catch;
  no duplicate keys left in any server group (needsYouNowIds, followUpsIds,
  the AI byContact map, per-pairing listing sends keyed unitId + contactId).
  Pre-existing and not raised: the phone de-dupe can suppress a DIFFERENT
  needs_review contact holding the same phone as an emitted thread.
- Quiet shares: buildQuietShares thresholds, the subset invariant (candidates
  are the core's waiting rows), property and people order; QuietSharesSection
  keeps `openByUnit` across a quiet 'unavailable' refetch.
- Writers: W1 stamps once per staff send (first batch only, api.ts:1589) and
  emits contact.updated last and only on 'written'; W2 gate and system_copy
  inheritance (api.ts:1904-1920); W3 stamps after SES accepts, emits last
  (sendEmailMessage.ts:489, :552); W4 stamps only accepted team-post legs and
  emits one fresh-read conversation.updated per pass before the continuation
  (relayFanOut.ts:1589-1702); W7 stamps only the edited intro whose persisted
  body is the verbatim intro_body (relayFanOut.ts:1106-1161,
  relayAnnouncements.ts:332); stampRelayOutreach never throws.
- Backfill: relay slots keyed by contactId, phone slots skipped; the 30003
  rung writes its own `relay_retry_of` row (skipped); call rows are author
  'teammate' (originateCall.ts:177); edited intros match by body.
- e2e today-checklist.spec.ts: server truth read with a non-200 throw, a
  positive control before every live check, a no-reload flag; no vacuous
  absence found. The perf terminal contract (e2e/performance/routes.ts:405-416)
  does not list the new refresh note, which matters only if a sample's first
  terminal were read after a failed refetch - not raised.
- Dashboard contact.updated consumers: useContactTimeline refetches only for
  its own contact on the shared debounce; useInbox already refetched on
  conversation.updated.
- ASCII: this record is ASCII-only.
