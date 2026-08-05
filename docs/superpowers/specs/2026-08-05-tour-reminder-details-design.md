# Tour reminders carry the actual time and address

Date: 2026-08-05
Status: APPROVED (Cameron, this session)
Branch: `feat/tour-reminder-details` (worktree `w:/tmp/tour-reminder-details`, cut from `main` @ed75d9e8)
Revision: v2 - rewritten after an adversarial review whose 15 findings were all
verified against the code. Changes from v1 are marked REVISED or NEW.

## 1. Problem

Every tour reminder is generic, token-free copy:

```
tour.confirmation     Your tour is confirmed. We'll send reminders as it approaches.
tour.day_before       Reminder: your property tour is tomorrow.
tour.morning_of       Good morning! Your property tour is today.
tour.en_route         Your tour is coming up soon. Text us when you're on the way!
tour.no_show_checkin  Hi! We noticed you may have missed your tour. Want to reschedule?
```

None of it answers the two questions a tenant actually has the morning of a
tour: what time, and where. That gap matters most for `self_guided` tours, where
nobody is on site to meet them. The catalog already has `{token}` interpolation
(`messages/resolve.ts`) and the send paths already hold the tour, its `unitId`,
and the org timezone, so both facts are cheap to add.

A second, smaller defect rides along. Three placement-nudge defaults contain a
U+2014 EM DASH, which forces the whole message to UCS-2 and its 70-char budget;
two of them consequently bill as two segments. Nothing enforces the character
range on catalog copy today. Filed as
`docs/issues/sms-copy-non-gsm7-characters.md`; the mechanism half folds in here
(section 7) because this feature needs the same analysis helper for its own
tests.

## 2. Scope

IN:
- The four auto-armed rungs gain org-local time and the unit's address.
- One shared body composer used by every resolution site, so the three preview
  surfaces cannot drift from what sends.
- A snapshot of the sent body on the row, so history stays honest (D4).
- `analyzeSms()` plus a catalog-wide ASCII test for code-controlled copy, and the
  three em-dash edits that test forces.
- BOTH affected dashboard surfaces re-zoned to the composing timezone (D8): the
  tour page's Reminders panel AND the contact timeline's ScheduledCard.

OUT (explicitly deferred, each with a follow-up issue to file - section 10):
- The Settings-UI advisory showing an operator the encoding and segment count of
  an override. The folded-in issue stays open, narrowed to this.
- Converting the seeded plain-string addresses to structured `Address` (D5).
- Any message-length guard, tour-local or universal (D9). Filed separately as
  `automated-sms-length-guard`.
- `{firstName}` personalization.
- A per-contact `timezone` FIELD. This spec routes through the existing resolver
  seam (D8) but builds no field, storage, or UI.
- Any change to arm-time scheduling. Rungs, dueAts, clamping and skip rules are
  untouched.

## 3. Decisions

**D1. One body for both routes.** Reminders for `landlord_led` and `pm_team`
tours go to the tour's masked GROUP thread, where landlord and tenant read the
identical text. Rather than maintain per-route variants, the copy is NEUTRAL: no
possessive, address-led. "Tour at 412 Oak St is today at 3:00 PM" reads correctly
to either party.

Rejected: per-route catalog entries (doubles the entries and doubles what an
operator keeps in sync); naming the tenant in group copy (puts a first name in
the thread on every rung).

Side benefit: leading with the address sidesteps a glossary drift. Current copy
says "your property tour" to a TENANT, but per `documentation/GLOSSARY.md` the
tenant-facing noun is "home", not "property". Naming the address avoids picking a
noun at all.

**D2. `no_show_checkin` is UNCHANGED.** Cameron's call: when you are not certain
someone no-showed, vaguer wording is kinder. It stays token-free, second-person,
and verbatim.

**D3. `en_route` keeps "Text us when you're on the way!"** Aimed at the tenant,
slightly odd for a landlord reading the group thread, and that is accepted.

**D4. REVISED - compose live for pending rungs, SNAPSHOT for sent ones.** v1 said
"compose at send and at read, never store". That is right for a rung that has not
fired: a rescheduled tour's preview self-corrects with no migration. It is WRONG
for a rung that already fired. Sent rows persist across a reschedule, and a later
edit to the tour time or the unit address would make the panel and the contact
timeline render an already-sent confirmation with NEW details - claiming we texted
something we never texted, and disagreeing with the real message sitting in the
conversation thread (and, on the group route, with the announcement
`sendRelayAnnouncement` persisted).

The rule:
- rung has NO `sentAt` -> compose live at read.
- rung HAS `sentAt` -> render the stored `sentBody`.

`sentBody` is written in the SAME atomic update as `sentAt`, by passing the
composed body into `claimSend`. Rendering from the thread instead was rejected:
no rung-to-message link exists today.

THE REORDER IS REAL AND IS THE RISKIEST EDIT IN THIS DIFF. Only ONE of the four
send call sites composes before it claims today:

| site | claims at | composes at | needs reorder |
|---|---|---|---|
| poll, 1:1 (`processReminderRow`) | `:587` | `:579` | NO - already before |
| force-send, 1:1 (`forceSendReminder`) | `:871` | `:903` | YES |
| poll, group (`sendGroupReminder`) | `:715` | `:767` (inside `announceGroupReminder`) | YES |
| force-send, group | `:882` | `:767` (same) | YES |

Three of four must move composition ABOVE the claim. `claimSend` IS the `sentAt`
stamp, so a compose failure after it burns the rung permanently - see W6, which
this table is the evidence for. For the two group paths the body must be composed
by the CALLER and passed into `announceGroupReminder`, which today composes it
itself.

Legacy rows (armed before this change) have no `sentBody`; they fall back to
composing live. Documented, not migrated - the old copy carried no time or
address, so there is nothing to be wrong about. NOTE this means a read path can
never skip the unit/timezone reads on the grounds that a rung is already sent:
any request may contain a legacy row. `sentBody` saves correctness, not I/O.

**D5. REVISED - address means street-only WHEN STRUCTURED, stored string
otherwise.** v1 claimed "street only (line1 + line2), no city/state/zip". That is
true only for a structured `Address`. Verified: `seed/cast.ts`, `seed/lean.ts`
and `seed/matrix.ts` all store PLAIN STRINGS including city, state and zip
(`'350 Boulevard SE, Atlanta, GA 30312'`); only `seed/live.ts` is structured. So
on dev, in every demo, and across the whole e2e suite, `{where}` renders exactly
the postal noise v1 said it excluded.

Honest statement of behavior: `formatStreet` returns `line1 [line2]` for a
structured address and the stored string trimmed and verbatim for a legacy one.
Converting the seeds is deferred to a follow-up issue (it touches the byte-stable
`lean` profile the e2e goldens depend on - real risk for a cosmetic gain).

**D6. ASCII is enforced on OUR strings only.** See section 7.

**D7. NEW - no token carries embedded whitespace; use `_no_address` variants.**
v1 had `{where}` carry its own leading space so the empty case read correctly,
and documented the inconsistency (`{when}` had no leading space, `{where}` did)
as a wart. Rejected on review: a convention where some tokens carry whitespace
and others do not is unlearnable - you would have to read the composer to know
which is which.

Instead there is no optional token. Eight entries; the composer picks by whether
a street exists. Every token is a bare value.

This also restores `interpolate`'s strict-throw as a real guard: with an optional
token we would always pass a string (`''` counts), silently defeating the "a
default that declares a token must supply it" check. With mandatory tokens, a
forgotten var throws in tests as designed.

Rejected alternatives: whitespace-collapse after substitution (makes the catalog
string stop being the sent string - exactly the drift the parity test exists to
prevent - and fails silently when an optional token precedes a comma); a trailing
space instead of a leading one (moves the wart, does not remove it).

ACKNOWLEDGED TENSION WITH D1. D1 rejects per-route variants precisely because
they "double the entries and double what an operator keeps in sync", and D7 then
doubles the entries 4 -> 8 anyway. That is a knowing trade, not an oversight: the
unlearnable-whitespace cost D7 avoids is paid on EVERY future read of the
catalog, while the sync cost is paid only by an operator editing tour copy - and
no such operator exists yet (see the override note below). Concrete consequence
to accept: someone overriding `tour.day_before` sees NO change for address-less
tours, because those render `tour.day_before_no_address`.

OVERRIDES ARE UNREACHABLE TODAY. `settingsToOverrides` (`messages/resolve.ts:77`)
maps only `welcome.sms` and `missed_call.autotext`, so no `tour.*` override can
exist and the composer's `overrides` parameter is DEAD CODE for now. It is
carried because `resolveMessage` takes it and the generic Templates UI is a filed
follow-up. Stated so a reviewer does not go hunting for an override path that
isn't built.

**D8. NEW - timezone resolves through the existing seam, and the API returns the
zone it used.** Do NOT read `settings.timezone` directly. Every timezone
resolution goes through `resolveQuietHoursTimezone(settings, contact?)`
(`lib/quietHours.ts`), which today returns the org zone and ignores the contact.

VERIFIED: there is no per-contact timezone FIELD - not on `ContactItem`, not
anywhere. The 2026-08-03 quiet-hours spec states "No contact field or UI is built
now", and `app/test/quietHours.test.ts:127` pins that passing a contact still
yields the org zone. What exists is a one-function seam every call site funnels
through. This spec builds no field; it only makes sure tour copy uses the seam,
so the day a contact-level zone lands, reminder copy becomes recipient-local for
free.

Consequence for the dashboard: `dateTime` (`placements/placementsFormat.ts`)
calls `toLocaleString` with NO `timeZone` - i.e. the BROWSER's zone. Once a body
carries an org-local time, staff outside America/New_York see a row whose chip
and body disagree. Before this change no disagreement was possible, so this
change introduces the defect and must fix it.

TWO surfaces are affected, not one:
- `RemindersPanel.tsx:79,103` (the tour page), fed by sites 4 and 5.
- `contact/ScheduledCard.tsx:37` (the contact timeline), which renders
  `[sendRelative(at), dateTime(at)]` directly beside the body that site 6
  composes. This one is easy to miss and the argument above applies to it
  verbatim.

BOTH responses therefore carry the `timezone` actually used to compose, and both
components format in that zone. Hardcoding "org timezone" in the components was
rejected: returning the composing zone keeps chip and body agreeing even after
per-contact zones land.

CONSTRAIN THE FORMATTER CHANGE. `dateTime` is shared by FIVE consumers -
`ScheduledCard`, `RemindersPanel`, `DeadlinesNudgesCard`, `PlacementNowCard` and
`TourDetail`. Re-zoning it in place would silently move every placement and
activity timestamp in the dashboard. REQUIRED: add an OPTIONAL `timeZone`
parameter defaulting to today's behavior (or add a sibling function), so the
three non-reminder consumers are provably unchanged. `sendRelative` is purely
relative and therefore zone-independent - do NOT touch it.

**D9. NEW - an unbounded address is ACCEPTED here; length is a universal
concern, not a tour concern.** Address length has NO storage-level bound.
DynamoDB is schemaless (only the 400 KB item ceiling applies), and the only cap
is an application constant: `FIELD_CAPS` in `lib/address.ts:33` (`line1` 200,
`line2` 100), checked by `validateAddress` at `address.ts:66` and reached from
exactly ONE call site, the unit write surface `lib/unitFields.ts:175`.

Two gaps follow, and both matter here:
- `validateAddress` only accepts a STRUCTURED object, so it never applies to a
  legacy plain-STRING address at all - those are length-unbounded.
- The seeds write straight to DynamoDB, bypassing `unitFields` entirely. That is
  precisely why every seeded address is an uncapped plain string (D5).

So even the ~300-char figure describes only the validated structured path; a
seeded or legacy string address has no bound whatsoever. Either way this lands
past the `maxChars: 320` the catalog declares but never validates. v1's "adding
time and address costs NOTHING in segments" was verified only inside a window
nothing enforces, and that claim is corrected in section 4.

No tour-specific cap is added. Cameron's ruling: a length guard belongs at the
automated-send layer where it protects EVERY message, not bolted onto one
feature's composer. A tour-local cap would also be redundant the moment the
universal one lands, and removing it later is work we can skip by not adding it.

Truncating the address was rejected on its own merits too - a mangled street
("1234 Northwest Somethingvi") is worse than a long text.

The universal guard is filed as `automated-sms-length-guard` (section 10). Until
it lands, a pathological address produces a multi-segment text: a real but
bounded, per-unit, self-inflicted cost.

## 4. Copy

Eight catalog entries replace four. `no_show_checkin` is untouched.

```
tour.confirmation             Tour confirmed at {where} for {when}. We'll text reminders as it gets closer.
tour.confirmation_no_address  Tour confirmed for {when}. We'll text reminders as it gets closer.
tour.day_before               Reminder: tour at {where} is tomorrow, {when}.
tour.day_before_no_address    Reminder: tour is tomorrow, {when}.
tour.morning_of               Good morning! Tour at {where} is today at {time}.
tour.morning_of_no_address    Good morning! Tour is today at {time}.
tour.en_route                 Tour at {where} starts at {time}. Text us when you're on the way!
tour.en_route_no_address      Tour starts at {time}. Text us when you're on the way!
tour.no_show_checkin          (UNCHANGED, no tokens)
```

Tokens - all bare values, no embedded whitespace (D7):

| token | value | example |
|---|---|---|
| `{when}` | `formatLocalDate` + " at " + `formatLocalTime` | `Thu, Jul 23 at 3:00 PM` |
| `{time}` | `formatLocalTime` | `3:00 PM` |
| `{where}` | `formatStreet(unit.address)` | `412 Oak St Apt 2` |

Address-bearing entries declare `vars: ['when', 'time', 'where']`; `_no_address`
entries declare `vars: ['when', 'time']`. `interpolate` only substitutes tokens
present in a template, so declaring both time tokens on every entry is safe, and
every declared-and-present token is always supplied (D7's strict-throw guarantee).

KNOWN GAP IN THAT ASYMMETRY, to be documented in a catalog comment rather than
"fixed": `interpolate` iterates only over `allowed`, so a token NOT declared is
never inspected at all. An operator override of `tour.morning_of_no_address`
containing `{where}` would therefore emit the literal text `{where}` to a tenant,
with no throw (strict applies to defaults, and `where` is never examined).
Declaring `where` on the `_no_address` entries would suppress that, but only by
reintroducing the always-pass-a-string hole D7 exists to close. The right fix is
a comment on each half stating which vars it accepts. This is unreachable today
regardless - no `tour.*` override can exist (see D7's override note).

Rendered with the SEEDED address (`350 Boulevard SE, Atlanta, GA 30312`, a legacy
plain string - this is what dev, demos and e2e actually show, per D5):

```
Tour confirmed at 350 Boulevard SE, Atlanta, GA 30312 for Thu, Jul 23 at 3:00 PM. We'll text reminders as it gets closer.
Reminder: tour at 350 Boulevard SE, Atlanta, GA 30312 is tomorrow, Thu, Jul 23 at 3:00 PM.
Good morning! Tour at 350 Boulevard SE, Atlanta, GA 30312 is today at 3:00 PM.
Tour at 350 Boulevard SE, Atlanta, GA 30312 starts at 3:00 PM. Text us when you're on the way!
```

With no address on file:

```
Tour confirmed for Thu, Jul 23 at 3:00 PM. We'll text reminders as it gets closer.
Reminder: tour is tomorrow, Thu, Jul 23 at 3:00 PM.
Good morning! Tour is today at 3:00 PM.
Tour starts at 3:00 PM. Text us when you're on the way!
```

SEGMENT MATH, stated honestly:
- With the seeded 52-char address every rung is GSM-7 single-segment (longest 138
  units of 160). VERIFIED this session.
- Address length is UNBOUNDED (D9) - by this spec AND by storage. A structured
  address validated through the unit write surface reaches ~300 chars (about 3
  segments per rung); a legacy or seeded plain-string address is capped by
  nothing at all. Accepted here; the universal length guard in section 10 is
  what will flag it.
- If a unit address contains ANY non-ASCII character the whole body becomes UCS-2
  with a 70-char budget. At the seeded address length that is FOUR of four rungs
  at 2+ segments (`morning_of` reaches 95 UCS-2 units). v1 said three of four,
  which was true only for a 16-char example address. This cost is accepted (D6):
  we do not rewrite the user's data.

Redundancy on `day_before` ("tomorrow" plus the date) and `morning_of` ("today"
plus the time) is DELIBERATE - both words are currently guaranteed by the
arm-time stale-`day_before` and `past_event` rules, but the explicit value costs
no segment and survives any future change to those rules.

## 5. Modules

**NEW `app/src/lib/localTime.ts`** - pure, structural inputs, no clock reads, no
repo imports (the `lib/quietHours.ts` discipline including its cached
`Intl.DateTimeFormat` idiom):

```
formatLocalDate(iso: string, timezone: string): string   // "Thu, Jul 23"
formatLocalTime(iso: string, timezone: string): string   // "3:00 PM"
```

Both normalize U+00A0 NO-BREAK SPACE and U+202F NARROW NO-BREAK SPACE to a plain
space before returning. RATIONALE: ICU 72 shipped U+202F in exactly the position
before AM/PM. This repo's Node 24 (ICU 78) emits a plain ASCII space - VERIFIED
across `hour`/`minute`, `hour12`, `timeStyle`, `dateStyle+timeStyle` and
`toLocaleTimeString` - but a Node bump must not be able to silently flip every
reminder to UCS-2 and halve its budget.

**NEW `app/src/messages/tourCopy.ts`** - pure, no repos, no clock:

```
composeTourReminderBody(input: {
  kind: ReminderKind;
  scheduledAt: string;
  timezone: string;
  address?: Address | string;
  overrides?: Partial<Record<MessageId, string>>;
}): string
```

Picks the address-bearing or `_no_address` entry (D7), builds the tokens, and
delegates to `resolveMessage`. This is the ONLY module allowed to construct a
`tour.*` message id other than `tour.no_show_checkin` - enforced by a test
(section 8).

`scheduledAt` is REQUIRED, not optional, though `TourItem.scheduledAt` is
optional. This is a deliberate narrowing: a reminder row cannot exist for a
time-less tour (`armTourReminders` returns early without one, and PATCH cannot
clear it), so every caller has one in hand. The composer validates it and throws
a NAMED `UncomposableReminderError` rather than letting `formatLocalDate` surface
a bare `RangeError`. `{when}` and `{time}` have no graceful empty shape - they
sit mid-sentence - so the composer itself has nothing to degrade to.

**NO CALL SITE MAY PROPAGATE THAT THROW.** The composer is partial; every caller
must make itself total. This is not defensive padding - each unhandled path has a
specific, verified failure mode:

- SEND paths: a throw escapes `processReminderRow` into the per-row try/catch at
  `tourReminders.ts:379-390`, which logs and continues WITHOUT claiming. The row
  stays in `listDue` and is retried every 60s FOREVER - precisely the perpetual
  "sending shortly" bug that `claimSkip` was built to end (see the `claimSkipRow`
  docstring). Required: catch `UncomposableReminderError` and CLAIM-SKIP the rung
  with a new `ReminderSkipReason` of `invalid_schedule`, so it retires once and
  visibly. Add the matching label beside the existing skip-reason labels in
  `RemindersPanel.tsx`.
- READ paths (sites 4, 5, 6): no such guard exists. A throw is a 500 on the tour
  page AND the contact timeline. A read path must NEVER 500 over copy rendering.
  Required: catch and degrade - render the `_no_address`/no-time shape, or omit
  the body for that rung - and log at warn.

Probability is low (rows cannot be armed without `scheduledAt`, PATCH cannot
clear it, and the value is canonicalized at the boundary). Low probability plus
unbounded retry is a class this repo has already been bitten by, which is why the
containment is specified rather than left to judgment.

**EXTENDED `app/src/lib/address.ts`** - add `formatStreet(a)` beside
`formatAddress`: joins `line1` and `line2` with a space, returns a legacy
plain-string address trimmed and verbatim, returns `''` for `undefined` or an
all-empty address. `formatAddress` currently computes the street inline at
`address.ts:90`; refactor it to call `formatStreet` so the two cannot drift.

**NEW `app/src/lib/smsEncoding.ts`** - see section 7.

## 6. Resolution sites and wiring

There are SEVEN `tour.<kind>` resolution sites, not the six v1 claimed. SIX move
to `composeTourReminderBody`; the seventh stays.

| # | site | file | note |
|---|---|---|---|
| 1 | poll, 1:1 route | `jobs/tourReminders.ts` `processReminderRow` | |
| 2 | poll + force-send, group route | `jobs/tourReminders.ts` `announceGroupReminder` | shared by both callers |
| 3 | human "Send now", 1:1 | `jobs/tourReminders.ts` `forceSendReminder` | |
| 4 | GET reminders list | `routes/tourReminders.ts` | preview surface |
| 5 | `viewOf` | `routes/tourReminders.ts` | serves PATCH + send-now 200 AND 409 |
| 6 | contact timeline Upcoming | `routes/contactTimeline.ts:626` | MISSED BY v1 - preview surface |
| 7 | no-show draft | `routes/tourReminders.ts` | UNCHANGED (token-free rung, D2) |

**Site 6 is the blocking find.** `contactTimeline.ts:626` calls
``resolveMessage(`tour.${row.kind}`)`` with NO vars. The moment the defaults
declare `{when}`, `resolve.ts:39-41` throws in strict mode (defaults are always
strict), so `GET /api/contacts/:id/timeline` returns 500 for any tenant with an
upcoming tour rung. It is also a THIRD preview surface subject to the same drift
the shared composer exists to prevent.

Sites 1-6 must render IDENTICALLY for the same tour and rung; that is the
invariant the parity test protects. `RemindersPanel.tsx` renders `rung.body`
verbatim as the preview of what will send, so drift between the send sites and
the preview sites is a lying UI, not a cosmetic bug.

**`viewOf` shape.** `viewOf` is SYNC and serves four responses (`:209`, `:221`,
`:269`, `:280`). The composed body needs async unit and settings reads, so it
must be resolved ONCE per request and passed INTO `viewOf` - never resolved per
row inside it. This is the shape most likely to be got wrong.

**Wiring.**
- `unitsRepo` joins `RunDueTourRemindersDeps` (jobs) and `TourRemindersRouterDeps`
  (routes, optional-with-factory-default like its siblings). Fetch via
  `unitsRepo.getById(tour.unitId)`.
- `contactTimeline.ts` ALREADY has `unitsRepo` and `settingsRepo` in its deps
  (`:102`, `:95`) - wiring there is cheap.
- `routes/dev.ts:241` builds `tourReminderDeps` for
  `POST /__dev/tour-reminders/tick` - THE path every e2e reminder assertion runs
  through. Its return type IS annotated `(): RunDueTourRemindersDeps`, so
  typecheck catches a missing `unitsRepo` here (unlike the cast below). Named
  explicitly because section 8's e2e strategy composes expected bodies from
  seeded fixture data: an unwired dev tick would make every e2e body silently
  lose its address and fail the suite in a confusing way.
- `claimSend` signature change: `tourRemindersRepo.ts:96` becomes
  `claimSend(reminderId, claimedAt, sentBody)`, adding `#sentBody` to the SAME
  conditional `UpdateExpression` (genuinely atomic, no second write). Fake blast
  radius is ONE implementation: `app/test/helpers/twilioWebhookHarness.ts:2085`.
  The other `claimSend` hits call the real repo, and `:2179` is
  `placementNudgesRepo`'s separate `claimSend` - do NOT touch it.
- TYPECHECK BLIND SPOT: `contactTimeline.ts:613` builds
  `{ conversationsRepo } as unknown as RunDueTourRemindersDeps`. That cast will
  silently swallow a new required field, so typecheck will NOT flag the one
  router that most needs the unit read. `worker.ts` builds its deps as an
  unannotated literal but PASSES them to `runDueTourReminders`, so it IS caught.
  Test blast radius is one `runDeps` literal at `tourReminders.test.ts:107` plus
  seven spreads - a single edit.

**Cost, corrected.** v1's "NO N+1" was wrong. Sites 4, 5 and 7 are single-tour.
Site 6 is NOT: `contactTimeline.ts:597-633` is a `Promise.all` over
`toursRepo.listByTenant(contactId)`, so it costs one unit read per tour with
upcoming rungs, per contact-page load. Deduplicate by `unitId` within the walk.

v1 also claimed "neither needs a new settings read on the common path". FALSE:
`tourReminders.ts:324` calls `readQuietHoursWindow` only inside
`if (tour.tourType === 'self_guided' && hasUpcoming)`. A `landlord_led` tour's
GET, and every PATCH and send-now response, read settings ZERO times today. All
of them now need the timezone. Read it once per request.

**Failure posture** (the `resolveWithSettings` precedent): a missing unit, a
unit-read failure, a missing `unitId`, or an empty address ALL degrade to the
`_no_address` variant, which requires no error handling at any call site. A read
failure logs at warn with IDs only.

The ONE partial case is a missing/invalid `scheduledAt`, which throws
`UncomposableReminderError` by design. Section 5 specifies exactly how each call
site contains it - send paths claim-skip with `invalid_schedule`, read paths
degrade and never 500. Composition is NOT total; the call sites are what make the
system total.

**Preserve the announcement `kind` tag.** `announceGroupReminder:768` passes
``kind: `tour.${row.kind}` `` to `sendRelayAnnouncement`. Keep it derived from
`row.kind`, NOT from the eight-way catalog id the composer selects - otherwise
every log line forks by address presence. Verified low severity (`kind` is
log-only in `relayAnnouncements.ts`, never persisted), but it is a one-word
mistake that is easy to make while touching this exact function.

## 7. Folded in: ASCII enforcement on code-controlled copy

**NEW `app/src/lib/smsEncoding.ts`** - pure:

```
analyzeSms(body: string): {
  encoding: 'GSM-7' | 'UCS-2';
  units: number;            // septets or UTF-16 code units
  segments: number;
  nonGsm7Chars: string[];   // distinct offending characters, for failure messages
}
```

Implements the GSM-7 basic and extension tables. `analyzeSms` PRICES GSM-7 - the
eight ASCII characters `^ { } \ [ ~ ] |` are extension characters costing 2
septets each, so ASCII and cheap-GSM-7 are not nested, and segment counts cannot
be derived from a character-range check alone.

**The catalog test enforces the STRICTER ASCII rule deliberately.** It rejects
characters that GSM-7 would price at one septet (POUND SIGN, E-ACUTE, N-TILDE
- all in the GSM-7 basic table, all rejected by this test). That is
intentional, not an oversight: ASCII is a rule a human can apply by eye and a
reviewer can enforce without consulting a table. Anyone tempted to "fix" the test
into a GSM-7 check should not - that would let the em dash's cousins back in.
`analyzeSms` reports GSM-7 pricing; the test asserts ASCII. Both facts are true
and they serve different jobs. (This reconciles the naming with the folded-in
issue, which describes the criterion as GSM-7.)

**THE BOUNDARY (Cameron's explicit ruling).** Enforcement applies to strings WE
control, never to strings the user controls.

| ours - ASCII enforced by test | theirs - passes through VERBATIM |
|---|---|
| every `channel: 'sms'` catalog DEFAULT | unit addresses |
| `formatLocalDate` / `formatLocalTime` output | operator overrides |
| | contact names |

A landlord who types `O'Brien Court` with a curly apostrophe gets it sent exactly
as typed. We do NOT sanitize, transliterate, or "helpfully" normalize user data:
rewriting an address is the same category of mistake as stripping the accent from
a tenant named Jose, just less visible. The cost is stated in section 4 and
accepted.

**Consequent copy edits** (forced by the new test - an allowlist of known
violations would be worse than a one-character fix):

| entry | change |
|---|---|
| `nudge.receipt_check` | U+2014 -> `-` (was UCS-2 95u 2seg) |
| `nudge.approval_check` | U+2014 -> `-` (was UCS-2 63u 1seg) |
| `nudge.rta_window_closing` | U+2014 -> `-` (was UCS-2 87u 2seg) |

All three become single-segment GSM-7; copy reads identically.

VERIFIED SAFETY: these three are the ONLY non-ASCII characters in any
`channel: 'sms'` default. Every non-ASCII character in `lib/smsCompliance.ts` is
inside a COMMENT; the string VALUES (`WELCOME_SMS`, `STOP_CONFIRMATION`,
`HELP_REPLY`, `WEB_FORM_CONSENT_COPY`, `RELAY_INTRO_IDENTITY`) are pure ASCII. The
test therefore CANNOT force a rewording of A2P-filed compliance copy - which would
be a serious hazard if it did.

On close: update `docs/issues/sms-copy-non-gsm7-characters.md` to record what
shipped and narrow it to the deferred Settings advisory. It stays `status: open`.

## 8. Testing

Unit:
- `localTime` - DST on both sides, midnight and noon 12-hour edges, a non-US
  zone, and an ASCII-only assertion on the output.
- `address.formatStreet` - `line1` only, `line1`+`line2`, legacy string, empty,
  undefined; plus `formatAddress` still correct after the refactor.
- `smsEncoding` - GSM-7 vs UCS-2 classification, the 160/153 and 70/67
  boundaries, and the 2-septet extension characters.
- `tourCopy` - every rung with and without an address, legacy string address,
  a missing `scheduledAt` throwing `UncomposableReminderError`, and
  `analyzeSms(...).segments === 1` for every body composed with the seeded address.
- `dateTime` - the new optional `timeZone` parameter renders in the given zone,
  AND omitting it is byte-identical to today's output. The second half is what
  proves `DeadlinesNudgesCard` / `PlacementNowCard` / `TourDetail` are unchanged.

Containment (pins section 5 - each has a specific verified failure mode):
- a rung whose `scheduledAt` is unusable is CLAIM-SKIPPED with `invalid_schedule`
  on the send path, and is NOT re-listed by a subsequent `listDue` - the
  regression test for the every-60s-forever retry loop.
- each read path (sites 4, 5, 6) returns 200 with a degraded body rather than
  500 when composition throws.

Catalog:
- Every `channel: 'sms'` DEFAULT is ASCII. The durable guard of section 7; its
  failure message must name the offending characters.

REQUIRED mechanical guard (not a nice-to-have - the missed site 6 proves the need):
- A test asserting NO file outside `messages/tourCopy.ts` calls `resolveMessage`
  with a `tour.*` id other than `tour.no_show_checkin`. Nothing at the type level
  ties "this id declares tokens" to "this call site supplies them" -
  `resolveMessage(id)` is valid TS for every id - so this change fails open into
  runtime 500s rather than typecheck errors. This test is the only structural
  defense.

Boundary (pins section 7 from BOTH sides - this pair is the point):
- composing with an ASCII address yields ASCII output;
- composing with a DELIBERATELY non-ASCII address yields that address UNCHANGED
  in the body, so a future "helpful" sanitizer cannot sneak in.

Parity (the invariant of section 6):
- the GET reminders body, the `viewOf` body, and the contact-timeline body all
  EQUAL the body the job sends, for the same tour and rung. Cover the 1:1 and
  group routes and the with/without-address cases.

History (pins D4):
- a rung sent, then the tour rescheduled (or the unit address edited), still
  renders its ORIGINAL body from `sentBody` - while a pending rung on the same
  tour renders the NEW details.

Known regressions to fix (verified, beyond the two files v1 named):
- `app/test/messages/resolve.test.ts:21` - uses `tour.day_before` as its
  token-free example; now throws.
- `app/test/contactTimeline.test.ts:673-674` and `app/test/devGating.test.ts:263-264`
  - `resolveMessage('tour.confirmation')` at MODULE SCOPE, so the whole file fails
  to load.
- `app/test/relayApi.test.ts:1335` - asserts `toContain('Your tour is confirmed')`.
- `app/test/tourReminders.test.ts`, `app/test/tourRemindersApi.test.ts`.

e2e - a DESIGN decision, not a mechanical fix:
`e2e/scenarios/steps.ts:131-136` derives `TOUR_REMINDER_BODIES` directly from
`MESSAGE_CATALOG[...].default`. After this change those constants would literally
contain `{when}`.

THREE step helpers consume it, at `:1801`, `:1827` and `:1839`, and they do NOT
all assert the same way:
- `:1801` and `:1839` compare against the fake-provider OUTBOX (`m.body === body`
  at `:1811` and `:1848`) - `expectReminderInGroup` and `expectReminderTo1to1`.
- `:1827` (`expectReminderVisibleInGroupThread`) asserts `getByText(body)`
  against the DASHBOARD group thread. It is a DOM text match, not an outbox
  match, so it fails differently and is the easiest of the three to miss.

The harness must import the real `composeTourReminderBody` and build expected
bodies from the seeded fixture data (the cross-workspace import path already
exists - `steps.ts` imports `MESSAGE_CATALOG` today). This keeps exact equality
AND one source of truth. Where a step lacks the tour context, fall back to a
kind-distinctive substring. Consumers to update: `tours.spec.ts`,
`scheduled-visibility.spec.ts`, `quiet-hours.spec.ts`, and
`dashboard-next/tour-comms-pane.spec.ts` (see W4).

Panel e2e: the Reminders panel shows time and address in the rung preview, with
the chip in the composing timezone (D8). Honor the known flake
`tour-reminders-panel-e2e-flake`.

## 9. Risks and watch items

- **W1 - preview/send drift** across SIX sites is the headline risk and the reason
  the composer is shared. A reviewer should check that no call site rebuilds a
  body inline. The mechanical guard test in section 8 is the enforcement.
- **W2 - the `contactTimeline.ts:613` cast** hides the new required dep from
  typecheck. Highest-risk single line in this change.
- **W3 - ASCII rule scope.** The test must assert ONLY catalog defaults and
  formatter output. A reviewer seeing it reach into user data should treat that as
  a spec violation, not an improvement.
- **W4 - concurrent branches.** `feat/contact-comms-pane` is merge-ready but
  UNMERGED and owns `e2e/tests/dashboard-next/tour-comms-pane.spec.ts`, a
  consumer of `TOUR_REMINDER_BODIES`. Whichever lands second must reconcile that
  file. `feat/contact-rosters` is in planning. Sync `main` ONCE before declaring
  done and re-run all three gates on the updated base.
- **W5 - timezone source.** Resolve ONLY through `resolveQuietHoursTimezone`
  (D8). A settings-read failure falls back to `DEFAULT_ORG_SETTINGS`
  (America/New_York), never to UTC - reusing `readQuietHoursWindow` gets this
  free, so do not add a second settings path.
- **W6 - `sentBody` and the claim.** `claimSend` IS the `sentAt` stamp. The body
  must be composed BEFORE the claim and written in the same update; a compose
  failure after the claim would burn the rung. THREE of the four send sites
  currently compose AFTER claiming and must be reordered - see D4's table, which
  is the evidence for this watch item. What makes the reorder safe is NOT that
  composition is total (it is not - section 5), but that every caller CONTAINS
  the one partial case: send paths claim-skip with `invalid_schedule` instead of
  letting the throw reach the per-row catch at `tourReminders.ts:379-390`, which
  would otherwise retry the row every 60s forever.
- **W7 - read paths must never 500 over copy.** Sites 4, 5 and 6 have no
  equivalent of the poll's per-row guard. An uncontained compose throw is a 500
  on the tour page and the contact timeline. Section 5 requires the catch-and-
  degrade; a reviewer should verify it exists at all three.

## 10. Out of scope, and follow-up issues to file

No arm-time change, no schema change beyond the `sentBody` attribute, no new
dependency, no infra.

File these before handback:
1. **Convert seeded unit addresses to structured `Address`** (D5). Note the
   byte-stable `lean` profile risk.
2. FILED: `automated-sms-length-guard` (D9) - a universal length guard at the
   automated-send layer, covering every automated message rather than one
   feature. Needs the send service to know the message id, which it does not
   today, and should finally validate the `maxChars` the catalog has always
   declared and never enforced. This spec adds NO tour-local cap in its place.
3. Narrow `sms-copy-non-gsm7-characters` to the deferred Settings-UI advisory
   (section 7).
