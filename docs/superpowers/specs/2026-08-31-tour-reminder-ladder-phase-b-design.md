# Tour reminder ladder Phase B + relay group templates - design

Date: 2026-08-31
Branch: `feat/tour-reminder-ladder-phase-b`
Base: `main` @`ec32170a`
Predecessor: `docs/superpowers/specs/2026-08-26-tour-reminder-ladder-design.md`
(Phase A, merged @`a509eb3b`)
Ledger this discharges: `docs/issues/tour-reminder-ladder-phase-b.md`

## 1. What this is, and why it is ONE mission

Two bodies of work that an earlier split by "risk profile" tried to separate:

- **Turn the tour reminder ladder on.** It has been paused since 2026-08-20
  (`MANUAL_ONLY_REMINDER_KINDS`): every rung still arms and displays, nothing
  auto-sends. Phase A shipped the copy, the name resolution, the retiming and
  the skip rules, and deliberately did not lift the pause.
- **Rewrite the relay group templates** to Sam's 2026-08-24 wording.

They are one mission because the relay copy needs the SAME tokens and the SAME
name resolution Phase A already built (`app/src/lib/tourContacts.ts`), and
because the unpause has an ordering chain that has to be reasoned about as a
whole. Designing them apart is what let the scope drift the first time.

**Governing founder document:**
`W:\AI Projects\Housing Choice\HousingChoiceMessageTemplates_Sam_edits.docx`
(Sam's edits, 2026-08-24). The parallel
`HousingChoice_Templates_Relay_and_Tours_Sam (1).docx` is DISCARDED - it
conflicts; do not read it.

## 2. Decisions locked before this spec

Every item below was settled with Cameron in the brainstorm on 2026-08-31 and
is NOT open for re-litigation by a reviewer. A reviewer may challenge whether
this document IMPLEMENTS them correctly; it may not re-argue the choice.

D1. Confirmation reminders are gone entirely - not armed, not sent.
D2. Two new sweep skip tokens, not one (section 4).
D3. No new dev seam for immediate sends; test-only vehicles (section 10).
D4. The names-read re-list gets a one-hour bound (section 7).
D5. An `overdue` flag ships on the reminder view (section 8).
D6. Ledger item 8 (supersession citing a retired rung) is ASSESSED, NOT WORTH
    FIXING, and DROPPED - not filed (section 12).
D7. `en_route` is exempt from quiet hours, at BOTH sites (section 6).
D8. Three relay intro variants; the no-owner one is unchanged (section 9.1).
D9. `{members}` is removed in favour of `{names}` (section 9.2).
D10. `member_added` splits per-recipient; ONE persisted row carrying the NEW
     MEMBER's body (section 9.4).
D11. Missing intro inputs fall back to the naked intro (section 9.5).
D12. `interpolate` gets a real single-pass fix (section 11).
D13. Merge everything including the unpause; the human runs the sweep against
     prod from their own machine BEFORE deploying (section 3).

## 3. Ordering - the part that texts people if it is wrong

The pause is a code constant, so emptying `MANUAL_ONLY_REMINDER_KINDS` turns
sending on the moment the branch DEPLOYS. Merge is not deploy in this repo;
deploy is a separate human-driven `scripts/deploy.mjs` step. So:

1. Merge the whole branch, unpause included.
2. The human runs the retirement sweep against dev, then prod, from their own
   machine (`--dry-run` first). NOT an agent action - see section 4.4.
3. The human deploys.

Between step 2 and step 3, prod rows carry the two new skip reasons while the
RUNNING dashboard has no labels for them.
`dashboard/src/routes/tours/RemindersPanel.tsx:107` falls back to a bare
"Skipped" chip on an unrecognized reason, so this degrades cleanly and resolves
itself at deploy. Stated here so it is not diagnosed as a bug.

The sweep is idempotent and conditional-write, so re-running it after the deploy
is safe and catches anything armed in between.

**Within the branch**, the build order is: the sweep script, then the test
vehicle conversion, then the unpause. The vehicle must exist before
`confirmation` stops arming, because it is what the suites currently ride.

## 4. The retirement sweep

### 4.1 Why it is needed

A manual-only rung is left PENDING, not claim-skipped, so Send now keeps
working. Every rung armed during the pause is therefore still sitting there,
due, waiting. The instant the manual-only set is empty the next poll tick sees
the lot and sends it, carrying OLD dueAts - a burst of reminders for tours that
are long past.

### 4.2 TWO populations, not one

This is the correction that matters, and the ledger did not have it.
`REMINDER_KINDS` governs **arming only**; the poll reads `listDue` and filters
on `manualOnlyKinds`. So dropping `confirmation` from `REMINDER_KINDS` does
nothing to rows that already exist.

- **Population A - the tour has already happened.** Every PENDING rung of any
  kind on a tour whose `scheduledAt` is in the past at sweep time.
  Criterion is THE TOUR BEING PAST, not the dueAt: a `confirmation` armed for a
  tour next week is past-due from birth and must NOT be swept by this arm.
- **Population B - every pending `confirmation`, regardless of tour date.**
  The kind is being discontinued, so an in-flight confirmation for a FUTURE tour
  would otherwise survive both the sweep and the kind removal and fire on the
  first tick after unpause: "your tour is confirmed" landing days or weeks after
  the booking it confirms.

A row in both populations takes population A's token.

### 4.3 Two new `ReminderSkipReason` tokens

`past_event` is NOT reused. It means "would land at or after the tour starts",
which is false of these rows, and spec 8.2 of Phase A already called that reuse
a lie for this row shape.

| token | dashboard label | population |
|---|---|---|
| `tour_already_passed` | `the tour had already happened` | A |
| `kind_retired` | `this reminder is no longer sent` | B |

Both are added to `ReminderSkipReason` (`app/src/repos/tourRemindersRepo.ts`)
and to `REMINDER_SKIP_REASON_LABELS` (`dashboard/src/api/types.ts`). The
existing label-completeness test (`dashboard/src/api/types.test.ts:119`) pins
that the two maps agree, so a missing label fails the build.

Separate tokens rather than one because the panel chip is operator-facing copy.
A swept confirmation for next Tuesday's tour showing "the tour had already
happened" is a visible falsehood, and `kind_retired` is additionally the honest
token for any future kind removal.

### 4.4 Shape: an ops script, run by the human

`app/scripts/retire-paused-tour-reminders.ts`, following the five existing
`backfill-*.ts` precedents exactly (`backfill-relay-optout-flag.ts` is the
closest model):

- a PURE planner function - given a reminder row and its tour, return
  `'tour_already_passed' | 'kind_retired' | 'skip'` - unit-testable with no
  DynamoDB;
- `--dry-run` scans and reports counts, writing nothing;
- every write CONDITIONAL on the state the planner decided from
  (no `sentAt`, no `canceledAt`, no `skippedAt`), so a concurrent runtime write
  cannot be double-applied and a re-run is always safe;
- targets `DYNAMODB_ENDPOINT` and resolves the table via `lib/config.tableName`,
  no local-only guard - it is an ops script the human runs with the target
  environment set on purpose;
- PII: logs counts, tourIds and reminderIds only. Never a name, phone or body.

**No agent runs this against dev or prod.** It is a data mutation on a real
environment; the human runs it. An agent may run it only against a hermetic
local lane. Its RUNBOOK entry is part of this change.

### 4.5 What the sweep does NOT do

Rows armed BEFORE 2026-08-26 for tours still in the future keep their stored
dueAts and begin firing under the OLD timings for one booking horizon (Phase A
spec 9.3, ledger item 6). Nothing re-arms them and nothing should. Expected, not
a bug: the first `day_before` may fire at the old `scheduledAt - 24h`.

## 5. Stopping `confirmation`

Remove `'confirmation'` from `REMINDER_KINDS` ONLY - the `no_show_checkin`
pattern. The kind stays valid in the `ReminderKind` union, in `computeDueAt`, in
`LADDER_ORDER` and in the catalog, so an in-flight row still composes and still
displays. `MANUAL_ONLY_REMINDER_KINDS` is emptied in the same change, at which
point its `confirmation` entry is dead state and its docblock is false - correct
both.

Founder authority: Sam's 2026-08-24 doc, verbatim - "Turned off:
tour.confirmation and tour.confirmation_no_address. No confirmation text at all
- I'm scheduling manually, so it's redundant."

`tour.confirmation` and `tour.confirmation_no_address` catalog entries STAY.
Phase A spec 6.4 says Phase B disposes of them; that is superseded here - an
in-flight row must still compose for the panel, and the entries cost nothing.
They become unreachable from `armTourReminders` only.

## 6. `en_route` is exempt from quiet hours

Sam approved this explicitly. It must be built at **both** sites; one without
the other reopens the hole. This is Phase A spec 7.3's cut hook.

1. **Arm-time clamp** (`armTourReminders`, `clampOutOfQuietHours`): the
   `en_route` rung's dueAt is stored UNCLAMPED. Every other rung clamps as
   today.
2. **Fire-time backstop** (`sendOneReminder`, the `isQuietTime(now, window)`
   branch): `en_route` is not deferred.

The exemption must NOT change `clampOutOfQuietHours` itself - that helper is
shared. Exempt at the call sites, by kind.

### 6.1 What this changes for Sam, and what she must be told

Her email documents the current overnight behaviour: a 9am tour yields one text
at 8am with the 4-hour reminder skipped, and **a tour at 8am or earlier gets NO
automated reminder at all**. The exemption changes that second half - an 8am
tour now gets its 7am `en_route`. That is the outcome she approved, but she was
given the old explanation. FLAG IT IN THE HANDBACK.

### 6.2 Interaction with the supersession rules

Un-clamping `en_route` REMOVES collisions rather than creating them: a clamped
`en_route` was one of the rungs that could land on another's slot. The
`past_event` rule still applies (`en_route`'s raw dueAt is `scheduledAt - 1h`,
always before the tour), and `staleDayBefore` does not involve `en_route`. No
precedence change.

## 7. Bounding the names-read re-list

Ledger item 7, and the one item whose acceptance was explicitly conditioned on
the pause. When name resolution's contact or unit read THROWS on a rung whose
copy renders what was lost, `composeBodyForRow` raises
`ReminderNamesUnavailableError` and `sendOneReminder`
(`app/src/jobs/tourReminders.ts:1037-1043`) logs and returns WITHOUT claiming.
There is no bound: a persistently failing read re-lists every tick forever, and
the panel keeps calling the rung `upcoming` because there is no overdue state.

### 7.1 The failure this actually guards

Not a poisoned row. Absence never throws - a missing contact, a deleted unit or
a nameless contact all return `undefined` and compose the fallbacks. Only a
THROWN read counts, and the empty-string key case is guarded at the door
(`routes/tours.ts:315` rejects an empty `unitId`).

What throws repeatedly is a **sustained failure of the contacts or units
table**: an IAM permission lost in a deploy, a table misconfiguration, a long
throttling episode. Every rung due during that window re-lists; when the read
recovers, the whole backlog fires at once, carrying copy whose moment has
passed. The bound is what makes an outage degrade into "these did not send, and
the panel says so" instead of "these sent at the wrong time".

### 7.2 The fix - mirror the twin exactly

`roster_unavailable` was bounded for precisely this reason. Reuse its shape:
past `ROSTER_UNAVAILABLE_GRACE_MS` (one hour, `app/src/lib/rosterResolution.ts:100`)
after the row's `dueAt`, claim-skip with a new `names_unavailable`
`ReminderSkipReason`. Dashboard label: `couldn't look up the names`.

`names_unavailable` ALREADY exists in the force-send REFUSAL union
(`app/src/jobs/tourReminders.ts:1478`) - the same dual-union shape
`roster_unavailable` established. Adding it to the skip union is consistent, not
a new naming argument.

One hour and not longer, deliberately: a rung more than an hour past due has
copy that has gone stale regardless of whether the read recovers. An `en_route`
"she is headed over" landing ninety minutes late is worse than a chip saying it
did not send.

The FORCE-SEND path is unchanged - a human action must never retire a rung. It
keeps refusing with `names_unavailable` and the generic retry sentence, so an
operator can still push the rung through the moment the table recovers, for as
long as the rung stays pending.

## 8. The `overdue` flag

A rung is `'upcoming' | 'sent' | 'canceled' | 'skipped'`
(`app/src/routes/tourReminders.ts:143`), derived by `stateOf` from terminal
markers alone - `dueAt` is not consulted. So a rung stuck behind any pre-claim
deferral reads "upcoming" with a dueAt weeks in the past, and nothing says so.

### 8.1 An ADDITIVE BOOLEAN, never a fifth state value

Do NOT widen the `state` union. Two predicates test `'upcoming'` by equality -
`hasUpcoming` (`routes/tourReminders.ts:497`) and the next-rung pick (`:616`) -
and an `'overdue'` value would silently drop overdue rungs out of exactly the
places that surface them.

Add to `TourReminderView` (and its dashboard twin at
`dashboard/src/api/types.ts:1196`):

```
/** Derived, never stored: this rung's send time has passed and it still has
 *  not sent. Composes with `suppression`, which says WHY. */
overdue?: boolean;
```

set at the view-build site (`routes/tourReminders.ts:598-609`) as
`state === 'upcoming' && row.dueAt < nowIso`. Omitted when false, matching the
file's existing conditional-spread style.

It composes with `suppression` rather than competing: a quiet-hours-deferred
rung is overdue AND carries `{reason: 'quiet_hours'}`. Chip copy pairs them.

### 8.2 Scope boundary

`routes/placementNudges.ts` has the identical four-value union, the identical
`stateOf` (`:176`) and the identical blind spot, with its own `'upcoming'`
equality predicates at `:376` and `:419`. It is FILED, not built:
`docs/issues/placement-nudge-overdue-invisible-on-card.md`. This branch does not
touch the placement surface.

## 9. Relay group templates

### 9.1 Three intro variants, routed on the conversation's owner

`getOwner(conv)` (`app/src/repos/conversationsRepo.ts:385`) returns
`{type: 'tour'|'placement', id}` or `{type: null}`, with a legacy
`placementId` fallback. The intro job already holds the conversation
(`relayFanOut.ts:626`), so the routing is free.

**Precedence, highest first:**

1. An operator-edited `intro_body` - sends verbatim, exactly as today. Sam:
   "the manual, editable opener you just shipped works great for right now -
   nothing to change there, and please don't pull it."
2. `owner.type === 'tour'` -> the tour intro.
3. `owner.type === 'placement'` -> the placement intro.
4. Otherwise, or any missing input per 9.5 -> the naked intro, unchanged.

**Tour intro - the tour is TODAY in the org timezone**

```
Hey {tenantFirstName}! Putting you in a group text with {propertyContactFirstName} to tour {where} at {time}. Looking forward to you seeing the property and meeting {propertyContactFirstName}! Please let us know when you're on the way.
```

**Tour intro - any other day**

```
Hey {tenantFirstName}! Putting you in a group text with {propertyContactFirstName} to tour {where} on {when}. Looking forward to you seeing the property and meeting {propertyContactFirstName}! Please let us know when you're on the way.
```

Sam wrote "at {when}" for both. Our `{when}` renders "Tue, Sep 8 at 3:00 PM", so
"at Tue, Sep 8 at 3:00 PM" reads badly; Cameron approved "on" for the dated
form. The today form drops the date entirely and uses the existing `{time}` -
"on Monday, August 31st at 3:00 PM" for a tour later the same day is confusing.
There is deliberately NO "tomorrow" variant.

"Today" uses the SAME timezone the booked-too-late rules use for their same-day
test (`resolveQuietHoursTimezone`), so the two can never disagree.

**Placement intro**

```
Hey {tenantFirstName}! Excited to have you move into {where}. Please use this group text for all future communication and {propertyContactFirstName} will share updates as they receive them from the housing authority. This can be a long process so if you have any questions feel free to ask in here! We are committed to the process and are excited to have you move in.
```

**Naked intro** - the live copy, rewritten only to drop `{members}` per 9.2. The
sent text is BYTE-IDENTICAL to today's.

### 9.2 `{members}` is removed; `{names}` replaces it

`{members}` is a whole computed SENTENCE
(`composeConnectionSentence`, `relayFanOut.ts:189`) carrying fixed copy that
never varies. That copy belongs in the catalog where it is visible and
editable, not buried in code.

`{names}` is the bare list only - "Alice, Bob, and Carol". The naked intro
becomes:

```
Hey, it's Sam. You're now connected with {names} on this number. Reply here and everyone in the group sees it. Use this group text for anything that comes up. It can be a long process, so ask me anything in here!
```

`composeConnectionSentence` becomes a name-list builder. Its no-names branch
today RESTRUCTURES the sentence; as a token it resolves to the noun phrase
`2 other people` / `1 other person` so the one sentence still works. The
degenerate zero-others case ("You're now connected on this number.") is dropped
- a relay group with no other members is not a group.

Never a phone number, ever, in any branch. That rule is unchanged.

### 9.3 Token contract for the relay entries

Reuse, do not reimplement:

- `resolveTourContactNames` (`app/src/lib/tourContacts.ts`) for
  `{tenantFirstName}` and `{propertyContactFirstName}`. It already brace-strips
  names (`inertName`), which is what keeps a user-supplied name from re-opening
  a token.
- `formatStreet` (`app/src/lib/address.ts`) for `{where}`. It is ALREADY
  street-only for structured addresses; Sam's request for that predates the
  change and is satisfied. A legacy plain-string address still returns verbatim
  (`seed-addresses-unstructured`, out of scope).
- `formatLocalDate` / `formatLocalTime` (`app/src/lib/localTime.ts`) for
  `{when}` ("Tue, Sep 8 at 3:00 PM") and `{time}` ("3:00 PM").

**Declare `{where}` LAST in every new entry's `vars` array.** With section 11's
single-pass fix this is belt-and-braces rather than load-bearing, but the
ordering costs nothing and the address is the one value that is not
brace-stripped.

The composer stays PURE and synchronous, mirroring Phase A's split: a resolver
in the job handler gathers owner -> tour/placement -> unit + names, and hands
plain values to a pure entry-selection-and-interpolate function. No repo reads
below the composer.

### 9.4 `member_added` splits per recipient

**This REVERSES the recorded founder decision of 2026-07-14**, which made
`member_added` a single body to the whole group precisely so it could double as
the new member's first contact. Recording the reversal explicitly, with its
date, the way Phase A recorded D2's reversal, so nobody re-derives the old
rationale and "fixes" it back. Authority: Cameron, 2026-08-31, on Sam's
2026-08-24 wording.

**To the GROUP** - Sam's line, with the role clause she asked for:

```
Hey, adding {name} to the group as the {role}.
```

**To the GROUP, when the role does not resolve** - a separate entry, because
the role sits MID-sentence and cannot blank out cleanly (Phase A spec 6.4's
empty-clause trick only works for a trailing sentence):

```
Hey, adding {name} to the group.
```

**To the NEW MEMBER** - the naked intro from 9.1, unchanged, with the full
post-add roster in `{names}`. No tour/placement variants of this: one message.
It is the right body because the new member cannot see any history - a relay
member receives forward traffic only - so this message IS their entire context,
and the naked intro is the one that already carries "it's Sam" and names who
else is on the number.

`{name}` is the FIRST name, matching the 2026-08-20 decision and the name list.

**STOP is omitted on both.** Sam's logged A2P decision for relay intros
(changelog 1.2.1 #7). The new member's first contact IS an intro, so the same
decision governs. DECIDED - do not re-open.

**Role token source: `UnitContact.role`** (`app/src/repos/unitsRepo.ts:69`),
`'landlord' | 'pm' | 'owner' | 'other'` - NOT `ContactItem.type`, which has no
property-manager value.

| roster role | `{role}` |
|---|---|
| `pm` | `property manager` |
| `landlord`, `owner` | `landlord` |
| the owning tour's or placement's tenant | `tenant` |
| `other`, no roster row, no unit, no owner | use the no-role entry |

Free: `resolveTourContactNames` already reads `unitContacts(unit)`.

### 9.5 Missing inputs fall back to the naked intro

ONE rule. A missing landlord, address or tour time on a tour or placement relay
-> send the naked intro. **Exception:** a missing tenant first name degrades
in-sentence the way Phase A already does ("Hey there,").

This must be a fallback and not an empty clause because both new intros use
`{where}` MID-sentence, which Phase A spec 6.4 identifies as exactly the case
the empty-clause trick cannot handle. The escape hatch for a case where the
naked opener is not good enough is the one Sam already uses: the operator sees
the preview and edits it.

### 9.6 ONE persisted row, carrying the NEW MEMBER's body

`sendRelayAnnouncement` (`app/src/services/relayAnnouncements.ts:190-294`)
persists ONE message row with a `delivery_recipients` map for the whole roster,
then sends that one `body` to every member. Per-recipient bodies change that
function, not just the composer.

**DECIDED (Cameron, 2026-08-31): one announcement row, one bubble, one rollup
chip, and the persisted body is the NEW MEMBER's copy.** The group-side copy
goes out to everyone else and is deliberately NOT shown in the dashboard thread.
`touchLastActivity`'s inbox preview inherits the same body, which is consistent.

**This is a NAMED, DATED EXCEPTION to the founder decision of 2026-07-14 that
everything sent into a relay group must be visible in its dashboard thread.**
Written here with its rationale so it is not filed as a bug: this is the only
message in the product where recipients get different copy, and of the two the
new member's is the one worth seeing. Two rows would mean two bubbles and two
rollup chips for one event, which Cameron ruled out.

Implementation shape: `sendRelayAnnouncement` takes an optional per-member body
selector alongside `body`; `body` remains what is persisted and previewed. The
default (no selector) is byte-identical to today's behaviour, so every existing
caller - tour reminders included - is unaffected.

Per-recipient DELIVERY (rows and chips) already exists and does NOT help here:
that is delivery state, not bodies.

### 9.7 `relay.group_closed` and the placement nudges - nothing owed

Sam's doc asks to "please delete" `relay.group_closed` and to "DISABLE FOR NOW"
all four placement nudges. Both are already satisfied and neither is in scope:

- `relay.group_closed` is already not sent (changelog 1.2.1 #10). The catalog
  entry and the code STAY.
- The placement nudges are already manual-only. "Disable" means not
  automatically sending, which is already true. Do NOT remove the copy or the
  code.

Recorded so a reviewer does not read the founder doc and file them as gaps.

## 10. Test vehicles - no new dev seam

`confirmation` is the suites' only immediate-send vehicle today: roughly 40
sites in `app/test/tourReminders.test.ts` and roughly 14 across
`e2e/tests/scenarios/scheduled-visibility.spec.ts`, `e2e/tests/tour-roster.spec.ts`
and `e2e/tests/scenarios/tours.spec.ts`, all riding its `dueAt = now`.

The ledger recommended budgeting for a new dev seam. **That is not needed**, and
the correction is load-bearing enough to state with its evidence:

- **Unit tests.** Only `armTourReminders` drops a past-due row; the repo's own
  `create` does not. A test-only helper calling
  `tourRemindersRepo.create({tourId, kind, dueAt: now0})` yields an
  immediately-due row of any kind with ZERO production code. Those ~40 sites
  test the SEND path, not arming, and arming has its own dedicated cases - so
  the split is more honest than what they do today.
- **E2E.** The vehicle already exists. `e2e/scenarios/steps.ts:2033-2046` -
  `tickTourReminders(justAfter(await armedReminderDueAt(kind)))` - and its
  docblock describes firing a future rung in terms. The sites convert
  mechanically.

E2E runs `workers: 1, fullyParallel: false`, so there is no concurrent-spec
hazard; the residual risk of clock-travel ticks is that a future `now` also
fires seeded rows, and assertions are already phone-scoped.

**If a spec genuinely cannot be made deterministic this way, RAISE IT** rather
than building a `POST /__dev/tour-reminders/fire` seam speculatively. Adding a
second code path through the send machinery in the change that turns the send
machinery on is the wrong risk.

The existing dev tick's DELIBERATE DIVERGENCE comment
(`app/src/routes/dev.ts:404-418`) says "Delete this when the hold-back is
lifted; do not leave a permanent dev/prod fork." Honour it: with
`MANUAL_ONLY_REMINDER_KINDS` empty the `manualOnlyKinds: new Set()` override and
its comment both go.

## 11. The shared `interpolate` re-expansion fix

`interpolate` (`app/src/messages/resolve.ts:30-44`) substitutes declared tokens
SEQUENTIALLY into an accumulating string, so a value inserted for an earlier
token is rescanned for later ones. Live today in `relay.member_added`
(`vars: ['joined', 'members']`, both fed from contact display names): a member
named `{members}` injects the member list into the SMS to the whole group.
Filed as `message-interpolate-token-reexpansion`. Phase A closed the NAME vector
at the tour source with `inertName`; the general fix was left because it changes
every message in the app.

**FIX IT (Cameron approved).** Replace the per-token loop with a SINGLE pass
that fills every declared token simultaneously, so a substituted value can never
be rescanned.

Both existing behaviours must be preserved EXACTLY, and each needs its own
regression test:

- an UNDECLARED token stays literal in the output (it is not in `allowed`);
- a DECLARED token present in the template but missing from `vars` THROWS for a
  code-controlled DEFAULT (`strict`) and degrades to the empty string for an
  operator OVERRIDE (`!strict`). That split is load-bearing: an operator's
  personalized `welcomeText` using `{firstName}` can fire on a path with no
  name, and must not crash the send.
- a DECLARED token ABSENT from the template needs no value and must not throw
  (`welcome.sms` declares `{firstName}` for override use).

This touches every message in the app. It is a pure function with no I/O, which
is what makes it a small risk, but the test coverage above is not optional.

## 12. Ledger items disposed of here

| item | disposition |
|---|---|
| 1. retirement sweep | BUILT - section 4, plus the second population the ledger missed |
| 2. empty manual-only + stop arming `confirmation` | BUILT - section 5 |
| 3. replacement immediate-send vehicle | BUILT differently - section 10; no seam needed |
| 4. quiet-hours exemption hook, both sites | BUILT - section 6 |
| 5. the founder's open `en_route` question | ANSWERED - exempt; section 6 |
| 6. in-flight rows fire under OLD timings | ACCEPTED, documented - section 4.5 |
| 7. unbounded names-read re-list | BOUNDED - section 7 |
| 8. `confirmation` retired citing a rung that never armed | **ASSESSED, NOT FIXED, DROPPED - not filed.** See below |
| 9. failure-scope derivation reads catalog DEFAULTS only | RE-DEFERRED - see below |

**Item 8, in full, because the ledger asks Phase B to "say which one you are
doing".** It is TWO defects. The arm-time one (`supersededBySlot`) does vanish
when `confirmation` stops arming, and with confirmation gone it is only
reachable at all when quiet hours start at or before 19:30 - not the default.
The fire-time one (`supersededInBatch`) has no armability check and does NOT
vanish. But for it to cost a message, the later rung must fail for a reason that
would not also have killed the earlier one, and every terminal failure mode is
per-tour or per-tenant - no phone, contact missing, tenant not on roster,
unusable schedule, roster unreadable - killing both identically. The ONE
rung-differential mode is `names_unavailable` on a landlord-led `en_route`. So
the full failing scenario requires worker downtime AND a landlord-led tour AND a
live database read failure, simultaneously - during which the earlier rung was
firing hours late anyway. **Cameron's ruling: disaster-recovery only, drop
entirely, do not file.** The predicate stays as-is.

**Item 9** stays safe and stays deferred: `reminderNamesUsed` derives failure
scope from catalog DEFAULT templates, and no `tour.*` override can exist
(`settingsToOverrides` maps two non-tour ids; no tour compose site passes
`overrides`). This branch adds no override path. The
`TODO(tour-reminder-ladder-phase-b)` marker is RE-POINTED at
`docs/issues/tour-copy-where-token-declared-not-passed.md`, its sibling of the
same class, rather than left pointing at a closed ledger.

## 13. Out of scope

- Settings UI for tour copy. Cameron ruled it OUT. `relay.intro` stays
  `editable: false` and the catalog docblock's reasoning stands.
- `missed_call.autotext` - already solved.
- Legacy plain-string address cleanup - `seed-addresses-unstructured`.
- Voice prompts, `welcome.sms`, compliance-locked entries.
- The placement-nudge `overdue` twin - filed, section 8.2.
- `routes/placementNudges.ts` in general.

## 14. Testing

- **Unit.** The sweep planner (pure, both populations, the not-past-tour
  negative, and idempotency against an already-skipped row). The `en_route`
  exemption at both sites. The one-hour names bound, including the
  force-send path still refusing rather than retiring. `overdue` true/false/
  absent. Every relay entry's composition including all four fallbacks.
  `interpolate`'s three preserved behaviours plus a re-expansion regression.
- **E2E.** The converted immediate-send sites. A tour relay intro and a
  placement relay intro landing in every member's fake thread with resolved
  names. `member_added` proving the new member's fake thread carries the naked
  intro while the others carry Sam's line, and that ONE row is persisted.
- **Catalog.** The existing "no dead tokens" and label-completeness tests cover
  the new entries; add a case pinning the naked intro's composed output is
  byte-identical to the pre-change body.

## 15. Owed to the founder (handback items, not build work)

1. `en_route`'s quiet-hours exemption changes what her email told her about
   tours at 8am or earlier. Tell her the new outcome (section 6.1).
2. Confirm that `pm` on a unit roster is what she means by "property manager"
   (section 9.4).
3. The placement intro runs about 370 characters, roughly three SMS segments.
   Phase A spec section 5 rules that a cost note, not a gate. Do not shorten her
   words.
4. Her question "please also confirm {landlord} is wired to tour templates and
   not just to relays" - it is, as `{propertyContactFirstName}` on
   `tour.en_route_landlord_led`.
