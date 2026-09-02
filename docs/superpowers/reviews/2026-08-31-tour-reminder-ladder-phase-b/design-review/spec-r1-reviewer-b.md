# Spec R1 - adversarial design review (reviewer B)

Spec under review:
`docs/superpowers/specs/2026-08-31-tour-reminder-ladder-phase-b-design.md`
Repo state: `feat/tour-reminder-ladder-phase-b` @ `7fc744a8` (base `ec32170a`).

Every claim about current behaviour below cites a file:line I read in this
worktree. Anything I could not confirm is marked UNVERIFIED.

Section 2 decisions are taken as settled. Where a finding touches one, it
challenges the MECHANISM the spec proposes, not the choice.

---

## 1. [BLOCKING] The `en_route` quiet-hours exemption resurrects a rung that supersession currently retires, producing TWO reminders in reverse ladder order

**Spec:** section 6.2 - "Un-clamping `en_route` REMOVES collisions rather than
creating them ... No precedence change."

**What is wrong.** Removing the collision is exactly what causes the harm. The
arm-time supersession predicate retires an EARLIER rung only when a LATER rung's
clamped dueAt is EXACTLY EQUAL to it:

`app/src/jobs/tourReminders.ts:411-417`

```
const supersededBySlot = REMINDER_KINDS.some((other) => {
  if (LADDER_ORDER.indexOf(other) <= myOrder) return false;
  const otherDue = dues.get(other);
  return otherDue === dueAt && otherDue < scheduledIso;
});
```

Today, both `morning_of` and `en_route` clamp onto the same quiet-window END, so
they collide and `morning_of` is retired. Un-clamp `en_route` alone and the
equality disappears - so `morning_of` now ARMS and fires, and it fires AFTER
`en_route`.

**Worked case, defaults only.** `DEFAULT_ORG_SETTINGS` is
`quietHoursEnabled: true, quietHoursStart '21:00', quietHoursEnd '08:00'`
(`app/src/repos/settingsRepo.ts:173-176`); `isQuietTime` treats the end bound as
NOT quiet (`app/src/lib/quietHours.ts:143-145`), and `clampOutOfQuietHours`
returns the window end (`:153-163`). Tour at 08:30 org-local, armed the day
before:

| rung | raw | clamped TODAY | clamped AFTER the exemption |
|---|---|---|---|
| `morning_of` (sched - 4h) | 04:30 | 08:00 | 08:00 (unchanged) |
| `en_route` (sched - 1h) | 07:30 | 08:00 | **07:30** |

- Today: equal dueAts -> `morning_of` is born skipped `quiet_hours_superseded`
  (`:418-434`); ONE text goes out at 08:00.
- After the exemption: no equality, neither is retired. `en_route` sends at
  07:30 and `morning_of` sends at 08:00. TWO texts, and the "4 hours before"
  copy lands THIRTY MINUTES AFTER "she is headed over".

The fire-time backstop does not save this: `supersededInBatch`
(`:888-902`) only fires when both rungs are in ONE `listDue` snapshot, and these
are 30 minutes apart on a 60s poll.

The band is narrow but it is precisely the band section 6.1 exists to serve:
tours strictly between the quiet-window end and one hour after it (08:00-09:00
on the defaults; wider on any org that ends quiet hours later).

**Second-order breakage.** The exemption also falsifies the invariant
`LADDER_ORDER`'s own docblock is built on:

`app/src/jobs/tourReminders.ts:158-164` - "clamping can only push an EARLIER
rung forward onto a later one's slot, and when it does, the earlier rung's copy
is the stale one."

With `en_route` exempt, a rung LATER in `LADDER_ORDER` can now be EARLIER in
TIME than an earlier one. Both supersession sites index by `LADDER_ORDER`, not
by dueAt, so on a catch-up tick `supersededInBatch` will retire `morning_of`
because `en_route` is "later" in the ladder even though `en_route` was due
first. That may be the outcome you want, but nothing in the spec says the
invariant is being broken, and the two sites now disagree about what "later"
means.

**Implies.** Section 6 needs a rule for the collision it dissolves - either
un-clamp `en_route` and re-derive supersession on TIME rather than slot
EQUALITY, or keep the exemption and explicitly retire `morning_of` when
`en_route`'s unclamped dueAt precedes it. As written, the build ships a
double-text regression on early-morning tours and section 6.2's "No precedence
change" is the reason nobody will look for it.

---

## 2. [BLOCKING] The operator's intro PREVIEW is never enumerated, so the three-variant routing makes the preview lie - and precedence rule 1 is defined on a body the operator edited from the WRONG text

**Spec:** section 9.1 - routing on `getOwner(conv)` inside the intro JOB, with
"An operator-edited `intro_body` - sends verbatim, exactly as today" as the
highest precedence.

**What is wrong.** The operator does not author `intro_body` from nothing. They
are shown a composed preview and edit THAT. The preview is composed by a
different function, which the spec never names, and which has no owner routing
at all:

`app/src/services/rosterEdits.ts:450-478`

```
/**
 * THE ONE implementation of "what an open sends". The tour, placement, and
 * standalone preview routes all funnel through here so the body composition,
 * the recipient shape, the count rule, and the quiet-hours math cannot drift.
 */
export function buildOpenPreviewFromParts(...) {
  ...
  const preview = withQuietHours(
    composeIntroBody(parts.bodyMembers.map((m) => m.name)),
```

`composeIntroBody` is the NAKED intro and nothing else
(`app/src/jobs/relayFanOut.ts:217-221`). The edited text is then stored as
`intro_body` (`app/src/repos/conversationsRepo.ts:1902`) and preferred by the
job (`app/src/jobs/relayFanOut.ts:633-634`).

So after this change, for every tour- or placement-owned group:

- operator opens the preview -> sees the NAKED intro;
- operator accepts it unedited -> the TOUR intro is what actually sends;
- operator touches one character -> the NAKED intro is pinned and the tour
  intro never sends at all.

Either way the preview is a lie, and it is a lie about a first-contact SMS the
operator is being asked to approve. The file's own docblock calls itself "THE
ONE implementation of what an open sends" - which the spec silently makes false.

**Implies.** Section 9.1 must either route `buildOpenPreviewFromParts` on the
same owner (which means the resolver of 9.3 has to run on the preview path too,
under the preview routes' deps) or state that the preview intentionally shows
different copy than the send - which nobody should agree to. This is not an
implementation detail: it decides whether the feature is buildable from the spec
as written. It is also pinned by tests that will go red without a decision:
`app/test/relayGroupPreview.test.ts:151,208`, `app/test/toursApi.test.ts:3998,4096`,
`app/test/placementsApi.test.ts:989`.

---

## 3. [BLOCKING] The one-hour names bound is specified at ONE of the TWO `ReminderNamesUnavailableError` sites - and the one it omits is the one the ledger's own code comment points at

**Spec:** section 7 - "`composeBodyForRow` raises `ReminderNamesUnavailableError`
and `sendOneReminder` (`app/src/jobs/tourReminders.ts:1037-1043`) logs and
returns WITHOUT claiming."

**What is wrong.** There are TWO catch sites, not one. Section 6 goes out of its
way to say the quiet-hours exemption "must be built at BOTH sites"; section 7
names only one, and it is not the one the codebase flags.

1. The 1:1 path, `processReminderRow` - `app/src/jobs/tourReminders.ts:1037-1043`
   (the line range the spec cites).
2. The GROUP path, `sendGroupReminder` - `app/src/jobs/tourReminders.ts:1204-1216`,
   which carries the comment that IS ledger item 7:

```
// THE QUIET BACKSTOP, deliberately: no claim, no skip stamp. A PERMANENTLY
// failing read therefore re-lists every tick with NO self-clearing bound -
// accepted for Phase A because the production poll sits behind the
// manual-only filter ... That acceptance EXPIRES with the pause; it is item (7)
// of the Phase B ledger issue, which is what gets read at unpause.
```

A builder who implements the bound at `:1037` alone leaves the group route -
landlord_led and pm_team tours, the route that carries the `en_route` landlord
copy that is the ONLY rung-differential names failure the spec itself identifies
in section 12 item 8 - re-listing forever. The defect ledger item 7 exists to
close would ship unclosed on exactly the tours it matters for.

**Also unverified in the spec's own citation:** there is no function named
`sendOneReminder` anywhere in the repo. The quiet-hours fire-time backstop the
spec attributes to it (section 6, item 2) is at
`app/src/jobs/tourReminders.ts:910-916`, inside `processReminderRow`.

**Implies.** Section 7 must name both sites the way section 6 does, and must say
which one owns the claim-skip (both call `claimSkipRow`, so both can).

---

## 4. [HIGH] Section 10's conversion inventory is materially incomplete - the SEEDS and at least eight test files that ride `confirmation` are never named

**Spec:** section 10 - "roughly 40 sites in `app/test/tourReminders.test.ts` and
roughly 14 across `e2e/tests/scenarios/scheduled-visibility.spec.ts`,
`e2e/tests/tour-roster.spec.ts` and `e2e/tests/scenarios/tours.spec.ts`".

**What is wrong.** That is the inventory the ledger already had. The spec
re-states it without re-deriving it, and the real surface is much larger.
Reference counts for the string `confirmation` (some hits in each file are
unrelated to reminders; every file below has reminder-relevant ones):

| surface | file | note |
|---|---|---|
| SEED (prod-shaped) | `app/src/lib/seed/live.ts:9-12,506,523` | docblock declares "The four auto-armed rungs (confirmation, ...)"; arms via the real `armTourReminders` at `:514,:528,:538`. After section 5 it arms THREE. Docblocks become false. |
| SEED | `app/src/lib/seed/cast.ts:769-790` | writes an explicit `kind: 'confirmation'` reminder row |
| SEED | `app/src/lib/seed/matrix.ts:880,987` | same |
| SEED | `app/src/lib/seed/lean.ts:423` | comment reasons about the confirmation rung clamping |
| test | `app/test/seedLive.test.ts:87-91` | keeps its OWN duplicated `REMINDER_KINDS` list "to mirror the canonical REMINDER_KINDS in jobs/tourReminders.ts", plus `:186,:217-218,:242,:254,:279` assertions on the confirmation row and its `skipReason` |
| test | `app/test/contactTimeline.test.ts` (17 refs) | not named |
| test | `app/test/tourRemindersApi.test.ts` (15 refs) | not named |
| test | `app/test/toursApi.test.ts` (10 refs) | not named |
| test | `dashboard/src/routes/tours/RemindersPanel.test.tsx` (8 refs) | not named |
| e2e helper | `e2e/scenarios/steps.ts` (7 refs) | the vehicle itself |
| e2e | `e2e/tests/scenarios/quiet-hours.spec.ts:96-112` | holds `QUIET_NOTE` and `PAUSED_NOTE` with an explicit note that the specs "return to [QUIET_NOTE] the moment `MANUAL_ONLY_REMINDER_KINDS` is emptied". This file MUST flip and is not in the spec's e2e list. |
| e2e | `e2e/tests/tour-roster.spec.ts`, `e2e/tests/scenarios/post-tour-application.spec.ts` (5 each) | not named |

**Implies.** The "no new dev seam needed" conclusion (D3) may still be right -
`tourRemindersRepo.create` really does write a past-due row with no drop
(`app/src/repos/tourRemindersRepo.ts:174-197`; only `armTourReminders:390-393`
drops one) - but the BUDGET behind it is wrong by a factor of roughly two, and
the seed surfaces are not test sites at all: they are product code whose
docblocks and emitted worlds change. A plan built on section 10's numbers will
under-scope the task and discover the seeds late.

---

## 5. [HIGH] The `member_added` per-recipient split never enumerates its PREVIEW, and `{role}` cannot be resolved by the pure composer the spec keeps

**Spec:** sections 9.4 and 9.6.

**What is wrong.** Two surfaces are missing.

**(a) The add PREVIEW.** `app/src/services/rosterEdits.ts:648-673`:

```
/**
 * Preview ADDING a member to a live group: the relay.member_added body the
 * WHOLE group receives, ...
 * Parity with the job (jobs/relayFanOut RELAY_MEMBER_ADDED_JOB): ...
 */
export async function buildAddPreview(...) {
  ...
  const body = composeMemberAddedBody(candidate.name, ...);
```

Its stated contract is PARITY WITH THE JOB. After 9.4 the job produces TWO
bodies, and 9.6 persists the NEW MEMBER's one while everyone else receives the
group line. The preview has to choose, and the spec does not say which - nor
does it note that the docblock's "the body the WHOLE group receives" stops being
true. Same class of omission as finding 2, on the same file.

**(b) `{role}` needs I/O the composer cannot do.** Section 9.4 sources `{role}`
from `UnitContact.role` (`app/src/repos/unitsRepo.ts:69`, VERIFIED as
`'landlord' | 'pm' | 'owner' | 'other'`). Section 9.3 requires the composer to
stay "PURE and synchronous ... No repo reads below the composer", with the
resolver "in the job handler". The member-added JOB
(`app/src/jobs/relayFanOut.ts:669-698`) currently reads only the conversation;
it has a `conversations`/`contacts` handle but no `unitsRepo` and no owner
resolution. `buildAddPreview` takes `RosterResolutionDeps` and a `RosterOwner`
and would need the same new read. Neither the new dep nor the preview's copy of
the resolver is stated.

**Implies.** A builder will implement the job and ship a preview that shows copy
nobody receives, or will put a repo read inside the composer and break 9.3's own
purity rule.

---

## 6. [HIGH] The two new intro variants drop the sender identity that the spec's own argument in 9.4 says is load-bearing - on a first-contact SMS with no STOP either

**Spec:** section 9.1 (tour intro, placement intro) vs section 9.4.

**What is wrong.** The naked intro opens `"Hey, it's Sam."`
(`app/src/messages/catalog.ts:281-290`). Neither new variant carries any sender
identity:

```
Hey {tenantFirstName}! Putting you in a group text with {propertyContactFirstName} to tour {where} at {time}. ...
Hey {tenantFirstName}! Excited to have you move into {where}. ...
```

These are first-contact messages from a pool number the recipient has never
seen, and section 9.4 confirms STOP is omitted. The catalog already records that
this exact exposure was created deliberately once and states it in terms:

`app/src/messages/catalog.ts:240-249`

```
// ... relay.identity has NO send site anywhere in the app, so this entry's own
// "with <brand>" was the ONLY thing identifying us on a first-contact text.
// With it removed, the group intro now carries NEITHER business identity NOR
// opt-out language, and a stranger's first text from an unknown number no
// longer says who it is from. Engineering stated that exposure; the founder
// directed it anyway.
```

After that removal, `"it's Sam"` was the last identifier left. The new variants
remove it too - and the spec is demonstrably AWARE the clause matters, because
section 9.4 justifies giving the new member the naked intro on precisely that
ground: "the naked intro is the one that already carries 'it's Sam' and names
who else is on the number." The spec cannot rely on that property in 9.4 and
discard it without comment in 9.1.

**Implies.** This is not a re-litigation of D8 (three variants) - it is that the
variants as WORDED remove a property the spec elsewhere treats as decisive, and
they do it on the message that reaches a tenant first. It needs an explicit
ruling and a founder handback line (section 15), the way section 6.1 got one.

---

## 7. [MEDIUM] The label-completeness "safety net" cited in 4.3 does not work in the direction claimed, and only two of four surfaces per new token are named

**Spec:** section 4.3 - "Both are added to `ReminderSkipReason`
(`app/src/repos/tourRemindersRepo.ts`) and to `REMINDER_SKIP_REASON_LABELS`
(`dashboard/src/api/types.ts`). The existing label-completeness test
(`dashboard/src/api/types.test.ts:119`) pins that the two maps agree, so a
missing label fails the build."

**What is wrong.** The test does not compare the two maps. It compares the label
map against a HAND-WRITTEN string array in the test file, and its own comment
says why the safety net runs only one way:

`dashboard/src/api/types.test.ts:87-106`

```
// Listed here as plain strings rather than imported or typed against the wire
// union so that the two hand-duplicated unions are checked against each other:
// the Record type already catches "member added to the dashboard union, label
// missing", but nothing catches "the app added a reason and the dashboard union
// was never touched" - which fails no build and degrades the chip to a
// reason-less "Skipped".
const SKIP_REASONS = [ 'no_conversation', ... 'booked_too_late' ];
```

So a token added to the app union alone fails NOTHING. And each new token needs
FOUR edits, of which the spec names two:

1. `app/src/repos/tourRemindersRepo.ts` `ReminderSkipReason` (named);
2. `dashboard/src/api/types.ts:1208-1223` - the hand-duplicated
   `TourReminderView['skipReason']` union (NOT named);
3. `REMINDER_SKIP_REASON_LABELS` (`dashboard/src/api/types.ts:1271-1284`) (named);
4. `SKIP_REASONS` in `dashboard/src/api/types.test.ts:95-106` (NOT named) -
   omitting it makes `:119` FAIL, since it asserts key-set equality.

This applies to THREE tokens, not two: section 7 adds `names_unavailable` as a
skip reason as well, and section 7 names only the label.

**Implies.** Low blast radius (the omissions surface as a red test or a
reason-less chip) but the spec is teaching the builder to trust a gate that does
not exist. Correct the claim and enumerate all four.

---

## 8. [MEDIUM] `overdue` is specified at one of three view-build sites, and two other renderers of the same rungs are neither built nor excluded

**Spec:** section 8.1 - "set at the view-build site
(`routes/tourReminders.ts:598-609`)".

**What is wrong.**

**(a) `viewOf` is a second builder of the SAME wire type.**
`app/src/routes/tourReminders.ts:336-349` constructs a `TourReminderView` for
the PATCH cancel/restore response (`:393`, `:406`) and for the send-now response
(`:460`, `:471`). It has no `dueAt`-vs-now logic and would omit `overdue`. The
panel replaces the row in place from those payloads
(`dashboard/src/api/endpoints.ts:2533-2542, 2555-2563`), so an overdue rung that
the operator cancels and restores loses its overdue marker until the next list
fetch. The spec's own "Omitted when false" convention makes that indistinguishable
from "not overdue".

**(b) Two other renderers of upcoming tour rungs are unaddressed.**
`app/src/routes/contactTimeline.ts:240-254` defines `TimelineScheduled`, and
`:994-1028` projects the same pending reminder rows into the contact page's
Upcoming bucket, with the same `MANUAL_ONLY_REMINDER_KINDS`-driven suppression
(`:84,:1091`) and no state/overdue concept at all. `app/src/routes/relayGroups.ts`
carries the third copy of the body-projection (named as such in
`routes/tourReminders.ts:253-267`). Section 13 excludes `routes/placementNudges.ts`
and the placement-nudge twin explicitly; it says nothing about these two, so a
builder cannot tell whether they are out of scope or forgotten.

**Implies.** Name (a) as in-scope or the flag is unreliable on the surface it was
built for. Name (b) either way.

---

## 9. [MEDIUM] Section 3's ordering guarantee is not delivered by its own mechanism

**Spec:** section 3 - "The sweep is idempotent and conditional-write, so
re-running it after the deploy is safe and catches anything armed in between."

**What is wrong.** "Safe" and "catches in time" are different claims. The
sequence is: (2) human sweeps prod against the OLD deployed code, (3) human
deploys. Rows armed by the still-running old code between (2) and (3) are
unswept when the new code goes live, and the poll runs on a 60s interval, so
they fire on the FIRST post-deploy tick - before any human can re-run anything.
A post-deploy re-run cannot catch a row that already sent; `claimSend` is the
`sentAt` stamp (`app/src/repos/tourRemindersRepo.ts:249-284`).

The practical exposure is small - `confirmation` arms with `dueAt = now`
(`app/src/jobs/tourReminders.ts:126`), so a confirmation armed in that window is
for a fresh booking and is timely - but section 4.1's stated hazard (population
A rows carrying OLD dueAts) is not fully closed, and the spec presents it as if
it were.

**Implies.** State the residual honestly, or add the obvious closure: run the
sweep AFTER the deploy with the worker stopped, or have the deploy step itself
gate the poll for one cycle. As written, the sentence will be read as a
guarantee.

---

## 10. [MEDIUM] The e2e conversion is not "mechanical" - a clock-travel tick pulls every earlier same-tour rung into one batch, where the fire-time backstop claim-SKIPS them

**Spec:** section 10 - "`tickTourReminders(justAfter(await armedReminderDueAt(kind)))`
... The sites convert mechanically ... the residual risk of clock-travel ticks is
that a future `now` also fires seeded rows, and assertions are already
phone-scoped."

**What is wrong.** The stated residual covers other tours. It misses the same
tour. `listDue(now)` returns every pending row with `dueAt <= now`
(`app/src/repos/tourRemindersRepo.ts:211-247`), and `processReminderRow` then
retires every rung that has a LATER-ladder sibling in that snapshot:

`app/src/jobs/tourReminders.ts:888-902` (`supersededInBatch` -> `claimSkipRow(...,
'quiet_hours_superseded', ...)`).

So a site converted to fire, say, `en_route` at `justAfter(en_route.dueAt)` does
not merely fire `en_route` - it silently claim-SKIPS `day_before` and
`morning_of` on the same tour in the same pass. Any assertion in the converted
suites that those rungs are still `upcoming`, or that the ladder shows N
pending, changes meaning. The vehicle also depends on
`armedReminderDueAt` finding a rung in state `upcoming`
(`e2e/scenarios/steps.ts:2020-2030`), which is exactly what the batch retires for
the earlier rungs.

**Implies.** The conversion needs a stated rule (pick the EARLIEST pending rung,
or tick per-rung with a `now` between siblings), not "mechanically".

---

## 11. [MEDIUM] The single-pass `interpolate` rewrite can introduce a NEW substitution vector that today's implementation is immune to, and the spec's test list does not cover it

**Spec:** section 12 (D12) and section 11.

**What is wrong.** The current implementation substitutes with
`out.split(needle).join(value)` (`app/src/messages/resolve.ts:41`), which treats
`value` as a literal. The natural single-pass rewrite is a regex
`String.prototype.replace` over `/\{(\w+)\}/g`. If the replacement is passed as a
STRING rather than a function, `$&`, `$'`, `` $` `` and `$1` inside the value are
interpreted as replacement patterns. The values here are contact display names
and operator-supplied text - the same untrusted feed that motivated the
re-expansion fix in the first place.

The spec lists three behaviours that must be preserved and says "the test
coverage above is not optional", but none of the three covers a `$`-bearing
value. The fix for a token-injection bug would ship a different injection bug
with a green suite.

I verified the three stated behaviours are described correctly
(`app/src/messages/resolve.ts:24-44`): undeclared tokens are untouched (the loop
iterates `allowed` only); a declared-and-present token with no value throws when
`strict` and empties otherwise (`:35-40`); a declared token absent from the
template is skipped by `if (!out.includes(needle)) continue` (`:32`).

**Implies.** Add "a value containing `$&` / `$1` survives verbatim" to section
11's required regressions, or mandate a function-callback replacement.

---

## 12. [MEDIUM] `composeConnectionSentence`'s redefinition leaves its zero-others branch undefined

**Spec:** section 9.2 - "as a token it resolves to the noun phrase `2 other
people` / `1 other person` ... The degenerate zero-others case ('You're now
connected on this number.') is dropped - a relay group with no other members is
not a group."

**What is wrong.** Dropping the SENTENCE does not answer what the TOKEN resolves
to. The branch is reachable by construction:

`app/src/jobs/relayFanOut.ts:189-206`

```
if (named.length === 0) {
  const others = Math.max(memberNames.length - 1, 0);
  return others > 0 ? `... ${others} other ${others === 1 ? 'person' : 'people'} ...`
                    : `You're now connected on this number. ...`;
}
```

With one nameless member, `others === 0` and the new token formula yields
"0 other people" (or an empty `{names}`) inside the sentence the spec keeps:
"You're now connected with 0 other people on this number." `sendRelayAnnouncement`
does refuse an EMPTY roster (`app/src/services/relayAnnouncements.ts:165-178`)
but not a one-member one, and the preview path composes with whatever roster the
operator has assembled so far.

**Also worth confirming while you are in there:** I checked the byte-identity
claim for the naked intro and it HOLDS for both surviving branches - the named
list case and the "N other people" case both reproduce today's string exactly
once `{members}` is split into "You're now connected with {names} on this number.
Reply here and everyone in the group sees it." That part of 9.2 is sound.

---

## 13. [LOW] The placement intro reinstates a sentence a dated founder decision removed, without the reversal note the spec's own discipline demands

**Spec:** section 9.1 placement intro - "... `{propertyContactFirstName}` will
share updates as they receive them from the housing authority."

**What is wrong.** That sentence was removed by a dated decision and is asserted
against in the suite:

`app/src/messages/catalog.ts:250-252` - "Same removal for the housing-authority
sentence: updates come from the landlord, not from Sam."
`app/test/messages/catalog.test.ts` - `expect(MESSAGE_CATALOG['relay.intro'].default).not.toContain('housing authority');`

The new wording arguably HONOURS the 2026-08-20 rationale (it attributes the
updates to the property contact, not to Sam), and the assertion is scoped to
`relay.intro` so a new entry will not trip it. But section 9.4 makes a point of
recording the 2026-07-14 reversal "explicitly, with its date ... so nobody
re-derives the old rationale". The same courtesy is owed here, or the next reader
of `catalog.ts:250` files the placement intro as drift.

---

## 14. [LOW] The three new catalog entries are given copy but no catalog metadata, and two existing invariants constrain them

**Spec:** section 9.1 / 9.4 give five new bodies (tour-today, tour-other-day,
placement, member_added-with-role, member_added-no-role) and no ids, `class`,
`channel`, `editable`, or `requiresOptOut`.

Constraints a builder will hit:

- `app/test/messages/catalog.test.ts:43-52` - "a NON-editable entry uses every
  var it declares in its default (no dead tokens)". Each variant must declare
  exactly its own tokens; the `{when}` / `{time}` split across the two tour
  variants is what makes that satisfiable, but it is implied rather than stated.
- `app/test/messages/catalog.test.ts:62-69` pins `relay.intro` and
  `relay.member_added` as `editable: false` with a written rationale
  (nothing can store or route an override). New relay entries inherit that
  reasoning; the spec only says `relay.intro` "stays `editable: false`"
  (section 13).
- `app/test/messages/catalog.test.ts:35-41` - every `{token}` in a default must
  be declared in `vars`.

**Implies.** One paragraph of catalog metadata in section 9 would remove three
guesses from the build.

---

## 15. [LOW] Stale and drifted code citations a builder will grep by

- `sendOneReminder` (sections 6.2 and 7) does not exist. The sites are
  `processReminderRow` (`app/src/jobs/tourReminders.ts:910` quiet backstop,
  `:1037` names catch) and `sendGroupReminder` (`:1210`). See finding 3.
- `sendRelayAnnouncement` (section 9.6) is cited as `:190-294`; the function
  begins at `app/src/services/relayAnnouncements.ts:147`.
- The dashboard `TourReminderView` twin (section 8.1) is cited as
  `dashboard/src/api/types.ts:1196`; the interface begins at `:1191`.
- `armedReminderDueAt` / `tickTourReminders` (section 10) are cited as
  `e2e/scenarios/steps.ts:2033-2046`; they span roughly `:2010-2046`.
- Section 5 correctly instructs correcting the `MANUAL_ONLY_REMINDER_KINDS`
  docblock, but leaves `app/src/messages/tourCopy.ts:135-137` ("Phase B disposes
  of both entries") false after 5 supersedes Phase A spec 6.4. Same class of
  stale comment, same change.

Verified-correct citations, for the record, so a later reviewer does not re-walk
them: `getOwner` at `conversationsRepo.ts:385`; `ROSTER_UNAVAILABLE_GRACE_MS` =
1h at `rosterResolution.ts:100`; empty-`unitId` rejection at `routes/tours.ts:315`;
`names_unavailable` already in the force-send refusal union at
`jobs/tourReminders.ts:1328` (spec says `:1478`, which is its USE site - both
are real); the bare-"Skipped" fallback at `RemindersPanel.tsx:100-107`;
`formatStreet` street-only at `address.ts:90-104`; `{when}` = "`<date> at <time>`"
at `tourCopy.ts:115`; `settingsToOverrides` mapping only two non-tour ids at
`resolve.ts:73-79`; the five `backfill-*.ts` precedents and
`backfill-relay-optout-flag.ts`'s pure-planner / `--dry-run` / no-local-guard
posture at `app/scripts/backfill-relay-optout-flag.ts:1-51`.

---

## 16. [LOW] The sweep's population A silently destroys operator-restored rungs, which the repo documents as a deliberate "send it after all"

**Spec:** section 4.2 - "Population A ... Every PENDING rung of any kind on a
tour whose `scheduledAt` is in the past at sweep time."

**What is wrong.** "Any kind, pending" includes a rung an operator explicitly
un-cancelled:

`app/src/repos/tourRemindersRepo.ts:152-158`

```
* Restore ONE canceled rung to pending (operator un-cancel). ...
* A restored PAST-DUE rung fires on the next poll tick (the panel shows
* "sending shortly" - deliberate: an un-canceled confirmation means "send it
* after all").
```

Section 4.1's whole premise is that manual-only rungs are left PENDING so "Send
now keeps working"; the sweep then removes that capability for every rung on
every past tour, with no lower bound (a tour that ended ten minutes ago
qualifies). That is probably the right call, but it is a deliberate reversal of a
documented operator affordance and the spec does not acknowledge it.

---

## Things I checked and found the spec RIGHT about

Recorded so they are not re-litigated:

- Section 4.2's core correction is correct: `REMINDER_KINDS`
  (`jobs/tourReminders.ts:235-240`) governs arming only, and the poll filters
  `listDue` output on `manualOnlyKinds` (`:602-603`), so removing `confirmation`
  from `REMINDER_KINDS` does nothing to existing rows.
- Section 10's unit-test vehicle is real: `tourRemindersRepo.create`
  (`:174-197`) has no past-due drop; only `armTourReminders:390-393` does. This
  refutes ledger item 3's "No armed rung can substitute" correctly.
- Section 4.3's refusal to reuse `past_event` is right on the merits - the token's
  docblock (`tourRemindersRepo.ts:47-50`) means "lands at/after the tour start",
  which is false of a swept row.
- Section 3's degradation claim is right: `viewOf` spreads `skipReason` verbatim
  (`routes/tourReminders.ts:347`), `stateOf` keys on `skippedAt` only (`:157-162`),
  and the panel falls back to a bare "Skipped" (`RemindersPanel.tsx:100-107`), so
  unknown tokens written by the sweep degrade cleanly on the running build.
- Section 7's force-send posture is right: `forceSendReminder` refuses with
  `names_unavailable` pre-claim and leaves the row pending
  (`jobs/tourReminders.ts:1469-1482`).
- Section 8.1's argument against widening the `state` union is right, and
  UNDERSTATED - there is a THIRD `'upcoming'` comparison at
  `routes/tourReminders.ts:591` (`state !== 'upcoming'`) gating the suppression
  estimate, on top of the two the spec names at `:497` and `:616`.
- Section 12 item 9 is right: `settingsToOverrides` maps only `welcome.sms` and
  `missed_call.autotext` (`resolve.ts:73-79`), and no `tour.*` compose site
  passes `overrides`, so `reminderNamesUsed`'s defaults-only derivation is safe.
  The `TODO(tour-reminder-ladder-phase-b)` marker is at
  `app/src/messages/tourCopy.ts:172` (one occurrence, as implied), and
  `docs/issues/tour-copy-where-token-declared-not-passed.md` exists.
- Section 9.2's byte-identity claim for the naked intro holds for both live
  branches (see finding 12).
