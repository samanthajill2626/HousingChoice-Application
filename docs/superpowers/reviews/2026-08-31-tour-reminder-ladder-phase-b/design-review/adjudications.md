# Spec design review - round 1 adjudications

Date: 2026-08-31
Spec: `docs/superpowers/specs/2026-08-31-tour-reminder-ladder-phase-b-design.md` @`7fc744a8`
Reviewers: A (11 findings), B (16 findings), independent, both `opus`, both
blind to the brainstorm.
Reports: `spec-r1-reviewer-a.md`, `spec-r1-reviewer-b.md`

Findings are merged where the two reviewers found the same thing. Counts:
**19 merged findings - 18 ACCEPTED, 1 SPLIT (accepted in part), 0 rejected
outright.**

A round-1 with no rejections usually means a weak adjudicator. It does not here:
the spec was written fast off a settled brainstorm and was carrying two
mechanically wrong claims (M1, M2), a fabricated symbol name, and a set of
unenumerated call sites. The reviewers were right about nearly everything. Where
I disagreed it was with a proposed REMEDY, not a finding - recorded at M8.

---

## M1. ACCEPT [BLOCKING] - the names bound is specified at ONE of TWO sites
(A1, B3)

The spec cites `tourReminders.ts:1037` and names a function `sendOneReminder`
that DOES NOT EXIST - I invented it. There are two `ReminderNamesUnavailableError`
unclaimed-return sites: `:1037` (the 1:1 route) and `:1210` (the GROUP route).
Verified: `grep -rn "sendOneReminder" app/src` returns nothing, and `:1205-1216`
carries the ledger-item-7 comment verbatim.

The omitted site is the group route - which is where a landlord-led `en_route`
rung lives, and that is the ONE rung-differential names failure the spec's own
section 12 reasons about when disposing of ledger item 8. Bounding one and not
the other would have shipped exactly the hole the item exists to close.

**Spec change:** section 7.2 names BOTH sites by line, drops the invented
function name, and states that the bound is identical at both.

## M2. ACCEPT [BLOCKING] - the `en_route` exemption resurrects a `morning_of`
that supersession currently retires (B1)

Section 6.2 claimed un-clamping `en_route` only REMOVES collisions. **That is
wrong**, and I verified it numerically.

Default window 21:00-08:00, tour at 08:30 local:

| rung | raw | today (clamped) | with the exemption |
|---|---|---|---|
| `morning_of` | 04:30 | 08:00 | 08:00 |
| `en_route` | 07:30 | 08:00 | **07:30** |

Today the two clamp onto the SAME slot and `supersededBySlot`
(`app/src/jobs/tourReminders.ts:412-417`, equality on `otherDue === dueAt`)
retires `morning_of`. One text goes out. Un-clamping `en_route` separates the
slots, the equality no longer holds, and BOTH send - `en_route` at 07:30
("she is headed that way shortly") followed by `morning_of` at 08:00 ("looking
forward to having you tour at 8:30 today"). Two texts, in reverse ladder order,
for the tours the founder was told get one.

Offsets verified at `computeDueAt` (`tourReminders.ts:117-152`): `morning_of`
`-4h`, `en_route` `-1h`. Clamp target verified at
`clampOutOfQuietHours` (`app/src/lib/quietHours.ts:153-164`) - it returns
`window.end`.

**Spec change - and this is the one design decision round 1 forced.**
Generalize `supersededBySlot` from equality to `otherDue <= dueAt`: an earlier
rung is stale when a LATER rung fires at or BEFORE it. Equality was only ever a
proxy for that; clamping is what used to make the two coincide, and the
exemption is what breaks the coincidence.

Deliberately NOT a precedence reorder - Phase A spec 8.1 warns that reordering
rule evaluation reopens the vanishing-row problem, and this changes no ordering.
It widens ONE predicate, and only in cases where clamping has inverted the
ladder, which is the defect. On an unclamped ladder the rungs are strictly
increasing, so the new predicate is false for every pair and nothing changes.

`supersededInBatch` (the fire-time twin, `:889-894`) needs the same widening for
the same reason - it compares batch membership, not times, so a resurrected
`morning_of` due in the same catch-up batch as an `en_route` is already covered
there. Stated in the spec so the builder does not fix one and leave the other.

## M3. ACCEPT [BLOCKING] - the operator PREVIEW surfaces are never enumerated
(A3, B2, B5a)

`app/src/services/rosterEdits.ts` calls BOTH composers - `composeIntroBody` at
`:473` and `composeMemberAddedBody` at `:673` - and its header (`:21-22`) states
the parity contract: previews must go through the same composers the fan-out
uses. Verified.

Two consequences the spec missed:

- The intro preview would show the NAKED intro while the job sends the TOUR or
  PLACEMENT intro. That breaks section 9.5's escape hatch, which is the entire
  fallback story: "the operator sees the preview and edits it." Worse, precedence
  rule 1 pins `intro_body` from whatever the operator edited - so an operator who
  tweaks a previewed naked intro pins the WRONG variant.
- `buildAddPreview`'s docblock says it previews "the body the WHOLE group
  receives". After the split there are two bodies and the preview must choose.

**Spec change:** section 9 gains a call-site inventory - job AND preview for both
messages - and rules that the preview shows the same variant the job would send,
with `buildAddPreview` showing the GROUP body (what the operator is authoring)
while the persisted row carries the new member's, and the docblock corrected.

## M4. ACCEPT [HIGH] - section 3's ordering guarantee is not delivered by its
mechanism (A4, B9)

A tour booked between the human's sweep and the deploy runs the OLD code, arms a
`confirmation` with `dueAt = now`, and that row is past-due from birth. It fires
on the FIRST post-deploy tick, before any human re-run. "Re-running the sweep
afterwards catches it" is a race, not a fix.

**Spec change, and it is a better design than what I wrote:** do NOT empty
`MANUAL_ONLY_REMINDER_KINDS`. Empty it of the three live rungs and leave
`confirmation` in it PERMANENTLY, re-commented as a discontinued kind that never
auto-sends. Then no confirmation row fires regardless of when it was armed, the
ordering dependency disappears entirely, and the sweep becomes panel cleanup
rather than a race against a deploy. Section 5's "at that point its entry is
dead state" was the wrong instinct - the entry is the guard.

## M5. ACCEPT [HIGH] - `overdue` is specified at one view builder of several
(A5, B8)

The spec named only the GET list site (`routes/tourReminders.ts:598-609`).
Verified there are more:

- `viewOf` (`routes/tourReminders.ts:336-345`) - the PATCH state-echo projection,
  a second builder of the same `TourReminderView`;
- `routes/contactTimeline.ts` and `routes/relayGroups.ts` render the same pending
  rungs on other surfaces.

**Spec change:** section 8 enumerates every builder and renderer, sets `overdue`
in both `TourReminderView` builders, and EXPLICITLY excludes the timeline and
relay-group renderers with a reason rather than leaving them unmentioned - an
unmentioned reader is where the rule silently disagrees with itself.

## M6. ACCEPT [HIGH] - the label "safety net" in 4.3 does not work in the
direction claimed (A2, B7)

I wrote that the existing test "pins that the two maps agree, so a missing label
fails the build." `dashboard/src/api/types.test.ts:87-106` HAND-COPIES the reason
list as plain strings, and its own comment says the case I relied on "fails no
build". Verified by reading it.

Each new token touches FOUR sites: `ReminderSkipReason` (app), the dashboard
wire union, `REMINDER_SKIP_REASON_LABELS`, and `SKIP_REASONS` in the test. Three
tokens now, not two - `names_unavailable` from section 7 is the third.

**Spec change:** 4.3 states the four sites per token, names all three tokens, and
drops the false safety-net claim.

## M7. ACCEPT [HIGH] - `{role}` needs a repo read the spec's own purity rule
forbids (B5b)

Section 9.3 requires the composer to stay pure with the resolver in the job
handler; section 9.4 sources `{role}` from `UnitContact.role`. The member-added
job (`relayFanOut.ts:669-698`) reads only the conversation - no `unitsRepo`, no
owner resolution - and `buildAddPreview` would need the same new read.

**Spec change:** section 9.3 states the new dependency explicitly for both the
job and the preview, and keeps the purity rule intact by resolving above the
composer in both.

## M8. SPLIT - the new intros drop the "it's Sam" sender identity (B6)

**ACCEPT the inconsistency.** Section 9.4 argues the naked intro is right for a
new member precisely BECAUSE it carries "it's Sam" on a first-contact text with
no brand and no STOP. Sam's tour and placement intros carry no sender identity
at all, and the spec never notices that its own argument applies to them too.
That is a real internal contradiction and it is now stated in the spec.

**REJECT the implied remedy.** I will not add "it's Sam" to founder-authored
copy. Every string in this product is Sam's; inventing a sentence for her because
a reviewer noticed an asymmetry is exactly the drift the catalog's
do-not-remove-without-reading blocks exist to prevent. The A2P exposure here was
already stated to her and directed anyway (`catalog.ts:240-250`).

**Disposition:** recorded in the spec as a known, deliberate exposure, and added
to section 15 as a question for Sam. Her call, not ours, and not the builder's.

## M9. ACCEPT [HIGH] - the `confirmation` conversion inventory is incomplete
(A7, B4)

Section 10's counts came from the ledger and I did not re-derive them. The seed
files and roughly eight test/e2e files are unnamed, and A is right that some
sites are not "mechanical conversions" at all: `tour-roster.spec.ts:488-501` and
`scheduled-visibility.spec.ts:234-259` depend on `confirmation`'s ARM-TIME
semantics and its next-rung position, not on immediate send. Those are
DELETIONS or re-baselines, not conversions.

**Spec change:** section 10 requires the plan to carry a derived, enumerated
inventory split three ways - immediate-send conversions, arm-time assertions that
are deletions, and seeds - rather than a count.

## M10. ACCEPT [MEDIUM] - the e2e clock-travel conversion has a supersession
interaction (B10)

Ticking with a future `now` pulls every earlier same-tour rung into the same
`listDue` batch, where `supersededInBatch` claim-SKIPS them. So a converted
spec asserting an `en_route` arrival may find its `morning_of` retired as a side
effect - a real behaviour change in the fixtures, not a flake.

**Spec change:** section 10 states it, and section 14 requires the converted
specs to assert the retirement rather than be surprised by it. Compounds with
M2: both reviewers reached the supersession machinery from different directions,
which is a signal the widening in M2 needs its own tests.

## M11. ACCEPT [MEDIUM] - a single-pass `interpolate` can introduce a
replacement-pattern vector (B11)

The best finding of the round on pure craft. Today's `split(needle).join(value)`
is immune to `$`-patterns. A naive single-pass `String.replace(/\{(\w+)\}/g,
value)` with a STRING replacement interprets `$&`, `$1`, `$'` and `` $` `` in the
substituted value - so a contact named `$&$&$&` would expand. That would REPLACE
one injection vector with another while claiming to close it.

**Spec change:** section 11 mandates a FUNCTION replacement (`(m, token) => ...`),
which never interprets `$`-patterns, and adds a regression test with a `$&`- and
`$1`-bearing value.

## M12. ACCEPT [MEDIUM] - `{names}` has no value for the zero-others branch
(A8, B12)

`composeConnectionSentence`'s no-names path today restructures the whole
sentence, including a zero-others form. Section 9.2 dropped that form on the
grounds that "a relay group with no other members is not a group" - but the
PREVIEW builder can reach it, and a `{names}` with no value in a strict catalog
DEFAULT THROWS (`resolve.ts:36`). A crash, not a degraded sentence.

**Spec change:** `{names}` is TOTAL - it always returns a non-empty noun phrase.
`2 other people` / `1 other person` for the unnamed cases, and the degenerate
zero case returns `1 other person` rather than being unreachable-by-assumption.

## M13. ACCEPT [MEDIUM] - `persist: false` leg-only mode has no referent for
"the persisted body" (A9)

`sendRelayAnnouncement` has a legs-only mode (the dev intro replay seam) that
persists nothing. Section 9.6's rule is written as if persistence always happens.

**Spec change:** 9.6 states that in `persist: false` mode the selector still
drives per-member bodies and there is simply no row - the rule degrades rather
than being undefined.

## M14. ACCEPT [MEDIUM] - the `en_route` exemption has no floor, and that is
not stated (A6)

An exempt `en_route` for a 04:00 tour sends at 03:00. That is the founder's
decision working as directed, not a defect - but the spec presented the
exemption only through the 8am-tour case and never stated the unbounded
consequence.

**Spec change:** section 6.1 states it plainly and it joins the section 15 list
of things Sam must be told, alongside the 8am change she was already owed.

## M15. ACCEPT [LOW] - catalog metadata is unspecified for five new bodies (B14)

Ids, `class`, `channel`, `editable` and the declared `vars` are all constrained
by existing catalog invariants (`catalog.test.ts:35-41`, `:43-52`, `:62-69`),
including the no-dead-tokens rule for non-editable entries, which is what makes
the `{when}` / `{time}` split across the two tour variants necessary rather than
merely tidy.

**Spec change:** section 9 gains a metadata table.

## M16. ACCEPT [LOW] - the placement intro needs its own reversal note (B13)

`catalog.ts:250-252` records a dated removal of the housing-authority sentence.
Sam's new placement copy reinstates it in a form that arguably HONOURS the
original rationale - it attributes updates to the property contact rather than to
Sam - and the existing assertion is scoped to `relay.intro`, so nothing breaks.
But section 9.4 makes a point of recording reversals with their dates, and the
same courtesy is owed here or the next reader of that comment files it as drift.

**Spec change:** a dated note in section 9.1.

## M17. ACCEPT [LOW] - the sweep reverses a documented operator affordance (B16)

`tourRemindersRepo.ts:152-158` documents restoring a canceled rung to pending as
a deliberate "send it after all", explicitly including a past-due one. Population
A retires those with no lower bound - a tour that ended ten minutes ago
qualifies. Probably right; unacknowledged is wrong.

**Spec change:** section 4.2 acknowledges it and rules on it explicitly.

## M18. ACCEPT [LOW] - citation drift (A10, B15)

`stateOf` is at `:157` not `:143`; dashboard `TourReminderView` at `:1191` not
`:1196`; `interpolate` at `:24-45` not `:30-44`; `sendOneReminder` does not exist
(M1). A builder greps these.

**Spec change:** all citations re-derived against the worktree at `ec32170a`.

## M19. ACCEPT [LOW] - "guarded at the door" overclaims (A11)

Section 7.1 cites one create route and implies coverage of every `unitId`
writer. The claim it needs is narrower and still true: the empty-key case is not
the realistic permanent failure, a sustained table failure is.

**Spec change:** narrowed.

---

## What this round did NOT change

- Every decision in section 2 stands. No reviewer challenged one, and none of
  the accepted findings reverses one.
- Ledger item 8 stays dropped. Both reviewers reached the supersession machinery
  (M2, M10) without contesting that disposition.
- Section 13's non-goals stand; no accepted finding is additive scope.

## Round 2

Round 1 changed decisions (M2 and M4 materially), so the loop continues.
Reviewer B is continued with the re-review charge - it landed more accepted
findings including the round's only unique BLOCKING one - and is handed reviewer
A's report path.
