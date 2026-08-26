# Tour Reminder Ladder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the tour reminder ladder to the founder's copy - tenant and
property-contact names, two retimed rungs, two booking-time skip rules, and a
tour-type fork on the one-hour rung.

**Architecture:** All copy stays in `MESSAGE_CATALOG`. `composeTourReminderBody`
remains the single composer; its input grows two resolved names and the tour
type, and its id selection forks on tour type for `en_route` instead of on
address. Name resolution happens in the CALLERS (the composer stays pure), so
every call site gains a resolve step. Timing changes are confined to
`computeDueAt` and the arm loop.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, Playwright,
DynamoDB Local.

**Spec:** `docs/superpowers/specs/2026-08-26-tour-reminder-ladder-design.md` -
read it fully before Task 1. This plan argues from it and does not repeat its
reasoning.

## Global Constraints

- **The ladder stays PAUSED.** `MANUAL_ONLY_REMINDER_KINDS`
  (`app/src/jobs/tourReminders.ts:163`) is NOT touched by any task. If a test
  needs an automatic send, inject an empty set through
  `RunDueTourRemindersDeps.manualOnlyKinds` (`:353`), as existing tests do. Do
  NOT empty the real set to go green. Unpausing is Phase B.
- **ASCII only** on every new or touched line - comments, test names, copy.
- **Never pipe a gate command.** `npm run e2e | tail` returns the pipe's exit
  code; that is how a failing suite was reported as a pass on 2026-08-18.
  Redirect to a file and read `$?`.
- **`npm run typecheck` TYPECHECKS TESTS** (`app/package.json:13` runs
  `tsconfig.test.json`). A signature change is not done until the test files
  compile too.
- **`ReminderKind` is persisted** (`app/src/repos/tourRemindersRepo.ts:76`) and
  must not be renamed. `MessageId` is derived at compose time and may change.
- **Resolve timezone via `resolveQuietHoursTimezone`** (`app/src/lib/quietHours.ts:39`),
  never by reading `settings.timezone` directly.
- **Commit after every task**, explicit paths only, never `git add -A`. Add
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `app/src/lib/contactName.ts` | contact name helpers | ADD `contactFirstName()` |
| `app/src/lib/localTime.ts` | local date/time formatting | ADD `shiftLocalDate()` |
| `app/src/lib/tourContacts.ts` | resolve a tour's two names | CREATE |
| `app/src/messages/catalog.ts` | copy + token declarations | MODIFY tour block |
| `app/src/messages/tourCopy.ts` | the one composer | MODIFY signature + id selection |
| `app/src/repos/tourRemindersRepo.ts` | row shape + skip reasons | ADD `booked_too_late` |
| `app/src/jobs/tourReminders.ts` | timing, arm loop, send path | MODIFY |
| `app/src/routes/{tourReminders,contactTimeline,relayGroups}.ts` | preview surfaces | MODIFY |
| `dashboard/src/api/types.ts` | wire union + operator labels | MODIFY |
| `e2e/scenarios/steps.ts` | ladder mirror, markers, labels | MODIFY |

---

### Task 1: `contactFirstName()` helper

**Files:**
- Modify: `app/src/lib/contactName.ts`
- Test: `app/test/contactName.test.ts`

**Interfaces:**
- Produces: `contactFirstName(contact: ContactItem | undefined): string | undefined`

READ THIS BEFORE WRITING THE TEST. `contactDisplayName`
(`app/src/lib/contactName.ts:67`) joins `firstName` + `lastName` and **never
reads a `name` field**. So "fall back to splitting a display name" is a no-op
here - the first token of `firstName + ' ' + lastName` is just `firstName`. This
helper is therefore deliberately thin, and deliberately does NOT fall back to a
surname: greeting a tenant "Hey Chen," is worse than "Hey there,".

- [ ] **Step 1: Write the failing test**

```ts
import { contactFirstName } from '../src/lib/contactName.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';

const c = (o: Record<string, unknown>): ContactItem => o as unknown as ContactItem;

describe('contactFirstName', () => {
  it('returns the firstName field, trimmed', () => {
    expect(contactFirstName(c({ firstName: '  Alice ', lastName: 'Rivera' }))).toBe('Alice');
  });
  it('returns undefined for an absent contact', () => {
    expect(contactFirstName(undefined)).toBeUndefined();
  });
  it('returns undefined when firstName is missing or blank', () => {
    expect(contactFirstName(c({}))).toBeUndefined();
    expect(contactFirstName(c({ firstName: '   ' }))).toBeUndefined();
  });
  it('does NOT fall back to a surname - greeting by last name is worse than a generic greeting', () => {
    expect(contactFirstName(c({ lastName: 'Chen' }))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**
      `cd app && npx vitest run test/contactName.test.ts -t contactFirstName`
      Expected: FAIL, `contactFirstName is not a function`.
- [ ] **Step 3: Implement**

```ts
/** First name for greeting copy. Deliberately does NOT fall back to lastName:
 *  "Hey Chen," is worse than the caller's "Hey there," fallback. */
export function contactFirstName(contact: ContactItem | undefined): string | undefined {
  if (contact === undefined) return undefined;
  const first = typeof contact['firstName'] === 'string' ? contact['firstName'].trim() : '';
  return first.length > 0 ? first : undefined;
}
```

- [ ] **Step 4: Run and watch it pass.** `cd app && npx vitest run test/contactName.test.ts`
- [ ] **Step 5: Commit**

```bash
git add app/src/lib/contactName.ts app/test/contactName.test.ts
git commit -m "feat(contacts): contactFirstName helper for greeting copy"
```

---

### Task 2: `shiftLocalDate()` helper

**Files:**
- Modify: `app/src/lib/localTime.ts`
- Test: `app/test/localTime.test.ts`

**Interfaces:**
- Produces: `shiftLocalDate(localDate: string, days: number): string`

Task 6 needs "the tour's local date minus one day" as a `'YYYY-MM-DD'` string.
No such helper exists anywhere in `app/src/lib`, and hand-rolling it is silently
wrong across month and year boundaries. Operate on the calendar string with
`Date.UTC` so no timezone is involved.

- [ ] **Step 1: Write the failing test**

```ts
describe('shiftLocalDate', () => {
  it('steps back one day', () => {
    expect(shiftLocalDate('2026-07-23', -1)).toBe('2026-07-22');
  });
  it('crosses a month boundary', () => {
    expect(shiftLocalDate('2026-08-01', -1)).toBe('2026-07-31');
  });
  it('crosses a year boundary', () => {
    expect(shiftLocalDate('2026-01-01', -1)).toBe('2025-12-31');
  });
  it('handles a leap day', () => {
    expect(shiftLocalDate('2028-03-01', -1)).toBe('2028-02-29');
  });
});
```

- [ ] **Step 2: Run and watch it fail.** `cd app && npx vitest run test/localTime.test.ts -t shiftLocalDate`
- [ ] **Step 3: Implement**

```ts
/** Shift a 'YYYY-MM-DD' CALENDAR date by whole days. Pure string arithmetic via
 *  Date.UTC - no zone is involved, so it cannot drift across a DST boundary. */
export function shiftLocalDate(localDate: string, days: number): string {
  const [y, m, d] = localDate.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined) {
    throw new Error(`shiftLocalDate: unparseable local date "${localDate}"`);
  }
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
```

- [ ] **Step 4: Run and watch it pass.**
- [ ] **Step 5: Commit**

```bash
git add app/src/lib/localTime.ts app/test/localTime.test.ts
git commit -m "feat(lib): shiftLocalDate for calendar-day arithmetic"
```

---

### Task 3: `resolveTourContactNames()`

**Files:**
- Create: `app/src/lib/tourContacts.ts`
- Test: `app/test/tourContacts.test.ts`

**Interfaces:**
- Consumes: `contactFirstName` (Task 1), `contactDisplayName`, `unitContacts`.
- Produces:

```ts
export interface TourContactNames {
  tenantFirstName?: string;
  tenantName?: string;
  propertyContactFirstName?: string;
  propertyContactName?: string;
}
export interface ResolveTourContactNamesResult {
  names: TourContactNames;
  /** true only when a repo read THREW. Absence is undefined names + failed:false.
   *  Task 8 branches on this: send paths must NOT send fallback copy after a
   *  read failure, they leave the rung unclaimed. */
  failed: boolean;
}
export async function resolveTourContactNames(
  tour: { tenantId: string; unitId: string },
  deps: {
    contactsRepo: Pick<ContactsRepo, 'getById'>;
    unitsRepo: Pick<UnitsRepo, 'getById'>;
    logger?: Logger;
  },
): Promise<ResolveTourContactNamesResult>;
```

Resolve the property contact with the ESTABLISHED rule (`lib/rosterResolution.ts:274`).
Do NOT read the `unit.primary_contact` scalar - nothing else does, and it is
nullable:

```ts
const roster = unitContacts(unit);
const primary = roster.find((c) => c.primaryContact === true);
const propertyContactId = primary?.contactId ?? unit.landlordId;
```

Zero-primary on an EXISTING roster is legal and reachable, so that fallback
covers both it and the no-roster case. Read the LIVE contact for names; the
roster's denormalized `name` goes stale.

- [ ] **Step 1: Write the failing tests** - five cases: roster primary resolves;
      zero-primary roster falls back to `landlordId`; no roster at all falls back
      to `landlordId`; a nameless contact yields undefined names with
      `failed:false`; a throwing repo yields `failed:true` and never throws out.
      Build a local `rig()` returning
      `{ contactsRepo: { getById: async (id) => contacts[id] }, unitsRepo: { getById: async () => unit } }`.
- [ ] **Step 2: Run and watch it fail.** `cd app && npx vitest run test/tourContacts.test.ts`
- [ ] **Step 3: Implement.** Wrap BOTH reads in one try/catch setting
      `failed = true`, logging a warn with IDS ONLY - never a name or phone.
- [ ] **Step 4: Run and watch it pass** (5 tests).
- [ ] **Step 5: Commit**

```bash
git add app/src/lib/tourContacts.ts app/test/tourContacts.test.ts
git commit -m "feat(tours): resolve tenant + property-contact names for reminder copy"
```

---

### Task 4: Catalog copy, composer, and EVERY call site including tests

**Files:**
- Modify: `app/src/messages/catalog.ts`, `app/src/messages/tourCopy.ts`
- Modify: `app/src/jobs/tourReminders.ts:549`, `app/src/routes/tourReminders.ts:238`
  and `:548`, `app/src/routes/contactTimeline.ts:725`,
  `app/src/routes/relayGroups.ts:258`, `e2e/scenarios/steps.ts:174`
- Modify (COMPILE ONLY): `app/test/tourReminders.test.ts:102`,
  `app/test/tourRemindersApi.test.ts:244,844,1088`,
  `app/test/contactTimeline.test.ts:1108,1113`, `app/test/devGating.test.ts:459,464`
- Test: `app/test/tourCopy.test.ts`, `app/test/tourCopyCallSites.test.ts`

**Interfaces:**
- Consumes: `TourContactNames` (Task 3).
- Produces: `ComposeTourReminderInput` gains REQUIRED `tourType: TourType` and
  optional `names?: TourContactNames`.

`tourType` is REQUIRED, not defaulted. A default would silently give a
landlord-led tour the self-guided wording at any call site that forgot it - the
exact silent-wrong this fork exists to prevent. That means the existing TEST call
sites above must gain the field IN THIS TASK or `npm run typecheck` fails.
Update them to compile only; their expectation re-baseline is Task 10.

Copy is spec section 5, verbatim. Token declarations:

- Every tour entry declares
  `['when','time','where','tenantFirstName','tenantName','propertyContactFirstName','propertyContactName']`
- EXCEPT `tour.morning_of_no_address` AND `tour.confirmation_no_address`, which
  declare that list MINUS `where`. Both are no-address twins and spec 6.4's
  rationale applies to both.

Legal only because these entries are `editable: true` (`catalog.test.ts:43`
runs its no-dead-tokens check on non-editable entries only). Do not flip that flag.

- [ ] **Step 1: Write the failing tests.** Everything you need is below - there
      is no other document to copy from. DELETE the existing old-copy
      expectations in `tourCopy.test.ts` as you go; leaving them means Step 7
      cannot pass.

```ts
import { MESSAGE_CATALOG } from '../src/messages/catalog.js';
import { composeTourReminderBody } from '../src/messages/tourCopy.js';
import { TOUR_TYPES } from '../src/lib/toursModel.js';
import type { ReminderKind } from '../src/repos/tourRemindersRepo.js';

const base = { scheduledAt: '2026-07-23T19:00:00.000Z', timezone: 'America/New_York' } as const;
const NAMES = {
  tenantFirstName: 'Alice', tenantName: 'Alice Rivera',
  propertyContactFirstName: 'Dana', propertyContactName: 'Dana Ortiz',
};

it('day_before greets by first name and uses the BARE time', () => {
  const body = composeTourReminderBody({ ...base, kind: 'day_before', tourType: 'self_guided', names: NAMES });
  expect(body).toBe('Hey Alice, confirming your tour tomorrow at 3:00 PM. Does that still work for you?');
  expect(body).not.toContain('Jul 23');
});

it('morning_of carries the address; its twin drops that sentence', () => {
  expect(composeTourReminderBody({ ...base, kind: 'morning_of', tourType: 'self_guided', names: NAMES, address: '412 Oak St' }))
    .toBe('Hey Alice, looking forward to having you tour at 3:00 PM today. Does that still work for you? Address is 412 Oak St.');
  expect(composeTourReminderBody({ ...base, kind: 'morning_of', tourType: 'self_guided', names: NAMES }))
    .toBe('Hey Alice, looking forward to having you tour at 3:00 PM today. Does that still work for you?');
});

it('en_route forks on TOUR TYPE, and pm_team takes the landlord-led wording', () => {
  expect(composeTourReminderBody({ ...base, kind: 'en_route', tourType: 'self_guided', names: NAMES }))
    .toBe("Hey Alice, can you please text me when you're on the way?");
  const landlordLed = "Hey Alice, Dana will be headed that way shortly. Can you please text here when you're on the way?";
  expect(composeTourReminderBody({ ...base, kind: 'en_route', tourType: 'landlord_led', names: NAMES })).toBe(landlordLed);
  expect(composeTourReminderBody({ ...base, kind: 'en_route', tourType: 'pm_team', names: NAMES })).toBe(landlordLed);
});

it('no property-contact name DEGRADES landlord-led AND pm_team to the self-guided wording', () => {
  for (const tourType of ['landlord_led', 'pm_team'] as const) {
    expect(composeTourReminderBody({ ...base, kind: 'en_route', tourType, names: { tenantFirstName: 'Alice' } }))
      .toBe("Hey Alice, can you please text me when you're on the way?");
  }
});

it('no tenant first name greets with "there"', () => {
  expect(composeTourReminderBody({ ...base, kind: 'day_before', tourType: 'self_guided', names: {} }))
    .toBe('Hey there, confirming your tour tomorrow at 3:00 PM. Does that still work for you?');
});

it('no_show_checkin greets by name and no longer throws on the token', () => {
  expect(composeTourReminderBody({ ...base, kind: 'no_show_checkin', tourType: 'self_guided', names: NAMES }))
    .toBe('Hi Alice! Do you need to reschedule?');
});
```

PLUS these two:

```ts
it('the no-address twins do NOT declare where - the leak guard', () => {
  expect(MESSAGE_CATALOG['tour.morning_of_no_address'].vars).not.toContain('where');
  expect(MESSAGE_CATALOG['tour.confirmation_no_address'].vars).not.toContain('where');
});

// Closes docs/issues/tourcopy-messageid-cast-unguarded.md.
it('EXHAUSTIVE: every kind x address x tourType composes without throwing', () => {
  const kinds: ReminderKind[] = ['confirmation','day_before','morning_of','en_route','no_show_checkin'];
  for (const kind of kinds)
    for (const address of [undefined, '412 Oak St'] as const)
      for (const tourType of TOUR_TYPES)
        expect(() => composeTourReminderBody({
          ...base, kind, tourType, names: NAMES, ...(address !== undefined && { address }),
        }), `${kind}/${address ? 'addr' : 'no-addr'}/${tourType}`).not.toThrow();
});
```

- [ ] **Step 2: Run and watch them fail.** `cd app && npx vitest run test/tourCopy.test.ts`
- [ ] **Step 3: Update the catalog** per spec section 5 and the token rule above.
      Add `tour.en_route_self_guided` / `tour.en_route_landlord_led`; delete
      `tour.en_route`, `tour.en_route_no_address`, `tour.day_before_no_address`;
      KEEP both `confirmation` entries with a comment saying they are unarmed but
      must exist for in-flight rows (spec 9.1).
- [ ] **Step 4: Update the composer.** Build the vars ONCE, ABOVE the
      `no_show_checkin` early return, so that branch gets them too - it is one of
      spec 9.2's two throw sites:

```ts
const n = input.names ?? {};
const nameVars = {
  tenantFirstName: n.tenantFirstName ?? 'there',
  tenantName: n.tenantName ?? 'there',
  propertyContactFirstName: n.propertyContactFirstName ?? '',
  propertyContactName: n.propertyContactName ?? '',
};
if (kind === 'no_show_checkin') return resolveMessage('tour.no_show_checkin', nameVars, overrides);
```

Replace the string-cast with an exhaustive switch. NOTE the signature takes the
resolved first name, because the landlord-led degrade depends on it:

```ts
function idFor(
  kind: ReminderKind, hasStreet: boolean, tourType: TourType, hasContactName: boolean,
): MessageId {
  switch (kind) {
    case 'day_before': return 'tour.day_before';
    case 'no_show_checkin': return 'tour.no_show_checkin';
    case 'confirmation': return hasStreet ? 'tour.confirmation' : 'tour.confirmation_no_address';
    case 'morning_of': return hasStreet ? 'tour.morning_of' : 'tour.morning_of_no_address';
    case 'en_route':
      // Degrade to the self-guided wording when we cannot name the contact -
      // "will be headed that way shortly" with a blank name is worse than a
      // message that names nobody (spec 6.3).
      return tourType === 'self_guided' || !hasContactName
        ? 'tour.en_route_self_guided'
        : 'tour.en_route_landlord_led';
  }
}
```

The exhaustive switch is what removes the unguarded cast: the compiler now fails
on a new kind instead of throwing a bare `TypeError` at runtime.

- [ ] **Step 5: Update the five call sites plus the no-show draft.** The draft at
      `routes/tourReminders.ts:548` calls `resolveMessage('tour.no_show_checkin')`
      directly. Route it through the composer - which needs `scheduledAt`,
      `timezone`, `tourType` and names, so that router must reach `unitsRepo` and
      `contactsRepo`. Then DELETE the `ALLOWED_DIRECT` whitelist at
      `app/test/tourCopyCallSites.test.ts:33` and its now-false "token-free by
      design" justification.
- [ ] **Step 6: Add `tourType` to the existing test call sites** listed above,
      compile only.
- [ ] **Step 7: Run the composer + call-site suites.**
      `cd app && npx vitest run test/tourCopy.test.ts test/tourCopyCallSites.test.ts`
- [ ] **Step 8: Typecheck the WHOLE repo.** `npm run typecheck` - exit 0. This is
      the step that catches a missed call site, in src OR test.
- [ ] **Step 9: Commit** (paths: the src files, the e2e helper, the six test files,
      and the two test suites above).

---

### Task 5: `booked_too_late` skip reason

**Files:**
- Modify: `app/src/repos/tourRemindersRepo.ts:36`, `dashboard/src/api/types.ts`
  (wire union ~`:1213`, label map ~`:1273`)
- Test: `app/test/tourRemindersRepo.test.ts`,
  `dashboard/src/routes/tours/RemindersPanel.test.tsx`

**Interfaces:**
- Produces: `'booked_too_late'` on both unions; operator label
  `booked too late for this reminder`.

None of the eight existing reasons means this. `past_event` would be a lie (the
rung lands before the tour); `quiet_hours_superseded` would be a lie (nothing
superseded it).

- [ ] **Step 1: Write the failing tests** - the union accepts it, and the panel
      renders the exact label string.
- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Add the token to both unions and the label map.**
- [ ] **Step 4: Run both suites.** `cd app && npx vitest run test/tourRemindersRepo.test.ts`
      and `cd dashboard && npx vitest run src/routes/tours/RemindersPanel.test.tsx`
- [ ] **Step 5: Commit.**

---

### Task 6: Export and retime `computeDueAt`

**Files:**
- Modify: `app/src/jobs/tourReminders.ts:89`
- Test: `app/test/tourReminders.test.ts`

**Interfaces:**
- Consumes: `shiftLocalDate` (Task 2).
- Produces: `computeDueAt` becomes EXPORTED. It still returns a RAW, UNCLAMPED
  instant - the clamp lives in the caller at `:250`. Do not add clamping here.

`computeDueAt` is currently unexported and no test calls it directly. Export it
in Step 1; `seedLive.test.ts` already mirrors it, so a directly-tested original
is the point.

- [ ] **Step 1: Export the function**, then add these fixtures at the top of the
      describe block (the existing file has no `NOW`/`WINDOW`):

```ts
import { computeDueAt } from '../src/jobs/tourReminders.js';
import { formatLocalTime } from '../src/lib/localTime.js';
import { quietHoursWindowOf } from '../src/lib/quietHours.js';

const WINDOW = quietHoursWindowOf({
  quietHoursEnabled: true, quietHoursStart: '21:00', quietHoursEnd: '08:00',
  timezone: 'America/New_York',
});
const NOW = '2026-07-01T12:00:00.000Z'; // far before every fixture tour
```

- [ ] **Step 2: Write the failing tests**

```ts
// Tour = Thu Jul 23 2026, 15:00 EDT (= 19:00Z).
const TOUR = '2026-07-23T19:00:00.000Z';

it('day_before is 19:30 org-local the night before', () => {
  expect(computeDueAt('day_before', TOUR, NOW, WINDOW)).toBe('2026-07-22T23:30:00.000Z');
});
it('morning_of is four hours before the tour', () => {
  expect(computeDueAt('morning_of', TOUR, NOW, WINDOW)).toBe('2026-07-23T15:00:00.000Z');
});
it('en_route is one hour before the tour', () => {
  expect(computeDueAt('en_route', TOUR, NOW, WINDOW)).toBe('2026-07-23T18:00:00.000Z');
});
it('the 19:30 anchor holds on a DST-transition day', () => {
  // 2026-03-08 is spring-forward in America/New_York. Tour Mar 9 12:00 EDT.
  const due = computeDueAt('day_before', '2026-03-09T16:00:00.000Z', NOW, WINDOW);
  expect(formatLocalTime(due, 'America/New_York')).toBe('7:30 PM');
});
```

- [ ] **Step 3: Run and watch them fail.**
      `cd app && npx vitest run test/tourReminders.test.ts -t computeDueAt`
- [ ] **Step 4: Implement.** `day_before` becomes
      `instantAtLocalTime(shiftLocalDate(localDateOf(scheduledAt, window.timezone), -1), '19:30', window.timezone)`;
      `morning_of` becomes `scheduledAt - 4h`. Comment both with the founder
      decision date and note `morning_of` keeps its name deliberately.
- [ ] **Step 5: Run and watch them pass.**
- [ ] **Step 6: Update ONLY the `computeDueAt` twin** in
      `app/test/seedLive.test.ts` (the function starts at `:53`), in lockstep
      with Step 4. Do NOT touch that file's local `REMINDER_KINDS` copy at `:84`
      or its rung-count assertion at `:219` in this task - those depend on
      `confirmation` no longer arming, which does not happen until Task 9. An
      earlier revision of this plan changed them here and then asked you to prove
      the file green, which was impossible.
- [ ] **Step 7: Run `cd app && npx vitest run test/seedLive.test.ts` with Docker
      UP** and confirm it did NOT skip (`describe.skipIf(!reachable)` passes
      silently without it, and this file IS the drift guard).
      EXPECTED STATE: the dueAt assertions pass; the rung-count assertion at
      `:219` still passes because `confirmation` is still armed. If it fails
      here, your `computeDueAt` change is wrong - do not "fix" it by editing
      `:219`.
- [ ] **Step 8: Commit.**

---

### Task 7: The two skip rules and the quiet-window warn

**Files:**
- Modify: `app/src/jobs/tourReminders.ts` arm loop `:248-300`
- Test: `app/test/tourReminders.test.ts`

**Interfaces:**
- Consumes: `booked_too_late` (Task 5), raw `computeDueAt` (Task 6).

CRITICAL: pass 1 at `:248` stores CLAMPED dueAts in `dues` and discards the raw
value. Both new rules compare RAW offsets (spec section 8), so build a SECOND map
of raw values in the same loop and compare against that. Using `dues` passes most
tests by luck and is wrong for any tour whose `day_before` clamps.

Rule 1 must be evaluated BEFORE the existing past-dueAt branch at `:266`, which
writes NO row - otherwise a late-booked `day_before` vanishes instead of showing
as booked-too-late. Boundaries are strictly `>`. `now` is the ARM instant:
booking, reschedule (`routes/tours.ts:1178`), or revival.

- [ ] **Step 1: Write the failing tests.** Reuse the file's existing rig
      (`tours.create` + `armTourReminders` + the per-test `byKind` object literal;
      the log capture is `logCapture`, not `capture`). Concrete instants:

```ts
// Tour Thu Jul 23 15:00 EDT. day_before raw = Jul 22 19:30 EDT = 23:30Z.
// Rule 1 lead = 4h => the cutoff is Jul 22 15:30 EDT = 19:30Z.
const TOUR = '2026-07-23T19:00:00.000Z';
const BOOKED_JUST_INSIDE = '2026-07-22T19:30:00.001Z'; // 1ms past the cutoff -> SKIP
const BOOKED_ON_CUTOFF   = '2026-07-22T19:30:00.000Z'; // exactly 4h -> ARMS (strict >)

// Same-day rule 2: cutoff is scheduledAt - 6h = Jul 23 13:00Z.
const SAMEDAY_INSIDE = '2026-07-23T13:00:00.001Z'; // -> SKIP
const SAMEDAY_ON_CUTOFF = '2026-07-23T13:00:00.000Z'; // -> ARMS
```

Assert: rule 1 writes a VISIBLE row with `skipReason === 'booked_too_late'`;
the cutoff instant still arms; rule 2 skips only on a SAME-DAY tour (an advance
tour with the same clock gap still arms `morning_of`); and a RESCHEDULE
re-evaluates both rules against the reschedule instant.

- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement** both rules against the RAW map, writing visible
      skipped rows shaped like the `past_event` branch at `:270`.
- [ ] **Step 4: Add the quiet-window warn.** When 19:30 local falls inside the
      configured window, log a WARN naming the rung, so the cause is visible when
      the panel starts showing every `day_before` as superseded. Test it with a
      `quietHoursStart: '19:00'` settings stub and assert BOTH the warn and that
      `staleDayBefore` still retires the rung.
- [ ] **Step 5: Run and watch them pass.**
- [ ] **Step 6: Commit.**

---

### Task 8: Send-path failure semantics

**Files:**
- Modify: `app/src/jobs/tourReminders.ts` (`composeBodyForRow` `:547` and its
  caller), `app/src/routes/{tourReminders,contactTimeline,relayGroups}.ts`
- Test: `app/test/tourReminders.test.ts`, `app/test/tourRemindersApi.test.ts`

Task 3 produces `failed`; this task is where it is CONSUMED. Without it the flag
is dead code and every gate is still green - spec 6.3 and section 13 both owe
this behavior.

**READ THIS BEFORE WRITING A TEST - the obvious test is already green.**
`resolveReminderTarget` (`jobs/tourReminders.ts:646`) calls
`contactsRepo.getById` with NO try/catch, so a throwing read ALREADY escapes and
ALREADY leaves the rung unclaimed. A test asserting "read throws -> nothing sent,
row unclaimed" passes on today's code, before you write a line. An earlier
revision of this plan shipped exactly that test. Your red state must come from
behaviour that does NOT exist yet.

What does not exist yet, and is therefore what you test:

1. The POLL distinguishing failure from ABSENCE. Today an absent contact is
   `contact_missing` (a claim-skip) and a THROW is an escape. After this task an
   absent contact still sends, greeting "there"; only a THROW leaves it
   unclaimed. The absence-still-sends case is the one that is red today.
2. `forceSendReminder` returning a REPRESENTABLE REFUSAL. This is the path that
   matters most: in Phase A it is the ONLY way a message reaches anyone. "Leave
   unclaimed" is poll vocabulary and does not translate to a human pressing Send
   now - they need an answer. Add a refusal outcome to `ForceSendResult` and a
   reason token, and have the route render it. Neither exists today.
3. READ paths degrading rather than 500-ing. Each preview catches ONLY
   `UncomposableReminderError`, so an escaping repo error takes out the whole
   bucket.

- [ ] **Step 1: Write the failing tests** - one per numbered item above, plus a
      force-send test asserting the refusal reaches the route as a rendered
      outcome rather than a thrown error. Before writing each one, RUN IT AGAINST
      UNMODIFIED CODE and confirm it is red. A test that is green before you
      start is not a test; delete it and find the behaviour that is actually new.
- [ ] **Step 2: Run and confirm every one is red for the RIGHT reason** (the new
      behaviour is missing), not because a fixture is malformed.
- [ ] **Step 3: Implement.** Widen `composeBodyForRow`'s deps - they are
      `Pick<RunDueTourRemindersDeps,'unitsRepo'>` today with no `contactsRepo`.
      Resolve the unit ONCE; it already reads it for the address. And note
      `resolveReminderTarget` has ALREADY fetched the tenant contact into
      `target.contact` - reuse it rather than reading the tenant twice.
- [ ] **Step 4: Resolve the property contact PER TOUR, not per request.**

      An earlier revision said "resolve contacts once per request" for the
      contact timeline's Upcoming bucket. THAT IS THE WRONG KEY and would have
      shipped a real bug: the bucket walks MULTIPLE tours, each with its OWN
      unit and therefore its own property contact. Caching one per request
      stamps one person's name onto every tour's preview.

      Correct shape: memoize by `unitId` (and by `contactId` for the contact
      reads) across the request, so N tours on the same unit cost one read and N
      tours on different units stay correct. Assert BOTH in a test: the read
      count collapses for repeats, AND two tours on different units render
      different names.
- [ ] **Step 5: Run and watch them pass.**
- [ ] **Step 6: Commit.**

---

### Task 9: Stop arming `confirmation`

**Files:**
- Modify: `app/src/jobs/tourReminders.ts` (`REMINDER_KINDS` `:197`, the
  `MANUAL_ONLY_REMINDER_KINDS` docblock `:149`)
- Test: `app/test/tourReminders.test.ts` (arming), `app/test/tourCopy.test.ts`
  (the compose-survives case - it needs `base`/`NAMES` from that file)

Remove `confirmation` from `REMINDER_KINDS` ONLY - the `no_show_checkin` pattern.
The kind stays in the union, `computeDueAt`, `LADDER_ORDER` and the catalog. Its
`MANUAL_ONLY_REMINDER_KINDS` entry becomes dead state whose 6-line rationale is
now false: leave the entry (harmless) and correct the comment.

**THIS IS THE WIDEST-BLAST-RADIUS TASK IN THE PLAN. Read before starting.**
`confirmation` is the ONLY rung whose dueAt is `now`, which makes it the test
suites' universal "fire a reminder immediately" vehicle. Turning it off is not a
string change:

- ~40 structural sites in `app/test/tourReminders.test.ts` key on it.
- ~14 e2e sites across `scheduled-visibility.spec.ts` (six, as its anchor),
  `tour-roster.spec.ts` and `tours.spec.ts:130-132`.

Those specs need a DIFFERENT immediate-send vehicle, not a new expected string.
Decide that vehicle ONCE here and apply it consistently - the natural candidate
is an `en_route` rung on a tour booked so the rung is already due, driven by the
dueAt read back from the API (Task 11 Step 2's method). Do not solve it five
different ways in five specs.

- [ ] **Step 1: Enumerate every site** before changing anything:
      `grep -rn "confirmation" app/test/tourReminders.test.ts e2e/tests/ | wc -l`
      and read them. If the count is far from the numbers above, STOP and report -
      the plan's model of this task is wrong and pressing on will produce a sweep
      that hides the difference.
- [ ] **Step 2: Write the failing tests** - arming creates no `confirmation` row;
      and (in `tourCopy.test.ts`, which owns `base`/`NAMES`) a pending
      `confirmation` row still composes, because a removed catalog entry throws a
      bare `TypeError` no containment block catches.
- [ ] **Step 3: Run and watch them fail.**
- [ ] **Step 4: Implement** the `REMINDER_KINDS` removal and correct the
      `MANUAL_ONLY_REMINDER_KINDS` comment.
- [ ] **Step 5: Re-point the app-side immediate-send sites** to the chosen
      vehicle. `seedLive.test.ts`'s local `REMINDER_KINDS` copy at `:84` and its
      rung-count assertion at `:219` belong to THIS task (Task 6 deliberately
      left them alone).
- [ ] **Step 6: Run `cd app && npx vitest run` and get it green.** The e2e side
      is Task 11's - the suite is expected to be RED between here and Task 11
      Step 6, and Task 11 owns closing it.
- [ ] **Step 7: Commit.**

---

### Task 10: Dashboard relabel and app-suite re-baseline

**Files:**
- Modify: `dashboard/src/api/types.ts` (`morning_of: 'Morning of'` ~`:1242`)
- Modify: `app/test/{tourRemindersApi,contactTimeline,devGating,relayAnnouncements,toursApi,relayApi}.test.ts`,
  `app/test/messages/catalog.test.ts`,
  `dashboard/src/routes/tours/RemindersPanel.test.tsx`

Relabel `morning_of` to `4 hours before`. The persisted KIND keeps its name for
the migration reason; the LABEL has no such constraint, and "Morning of" on a
rung that fires at 3pm is a staff-facing lie.

- [ ] **Step 1: Change the label in the dashboard map.**
- [ ] **Step 2: Run the app suite to a file and collect failures.**
      `cd app && npx vitest run > /tmp/app-suite.log 2>&1; echo "EXIT $?"`
- [ ] **Step 3: Re-baseline each failing expectation** to the new copy, timing and
      label. Where a test asserted a rung COUNT for a near-term booking, the new
      skip rules may legitimately change it - re-derive from the fixtures rather
      than force a number.
- [ ] **Step 4: Re-run until green**, plus `cd dashboard && npx vitest run`.
- [ ] **Step 5: Commit.**

---

### Task 11: The e2e ladder mirror

**Files:**
- Modify: `e2e/scenarios/steps.ts` (`TourTimes` `:211`, `timesFor` `:267`,
  `REMINDER_BODY_MARKERS` `:186`, `REMINDER_KIND_LABELS` `:205`)
- Modify: `e2e/tests/scenarios/quiet-hours.spec.ts:293,318`,
  `e2e/tests/scenarios/scheduled-visibility.spec.ts:163,228`,
  `e2e/tests/scenarios/tours.spec.ts:134`

THIS IS THE HARDEST TASK IN THE PLAN. Do not treat it as part of the sweep.

`timesFor` computes `dayBefore` HOST-locally as `sched - 24h`. After Task 6 that
rung is 19:30 ORG-LOCAL, which a host-local helper CANNOT compute. This is
exactly why `morningOf` was already removed from `TourTimes` - read the docblock
at `steps.ts:234-241`: it was "removed rather than left as a wrong answer waiting
to be used". The same now applies to `dayBefore`.

The change INVERTS: `morning_of` becomes a pure `-4h` offset and CAN be mirrored;
`day_before` cannot.

- [ ] **Step 1: Restructure `TourTimes`** - REMOVE `dayBefore`, ADD
      `morningOf: sched - 4h`. Keep `enRoute` and `noShowCheckin`. Update the
      docblock to explain the inversion and why, in the same voice as the
      existing one.
- [ ] **Step 2: Rework the five specs that tick off `times.dayBefore`** -
      `quiet-hours.spec.ts:293,318`, `scheduled-visibility.spec.ts:163,228`,
      `tours.spec.ts:134`.

      THE METHOD, because "compute it a different way" is not an instruction:
      READ THE ARMED `dueAt` BACK from the reminders API for the tour under test
      and drive `justAfter()` from that value. The server already computed the
      org-local instant; the harness does not need to reproduce the arithmetic,
      and a value read back is correct by construction at any wall clock. Do NOT
      invent a host-local approximation of 19:30 - that is the "wrong answer
      waiting to be used" the `TourTimes` docblock at `:234` warns about, and it
      is why `morningOf` was removed in the first place.

      HARDEST CASE, do not treat it as arithmetic: `quiet-hours.spec.ts:21`
      declares an explicit TIMING CONTRACT - "deterministic at ANY wall clock" -
      and the suite is deliberately time-of-day independent after a documented
      flake class. A fixed 19:30 org-local rung is exactly the dependency that
      contract excludes. Your rework must PRESERVE that property: a solution
      that passes only between certain hours is a regression against a contract
      someone already paid for. If reading the dueAt back cannot preserve it for
      a given assertion, change WHICH RUNG that assertion drives rather than
      weakening the contract.
- [ ] **Step 3: Update the markers.** Each fragment must appear in EVERY variant
      of its rung - address forks AND tour-type forks - or absence assertions
      pass vacuously:

```ts
export const REMINDER_BODY_MARKERS: Record<ReminderKind, string> = {
  confirmation: 'your tour is set for',
  day_before: 'confirming your tour tomorrow at',
  morning_of: 'looking forward to having you tour at',
  en_route: "on the way",
  no_show_checkin: 'Do you need to reschedule?',
};
```

`on the way` is deliberately the shared tail: the two `en_route` variants differ
exactly where a longer marker would be drawn from ("text me" vs "text here").

- [ ] **Step 4: Mirror the relabel** in `REMINDER_KIND_LABELS`.
- [ ] **Step 5: Note the new seed coupling.** `tourReminderBody()` (`:174`)
      composes through the app's own composer, so expectations now depend on the
      SEEDED tenant's first name. Thread it through `TourReminderContext` rather
      than hard-coding a name in each spec.
- [ ] **Step 6: Run e2e UNPIPED and read the real exit code.**

```bash
npm run e2e > /tmp/e2e-ladder.log 2>&1; echo "REAL EXIT: $?"
grep -E "^  [0-9]+ (passed|failed|flaky)" /tmp/e2e-ladder.log
```

- [ ] **Step 7: Commit.**

---

### Task 12: Issue registry, gates, handback

**Files:**
- Modify: `docs/issues/tourcopy-messageid-cast-unguarded.md`,
  `docs/issues/founder-message-template-updates-owed.md`

- [ ] **Step 1: Stamp `tourcopy-messageid-cast-unguarded.md` resolved** - the
      exhaustive switch in Task 4 plus the matrix test closes it. Add
      `resolved: 2026-08-26` and a Resolution line naming both.
- [ ] **Step 2: Update `founder-message-template-updates-owed.md`** - close the
      tour-ladder items; leave the relay ones open.
- [ ] **Step 3: `npm run issues`** to regenerate the gitignored index.
- [ ] **Step 4: Sync `main` into the branch once** (merge), preserving both sides.
- [ ] **Step 5: Gates 1-3 BARE.** `npm run typecheck`, `npm test`, `npm run smoke`.
      Compare any `npm test` failure against a base-commit run before blaming the
      branch; the DynamoDB Local GSI flake is known and passes in isolation.
- [ ] **Step 6: Gate 4, e2e, redirected** (command as Task 11 Step 6). Never piped.
- [ ] **Step 7: Gate 5, eslint on the branch's own files:**

```bash
npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx')
```

If that list is EMPTY, SKIP the gate - a bare `npx eslint` lints the whole repo
and fails on ~117 pre-existing errors.

- [ ] **Step 8: Update the non-test surfaces that STATE the ladder.** Each is a
      reader that otherwise disagrees with the new rule, and none is covered by
      any earlier task:
      - `documentation/tours-sequence-writeup.md:110-119` states the ladder
        verbatim.
      - `app/src/lib/seed/matrix.ts:958` - a THIRD hardcoded `scheduledAt - 24h`
        carrying a `computeDueAt('day_before') parity` comment this change
        falsifies. (`:930`, the `pm_team` generator, needs no change but explains
        why Task 4's `pm_team` case matters.)
      - `app/src/lib/seed/live.ts` describes a "Full 5-rung ladder".
      - `e2e/support/selectors.md:72` pins the Send-now accessible-name contract,
        which lists "Morning of" and must follow the Task 10 relabel.
- [ ] **Step 9: Confirm the segment gate is GREEN, do not "measure and report".**
      `tourCopy.test.ts:115` already asserts `analyzeSms(body).segments === 1`
      for every rung with a real seeded address. The new `tour.morning_of` copy
      has roughly NINETEEN characters of margin. If that gate is red, the answer
      is to shorten the copy or take a deliberate decision to allow two segments
      - NEVER to relax the assertion. Report the measured margin either way.
- [ ] **Step 10: File the deferrals in the issue registry.** Two things are
      deliberately NOT built here and would otherwise be lost with this branch:
      the quiet-hours exemption hook (spec 7.3, cut from Phase A) and the
      zero-primary property-contact leg having no e2e path (spec 13). File each
      as a `docs/issues/<slug>.md` from `_TEMPLATE.md`, and put a
      `TODO(<slug>)` marker on the new first-name helper for the
      `consolidate-contact-display-name-helpers` issue it deliberately adds to.
      Re-run `npm run issues`.
- [ ] **Step 11: Write the handback** naming: the measured segment margin; that
      the ladder is STILL PAUSED so nothing sends automatically; that a green
      e2e proves the machinery ONLY, because the dev tick injects an empty
      manual-only set production does not have; and - said plainly, because it is
      the part that reaches people - that FORCE-SEND is live and every word of
      this copy plus its fallbacks goes to real tenants the moment the founder
      presses Send now.

---

## Self-Review

**Spec coverage.** Section 5 copy -> Task 4. Section 6 tokens / 6.1 resolver /
6.2 helper -> Tasks 1, 3, 4. Section 6.3 fallbacks -> Tasks 3, 4 (absence) and 8
(failure). Section 6.4 -> Task 4 Step 1. Section 7 timing / 7.1 warn -> Tasks 2,
6, 7. Section 7.3 hook -> DEFERRED, see below. Section 8 skip rules / 8.1 visible
rows / 8.2 reason -> Tasks 5, 7. Section 9 restructure / 9.1 matrix / 9.2 no-show
/ 9.4 comment -> Tasks 4, 9. Section 10 batching -> Task 8 Step 4. Section 11
relabel -> Tasks 10, 11. Section 13 tests -> throughout. Section 14 gates ->
Task 12.

**Deferred with reason.** Spec 7.3's `QUIET_HOURS_EXEMPT_KINDS` hook is CUT from
Phase A. It needs injection points on two deps interfaces that do not exist, and
its second site - the fire-time backstop at `:729` - is unreachable in production
while the manual-only filter at `:470` short-circuits first. Building an
untestable, unreachable hook to make a later one-line change easier is not worth
the surface. Phase B adds it where it can be exercised. Spec 7.3 should be
amended to say so.

**Spec 9.3** (in-flight rows are not re-armed) has no task by design - it is a
consequence to state, carried by Task 12 Step 9.

**Placeholder scan.** Tasks 5, 10 and 12 describe assertions in prose. Task 5 is
a two-union-plus-label edit with the exact string given. Task 10 is a
failure-driven sweep whose expectations cannot be written before seeing the
output. Task 12 is verification. Every task with novel logic (1, 2, 3, 4, 6, 7,
8, 9, 11) carries real test code and concrete instants.

**Type consistency.** `contactFirstName` (T1) -> T3. `shiftLocalDate` (T2) -> T6.
`TourContactNames` / `failed` (T3) -> T4, T8. `booked_too_late` (T5) -> T7, so
T7 must not run before T5. `computeDueAt` export (T6) -> T7's raw comparison.
`tourType` required (T4) is why T4 carries the test-file compile fixes.
