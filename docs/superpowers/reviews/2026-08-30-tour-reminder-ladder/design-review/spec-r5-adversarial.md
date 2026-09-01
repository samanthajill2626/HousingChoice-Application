# Round 5 adversarial review - tour reminder ladder spec

Reviewer A, continued (rounds 1-4). Narrow pass, per my own round-4
recommendation. Target: the spec at commit `4749e4d1`. SPEC ONLY.

Scope of this pass: the two substantial new sections (6.3a rewrite, 9.6), the
rewritten segment paragraph, the two accepted consequences in section 2, and one
more sweep for an unenumerated writer or reader. I did not re-open settled
ground.

---

# VERIFIED CORRECT - the round-4 fixes hold

Stating these first because two of them were wrong twice and the coordinator
asked for arithmetic.

**6.3a's core rewrite is right.** Every factual claim in the new text checks out:
`composeBodyForRow` is module-private at `jobs/tourReminders.ts:532` with callers
only at `:846`, `:1006`, `:1224`; `relayGroups.ts:256` is a
`((): string => {...})()` IIFE inside `.map()`; `composeTourReminderBody`
(`messages/tourCopy.ts:48`) returns `string` synchronously. The new instruction -
composer stays pure and sync, each caller resolves, previews hoist above their
sync compose - is the correct shape and no longer contradicts section 10. The
"THE REAL HAZARD IS THE DUPLICATION" paragraph is well-aimed: `relayGroups.ts:253`
does carry "DUPLICATED SHAPE (3 copies, keep in sync)", and
`tourCopyCallSites.test.ts:16-19` does disclaim body-level coverage in its own
header.

**The segment arithmetic is now right.** I counted the template independently:
`tour.morning_of` has 94 fixed characters; with a 7-character `{time}` that
leaves `160 - 94 - 7 = 59` for `len(firstName) + len(where)`, and `59 - 35 = 24`
at the seeded address. Both stated figures reproduce. The "four more, not nine"
correction is also right (`Alejandra` 9 vs `there` 5). The reframing from margin
to two-input budget, measured against the worst realistic address rather than the
fallback body, is the right framing. (UNVERIFIED: I counted characters rather
than running `analyzeSms`, so GSM-7 septet counting could differ by a character
or two; the structure holds regardless.)

**No sixth row-writer.** I swept for one. `tour_reminder` as a `DeadlineType` is
RETIRED (`placementsRepo.ts:63`), so the deadlines surface is not a writer;
`seed/lean.ts` writes no reminder rows (its only `tour_reminder` mention,
`:375`, is a deadline exclusion comment). The five now named - `jobs/tourReminders.ts`,
`repos/tourRemindersRepo.ts`, `seed/matrix.ts`, `seed/cast.ts`, and
`seedLive.test.ts`'s drift twin - are the set.

On the reader side I did find two renderers no revision has named -
`dashboard/src/routes/contact/ScheduledCard.tsx:14` and the conversation
detail's scheduled bucket - but both consume `body` as an opaque string and need
no change. Noting them only so the next sweep does not re-derive them.

---

# NEW FINDINGS

## 1. [HIGH] The contact timeline already memoizes the unit read and SWALLOWS its
failures, so 6.3a's preview instruction silently breaks 6.3b's absence-vs-failure
rule - and makes a preview disagree with a send

This is the one finding this round that changes what gets built.

**What is there.** `routes/contactTimeline.ts:860-871`:

```ts
const unitOnce = (unitId: string): Promise<UnitItem | undefined> => {
  let pending = unitReads.get(unitId);
  if (pending === undefined) {
    pending = repos.unitsRepo.getById(unitId).catch((err: unknown) => {
      log.warn({ err, unitId }, 'contact timeline: unit read failed - composing without an address');
      return undefined;
    });
    unitReads.set(unitId, pending);
  }
  return pending;
};
```

It is exactly the per-request, `unitId`-keyed memo that 6.3a asks the builder to
resolve behind, and section 10 separately instructs ("resolve contacts once per
request and batch; do not read per rung"). A builder will reuse it - correctly,
for performance.

**Why that breaks the new rules.** `unitOnce` **collapses a read FAILURE into
`undefined`**, indistinguishable from "no such unit". That is harmless today,
because both outcomes degrade to the no-address twin and section 6.3b's read-path
rule permits degrading. It stops being harmless once the property contact rides
the same read, because the property contact does not select a CLAUSE - it selects
an ENTRY:

- Failed unit read -> `undefined` -> no roster -> no property contact -> 6.3b
  says "compose the SELF-GUIDED entry instead".
- So a **landlord-led tour's preview renders self-guided wording** on a transient
  unit-read blip.
- The SEND path does not use `unitOnce` - `composeBodyForRow`
  (`jobs/tourReminders.ts:539-548`) does its own `try/catch` around
  `unitsRepo.getById` - and would render the landlord-led wording.

That is a preview disagreeing with a send, which is the failure 6.3a's own
duplication paragraph is about, arriving through a door that paragraph does not
watch: not hand-mirrored code drift, but **divergent failure handling between an
already-memoized read path and a non-memoized send path.** It is also this
repo's named `batch-read-absence-ambiguity` pattern, and section 6.3b was written
precisely to forbid the collapse it permits here.

**What the spec must say.** In 6.3a, state that the property-contact resolution
must NOT inherit `unitOnce`'s failure-to-`undefined` collapse: either the memo
distinguishes failure from absence (cache a discriminated result, not
`undefined`), or the property contact resolves through its own read whose failure
is handled per 6.3b. Say which. And add the corollary to 6.3b: for the ADDRESS,
failure and absence may collapse (they already do, and both degrade identically);
for the PROPERTY CONTACT they may not, because the two outcomes select different
catalog entries.

## 2. [MEDIUM] 6.3a keys the preview resolve by `unitId` and never says how the
TENANT is keyed - and on the only multi-tour surface the tenant is constant

6.3a says: *"Resolve once per request, keyed by `unitId` (the property contact
varies per TOUR, so a single per-request value would stamp one name onto every
row)."*

Two imprecisions, one of them substantive:

- The property contact varies per **UNIT**, not per tour - which is why `unitId`
  is the right key and why `unitOnce` already uses it. Minor wording.
- **The tenant is not addressed at all.** On the only preview surface that walks
  multiple tours, the tenant is *constant*: `contactTimeline.ts:874` is
  `await repos.toursRepo.listByTenant(contactId)`, so every tour in the walk has
  the same tenant, and it is the page's own contact. One read serves the whole
  request. The other two previews (`routes/tourReminders.ts`, `relayGroups.ts`)
  each handle a single tour, so both names are single reads there.

A builder following "keyed by `unitId`" literally, with no rule for the tenant,
will either key the tenant by `unitId` too (wrong - no such relationship) or read
it per rung (the thing section 10 forbids).

**What the spec should say.** One clause: on the contact timeline the tenant is
constant and equals the page contact (`listByTenant(contactId)`); the property
contact is memoized by `unitId`; on the two single-tour previews both are single
reads.

## 3. [MEDIUM] Section 9.6 instructs reusing `past_event` for the backlog sweep -
the exact reuse section 8.2 calls a lie, 163 lines earlier

**The contradiction, both in this document:**

- Line 530 (section 8.2), refusing to reuse an existing token for a new
  situation: *"Reusing `past_event` is a lie (the rung would land before the
  tour)."* That refusal is the entire justification for adding `booked_too_late`.
- Line 693 (section 9.6), specifying the Phase B sweep: *"retire anything whose
  dueAt is meaningfully past, as `past_event`."*

**And it is false on the merits for most of the backlog.** `past_event`'s
documented meaning (`repos/tourRemindersRepo.ts:47-50`) is "the rung's (clamped)
dueAt lands at/after the tour start". A stale `day_before` row for a tour that
happened last month has `dueAt < scheduledAt` - it is not `past_event` by any
reading. Stamping it as one puts "would land after the tour starts"
(`dashboard/src/api/types.ts:1270`) on the operator's chip for a rung that would
have landed a day early.

This matters beyond tidiness: section 8.2's principle is the reason the change
takes on a new token, a wire-union edit and a dashboard label at all. Undercutting
it in 9.6 tells the next reader the principle is negotiable.

**What the spec must say.** Either name a correct token for the sweep or state
that Phase B adds one (`stale_backlog` or similar) under the same rule 8.2
applied - and note it inherits the same two-union, silent-degradation problem 8.2
documents.

## 4. [MEDIUM] The "roughly NINETEEN CHARACTERS" sentence survived, four lines
above the paragraph that declares any such margin meaningless

Spec lines 165-168 still read: *"`tour.morning_of` is the longest and
highest-volume rung, and the measured margin is roughly NINETEEN CHARACTERS."*

The very next paragraph is headed *"READ THE GATE BEFORE TRUSTING ANY MARGIN"*
and explains that 19 was computed from the fallback body, and the one after that
is *"STATE IT AS A BUDGET, NOT A MARGIN."* The document now asserts the number,
then debunks the category the number belongs to, without retracting it.

A reader skimming for the constraint takes the bolded figure from the first
paragraph. That figure is the wrong one - the budget is 59 shared between two
inputs, of which 19 is one point on one axis.

Precision edit, but in the paragraph the coordinator has now had wrong twice, so
worth closing properly: delete the NINETEEN sentence and let the budget stand
alone.

## 5. [MEDIUM] Section 2's stated reason for leaving the Send-now button live is
factually wrong - this phase DOES touch that file and that line

The acceptance reads: *"suppressing a per-rung button is dashboard work this
phase does not otherwise touch, and a disabled button with no explanation is its
own confusion."*

The first clause is false. This phase already opens the dashboard, and
specifically opens the file and the line the button lives on:

- Section 11 requires fixing the interpolated aria-label at
  `RemindersPanel.tsx:347` - which is the Send-now button itself.
- Section 8.2 requires editing `dashboard/src/api/types.ts` (the skip union at
  `:1205ff` and the label map at `:1262ff`).
- Section 11 also requires the `REMINDER_KIND_LABELS` relabel at `types.ts:1242`.

So the marginal cost is not "opening dashboard work we otherwise avoid"; it is a
conditional on an object already being edited.

**I am not saying the decision is wrong.** The second clause - a disabled button
with no explanation is its own confusion - is a real argument and may well carry
it on its own. But an accepted consequence resting on a false premise is the
thing this review series exists to catch, and if the premise is corrected the
decision deserves one more look, because "we're already in that file" changes the
cost side of it.

**What the spec should say.** Strike the "does not otherwise touch" clause and
re-state the acceptance on the confusion argument alone - or reconsider.

**Separately, UNVERIFIED:** section 2 asserts the confirmation copy "IS in her
voice (it was rewritten in the previous pass)". The catalog default is
`Hey, your tour is set for {when} at {where}.` I could not confirm it was the
2026-08-18 founder rewrite specifically rather than an earlier pass. Cheap to
check before the human gate; the acceptance leans on it.

## 6. [LOW] 9.6's sweep criterion conflates two populations

*"Retire anything whose dueAt is meaningfully past"* is undefined, and the
backlog is not homogeneous:

- Stale rungs of tours that already happened - unambiguously retire.
- `confirmation` rows of tours still in the FUTURE - past-due the instant they
  are written (`dueAt = now`, `jobs/tourReminders.ts:98`), so any "dueAt is past"
  criterion sweeps them too.

Sweeping the second population is probably the intent, since the founder wants no
confirmation text - but it happens as a side effect of a criterion aimed at the
first, and a Phase B builder could reasonably read "meaningfully past" as
excluding a row written yesterday for a tour next week.

One clause naming both populations and the intended treatment of each would
settle it.

---

# CONTESTING THE ADJUDICATIONS

## Ruling (b) and the backlog - CONCEDED, your reasoning holds

I asked whether the backlog reopens the confirmation ruling. It does not, and
your basis is right: the pause has held since 2026-08-20 and manual-only rungs
are left PENDING by deliberate design (`jobs/tourReminders.ts:457-471` - "LEFT
PENDING on purpose, NOT claim-skipped" so Send-now still works), so
`day_before`, `morning_of` and `en_route` rows have been piling up for six days
independent of anything decided this week. Phase B owes the sweep regardless of
(b). A one-time retirement sweep is the proportionate answer; un-arming
`confirmation` now would not remove the need for it.

One sharpening worth putting in 9.6, which strengthens rather than reopens your
call: `confirmation` is the only rung whose **entire population** is in the
backlog by construction - the other three are only in it for tours that have
already passed, while every confirmation row is past-due from birth. That is what
takes the sweep from prudent to load-bearing. 9.6 already says "BEFORE it lifts
the pause" and "first task, not its last", which is the right strength; the
reason for that strength is worth one sentence.

## Nothing else from rounds 3-4 looks wrong

The clamped-dueAt correction, the `next`-from-pending-rows correction, the
inline empty-string guard, the "4 hours before" reject and the zero-primary defer
all still stand, and I re-affirm the two that corrected me.

---

# WHAT WOULD CHANGE WHAT GETS BUILT

- **Finding 1** - yes. It changes the failure handling on three preview surfaces
  and the shape of the per-request memo. Without it the builder reuses `unitOnce`
  and ships a preview that disagrees with the send on a transient read failure.
- **Finding 3** - yes, for Phase B: it determines which token gets persisted, and
  a wrong one is a data problem, not a prose problem.
- **Finding 2** - marginal. It prevents a per-rung tenant read or a mis-keyed
  cache; a careful builder would work it out from the code.
- **Findings 4, 5, 6** - precision edits. 5 may prompt a decision review, but the
  decision itself is defensible either way.

---

CONVERGENCE: Close but not yet - findings 1 and 3 both change what gets built or
persisted, and 5 rests an accepted consequence on a false premise, so this needs
one narrow patch; with those three closed I would call the document ready for the
human sign-off gate, and I would not expect a seventh round to earn its cost.
