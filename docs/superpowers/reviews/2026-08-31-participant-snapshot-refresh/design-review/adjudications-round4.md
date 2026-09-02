# Spec design review - round 4 adjudications (TERMINAL)

Spec v4 @a53bd66f, delta-only review of v3..v4. Reviewer: B continued (fourth
pass). Findings at `../spec-review-round4-findings.md`. 12 findings, 0 BLOCKING,
2 flagged OUT-OF-DELTA.

**12 ACCEPT, 0 REJECT, 0 DEFER.**

## The result that matters: two findings I accepted in earlier rounds were false

Round 4's two most important items are the reviewer WITHDRAWING its own prior
work - findings I accepted, built on, and reported to Cameron as fact. Both
withdrawals were verified by the planner before acceptance.

### ACCEPT - U1. The "merged stub" population does not exist.

Round 1 (A1) and round 3 (T6) both asserted that a roster `contactId` can point
at a stub that staff later merged away, stranding rung 1 permanently. I
accepted it twice, built section 3.1 around it, added S5's metric 6 to size it,
and told Cameron the gap "recurs on every rename".

Planner verification:

- **There is no contact merge mechanism anywhere in the tree** - no merge route,
  service, or repo method.
- Triage is an IN-PLACE `PATCH /api/contacts/:contactId`
  (`routes/contacts.ts:1391`); the stub keeps its id and GAINS a name.
- `routes/api.ts:2029-2041` says the SNAPSHOT goes stale, never the id.

So rung 1 resolves that member correctly and **the gap does not exist**. The
branch is more complete than v3 and v4 claimed.

This is the most instructive failure of the whole design review. The phantom
survived two adversarial rounds and one planner acceptance because every pass
argued about the CONSEQUENCES of the mechanism and nobody asked whether the
mechanism was in the code. The spec now records it at length so it is not
re-derived a third time.

### ACCEPT - U4/U5. The preview-pin collision does not exist either.

Round 3 (T5, second half) claimed S3's `describeRoster` flip would fight
phase-b's Task 14 pin re-baseline. I accepted it, wrote section 2.4's
field-by-field ritual and a handback stop-block around it, and reported it to
Cameron as the mission's one real coordination hazard.

Planner verification, and it is enforced by the TYPE:
`services/rosterEdits.ts:138` types the preview-open owner as
`Omit<RosterOwner, 'roster' | 'groupThreadId'>`. With no `groupThreadId`,
`resolveRoster` can never take its `participants` branch there; it always takes
plan/default, where `memberFromContact` (`lib/rosterResolution.ts:172-180`)
already derives the name from the contact. S3 reorders stored-vs-contact
precedence, so on a path whose names are already contact-derived it is a
structural no-op.

U5 additionally shows v4's trap warning was wrong on its own terms: the pins
are separate `expect` statements whose expected values are composer CALLS at
assert time, not literals in a shared fixture, and `rosterEdits.ts:425-441` is
an interface declaration. There was no green-but-wrong rewrite to guard against.

**Cameron's merge-order ruling stands on its own** and is kept. Only its
justification and its ritual were wrong. Section 2.4 is rewritten around what
re-baselining actually involves: line numbers shifting ~13 in
`routes/relayGroups.ts`, and a real textual co-edit in
`app/test/relayApi.test.ts` around `:1505` (U12).

## Accepted - a regression v4 introduced

### ACCEPT - U3. v4's "no rung 2" for `maskedPartyLabel` was a regression.

Round 3's T9 was right that a privacy posture cannot depend on a read
succeeding, and I honoured it the crude way - by deleting the fallback.
`maskedPartyLabel` (`webhooks/voice.ts:116-121`) is total: `member.name` ->
role -> `'the other party'`. Deleting rung 2 sends a bare-phone member - who
has no contact and therefore no role, and who is 3.1's ONE real uncovered
population - from their stored name straight to "the other party", in a
PERSISTED `call_party_label`.

Fixed properly: rung 2 is MASKED, not dropped. The stored "First Last" is put
through the same short-name transform `contactShortName` applies to a contact,
yielding "First L.". Masked either way, and nobody loses a label they have
today.

## Accepted - the rest

| # | finding | disposition |
|---|---|---|
| U2 (HIGH) | S5's metric 6 had no discriminating power even for its imagined target: false-positive on the modeled shared-handset/phone-pointer state, false-negative arbitrarily via `contactsRepo.ts:1011-1016`'s arbitrary duplicate-phone order. | ACCEPT. Moot under U1, but accepted on its own merits - I invented a metric in round 3 without checking it could separate its target from a state the system explicitly models. Deleting it removes the LAST `findByPhone` anywhere in the spec: this branch now has no phone-keyed name resolution at all, in request paths or offline scripts. |
| U6 (HIGH) | The reworded disposition overreaches a THIRD time: 5.5 leaves `PlacementDetail.tsx:370-375` and `TourDetail.tsx:453-455` unhydrated with no sibling roster fetch. | ACCEPT. Named in the disposition row itself. Three consecutive rounds have caught this same table overclaiming; it now enumerates every exclusion inline rather than pointing elsewhere. |
| U7 (MEDIUM) | Every `routes/relayGroups.ts` line number in v4 is stale at build time, BECAUSE 2.4 orders the branch that shifts them to merge first. | ACCEPT, and it is a neat self-inflicted one: the merge-order ruling invalidates the spec's own citations. 2.4 now instructs re-derivation by SYMBOL after the sync. |
| U8 (MEDIUM) | The risk table kept the superseded "panel is never opened" row beside its 3.1 replacement, and the merge row still said "sequence at merge time" after 2.4 fixed the order. | ACCEPT. Both corrected. |
| U9 (MEDIUM) | T13's comment amendment landed with no reachable execution state: 2.2 forbids touching `rosterEdits.ts`, 2.4 deferred it to a merge, and the stop-block halted the branch in the other case. | ACCEPT. Doubly moot under U4 - S3 is a no-op on those paths, so the comments stay true. S3 now states "no stale comments" explicitly, per 5.4's own rule. |
| U10 (LOW) | The accepted T2 soft-delete limitation got no risk row and no test, unlike every other stated limitation in the delta. | ACCEPT. Risk row plus a test that PINS current behavior, so a future change to that write-back is a visible diff rather than a surprise. |
| U11 (MEDIUM, OUT-OF-DELTA) | S2 still carried v3's COST NOTE describing hydration of `api.ts:1993-2002`, which 5.5 forbids and 4.2 marks NOT HYDRATED. | ACCEPT. Deleted. A stale paragraph directly contradicting two other sections. |
| U12 (LOW, OUT-OF-DELTA) | `6328970e` also touches `app/test/relayApi.test.ts:1505`, where this branch's members-route tests land; 2.2 named only the source file. | ACCEPT. Added to 2.4 as the real test co-edit. |

## Contested items, resolved

The reviewer CONCEDED round 3's T5 half one fully (it checked phase-b's plan
and not its commits - the mirror of the planner's own earlier error), and went
past conceding on T5 half two to WITHDRAW it. Both were correctly split.

Round 3's T4 rejection (dropping S4 to remove the push's internal
disagreement) was not contested and stands.

## STOP - this is the terminal round

The skill's stop rule is "no accepted finding altered what gets built, added or
removed a surface, or moved an invariant". Round 4 does not meet it literally -
U3 changed a rung and U1/U4 removed claims - but it meets what the rule is for,
in the opposite direction from a normal terminal round: **every decision this
round changed was a RETRACTION of something earlier rounds added.** Nothing new
was designed. The spec is now strictly smaller and strictly truer than v4, and
the build it describes is unchanged from v3 except for one masking fix.

Round 4 also hit the skill's HARD CAP of four rounds. Both readings agree:
stop. To the human's spec gate.
