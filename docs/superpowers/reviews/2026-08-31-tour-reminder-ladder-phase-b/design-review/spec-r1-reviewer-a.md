# Spec R1 - adversarial design review (reviewer A)

Spec under review:
`docs/superpowers/specs/2026-08-31-tour-reminder-ladder-phase-b-design.md`
Repo state: `feat/tour-reminder-ladder-phase-b` @ `7fc744a8` (base `main` @ `ec32170a`).

Every claim below cites a file:line I opened. Anything I could not confirm is
marked UNVERIFIED.

---

## 1. [BLOCKING] `sendOneReminder` does not exist, and the names bound has TWO sites - the spec names one

**What is wrong.** Sections 6 and 7 both anchor their build on a function called
`sendOneReminder`:

- 6, point 2: "Fire-time backstop (`sendOneReminder`, the `isQuietTime(now, window)`
  branch)".
- 7: "`composeBodyForRow` raises `ReminderNamesUnavailableError` and
  `sendOneReminder` (`app/src/jobs/tourReminders.ts:1037-1043`) logs and returns
  WITHOUT claiming."

There is no such symbol anywhere in the repo. `grep -rn "sendOneReminder"` over
the whole tree returns zero hits.

The real shape is TWO send paths, and the unclaimed-return the section 7 bound
must replace exists in BOTH:

- `app/src/jobs/tourReminders.ts:1037-1043` - inside `processReminderRow`, the
  TENANT-1:1 path. This is the line range the spec cites.
- `app/src/jobs/tourReminders.ts:1210-1216` - inside `sendGroupReminder`, the
  GROUP path. The spec never mentions it. Its own comment is the ledger item
  the spec is discharging: "A PERMANENTLY failing read therefore re-lists every
  tick with NO self-clearing bound - accepted for Phase A ... it is item (7) of
  the Phase B ledger issue, which is what gets read at unpause."

**Why the missed site is the one that matters.** The only failure that reaches
`ReminderNamesUnavailableError` through the unit read is the Phase A carve-out,
documented at `app/src/jobs/tourReminders.ts:497-507` and `:665-671`: "on an
`en_route` rung of a NON-self_guided tour a THROWING unit read now BLOCKS the
send". A non-self_guided tour with a usable group routes to
`sendGroupReminder` (`resolveReminderTarget`, `:822-825`), never to
`processReminderRow`'s 1:1 tail. So the primary carrier of the unbounded
re-list is the site the spec does not cite. The spec's own section 12 reaches
the same conclusion from the other direction - "The ONE rung-differential mode
is `names_unavailable` on a landlord-led `en_route`" - and then points the fix
at the wrong function.

The quiet-hours fire-time backstop is likewise not in any `sendOneReminder`: it
is `processReminderRow`'s `if (isQuietTime(now, window))` at
`app/src/jobs/tourReminders.ts:910-916`. That one happens to cover both routes
(it runs above the `target.route === 'group'` return at `:937`), so section 6 is
buildable - but only if the builder finds it despite the name.

**Implies.** A builder following section 7 literally bounds the 1:1 path,
leaves the group path re-listing forever, and ships the exact defect the ledger
item exists to close. Section 7 must name `processReminderRow` and
`sendGroupReminder` explicitly and require the bound at both, the way section 6
already insists on "both sites" for quiet hours.

---

## 2. [HIGH] Section 4.3's safety net does not exist: the label test cannot fail on a new app-side token

**What is wrong.** Section 4.3 states: "The existing label-completeness test
(`dashboard/src/api/types.test.ts:119`) pins that the two maps agree, so a
missing label fails the build."

That is false in the direction the spec needs. `dashboard/src/api/types.test.ts:87-106`
defines `SKIP_REASONS` as a hand-copied array of plain strings, and its own
comment says why it cannot do what the spec claims:

> "Listed here as plain strings rather than imported or typed against the wire
> union so that the two hand-duplicated unions are checked against each other:
> the Record type already catches 'member added to the dashboard union, label
> missing', but nothing catches 'the app added a reason and the dashboard union
> was never touched' - which fails no build and degrades the chip to a
> reason-less 'Skipped'."

Adding `tour_already_passed` / `kind_retired` / `names_unavailable` to
`ReminderSkipReason` (`app/src/repos/tourRemindersRepo.ts:38-70`) fails nothing.

**The edit surface is also under-enumerated.** Section 4.3 names two sites. There
are four hand-maintained ones:

1. `app/src/repos/tourRemindersRepo.ts:38` - `ReminderSkipReason`.
2. `dashboard/src/api/types.ts:1207-1223` - the INLINE literal union on the
   dashboard's `TourReminderView.skipReason`. The spec never mentions it, yet
   the label map's key type is `Record<NonNullable<TourReminderView['skipReason']>, string>`
   (`dashboard/src/api/types.ts:1271-1273`), so adding a label without widening
   this union is a type error.
3. `dashboard/src/api/types.ts:1274-1284` - `REMINDER_SKIP_REASON_LABELS`.
4. `dashboard/src/api/types.test.ts:95-106` - `SKIP_REASONS`, which the
   "carries no label for a reason the app cannot send" assertion at `:119`
   compares against by exact key-set equality.

**Implies.** The spec is relying on a gate that is only half-armed, in the half
that does not cover this change. Sections 3 and 4.3 both lean on it: 3 argues
the pre-deploy window "degrades cleanly and resolves itself at deploy", which
is only true if the deploy actually carries the labels. The plan must list all
four sites explicitly and add the three tokens to `SKIP_REASONS` in the same
commit.

(The graceful-degradation half of section 3 IS correct:
`dashboard/src/routes/tours/RemindersPanel.tsx:102-109` looks the reason up and
falls back to a bare `Skipped` chip on an unknown token. Verified.)

---

## 3. [HIGH] The relay intro PREVIEW is an unenumerated surface - it will show the naked intro while the job sends the tour/placement one

**What is wrong.** Section 9.1 routes the three intro variants on the
conversation's owner and justifies it with "The intro job already holds the
conversation (`relayFanOut.ts:626`), so the routing is free." That citation is
correct (`app/src/jobs/relayFanOut.ts:626`). But the intro body has a SECOND
live composer, and the spec never mentions it.

`composeIntroBody` is called from exactly two production sites:

- `app/src/jobs/relayFanOut.ts:634` - the send (the site the spec covers).
- `app/src/services/rosterEdits.ts:473` - inside `buildOpenPreviewFromParts`,
  whose own docblock at `:450-453` says: "THE ONE implementation of 'what an
  open sends'. The tour, placement, and standalone preview routes all funnel
  through here so the body composition ... cannot drift."

That is the operator's pre-send preview. Left alone, opening a group on a tour
shows the operator the NAKED intro and then texts the TOUR intro. Existing
parity tests pin the current agreement and will need to be re-derived, not just
left alone: `app/test/relayGroupPreview.test.ts:151,208`,
`app/test/toursApi.test.ts:3998,4096`, `app/test/placementsApi.test.ts:989`.

**This breaks the spec's own escape hatch.** Section 9.5 rules that missing
inputs fall back to the naked intro and says the remedy is "the one Sam already
uses: the operator sees the preview and edits it". A preview that does not show
what will be sent cannot be that remedy - and 9.1's precedence rule 1
(operator-edited `intro_body` sends verbatim) means whatever the operator edits
is exactly what goes out, so a wrong preview is a wrong send.

**Same hole on `member_added`.** `composeMemberAddedBody` also has two callers:
`app/src/jobs/relayFanOut.ts:683` (send) and `app/src/services/rosterEdits.ts:673`
(`buildAddPreview`, whose docblock at `:657-659` explicitly claims "Parity with
the job"). Section 9.4 splits `member_added` into two bodies plus a no-role
variant and never says which of the three the add-preview shows, or whether the
"parity with the job" claim survives.

**Implies.** Section 9 must enumerate `rosterEdits.ts:473` and `:673` and decide
the preview contract, or the branch ships an operator-facing lie on the one
surface Sam is documented as using.

---

## 4. [HIGH] Section 3's ordering does not deliver its stated guarantee - the sweep-to-deploy window is unswept and unswept-able

**What is wrong.** Section 3 orders merge -> human sweep (dev, then prod) ->
human deploy, and closes: "The sweep is idempotent and conditional-write, so
re-running it after the deploy is safe and catches anything armed in between."

The mechanism does not catch them. Between the sweep and the deploy, PROD IS
STILL RUNNING THE OLD CODE, which still arms `confirmation`
(`REMINDER_KINDS`, `app/src/jobs/tourReminders.ts:235-240`) at a dueAt of the
arm instant (`computeDueAt` case `'confirmation'`, `:125-126`) - past-due from
birth, exactly as section 4.2 itself argues. Those rows are pending and due at
the moment the new code starts. The first post-deploy poll tick sends them. A
sweep re-run AFTER the deploy runs after the send, not before it.

So the ordering guarantees only that rows armed BEFORE the sweep do not burst.
Rows armed in the sweep-to-deploy window will send, and the number of them is a
function of how long the human takes between two manual steps.

**Implies.** Either the primary sweep must run AFTER the deploy (accepting the
burst risk in a shorter, code-controlled window), or the spec must state
plainly that any rung armed between the sweep and the deploy WILL fire on the
first tick, and say which kinds that reaches. As written, section 3 reads as a
proof of safety that its own steps do not establish - and section 3 is the
section whose entire purpose is "the part that texts people if it is wrong".

---

## 5. [HIGH] `overdue` is added to one of three surfaces that render a pending rung as "upcoming"

**What is wrong.** Section 8's justification is that a stuck rung "reads
'upcoming' with a dueAt weeks in the past, and nothing says so." Section 8.2
scopes the work by excluding `routes/placementNudges.ts`, and section 13 adds
nothing else. But two OTHER tour-reminder readers derive the same
pending-equals-upcoming presentation and will keep making the same promise
after the build:

- `app/src/routes/contactTimeline.ts:968-1030` - `gatherUpcoming` filters
  pending tour reminder rows and maps them into the first-page `upcoming[]`
  bucket as `TimelineScheduled` (`dashboard/src/api/types.ts:2418-2431`, which
  carries `suppression` but no state and no `overdue`).
- `app/src/routes/relayGroups.ts:266-342` - `GET /conversations/:id/scheduled`,
  the group thread's "Upcoming" bucket, same shape
  (`dashboard/src/api/types.ts:2448-2453`).

Both surfaces render the identical rung the tour page will now flag as overdue.
After this branch, the tour page says overdue and the contact timeline and the
group thread still say upcoming, for the same row, in the same session.

**A second view-build site inside the named file is also missed.** Section 8
says "set at the view-build site (`routes/tourReminders.ts:598-609`)". There
are TWO `TourReminderView` constructors in that file: the GET map at `:598-609`
and `viewOf` at `:336-349`, which builds the PATCH and send-now single-row
responses (returned to the client at `:393`, `:406`, `:460`, `:471`, and typed
as `TourReminderView` on the dashboard at
`dashboard/src/api/endpoints.ts:2537,2558`). With `overdue` omitted-when-false,
`viewOf` would report every overdue rung as not-overdue. The panel happens to
mask this today because both handlers call `fetchNow()` afterwards
(`dashboard/src/routes/tours/RemindersPanel.tsx:254-256,281-283`), but the wire
contract would be inconsistent and a future consumer or test hits it.

**Minor mechanical detail in the same section.** The proposed expression
`state === 'upcoming' && row.dueAt < nowIso` uses `nowIso`, which at `:598-609`
is not in scope: it is declared at `routes/tourReminders.ts:529`, inside the
`if (tour.tourType === 'self_guided' && hasUpcoming)` block. It has to be
hoisted.

(The two `'upcoming'` equality predicates section 8.1 names ARE correct:
`hasUpcoming` at `routes/tourReminders.ts:497` and the next-rung pick at `:616`.
The argument for an additive boolean over a fifth state value stands.)

---

## 6. [MEDIUM] Section 6.1 understates the exemption: there is no floor on when an exempt `en_route` fires

**What is wrong.** Section 6 removes the arm-time clamp AND the fire-time
deferral for `en_route`. Section 6.1 then describes the founder-visible
consequence as exactly one case: "an 8am tour now gets its 7am `en_route`."

The mechanism is unbounded, not scoped to 8am. `computeDueAt`'s `en_route` case
(`app/src/jobs/tourReminders.ts:145-152`) is `scheduledAt - 1h` for ANY tour
hour, and with both guards removed nothing else constrains it. A 04:00 tour
sends at 03:00. Quiet hours was the only mechanism that had ever prevented an
overnight tour reminder, and this change removes it for this rung at both ends.
Whether an 04:00 tour is realistic is beside the point - a timezone error or a
mis-entered date makes it reachable, and the spec's handback item 1 tells the
founder a narrower story than the code will do.

**Second, unstated consequence.** Clamping only ever moves a dueAt LATER
(`clampOutOfQuietHours`). Un-clamping therefore makes `en_route` land EARLIER
and so more likely to trip the one SILENT arm-time retirement,
`if (dueAt < now)` at `app/src/jobs/tourReminders.ts:390-393` - a booking made
inside the last hour before the tour now arms `en_route` nowhere and leaves no
row. Section 6.2 reasons carefully about `past_event` and `staleDayBefore` and
never mentions this one, even though the module header at `:10-13` calls out
`en_route` by name as the rung that silent drop is reachable for.

**Implies.** Section 6.1 should state the actual rule ("`en_route` fires one
hour before the tour, whatever the hour, with no quiet-hours protection at
either end") and section 6.2 should say whether the increased silent-drop rate
is accepted.

---

## 7. [MEDIUM] Section 10's "the sites convert mechanically" is contradicted by the specs it names

**What is wrong.** Section 10 argues no new dev seam is needed and that the ~14
e2e sites "convert mechanically" onto
`tickTourReminders(justAfter(await armedReminderDueAt(kind)))`. The helper does
exist and works as described (`e2e/scenarios/steps.ts:2019-2046`). But several
of the named sites depend on `confirmation`'s SEMANTICS, not on its
immediate-send convenience:

- `e2e/tests/tour-roster.spec.ts:488-501`: "`confirmation` rung's dueAt is the
  server's ARM-TIME instant", then `if (confirmation === undefined) throw new
  Error('the booking armed no confirmation rung')`.
- `e2e/tests/scenarios/scheduled-visibility.spec.ts:234-259`: the reschedule
  case asserts "the fresh confirmation's dueAt is the re-arm instant, i.e. now,
  which beats every other fresh rung ... so confirmation is still the NEXT
  rung", and then that the re-armed body is "textually DISTINCT" from the
  first. Both facts die with the kind.

Worse, the obvious substitute rungs are not always armable. For a tour booked
close to its time, `day_before` and a same-day `morning_of` are retired
`booked_too_late` at `app/src/jobs/tourReminders.ts:368-374`, and `en_route` can
fall to the silent `dueAt < now` drop at `:390`. `armedReminderDueAt` throws
when no upcoming rung of the requested kind exists
(`e2e/scenarios/steps.ts:2026-2029`), so a spec whose tour is booked minutes
out has no vehicle at all until its `scheduledAt` is re-chosen.

**Implies.** The conversion is design work per spec, not a sed pass. The plan
should budget it and the spec should drop the word "mechanically"; its escape
valve ("If a spec genuinely cannot be made deterministic this way, RAISE IT")
is good but is currently framed as an unlikely exception rather than the
expected case for at least two named specs.

The two supporting claims in section 10 that I checked ARE correct: the repo's
`create` does not drop a past-due row (`app/src/repos/tourRemindersRepo.ts:174-197`
writes the item unconditionally), and the dev tick's DELIBERATE DIVERGENCE
comment says what the spec quotes (`app/src/routes/dev.ts:404-421`).

---

## 8. [MEDIUM] Section 9.2 deletes a branch without giving `{names}` a value for it

**What is wrong.** `composeConnectionSentence`
(`app/src/jobs/relayFanOut.ts:189-207`) has three branches: a named list, a
neutral count (`2 other people` / `1 other person`) when no member has a name,
and a degenerate `others === 0` branch that RESTRUCTURES the sentence to
"You're now connected on this number."

Section 9.2 turns the function into a name-list builder, maps the middle branch
onto the noun phrase, and then says of the third: "The degenerate zero-others
case ... is dropped - a relay group with no other members is not a group."

"Dropped" is not a value. `{names}` is a declared token on a non-editable entry
and must resolve to a string on every call. The preview builder
(`rosterEdits.ts:473`, via `buildOpenPreviewFromParts`) composes from the roster
the operator is CURRENTLY assembling, so a one-member, unnamed roster is
reachable there even if it can never be created. `resolveMessage` in strict mode
throws on a declared token with no value (`app/src/messages/resolve.ts:36-38`),
which would 500 the preview route.

**Implies.** Section 9.2 must state what `{names}` resolves to when
`others === 0`, or state that the composer's callers guarantee it cannot happen
and name the guard.

---

## 9. [MEDIUM] Section 9.6's per-member selector has an unenumerated mode: `persist: false`

**What is wrong.** Section 9.6 designs the change as "`sendRelayAnnouncement`
takes an optional per-member body selector alongside `body`; `body` remains what
is persisted and previewed." That describes the persist path only.

`sendRelayAnnouncement` also runs in a leg-only mode. `persist === false` is
threaded from the relay intro job (`app/src/jobs/relayFanOut.ts:657`) and
short-circuits the whole persist block (`app/src/services/relayAnnouncements.ts:188-227`),
substituting a per-leg `putSystemSidMarker` at `:256-270` so DLRs do not alarm.
In that mode there is no row at all, so "the persisted body is the NEW MEMBER's
copy" has no referent, and the spec says nothing about it.

Separately, 9.6 asserts "The default (no selector) is byte-identical to today's
behaviour, so every existing caller - tour reminders included - is unaffected."
That is achievable but load-bearing and untested by the spec's own section 14:
the selector must apply ONLY inside the roster loop at
`app/src/services/relayAnnouncements.ts:230-265` and NOT to `messagesRepo.append`
(`:203-217`) or `touchLastActivity` (`:211-215`). Section 14 asks for a test that
one row is persisted; it does not ask for a test that the tour-reminder group
route's bytes are unchanged.

**Implies.** Name the `persist: false` behaviour, and add the byte-identity
regression for the no-selector default to section 14.

---

## 10. [LOW] Citation drift that will cost a builder time

Each of these points at a real thing but at the wrong line, or names a symbol
loosely. None changes a decision; all of them cost a reader a search.

- Section 8: "`app/src/routes/tourReminders.ts:143`" for `stateOf`. `:143` is the
  `state` FIELD declaration on `TourReminderView`; `stateOf` is at `:157-162`.
- Section 8.1: "its dashboard twin at `dashboard/src/api/types.ts:1196`". The
  interface opens at `:1191`.
- Section 11: "`interpolate` (`app/src/messages/resolve.ts:30-44`)". The function
  is `:24-45`; its substitution loop is `:31-43`.
- Section 3: "`RemindersPanel.tsx:107`". The fallback ternary is at `:106-109`;
  the lookup is `:102-103`. Behaviour as described is correct.

---

## 11. [LOW] Section 7.1's "guarded at the door" is narrower than stated

Section 7.1 supports "Absence never throws" with "the empty-string key case is
guarded at the door (`routes/tours.ts:315` rejects an empty `unitId`)". That
guard is real - `app/src/routes/tours.ts:314-318` rejects a missing or empty
`unitId` on `POST /api/tours`. But it is one create route. I did not verify that
every writer of `tour.unitId` (reschedule/PATCH paths, the seeds, the import) is
covered; UNVERIFIED.

This does not change the section's conclusion - and after the section 7 bound
lands, a genuinely poisoned row self-clears in an hour anyway, which is the
better argument. But "guarded at the door" as stated is a claim about all
writers and only one was cited.

---

## Claims I checked that HOLD

Recorded so the next reviewer does not re-derive them.

- Section 4.2's two-population correction is right: `REMINDER_KINDS`
  (`app/src/jobs/tourReminders.ts:235-240`) governs arming only, and the poll
  filters `listDue` output on `manualOnlyKinds` at `:602-603`, so dropping
  `confirmation` from `REMINDER_KINDS` does nothing to existing rows.
- The manual-only rows really are LEFT PENDING, not claim-skipped
  (`app/src/jobs/tourReminders.ts:589-603` and the comment above it), so
  section 4.1's burst risk is real.
- `past_event`'s existing meaning is what 4.3 says it is
  (`app/src/repos/tourRemindersRepo.ts:48-51`, label at
  `dashboard/src/api/types.ts:1279`), so refusing to reuse it is correct.
- `ROSTER_UNAVAILABLE_GRACE_MS` is one hour and its rationale is the one section
  7.2 mirrors (`app/src/lib/rosterResolution.ts:100`, `rosterWaitExpired` at
  `:107-113`).
- `names_unavailable` already exists in the force-send refusal union
  (`app/src/jobs/tourReminders.ts:1328`), and the force-send path leaves the row
  pending rather than retiring it (`:1478-1480`), so 7.2's "force-send path is
  unchanged" is consistent with the code.
- `getOwner` returns what 9.1 says, with the legacy `placementId` fallback
  (`app/src/repos/conversationsRepo.ts:385-401`), and tour relay groups do carry
  `owner: { type: 'tour', id }` (`app/src/services/rosterProvision.ts:356`).
- Operator-edited `intro_body` wins verbatim (9.1 precedence 1):
  `app/src/jobs/relayFanOut.ts:633-640`. The dashboard omits the field entirely
  when the preview is untouched (`dashboard/src/api/endpoints.ts:414-417`), so
  precedence rule 1 does not accidentally swallow every group.
- 9.4's role source is correct: `UnitContact.role` is
  `'landlord' | 'pm' | 'owner' | 'other'` (`app/src/repos/unitsRepo.ts:68-75`).
- 9.7 is correct on both counts: `relay.group_closed` is gated off by
  `RELAY_CLOSE_ANNOUNCEMENT_ENABLED = false`
  (`app/src/routes/relayGroups.ts:88-105`, used at `:591`), and all four
  placement nudge kinds are manual-only
  (`app/src/jobs/placementNudges.ts:123-128`).
- 9.3's reuse targets exist with the described behaviour: `formatStreet` is
  street-only for structured addresses and verbatim for a legacy string
  (`app/src/lib/address.ts:90-104`); `formatLocalDate` / `formatLocalTime` are at
  `app/src/lib/localTime.ts:55,60`; `inertName` brace-strips names
  (`app/src/lib/tourContacts.ts:30-66`).
- Section 11's three preserved behaviours are exactly what `interpolate` does
  today: undeclared tokens are untouched (the `allowed` loop,
  `app/src/messages/resolve.ts:31`), a declared-and-present-but-unsupplied token
  throws under `strict` and blanks otherwise (`:34-41`), and a declared token
  absent from the template is skipped (`:33`). The strict split is driven from
  `resolveMessage` at `:64`. The live re-expansion vector on
  `relay.member_added` is real: `vars: ['joined', 'members']`
  (`app/src/messages/catalog.ts:299-302`), both fed from contact display names
  (`app/src/jobs/relayFanOut.ts:238-249`).
- Section 4.4's precedents exist: five `backfill-*.ts` scripts in `app/scripts/`,
  including `backfill-relay-optout-flag.ts`. `lib/config.tableName` is real
  (`app/src/lib/config.ts:512`). `listDue` paginates fully
  (`app/src/repos/tourRemindersRepo.ts:211-246`), so a sweep built on it will not
  silently under-sweep.
- Merge is genuinely not deploy: `scripts/deploy.mjs` is a separate script.
