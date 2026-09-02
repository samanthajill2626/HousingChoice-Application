# SLICE S2 REPORT - Task 4 Steps 1-5 (catalog, composer, composer tests)

Worktree: `W:\tmp\tour-reminder-ladder`, branch `feat/tour-reminder-ladder`,
base commit `e8e20c92` (S1's last). **NOTHING COMMITTED. Tree left dirty on
purpose** - S3 finishes Task 4 and commits it as one commit.

Files touched (all uncommitted):

- `app/test/tourCopy.test.ts` - rewritten (Step 1)
- `app/src/messages/catalog.ts` - tour block rewritten (Step 3)
- `app/src/messages/tourCopy.ts` - rewritten (Step 4)
- `app/test/messages/resolve.test.ts` - one stale comment corrected (A4-14)

---

## 1. THE RED (Step 2)

`cd app && npx vitest run test/tourCopy.test.ts` - **EXIT 1**, 19 failed / 8
passed of 27.

**Step 2's predicted shape was HALF RIGHT and the difference is worth
recording: vitest did NOT report compile errors.** Vitest runs through
esbuild, which strips types without checking them, so the missing
`tourType`/`names` input fields produced NO diagnostic at all in this run. The
red was entirely (a) copy mismatches and (b) `TypeError: ... is not a function`
on the two new exports. The type-level red is real but only visible under
`tsc` - it is quoted in section 5 below.

Failure list, ANSI stripped, verbatim:

```
 FAIL  test/tourCopy.test.ts > composeTourReminderBody: the founder copy (Sam, 2026-08-24) > day_before greets by first name and uses the BARE time
AssertionError: expected 'Hey, confirming your tour tomorrow at...' to be 'Hey Alice, confirming your tour tomor...' // Object.is equality
 FAIL  test/tourCopy.test.ts > composeTourReminderBody: the founder copy (Sam, 2026-08-24) > morning_of carries the address as a trailing sentence
AssertionError: expected 'Good morning, excited for you to see ...' to be 'Hey Alice, looking forward to having ...' // Object.is equality
 FAIL  test/tourCopy.test.ts > composeTourReminderBody: the founder copy (Sam, 2026-08-24) > morning_of with NO address ends cleanly - no trailing "Address is", no {where}, no double space
AssertionError: expected 'Good morning, excited for you to see ...' to be 'Hey Alice, looking forward to having ...' // Object.is equality
 FAIL  test/tourCopy.test.ts > composeTourReminderBody: the founder copy (Sam, 2026-08-24) > en_route forks on TOUR TYPE, and pm_team takes the landlord-led wording
AssertionError: expected 'Hey, see you soon. Please let me know...' to be 'Hey Alice, can you please text me whe...' // Object.is equality
 FAIL  test/tourCopy.test.ts > composeTourReminderBody: the founder copy (Sam, 2026-08-24) > no property-contact name DEGRADES landlord-led AND pm_team to the self-guided wording
AssertionError: expected 'Hey, see you soon. Please let me know...' to be 'Hey Alice, can you please text me whe...' // Object.is equality
 FAIL  test/tourCopy.test.ts > composeTourReminderBody: the founder copy (Sam, 2026-08-24) > no tenant first name greets with "there"
AssertionError: expected 'Hey, confirming your tour tomorrow at...' to be 'Hey there, confirming your tour tomor...' // Object.is equality
 FAIL  test/tourCopy.test.ts > composeTourReminderBody: the founder copy (Sam, 2026-08-24) > no_show_checkin greets by name (D2 reversed - ruled, spec section 3)
AssertionError: expected 'Hi! Do you need to reschedule?' to be 'Hi Alice! Do you need to reschedule?' // Object.is equality
 FAIL  test/tourCopy.test.ts > address shapes (all through the morning_of clause) > an all-empty structured address takes the no-address rendering
AssertionError: expected 'Good morning, excited for you to see ...' to be 'Hey Alice, looking forward to having ...' // Object.is equality
 FAIL  test/tourCopy.test.ts > address shapes (all through the morning_of clause) > a NULL address composes cleanly instead of throwing (seeds write raw items)
AssertionError: expected 'Good morning, excited for you to see ...' to be 'Hey Alice, looking forward to having ...' // Object.is equality
 FAIL  test/tourCopy.test.ts > address shapes (all through the morning_of clause) > a structured address contributes street only
AssertionError: expected 'Good morning, excited for you to see ...' to be 'Hey Alice, looking forward to having ...' // Object.is equality
 FAIL  test/tourCopy.test.ts > address shapes (all through the morning_of clause) > a legacy string address passes through whole
AssertionError: expected 'Good morning, excited for you to see ...' to be 'Hey Alice, looking forward to having ...' // Object.is equality
 FAIL  test/tourCopy.test.ts > token declarations > every tour entry declares all four name tokens plus when/time (spec 6)
AssertionError: expected 9 to be 7 // Object.is equality
 FAIL  test/tourCopy.test.ts > token declarations > morning_of declares BOTH where and addressLine (spec 6.4: where stays for future edits)
AssertionError: expected [ 'when', 'time', 'where' ] to include 'addressLine'
 FAIL  test/tourCopy.test.ts > assessNamesReadFailure - the derived failure-scope table > reminderNamesUsed reads the TEMPLATES: confirmation renders no name, everything else greets the tenant
TypeError: (0 , reminderNamesUsed) is not a function
 FAIL  test/tourCopy.test.ts > assessNamesReadFailure - the derived failure-scope table > confirmation is never blocked - its untouched copy renders no name
TypeError: (0 , assessNamesReadFailure) is not a function
 FAIL  test/tourCopy.test.ts > assessNamesReadFailure - the derived failure-scope table > a tenant-read failure BLOCKS THE SEND but does NOT withhold the preview (6.3b: previews degrade to "Hey there,")
TypeError: (0 , assessNamesReadFailure) is not a function
 FAIL  test/tourCopy.test.ts > assessNamesReadFailure - the derived failure-scope table > a property/unit read failure on the en_route type fork blocks send AND withholds the preview (never a different ENTRY)
TypeError: (0 , assessNamesReadFailure) is not a function
 FAIL  test/tourCopy.test.ts > assessNamesReadFailure - the derived failure-scope table > a unit-read failure alone never blocks an address-only rung (never lost over a missing street)
TypeError: (0 , assessNamesReadFailure) is not a function
 FAIL  test/tourCopy.test.ts > assessNamesReadFailure - the derived failure-scope table > TRIPWIRE: no entry renders the property token without FORKING on it - red here means a copy edit just activated the dead tokenBlanked branch and owes a preview rule (see assessNamesReadFailure)
TypeError: (0 , reminderNamesUsed) is not a function
 Test Files  1 failed (1)
      Tests  19 failed | 8 passed (27)
```

(The 8 that passed pre-implementation were the three scheduledAt-precondition
tests, the two surviving ASCII/UCS-2 tests, the confirmation-untouched test,
the leak-guard `vars` test, and the exhaustive matrix - the matrix passed
because the OLD id derivation still resolved for every kind it was fed.)

---

## 2. THE GREEN (Step 5)

`cd app && npx vitest run test/tourCopy.test.ts` - **EXIT 0**

```
 v test/tourCopy.test.ts (27 tests) 31ms

 Test Files  1 passed (1)
      Tests  27 passed (27)
```

`cd app && npx vitest run test/messages/catalog.test.ts test/messageCatalogAscii.test.ts`
- **EXIT 0**

```
 v test/messageCatalogAscii.test.ts (46 tests) 5ms
 v test/messages/catalog.test.ts (8 tests) 8ms

 Test Files  2 passed (2)
      Tests  54 passed (54)
```

No catalog invariant needed a workaround. The no-dead-tokens rule never fires
(all 7 tour entries stay `editable: true`); the token-used-but-not-declared
rule is satisfied by declaring `addressLine` on `tour.morning_of`.

Extra run, because A4-14 touched it:
`cd app && npx vitest run test/messages/resolve.test.ts` - **EXIT 0**

```
 Test Files  1 passed (1)
      Tests  14 passed (14)
```

Lint on the four touched files (`npx eslint <4 paths>`): **EXIT 0**, no output.

---

## 3. THE EXACT `ComposeTourReminderInput` AS SHIPPED

Byte-exact from `app/src/messages/tourCopy.ts`:

```ts
export interface ComposeTourReminderInput {
  kind: ReminderKind;
  /** REQUIRED even though TourItem.scheduledAt is optional: a reminder row cannot
   *  exist for a time-less tour (armTourReminders returns early without one, and
   *  PATCH cannot clear it), so every caller has one in hand. */
  scheduledAt: string;
  /** IANA zone. Resolve it via resolveQuietHoursTimezone - never read
   *  settings.timezone directly (spec D8). */
  timezone: string;
  /** REQUIRED, no default: a defaulted tourType would silently give a
   *  landlord-led tour the self-guided wording at any call site that forgot
   *  it (spec 9.0). */
  tourType: TourType;
  /** REQUIRED (may be {}): resolved by the CALLER via
   *  lib/tourContacts.ts - this composer stays pure and synchronous (spec
   *  6.3a). Absent fields compose the fallbacks (spec 6.3). */
  names: TourContactNames;
  address?: Address | string;
  overrides?: Partial<Record<MessageId, string>>;
}
```

Field ORDER as declared: `kind, scheduledAt, timezone, tourType, names,
address?, overrides?`. `tourType` and `names` are both REQUIRED - an object
literal missing either is a TS2345 at the call site.

## 3a. THE EXPORTED SIGNATURE LIST OF `tourCopy.ts`

Six exports, in file order:

```ts
export class UncomposableReminderError extends Error {
  constructor(message: string);
}

export type { TourContactNames } from '../lib/tourContacts.js';

export interface ComposeTourReminderInput { /* see above */ }

export function composeTourReminderBody(input: ComposeTourReminderInput): string;

export function reminderNamesUsed(
  kind: ReminderKind,
  tourType: TourType,
): { tenantName: boolean; propertyContact: boolean };

export function assessNamesReadFailure(args: {
  kind: ReminderKind;
  tourType: TourType;
  tenantReadFailed: boolean;
  propertyReadFailed: boolean;
  unitReadFailed: boolean;
}): { blocksSend: boolean; withholdPreview: boolean };
```

Module-private: `idFor(kind, hasStreet, hasPropertyContactFirstName, tourType): MessageId`
(exhaustive switch, no trailing return).

Type-only imports added: `TourContactNames` from `../lib/tourContacts.js`,
`TourType` from `../lib/toursModel.js`. One NEW value import:
`MESSAGE_CATALOG` from `./catalog.js` (needed by `reminderNamesUsed`;
`resolve.ts` already value-imports the same module, so it adds no new edge).

**A4-8 VERIFIED EMPIRICALLY, not by inspection.** esbuild transform of the
shipped file emits exactly these four imports and nothing else:

```
import { formatStreet } from "../lib/address.js";
import { formatLocalDate, formatLocalTime } from "../lib/localTime.js";
import { MESSAGE_CATALOG } from "./catalog.js";
import { resolveMessage } from "./resolve.js";
```

`tourContacts.js` and `toursModel.js` are fully erased, so the Playwright
bundle stays AWS-free. (`address.ts` and `localTime.ts` have zero imports;
`catalog.ts` imports only the pure `lib/smsCompliance.js`; `resolve.ts`
imports only `catalog.js`.)

---

## 4. THE FINAL `MessageId` TOUR MEMBERS

Seven, replacing nine (-4 / +2):

```ts
  | 'tour.confirmation'
  | 'tour.confirmation_no_address'
  | 'tour.day_before'
  | 'tour.morning_of'
  | 'tour.en_route_self_guided'
  | 'tour.en_route_landlord_led'
  | 'tour.no_show_checkin'
```

REMOVED: `tour.day_before_no_address`, `tour.morning_of_no_address`,
`tour.en_route`, `tour.en_route_no_address`.

Shipped copy (all ASCII, apostrophes are ASCII `'`):

| id | default | vars |
| --- | --- | --- |
| `tour.confirmation` | `Hey, your tour is set for {when} at {where}.` (UNCHANGED) | `[...TOUR_NAME_VARS, 'where']` |
| `tour.confirmation_no_address` | `Hey, your tour is set for {when}.` (UNCHANGED) | `[...TOUR_NAME_VARS]` |
| `tour.day_before` | `Hey {tenantFirstName}, confirming your tour tomorrow at {time}. Does that still work for you?` | `[...TOUR_NAME_VARS, 'where']` |
| `tour.morning_of` | `Hey {tenantFirstName}, looking forward to having you tour at {time} today. Does that still work for you? {addressLine}` | `[...TOUR_NAME_VARS, 'where', 'addressLine']` |
| `tour.en_route_self_guided` | `Hey {tenantFirstName}, can you please text me when you're on the way?` | `[...TOUR_NAME_VARS, 'where']` |
| `tour.en_route_landlord_led` | `Hey {tenantFirstName}, {propertyContactFirstName} will be headed that way shortly. Can you please text here when you're on the way?` | `[...TOUR_NAME_VARS, 'where']` |
| `tour.no_show_checkin` | `Hi {tenantFirstName}! Do you need to reschedule?` | `[...TOUR_NAME_VARS]` |

with, above `MESSAGE_CATALOG`:

```ts
/** The token set EVERY tour entry declares (see the TOKEN CONTRACT below). */
const TOUR_NAME_VARS = [
  'when', 'time', 'tenantFirstName', 'tenantName',
  'propertyContactFirstName', 'propertyContactName',
] as const;
```

All seven keep `class: 'operational'`, `editable: true`, `channel: 'sms'`.

Composed bodies, for S3's call-site pinning (tenant `Alice`, property contact
`Dana`, `2026-07-23T19:00:00.000Z` in `America/New_York`, street
`412 Oak St`):

- day_before: `Hey Alice, confirming your tour tomorrow at 3:00 PM. Does that still work for you?`
- morning_of + addr: `Hey Alice, looking forward to having you tour at 3:00 PM today. Does that still work for you? Address is 412 Oak St.`
- morning_of, no addr: `Hey Alice, looking forward to having you tour at 3:00 PM today. Does that still work for you?`
- en_route self_guided (and any type with NO property first name): `Hey Alice, can you please text me when you're on the way?`
- en_route landlord_led / pm_team: `Hey Alice, Dana will be headed that way shortly. Can you please text here when you're on the way?`
- no_show_checkin: `Hi Alice! Do you need to reschedule?` / nameless: `Hi there! Do you need to reschedule?`
- nameless tenant anywhere: `Hey there, ...`

---

## 5. EXPECTED RED LEFT FOR S3 (do not chase - this is the handover)

`cd app && npx tsc -p tsconfig.test.json --noEmit` - EXIT 2, **12 errors,
ZERO of them in the four files this slice touched.** Every one is a call site
S3 wires in Steps 6-12:

```
src/jobs/tourReminders.ts(549,34): error TS2345: ... is not assignable to parameter of type 'ComposeTourReminderInput'.
src/routes/contactTimeline.ts(725,36): error TS2345: ...
src/routes/relayGroups.ts(258,44): error TS2345: ...
src/routes/tourReminders.ts(238,38): error TS2345: ...
test/contactTimeline.test.ts(1108,51): error TS2345: ...
test/contactTimeline.test.ts(1113,49): error TS2345: ...
test/devGating.test.ts(459,53): error TS2345: ...
test/devGating.test.ts(464,51): error TS2345: ...
test/tourReminders.test.ts(102,34): error TS2345: ...
test/tourRemindersApi.test.ts(244,33): error TS2345: ...
test/tourRemindersApi.test.ts(844,31): error TS2345: ...
test/tourRemindersApi.test.ts(1088,31): error TS2345: ...
```

That list is the app workspace only. `e2e/scenarios/steps.ts:174` is a
thirteenth call site and is NOT in the app tsconfig - it will surface on
`npm run typecheck` (Step 14). `npm test`, `npm run smoke` and `npm run e2e`
were NOT run, per the slice brief.

---

## 6. WORKLIST ITEMS - DISPOSITION

- **A4-4 DONE.** The token-declarations loop now also asserts
  `expect(MESSAGE_CATALOG[id].channel, ...).toBe('sms')`, with the reason
  (messageCatalogAscii filters on `channel !== 'sms'`) in a comment beside it.
- **A4-5 DONE.** The exhaustive matrix now also asserts
  `expect(body, label).not.toMatch(/\{[A-Za-z]/)`, with the
  interpolate-drops-undeclared-vars reason in a comment.
- **A4-6 DONE.** The `it` is renamed to
  `'OUR copy is ASCII with the seeded address'`, with a dated comment saying
  the segment assertion was ruled out (spec 5) rather than lost.
- **A4-7 DONE.** The whole file was rewritten, so the enclosing `describe`
  (`:14`), the `addr` const (`:15`), the token-contract comment (`:17-21`) and
  the address-shape tests (`:77-105`) all went with the pins. The NULL-address
  test's "seeds write raw items" comment was carried forward into the new
  `address shapes` describe.
- **A4-8 DONE and VERIFIED** - see section 3a.
- **A4-14 DONE.** `app/test/messages/resolve.test.ts:17` said "every tour.*
  default now carries {when}/{time}/{where}". That is now false: only
  `tour.confirmation` carries `{where}`, the two `en_route` entries carry NO
  time token at all, and `tour.no_show_checkin` carries neither. Corrected to
  "after the 2026-08-26 founder rewrite every tour.* default carries at least
  one required token (a name, and/or {when}/{time}/{where})", which is true
  for all seven and preserves the sentence's actual point (why
  `relay.group_closed`, not a tour entry, is the token-free example). File
  re-run green (14/14).

Constraints honoured: `MANUAL_ONLY_REMINDER_KINDS` / `REMINDER_KINDS`
untouched; both `tour.confirmation*` `default` strings byte-identical to
before (only `vars` changed); copy transcribed byte-for-byte from spec section
5; every ADDED line in all four files is ASCII (verified by scanning the `+`
side of the diff); no PowerShell rewrite pipeline used; no gate command piped.

---

## 7. DEVIATIONS FROM THE PLAN

1. **The kept ASCII test is now partly redundant with the matrix.** The plan's
   matrix comment says it "doubles as the ASCII guard for OUR copy in every
   variant", while Step 1 also says KEEP the ASCII guard and A4-6 says RENAME
   it. I kept BOTH: deleting the older `it` would leave its describe
   ("the ASCII boundary, pinned from BOTH sides") asserting two sides while
   holding one. Cost is one duplicated loop; benefit is the describe stays
   honest. Flagging it so a reviewer does not read it as an oversight.
2. **`TOUR_NAME_VARS` placement.** The plan says "write it once as a local
   const above the block"; it sits immediately above
   `export const MESSAGE_CATALOG`, outside it, un-exported.
3. **Two comments added beyond the plan's verbatim text**, both recording a
   ruling that would otherwise be invisible at the entry: a note on
   `tour.confirmation_no_address` saying `{where}` must NOT be added there
   (spec 6.5's leak guard, whose old explanation lived in the comment block
   this change replaced), and a note on `tour.en_route_landlord_led` saying it
   is also the `pm_team` wording (spec 9.0). Neither changes behaviour.
4. **The composer's module header gained two paragraphs** the plan did not
   dictate: the IMPORT LAYERING contract (moved into the file where the next
   editor will see it, including R1 G1's warning never to point this file at
   `messages/index.js`, which value-exports `resolveWithSettings` and would
   drag the SDK into the harness bundle), and "the already-RESOLVED names" in
   the purity sentence. The false D2 sentence at the old `:51-52` is gone with
   the function body it sat in.

---

## 8. NOTICED, NOT FIXED

- **A4-10 confirmed harmless.** The new `.trim()` applies to `confirmation`
  and `no_show_checkin` too. Neither default has leading/trailing whitespace,
  so no rendered output changes. The only theoretical exposure is a stored
  `sentBody` snapshot written under the old composer with stray whitespace
  being compared to a freshly recomposed body; nothing in this slice does
  that.
- **Vitest cannot see the signature change.** Worth stating loudly for S3:
  esbuild strips types, so `npx vitest run` will go GREEN on a call site that
  is missing `tourType`/`names` and is silently composing `undefined` names.
  Only `npm run typecheck` (Step 14) catches those. Do not treat a green app
  suite as proof the threading is complete.
- **`{where}` is declared but unused on four entries** (`tour.day_before`,
  both `en_route`, and - via `TOUR_NAME_VARS` - `{when}`/`{time}` on entries
  that do not use them). Deliberate per spec 6 and legal only because every
  tour entry is `editable: true`. `catalog.test.ts`'s no-dead-tokens rule
  skips editable entries, so nothing guards against a future editor flipping
  one to `editable: false`; the new token-declarations test pins
  `editable === true` on all seven, which closes that.
- **The exhaustive matrix passed BEFORE the implementation.** It was written
  to close `tourcopy-messageid-cast-unguarded.md` and it does - but note it
  was never RED, because the old string-cast derivation happened to resolve
  for every kind it was fed with the old nine-entry catalog. Its value is
  forward-looking (a new `ReminderKind` now fails at compile time in `idFor`),
  not as a TDD driver.
- **`reminderNamesUsed` inspects DEFAULTS only.** Carried the plan's
  `TODO(tour-reminder-ladder-phase-b)` verbatim; no `tour.*` override can
  exist today (`settingsToOverrides` maps two ids, and no tour compose site
  passes `overrides`).
