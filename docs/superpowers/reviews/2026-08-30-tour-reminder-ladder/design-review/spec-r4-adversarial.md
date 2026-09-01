# Round 4 adversarial review - tour reminder ladder spec

Reviewer A, continued (rounds 1-3). Target: the spec at commit `3a9c9e8d`.
SPEC ONLY - the implementation plan is out of scope this round and is not
referenced below.

Every existing-behaviour claim cites a file:line I opened this session.
UNVERIFIED is marked where I could not check.

---

# NEW FINDINGS

## 1. [BLOCKING] Section 6.3a names a seam the preview surfaces do not use and
CANNOT use. The ruling's intent is right; the mechanism is factually wrong

The coordinator asked me to check this specifically. It is worse than suspected:
there are two independent reasons the seam fails, and 6.3a also now contradicts
section 10.

**6.3a asserts:**

> `composeBodyForRow` (`jobs/tourReminders.ts:547`) is called by BOTH routes and
> already reads the unit for the address. Resolve the two names there...
> The three preview surfaces call the same function and therefore inherit the
> same resolution - which is what keeps a preview honest against the send.

**Reason 1 - the previews do not call it, and cannot.** `composeBodyForRow` is
declared `async function composeBodyForRow(` at `jobs/tourReminders.ts:532` with
**no `export`**. I grepped the identifier across the repo: the only references
are its declaration and three call sites, `:846`, `:1006`, `:1224` - all inside
`jobs/tourReminders.ts` (poll 1:1, group send, force-send). It is module-private,
and its signature takes `Pick<RunDueTourRemindersDeps, ...>`, a job-layer type.

The three previews call the PURE composer `composeTourReminderBody` directly:
`routes/tourReminders.ts:238`, `routes/contactTimeline.ts:725`,
`routes/relayGroups.ts:258` - which is exactly what section 10's own call-site
list says. So "the three preview surfaces call the same function" is false, and
the sentence built on it - "which is what keeps a preview honest against the
send" - is the load-bearing justification for the whole ruling's mechanism.

**Reason 2 - all three preview call sites are SYNCHRONOUS, two of them inside
`.map()`.** Even if `composeBodyForRow` were exported, `await` cannot be
introduced there:

- `routes/relayGroups.ts:255-275` - the body is a synchronous IIFE
  `body: ((): string => { ... })()` inside `rows.filter(...).sort(...).map(...)`.
  Confirmed by reading it.
- `routes/tourReminders.ts:229` - `const bodyFor = (row, tour, tz, address?, tally?): string =>`,
  a synchronous arrow. Called at `:323`, `:335`, `:379`, and `:495` - the last
  inside the ladder `.map()`.
- `routes/contactTimeline.ts:716` - `function tourReminderBodyOrEmpty(...): string`,
  synchronous. Called at `:920` inside a per-rung map.

`composeTourReminderBody` itself is synchronous (`messages/tourCopy.ts:48`,
returns `string`).

**Reason 3 - 6.3a contradicts section 10.** Section 10 says: *"Its signature
grows to take the resolved names and the tour type... Every one must supply the
new arguments, INCLUDING the read-only previews."* That is the correct design -
resolution hoisted ABOVE each call site into its own async scope, results passed
down into a still-synchronous composer. 6.3a says the opposite: resolution
happens inside the seam and callers inherit it. A builder reading 6.3a and a
builder reading section 10 build two different things.

**Why the ruling's INTENT still holds.** The goal - "1:1 and group get identical
copy by construction rather than by two implementations agreeing" - is right, and
so is the underlying finding (`resolveReminderTarget:641-644` returns the group
route before the tenant read at `:647`, so the group path does zero contact
reads). What achieves the goal is a single **resolver** function that every one
of the four async scopes calls before composing, plus the composer taking
resolved names as parameters. The shared thing is the resolver, not the composer.

**What the spec must say.** Rewrite 6.3a around that: name one resolver in the
new module (section 6.1/6.2's `app/src/lib/tourContacts.ts`), state that it is
called in each of the four async scopes - `composeBodyForRow` for all three job
paths, and once per request above each preview's synchronous map - and that
`composeTourReminderBody` stays SYNCHRONOUS and takes the resolved names as
arguments. Delete the claim that the previews call `composeBodyForRow`. State
explicitly that no `await` may be introduced inside
`routes/relayGroups.ts`'s `.map()`, `bodyFor`, or `tourReminderBodyOrEmpty`,
because that is the shape a builder will otherwise reach for first.

## 2. [HIGH] Ruling (b) leaves a live Send-now button on the one rung whose copy
the founder cancelled, guarded only by an assertion that she will not press it

**What is wrong.** Section 2's ruling rests on this sentence:

> The founder asked for no confirmation text, and while the pause holds she gets
> none - nothing auto-sends, and force-send is a deliberate act she simply does
> not take on that rung.

That is a behavioural assumption standing in for a control. The affordance is
right there: `RemindersPanel.tsx:347` renders
`` aria-label={`Send ${kindLabel} reminder now`} `` for every pending rung, and
`e2e/support/selectors.md:72` documents that *"a bare `{ name: 'Send now' }`
matches one button PER pending rung"*. So `confirmation` gets a Send-now button
on every scheduled tour, identical to the four rungs she DOES want.

Two consequences the spec does not state:

1. **A misclick sends copy the founder explicitly asked to eliminate**, in its
   OLD un-rewritten wording (`Hey, your tour is set for {when} at {where}.` -
   `catalog.ts` `tour.confirmation`), to a real tenant, because section 2 also
   establishes force-send is the only live path in Phase A.
2. **Phase A's stated deliverable is undermined.** Section 2 says the sequencing
   "is what makes the copy reviewable before the POLL can reach anyone" - but the
   panel Sam reviews will contain a Confirmation rung she believes was deleted,
   showing wording she did not approve, sitting between rungs she did. That is a
   poor artifact to hand a founder for copy sign-off, and it invites exactly the
   "I thought we removed this" conversation.

Neither is fatal, and the ruling may well still be right on the harness
arithmetic. But the spec currently mitigates with an assumption rather than a
decision.

**What the spec must say.** Pick one and record it: (a) suppress or disable the
Send-now affordance for `confirmation` in Phase A - a small, contained dashboard
change; (b) accept the misclick risk explicitly, in writing, so it is a decision
rather than an oversight; or (c) give `confirmation` the copy pass after all so
that if it does go out, it goes out in approved wording. Also add one line to
section 2 telling whoever runs the copy review with Sam that this rung will
appear in the panel and why.

## 3. [HIGH] Section 9.5 misses the one Phase B consequence that ruling (b)
actually creates: a pending-`confirmation` BACKLOG that fires en masse at cutover

The coordinator asked whether 9.5's account of Phase B is complete. It is not,
and the gap is a direct cost of the ruling that created 9.5.

**The mechanism.** `confirmation`'s dueAt is `now` at arm time
(`jobs/tourReminders.ts:98`). Under the pause it is armed and never sent, so it
stays PENDING - `listDue` excludes only `sentAt`/`canceledAt`/`skippedAt`
(`tourRemindersRepo.ts:114-115`). Ruling (b) keeps arming it. **Therefore every
tour booked during Phase A accumulates a pending, already-past-due
`confirmation` row, and the backlog grows for as long as the pause holds.**

At the moment Phase B empties `MANUAL_ONLY_REMINDER_KINDS`, the very first poll
tick's `listDue(now)` returns all of them at once and they send.

Release supersession does not save this. It retires a rung only when a LATER
rung of the SAME tour is due in the same batch (`:707-713`); for a future tour
the day_before/morning_of/en_route rungs are not yet due, so each `confirmation`
sends alone.

The net effect is a mass send, to every tenant booked during the pause, of the
message class the founder specifically asked to eliminate, in its old wording -
on the same deploy that lifts the pause. Section 9.3 warns about in-flight rows
firing at cutover in general terms; 9.5 never connects it to `confirmation`,
which is the largest and most certain instance because those rows are past-due by
construction rather than by chance.

**What the spec must say.** Add to 9.5: Phase B must CANCEL all pending
`confirmation` rows in the same change that lifts the pause, not merely stop
arming new ones - and it must do so before or atomically with emptying the
manual-only set. Note in section 2 that the ruling deliberately trades a growing
cutover backlog for harness stability, so the trade is priced rather than
discovered. (If that cancellation is unattractive, it is an argument for
un-arming in Phase A after all - which is a decision worth re-opening on this
information, not on the harness argument alone.)

## 4. [HIGH] A FIFTH reminder-row writer, unenumerated: `seed/cast.ts` hardcodes
the OLD ladder times, and NO seed writes `sentBody`, so seeded history
recomposes from the new catalog

**What is wrong.** Section 13's non-test-surfaces list names
`documentation/tours-sequence-writeup.md:110`, `seed/matrix.ts:958`+`:930`,
`seed/live.ts`, and `selectors.md:72`. It does not name `seed/cast.ts`.

**Evidence** - `app/src/lib/seed/cast.ts:768-795`:

```
// Reminder rows: confirmation sent, day_before sent, morning_of sent (all history)
{ kind: 'confirmation', dueAt: CW,                          sentAt: CW },
{ kind: 'day_before',   dueAt: '2026-05-09T18:00:00.000Z',  sentAt: '2026-05-09T18:00:00.000Z' },
{ kind: 'morning_of',   dueAt: '2026-05-10T08:00:00.000Z',  sentAt: '2026-05-10T08:00:00.000Z' },
```

That makes **four** hardcoded statements of ladder timing outside `computeDueAt`
- `seedLive.test.ts:37`'s drift guard, `matrix.ts:958`, and these two - of which
the spec names two. `cast.ts` is byte-stable hand-authored seed data (its header:
"All dates are fixed past ISO strings", "byte-stable across reseeds"), and its
`morning_of` at `08:00Z` encodes the anchor this change removes.

**The larger half: no seed writes a body.** I grepped `sentBody` across
`app/src/lib/seed/` - **zero hits**. Every read surface prefers the snapshot only
when it is a string (`routes/tourReminders.ts:236`:
`if (row.sentAt !== undefined && typeof row.sentBody === 'string')`), so **every
seeded "sent" reminder row recomposes LIVE from the current catalog** on every
panel, timeline and thread read.

Three consequences:

1. Seeded history is retroactively rewritten - a May-2026 toured tour's
   "sent" rungs will render the new copy with the tenant's first name, which is
   not what was "sent".
2. More seriously, those rows are live consumers of the id derivation AND the new
   name resolution. If either throws for a seeded fixture, the failure is 9.1's
   `TypeError` shape - a 500 on the demo world's tour page, timeline and thread
   bucket, not a graceful degrade.
3. `cast.ts`'s tour must therefore resolve a property contact, and `matrix.ts`'s
   every-third-`pm_team` tour (`:930`) must resolve one too. Neither seed was
   written with that requirement in mind.

My round-2 report raised the `matrix.ts` half of this; only the `:958`/`:930`
half reached the spec. Ruling (b) makes it MORE relevant, not less, because
`confirmation` rows now stay live in both seeds.

**What the spec must say.** Add `app/src/lib/seed/cast.ts:768-795` to the
non-test surfaces list with its two stale dueAts. State that no seed writes
`sentBody`, so every seeded sent row recomposes from the new catalog and must be
covered by the 9.1 matrix reasoning - and that both seeds' tours need a
resolvable property contact or they will exercise the 6.3b absence fallback in
the demo world. UNVERIFIED: which test file pins `cast.ts`'s reminder dueAts
(`seedData.test.ts` / `seedPersonaDrift.test.ts` are the candidates).

## 5. [MEDIUM] The segment paragraph is internally inconsistent, and its worked
example is arithmetically wrong

Three problems in the patched paragraph, in a section whose entire purpose is to
establish a character budget.

**(a) The stated margin describes the gate the paragraph declares insufficient.**
The paragraph says the margin is "roughly NINETEEN CHARACTERS", then says the
gate as written composes with NO names and therefore measures the fallback, then
mandates composing with a 12-character name. Those cannot all stand: ~19 is the
no-name figure. Counting the template
(`Hey {tenantFirstName}, looking forward to having you tour at {time} today. Does that still work for you? Address is {where}.`)
its fixed characters total 94; with the gate's fixture values -
`there`(5) + `3:00 PM`(7) + the seeded address string
`350 Boulevard SE, Atlanta, GA 30312`(35) - that is 141, margin 19. **Exactly the
stated figure, which confirms it was measured against the no-name composition.**
Substituting a 12-character name gives 148 and a margin of **12**. Once the
mandated change lands, the headline number in the same paragraph is wrong.

**(b) The worked example is wrong.** *"'Hey Alejandra,' is nine characters longer
than 'Hey there,'"*. `Hey there,` is 10 characters; `Hey Alejandra,` is 14. The
difference is **four**, not nine.

**(c) UNVERIFIED:** I did not execute `analyzeSms`, so the 141/148 figures are my
character counts, not the tool's. GSM-7 septet counting may differ if any
character in the composed body is an extension-table character (none of the
literal copy is). The direction and the inconsistency hold regardless.

**What the spec must say.** Restate the margin against the composition it
mandates (~12 characters with a 12-character name and the seeded address), fix
the worked example to four, and mark whether the number is measured or counted.

## 6. [MEDIUM] The segment budget has TWO variable inputs and the spec pins only
one, so the gate proves the fixture passes rather than that production fits

Related to 5 but a separate decision. The margin depends on the first name AND
the street line, and section 4 keeps "legacy plain-string address cleanup" OUT of
scope - meaning `{where}` can be a whole address string (`formatStreet` on a
plain string; the gate's own fixture is the 35-character
`350 Boulevard SE, Atlanta, GA 30312`), not a street line. A longer legacy
address eats the budget faster than any plausible name.

Pinning a 12-character name against one fixed address is a point measurement
presented as a guarantee.

**What the spec should say.** State the budget as the invariant it actually is:
`len(firstName) + len(where) <= 160 - 94 - len(time)`, i.e. roughly 59 characters
shared between the name and the address line at a 7-character time. Then the
12-character assumption becomes one point on a stated constraint rather than the
constraint itself, and the next person editing copy can check their own case.

## 7. [LOW] The new precedence plus clamped storage puts a "booked too late" chip
on some rungs whose real cause is the clamp landing past the tour

Section 8.1 orders both new rules ahead of past-dueAt and past-event, and
section 8.2 now stores the CLAMPED dueAt. For a same-day tour at 08:00 booked at
05:00: rule 2 fires (`sameDay && 05:00 > 02:00`), so the rung is retired
`booked_too_late` with a clamped dueAt of 08:00 - which equals `scheduledAt`, the
condition `:270` calls `past_event`. Same situation, different chip, decided by
precedence order rather than by cause.

Defensible - they did book late - and section 11 already constrains the wording
not to accuse. Worth one clause in 8.1 noting the overlap so nobody later reads a
`booked_too_late` row with a start-time dueAt as a bug.

## 8. [LOW] Section 13's non-test list still omits the `matrix.ts` sent-row
recompose, which ruling (b) keeps live

Covered mechanically by finding 4; noting separately because it is a
half-landed round-2 correction rather than a new surface, and the fix is one
clause in an existing bullet.

---

# CONTESTING THE ADJUDICATIONS

Nothing from round 3's rulings looks wrong to me. Two I want to affirm on the
record because they corrected ME:

- **`booked_too_late` stores the CLAMPED dueAt - you were right and I was wrong.**
  I verified your basis: `next` is `reminderViews.find((v) => v.state === 'upcoming')`
  at `routes/tourReminders.ts:508`, so a skipped row can never supply it, and my
  r2 #8 justification was indeed half-false. Clamped also matches both
  neighbouring branches, which take `dueAt` from the clamped `dues` map
  (`jobs/tourReminders.ts:274-279`, `:298-303`). Consistency is the right tiebreak.
- **The inline empty-string guard is correct.** `nonEmpty` is not exported from
  `lib/rosterResolution.ts` - its exports are `rosterWaitExpired`,
  `resolveRoster`, `isOnRoster`, `describeRoster`, `rosterEquals`. Guarding
  inline rather than widening that module is right, and consistent with 6.2's own
  refusal to drive-by `contactName.ts`.

Also correct, checked: the 6.2 forward-reference now resolves to
`app/src/lib/tourContacts.ts` with the "reuse the RULE, not the location"
clarification; the D2 reversal is recorded as a dated ruling in section 3 with
the governing registry issue referenced; section 11's revival paragraph matches
`routes/tours.ts:1177-1182` (cancel + re-arm at `getNow()`); and 13.2's
`tour-no-show-checkin.spec.ts` addition is the fourth affected e2e spec, which I
had not found.

The two prior concessions stand: the "4 hours before" clamp objection stays
withdrawn, and the zero-primary DEFER stays conceded.

---

# CONVERGENCE

**Yes, it is converging - but not finished, and round 5 is warranted.**

The evidence for converging: round 1 produced five structural blockers about what
the document was FOR (paused ladder, ambiguous rules, missing skip reason,
unguarded derivation). Round 4 produces one blocker about a single named
mechanism inside an otherwise-correct ruling, plus consequences of a decision
taken two hours ago. The defect class has moved from "the design is wrong" to
"this paragraph names the wrong function", which is the expected shape of a
document closing in. Sections 7, 8.1, 9.0, 9.1, 9.2, 9.3, 10, 13.1 have now each
survived a dedicated adversarial pass.

**Would change what gets built:** findings 1 (the seam - a builder following
6.3a writes code that cannot compile at three call sites, then improvises), 2
(whether a Send-now button exists on `confirmation` in Phase A), 3 (whether Phase
B cancels the backlog, and possibly whether ruling (b) survives contact with
it), 4 (two seed files and a whole class of seeded rows nobody has accounted
for).

**Precision edits:** 5, 6, 7, 8. Real, cheap, would not change the shape of the
implementation.

The one thing I would watch: findings 2 and 3 are both consequences of a ruling
made THIS round, and neither was visible before it. That is the pattern the
round-3 note about wholesale rewrites identified - each decision opens a small
new surface. It argues for round 5 being narrow: re-review only what round 5
touches, rather than another full sweep, unless finding 3 reopens ruling (b).
