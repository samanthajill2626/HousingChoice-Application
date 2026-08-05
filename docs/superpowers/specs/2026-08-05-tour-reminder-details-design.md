# Tour reminders carry the actual time and address

Date: 2026-08-05
Status: APPROVED (Cameron, this session)
Branch: `feat/tour-reminder-details` (worktree `w:/tmp/tour-reminder-details`, cut from `main` @ed75d9e8)

## 1. Problem

Every tour reminder is generic, token-free copy:

```
tour.confirmation     Your tour is confirmed. We'll send reminders as it approaches.
tour.day_before       Reminder: your property tour is tomorrow.
tour.morning_of       Good morning! Your property tour is today.
tour.en_route         Your tour is coming up soon. Text us when you're on the way!
tour.no_show_checkin  Hi! We noticed you may have missed your tour. Want to reschedule?
```

None of it answers the two questions a tenant actually has the morning of a tour:
what time, and where. That gap matters most for `self_guided` tours, where nobody
is on site to meet them. The catalog already has `{token}` interpolation
machinery (`messages/resolve.ts`) and the send path already holds the tour, its
`unitId`, and the org timezone, so both facts are cheap to add.

A second, smaller defect rides along. Three placement-nudge defaults contain a
U+2014 EM DASH, which forces the whole message to UCS-2 encoding and its 70-char
budget; two of them consequently bill as two segments. Nothing enforces the
character range on catalog copy today. Filed as
`docs/issues/sms-copy-non-gsm7-characters.md`; the mechanism half is folded into
this spec (section 7) because this feature needs the same analysis helper for its
own tests, and building it twice is waste.

## 2. Scope

IN:
- The four auto-armed rungs gain org-local time and the unit's street address.
- One shared body composer, used by every call site so the dashboard preview
  cannot drift from what actually sends.
- `analyzeSms()` plus a catalog-wide ASCII test for code-controlled copy, and the
  three em-dash fixes that test forces.

OUT (explicitly deferred):
- The Settings-UI advisory that would show an operator the encoding and segment
  count of an override. Stays in the issue, which stays open narrowed to it.
- `{firstName}` personalization of reminders.
- Per-recipient timezones. The seam already exists in
  `resolveQuietHoursTimezone(settings, _contact)` and is untouched here.
- Any change to arm-time scheduling. Rungs, dueAts, clamping, and the skip rules
  are all unchanged.

## 3. Decisions

**D1. One body for both routes (option A).** Reminders for `landlord_led` and
`pm_team` tours go to the tour's masked GROUP thread, where the landlord and the
tenant read the identical text. Rather than maintain per-route copy variants, the
copy is written NEUTRALLY: no possessive, address-led. "Tour at 412 Oak St is
today at 3:00 PM" reads correctly to either party.

Rejected: per-route catalog entries (doubles the tour entries and doubles what an
operator must keep in sync later); naming the tenant in the group copy (puts a
first name into the thread on every rung).

Side benefit: leading with the address sidesteps a glossary drift. The current
copy says "your property tour" to a TENANT, but per `documentation/GLOSSARY.md`
the tenant-facing noun is "home", not "property". Naming the actual address
avoids having to pick a noun at all.

**D2. `no_show_checkin` is UNCHANGED.** Cameron's call: when you are not certain
someone no-showed, the vaguer wording is kinder. It stays token-free, stays
second-person, and keeps its current text verbatim.

**D3. `en_route` keeps "Text us when you're on the way!"** It is aimed at the
tenant and slightly odd for a landlord reading the group thread, and that is
acceptable (Cameron's call). Not made neutral.

**D4. Composition happens at SEND and at READ, never at arm time.** No body is
stored on the reminder row. A rescheduled tour's preview and its eventual text
both self-correct with no migration and no stored-copy staleness.

**D5. Address means STREET ONLY (`line1` + `line2`).** No city/state/zip: the
tenant does not need it to navigate and it is noise. A legacy plain-string
address passes through as-is (it may contain city/state; acceptable).

**D6. ASCII is enforced on OUR strings only.** See section 7.

## 4. Copy

Catalog templates after this change:

```
tour.confirmation     Tour confirmed{where} for {when}. We'll text reminders as it gets closer.
tour.day_before       Reminder: tour{where} is tomorrow, {when}.
tour.morning_of       Good morning! Tour{where} is today at {time}.
tour.en_route         Tour{where} starts at {time}. Text us when you're on the way!
tour.no_show_checkin  (UNCHANGED, no tokens)
```

Tokens, all composed in code (the `relay.intro` `{members}` precedent):

| token | value | example |
|---|---|---|
| `{when}` | `formatLocalDate` + " at " + `formatLocalTime` | `Thu, Jul 23 at 3:00 PM` |
| `{time}` | `formatLocalTime` | `3:00 PM` |
| `{where}` | " at " + street, or EMPTY | ` at 412 Oak St Apt 2` |

`{where}` CARRIES ITS OWN LEADING SPACE and the templates have no space before
it, so the empty case produces no double space. This is the one subtlety an
operator writing an override must know; the catalog entry comment must say so.

All four entries declare `vars: ['when', 'time', 'where']` and the composer
always supplies all three. `interpolate` only substitutes tokens that actually
appear in a template, so declaring all three everywhere is safe, and an empty
string is a supplied value (no strict-throw).

Rendered, with a short address:

```
Tour confirmed at 412 Oak St Apt 2 for Thu, Jul 23 at 3:00 PM. We'll text reminders as it gets closer.
Reminder: tour at 412 Oak St Apt 2 is tomorrow, Thu, Jul 23 at 3:00 PM.
Good morning! Tour at 412 Oak St Apt 2 is today at 3:00 PM.
Tour at 412 Oak St Apt 2 starts at 3:00 PM. Text us when you're on the way!
```

With NO address on file:

```
Tour confirmed for Thu, Jul 23 at 3:00 PM. We'll text reminders as it gets closer.
Reminder: tour is tomorrow, Thu, Jul 23 at 3:00 PM.
Good morning! Tour is today at 3:00 PM.
Tour starts at 3:00 PM. Text us when you're on the way!
```

VERIFIED segment counts (this session, GSM-7 basic + extension tables): the eight
variants above, plus the same four rendered against a 53-character address
(twelve in total), are ALL GSM-7 single-segment. The longest is 139 units against
a 160-unit budget. Adding time and address costs NOTHING in segments.

Redundancy on `day_before` ("tomorrow" plus the explicit date) and `morning_of`
("today" plus the time) is DELIBERATE. Both words are currently guaranteed
accurate by the arm-time rules -- the stale-`day_before` supersession and the
`past_event` skip -- but spelling out the date costs no segment and survives any
future change to those rules.

## 5. Modules

**NEW `app/src/lib/localTime.ts`** -- pure, structural inputs, no clock reads, no
repo imports (the `lib/quietHours.ts` discipline, including its cached
`Intl.DateTimeFormat` idiom):

```
formatLocalDate(iso: string, timezone: string): string   // "Thu, Jul 23"
formatLocalTime(iso: string, timezone: string): string   // "3:00 PM"
```

Both normalize U+00A0 NO-BREAK SPACE and U+202F NARROW NO-BREAK SPACE to a plain
space before returning. RATIONALE: ICU 72 shipped U+202F in exactly the position
before AM/PM. The ICU in this repo's Node 24 (ICU 78) emits a plain ASCII space
-- VERIFIED this session across `hour`/`minute`, `hour12`, `timeStyle`,
`dateStyle+timeStyle`, and `toLocaleTimeString` -- but a Node bump must not be
able to silently flip every reminder to UCS-2 and halve its budget. The
normalization plus its test is the guard.

**NEW `app/src/messages/tourCopy.ts`** -- pure, no repos, no clock:

```
composeTourReminderBody(input: {
  kind: ReminderKind;
  scheduledAt: string;
  timezone: string;
  address?: Address | string;
  overrides?: Partial<Record<MessageId, string>>;
}): string
```

Builds the three fragments and delegates to `resolveMessage`. Honors operator
overrides exactly as `resolveMessage` does today.

**EXTENDED `app/src/lib/address.ts`** -- add `formatStreet(a)` beside the
existing `formatAddress`: joins `line1` and `line2` with a space, returns a
legacy plain-string address trimmed and as-is, returns `''` for `undefined` or an
all-empty address.

**NEW `app/src/lib/smsEncoding.ts`** -- see section 7.

## 6. Call sites and wiring

There are SIX `resolveMessage('tour.<kind>')` sites today. FIVE move to
`composeTourReminderBody`; the sixth stays as it is:

| # | site | file |
|---|---|---|
| 1 | poll, 1:1 route | `jobs/tourReminders.ts` `processReminderRow` |
| 2 | poll, group route | `jobs/tourReminders.ts` `announceGroupReminder` |
| 3 | human "Send now" | `jobs/tourReminders.ts` `forceSendReminder` |
| 4 | GET reminders list | `routes/tourReminders.ts` |
| 5 | PATCH response rebuild | `routes/tourReminders.ts` |
| 6 | no-show draft | `routes/tourReminders.ts` (UNCHANGED -- token-free rung) |

Site 6 keeps calling `resolveMessage` because D2 leaves that rung token-free.
Sites 1-5 must all render IDENTICALLY for the same tour and rung; that is the
invariant the parity test in section 8 protects. The Reminders panel
(`dashboard/src/routes/tours/RemindersPanel.tsx`) renders `rung.body` verbatim as
the preview of what will send, so a drift between sites 1-3 and sites 4-5 is a
lying UI, not a cosmetic bug.

Wiring:
- `unitsRepo` joins `RunDueTourRemindersDeps` (jobs) and `TourRemindersRouterDeps`
  (routes, optional-with-factory-default like its siblings). Fetch via
  `unitsRepo.getById(tour.unitId)`.
- Timezone: the poll already reads the quiet-hours window ONCE per tick
  (`readQuietHoursWindow`) and `window.timezone` is the org zone; the routes
  already import `readQuietHoursWindow` for the suppression estimate. Neither
  needs a new settings read on the common path.
- Cost: one extra unit read per send and per tour-page load. Both preview routes
  are single-tour, so there is NO N+1.

FAILURE POSTURE (the `resolveWithSettings` precedent): a missing unit, a unit-read
failure, a missing `unitId`, or an empty address ALL degrade to the no-address
variant. Composition never throws and never blocks a send. A read failure logs at
warn with IDs only.

## 7. Folded-in: ASCII enforcement on code-controlled copy

**NEW `app/src/lib/smsEncoding.ts`** -- pure:

```
analyzeSms(body: string): {
  encoding: 'GSM-7' | 'UCS-2';
  units: number;          // septets or UTF-16 code units
  segments: number;
  nonAscii: string[];     // distinct offending characters, for the failure message
}
```

Implements the GSM-7 basic and extension tables. Note the eight ASCII characters
`^ { } \ [ ~ ] |` are GSM-7 EXTENSION characters costing 2 septets each, so ASCII
and cheap-GSM-7 are not nested; `analyzeSms` prices them correctly, which is why
the test asserts segment counts and not merely a character range.

**THE BOUNDARY (Cameron's explicit ruling).** Enforcement applies to strings WE
control, never to strings the user controls.

| ours -- ASCII enforced by test | theirs -- passes through VERBATIM |
|---|---|
| every `channel: 'sms'` catalog DEFAULT | unit addresses |
| `formatLocalDate` / `formatLocalTime` output | operator overrides (`welcomeText`, `missedCallAutoText`) |
| | contact names |

A landlord who types `O'Brien Court` with a curly apostrophe gets it sent exactly
as typed. We do NOT sanitize, transliterate, or "helpfully" normalize user data:
rewriting an address is the same category of mistake as stripping the accent from
a tenant named Jose, just less visible. The cost is accepted and understood: one
non-ASCII character in a unit address flips that tour's reminders to UCS-2 and
its 70-char budget, which pushes three of the four rungs to two segments
(`morning_of` at 59 units stays under). It is per-unit, self-inflicted by data
entry, and surfaceable later by the deferred Settings advisory.

**Consequent copy edits** (forced by the new test -- an allowlist of known
violations would be worse than a one-character fix):

| entry | change |
|---|---|
| `nudge.receipt_check` | U+2014 -> `-` (was UCS-2 95u 2seg) |
| `nudge.approval_check` | U+2014 -> `-` (was UCS-2 63u 1seg) |
| `nudge.rta_window_closing` | U+2014 -> `-` (was UCS-2 87u 2seg) |

All three become single-segment GSM-7. Copy reads identically.

On close: update `docs/issues/sms-copy-non-gsm7-characters.md` to record what
shipped and narrow it to the deferred Settings advisory. It stays `status: open`.

## 8. Testing

Unit:
- `localTime` -- DST on both sides, midnight and noon 12-hour edges, a non-US
  zone, and an ASCII-only assertion on the output.
- `address.formatStreet` -- `line1` only, `line1`+`line2`, legacy string, empty,
  undefined.
- `tourCopy` -- every rung with and without an address, legacy string address,
  operator override still honored, and `analyzeSms(...).segments === 1` on every
  composed body with an ASCII address.
- `smsEncoding` -- GSM-7 vs UCS-2 classification, the 160/153 and 70/67
  boundaries, and the 2-septet extension characters.

Catalog:
- Every `channel: 'sms'` DEFAULT is ASCII. This is the durable guard from section
  7; its failure message must name the offending characters.

Boundary (pins section 7 from BOTH sides -- this pair is the point):
- composing with an ASCII address yields ASCII output;
- composing with a DELIBERATELY non-ASCII address yields that address UNCHANGED
  in the body, so a future "helpful" sanitizer cannot sneak in.

Parity (the invariant of section 6):
- the GET reminders route's `body` for a given tour and rung EQUALS the body the
  job sends for that same tour and rung. Cover both the 1:1 and group routes, and
  both the with-address and no-address cases.

Regression on existing suites: `app/test/tourReminders.test.ts`,
`app/test/tourRemindersApi.test.ts`, and any `seed/cast.ts`-backed body
assertions, since seeded reminder rows now interpolate from seeded tour data.

e2e: the tour page's Reminders panel shows the time and address in the rung
preview. Honor the known flake `tour-reminders-panel-e2e-flake`.

## 9. Risks and watch items

- **W1 -- preview/send drift** is the headline risk of this design and the reason
  the composer is shared rather than duplicated. Any reviewer should check that
  no call site rebuilds the body inline.
- **W2 -- `{where}`'s leading space.** An operator override written as
  `Tour at {where}` produces a double space. Documented in the catalog comment;
  consider it a known ergonomic wart of the token approach, not a defect.
- **W3 -- ASCII rule scope.** The test must assert ONLY catalog defaults and
  formatter output. A reviewer seeing it reach into user data should treat that
  as a spec violation, not an improvement.
- **W4 -- concurrent branches.** `feat/contact-comms-pane` (merge-ready, unmerged)
  touches the tours dashboard area and `feat/contact-rosters` is in planning. Sync
  `main` once before declaring done, per the repo's branch-hygiene rule, and
  re-run all three gates on the updated base.
- **W5 -- timezone source.** The org timezone comes from the same settings row the
  quiet-hours window reads. A settings-read failure falls back to
  `DEFAULT_ORG_SETTINGS` (America/New_York), never to UTC -- reusing
  `readQuietHoursWindow` gets this for free, so do not add a second settings path.

## 10. Out of scope

No arm-time change, no schema change, no new dependency, no infra. No stored
message bodies. No dashboard work beyond whatever the existing panel needs to
keep rendering `rung.body`.
