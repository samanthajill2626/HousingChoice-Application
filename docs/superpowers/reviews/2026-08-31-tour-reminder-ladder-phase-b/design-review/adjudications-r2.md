# Spec design review - round 2 adjudications

Continues `adjudications.md` (round 1). Reviewer B continued as the same agent
with full context, charged with the re-review brief and handed reviewer A's
report plus the round-1 adjudications.

**14 findings - 13 ACCEPTED, 1 CONCEDED BY THE REVIEWER, 0 rejected.**

Round 2 did what the charge asked. Its two BLOCKING findings are both in
mechanisms I invented DURING round-1 adjudication, which nobody had reviewed.
That is the entire argument for the round existing, and it is why "the reviewer
confirmed my fixes" would have been the wrong brief.

## R2-1. ACCEPT [BLOCKING] - the FIRE-TIME half of the `en_route` exemption is unbounded where the arm-time half is not

VERIFIED: there is no past-tour gate anywhere on the fire path. The only
`scheduledAt` comparison in the send path is `beforeStart`
(`app/src/jobs/tourReminders.ts:956`), which gates the group-open-pending branch
and nothing else. Arm time has `past_event`; fire time has no equivalent.

Today quiet hours indirectly caps the damage - an overnight backlog defers to
08:00. Exempting `en_route` at fire time removes that last brake, so a worker
returning from an outage at 03:00 texts its whole `en_route` backlog
immediately, including rungs whose tours have already happened.

**Spec change.** Add a fire-time past-tour gate: a rung whose tour has already
STARTED is claim-skipped `tour_already_passed` instead of sent. The token already
exists from section 4, which makes this cheap - and it makes the sweep what it
should have been all along: cleanup of a condition the runtime now also enforces,
rather than the only thing enforcing it.

Scoped to ALL kinds, not just `en_route`. A reminder for a tour that has already
started is useless by construction, and a gate that applies to one rung is the
kind of asymmetry the next reader deletes. Same reasoning section 7.1 uses for
the names bound: the branch that turns sending on must not also be the branch
that lets a recovered backlog fire stale.

## R2-2. ACCEPT [BLOCKING] - section 3.1's guarantee is false on the human path

VERIFIED: `manualOnlyKinds` is read at exactly ONE place -
`app/src/jobs/tourReminders.ts:602-603`, the poll's due-row filter.
`forceSendReminder` (`:1364`) never consults it. So keeping `confirmation` in
`MANUAL_ONLY_REMINDER_KINDS` stops the POLL and not Send now.

Worse, and this is the half that makes it BLOCKING rather than merely
incomplete: the panel derives its chip from the same set
(`routes/tourReminders.ts:589-597`), so a discontinued `confirmation` chips
**"Paused"** with a working Send now button beside it - actively inviting an
operator to send a message we have decided never to send. My round-1 fix reused
a mechanism whose meaning is "a human decides when this goes out" for a kind
whose meaning is "this never goes out".

**Spec change.** Introduce `DISCONTINUED_REMINDER_KINDS`, a separate permanent
set holding `confirmation`, consulted by THREE surfaces:

- the poll's due-row filter, alongside the manual-only filter;
- `forceSendReminder`, which REFUSES with a `kind_retired` reason - reusing the
  skip token's name across both unions the way `roster_unavailable` and
  `names_unavailable` already do;
- the panel's chip derivation, which must read "no longer sent", never "Paused".

`MANUAL_ONLY_REMINDER_KINDS` is then genuinely emptied, its docblock's "TO
RESTORE: empty this set. Nothing else has to change" stays TRUE, and the two
concepts stop being conflated. This is a better answer than round 1's and it is
what I should have written then.

## R2-3. ACCEPT [HIGH] - section 10's dev-tick instruction rested on a deleted premise

Section 10 still said to delete the dev tick's `manualOnlyKinds: new Set()`
override "with `MANUAL_ONLY_REMINDER_KINDS` empty". Under R2-2 the set IS empty,
so the override is genuinely removable - but the dev tick must NOT bypass
`DISCONTINUED_REMINDER_KINDS`, or e2e keeps a send path production does not
have, which is exactly the dev/prod fork that comment forbids.

## R2-4. ACCEPT [HIGH] - the relay half has no inventory, and four existing assertions are tripwires written for this edit

The most concrete finding of the round. M9's "a count is not an inventory" was
scoped to `confirmation` only; the relay half changes a declared token, two
composed outputs and one whole message, and section 14 treated the suites as
passive coverage. They are not:

- `app/test/messages/catalog.test.ts:66-69` THROWS after the `{members}` rename -
  it builds its expectation with `.replace('{members}', 'M.')` and the entry is
  strict and non-editable, so a declared-but-unvalued token raises rather than
  degrades;
- `e2e/tests/tour-roster.spec.ts:252-269` splits the default on the LITERAL
  `'{members}'` and its own failure message names this exact failure - and it
  asserts against a TOUR preview, so 9.0's routing breaks it a second,
  independent time;
- `e2e/scenarios/steps.ts:1887` and `:1930-1949` assert
  `/You're now connected with/` in the dashboard thread and in EVERY member's
  fake thread - shared steps, so every tour and placement relay spec that calls
  them breaks;
- parity pins at `app/test/toursApi.test.ts:3989-3998` and `:4096`,
  `placementsApi.test.ts:989` / `:1007`, `relayGroupPreview.test.ts:151` /
  `:208`, `relayFanOut.test.ts:703-716`.

**Spec change.** The inventory requirement is lifted out of section 10 into its
own section covering BOTH halves of the mission, with these sites named as the
known floor rather than as the complete list.

## R2-5. ACCEPT [HIGH] - the shared resolver cannot take a conversation

VERIFIED: `buildOpenPreview` (`services/rosterEdits.ts:508`) takes a
`RosterOwner`, not a conversation, and preview-open is PRE-provisioning -
`e2e/tests/tour-roster.spec.ts:247` records that it 409s
`relay_already_provisioned` once a thread exists. So `getOwner(conv)` is
uncallable there, and that is the MAIN authoring path for precedence rule 1,
since the edited `intro_body` is stored on the same call
(`repos/conversationsRepo.ts:1902`).

**Spec change.** The resolver takes the OWNER (`{type, id}`), not the
conversation. The job does `getOwner(conv)` above it; the preview passes its
`RosterOwner` straight through. One line, and it is the difference between
"cannot drift by construction" and a shared function half its callers cannot
call.

## R2-6. ACCEPT [HIGH] - `{name}` has the same totality hole `{names}` just had

VERIFIED: `ANONYMOUS_JOINED_LABEL` (`jobs/relayFanOut.ts:224`) exists precisely
because a relay member can be a bare phone with no contact row, and the nameless
case is reachable from both callers - the job passes `added?.name` from a roster
participant, and `buildAddPreview` passes an optional `candidate.name`.

Under 9.4's rewrite `{name}` with no value in a strict non-editable default
THROWS. That kills the job handler AFTER its `putJobExecutionMarker` claim, so
the announcement is LOST rather than retried, and it 500s the add-preview route.

I fixed exactly this for `{names}` in round 1 and failed to generalize it one
entry over.

**Spec change.** `{name}` is TOTAL, with its own table row. The neutral value is
`a new member` - LOWER-CASED from the existing constant so it reads correctly
mid-sentence in Sam's wording ("Hey, adding a new member to the group."). A copy
decision, made here rather than left to the builder.

## R2-7 to R2-13. ACCEPTED - precision

- **R2-7** the `nowIso` note in 8.2 is wrong on every path it covers
  (block-scoped in one, absent in the others). Rewritten: each builder computes
  its own.
- **R2-8** section 4.2's population-B rationale still argued those rows "fire on
  the first tick after unpause", which R2-2's guard now prevents. Re-argued: the
  sweep is panel hygiene; the guard is what stops the sending.
- **R2-9** `otherDue <= dueAt` does not typecheck against `Map.get`'s
  `string | undefined` - the current `===` narrows, `<=` does not. Explicit
  `otherDue !== undefined` guard, with its polarity stated: a rung with no
  computed dueAt never supersedes.
- **R2-10** the widening falsifies the `LADDER_ORDER` docblock
  (`jobs/tourReminders.ts:158-164`), which is the exact text a future reader
  would use to "fix" the predicate back. It joins the rewrite list.
- **R2-11** section 10 appended M9's and M10's remedies without deleting the
  sentences they supersede ("convert mechanically", "roughly 40 sites", the old
  residual-risk claim). Deleted.
- **R2-12** M18 was not actually executed - four citations still wrong, three of
  them named in round 1. Re-derived by grep this time, not from memory.
- **R2-13** 9.2a omits the `MessageId` union edit while presenting itself as
  complete. Added.

## R2-14. CONCEDED BY THE REVIEWER - M8

B accepts the remedy rejection and confirms its actual ask - record the
inconsistency, route the decision to the founder - was met. Its sequencing note
is adopted: because the deploy is a separate human step, Sam can be asked BEFORE
the first tour or placement intro ever sends, not after. Moved into section 15
as a sequencing line.

## Round 3

Round 2 changed decisions (R2-1, R2-2, R2-5, R2-6), so the loop continues.
Reviewer B is continued again. If round 3 still changes decisions the hard cap
(4) is close, and the design goes to the human as a decision with the open
findings rather than quietly continuing.
