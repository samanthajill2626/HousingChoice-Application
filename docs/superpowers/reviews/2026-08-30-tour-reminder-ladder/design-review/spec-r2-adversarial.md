# Round 2 adversarial review - tour reminder ladder spec

Reviewer: Reviewer A (round 1), continued. Lens: cold-build engineer, plus the
coordinator's three added charges - what everyone missed, whether the NEW prose
holds, and which round-1 ACCEPTs were wrong.

Target: `docs/superpowers/specs/2026-08-26-tour-reminder-ladder-design.md` (478 lines).
Adjudications: `.superpowers/design-review/adjudications.md`.

Every claim about existing behaviour below cites a file:line I opened in this
session. Anything I could not confirm is marked UNVERIFIED.

---

## 1. [BLOCKING] `pm_team` was deleted from the spec, and the seed manufactures it

**What is wrong.** `pm_team` appears NOWHERE in the rewritten spec. I grepped the
whole file: zero hits. The round-1 draft had it - old section 9 said "For WORDING
there are two buckets, not three: `self_guided` on one side, `landlord_led` and
`pm_team` on the other (Cameron, 2026-08-26)". The rewrite dropped that section
and never re-homed the ruling.

**Evidence.**

- `app/src/lib/toursModel.ts:92` - `TOUR_TYPES = ['self_guided', 'landlord_led', 'pm_team']`. Three types.
- New spec section 9's id table gives `en_route` a "tour type" fork with exactly
  TWO ids: `tour.en_route_self_guided` / `tour.en_route_landlord_led`.
- `app/src/lib/seed/matrix.ts:930` -
  `const tourType = counter % 3 === 0 ? 'pm_team' : ...`. **One tour in three in
  the demo world is `pm_team`.**
- `app/src/lib/seed/live.ts:359,371,384` - the lean/e2e world is `self_guided`,
  `landlord_led`, `landlord_led`. **No `pm_team` in the lean world at all**, so
  e2e cannot catch this.

**Why it ships a bug.** An implementer given a table that says "fork by tour
type" and two ids writes `` `tour.en_route_${tourType}` ``. For a `pm_team` tour
that yields `tour.en_route_pm_team`, which the catalog lacks - and section 9.1 of
this very spec documents the consequence: `MESSAGE_CATALOG[id]` is `undefined`,
`resolve.ts:58` throws a bare `TypeError`, every containment block catches only
`UncomposableReminderError`, so the poll row is never claimed and re-lists
forever AND three read endpoints 500. The spec diagnoses the failure mode in one
section and creates an instance of it in another.

The matrix seed makes it a demo-world outage rather than a theoretical one, and
the lean world's type distribution guarantees the gate stays green.

**What the spec must say.** Restore the ruling explicitly in section 9: `en_route`
forks into TWO buckets, `self_guided` on one side and `landlord_led` + `pm_team`
on the other; the id derivation is a mapping, not string interpolation over
`TourType`. Add `pm_team` to the section 13 matrix test's axis by name. Note that
the lean seed contains no `pm_team` tour, so this case has no e2e coverage and
must be pinned in unit tests.

---

## 2. [BLOCKING] Section 6.2 names a helper that does not exist, and the file it
names carries an explicit guard against being used this way

**What is wrong.** Section 6.2: *"Use the shared helper in
`app/src/lib/contactName.ts` and add no seventh copy."*

`app/src/lib/contactName.ts` exports exactly two things, and neither is a
first-name helper:

- `parseContactName(raw: string)` - a parser for the `"First Last - N Bed"`
  voucher-size naming convention. It returns `undefined` for **anything
  non-conforming** ("no size suffix, single-token names, garbage",
  `contactName.ts:31-33`). A tenant named `"Maria Alvarez"` with no ` - 2 Bed`
  suffix returns `undefined`. It is useless as a general first-name source.
- `contactDisplayName(contact)` - the **full** trimmed `First Last` join, not a
  first name (`contactName.ts:69-74`).

Worse, `contactDisplayName` carries a SCOPE GUARD in its own docblock
(`contactName.ts:52-60`):

> SCOPE GUARD: five PRIVATE copies of this derivation already exist
> (routes/contacts.ts, routes/units.ts, lib/rosterResolution.ts,
> services/groupMembers.ts, services/inboundEmail.ts). This export is consumed by
> PUSH-COPY sites only ... consolidating the older copies is tracked in
> `docs/issues/consolidate-contact-display-name-helpers.md` - do not re-point
> them here as a drive-by.

**Why it ships a bug.** Two failure modes, and both are likely. (a) The
implementer reads section 6.2, opens the file, finds `parseContactName`, uses it,
and every tenant whose name does not carry a bedroom suffix silently becomes
`Hey there,` - the fallback firing on the common case rather than the edge case,
with no error anywhere. (b) The implementer notices there is no such helper,
writes one into `contactName.ts` anyway because the spec told them to, and
violates the file's stated scope guard and its filed consolidation issue.

**This is a MISTAKEN ACCEPT of my own round-1 H2.** I asked the spec to "name the
one helper to use". The planner answered by naming a file rather than verifying a
function existed in it. The adjudication table (`| H2 | ... | ACCEPT |`) records
this as closed. It is not.

**What the spec must say.** There is NO existing first-name helper. Section 6.2
must state that one is being ADDED, give its name, module, exact signature, and
its derivation rule (`firstName` off the index signature, trimmed; then what? -
first whitespace token of `name`? refused?), and say explicitly whether it lands
in `contactName.ts` (and if so, that the scope-guard docblock is amended in the
same commit) or in a new module. The adjudication of PLAN reviewer C's B1
("helper narrowed; surname fallback explicitly refused") suggests the plan already
knows this - the SPEC does not, and the spec is what a cold builder reads first.

---

## 3. [BLOCKING] Section 8.1 fixes the past-dueAt overlap for rule 1 only. Rule 2
has the identical overlap and is left broken

**What is wrong.** Section 8.1 correctly identifies that the pre-existing
past-dueAt branch writes NO row (`jobs/tourReminders.ts:266`, a bare `continue`)
and would fire ahead of new rule 1, so it orders rule 1 first. It then says:

> Leave the past-dueAt branch itself alone for every other rung - it is unchanged
> behaviour that other tests pin.

Rule 2 is one of those "other rungs" and has the same collision.

**Evidence / arithmetic.** Rule 2 fires when `now > scheduledAt - 6h`.
`morning_of`'s raw dueAt is `scheduledAt - 4h` (section 7 table). The past-dueAt
branch fires when `dueAt < now`, i.e. when `now > scheduledAt - 4h`. So:

| booked | rule 2 | raw dueAt vs now | which branch wins |
| --- | --- | --- | --- |
| 6h+ out | no skip | future | armed normally |
| 4h-6h out | fires | future | visible `booked_too_late` row - correct |
| under 4h out | fires | **past** | past-dueAt wins - **NO ROW, silent gap** |

The under-4h case is the *most* late-booked case - precisely the one section 8.1's
own justification is about ("A founder who booked late should see WHY a rung is
missing rather than find a gap"). The rule produces the honest row for moderately
late bookings and vanishes for very late ones. That is the opposite of the
intended gradient, and nobody will notice because the two cases look the same
from the outside.

**What the spec must say.** Order BOTH new skip rules ahead of the past-dueAt
check, not just rule 1, and state the resulting rung-by-rung ordering explicitly
(rule 1 for `day_before`, rule 2 for `morning_of`, then past-dueAt for everything
else). Section 13's "boundary instants" coverage must include a booking under 4h
out, which is where the two branches cross.

---

## 4. [HIGH] `e2e/tests/scenarios/scheduled-visibility.spec.ts` drives the
`confirmation` rung end to end and is not mentioned anywhere in the spec

**What is wrong.** Section 9.1 removes `confirmation` from `REMINDER_KINDS`, so
no confirmation row ever arms again. Section 13's e2e paragraph names only
`REMINDER_BODY_MARKERS` and `timesFor`.

**Evidence** - `e2e/tests/scenarios/scheduled-visibility.spec.ts`:

- `:103` comment "The whole ladder is armed and upcoming right after booking; confirmation ..."
- `:106` `await flow.expectReminderRung('confirmation', 'next')`
- `:131` "Fire the confirmation rung -> the panel now reads it SENT, and day_before is ..."
- `:135` `await flow.expectReminderRung('confirmation', 'sent')`
- `:178` `await flow.expectReminderTo1to1('confirmation', tenant)`
- `:180` `await flow.expectReminderRung('confirmation', 'sent')`
- `:185` "upcoming ladder whose confirmation is the new NEXT rung"

`expectReminderRung` scopes rows by `REMINDER_KIND_LABELS[kind]`
(`e2e/scenarios/steps.ts:3376`), so every one of these locates a panel row that
will no longer exist. This spec is not a marker update - it is a structural
rewrite of the scenario, because `confirmation` is its *anchor* rung (it is the
one that used to be due immediately and could therefore be fired on demand).

Also unenumerated: `e2e/tests/tour-roster.spec.ts:519` filters a panel row by
`REMINDER_KIND_LABELS.confirmation` and asserts its skip chip
(`:521`, `Skipped - ${REMINDER_SKIP_REASON_LABELS.tenant_not_on_roster}`) - the
same breakage in a second file. And `e2e/tests/scenarios/quiet-hours.spec.ts:165-170`
scopes rows by kind label and is built on the old clamping arithmetic that
section 7.2 changes.

**Why it matters.** Section 13 sets the expectation that the e2e work is two
constants. It is at minimum three spec files, one of which loses its driving
rung. That is the difference between a half-hour task and a day, and it is the
kind of under-scoping that produces a "gates are green except e2e, will fix in
the morning" handback.

**What the spec must say.** Name `scheduled-visibility.spec.ts`,
`tour-roster.spec.ts` and `quiet-hours.spec.ts` explicitly, and state what
replaces `confirmation` as the on-demand rung those scenarios fire.

---

## 5. [HIGH] The matrix seed is a THIRD hardcoded copy of the ladder timing, with
a parity comment that this change falsifies

**What is wrong.** Section 10 names exactly one timing twin: *"`app/test/seedLive.test.ts:37`
carries a DELIBERATE second implementation of `computeDueAt` as a drift guard."*
There is a third, in production seed code, and the spec does not mention it.

**Evidence.**

- `app/src/lib/seed/matrix.ts:958` -
  `const dayBeforeDueAt = iso(scheduledMs - 24 * HOUR_MS); // computeDueAt('day_before') parity`
- `matrix.ts:880` (module docblock) - *"day_before sent at its dueAt (= scheduledAt - 24h)"*
- `app/test/seedMatrixCoherence.test.ts:465-474` pins those rows
  (`upcoming ... day_before dueAt > now`).

After this change `computeDueAt('day_before')` is 19:30 org-local on D-1. The
seed keeps `scheduledAt - 24h` and keeps CLAIMING parity in a comment. The demo
world then shows a ladder whose timings contradict the code, and the next person
to touch `computeDueAt` reads a false parity claim.

**Second, related, unenumerated surface in the same file.** `matrix.ts:976-987`
writes a `confirmation` reminder row for **every** non-requested tour, with
`sentAt` set and **no `sentBody`**. Read surfaces prefer the snapshot only when it
is a string (`routes/tourReminders.ts:236`:
`if (row.sentAt !== undefined && typeof row.sentBody === 'string')`), so all of
those SENT confirmation rows **recompose live from the catalog** on every panel
and timeline read. Section 13 owes only *"A pending `confirmation` row still
composes"*. The demo world's exposure is sent rows without a body, at volume.

**What the spec must say.** Add `app/src/lib/seed/matrix.ts` to section 10's
lockstep list (its `dayBeforeDueAt` constant, the `:880` docblock, and whatever
`seedMatrixCoherence.test.ts` pins), and extend section 13's confirmation test to
cover a SENT row with no `sentBody`, not only a pending one.

---

## 6. [HIGH] Section 12 still says the exemption hook is built. Section 7.3 says it
is cut. The contradiction the adjudications predicted was not fixed

**What is wrong.** Direct self-contradiction inside the approved document.

- Section 7.3 (line 237): *"The exemption hook - CUT FROM PHASE A (amended 2026-08-26)... this hook is NOT built in Phase A."*
- Section 12 item 1 (lines 425-427): *"The hook **is built here** but stays empty; enabling it is section 7.3's two sites."*

The adjudications file flagged this as standing question 3 (*"Section 7.3 was
amended but section 12's open items were not re-read against it"*) and it was not
closed.

**Why it matters.** Section 12 is the "what's left open" section - the one a
builder scans for work they still owe. It currently tells them to build the thing
section 7.3 forbids, using the exact phrasing ("stays empty") that makes it sound
like a five-minute task.

**What the spec must say.** Rewrite section 12 item 1 to: the exemption question
is open with the founder; the hook is NOT built in Phase A (7.3); both the
question and the hook are Phase B.

**On whether the CUT itself was right (the coordinator's direct question):
YES, and 7.3's reasoning verifies.** I checked the claim that the fire-time
backstop is unreachable in production. `runDueTourReminders` filters
`allDueRows` by the manual-only set at `jobs/tourReminders.ts:470-471` and
returns early on an empty result at `:479`. `MANUAL_ONLY_REMINDER_KINDS`
(`:163`) contains all four auto-armed kinds, and `no_show_checkin` is never
armed (`REMINDER_KINDS`, `:197`). So `processReminderRow` - and therefore the
`isQuietTime` gate at `:729` - is genuinely dead code in production today. A
hook whose second required site cannot be exercised is not testable, and my H1
asked only for the mechanism to be corrected, not for the hook to be built. The
escalation was not an over-correction. The only defect is that section 12 was
not re-read against it.

---

## 7. [MEDIUM] Forgetting the dashboard half of `booked_too_late` degrades
SILENTLY - the two unions are hand-duplicated, not type-linked

**What is wrong.** Section 8.2 says to carry the new token through
`dashboard/src/api/types.ts:1210` and the label map at `:1269`. It does not say
what happens if you do not, and the answer is "nothing visible fails".

**Evidence.**

- The dashboard union at `dashboard/src/api/types.ts:1205-1214` is a **hand-written
  literal union**, independent of `app/src/repos/tourRemindersRepo.ts:38`. Nothing
  imports one from the other.
- `REMINDER_SKIP_REASON_LABELS` at `:1262` is
  `Readonly<Record<NonNullable<TourReminderView['skipReason']>, string>>`, so
  adding a member to the *dashboard* union without a label IS a compile error -
  but adding it to the *app* union alone typechecks both workspaces cleanly.
  (Root `typecheck` runs `--workspaces` and `dashboard` is a workspace,
  `package.json:9-15`, `dashboard/package.json:10` - so the coupling that exists
  is enforced; the coupling that is missing is between the workspaces.)
- Runtime consequence: `RemindersPanel.tsx:103` computes
  `REMINDER_SKIP_REASON_LABELS[rung.skipReason]`, gets `undefined`, and
  `:106-107` renders the bare fallback chip `Skipped` with no reason - the exact
  "honest trace" the skipped-row design exists to provide, silently emptied.

**Also, section 8.2's enumeration is wrong.** It says *"The eight existing
`ReminderSkipReason` tokens"* and lists eight. There are **nine** -
`invalid_schedule` is the ninth (`tourRemindersRepo.ts:36` union, ninth member;
stamped at `jobs/tourReminders.ts:853`; labelled in the dashboard map at
`types.ts:1272`). A miscount in the sentence that introduces a new union member
suggests the list was written from memory rather than from the file.

**What the spec should say.** Correct the count to nine. State that the two
unions are hand-duplicated and that omitting the dashboard half fails SILENTLY to
a reason-less chip. Section 13's owed "test on the label" should be a parity
assertion, not a rendering assertion - something that fails when the app union
grows and the dashboard one does not.

---

## 8. [MEDIUM] What `dueAt` is stored on a `booked_too_late` row is unspecified,
and the panel orders and labels rows by it

**What is wrong.** Section 8 rules that both new rules compare against RAW
offsets. It never says what value is PERSISTED on the resulting visible skipped
row. For rule 1 the raw dueAt is by construction in the past (19:30 yesterday);
for rule 2 it may be past or future (see finding 3).

Every existing visible-skip row stores the CLAMPED value from the `dues` map
(`jobs/tourReminders.ts:274-279`, `:298-303` - both pass `dueAt` taken from
`dues.get(kind)`, which holds `clampOutOfQuietHours(...)` per `:250`). Plan
reviewer C's H1 adds a second RAW map. So the builder will have two values in
hand at the write site and no instruction.

**Why it matters.** `dueAt` is not inert display data. `routes/relayGroups.ts:242`
sorts the scheduled bucket by `dueAt.localeCompare`, and the Reminders panel's
"Next" chip is what `e2e/scenarios/steps.ts:3383` locates rows by. A skipped row
carrying a past dueAt sorts to the top of a ladder of future rungs; a skipped row
carrying a clamped future dueAt sorts among them. The two choices produce
visibly different panels.

**What the spec should say.** Pick one - I would store the RAW dueAt, because the
row's whole purpose is to say "this rung's time already went by" - and state the
resulting panel ordering so the e2e assertions are written against a decision
rather than against whatever the first implementation happened to do.

---

## 9. [MEDIUM] Section 8.1's reordering makes `day_before`'s past-dueAt branch
unreachable, and named tests pin the old behaviour as SILENT

**What is wrong.** Section 8.1 says the past-dueAt branch is *"unchanged behaviour
that other tests pin"* - which reads as reassurance that no past-dueAt test
breaks. For `day_before` specifically, the reordering makes the branch dead:
whenever `now > dueAt`, rule 1's `now > rawDueAt - 4h` is already true, so every
past `day_before` is now reported as `booked_too_late` with a visible row.

**Evidence** - `app/test/tourReminders.test.ts` pins the silent form explicitly:

- `:1211-1212` - *"day_before = scheduledAt - 24h = '2026-07-12T14:00:00.000Z' < now0 -> past-dueAt, the pre-existing SILENT skip (no row at all)."*
- `:356` - *"it is already past `now`: dropped by the pre-existing past-dueAt rule,"*
- `:397` - *"past and the pre-existing past-dueAt rule drops it before supersession is"*

These do not merely need re-baselining for the new 19:30 arithmetic - their
**assertion polarity flips** from "no row" to "one visible `booked_too_late` row".

**What the spec should say.** State that `day_before` no longer reaches the
past-dueAt branch at all, and that the existing no-row assertions for that rung
invert rather than shift. Section 13's suite list says `tourReminders` breaks; it
should say *how*, because "expected 0 rows, got 1" is the shape of a regression
and someone will "fix" it by re-suppressing the row.

---

## 10. [MEDIUM] Section 2's Phase A framing understates what reaches tenants

**What is wrong.** Section 2: *"It does not change when a tenant receives a text,
because no automatic send happens at all"* and *"Phase A is the safe place to be
wrong."*

Both are true about TIMING and false about COPY. Section 2 itself says the
observable effect includes *"what a human force-send COMPOSES"*, and
`forceSendReminder` (`jobs/tourReminders.ts:1156`) sends to a real tenant or a
real relay group with `automated: false`. In Phase A the founder's only way to
send a reminder IS "Send now". So the new copy - including the `Hey there,`
fallback, the self-guided degrade on a missing property contact, and any segment
overrun - reaches live recipients from day one of Phase A.

**Why it matters.** "Phase A is the safe place to be wrong" is the sentence a
reviewer will lean on when deciding how hard to scrutinise the copy fallbacks. It
is safe with respect to *unattended* sends only.

**What the spec should say.** One added clause: Phase A removes the AUTOMATIC
blast radius, not the human one; every rung a human presses in Phase A delivers
the new copy to a real recipient, so the fallback paths in 6.3 are live from the
first deploy, not from Phase B.

---

## 11. [LOW] Section 13 lists `relayAnnouncements` as a suite that WILL break. It
will not

**What is wrong.** Section 13: *"`relayAnnouncements` (`:67`)"* is listed among
*"Suites that pin this copy or timing and WILL break"*.

**Evidence.** `app/test/relayAnnouncements.test.ts:60-72` passes a hand-written
literal body (`body: 'Tour tomorrow.'`) and `kind: 'tour.day_before'` as an
**announcement tag string**, not a catalog id. Nothing in this change touches
either. The tag is derived from the RUNG at `jobs/tourReminders.ts:1081`
(`` kind: `tour.${row.kind}` ``) and `ReminderKind` does not change (section 9).

**Why it matters, mildly.** A "will break" list with a false positive on it
teaches the builder to treat the list as advisory. That is how the true positives
in the same list - `tourCopyCallSites`'s `ALLOWED_DIRECT` whitelist, the
`RemindersPanel.test.tsx` label - get skipped.

**What the spec should say.** Drop it, or move it to a separate "checked, not
affected" line.

---

## 12. [LOW] Section 11's relabel to "4 hours before" is right in direction but is
a nominal-offset name on a rung whose real time is clamped

**Contesting my own accepted M2.** The relabel decision is a net improvement and I
would keep it. But it is worth one sentence of honesty in the spec: section 7.2
establishes that this rung's actual fire time is frequently NOT four hours before.
For an 8am tour it is born skipped (`past_event`); for a 9am tour it clamps to
08:00, one hour before. So `4 hours before` is a nominal-offset label that is
sometimes as wrong as `Morning of` was - just wrong less often, and wrong in a
direction the panel's own displayed dueAt corrects.

**What the spec should say.** Either accept it with that caveat stated, or use a
position label (`Second reminder`) that cannot be falsified by clamping. Do not
leave a reader to discover 7.2 and 11 disagree.

---

## 13. [LOW] Section 6.1's snippet drops the empty-string guard the code it cites
actually applies

**What is wrong.** Section 6.1 gives:

```
unitContacts(unit).find((c) => c.primaryContact === true)?.contactId
  ?? unit.landlordId
```

The two call sites it cites both guard the fallback against an empty string:

- `services/rosterProvision.ts:233-234` -
  `?? (typeof unit.landlordId === 'string' && unit.landlordId.length > 0 ? unit.landlordId : undefined)`
- `lib/rosterResolution.ts:275` - `?? nonEmpty(unit.landlordId)`

The spec's transcription drops that guard. An empty-string `landlordId` would
yield `''` rather than `undefined`, and the code would then do a contacts lookup
on `''` instead of taking the 6.3 absence path.

Note the rest of 6.1 is correct and well-sourced: `unitContacts`
(`unitsRepo.ts:288-302`) does return the derived single-row roster from
`landlordId` when `contacts[]` is empty, so 6.1's "TWO cases, not one" analysis
holds, and the instruction not to read the `primary_contact` scalar
(`unitsRepo.ts:253`) is right.

**What the spec should say.** Reproduce the guard, or say "use
`rosterProvision.ts:233`'s expression verbatim" rather than paraphrasing it.

---

## 14. [LOW] The lean seed exercises only the `landlordId` leg of 6.1

**Observation, not a defect in the design.** `app/src/lib/seed/live.ts:188,210,232`
give units a `landlordId` and no `contacts[]` array, so `unitContacts` derives the
single-row roster (`unitsRepo.ts:296-300`) and the primary always resolves. The
zero-primary leg (a `contacts[]` that exists with no `primaryContact: true`),
which section 6.1 calls out as legal and reachable, has **no seeded instance** and
therefore no e2e path.

Section 13 already owes a unit test covering *"BOTH zero-roster and zero-primary"*
- good. Worth one added sentence that e2e cannot cover the zero-primary leg, so
the unit test is the only guard.

Seeded contacts do carry `firstName` (`live.ts:143,160,174` - Diana, Leon,
Gloria), so the e2e name coupling section 13 warns about resolves to real names
rather than to the `there` fallback. UNVERIFIED: which of those three is the
landlord on the two `landlord_led` tours at `live.ts:371,384`.

---

## Sections I checked and found sound - do not spend time re-litigating

- **Section 9.2** is correct on both throw sites. `routes/tourReminders.ts:548`
  is verbatim `res.json({ body: resolveMessage('tour.no_show_checkin') })` with no
  vars and no override argument, inside a handler that has already fetched the
  tour - so the tenant IS resolvable there. `tourCopyCallSites.test.ts:33`'s
  `ALLOWED_DIRECT` whitelist and its "token-free by design (spec D2)"
  justification are exactly as described.
- **Section 9.1** is correct and its blast-radius description matches
  `docs/issues/tourcopy-messageid-cast-unguarded.md` and the containment blocks I
  read. The exhaustive matrix test is the right remedy - it is also what would
  have caught finding 1.
- **Section 6.4** is right about `interpolate` (`resolve.ts:31-33` iterates
  `allowed` only) and right that `catalog.test.ts:35` is the build-time guard.
- **Section 6's** "declaring unused tokens is legal only because these entries are
  `editable: true`" is verified: `catalog.test.ts:43` scopes the dead-token rule to
  NON-editable entries.
- **Section 7.1** is verified: default quiet hours are `21:00`/`08:00`
  (`settingsRepo.ts:170-171`), and `staleDayBefore` at `jobs/tourReminders.ts:294`
  does retire a `day_before` whose clamped dueAt lands on the tour's local date.
  The WARN-don't-validate ruling is the right call.
- **Section 7.2's** arithmetic is right. `clampOutOfQuietHours`
  (`quietHours.ts:153`) returns the window END for an instant inside the window, and
  `:270`'s `dueAt >= scheduledIso` births the `past_event` row.
- **Section 8's** arm-instant framing is verified against `routes/tours.ts:350`
  (POST) and `:1177-1182` (PATCH cancel+re-arm on any `scheduledAt` change or move
  into `scheduled`).
- **Section 9.3** is verified: only `sentAt` rows with a string `sentBody` render
  the snapshot (`routes/tourReminders.ts:236`).
- **Section 10's** call-site enumeration is complete. I grepped
  `composeTourReminderBody` across `app/src`, `app/test` and `e2e`: the four src
  sites and the one harness site are exactly right, and the
  `routes/relayGroups.ts` caveat ("not a tour-reminder route surface, despite
  sitting in this list") is a genuinely useful correction.
- **Section 14's** gate discipline is correct.

`tourType` is POST-only (`routes/tours.ts:145` `POST_ALLOWED`; no PATCH
allowlist entry for it), so a tour's type cannot change after arming and the
`en_route` fork is stable for the life of a row. The spec does not say this and
does not need to - but it is the answer to the obvious "what if the type
changes" question, and one sentence in section 9 would stop the next reviewer
re-deriving it.
