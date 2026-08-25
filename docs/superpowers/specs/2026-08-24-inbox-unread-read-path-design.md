# Inbox unread read path (cluster C1) - design

Status: **SPLIT.** Section 2 (the diagnosis and its fix) SHIPPED on
`feat/inbox-unread-read-path`, merged to `main` @88ac7b36. Sections 3 through 10
- the anchors and the riders - were REWRITTEN on 2026-08-25 after the first
draft failed adversarial review, and have not yet passed the human's spec gate.
They are `feat/inbox-unread-cluster`'s work.

The split was the human's call once the diagnosis landed: the `useInbox` fix is
self-contained and verified (250/250 on the spec that reproduced at 1-in-38),
and holding it behind a twelve-issue build would both delay an
operator-visible fix and produce a diff too large to review well.

Branch: `feat/inbox-unread-cluster`, cut from `main` @88ac7b36. (Section 2's
shipped work was `feat/inbox-unread-read-path`, cut from `main` @5355b7ae.)
Cluster: [`docs/issues/_CLUSTERS.md`](../../issues/_CLUSTERS.md) section C1.

## 1. What this mission is

Cluster C1 is one read path seen from several angles: the sparse `byUnread`
index walk that backs the nav badge and the Unread tab, the two mark-read
fan-outs that maintain it, and the open-partition pager that backs every other
tab. The human scoped this mission to sweep the WHOLE cluster rather than the
two highs alone.

Thirteen issues were listed under C1. One
(`unread-index-integration-coverage-requires-local-dynamo`) is already
`status: resolved` - closed 2026-08-21 by the `globalSetup` throw - so the
cluster table's row for it is stale and is corrected as part of this work.
Twelve remain, plus the diagnosis below.

## 2. The diagnosis that came first, and what it changed

The mission opened with a diagnosis phase because two of the four candidate
explanations for the routed e2e evidence would have changed what gets built.
It is complete, and the answer was none of the four hypotheses that implicated
the read path.

**Root cause: `useInbox` installed a page fetched for a filter the operator had
already left.** `scheduleRefetch` closes over the `fetchFirstPage` of whichever
filter was active when the SSE event arrived; nothing cancelled it on a filter
change (the clearing effect had empty deps, so it ran only on unmount), and
`fetchFirstPage` committed whatever it fetched with no filter-identity check.
Mark-read on Unread fires `conversation.updated`; the operator switches to All
inside the 300ms debounce; the stale reconcile lands, and because mark-read has
just emptied the unread feed it installs ZERO rows. One bad page sticks until
the next event happens to arrive.

Evidence, from a reproduction on iteration 38 of a 150-repeat soak on a quiet
machine, with the read accounting added in `360c5a6d`:

```
-28553ms  ASSEMBLED all     count=4 rawScanned=2   <- All tab fetch; row visible
-28395ms  ASSEMBLED unread  count=0                <- lands INTO the All tab
   ...    28 seconds of silence, then the click times out
```

Every `filter=all` response in the failing iteration carried a full page. The
emptying request came from the browser (Chrome user-agent), not the test's API
helper. Fixed in `52ebafc8`; verification is a re-soak of the same spec.

**What this changes for the rest of the mission.** The two highs are real - but
they were not what made the row vanish, and the mission must not claim
otherwise. Note that "built exactly as their issues prescribe" stood here until
2026-08-25 and did not survive the re-adjudication in section 3; half the
cluster's prescriptions turned out to be wrong. Specifically:

- `call-inbox-unread-detached-node-flake` closes on the `useInbox` fix. Its
  three sightings are ONE defect: the detached-node shape and the
  ready-and-empty shape are the same event, because the node detaches when the
  list is replaced by an empty one. The reproduction exhibits both signatures
  at once.
- `inbox-row-appearance-e2e-flake` is NOT closed on a guess. Its
  `inbox-markread.spec.ts` half is plausibly the same defect - that spec
  switches tabs with inbound traffic in flight, and a stale ALL page installed
  on the Unread tab is then narrowed client-side to unread rows only, which
  reproduces "the row did not appear". Its `deleted-contact-resurfacing.spec.ts`
  half uses full page loads, where no timer survives the mount, and is not
  explained by this mechanism. It has not reproduced in 8+ full runs, so
  neither half can be verified directly. The issue is updated with both
  findings and stays open.
- The routed issues' shared premise - "a whole open-partition read answered
  EMPTY" - is disproven and is corrected in both files. The inference was
  reasonable from browser-side artifacts alone; it did not survive a
  server-side log.

## 3. Re-adjudication, and what it changed

Sections 3 through 8 were rewritten on 2026-08-25. The previous draft failed an
adversarial review, and rather than patch it against the same issue files it was
written from, the twelve open cluster-C1 issues were re-verified against `main`
@88ac7b36 by twelve independent read-only agents - one per issue, each briefed
WITHOUT the planner's priors, so that agreement between them counts as evidence
rather than echo. A thirteenth agent was sent at R11, which is not a C1 issue
but sits in this spec as a rider and carried two unresolved review objections.
Reports: `W:\tmp\handbacks\c1-readjudication-2026-08-25\`.

**Result across the twelve: 6 still-valid, 6 remedy-wrong, 0 already-fixed.**
Nothing self-healed. Every defect still reproduces. What decayed is the
REMEDIES - half the "Suggested fix" sections were wrong, no-ops, or aimed at a
path that does not behave the way the issue claims. The issues were filed
2026-08-16 to 2026-08-21; that is roughly a one-week half-life on a prescribed
fix in this repo.

**The rule this mission now runs on: an issue's "Suggested fix" is a CLAIM, not
a finding.** Every remedy below is written from code that was read, and the
disproven ones are recorded as disproven so nobody re-proposes them. Where a
remedy needs a decision that is not an engineer's to take, it says so instead of
inventing one.

Two premises the old draft was built on are false, and both are load-bearing:

- **The badge and the page-fill loop are DIFFERENT endpoints.** `countUnreadRows`
  makes exactly ONE `collectUnreadRows` call, and its `maxRows`
  (`BADGE_COUNT_CAP` = 100) already equals the internal query page size. The
  fill loop lives in `aggregateInbox`'s `filter=unread` branch. Three agents
  established this independently. The old draft sequenced the fill loop first
  "because it is contributor 2 of the badge high" and then gated the badge
  decision on re-measuring it - a plan that would have measured no badge
  improvement, because none was structurally possible.
- **The badge's blocking premise - "no `contactId` on the conversation item to
  batch with" - is false.** `participants` carries `{contactId, phone}`, and
  `contacts.getManyByIds` shipped 2026-08-21, the same day the issue asserted
  the tool did not exist.

  Two supporting arguments this section originally made have since been
  WITHDRAWN and must not be repeated downstream: that `captureContact` claims
  the link before `incrementUnread` indexes the row (true on one of six paths -
  see 4.1.a), and that `today.ts:1086` reading it off the same walk is
  reassuring precedent (it reads `participants[0]` as a RULE and drives the
  deleted-contact skip from it, which is a bug to file, not a precedent). The
  premise survives without them; the field exists. How OFTEN it is usable is
  4.1.a's question, and it is open.

## 4. The two anchors

### 4.1 unread-badge-request-round-trip-cost (high)

The defect is one serial `findByPhone` GSI Query per 1:1 index item SCANNED,
unbounded to `UNREAD_WALK_LIMIT` = 2000. The row cap cannot fire inside a
residue wall, and the deleted-contact probe bound stops MESSAGE reads only,
never the contact lookups - it also sits downstream of an already-paid Query.
This is the app's highest-frequency request.

**Human ruling 2026-08-25 (first pass): build the read-through directly, no
measurement gate.** The earlier "measure, then decide by rule" ruling had been
given on the two false premises in section 3 and was void.

**Human ruling 2026-08-25 (revised, after review round 1): MEASURE FIRST.** Not
to decide whether to fix it - the defect is real and the read-through is the
right shape - but because a review finding showed the fix could ship green and
save nothing, and the stated acceptance could not have detected that. The
ruling was not wrong when it was made; the fact that changed it did not exist
yet.

### 4.1.a The measurement slice - runs BEFORE any read-through code

Reviewer A found, and the author verified, that the coverage this fix depends on
is largely unestablished:

- There are SIX `incrementUnread` call sites (`twilio.ts:709`, `:1018`,
  `:1787`, `:2258`, `voice.ts:400`, `inboundEmail.ts:749`) and TWO
  `captureContact` call sites (`twilio.ts:2187`, `voice.ts:606`). The claim in
  section 3 that capture precedes indexing is demonstrable for ONE path of six.
- Capture failure is swallowed even where it runs.
- There is no backfill FOR THIS FIELD. (Draft 2 said "`app/src/scripts/` does not
  exist" - a wrong-directory non-fact. `app/scripts/` holds four backfills,
  including one for this very index, which is the pattern to follow.)
- `contactId: ''` is a live steady-state class the importer can create on an
  established row - see
  [`import-blanks-conversation-participant-contactid`](../../issues/import-blanks-conversation-participant-contactid.md).

The question: of the 1:1 items the `byUnread` walk returns, what fraction carry
a participant entry with a NON-EMPTY `contactId` that resolves to a live
contact?

**RESOLVED 2026-08-25: the human runs it and hands back the number.** The
instrument now exists - `app/scripts/measure-unread-contact-coverage.ts`,
read-only, PII-free, gated behind `--confirm` and an explicit `TABLE_PREFIX`. It
is a SEPARATE script rather than a flag on `profile-inbox.ts`, deliberately:
that harness is hard-gated to the local lane, and loosening the gate to reuse it
would remove a guard that exists for good reasons. It implements 4.1.b condition
1's selection rule rather than an easier one, and counts a non-empty
`contactId` as coverage only when it RESOLVES. Its classification was verified
against a synthetic fixture covering every bucket, including a dual-key row.

The record of WHY this needed a ruling is kept below, because it is the reason
the number will mean anything.

**This slice was BLOCKED on a human decision, and saying so was the point.** Both
round-2 reviewers independently found that draft 2's version could be satisfied
while learning nothing. Three things were missing and only one is fixable by an
engineer:

- **No threshold.** "High" versus "low or mixed" named no number and no
  classifier. Proposed and fixed in advance so the result cannot be
  rationalised afterwards: **>= 95% usable is high; <= 80% is low; anything
  between is mixed and escalates.** These are proposals, not rulings.
- **No vehicle.** Nothing in the repo measures `contactId` coverage today.
  `app/scripts/profile-inbox.ts` is the nearest harness and already instruments
  both `aggregateInbox` and `countUnreadRows`, but it is hard-gated to
  `localhost:8000` and `hc-local-` tables. Extending it is small work.
- **No legitimate dataset - THIS is the human decision.** The hermetic lane is
  seeded, so it answers with the fixture coverage the slice exists to distrust.
  Dev and prod are off-limits to an agent under AGENTS.md. The founder's local
  imported dataset is exactly the interesting shape and is named as a human item
  in decision 5. So a builder cannot legitimately take this measurement at all,
  and draft 2's fix for one review finding reintroduced another.

See section 8 decision 6. Until it is answered, this slice is a specification,
not a task.

**The decision rule, once a dataset exists:**

- **High coverage** - build the read-through as specified below; the fallback is
  a tail case.
- **Low coverage** - the read-through is NOT the first change. Fix the capture
  paths and add a backfill FIRST, because a fallback that fires on most rows is
  today's cost with extra code in front of it. NOTE that branch is an unscoped
  expansion in its own right - four capture paths plus a backfill across two
  environments is infrastructure work needing its own human go, not a
  continuation of this mission.
- **Mixed** - escalate with the number rather than picking.
- **Either way** - the fallback ships, and acceptance measures SAVED round trips
  on real-shaped data. Draft 2 contradicted itself here, telling the builder to
  use real-shaped data in one sentence and the existing fixture-based call-count
  tests in another. The fixture tests remain valid for the mechanism; they
  cannot establish the saving.

### 4.1.b The read-through

Resolve the contact from the `participants` entry already on the conversation
item and batch through `contacts.getManyByIds`. Five conditions, none optional:

1. **Select the entry by a phone-then-email CHAIN, not a per-kind branch.**
   Draft 3 said "the phone for a phone thread, the single entry for an email
   thread", and review found that branches on a partition WHICH DOES NOT EXIST:
   `attachEmailToConversation` stamps `participant_email` onto an existing PHONE
   thread by design, and both live readers already handle it as an explicit
   `findByPhone` then `findByEmail` chain. A per-kind branch has no rule for the
   dual-key row and turns a resolvable contact into exactly the phantom
   `unknown` row condition 2 exists to prevent - a new hole created by round 2's
   fix for a different one.

   So: try the entry matching `participant_phone`; if there is none and the row
   carries an email, apply the email rule; only then call it a miss. Do NOT make
   `participants[0]` a rule: `contactCapture.ts:164` states the opposite in the imperative ("never
   `participants[0]`: an entry for another phone is..."), and
   `conversationsRepo.ts:1354-1356` records the convention as "readers key on
   contactId FIRST". Both round-1 reviewers proposed reverting to `[0]`; that
   was rejected and the continuing reviewer withdrew the proposal in round 2 -
   while correcting the basis of my rejection, which matters. "It would
   reintroduce the positional bug" is NOT true for the class actually in
   dispute: an email-only row has exactly one entry, so "the single entry" and
   `[0]` are the same expression there. `[0]` is unsafe as a GENERAL rule and
   merely unremarkable on that row.

   **The gap that leaves, and how it closes.** "The single entry" is an
   assertion, not a selector, and its natural implementation IS `[0]` - so the
   rule degenerates into the thing it forbids. Close it explicitly: **if an
   email thread carries more than one entry, do not pick. Fall back to
   `findByEmail` and log it.**

   `today.ts:1086` is now resolved and stops being cited as precedent either
   way: it DOES use `[0]` as a rule, and it drives the deleted-contact skip from
   it. That is a bug to file on its own, not evidence for anything here.
2. **Fall back on any UNUSABLE `contactId`, empty string included.** The
   un-backfilled shape is `''`, not `undefined`. An empty string is not a valid
   key: it throws on `BatchGetItem`, and a default batch helper can drop the
   WHOLE 100-key chunk rather than one row - degrading up to 100 unread rows to
   phantom `unknown` rows, which is the exact symptom this cluster exists to
   remove. Filter empties out BEFORE the batch. Fall back to `findByPhone` for a
   phone thread and `findByEmail` for an email thread.

   **What draft 2 got wrong here:** it also prescribed "use the existing
   `requireComplete` semantics", which quietly DECIDES the open question in
   decision 2 below, and decides it the harshest way. `requireComplete` throws,
   and the badge path deliberately does not catch - so a partial batch would
   become a 500 with no badge at all, replacing today's degrade-to-no-contact.
   Both round-2 reviewers caught this. A condition list headed "none optional"
   must not contain a decision the same document calls open. The choice is
   decision 2's; this condition only requires that whatever is chosen, a short
   response is never silently read as "these rows do not exist".
3. **Bound the look-ahead** by `maxRows - candidates.length`. The reason is not
   "laziness" - it is that this preserves `scanPosition == last consumed item`,
   which is what the cursor is minted from. A fixed 100-key batch would keep the
   letter of the bound and LOSE ROWS.
4. **Failed-batch semantics - RULED, see section 8 decision 2: fall back to the
   per-row lookup and keep the badge.** Never silently read a short response as
   "these rows do not exist".
5. **Attribution staleness - OPEN, see section 8.**

Two remedies stay ruled out and must not be re-litigated: the per-collect memo
(implemented and removed - it can never hit, because the claim arbiters
guarantee at most one OPEN conversation per participant key), and bounding
contact resolution (it re-creates the walk-stop class that makes the badge lie).
`BatchGetItem` cannot read a GSI, which is why the old `findByPhones` was never
buildable - but `getManyByIds` reads the base table by key and is fine.

**Acceptance is round-trip COUNT, not wall-clock** - local DynamoDB timings are
emulator-bound. Assert call counts as `app/test/inboxFeed.test.ts` already does,
on a realistic shape and on a residue-wall shape, to prove the MECHANISM. Those
fixture tests cannot establish the SAVING, because they supply the very field
production may lack; that is 4.1.a's job and this paragraph is subordinate to
it. Draft 3 left the two statements contradicting each other in different
sections.

### 4.2 mark-read-fanout-stale-gsi-skip (med, was high)

Both mark-READ fan-outs filter their candidate list on the `unread_count` they
just read through the eventually-consistent `byParticipantPhone` /
`byParticipantEmail` GSIs, which lag independently of `byUnread`. A stale ZERO
skips a genuinely unread thread: no `resetUnread`, no `conversation.updated`,
and the row stays in the sparse index. The client opens the window by design -
the mark-read POST is fired from a payload-blind `message.persisted`
subscription, milliseconds after `incrementUnread`.

**Corroboration from this mission's own shipped work:** the read path documents
this exact lag shape in place - the window where `byUnread` carries the
increment and `byParticipantPhone` still shows the pre-increment
`unread_count: 0` - and closes it with an authoritative base-table point read.
The WRITE path never got the same treatment.

**Severity high -> med.** The skip is sticky but not permanent: later events
re-drive the fan-out or reset by `conversationId`, and the row stays visible in
the Unread tab meanwhile. Review narrowed this - the "five later events" of the
first draft are largely four retries of the SAME defective route, which weakens
the argument without reversing it. The row staying visible is what carries the
downgrade, not the number of re-drives. Do not carry the `contacts.ts` permanence
argument across - that fan-out genuinely never re-runs; these two do.

Add `resetUnreadIfUnread` to `conversationsRepo`, call it UNFILTERED from both
fan-outs, treat `ConditionalCheckFailedException` as "already read", and emit
`conversation.updated` only when a write actually happened. Three corrections to
the issue's original prescription:

- **Compose the condition as `attribute_exists(conversationId) AND
  attribute_exists(unread_flag)`, AND request
  `ReturnValuesOnConditionCheckFailure`.** The two-conjunct form is correct as a
  GUARD but useless as a DIAGNOSTIC on its own: DynamoDB returns one
  `ConditionalCheckFailedException` and does not name the failing conjunct, so
  "row missing" and "already read" remain indistinguishable - which is what the
  clause was added to separate. The identical expression already ships elsewhere
  in the repo disambiguating nothing. The issue file prescribed the return-values
  mechanism; the first draft of this spec kept the clause and dropped the
  mechanism, which is a fair example of satisfying the letter of a fix. **State
  the READING, not just the flag** - naming `ReturnValuesOnConditionCheckFailure`
  without saying how the returned item is interpreted repeats the same omission
  one level down. The in-repo precedent is `poolNumbersRepo.ts:564` and `:580`:
  an absent item means the row is gone, a present item without the attribute
  means already read.
- **The "spends neither" capacity claim is deleted.** A failed conditional write
  saves the item mutation, the stream record and the SSE fan-out - not WCUs.
- **Name the cost it adds.** This turns zero writes into N conditional writes
  per request, multiplied by the payload-blind client trigger. The client-side
  complement is its own item, not folded in here.

**Counter-only rows - the objection, and the answer.** A spec reviewer argued
that gating on `unread_flag` would strand rows carrying a stale `unread_count`
with no flag, re-creating the unclearable-thread bug on a different class. That
class is empirically empty: the 2026-08-17 backfill dry run skipped 771/771 in
dev and 786/786 in prod. The remaining exposure is the founder's local
`hc-local-` dataset, which the RUNBOOK still lists as owing `db:update-gsis`
plus backfill. The first draft told the BUILDER to confirm it; review pointed
out a builder cannot, so it is a human item - section 8, decision 5. Note also
that the 771/786 evidence is a hand-typed RUNBOOK line, not a machine artifact.
This is exactly the guard that gets added by omission rather than by decision.

The two call sites are `POST /api/inbox/read` (phone in the BODY - the old draft
named a `/unknown/:phone/read` route that does not exist) and
`POST /api/inbox/:contactId/read`.

Regression test: **not** a repoint of the `stalePositiveOnFirstRead` seam. The
first draft prescribed that, and review showed it cannot stage this defect - it
stales ONE call, is phone-only (so it never exercises
`findByParticipantEmail`), lives in a mark-UNREAD describe, and stages an image
that is physically impossible for this path. Use the contact-soft-delete test's
staging pattern instead, which the issue file already named and the first draft
dropped. Whatever is written, mutation-probe it by restoring the filter - and if
the probe does not go red, the test is not testing this. `resetUnreadIfUnread`'s conditional-failure behaviour is
proved against the real repo in the
`app/test/updateCallStatus.integration.test.ts` pattern, because the fakes
cannot carry DynamoDB condition semantics.

## 5. The generator-contract slice

**These four were filed as four independent riders. They are one tangle.** Three
agents independently proposed edits to the same few lines of
`app/src/lib/unreadFeed.ts`, and two found that a neighbour's remedy was a no-op
or unreachable precisely because of the coupling. They ship as ONE slice with
ONE flag contract, not as four riders sequenced against each other.

The contract has four members: `capped`, `scanExhausted`, `truncated` and
`consumedAll`. **`consumedAll` is NOT new** - the first draft said it was, and
that was wrong. It ships today as `consumedAll: !capped && state.scanExhausted`,
and `scanExhausted` lives on the walk STATE, not on the collect result. Today
`truncated` is derived as `!capped && !scanExhausted`, the budget exit never
writes `scanExhausted`, and a consumer that breaks at the cap leaves the
generator suspended at its `yield`, so the line that would set `scanExhausted`
never runs at all.

**Do not derive `consumedAll` from `scanExhausted` alone.** That deletes the
`!capped` guard it carries today, and the reason for that guard is written in
place next to it - conflating the two made every under-budget dataset report
wrongly. The obvious later "simplification" turns this into ROW LOSS. Whatever
the slice does, that guard survives or its removal is proved safe in writing.

### G1 - the natural end is undetectable (`unread-load-more-empty-on-exact-multiple`)

DISPROVEN first: "report `scanExhausted` independently of `capped`" is a literal
no-op. `scanExhausted` is already `false` at the cap break, so the change ships
green having altered nothing - and the only mechanical way to make it non-no-op
(dropping `!capped` from `truncated`) flips `truncated` on for every ordinary
capped page, including the nav badge's wire.

**Draft 2's replacement was itself a no-op, and the author caused it.** It
prescribed "set `scanExhausted` before yielding a final page's last item" AND
"keep `consumedAll`'s `!capped` guard". Those two accepted fixes cancel: in the
exact-multiple case the page fills, so `capped` is true, so
`consumedAll = !capped && scanExhausted` is false no matter when
`scanExhausted` was set - and on the cap-break path both `truncated` and
`consumedAll` are already pinned by `capped` anyway. Both round-2 reviewers
found this independently. It is the FIFTH remedy in this cluster that would have
shipped green having changed nothing, and the only one produced by the
adjudication rather than inherited from an issue file. Two fixes can each be
correct and still cancel; that is what an adjudication has to check and this one
did not.

**The repair, which is better than either input.** `!capped` is a PROXY for "we
stopped early", and the proxy is what fails here. Set `scanExhausted` when the
last raw item of a `more === false` page is SCANNED - before the visibility test
- rather than when a visible item is yielded. Then the guard is no longer load
bearing for this case and the proxy can be dropped on a proved basis rather than
deleted on a hunch.

**Draft 3 then claimed this also closes the invisible-final-item residue. It
does not, and the claim is withdrawn.** On a cap break the generator's `return()`
means the trailing invisible item is never SCANNED, and where the consumer is
not capped the existing code already handles it - so the walk state is identical
to draft 2's in every reachable case. The repair is still right; it just buys
the exact-multiple case, not the residue. The residue stands open.

**And draft 3 forbade its own repair.** It carried a constraint saying that
dropping the `!capped` guard is "forbidden elsewhere in this section" - which
was a round-2 CRITIQUE transcribed into the document as a RULE. Dropping that
proxy IS the prescribed remedy here. That is the same two-correct-things-cancel
accident one revision later, in the opposite direction, and it is worth naming
because both instances came from folding review feedback too literally.

**The premise the repair rests on, which nobody had stated:** consumption trails
scanning by at most one item. That is what makes "the last raw item was scanned"
a safe stand-in for "supply is exhausted". 4.1.b condition 3's look-ahead buffer
is precisely the device that can break it - today it is safe only because the
bound yields at most one candidate per consumed item. So: the invariant is named
here, condition 3 cites it as its second reason, and whichever of the two slices
lands second re-proves `consumedAll` AND the cursor position, not merely
termination and budget. Draft 3's ordering note put the G-slice first, which
would otherwise prove `consumedAll` in a tree that has no look-ahead in it yet.

One real constraint remains: `scanExhausted` lives on the walk STATE and is not
exposed on `CollectResult`, so "record it" is not a one-line change.

The 100-item query-page boundary remains a narrower, genuine residue. Say it;
do not claim it closed.

Also corrected: the issue's "renders no affordance" claim went stale on
2026-08-17. The notice now renders "There are older unread threads not shown
here." on `truncated && serverRowCount > 0` - a FALSE statement to the operator,
which is worse than the silence the issue described. And the identical
empty-final-page behaviour already exists on the `all` filter, so this is
inbox-wide LEK paging, not an unread defect.

### G2 - the fill loop (`unread-fill-loop-query-amplification`)

**Not a badge fix.** See section 3.

Both filed remedies are DISPROVEN. Remedy 1 (`maxRows * k`) trades item-reads
for round trips: `maxRows` counts rows EMITTED while three paths consume without
emitting (the residue wall, the `excludeContactIds` seen-set, contactless email
threads), and DynamoDB returns a `LastEvaluatedKey` whenever `Limit` is reached
- so near page-fill it can cost up to 2000 Queries where 20 would do, which is
the exact cost driver the parent issue names. Remedy 2 (count FETCHED against
the budget) makes a page's completeness a function of its own redundancy, and
would flip the issue's own 600-item probe from a correct `consumedAll` to a
false `truncated` - the client's error state.

Remedy 3 is the only sound shape and is now IN scope (the old draft put it out):
thread ONE iterator through the loop. It needs explicit `.next()` pulls, because
`for await ... break` closes the generator by design.

**But "sound" is not "free", and the first draft asserted it without the
contract.** One iterator means one SHARED `UnreadWalkState` across what used to
be independent collects, which invalidates `remainingBudget`, `truncated`, and
the fill loop's WRITTEN termination proof - all three are currently correct
BECAUSE each collect starts fresh. The slice must re-establish the termination
proof rather than inherit it, and state the composed contract: what the budget
means across iterations, which exit sets which flag, and why the loop still
terminates. A ticker in this repo once failed to terminate five different ways
after a similar "obviously equivalent" restructure.

Routine cost today is ~3x at the dashboard's `PAGE_LIMIT` = 30; the ~90x figure
is a `limit=1` ceiling and is not the everyday shape.

### G3 - one boolean, four producers (`inbox-truncated-flag-two-meanings`)

Four producers funnel into one optional boolean. Exactly ONE consumer is
mis-served: the truncation notice depends on the "genuinely unreachable rows"
meaning but receives the union. The failure banner is meaning-agnostic and
correct, the hook is pure passthrough, and the badge's `truncated` is a SEPARATE
field that is already single-meaning and read by nobody.

Add `truncatedUnreachable`, set ONLY by the depth cap and the unresolved-drop
path, never by the budget exit. Two conditions, neither skippable:

- **OR-across-the-session semantics, WITH AN EXPLICIT RESET RULE.** The drop
  meaning is a session fact, so copying `truncated`'s replace-per-page semantics
  would clear it on the first "Load more". But an OR with no reset reproduces
  R4's defect - a notice that outlives the state it describes - on the brand-new
  flag, in the same slice that fixes R4. Reset on a filter change and on a fresh
  first page. NOTE draft 2 said "the same lifecycle event R4's gate uses", which
  is wrong twice: R4 uses a render-time STATUS GATE, not an event, and an SSE
  reconcile installs a fresh first page - so under this rule the flag is wiped
  by ordinary background traffic and "session fact" overstates what it is. Say
  what it actually is: sticky across paging, cleared on a fresh first page.
- **The wire must distinguish "this backend does not know the flag" from "this
  backend says false".** A bare `truncatedUnreachable ?? truncated` default does
  NOT achieve the split it was added for: with this file's optional-true wire
  style, a NEW backend exiting on the budget sends no flag at all, which is
  byte-identical to an OLD backend - so the false notice renders anyway and the
  whole server-side split is cancelled at the client. Send an explicit `false`
  on the new field, or carry a version marker. Keep the `??` default only for
  the genuinely-old-backend case it was meant for.

The "un-pageable page with rows" worry is closed by branch ordering - the depth
cap is tested before the budget exit, so a budget-minted cursor is always
decodable. An existing test asserting the current union behaviour is INVERTED,
not deleted.

### G4 - a truncated zero looks like "all caught up" (`unread-budget-truncation-has-no-forward-path`)

**Severity med -> low.** The `med` restoration rested on a cheapness that two
later waves removed. The exits the issue treats as distinct are mutually
exclusive by construction, and because the badge path makes a single collect
with no cursor and no seen-set, the badge's `truncated` has exactly ONE meaning
(budget expiry).

Remaining half only: surface it in the unread context and give the nav an
indeterminate marker so a truncated zero stops reading as "all caught up".

**Hard constraint the builder must honour.** The e2e nav-badge locator matches a
following sibling `span` whose `aria-label` contains "unread". A second sibling
span carrying that word makes it strict-mode-ambiguous and breaks the geometry
spec, whose stated invariant is ABSENT - never a "0". The marker's FORM (dot,
glyph, or restyled badge) is an open design question - section 8.

**No badge-side remedy depends on G3.** The old draft's "Depends on R5 for the
honest signal" is false: this acts on a separate, already-honest flag. What does
share the branch chain is G1 and G2, which land before G3.

## 6. The remaining riders

Each is its own commit so a red gate stays attributable.

**Ordering that draft 2 left unstated:** 4.1.b's read-through and G2's
single-iterator restructure touch the SAME loop. They must not be interleaved,
and whichever lands second re-proves the other's termination and budget
behaviour rather than assuming it survived. Given 4.1.a is blocked on decision
6, G2 is the one that can start.

| # | issue | sev | change |
|---|---|---|---|
| R1 | unread-deleted-contact-probed-twice-per-page | low | thread the collector's probe into hydration so the row builder reuses it. Lands with G2 - same function. TWO conditions: the carrier is keyed by `conversationId` (the collector evaluates PER THREAD, so a singular "probe result" is wrong), and it must NOT collapse "empty thread" into "read failed" - a cached absence becomes a fallback preview with no timestamp, which can never resurface, producing a drop classified as non-lagged and never retried. Corrected cost: removes ONE EXTRA read, not one of two |
| R2 | seen-set-max-equals-max-inbox-limit | low | **Filed symptom INVERTED and never reproduced** - the comparison has been a strict `>` since the first commit, and the maximum limit reaches the DEEPEST feed, not the shallowest. Real finding: `MAX_INBOX_LIMIT <= SEEN_SET_MAX` is a load-bearing invariant on its boundary with zero margin, undocumented and untested. Fix is comments at both constants plus one boundary test. Raising the cap fixes nothing and breaks an existing test; clamping makes the feed shallower. TWO review corrections: the boundary test as the issue words it CANNOT FAIL for the behaviour it names, so it must be written to fail when the invariant is violated (raise the limit past the cap in the test and watch paging die) rather than merely to pass today - a guard with no failing mode is the mission's own named anti-pattern; and `BADGE_COUNT_CAP == UNREAD_QUERY_PAGE_SIZE` is a SECOND unpinned coincidence carrying a load-bearing premise (it is why the badge cannot benefit from G2), so it rides this same remedy: comment both pairs, pin both boundaries. Draft 3 said "both constants are module-private"; it is one of each pair - `MAX_INBOX_LIMIT` and `BADGE_COUNT_CAP` are exported, `SEEN_SET_MAX` and `UNREAD_QUERY_PAGE_SIZE` are not - so the export is a smaller change than stated, but still a real one |
| R3 | inbox-parselimit-empty-one-row | low | take the FULL current `aiRuns` predicate including the `< 1` clause - the line the issue quotes has since been hardened, and copying it alone would leave `?limit=0` and `?limit=-5` behind. The floor's stated reason ("it stops `Limit: 0` reaching DynamoDB") is false for all three inbox branches. And once the `< 1` clause lands, the floor is UNREACHABLE DEAD CODE - draft 2 kept it on a corrected-but-still-wrong rationale. DELETE it with the clause, or keep it and say plainly it is defensive-only. Do not keep it with a reason. Retire the now-obsolete do-not-re-sync warning |
| R4 | inbox-group-truncation-notice-not-reset | low | gate the notice on ready status, matching the shipped precedent 85 lines below it. Reproduction is All/Groups only - the server never sets the flag under `filter=unread`. Scope limit stated in place: this does NOT close the adjacent one-commit filter-change window, which is pre-existing and orthogonal |
| R5 | inbox-filter-tabs-full-walk | **medium** | `low -> medium`. The last unbounded read on the route, re-issued on every debounced event while an operator sits on the tab. Cost model in the file was stale by ~1.5 orders of magnitude. Two parts: **(A)** give the unknown pager the budget + cursor + `truncated` contract the unread branch already has - NOTE this part is a new proposal with no approved vehicle and needs its own go; **(B)** ride 4.1's read-through. The filed remedy (sparse GSI or denormalized triage hint) is DISPROVEN - that denormalization already exists as a conversation `type` and is already divergent from the derived value at three reachable sites, so indexing it would bake the divergence in |
| R6 | inbox-imported-call-outcome-normalization | low | **Human ruling: all THREE renderers, plus group threads.** The filed remedy is unreachable for the rows it targets - the importer writes no call status and the derive path short-circuits on it before any outcome handling, so it would ship green having changed nothing. Order: make the status optional on the preview input (the body survives it - the ringing/in-progress checks are equality tests that are simply false for undefined), add a fourth derive-arm for a status-less row with a normalizable outcome gated on an empty fallback preview, THEN promote the shared helpers, and extend to the group-row builders, which read the stored preview directly and never call the derive path. **The duration-guard change from `< 0` to `<= 0` is REMOVED from this rider** - it would break a shipped pin asserting that a zero duration renders as `0s`, and a zero-second call is a real, renderable value. The defect was never the guard. **WHERE the shared helper lives is NOT assumed:** the repo states in ten to twelve places (the first draft said five) that the dashboard cannot import from `app/src`, and no app runtime module imports from `dashboard/src` today - the only proven cross-package reach is app-side TESTS importing a pure dashboard module. The builder must PROVE the chosen location under `npm run smoke`, which is the gate that catches exactly this class of resolution gap, with the established mirror-plus-drift-guard pattern as the named fallback if no single home resolves |
**R11 is CUT.** The old draft's last rider - merge the refetched inbox page onto
existing rows by `rowKey` - was re-adjudicated on 2026-08-25 and does not
survive. All three findings are independently verifiable in the tree:

- **Its justification describes today's behaviour, not a change.** The list is
  already keyed with a stable identity function and a reconcile never passes
  through the loading status, so an unchanged row already keeps its DOM node AND
  its component instance - provable by a row's local state surviving a
  reconcile. The implied re-render win is uncollectable regardless: the row has
  no memo and the row array is derived unmemoized on every render.
- **It breaks a deliberate invariant.** `serverRowCount` is a statement about
  the SERVER PAGE, judged against a server-page flag. An accumulating merge
  makes the early-end-empty condition unreachable, breaks its documented
  complement, and - the half nobody had noticed - removes any rule by which a
  row LEAVES the list, which is the Unread tab's entire job.
- **Decisively: it saves nothing.** It still requests the same page with the
  same limit and only changes how the response is installed. Zero round trips
  and zero bytes saved, on an issue titled "re-read the entire open page on
  every SSE event".

The issue's real remedy - apply the event instead of refetching - is BLOCKED on
the inbox today because the update event carries no `contactId`, which the
hook's own comment already says. That is the issue's true shape, and it is
recorded there. It is not this mission's work.

This is the fourth remedy in the cluster that would have shipped green having
changed nothing, and the second whose stated justification described the current
code rather than a defect.

## 7. Invariant surfaces

Per the planner's invariant rule, every mutation surface AND every reader of a
moved invariant is enumerated, because a plan-unlisted surface - read or write -
is where an invariant silently breaks.

**Invariant 1 - the authority for "is this thread unread" moves from a READ to a
WRITE** (4.2).

WRITERS of `unread_flag`: `incrementUnread`, `resetUnread`, the new
`resetUnreadIfUnread`, `setUnread`, the relay-close reset that clears the flag
in the same write as the status flip, the contact soft-delete fan-out, the seed
path, and the backfill.

READERS: `collectUnreadRows` / `queryUnreadPage` (the index walk),
`countUnreadRows` (the badge), the `filter=unread` branch, the per-row unread
projection on every pager row, the visibility predicate, **`today.ts` - a third
consumer of the unread iterator that the old draft did not enumerate** - and the
two fan-outs' own filters, which is what 4.2 removes.

**Invariant 2 - `contactId` on the conversation item becomes load-bearing for a
read path** (4.1). This was conditional in the old draft; it is now REQUIRED,
because the read-through is approved.

**This enumeration was WRONG in the first draft and both reviewers caught it.**
It named a contact-MERGE operation that does not exist in this repo, named
soft-delete and restore which do not touch `participants` at all, and OMITTED
the importer - the one writer that actually rewrites the field. It also asserted
`participants` is "write-once", which is false. It is rewritten below from a
code sweep rather than from recall, which is the only way this rule works.

**This list was wrong TWICE.** Draft 1 wrote it from recall. Draft 2 wrote it
from `grep -l` over identifiers, which swept COMMENTS - it listed
`services/sendMessage.ts` as an unread reader on the strength of a comment
reading "Outbound NEVER touches unread_count", and listed
`adapters/groupConversations.ts` as a participants writer when that adapter
builds a Twilio Conversations roster with a different shape entirely and never
writes this table. Draft 3 below is swept on CONTENT and each entry was opened
and read. If a fourth draft is needed, that is a signal the method is still
wrong, not the list.

WRITERS of `participants` on the conversation item:

- `conversationsRepo` - the versioned rewrite (`:1196`), the plain rewrite
  (`:1597`), the two group-membership writes (`:2550`, `:2591`), the two
  group-creation writes (`:1885`, `:2329`), and **`:1357`
  (`createOrGetByParticipantEmail`) - the writer that CREATES the email-only
  shape `{contactId, phone: ''}` that 4.1.b condition 1 exists to handle.** Both
  earlier drafts missed it, which is why condition 1 was wrong in draft 1.
- `setParticipantsIfAbsent` - the conditional claim, guarded on
  `attribute_not_exists(participants)`, so it CANNOT repair a present-but-blank
  entry.
- `contactCapture` - claims the link, best-effort, and swallows failure.
- **`import/apply.ts:1095` - an UNCONDITIONAL overwrite on the 1:1 path**, whose
  value falls back to an empty string. The group path guards the identical
  clause; the 1:1 path does not. Filed separately as
  [`import-blanks-conversation-participant-contactid`](../../issues/import-blanks-conversation-participant-contactid.md).
- `routes/public.ts:286` - the housing-fair intake claim.
- `routes/contacts.ts:1800` - the email-thread creation path.
- `routes/api.ts:2099` - `backfillGroupTextRoster`.
- The seed modules: `lib/seed/cast.ts`, `lean.ts`, `live.ts`, `matrix.ts`,
  `performance.ts`.

There are further producers of `contactId: ''` beyond the importer. **Enumerating
them is a STATIC CODE SWEEP and is NOT blocked on decision 6** - draft 3 folded
it into 4.1.a, which transitively blocked a task that needs no data at all.
It is its own item, startable now.

**There IS a backfill pattern to follow, and draft 2 said there was not.** That
claim was a wrong-directory non-fact: `app/src/scripts/` does not exist, but
`app/scripts/` does and holds `backfill-unread-flag.ts` among four backfills.
What does not exist is a backfill for THIS field. The distinction matters
because 4.2's counter-only argument leans on the unread-flag backfill having
run.

**Invariant 3 - the `byUnread` index itself.** The whole cluster reads it, so
its RANGE KEY is a mutation surface even though nothing here means to move it:
`touchLastActivity` writes `last_activity_at` on every outbound send. A change
to ordering or to the tie behaviour lands here first.

READERS of `unread_flag` / `unread_count` - **wrong a THIRD time in draft 3, by
a third method.** Draft 3 listed `webhooks/twilio.ts` and `webhooks/voice.ts` as
readers when their only content hits are `incrementUnread` CALLS - they are
WRITERS, and they are precisely the six sites 4.1.a names as the coverage
problem. The document set that test and then failed it. Corrected list:
`lib/unreadFeed.ts`, `routes/inbox.ts`, `routes/today.ts`, `routes/contacts.ts`,
**`routes/api.ts` - `GET /api/unread-counts`, which draft 1 missed and which is
exactly where 4.2's counter-only objection would surface**, `lib/markUnread.ts`,
`lib/events.ts` (the SSE frame carries `unread_count`, and the contact detail
view reads it), `repos/conversationsRepo.ts`, and the seed modules.

Also missing from the writer list and added: `groupConvert.ts`, which changes
`contactId` VALUES and is the ONLY code anywhere that heals a `contactId: ''`.
It heals group rosters only, so the 1:1 class does not shrink on its own - which
is a direct input to decision 6.

**Section 7 has now been wrong three times, by three different methods:** from
recall, from a grep that swept comments, and from classifying a file by the
attribute it mentions rather than by what it does with it. The lesson is not
"sweep harder" - it is that this enumeration wants a mechanical check in the
build, not another careful read.

Note the two mark-read fan-out filters that 4.2 removes read `unread_count`, not
`unread_flag`; draft 2 filed them under the wrong attribute. `resetUnread` has
four callers, and the one the severity downgrade leans on is `api.ts:2318` -
name it rather than counting re-drives.

WATCH ITEM: the unread backfill's `remove` arm can manufacture the exact
invariant break 4.2 is closing. It is unowned and needs a named owner before
4.2 lands.

## 8. Open decisions - these need a human ruling before build

1. **Contact-attribution staleness** (4.1 condition 5). **This is a SOFT-DELETE
   VISIBILITY rule, not a display preference** - review made that correction
   twice and draft 3 failed to apply it, so it is stated plainly here: getting
   this wrong does not mislabel a row, it decides whether a row the operator
   should not see appears at all. Weigh it accordingly. RE-FRAMED after review:
   the first draft posed this on a contact-MERGE operation that does not exist
   in this repo, and on the wrong divergence pair. The badge and the unread page
   CANNOT diverge - both go through `collectUnreadRows`. What can diverge is the
   Unread feed against the All / Unknown tabs, and the real operations are a
   number reassignment and the pointer-aware owner hop, not a merge. The stored
   `participants` value and the pointer can disagree; which one an operator
   should see is a product call.
2. **RULED 2026-08-25: fall back and keep the badge.** On a short or failed
   `getManyByIds`, resolve the affected rows through the existing per-row
   lookup. The operator sees a correct badge and correct rows; the saving
   disappears for that request only. This preserves today's behaviour exactly
   when a read degrades, which is the property worth having. The alternatives
   were a 500 with no badge (loud and wrong) and degrade-to-unknown (quiet and
   wrong) - review's framing, and a better one than draft 2's "harsh versus
   safe".
3. **The form of the indeterminate marker** (G4) - dot, glyph, or restyled
   badge - subject to the hard constraint that it must not be a second sibling
   span carrying the word "unread". Note the blast radius is larger than first
   stated: 4-5 locator sites across 3+ spec files, including the Email leaf, and
   the invariant is not pinned in the geometry test.
4. **R5 part (A)** - budget + cursor + `truncated` on the unknown pager is a new
   proposal, not an adjudicated remedy. It needs its own go or it drops to part
   (B) alone. Review also found that as specified it would light the unfiltered
   inbox failure banner on an empty All / Unknown page, so part (A) needs that
   solved before it is buildable at all.
5. **The founder's local imported dataset** (4.2). The first draft told the
   BUILDER to confirm it. That is unactionable by a builder - it is a human
   item, and it is the one remaining unverified exposure for the counter-only
   class.
6. **RULED 2026-08-25: the human runs the coverage measurement and hands back
   the number.** A builder had no legitimate dataset - the hermetic lane is
   seeded and answers with fixture coverage, dev and prod are off-limits under
   AGENTS.md, and the local imported dataset is decision 5. This keeps that
   boundary intact. The instrument is built; see 4.1.a.

   Recorded for the next reader: the third option considered was "drop the gate
   and let production tell us". Review found it had NO INSTRUMENT - the badge
   path deliberately emits no per-request line, the unread log line carries no
   resolution counts, and the one field that looks like a proxy is explicitly
   disclaimed for this use. "Unproven until observed in the wild" would have
   meant "never find out". If that option is ever revisited, it needs telemetry
   built first.

## 9. Testing

- **Every check added is mutation-probed**: the defect it claims to catch is
  reintroduced and the check must fail. Where a guard cannot be made to fail,
  that is stated in place rather than papered over.
- **Self-test any detector before trusting a clean result.** A non-ASCII check
  in this mission silently passed on everything because the regex flag it used
  is unsupported in this locale. A detector that has never been shown to fail
  has not been shown to work.
- `app/test/unreadIndexFakeMirror.integration.test.ts` runs the byUnread fake
  and the REAL repo over identical inputs. Any new index semantics go there
  rather than being trusted to the fake, which has drifted before. The fake
  THROWS on a resume inside a `last_activity_at` tie - the one input where fake
  and service diverge.
- `app/test/updateCallStatus.integration.test.ts` is the pin-the-real-repo
  pattern for DynamoDB semantics the fakes cannot carry.
- **FIVE gates bare from the worktree at handback**, not four: typecheck, test,
  smoke, e2e, and `npx eslint` on the branch's own touched files. The lint gate
  was added to AGENTS.md on 2026-08-24; the old draft predates it.

## 10. Out of scope

- ALL of `thread-hooks-refetch-whole-page-per-event`, both halves. The three
  conversation hooks were already out by the human's ruling; the inbox half is
  now out too, on evidence - see "R11 is CUT" in section 6. The issue stays open
  with its true shape recorded.
- Re-litigating the accepted trade that Retry is ineffective on a truncated
  page, or the silent undercount inside the residue wall past the probe bound.
- The `scanned` field RENAME in the unread log line - it depends on G2's budget
  accounting and naming it twice is wasted motion. The drop-reason map does NOT
  depend on G2 and is not deferred with it.
- Repo-wide lint. Gate 5 is the touched-file ratchet; `main` carries 117
  pre-existing errors and fixing unrelated ones is its own change.
- A conversation `type` versus derived-triage divergence at three sites (found
  under R5). It is a correctness bug in its own right, it is now recorded, and
  it is not this mission's to fix silently.
