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

- [ ] **Step 1: Write the failing tests.** Include, verbatim from the previous
      plan revision, the day_before/morning_of/en_route/pm_team/degrade/there/
      no_show cases, PLUS these two:

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
- [ ] **Step 6: Update `app/test/seedLive.test.ts`'s DELIBERATE twin** of
      `computeDueAt` (the function starts at `:53`) in lockstep, AND its local
      `REMINDER_KINDS` copy at `:84` and the rung-count assertion at `:219` -
      Task 9 removes `confirmation` from arming, so re-derive rather than guess.
      This file is `describe.skipIf(!reachable)`, so run it with Docker up or the
      drift guard silently passes.
- [ ] **Step 7: Run `cd app && npx vitest run test/seedLive.test.ts`** and confirm
      it did NOT skip.
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

Note `composeBodyForRow` already reads the unit for the address and its deps are
`Pick<RunDueTourRemindersDeps,'unitsRepo'>` with NO `contactsRepo`. Widen the
deps, and resolve the unit ONCE - do not read it twice.

- [ ] **Step 1: Write the failing tests**

```ts
it('SEND path: a contacts read failure leaves the rung UNCLAIMED, sends nothing', async () => {
  // Mirrors the roster_unavailable idiom: the poll retries, it does not send
  // fallback copy under a name we could not read.
  const rig = tourRig({ contactsRepo: { getById: async () => { throw new Error('boom'); } } });
  await runDueTourReminders(NOW, { ...rig.deps, manualOnlyKinds: new Set() });
  expect(rig.world.sent).toHaveLength(0);
  const row = await rig.repo.getById(rig.rowId);
  expect(row.sentAt).toBeUndefined();
  expect(row.skippedAt).toBeUndefined(); // unclaimed, NOT retired
});

it('SEND path: genuine ABSENCE still sends, greeting with "there"', async () => {
  const rig = tourRig({ contactsRepo: { getById: async () => undefined } });
  await runDueTourReminders(NOW, { ...rig.deps, manualOnlyKinds: new Set() });
  expect(rig.world.sent[0]!.body).toContain('Hey there,');
});

it('READ path: a contacts read failure degrades and does NOT 500 the bucket', async () => {
  const res = await request(app).get(`/api/tours/${tourId}/reminders`)...;
  expect(res.status).toBe(200);
});
```

- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement.** Send paths: on `failed`, return without claiming.
      Read paths: degrade to the absence fallbacks and never throw - each catches
      only `UncomposableReminderError`, so an escaping repo error 500s the bucket.
- [ ] **Step 4: Batch the timeline bucket.** `contactTimeline`'s Upcoming bucket
      walks MULTIPLE tours; resolve contacts once per request, not per rung
      (spec section 10). Assert the read count in a test.
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

- [ ] **Step 1: Write the failing tests** - arming creates no `confirmation` row;
      and (in `tourCopy.test.ts`) a pending `confirmation` row still composes,
      because a removed catalog entry would throw a bare `TypeError` no
      containment block catches.
- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and watch them pass.**
- [ ] **Step 5: Commit.**

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
- [ ] **Step 2: Rework the five specs that tick off `times.dayBefore`.** Each
      needs either the org-local 19:30 instant computed a different way, or to
      drive that rung by a different means. Do NOT invent a host-local
      approximation - that is the wrong answer the docblock warns about.
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

- [ ] **Step 8: Measure the segment count** for `tour.morning_of` with a real
      address, using `analyzeSms`. It is the highest-volume rung; a silent second
      segment doubles its cost. Report the number.
- [ ] **Step 9: Write the handback** naming: the segment measurement; that the
      ladder is STILL PAUSED and nothing sends automatically; and that a green
      e2e proves the machinery ONLY, because the dev tick injects an empty
      manual-only set that production does not have.

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
