# Adversarial spec review, round 4 - reviewer B (delta only)

Spec v4: `docs/superpowers/specs/2026-08-31-participant-snapshot-refresh-design.md` @a53bd66f
Delta reviewed: `a5b95d7b..a53bd66f -- docs/superpowers/specs/`
Adjudications: `design-review/adjudications-round3.md`
Trees read: `W:\tmp\participant-snapshot-refresh`, `W:\tmp\tour-reminder-ladder-phase-b`,
both read-only.

Scoped to the delta as charged. Two OUT-OF-DELTA items are flagged as such at
the end.

Two of this round's findings correct MY OWN round-3 work, which the planner
accepted and built on. Those are marked CONCESSION and are the first things to
read.

---

## U1. HIGH (CONCESSION) - 3.1's population 1 describes a mechanism I could not find in the code, and round-3 T1 is where the error entered

3.1: "Detection mints a REAL contact row for an unseen member
(`services/groupMembers.ts:105-119`); when staff later triage that stub into a
real contact, the roster keeps pointing at the stub. Rung 1 then resolves to a
NAMELESS contact and falls to rung 2."

For rung 1 to resolve to a NAMELESS contact, the stub must STAY nameless while
the person's identity lands somewhere else. I looked for the path that does
that and did not find one:

- Triage is an in-place PATCH on the stub's own id:
  `app/src/routes/contacts.ts:1391` `router.patch('/:contactId', ...)`. It
  updates THAT row, so triaging a detection stub gives that contact a name -
  and the roster's `contactId` still points at it, now named. Rung 1 resolves.
- There is no merge/absorb/dedupe route in `app/src/routes/contacts.ts` or
  `app/src/repos/contactsRepo.ts` (grep for merge/absorb/dedupe returns only
  `mergeContext`, SET-merge update semantics, and media-gallery merging).
- The route comment the population was derived from,
  `app/src/routes/api.ts:2029-2041`, says "the moment staff triage that stub
  into a real contact **the snapshot goes stale**" - the SNAPSHOT, i.e.
  `participants[].name`. Rung 1 fixes exactly that. It does not say the
  `contactId` goes dead or nameless.

The genuinely dead-id population is the OTHER one, and it is already covered:
`app/src/services/groupConvert.ts:254-259` documents a derived
`contactIdForPhone(phone)` "that has NO ROW BEHIND IT ... nothing re-resolves
an existing thread's roster, so it never self-heals". That is metric 5.

A shape that WOULD produce metric 6's signature is reachable - a nameless
auto-captured contact duplicating a named contact on the same number, which
`app/src/repos/contactsRepo.ts:1012-1016` names ("pre-existing duplicates (e.g.
imports)"). But that is DUPLICATION, whose owner is the M1.6 import dedupe, not
`participants[].contactId` ownership. 3.1 assigns the owner as M8.

I cannot prove no such path exists anywhere; I can say I looked in the three
places one would live and found none, and that the citation offered does not
support the claim. **This is my error from round 3 T1, accepted and built on.**
It now carries a gap statement, a risk-table row, an issue-disposition clause
and a new audit metric. Either the mechanism gets a file:line, or 3.1's
population 1 collapses into metric 5's population and metric 6 goes with it.

## U2. HIGH - S5's metric 6 has no discriminating power, in both directions

The planner's own question, and the answer is no.

Metric 6: "members whose `contactId` resolves to a NAMELESS contact while a
contact matching that member's PHONE has a name."

**False positives on a modeled product state.** Two people on one handset is not
an edge case here - it is designed for and tested:
`app/src/lib/rosterResolution.ts:502-503` tracks "First member seen on each
number - the one a later duplicate 'shares with'", `:546-554` computes
`sharesPhoneWithName`, and `app/test/relayGroupPreview.test.ts:186-208`
("collapses members sharing a phone to ONE recipient, first wins") pins two
NAMED contacts on one number. Make one of them a nameless auto-captured contact
and metric 6 fires with no stub-merge anywhere. The phone-pointer hop makes it
systematic: `app/src/repos/contactsRepo.ts:1031-1035` resolves a `phone_ref` to
its OWNER, so any roster member on a number attached as somebody's secondary
line produces the signature.

**False negatives in the population it targets.** The stub row itself carries
the phone (`app/src/services/groupMembers.ts:112`), so in the merged case the
byPhone GSI holds at least two items for that number, and
`app/src/repos/contactsRepo.ts:1011-1016` returns "the FIRST item the GSI yields
(arbitrary order)". If it yields the stub, metric 6 is silent. **Its answer is
arbitrary precisely where it is load-bearing** - which is the same
arbitrary-tiebreak property that killed v2's runtime phone rung (round 2, R9).
The spec justifies metric 6 by noting the lookup is offline and bounded; that
answers the COST objection and not the CORRECTNESS one.

This matters more than a normal metric flaw because metric 6 is the whole
remedy for round 3's only BLOCKING finding. A number that cannot separate a
shared handset from a merged stub will be reported and believed - the exact
failure T1 was raised to prevent.

## U3. HIGH - S4's no-rung-2 rule REGRESSES the voice label for 3.1's own population 2, and 3.1 says nothing regresses

Answering the planner's second question directly: **no, it does not leave an
empty label** - `app/src/routes/webhooks/voice.ts:120` terminates at
`'the other party'`, and the multi-callee form at `:985` renders
`"the other party +2"`. There is no blank.

The defect is silent degradation, and it lands on the population 3.1 has just
finished promising is untouched.

`app/src/routes/webhooks/voice.ts:980-982` passes `undefined` as the contact
whenever `firstCallee.contactId` is falsy - which is exactly a BARE-PHONE relay
member, 3.1's population 2 (`contactId: ''`, written at
`app/src/services/rosterProvision.ts:116` and
`app/src/services/relayMembers.ts:73-80`). Today `maskedPartyLabel:117` returns
that member's stored roster name. With rung 2 dropped, `contactShortName(undefined)`
is undefined and the chain falls to `:118-120`: a ROLE word, else
`'the other party'`.

That value is PERSISTED as `call_party_label`
(`app/src/routes/webhooks/voice.ts:993-1002`) and is the label the callee's
whisper announces. So a relay call that today says "Tina Tenant" will say
"Tenant" or "the other party", permanently, for every bare-phone member.

3.1's closing line - "Both keep today's behavior exactly - nothing regresses" -
is false as of this same commit. The privacy argument for dropping rung 2 is
sound (a posture contingent on a read is not a posture); the cost is real,
unstated, and contradicts a sentence 200 lines up. Either state it, or mask
rung 2 (`firstNameOnly` / initial) instead of deleting it.

## U4. HIGH (CONCESSION) - 2.4's collision is a no-op at every pin it names, and round-3 T5's second half is where that error entered

I found the data-flow reach in round 3 (S3 -> `describeRoster` -> the preview's
recipient list) and never checked whether the flip is OBSERVABLE at the pins.
It is not.

`describeRoster`'s flip at `app/src/lib/rosterResolution.ts:544-545` compares
`nonEmpty(member.name)` against `displayName(contact)`. When `resolveRoster`'s
source is `plan` or `default`, `member.name` is ALREADY `displayName(contact)` -
`memberFromContact` sets it from the contact at
`app/src/lib/rosterResolution.ts:175-179`, and both the plan branch (`:236-251`)
and the default branch (`:253-283`) build every member through it. **The flip is
a strict no-op unless the source is `participants` (`:219-228`).**

Now the pins 2.4 names:

- `app/test/relayGroupPreview.test.ts:151, 208` - the helper at `:99-104` posts
  to `POST /api/relay-groups/preview`, the STANDALONE preview (file header
  `:1`). No owner, no thread pointer. Source can never be `participants`.
  **No-op.**
- `app/test/toursApi.test.ts:3989-3998, 4096` - `preview-open`, which 409s
  `relay_already_provisioned` the moment a thread exists (the sibling test at
  `:3975-3987` pins exactly that). So preview-open runs only with no thread.
  **No-op.**
- `app/test/placementsApi.test.ts:989` - the same `preview-open`, with its own
  409 pin at `:998-1001`. **No-op.**
- `app/test/placementsApi.test.ts:1002-1010` - `preview-add`, run AFTER
  `seedThread`, so source IS `participants` and the flip is reachable. But the
  seeded roster names ('Tasha Tenant', 'Pat Manager') equal the contacts', so
  even here no value moves.

So "Both branches move the same expectations from different directions" is false
at all four locations. 2.4 step 3 ("re-baseline only the RECIPIENT-NAME half")
has nothing to re-baseline, and **step 5 is a HANDBACK BLOCK** ("If phase-b has
NOT merged at handback time, STOP and report a sequencing block") armed against
a hazard that is at most cosmetic and, on current fixtures, absent.

Merge-ordering behind phase-b may still be right for other reasons - it edits
`relayGroups.ts` (U-concession below) and rewrites the composers. But the stated
JUSTIFICATION for the ruling does not hold, and a hard stop-and-report should
not rest on it.

## U5. HIGH - 2.4's trap warning is misdirected, and its cited evidence supports neither half

"**THE TRAP: do not revert phase-b's body expectations while doing it.** Body
and recipient list are separate fields of the same fixture
(`rosterEdits.ts:425-441`), so a whole-fixture rewrite silently undoes another
branch's landed work WITH ALL TESTS GREEN."

Three problems, and the planner asked whether the claim is true. It is not.

1. **There is no whole fixture.** Every pin is separate `expect` statements on
   separate response fields, not one object comparison:
   `app/test/relayGroupPreview.test.ts:144-148` (`recipients`) and `:151`
   (`body`); `app/test/toursApi.test.ts:3998` and `:3999-4001`;
   `app/test/placementsApi.test.ts:989` and `:990`. A builder editing the
   recipient expectation physically cannot touch the body expectation in the
   same edit. The shape the trap warns about does not exist here.
2. **The citation is wrong.** `app/src/services/rosterEdits.ts:425-441` is
   `PreviewRecipientRow` and `OpenPreviewParts` - the INPUT interfaces the
   builders consume. It is not a response object and not a test fixture, so it
   evidences neither "same fixture" nor "separate fields" of the asserted thing.
3. **The body expectations are not literals.** Every one is the composer CALLED
   AT ASSERT TIME: `composeIntroBody([...])` at
   `app/test/relayGroupPreview.test.ts:151`, `app/test/toursApi.test.ts:3998`
   and `:4096`, `app/test/placementsApi.test.ts:989`; `composeMemberAddedBody(...)`
   at `:1007-1009`. So step 4's remedy - "diff against phase-b's merge commit to
   prove the body strings are byte-identical" - is aimed at strings that are not
   in these files.

There IS a real property of these pins worth warning about, and it is close to
the opposite: they re-derive the expected body FROM THE FUNCTION UNDER TEST, so
they cannot detect a change in body copy at all - what they actually pin is the
NAME LIST passed in. That is the thing a name-precedence branch could move
invisibly, and 2.4 does not mention it.

## U6. HIGH - the reworded disposition overreaches for the third consecutive round

The delta rewords the top table to "CLOSED for the operator-facing surfaces
(titles, chips, cards, panels)" and names four exclusions.

5.5 (unchanged, and correct on its own terms) leaves
`routes/api.ts:1993-2002` unhydrated. Its redundancy table at `:400-405` covers
`ConversationDetail.tsx`, `PlacementConversation.tsx`, `TourConversation.tsx`
and `GroupTextView.tsx` - the thread VIEWS, each of which also fetches a
resolved roster route. It does not cover two readers that 4.2's own CLIENT list
names and that call `getConversation` directly with no sibling roster fetch:

- `dashboard/src/routes/placements/PlacementDetail.tsx:370-375` - `getConversation(groupId)`
  then `conv.participants[].name` joined into the close-group prompt's
  `memberSummary`.
- `dashboard/src/routes/tours/TourDetail.tsx:453-455` - the same shape.

Those are CARDS/PROMPTS showing member names, and they stay stale. The
disposition's own word list includes "cards".

Separately, 4.2's CLIENT-list sentence still reads "all fixed by hydrating the
passthroughs above with NO client edit" while the passthrough feeding most of
that list is now marked NOT HYDRATED at `:273`. The sentence was not touched by
this delta but the disposition that depends on it was.

## U7. MEDIUM - every `relayGroups.ts` line number in v4 is guaranteed stale at build time, by 2.4's own ruling

phase-b's `6328970e` adds 13 lines above the members route in that file - an
import hunk (`@@ -70,7 +70,10 @@`) and the scheduled-view block
(`@@ -330,6 +333,16 @@`). In this worktree the route is
`app/src/routes/relayGroups.ts:456`; in phase-b's tree it is `:469`.

2.4 orders phase-b to merge FIRST. So at the moment the builder opens the file,
every citation v4 makes about that route - `:456-492` (2.2, 4.2, S2), `:470`
(3.1 population 2), `:471-474` and `:482-489` (3, S2) - is off by 13. This spec
has twice made line-number accuracy a matter of its own authority (round 1 A16,
round 3). Cite the route by name alongside the numbers, or re-derive them after
the sync.

## U8. MEDIUM - the new risk table keeps the superseded gap row alongside its replacement

The delta adds "The documented gap RECURS per rename rather than healing |
stated (3.1); owner is M8; S5 metrics 6-7 size it before and after".

It leaves in place the v3 row it supersedes: "A `group_text` roster whose panel
is never opened stays stale | stated gap (3); S5 sizes it". That is the exact
formulation 3.1 was rewritten to replace, still pointing at a section 3 that no
longer says it. Two rows now describe the same thing, one of them the version
round 3 falsified.

The unchanged "Merge conflict in `routes/relayGroups.ts` | ... sequence at merge
time" row is likewise superseded by 2.4's hard merge ORDER and should point at
it.

## U9. MEDIUM - T13's amendment landed as an instruction with no reachable execution state

S3's new block says `services/rosterEdits.ts:425-426` and `:437-441` "must say
so. See 2.4 - these are phase-b's file, so the amendment lands after its merge,
alongside the pin re-baseline."

2.2 says, in bold and without qualification: "**Do not touch those three
files**", `services/rosterEdits.ts` among them. And 2.4 step 5 says that if
phase-b has not merged, the builder STOPS.

So the amendment 5.4's standing requirement mandates is forbidden by 2.2,
conditioned on 2.4, and blocked by step 5 in the other branch of that condition.
There is no state in which a builder can execute it. Given U4 (the flip does not
move the recipient names at the named pins) the honest resolution may be that
the comments are not made stale in any observable way and no amendment is owed -
but that has to be decided, not left as an unexecutable instruction inside the
rule that exists to stop exactly this.

## U10. LOW - the accepted T2 limitation got no risk row, unlike every other stated limitation

5.3 now states that rung 2 may serve a soft-deleted contact's name, seeded by
`routes/api.ts:2086` + `:2099-2114`. Section 11 gained four rows in this delta
and has rows for the cleared-name limitation, the recurring gap, the padded
name, and the push disagreement - but none for this one, and section 10's test
list still pins only the rung-1 half ("SOFT-DELETED contact supplies no name"),
which will pass while the limitation ships. One row and one sentence in the
Resolution stamp.

---

## OUT-OF-DELTA

**OD1 (MEDIUM).** S2 still carries a v3 COST NOTE at the spec's `:487-490`
ending "Hydration there is one batch over ONE roster", describing hydration of
`api.ts:1993-2002` - which 5.5 (`:389-407`) forbids and 4.2 (`:273`) marks NOT
HYDRATED. A leftover that contradicts a ruling three sections away, inside the
slice that would perform it.

**OD2 (LOW).** phase-b's `6328970e` also touches `app/test/relayApi.test.ts`
(`@@ -1505,6 +1505,41 @@`), which is where this branch's new members-route
tests (section 10) would land. Same one-time textual merge class as the source
file; 2.2 mentions only the source file.

---

## Contesting the adjudications

**T5 half one - CONCEDED, fully.** `6328970e` does edit
`app/src/routes/relayGroups.ts`; I verified the commit, its stat, and its hunk
headers. I checked phase-b's plan and spec and not its commits. v4's reworded
framing - one landed edit exceeding that branch's own stated exclusion, at
`:333`, in a different function from `:456-492`, no further planned work - is
accurate on every element.

**T5 half two - I go further than the adjudication and withdraw it.** See U4.
The reach is real; the collision is not, because I never checked
`resolveRoster`'s source at those pins. The planner accepted my finding and
built a merge-order ruling with a handback block on it. That is the more
expensive half of the error and it is mine.

**T4's implied remedy rejection - CONCEDED.** A fresh sender name beside a stale
title is better than two stale ones, and dropping S4's free flip to buy
consistency would keep a known-wrong name. The restored risk row states the
trade accurately. Nothing to add.

---

## Verified in the delta, no finding

- 2.2's rewritten CO-EDIT paragraph: every claim checked and correct (plan has
  zero `relayGroups.ts` entries; spec `:653` excludes it; `6328970e` edits it at
  `:333`).
- 2.4's pin list matches phase-b's plan Task 14 **Step 6** exactly (its plan
  line 837 names `toursApi.test.ts:3989-3998,4096`,
  `placementsApi.test.ts:989,1007`, `relayGroupPreview.test.ts:151,208`,
  `relayFanOut.test.ts`). The Step number and the locations are right; only the
  claimed interaction with S3 is not (U4).
- 3.1's population 2 (bare-phone relay members) is real and correctly cited:
  `routes/relayGroups.ts:470`, with no phone resolver and no writer - and U3 is
  a consequence of it, not a contradiction of it.
- T6's correction is accurate: `routes/api.ts:2101-2105` writes `{ ...p, name }`
  and never `contactId`.
- 5.3's narrowing, 3's rung-3 exceptions (T10), 2.3's `relayGroupDuplicates`
  re-disposition to a filed issue (T12), 5.4's fourth-instance admission, S5's
  run-it-twice (T14), and the restored push-disagreement risk row (T4) all
  landed as adjudicated.
- S4's terminal fallback: `webhooks/voice.ts:120` returns `'the other party'`,
  so no caller is ever handed an empty label.
