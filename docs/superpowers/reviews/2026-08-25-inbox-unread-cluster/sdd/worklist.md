# Merged worklist - live-tree drift against the plan

Merged by the orchestrator from three read-only researchers. The BYTE-EXACT
reference lives in the three research files; this file is the DELTA - what the
plan says versus what the tree holds, plus the orchestrator's adjudications.

Research files (read the one that covers your slice):
- `.superpowers/sdd/research-inbox-route.md` - app/src/routes/inbox.ts
- `.superpowers/sdd/research-repos-unreadfeed.md` - contactsRepo / unreadFeed /
  contactThreads / today.ts precedent / tables.ts / logger / invariant sweep
- `.superpowers/sdd/research-tests-dashboard-e2e.md` - every test fixture, the
  dashboard, the e2e spec, the perf route pins, the issue file

VERDICT: the plan is BUILDABLE as written. No finding invalidates a task. The
deltas below are corrections to anchors and four small deliberate improvements.

---

## A. Anchor corrections (verified by the orchestrator, not just reported)

1. **Insert point for the flip is exact.** `inbox.ts` - the `filter === 'unread'`
   branch RETURNS at 1449, its closing `}` is line **1454**, 1455 is blank,
   **1456** is `const rows: InboxRow[] = [];`. Insert between 1454 and 1456.
   (The plan's "groups returns at 1034, unread at 1064" cites branch OPENINGS,
   not returns - harmless, but do not quote those numbers as returns.)

2. **`inboxGroups.test.ts`'s `filter: 'unknown'` test is at line 367, not 357.**
   The plan says 357 twice. Orchestrator-verified: `rg -n "filter: 'unknown'"`
   returns exactly one hit, 367. Its `contactsRepo` fake block is at 101-109.

3. **`inboxFeed.test.ts` has FIVE `filter: 'unknown'` call sites, not two:**
   lines **407, 433, 539, 610, 739**. The plan names only the tests at 387-409
   (needs no edit), 591-613 (rewritten in T5 step 9) and 736-766 (rewritten).
   The two it never mentions - **433 and 539** - are the tests that consume the
   two status-less `type: 'unknown'` fixtures at 417 and 521. T5 step 9's
   fixture edit (adding `status: 'needs_review'`) is exactly what keeps them
   green. RUN ALL FIVE and account for each; do not assume.

4. `unreadIndexFake.ts`'s LEK doc block is **104-117** (plan says 104-116).
   `:180-187` is exact.

5. `inbox.integration.test.ts`'s last `it` is **427-430**; the `describe` closes
   at 431. Insert the new test between 430 and 431.

6. The spec's "four lines past the range" for why `excludeOrigin` is safe in
   `today.ts` is **eighteen** lines past, at `today.ts:917-918`. The CLAIM is
   true; only the locator is wrong.

7. `lib/import/apply.ts:884-899` (cited in the plan's facts block) is the status
   DERIVATION. The contact WRITE is `upsertContact` at `:937-1053`, status at
   `:1023-1028`, and it is CONDITIONAL (`if (!preserveStatus)`).

---

## B. Comment retirement is EIGHT sites, not four (T5 step 6)

The plan's step 6 names four. The flip invalidates four more. All eight go in
the flip commit; a stale comment here is how the next reader re-derives a wrong
model, which is the specific failure this file's comments exist to prevent.

Plan's four:
1. read-accounting block ~599-623 ("filters `all` and `unknown`")
2. `passesFilter`'s `case 'unknown'` (~710-711) - needs the unread arm's
   keep-comment shape
3. `rowForConversation` header ~836-838 + its two unknown arms (~901) + the
   `unknownFilterRole` drop counter
4. relay-merge drop comment ~1571-1576 + group-source gate ~1599-1601

Found by research, ALSO stale after the flip:
5. **`inbox.ts:341-342`** - `decodeUnreadCursor`'s "a cursor minted under
   `all`/`unknown`". Unknown now mints none.
6. **`inbox.ts:804-807`** - `buildContactRow`'s "exactly like a no-contact
   number" - that is the class-(e) equivalence being retired.
7. **`inbox.ts:930-931`** - "NOT dead - it still runs for `all` and `unknown`" -
   becomes `all` only.
8. **`inbox.ts:1611-1617`** - the `filteredGroup` keep-comment asserts
   "`unknown` is gated out above" and "`filteredRelay` catches on `unknown`
   today". Both false after the flip.

---

## C. Adjudications (orchestrator decisions, with reasons)

**C1. The fake's `lastEvaluatedKey` shape - DEVIATE from the plan, improve it.**
Research: `contactsRepo.listByType` returns DynamoDB's raw `LastEvaluatedKey`
from a **GSI** query (`contactsRepo.ts:1021-1025`), so the real key is
`{ type, status, contactId }`. The plan's helper mints `{ contactId }` and its
test asserts `toEqual({ contactId: 'd2' })` - pinning a key shape production
never emits, inside the one helper the plan positions as "the authority on
partition semantics".
RULING: emit the full `{ type, status, contactId }`, keep resuming by
`contactId`, and say so in a comment. Update the three LEK assertions in
`contactsPartitionFake.test.ts` to `toMatchObject({ contactId: ... })` so they
still pin the resume position without re-pinning a wrong shape. Functionally
inert (no caller inspects the key; the collector passes it straight back), so
this cannot move any behaviour pin - it removes a false authority.

**C2. `deleted` is BINARY in code, not tri-state.** `opts.deleted === true` vs
everything else, and the FilterExpression is ALWAYS present (`listByType` can
never issue an unfiltered Query). The spec's operative claim - "all unknown
contacts, deleted included, is not expressible in one Query" - is TRUE either
way, so nothing in the design moves. Do NOT edit the spec (it is gated). The
plan's facts block says "tri-state"; leave it. Record in the handback.

**C3. `warnDeletedProbes` uses a SEPARATE limiter from `warnUnreadScanned`.**
The plan's branch comment claims "the two bind to ONE module-scope limiter, so
a request that trips both emits one line, never two" - and that claim is about
the in-collector scan warn versus the caller's `warnUnreadScanned`, both of
which do use `warnWalkScanned`. So the comment as written is CORRECT. Ship it
unchanged. (A request that trips the scan tripwire AND the probe tripwire emits
two lines, but the comment never claimed otherwise.)

**C4. `twilioWebhookHarness.ts` stays frozen, including its misleading comment.**
Its `:1692-1696` comment claims it "MODELS `Limit` AS DYNAMODB APPLIES IT",
which is true for `excludeOrigin` only and FALSE for `deleted`/`status`. That is
a trap for a future builder - but the plan freezes this file for a good reason
(the `today.ts` triage pins are calibrated against its semantics) and a comment
edit is out of this branch's scope. Do NOT touch it. The orchestrator surfaces
it in the handback.

**C5. Do NOT write a test that asserts on a TRIPWIRE warn.**
`warnWalkScanned` / `warnProbeBurst` are module-scope, 5-minute, with NO reset
seam: the second test in a file that trips the same tripwire is SUPPRESSED, and
every emitted line carries a `suppressedCount` field (so `toEqual` on the fields
object fails). Every WARN the planned tests assert on is a plain `log.warn` from
the collector or the branch - keep it that way.

---

## D. Confirmed-safe, do not re-litigate

- **Perf seed survives (T6 step 5).** Default seed = 100 contacts ->
  `floor(100/100)` = exactly ONE unknown contact, `perf-contact-00095`:
  contact-backed, `status: 'needs_review'`, NOT soft-deleted, participant in
  ~32 open non-relay 1:1 threads. `performanceSeed.integration.test.ts:414`
  (`unknown.rows.length > 0`) is expected to pass. Margin is ONE row - if it
  goes red, diagnose, do not weaken.
  Do NOT be alarmed by `:282` asserting the perf `unknown` CONTACT partition is
  `[]` - that is the 22-contact manifest (`floor(22/100) = 0`) hitting the repo
  directly, untouched by the flip.
- **The 400-on-cursor posture is NOT a UI break.** `useInbox.ts:205` never sends
  a cursor on the first page; `:340` is the only cursored call and sits behind
  the `:320` guard `if (cursor === null ...) return;`; `cursor` is only ever
  written from `nextCursor` and is reset on filter change (`:301`);
  `hasMore = cursor !== null` (`:546`) so no Load-more even renders. No `cursor`
  search-param is read anywhere in `routes/inbox/`.
- **The second `aggregateInbox` caller is safe.** `app/scripts/profile-inbox.ts`
  drives `inboxDiagnostics.ts:70`'s `unknown-page` case as
  `{ kind: 'inbox-page', caseId: 'unknown-page', filter: 'unknown', limit: 30 }`
  - orchestrator-verified: NO cursor anywhere in that path. It uses real repos,
  so `listByType` resolves. Its saved trace SHAPE changes (that is the point of
  the branch); nothing breaks.
- **Every e2e assumption in T8 holds exactly:** `placeCall`:19, `reseed`:20 +
  34-36, `uniqueVoicePhone`+`NEXT`:21, `devLogin`:27-32, `BUSINESS`:25.
  `GET /api/contacts?type=unknown` is real (`contacts.ts:957/1003/1005` ->
  `{contacts:[...]}`) and already polled by the shipping test. The
  `a[href="/contacts/<id>"]` + `/needs triage/i` pair is a verbatim copy of an
  assertion already in that file. `lean.ts` seeds exactly 3 contacts
  (tenant/landlord/partner): ZERO unknown, ZERO team_member.
- **`e2e/README.md` needs NO edit** (T9 step 2's expected outcome): line 194
  already says "no cursor accepted as profiler evidence".
- **A third independent enforcement of "never set `truncated` on unknown"**
  exists: `e2e/performance/routes.ts:399-406`'s `inboxTerminal` - a cleared
  queue that lit the alert would satisfy two terminal branches and break the
  perf harness. Extra reason to get the return shape right.
- The webhook harness's fidelity gaps are CONFIRMED as the plan states them
  (deleted-before-Limit at :1691 vs slice at :1701; items-remaining LEK at
  :1707) and it DOES honour `status` (:1689, partition-level, correct) and
  `excludeOrigin` (:1702-1705, page-level, faithful). A third gap the plan
  names is also confirmed: no GSI-sparseness filter.

---

## E. Invariant sweep - contact type/status/origin/deleted_at write surfaces

The protected state is "which contacts land in the `(type='unknown')`
byTypeStatus partition". Plan's claim - every current write path sets a
`status`, so a status-less unknown is a fake-fidelity concern and not a shipping
defect - is TRUE, but its list was incomplete. Also writing status:
`routes/public.ts:257-259`, `routes/unmatchedEmail.ts:461-468`, the triage PATCH
`routes/contacts.ts:1520` (the ONLY re-type path; status set conditionally at
`:1462-1478`), `statusTransition.ts:342/597`,
`suggestionResolutionRepo.ts:691`, and all five seed writers.

THE REAL HOLE, and it is small: `contactsRepo.update`'s documented
`null -> REMOVE` convention makes `update(id, { status: null })` a legal,
index-dropping write - the `EmptyIndexKeyError` docstring (`:428-429`) says so
outright. **No current caller does it.** So the correct wording is "no caller
nulls status", not "impossible". Not a blocker, not this branch's job to fix;
T9 may note it in one clause, and the handback names it.

Readers of `listByType('unknown')` in the whole tree: production is ONLY
`today.ts:865` plus the generic `routes/contacts.ts:1003` (reachable as
`?type=unknown`); the rest is the instrument
(`measure-unread-contact-coverage.ts:619/644/775/818`). The new collector makes
three.

---

## F. Order of build (unchanged from the plan)

T1 -> T2 -> T3 (COMMITTED GREEN before inbox.ts is touched) -> T4 -> T5 -> T6
-> T7 -> T8 -> T9 -> T10. Sequential, one implementer at a time, one commit
each.
