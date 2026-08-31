# C1 spec - design review round 1, adjudications

Reviewers A and B, dispatched in parallel on 2026-08-25 against
`docs/superpowers/specs/2026-08-24-inbox-unread-read-path-design.md` sections
3-10, each blind to the other and to the author's reasoning.

Reports:
`W:\tmp\handbacks\c1-specreview-r1-2026-08-25\reviewer-A.md`, `reviewer-B.md`.

**Both verdicts: request changes.** Combined 2 blocking, 9 high, ~16 medium,
11 low. NINE findings were reached independently by both reviewers, including
both blockers - that convergence is the strongest evidence in the set.

**The shape of the failure, in reviewer B's words:** the rewrite's DISPROOFS are
all correct - both reviewers independently re-derived G1's no-op argument, G2's
two disproven remedies, R6's unreachable remedy and the R11 cut, and neither
could break any of them - but its REMEDIES "assert rather than verify, the same
failure mode it was written to purge". The demolition held; the construction did
not. That is the author's error, not an inherited one.

## Blocking

**B-1 / A-F1 (both reviewers, independently) - ACCEPTED.**
`contactId: ''` is a live steady-state class, and the importer overwrites
`participants` unconditionally on the 1:1 path. VERIFIED in code by the author:
`import/apply.ts:1095` assigns `participants = :participants` while every
neighbouring field uses `if_not_exists`; the value at `:389-392` falls back to
`''`; the group path guards the identical clause at `:1140-1142` with the reason
written in place ("imported entries carry `contactId: ''`"), and that guard sits
in the CCF recovery arm at `:1188-1200`, which an imported `unknown_1to1` row
never reaches. `contactCapture` cannot heal it: its claim is conditioned on
`attribute_not_exists(participants)`.
ACTIONS: filed as
[`import-blanks-conversation-participant-contactid`](../../docs/issues/import-blanks-conversation-participant-contactid.md);
4.1 condition 2 widened from "no contactId" to "no USABLE contactId, empty
string included"; section 7 rewritten.

**B-2 / A-F2 - ACCEPTED.** The condition
`attribute_exists(conversationId) AND attribute_exists(unread_flag)` does not
separate "row missing" from "already read": DynamoDB returns one
`ConditionalCheckFailedException` and does not name the failing conjunct. The
spec kept the clause the issue prescribed and dropped the mechanism that makes
it legible.
ACTION: 4.2 now requires `ReturnValuesOnConditionCheckFailure` and says what
each outcome means. The two-conjunct form stays - it is still correct as a
GUARD; it was only ever wrong as a DIAGNOSTIC.

## High

**A-F3 - ACCEPTED, and it is the most consequential finding in the round.**
The anchor can ship green having saved nothing. VERIFIED by the author: there
are SIX `incrementUnread` call sites (`twilio.ts:709`, `:1018`, `:1787`,
`:2258`, `voice.ts:400`, `inboundEmail.ts:749`) and TWO `captureContact` call
sites (`twilio.ts:2187`, `voice.ts:606`). The spec's premise - "captureContact
claims the link BEFORE incrementUnread indexes the row" - is demonstrable for
ONE path of six. There is no `app/src/scripts/` directory, so there is no
backfill. And the stated acceptance (call counts in author-controlled fixtures)
cannot detect low coverage, because the fixtures supply the `contactId` the
production rows may lack.
ACTION: a MEASUREMENT slice is added ahead of the build, approved by the human
on 2026-08-25. Coverage of a usable `contactId` across the real `byUnread` walk
is measured first, with a decision rule stated in advance. This restores the
gate the human dropped - for a reason nobody had at the time the ruling was
given, which is why the ruling was not wrong when it was made.

**A-F4 / B-B2 - ACCEPTED IN FULL.** Section 7's invariant-2 enumeration named
a contact-merge operation that DOES NOT EXIST in this repo, named soft-delete
and restore which do not touch `participants`, and omitted the importer and
`routes/public.ts` - the writers that actually rewrite the field. "Write-once"
is false. This is precisely the failure the planner's invariant rule exists to
prevent, committed by the person applying the rule.
ACTION: section 7 rewritten from a code sweep rather than from recall.

**A-F10 / B-H3 - ACCEPTED, BUT NOT IN THE FORM PROPOSED.** Both reviewers are
right that condition 1 ("match by PHONE, not `participants[0]`") breaks the
email-only class, whose participant entry is `{contactId, phone: ''}`
(`conversationsRepo.ts:1357`). Both propose reverting to `[0]`, citing
`today.ts:1086`. That half is REJECTED on evidence: `contactCapture.ts:164`
states the opposite rule in the imperative - "never `participants[0]`: an entry
for another phone is..." - and `conversationsRepo.ts:1354-1356` records the
convention as "readers key on contactId FIRST". A positional rule is what the
capture path was explicitly written to avoid.
ACTION: condition 1 is replaced by neither rule. Resolve the entry that
corresponds to the ROW'S OWN participant key - phone for phone threads, the
single entry for email threads - and treat `[0]` as a consequence of a 1:1
thread having one entry, never as the selector. If `today.ts:1086` relies on
`[0]` as a rule it is the outlier and is noted for its own look.

**B-H1 - ACCEPTED.** G3's client rule `truncatedUnreachable ?? truncated`
cancels G3's own server split under this file's optional-true wire style: a new
backend on the budget exit sends no flag at all, which is byte-identical to an
old backend, so the false notice still renders.
ACTION: the wire must distinguish "this backend does not know the flag" from
"this backend says false". Explicit `false` on the new field, or a version
marker. The `??` default is kept only for the genuinely-old-backend case.

**A-F6 / B-H2 - ACCEPTED.** G1's hook cannot fire when the final page's last
raw item is INVISIBLE, which is the routine shape on this lagging index. The
residue paragraph names the wrong residue and claims a completeness it does not
have.
ACTION: the residue is restated correctly, and G1's acceptance is narrowed to
what it actually closes.

**A-F8 - ACCEPTED.** G2 remedy 3 threads one iterator through the loop, which
shares `UnreadWalkState` across collects and thereby invalidates
`remainingBudget`, `truncated`, and the fill loop's written termination proof.
The spec called it "the only sound shape" without giving the composed contract
that makes it sound.
ACTION: G2 now states the shared-state consequences explicitly and requires the
termination proof to be re-established, not inherited.

**A-F16 - ACCEPTED, and it is pointed.** G3's OR-across-the-session flag has no
reset rule, which reproduces R4's defect - a notice that outlives the state it
describes - on the brand-new flag, in the same slice that fixes R4.
ACTION: G3 gains an explicit reset rule tied to the same lifecycle R4's gate
uses.

**A-F11 - ACCEPTED.** Condition 4 (failed-batch semantics) is an
operator-visible product choice - a 500 with no badge, versus rows silently
mis-attributed - and the spec left it to the builder while declaring the section
"five conditions, none optional".
ACTION: promoted into section 8 as a human decision.

**A-F12 / B-H6 - ACCEPTED.** Section 8's decision 1 was framed on the
non-existent merge operation and on the wrong divergence pair. Badge and unread
page cannot diverge - both go through `collectUnreadRows`. Unread versus
All/Unknown can.
ACTION: decision 1 re-framed on the real pair and the real operations.

## Medium - accepted

- **A-F5** `consumedAll` ALREADY EXISTS (`unreadFeed.ts:430`, `:695`) and
  `scanExhausted` lives on `UnreadWalkState` (`:270`), not on `CollectResult`.
  The spec called `consumedAll` "new" and mis-stated which object carries the
  contract. VERIFIED by the author.
- **A-F7** Deriving `consumedAll` from `scanExhausted` alone deletes the
  `!capped` guard that `consumedAll: !capped && state.scanExhausted` carries
  today, whose reason is written at `unreadFeed.ts:425-429`. VERIFIED. The
  obvious later refactor turns that into ROW LOSS.
- **A-F14 / B-med** The reader enumeration misses `GET /api/unread-counts`
  (`api.ts:1880`), the SSE frame, and `ContactDetail.tsx`. VERIFIED that the
  route exists. This is exactly where the counter-only objection in 4.2 would
  surface.
- **B-med** R6's duration-guard change from `< 0` to `<= 0` breaks a SHIPPED
  pin: `callPreview.test.ts:7` asserts `formatCallDuration(0)` is `'0s'`.
  VERIFIED by reading the test.
  ACTION: the guard change is REMOVED from R6. A zero duration is a real,
  renderable value; the defect was never the guard.
- **A-F13 / B-med** The prescribed 4.2 regression seam cannot stage the defect
  (wrong describe, phone-only, one staled call). ACTION: the issue's better
  precedent is restored instead of repointing this one.
- **A-F17** R5(A) would light the unfiltered inbox failure banner on empty
  All/Unknown pages. ACTION: recorded against R5(A), which is already gated on
  its own human go.
- **B-med** section 7 omits `touchLastActivity`, which writes the `byUnread`
  RANGE KEY on every outbound send. ACCEPTED - a range-key writer is a mutation
  surface of the index the whole cluster reads.
- **B-med** R3's "stops `Limit: 0` reaching DynamoDB" is false for all three
  inbox branches. ACCEPTED; the sentence is corrected rather than deleted, since
  keeping the floor as a fallback is still right for a different reason.
- **B-med** "five later events" is four retries of the same defective route.
  ACCEPTED - this weakens the high->med severity argument but does not reverse
  it, since the row stays visible in the Unread tab throughout.
- **A-F9** condition 3's bound is right for an unstated reason (it preserves the
  cursor-minting position). ACCEPTED - the reason is now stated, because a fixed
  batch size would keep the letter and lose rows.
- **A-F15** "the builder must confirm" the founder's local dataset is
  unactionable by a builder. ACCEPTED - moved to a human item.
- **B-med** the backfill's `remove` arm can manufacture the invariant break and
  is unowned. ACCEPTED as a watch item.

## Rejected

- **The `[0]` half of A-F10 / B-H3** - see above. Rejected on
  `contactCapture.ts:164` and `conversationsRepo.ts:1354-1356`, which state the
  opposite convention in the repo's own words. Accepting it would have
  reintroduced the positional bug the capture path was written to avoid. This is
  the round's clearest case of a correctly-briefed reviewer being wrong, and of
  why load-bearing claims get checked rather than deferred to.

## Deferred to the issue registry

- **B-low** the mirror-plus-drift-guard "pattern" is one instance, and the
  module cited as import-free is not. Recorded against R6 rather than resolved
  here; R6 already requires the location to be PROVEN under `npm run smoke`.
- **A-F18** `BADGE_COUNT_CAP == UNREAD_QUERY_PAGE_SIZE` is an unpinned
  coincidence carrying a load-bearing premise. This is the same shape as R2's
  finding about `MAX_INBOX_LIMIT <= SEEN_SET_MAX`, and it rides R2's remedy:
  comment both, pin one boundary test.
- **A-F19 / B-low** G4's e2e blast radius is 4-5 sites across 3+ spec files and
  the invariant is not in the geometry test. Recorded against G4.

## Corrections to counts the reviewers made about the document

- "five places" (dashboard cannot import from `app/src`) is 10-12, not 5.
  ACCEPTED, corrected.
- A-F21: the header still named the merged branch and base commit. ACCEPTED,
  already corrected before the reports landed.

## Decision changes this round produced

Round 1 changed decisions - it is NOT terminal. Specifically: a measurement
slice was added ahead of the build; R6 lost its duration-guard change; condition
1 was replaced with a third rule that neither reviewer proposed; section 7 was
rewritten from a sweep; and one product decision moved from the builder to the
human. Round 2 is required.
