# Round 3 adversarial review - tour reminder ladder spec

Reviewer A, continued (rounds 1 and 2). Target: the PATCHED spec at
`docs/superpowers/specs/2026-08-26-tour-reminder-ladder-design.md` (commit
`6a9eb842`), read against `docs/superpowers/reviews/2026-08-26-tour-reminder-ladder-adjudications.md`
and both plan-reviewer reports.

Every existing-behaviour claim cites a file:line I opened this session.
UNVERIFIED is marked where I could not check.

---

# NEW FINDINGS

## 1. [BLOCKING] Section 6.3 splits the send paths on the WRONG AXIS. The group
path composes the landlord-led copy and performs ZERO contact reads today

**What is wrong.** Section 6.3 was patched in round 2 to say "TWO SEND PATHS, NOT
ONE. The poll is one; `forceSendReminder` is the other." That is the wrong
division. Poll and force-send share a composer call; what actually differs is
**1:1 versus GROUP**, and the group path is the one this change breaks hardest.

**Evidence.**

- `resolveReminderTarget` returns on the GROUP branch at
  `jobs/tourReminders.ts:641-644` - before the tenant contact is ever read. The
  `contactsRepo.getById(tour.tenantId)` at `:647` is on the 1:1 branch only.
- `sendGroupReminder` then calls `composeBodyForRow` at `:1006`, whose entire
  dependency surface is `Pick<RunDueTourRemindersDeps, 'unitsRepo'>`
  (`:536`) - **one unit read, zero contact reads.**
- `announceGroupReminder` (`:1060-1085`) does read contacts, but inside
  `sendRelayAnnouncement`, POST-claim, for member fan-out - unavailable to the
  composer and on the wrong side of the claim.
- Routing: `landlord_led` and `pm_team` tours go to the group thread
  (`:641`, restated in the restored section 9.0).

**Why this is decision-changing.** The `tour.en_route_landlord_led` copy is the
only entry needing BOTH names, and by section 9.0's own routing table it is
composed on the path that currently reads neither. So the group path needs two
NEW pre-claim contact reads that do not exist, each with its own absence and
read-failure semantics - and section 6.3's rules are written entirely in the
vocabulary of the 1:1 path ("the existing `roster_unavailable` idiom", which is a
1:1-only gate at `:795`, reached only after the group branch has returned).

A builder following 6.3 literally will add the reads to `composeBodyForRow` and
inherit its containment: `composeBodyForRow` is documented as "Total EXCEPT for
`UncomposableReminderError`" (`:527-531`), and both call sites catch only that
(`:848`, `:1008`). A throwing contacts read from inside it escapes to the per-row
catch at `:493` - the rung is never claimed and re-lists every tick forever,
which is the exact failure `claimSkip` exists to prevent and which section 9.1
already names for a different cause.

**What the spec must say.** Replace 6.3's "two send paths" framing with the real
matrix: {1:1, group} x {poll, force-send}. State that the group path has no
tenant or property-contact read today and that adding them is new PRE-CLAIM I/O
inside or above `composeBodyForRow`; state which function owns the reads; and
state that a throwing read must NOT propagate out of `composeBodyForRow`, because
its two callers' containment is `UncomposableReminderError`-only by design.

## 2. [BLOCKING] The governing registry issue is unreferenced, and it records the
`no_show_checkin` token as an UNRULED PRODUCT DECISION this spec reverses in passing

**What is wrong.** `docs/issues/founder-message-template-updates-owed.md` is the
Tier-2 registry entry for exactly this work - title "Founder's message-template
rewrite (2026-08) - items that could not be applied as text-only edits", `refs:`
includes `app/src/messages/tourCopy.ts`, status `open`. Its **item 3 is this
branch's scope verbatim**: `{tenant first name}` / `{landlord}` needing composer
plumbing, the no-address twins, and `no_show_checkin`.

The spec never references it. It cites only
`tourcopy-messageid-cast-unguarded` (line 449) and
`consolidate-contact-display-name-helpers` (lines 194, 203).

**The substantive part.** That issue says, of the founder's `no_show_checkin`
rewrite:

> `tour.no_show_checkin` is deliberately token-free today ("when you are not
> certain someone no-showed, vaguer wording is kinder" - spec D2); her rewrite
> adds a name, which is **a product call to revisit D2, not just a wiring gap**.

The spec's section 5 table adds `{tenantFirstName}` to `tour.no_show_checkin`,
and section 9.2 treats the consequence as pure plumbing ("it has two throw
sites"). The only acknowledgement of the reversal is a subordinate clause at
line 472 - *"on the justification 'token-free by design (spec D2)' - a
justification section 5 revokes"* - inside a paragraph about a test whitelist.

Every other founder-facing reversal in this document carries a dated ruling
("RULED (Cameron, 2026-08-26)", "DECIDED:", "(Cameron, 2026-08-26)"). **This one
carries none**, and the repo's own record says it is a product call rather than a
wiring gap. `tourCopy.ts:51` still states D2 as live design intent.

**Also in that issue and unaddressed:** it names a companion document sent BACK
to the founder - `HousingChoice-Message-Templates-Available-Tokens.md`, "lists
exactly which tokens ARE live for each tour-reminder slot today so she can
resubmit within that constraint". It is **not in the repo** (I searched; the only
hit is the issue's own mention), so it lives with the founder. This change adds
four tokens and removes a rung, which invalidates it. She will draft her next
revision against a stale token list - the same wording-and-plumbing split section
1 says this pass exists to end.

And its "Suggested fix (b)" proposes token names `firstName` /
`landlordFirstName` "(names TBD)". The spec picks different names and never
records the choice against the issue.

**What the spec must say.** Reference `founder-message-template-updates-owed` by
slug. State which of its four categories this branch closes (item 3, partially)
and which it explicitly leaves open (items 1, 2, 4 - consistent with section 4's
OUT list). Carry a dated ruling revoking D2 for `no_show_checkin`, in section 5
where the token is introduced, not as a clause in 9.2 - and update the comment at
`tourCopy.ts:51` in the same change. Add an obligation to reissue the founder's
available-tokens document.

## 3. [HIGH] The "Morning of" relabel breaks two INTERPOLATED accessible-name
sentences, one of which is a pinned contract

**What is wrong.** Section 11 rules the label changes from `Morning of` to
`4 hours before`. Nobody has checked what the label is interpolated INTO.

**Evidence** - `dashboard/src/routes/tours/RemindersPanel.tsx`:

- `:310` `const kindLabel = REMINDER_KIND_LABELS[rung.kind] ?? rung.kind;`
- `:347` `` aria-label={`Send ${kindLabel} reminder now`} ``
- `:358` `` aria-label={`${rung.state === 'upcoming' ? 'Cancel' : 'Restore'} ${kindLabel} reminder`} ``

With the ruled label those render **"Send 4 hours before reminder now"** and
**"Cancel 4 hours before reminder"**. Both are broken English - the existing
labels are all noun phrases ("Confirmation", "Day before", "En route"), which is
what makes the template read.

And `:347` is a **pinned contract**, spelled out with its enumerated label list
in `e2e/support/selectors.md:72`:

> `getByRole('button', { name: 'Send <Kind label> reminder now' })` - e.g.
> `Send Day before reminder now` (kind labels: Confirmation, Day before, Morning
> of, En route, No-show check-in). A bare `{ name: 'Send now' }` matches one
> button PER pending rung and substring-collides with the contact page's
> "+ Send": a strict-mode violation.

Section 13 does list `selectors.md:72` as a surface to update - good - but frames
it as "pins the Send-now accessible-name contract, which lists 'Morning of'",
i.e. as a list to edit. The actual problem is that the chosen label does not FIT
the template, and that the same list must also lose `Confirmation`.

**Note this is NOT a re-litigation of the rejected clamp argument.** I concede
that one (see below). This is a grammar-and-contract problem in a different file.

**What the spec must say.** Pick a noun-phrase label that survives both
templates - `4-hour reminder` gives "Send 4-hour reminder reminder now", so it
does not; `Four hours out` gives "Send Four hours out reminder now", which also
does not. Realistically either the templates gain a separate short name per kind,
or the label stays a positional noun phrase. State the decision, show both
rendered aria-labels in the spec, and update `selectors.md:72`'s enumerated list
for BOTH the relabel and the removal of `Confirmation`.

## 4. [HIGH] The new force-send refusal token has three readers; the spec names
none of them, and the one that matters degrades silently

**What is wrong.** Section 6.3's patch says force-send "returns a REFUSAL the
route can render... That refusal needs a representable outcome on
`ForceSendResult` and a reason token - neither exists today". Correct, and good
catch. But it stops at the union and never follows the token to its readers.

**Evidence - the token reaches staff copy verbatim.**

- The union: `ForceSendRefusal` at `jobs/tourReminders.ts:1098`.
- The route passes the reason RAW onto the wire:
  `routes/tourReminders.ts:394` - `const error = result.outcome === 'not_pending' ? 'reminder_not_pending' : result.reason;`
- The dashboard maps it to staff copy: `SEND_NOW_ERROR_COPY` at
  `dashboard/src/api/types.ts:1284`, consumed by `sendNowErrorMessage()` at
  `:1321`.

Two properties nobody has stated:

1. `SEND_NOW_ERROR_COPY` is `Readonly<Record<string, string>>` - a **loose string
   key**, unlike `REMINDER_SKIP_REASON_LABELS` at `:1262` which is
   `Record<NonNullable<TourReminderView['skipReason']>, string>` and therefore
   compile-linked. So the new refusal token produces **no type error anywhere**
   and falls through to the generic sentence at `:1322`,
   `"Couldn't send that just now - please try again."` This is the same
   silent-degradation shape as finding r2 #7, in a second map, and 8.2's patched
   warning does not cover it.
2. That map's docblock (`:1280`) already records the precedent for exactly this
   semantics: `roster_unavailable` **deliberately has no entry** -
   *"the generic retry sentence is exactly right for a transient failure"*
   (`:1305-1308`). A contacts-read failure is the same category.
3. The map is shared: `:1280` says *"Codes are shared by the reminder and nudge
   routes except where noted"*, and `dashboard/src/api/types.test.ts:2,79` tests
   it. So a tour-side addition lands in a map the placement-nudge route also
   reads.

**What the spec must say.** Name the token. State the three readers
(`ForceSendRefusal`, the raw pass-through at `routes/tourReminders.ts:394`, and
`SEND_NOW_ERROR_COPY`). Decide explicitly whether it gets its own copy line or
deliberately takes the generic fallback **following the documented
`roster_unavailable` precedent** - and if the latter, say so in a comment beside
the union so the next reader does not "fix" the omission. Note that the copy map
is string-keyed, so nothing catches a miss.

## 5. [MEDIUM] Section 6.2's patch forward-references a module section 6.1 does
not define, and 6.1's heading says the opposite

**A patch-shaped defect, exactly the class the coordinator flagged.** Section 6.2
was rewritten to say:

> So: put the first-name helper next to its consumer, in the new tour-contacts
> module (section 6.1), NOT in `contactName.ts`.

I read section 6.1 in full (spec lines 152-180). It contains a resolver
expression, a `nonEmpty` warning, a "do not read the scalar" instruction, and the
two-fallback-cases note. **It does not mention a module, new or otherwise.** Its
heading is `### 6.1 Resolving the property contact - REUSE, do not reimplement`,
which reads as an instruction to inline the established expression rather than to
create anything.

The module does exist - in the PLAN: `app/src/lib/tourContacts.ts`
(`plans/2026-08-26-tour-reminder-ladder.md:50`, `:188`, `:239`, `:246`). So the
work is covered. But the spec is the document a cold builder reads for intent,
and 6.2's patch was written against a section 6.1 that the patch author appears to
have expected to be amended in the same pass and was not.

**What the spec must say.** One sentence in 6.1 naming
`app/src/lib/tourContacts.ts` as the new home for both resolutions, and an
adjusted heading (`REUSE the resolver, in one new module`) so 6.1 and 6.2 stop
contradicting each other on whether anything is created.

## 6. [MEDIUM] `tours-sequence-writeup.md` is already TWO revisions stale, so the
line edit section 13 implies will leave two lies standing

**What is wrong.** Section 13's new non-test-surfaces list says
*"`documentation/tours-sequence-writeup.md:110` states the ladder verbatim"* -
which implies it currently agrees with the code and needs one row changed.

It does not. I read `documentation/tours-sequence-writeup.md:108-114`:

| Rung | When it fires (as documented) | Actual today |
| --- | --- | --- |
| `confirmation` | immediately, at booking | armed but never sent (manual-only, `tourReminders.ts:163`) |
| `day_before` | 24h before | 24h before - correct today, changes to 19:30 |
| `morning_of` | **08:00 UTC on the tour day** | 08:00 ORG-LOCAL (`tourReminders.ts:102-108`); 08:00 UTC was the 4am-text bug fixed 2026-08-03 |
| `en_route` | **2h before** | 1h before (`tourReminders.ts:114`, founder decision 2026-08-18) |
| `no_show_checkin` | 30m after | correct, but never auto-armed (`:197`) |

So the table is wrong on two rows BEFORE this change, and a builder who edits
only the `day_before` row - which is what "states the ladder verbatim" invites -
leaves the resurrected 4am-UTC bug documented as current behaviour.

**What the spec must say.** That the table is two revisions stale (08:00 UTC and
2h `en_route` are both already wrong) and needs a full rewrite of all five rows
plus the manual-only pause, not a one-row edit. Cheap to say, and it converts a
five-minute edit into a correct one.

## 7. [MEDIUM] Settling the DEFERRED absence-reachability question with the code
in hand - the answer is asymmetric and changes what the fixture must be

The adjudication deferred this ("marked 'may be', cheaper to settle with the code
in front of you"). I have the code in front of me. Settled:

**On the 1:1 poll path, genuine ABSENCE of the tenant contact is UNREACHABLE at
compose time.** `resolveReminderTarget` reads the tenant at
`jobs/tourReminders.ts:647`, and a missing contact returns
`{ unresolvable: 'contact_missing' }` at `:653`, which `processReminderRow`
claim-skips at `:742-753` - **before** composition is reached at `:846`. Same on
force-send: the refusal at `:1172-1179` precedes the compose at `:1224`.

So section 6.3's tenant-name absence fallback ("pass `there`") can only be
exercised on the 1:1 path by a contact that **exists and has no usable name** -
never by an absent one. A test fixture built around a missing contact will assert
`contact_missing` and prove nothing about the fallback.

**On the GROUP path it IS reachable**, because per finding 1 no tenant read
happens at all, so whatever read the builder adds owns both the absence and the
failure case with nothing upstream to pre-empt it.

**The property contact is reachable on both paths** - nothing anywhere pre-checks
it.

**What the spec should say.** Add one line to 6.3: the tenant-absence fallback is
reachable only on the group path and via nameless-but-present contacts on the
1:1 path; `contact_missing` pre-empts it elsewhere. Then section 13's owed
"read-failure vs absence" test can be written against reachable states instead of
discovering this at build time.

## 8. [LOW] Section 7 adds a second org-timezone anchor without citing the OPEN
issue that says org-timezone anchoring already texts wrong times

**What is wrong.** Section 7: *"We hold a single org-level timezone; per-property
is future work."* There is a filed, OPEN, `med` issue for exactly this -
`docs/issues/tour-times-assume-org-timezone.md`, created 2026-08-06, `refs:`
includes `app/src/messages/tourCopy.ts`, with a named failure story (Alabama
property, Atlanta org, "3:00 PM" quoted wrong). The spec does not cite it.

Worth noting the change's effect is MIXED, which is itself uncaptured: the new
`morning_of` (`scheduledAt - 4h`) is a pure offset and is **immune** to the zone
bug, where the old 08:00-org-local rung was not; the new 19:30 `day_before`
**adds** an anchor. Net, one anchor traded for another.

**What the spec should say.** Cite the slug in section 7 instead of re-describing
the constraint, and note the anchor trade in one clause. Per AGENTS.md, a
registry item is referenced inline rather than re-derived.

---

# CONTESTING THE ADJUDICATIONS

## The REJECT - CONCEDED

**"The '4 hours before' label is falsified by clamping" (r2 #12).** Your reject
holds and I withdraw it. Two reasons, both checkable: every rung label is nominal
under clamping - "Day before" has carried the same property since the clamp
landed - and `RemindersPanel.tsx:120` renders the relative FIRE time from the
stored dueAt beside the label, so the operator reads the real instant. A
clamp-aware label would be less legible and no more honest. Your distinction is
also right: "Morning of" was wrong at every setting, not only under a clamp.

Finding 3 above is a different objection to the same relabel - the label is
interpolated into two aria-label sentences and does not fit them grammatically -
and should be adjudicated on its own terms.

## DEFER 1 (zero-primary e2e coverage) - CONCEDED, with one addition

Correct to defer. AGENTS.md makes `lean` the byte-stable e2e world, and changing
a shared fixture to reach a `LOW` coverage gap is its own change. The owed unit
test is an adequate guard.

One thing worth putting in the registry note so the deferred test is writable
later: the zero-primary state is only reachable for a unit with a **non-empty**
`contacts[]` and no row flagged - because `unitContacts` (`unitsRepo.ts:288-302`)
synthesises `primaryContact: true` whenever it falls back to `landlordId`. Naming
the producer (roster edits that demote the last primary, `unitsRepo.ts:794-809`)
saves the next person the derivation.

## DEFER 2 (absence reachability) - SETTLED, see finding 7

You invited settling it with code in hand; it is settled above and the answer is
not "may be" but a clean asymmetry that changes the fixture. I would fold finding
7 into 6.3 now rather than carry the defer, because the cost is one sentence and
the cost of not doing it is a test that passes without exercising the feature -
the same shape as the Task 8 already-green defect this round caught.

---

# PATCH REVIEW - what is CORRECT, briefly

I checked each patched claim against the code rather than against the prose.

- **Section 9.0 (restored routing).** Correct and complete. `TOUR_TYPES` is
  three-valued at `toursModel.ts:92` (the spec says `:93`, off by one - the
  comment above it at `:90-91` independently states "reminder ROUTING branches on
  self_guided", which corroborates the ruling). The
  "branch on `=== 'self_guided'`, never enumerate `landlord_led` alone"
  instruction matches every existing site: `jobs/tourReminders.ts:641`, `:771`,
  and the comments at `worker.ts:334`, `routes/tourReminders.ts:35`, `:473`,
  `routes/relayGroups.ts:186` all treat the pair as one bucket. **No other
  section still assumes two tour types** - I grepped the whole spec for
  `pm_team`, `landlord_led` and `two buckets`; 9.0 is the only mapping and
  nothing contradicts it.
- **Section 8.1's four-rule precedence** is correct against the arm loop. The
  order it asserts - booked-too-late, past-dueAt (`:266`), past-event (`:270`),
  supersession/`staleDayBefore` (`:287-296`) - is the loop's actual order with the
  new rules inserted at the top, and "each for its own rung only" is the right
  scoping: `staleDayBefore` is already `kind === 'day_before'`-guarded at `:295`,
  and past-event/supersession must stay live for `en_route`, which neither new
  rule touches. The polarity-inversion callout at `tourReminders.test.ts:1211`,
  `:356`, `:397` matches what I read there.
- **Section 5's segment claim.** Verified: `tourCopy.test.ts:112-118` asserts
  `analyzeSms(body).segments === 1` for four kinds composed with the real seeded
  string address. My own arithmetic on the new `tour.morning_of` copy against
  that fixture lands near 139 characters, so the stated ~19-character margin is
  consistent (I did not execute `analyzeSms`, so the exact figure is UNVERIFIED).
- **Section 13.1's affected-spec list is exactly right.** I grepped
  `times.dayBefore` across `e2e/`: `quiet-hours.spec.ts:293,318`,
  `scheduled-visibility.spec.ts:163,228`, `tours.spec.ts:134`, plus the struct at
  `steps.ts:215` and its construction at `:275`. Five drive sites, no more. The
  `morningOf`-in / `dayBefore`-out inversion is the right call.
- **Section 6.1's `nonEmpty` restoration** matches both cited sites -
  `rosterProvision.ts:233-234` and `rosterResolution.ts:275`.
- **Section 12's correction** now agrees with 7.3. The contradiction is closed.
- **Section 2's force-send paragraph** is the right correction and lands the
  point I raised - `forceSendReminder` (`:1156`) sends with `automated: false` to
  a real recipient.
- **Section 8.2's nine-token count** is right; `invalid_schedule` is the ninth at
  `tourRemindersRepo.ts:36`ff, stamped at `jobs/tourReminders.ts:853`, labelled at
  `dashboard/src/api/types.ts:1272`.
- **`relayAnnouncements` removal** from the will-break list is correct;
  `:60-72` uses a literal body and a rung-derived tag.
