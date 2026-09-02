# Plan-blind adversarial review - feat/tour-reminder-supersession

- Reviewer: plan-blind adversarial (no spec, no plan, no prior review reports read)
- Diff reviewed: `git diff main...HEAD -- . ':!docs'` at HEAD 01924bc9 (fresh sync with main)
- Method: read the full diff, then swept every consumer/mutator of the touched state
  across app, dashboard, seeds, scripts and e2e. No test suites run (gates running
  concurrently per charter). Every file:line below was read directly.

## INCIDENT NOTE (not a code finding)

Partway through this review (approx. 22:29 local), the worktree's `app/` directory
(and at least part of `dashboard/`) was DELETED ON DISK while HEAD stayed at
01924bc9 - `git status` shows the whole `app/` tree as unstaged ` D` deletions.
This reviewer was read-only throughout and did not cause it; every citation below
was read from the intact tree before the deletion. Whatever concurrent process did
this (a gate run, another agent, a filesystem fault on W:) needs investigating
before anything else runs in this worktree; a `git checkout -- .` type restore is
outside this reviewer's charter.

## What was verified clean (the consumer sweep)

- No stale caller of the removed `cancelForTour` / `cancelTourReminders` anywhere
  in app, dashboard, scripts or e2e (grep; only a comment in
  app/test/tourReminders.test.ts:2032 references the old name historically).
- All three `armTourReminders` call sites consume the new `{ ladderId, rows }`
  shape: app/src/routes/tours.ts:347 and :1270, app/src/lib/seed/live.ts:535/550/561.
- The PATCH body allowlist (app/src/routes/tours.ts:145 `PATCH_ALLOWED`) does NOT
  include `currentLadderId` or `conversionClaimedAt`, so a client cannot write the
  pointer or the claim stamp through the API; both are handler-internal.
- The pointer comparison is genuinely single-sourced: app/src/lib/ladderPointer.ts
  `isSupersededRung` is the only compare, called by the poll
  (jobs/tourReminders.ts:1198), Send now (:1830), the panel GET
  (routes/tourReminders.ts partition), the contact timeline
  (routes/contactTimeline.ts:1051) and the relay-group bucket
  (routes/relayGroups.ts:372). No surface re-derives it.
- `uncancel` (tourRemindersRepo.ts:473) already requires
  `attribute_exists(#canceledAt)`, so a Restore against a swept (deleted) row loses
  cleanly - the resurrection guard the diff added to claimSend/claimSkip/cancel was
  not needed there, and is correctly present on the other three writers.
- The one-time retire script's write (app/scripts/retire-paused-tour-reminders.ts:217)
  really does carry `attribute_exists(reminderId)` - the RUNBOOK claim that a
  deleted row is counted, not resurrected, is true.
- The poll's ordering (past-tour gate -> conversion-claim defer/expire -> pointer
  refusal -> batch supersession -> quiet backstop, jobs/tourReminders.ts:1123-1268)
  matches its own position-is-behaviour comments; I could not construct an
  interleaving where a CURRENT-generation rung is claim-skipped `superseded`:
  freshly armed rows always have dueAt in the future, so listDue cannot serve one
  inside the eventual-consistency window of its own arm's pointer write.
- The transactional sweep (tourRemindersRepo.ts:502-575) is sound against the
  races I tried: the ConditionCheck on the tours row is transactionally
  serialized (not an EC read), item-0/item-1 positional decode of
  CancellationReasons is correct, a sentAt row survives via the per-delete
  condition (checked against the TABLE, immune to byTour GSI staleness), and the
  caller's own generation is excluded by the candidate filter.
- Reschedule/convert/terminal interleavings all converge: the loser's rows end
  unpointed and refused (named residue), never sent. The finalize's blind
  pointer write (placements.ts:771) cannot cause a stray send in any ordering I
  found - the CAS in tours.ts:1300 loses against it and the convert sweep or the
  refusal rules cover the leftovers.
- The fake world mirrors the new repo surface faithfully
  (app/test/helpers/twilioWebhookHarness.ts: setLadderIdIf with real compare
  semantics, deleteSupersededForTour with the per-row pointer re-check,
  conversionClaimedAt on claim/release).
- Seeds: matrix and cast stamp deterministic ladder ids (no byte churn); the
  live world re-Puts the tour with the pointer after each arm, and no seeded
  pending row is due at seed time, so the arm->pointer gap cannot strand a row.
- e2e: steps.ts's new `currentLadderList()` scoping means Reminders-panel
  assertions cannot silently widen into the Earlier disclosure; the reschedule
  spec's assertion moved from "canceled chip" to state-qualified absence, which
  is the honest post-sweep claim.
- streamAnchor geometry checked against the real CSS (.stream padding var(--sp-3),
  flex column, overflow-anchor none): the three bands are reachable exactly as
  documented, jsdom/ResizeObserver hazards are guarded
  (Timeline.tsx `typeof ResizeObserver === 'undefined'`), scrollIntoView is
  avoided, and the rect-delta pin cannot inherit the Load-older row's height.
  GroupTextView's `upcoming={[]}` fresh-literal hazard is correctly dodged by
  keying everything on the boolean.

## Findings

### 1. MEDIUM - A crashed conversion claim is a dead end the new copy now actively lies about

A conversion that dies between `claimConversion` and the finalize leaves the
`pending:` sentinel on the tour forever: no TTL, no admin route, and the retry
path is self-blocking - POST /api/placements/from-tour's fast-path 409 fires on
`typeof tour.convertedPlacementId === 'string'`, which the sentinel satisfies
(app/src/routes/placements.ts:665-671), so `releaseConversionClaim` is
unreachable from the product. That dead end is pre-existing. What this branch
adds on top of it:

- The poll now defers every rung for CONVERSION_CLAIM_GRACE_MS and then retires
  the whole ladder `conversion_stalled` - terminally, skippedAt cannot be undone
  (jobs/tourReminders.ts:1143-1176).
- Send now answers 409 `conversion_in_progress` whose operator copy is "try
  again once that finishes" (dashboard/src/api/types.ts SEND_NOW_ERROR_COPY) -
  a promise nothing in the product can keep.
- Three surfaces chip "On hold - the tour is becoming a placement" indefinitely.

The repo comment (tourRemindersRepo.ts `conversion_stalled` docblock) says "the
operator's remedy is to finish or clear the conversion" - neither action exists.
Consequence if merged unfixed: after any crashed conversion, the tour is
permanently unconvertible AND its reminders are permanently retired, with UI copy
pointing staff at a remedy that requires a manual DynamoDB edit. Wants either an
unclaim path (even ops-only) or copy that says to escalate, plus a RUNBOOK line.

### 2. MEDIUM - Block-vanish re-derivation reads post-append geometry: the feature's commonest event can flip an at-bottom operator to a pill

Timeline.tsx layout effect: when `hasUpcomingBlock` flips true->false the anchor
is re-derived from the committed DOM (the m2 fix). But the commit that empties
the Upcoming bucket is very often the SAME commit that appends the corresponding
sent message (the hub conversation hooks deliver items and upcoming in one
setState - the diff's own comment relies on that fact for the mount direction).
In that commit the appended bubble has already pushed the sentinel down before
`currentAnchor(el)` runs, so an operator who was pinned at the newest message
re-derives as `null` whenever the new bubble is taller than
STREAM_ANCHOR_SLACK_PX (48px - a routine two-line bubble), and the same pass
takes the `grew` branch: pill instead of follow, exactly at the moment the last
rung fires while they watch. The one-direction guard fixed the mount case; the
unmount case re-derives against geometry that includes the append it is about
to adjudicate. Consequence: intermittent loss of stick-to-bottom on the
reminder-fires moment, self-healing via the pill click. Fix shape: re-derive
before counting the growth against it (e.g. subtract the growth, or only
re-derive when the count did not also grow in the same pass).

### 3. LOW - A reschedule racing a completed conversion can arm a live, pointed ladder on a closed/converted tour (pre-existing TOCTOU, untouched by a branch that rebuilt this exact branch)

PATCH /tours/:id reads `current` once (tours.ts:1063, eventually consistent) and
its patch write carries no status condition. If a from-tour conversion runs to
completion between that read and the write, the PATCH re-arm branch arms a fresh
ladder and its CAS wins (the PATCH's own blind `currentLadderId: rotation`
clobbered the finalize's pointer), leaving a closed, converted tour with a live
pointed ladder. The poll has NO tour-status gate (processReminderRow checks
scheduledAt and the claim sentinel only, and the sentinel is now a real
placementId), so those reminders send. Pre-existing shape and a very narrow
window - but this branch added CAS machinery that closes every sibling race
while leaving this one, and the conversion's generation-scoped sweep can no
longer clean it up (its ConditionCheck fails once the pointer moved). A status
guard on the patch write, or a status check in the poll, would close it.

### 4. LOW - Send now judges supersession from an eventually consistent tour read

forceSendReminder reads the tour with the default EC get
(jobs/tourReminders.ts:1801) - the same read shape review round NEW-1 documented
as serving stale rows "with no concurrency at all". A sweep-missed rung plus a
stale pre-rotation pointer lets a human send fire from a dead generation in the
seconds after a reschedule. Defense in depth mostly covers it (the sweep usually
deletes the row first, and claimSend's attribute_exists blocks a deleted one),
so this is the residual sliver - but the branch demonstrably knows the remedy
(`{ consistentRead: true }` exists and is used one file over, tours.ts:1310).

### 5. LOW - The superseded single-row echo reuses `''`, the byte the same type defines as "compose failed"

routes/tourReminders.ts:446 and :540: a superseded rung with no sentBody echoes
`body: ''` through `viewOf` as a full TourReminderView - the projection whose
docblock (and the dashboard's) says empty string means "we could not compose it
right now", rendered as "Preview unavailable". The earlier-view machinery exists
precisely to distinguish absence from `''`, and these two echoes bypass it. No
consumer renders the echo today (the panel refetches and ignores it), so this is
latent - but the first consumer that does render it will show an outage message
for a rung that has no honest body, the exact confusion T7.7 documents.

### 6. LOW - TransactionConflict is not among the sweep's recognized cancellation outcomes

tourRemindersRepo.ts:544-566 decodes only ConditionalCheckFailed at positions 0
and 1. A concurrent plain write on the TOUR item (any operator PATCH - each
reschedule updates it) colliding with one of the sweep's per-row transactions
surfaces as TransactionCanceledException with a TransactionConflict reason, which
falls to the log.error("unexpected error on row") branch and continues; the
racing UpdateItem side can likewise throw TransactionConflictException into
handlers that only catch ConditionalCheckFailedException. UNVERIFIED whether the
v3 SDK's standard retry mode absorbs TransactionConflict before either surface
sees it; if it does not, a routine collision produces error-level noise and a
possible 500 on the operator write. Worth one measured look, not a redesign.

### 7. LOW - "Next" can decorate a rung chipped "Converting"

The server's `next` exclusion (routes/tourReminders.ts:900-905) filters
`discontinued` and `superseded` but not `conversion_in_progress`, so a
mid-conversion tour tags aria-current="step" and "Next" on a rung whose Send now
is 409 and whose poll tick is deferring it. Defensible (the state resolves, and
the chip is shown beside it), but the exclusion comment's own rule - "a rung can
only lose next for a reason the same response shows" - would equally justify
excluding this one, and nothing records the choice.

### 8. LOW - Cosmetic residue of the block's move into the scroller

Timeline.module.css: the zero-height sentinel is a flex item, so the column's
`gap: var(--sp-2)` applies twice between the newest cluster and the block
(~an extra 8px), and at full scroll the block's dashed top rule now floats above
`.stream`'s bottom padding instead of meeting the pane edge the way the old
pinned section met the composer. Neither breaks the 360px e2e assertions; both
will read as "why is there a gap here" in a future CSS pass. UNVERIFIED
pixel-exact (no browser run in this review).

## Not findings (checked and accepted as designed)

- Hard-deleting canceled/skipped rows of a superseded generation erases operator
  cancel decisions from history - deliberate, argued in the repo docblock and
  named in the RUNBOOK entry as "the change, not a bug".
- The CAS-loser residue (freshly armed rows left unpointed and visible as
  Replaced until the next sweep) - named in three places, converges.
- `earlier[]` unbounded and unpaginated - inherits listByTour's documented 1MB
  non-goal.
- The unreachable `superseded` arm in the current-rows projection - two lines,
  argued as belt-and-braces against the partition moving; fine.
- `names_unavailable` reused for a tours-table read failure in forceSendReminder
  - cause-agnostic copy is documented as intentional containment.
- seed cast/matrix terminal tours pointing at rotated generations (whole ladder
  reads as Earlier, bodyless) - stated as the accepted post-feature shape.
- The pre-migration exemption cell (absent pointer + absent ladderId) and the
  interruption cell (absent pointer + stamped row -> refuse) - the four-cell
  table in ladderPointer.ts is internally consistent and every caller inherits it.

## Verdict

No blocking or high finding. The two mediums are an operational dead-end made
louder (1) and a one-commit UX wrinkle on the new scroll anchor (2); both are
fixable post-merge without schema or contract movement. The worktree deletion
incident is orthogonal to the diff's quality but must be resolved before gates
are trusted.

VERDICT: mergeable - both MEDIUMs are contained (an ops-path copy/recovery gap
and a same-commit pill-vs-follow wrinkle), with no data-loss or wrong-send path
found.
