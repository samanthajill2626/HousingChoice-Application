<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-09-01).** This document
> describes how this work was *designed/planned at the time of writing*. Phase A shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it.** Phase B
> continues this work and names this file as its predecessor - for anything still moving read
> `docs/superpowers/specs/2026-08-31-tour-reminder-ladder-phase-b-design.md`, then the code.
> The mission's review record is preserved at
> `docs/superpowers/reviews/2026-08-30-tour-reminder-ladder/`.

# Tour Reminder Ladder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the tour reminder ladder to the founder's 2026-08-24 copy:
tenant and property-contact first names on every compose path, the `day_before`
rung retimed to 19:30 org-local, `morning_of` retimed to four hours before,
two booked-too-late skip rules with a new visible skip reason, a tour-type
fork on the `en_route` rung, and the `_no_address` twins collapsed everywhere
the change touches.

**Architecture:** All copy stays in `MESSAGE_CATALOG`. `composeTourReminderBody`
remains the single composer and stays PURE and SYNCHRONOUS: it receives
already-resolved names, and every caller resolves them BEFORE composing (spec
6.3a). A new module `app/src/lib/tourContacts.ts` owns name resolution (never
throws; reports read failure distinctly from absence). Timing changes are
confined to `computeDueAt` and the arm loop. The ladder STAYS PAUSED: nothing
in this plan touches `MANUAL_ONLY_REMINDER_KINDS` or `REMINDER_KINDS`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, Playwright,
DynamoDB Local (Docker), Express.

**Spec:** `docs/superpowers/specs/2026-08-26-tour-reminder-ladder-design.md`
(FINAL, signed off, commit bb4b0475). Read it fully before Task 1. Where this
plan states a decision, the spec section it implements is cited; if they ever
appear to disagree, STOP and raise it - do not improvise.

**Worktree:** `W:/tmp/tour-reminder-ladder`, branch `feat/tour-reminder-ladder`.
Run every command from this worktree. Shell working directories can reset
between calls - `pwd` before trusting surprising output.

## Global Constraints

- **THE LADDER IS PAUSED AND STAYS PAUSED.** `MANUAL_ONLY_REMINDER_KINDS`
  (`app/src/jobs/tourReminders.ts:163`) contains every auto-armed rung and NO
  task edits it. Do NOT empty or shrink it to make a test green. Tests that
  need an automatic send inject an empty set via
  `RunDueTourRemindersDeps.manualOnlyKinds` (the dev tick route already does,
  `app/src/routes/dev.ts:421`; `app/test/tourReminders.test.ts:67-70` wraps the
  poll the same way). Consequence: `forceSendReminder` is the ONLY path that
  reaches a real person in this phase - treat it as a first-class path.
- **`confirmation` KEEPS ARMING.** `REMINDER_KINDS`
  (`app/src/jobs/tourReminders.ts:197`) is NOT edited (spec 2, 9.4). Both
  `tour.confirmation*` catalog entries stay, keep their current copy, and gain
  only the new token DECLARATIONS. Un-arming is Phase B.
- **ASCII only** on every new or touched line - source, comments, copy, test
  names, this plan's own edits. No em dashes, no smart quotes, no arrows.
  A single smart quote pasted from a Word document flips an SMS from GSM-7 to
  UCS-2 (spec 5); `app/test/messageCatalogAscii.test.ts` guards the catalog.
- **NEVER pipe a gate command.** A pipe returns the pipe's exit code - a
  10-failure e2e run was reported green this way on 2026-08-18. Redirect to a
  file and read `$?` (PowerShell: `$LASTEXITCODE` for native commands).
- **`npm run typecheck` TYPECHECKS THE TESTS** (`app/package.json` runs
  `tsconfig.test.json`) AND the e2e workspace. A signature change is not done
  until the test files and `e2e/` compile.
- **`npm test` needs DynamoDB Local** (`npm run db:start`). Suites
  `describe.skipIf(!reachable)` - a suite that SKIPS is not a suite that
  PASSED. When running `seedLive.test.ts` or `tourReminders.test.ts`, confirm
  the run did not print its `SKIPPED` warning. If the suite is red with
  timeouts and zero assertion failures, re-run under a clean access key first:
  `cd app && AWS_ACCESS_KEY_ID=hccleanrun001 npx vitest run` (AGENTS.md).
- **`ReminderKind` is persisted** (`app/src/repos/tourRemindersRepo.ts:78`) and
  must not be renamed - `morning_of` keeps its stored name despite firing four
  hours before the tour. `MessageId` is derived at compose time and persisted
  nowhere, so catalog ids may be added and removed freely (spec 9).
- **Resolve the org timezone via `resolveQuietHoursTimezone`**
  (`app/src/lib/quietHours.ts:39`) - in practice, use the window that
  `readQuietHoursWindow` returns; never read `settings.timezone` directly.
- **Product vocabulary** (`documentation/GLOSSARY.md`): tenant-facing copy says
  "home"/"tour", staff-facing says "property"; code says `unit`. The new copy
  in this plan is already compliant - transcribe it byte-for-byte from spec
  section 5, do not rephrase.
- **Commit after every task**, explicit paths only, never `git add -A`. Read
  bare `git status` first, check `.git/MERGE_HEAD` is absent. End the message
  with a `Co-Authored-By:` trailer naming the authoring model.
- **Expected red window:** the app suite and typecheck are green at the end of
  EVERY task. Task 4 ends with a FULL GREEN e2e run (its Step 15 requires it -
  the copy/signature/harness churn must be proven against the live stack
  BEFORE the retiming opens the red window, or Task 4 breakage becomes
  indistinguishable from retiming red). The e2e suite is then expected RED
  from the end of Task 6 (retiming) until Task 9 closes it - do not run the
  full e2e gate between those tasks and do not "fix" e2e failures before
  Task 9 says how.

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `app/src/lib/localTime.ts` | org-local date/time rendering | ADD `shiftLocalDate()` |
| `app/src/lib/tourContacts.ts` | resolve a tour's two names (never throws; reports per-read failure) | CREATE |
| `app/src/messages/catalog.ts` | copy + token declarations | REWRITE tour block; MessageId union +2/-4 |
| `app/src/messages/tourCopy.ts` | the ONE composer + the catalog-derived failure assessor | signature + `{addressLine}` + exhaustive id switch + `assessNamesReadFailure` |
| `app/src/repos/tourRemindersRepo.ts` | skip-reason union | ADD `booked_too_late` |
| `app/src/jobs/tourReminders.ts` | timing, arm loop, send paths, force-send | retimes; raw map + skip rules + warn; name resolution; `names_unavailable` refusal |
| `app/src/routes/tourReminders.ts` | panel API + no-show draft | hoist name resolve; draft through the composer |
| `app/src/routes/contactTimeline.ts` | Upcoming bucket preview | memo carries failure; per-unit property names |
| `app/src/routes/relayGroups.ts` | group-thread scheduled bucket | hoist resolve above the sync `.map()` |
| `dashboard/src/api/types.ts` | wire union, labels, send-now copy | `booked_too_late` + label; relabel `morning_of`; `names_unavailable` copy |
| `dashboard/src/routes/tours/RemindersPanel.tsx` | panel | aria-label sentence + blank-preview note |
| `dashboard/src/routes/contact/ScheduledCard.tsx` | timeline/group Upcoming cards | blank-preview note |
| `dashboard/src/routes/tours/TourDetail.tsx` | tour page (draft fetch) | route the draft 409 refusal through `sendNowErrorMessage(err.code)` |
| `e2e/scenarios/steps.ts` | harness mirror | context gains tourType+names; `TourTimes` inversion; markers; labels; `armedReminderDueAt` |
| `e2e/tests/...` (6 spec files) | tour flows | compile threading (Task 4), label strings (Task 8), tick rework (Task 9) |
| `app/src/lib/seed/{matrix,cast,live}.ts` | seed writers that state the ladder | new timings + comments |
| `documentation/tours-sequence-writeup.md` | prose ladder table | new timings |
| `docs/issues/*` | registry | close 1, update 2, file 2 |

Test files created: `app/test/tourContacts.test.ts`, `app/test/computeDueAt.test.ts`.
Test files modified: `app/test/localTime.test.ts`, `app/test/tourCopy.test.ts`,
`app/test/tourCopyCallSites.test.ts`, `app/test/tourReminders.test.ts`,
`app/test/tourRemindersApi.test.ts`, `app/test/relayApi.test.ts`,
`app/test/contactTimeline.test.ts`, `app/test/devGating.test.ts`,
`app/test/toursApi.test.ts`, `app/test/seedLive.test.ts`,
`dashboard/src/routes/tours/RemindersPanel.test.tsx`,
`dashboard/src/routes/tours/TourDetail.test.tsx`
(plus whatever the Task 6/7 suite runs surface - re-derive, never delete).

---

### Task 1: `shiftLocalDate()` calendar-day helper

**Files:**
- Modify: `app/src/lib/localTime.ts`
- Test: `app/test/localTime.test.ts` (exists - add a describe block)

**Interfaces:**
- Produces: `shiftLocalDate(localDate: string, days: number): string` -
  consumed by Task 6 (`computeDueAt`) and Task 10 (`seed/matrix.ts`).

Task 6 needs "the tour's local date minus one day" as a `'YYYY-MM-DD'` string.
No such helper exists in `app/src/lib`. Operate on the calendar string with
`Date.UTC` so no timezone is involved and DST cannot drift it.

- [ ] **Step 1: Write the failing tests** (append to `app/test/localTime.test.ts`;
  it already imports from `../src/lib/localTime.js`):

```ts
import { shiftLocalDate } from '../src/lib/localTime.js';

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
  it('throws its OWN error on a malformed date, never a bare RangeError', () => {
    // 'ab' parses to NaN, which is defined - a bare undefined-check would pass
    // it through to Date.UTC and throw a RangeError from toISOString instead.
    expect(() => shiftLocalDate('2026-ab-23', -1)).toThrow(/shiftLocalDate: unparseable/);
    expect(() => shiftLocalDate('nonsense', -1)).toThrow(/shiftLocalDate: unparseable/);
  });
});
```

- [ ] **Step 2: Run and watch them fail.**
  `cd app && npx vitest run test/localTime.test.ts -t shiftLocalDate`
  Expected: FAIL - `shiftLocalDate` is not exported.
- [ ] **Step 3: Implement** (append to `app/src/lib/localTime.ts`):

```ts
/** Shift a 'YYYY-MM-DD' CALENDAR date by whole days. Pure string arithmetic
 *  via Date.UTC - no zone is involved, so it cannot drift across a DST
 *  boundary. Pair with instantAtLocalTime (lib/quietHours.ts) to anchor a
 *  local wall-clock time on the shifted day. */
export function shiftLocalDate(localDate: string, days: number): string {
  const [y, m, d] = localDate.split('-').map(Number);
  if (
    y === undefined || m === undefined || d === undefined ||
    !Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)
  ) {
    throw new Error(`shiftLocalDate: unparseable local date "${localDate}"`);
  }
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
```

- [ ] **Step 4: Run and watch them pass.**
  `cd app && npx vitest run test/localTime.test.ts`
- [ ] **Step 5: Commit.**

```bash
git add app/src/lib/localTime.ts app/test/localTime.test.ts
git commit -m "feat(lib): shiftLocalDate for calendar-day arithmetic"
```

---

### Task 2: `resolveTourContactNames()` - the new module

**Files:**
- Create: `app/src/lib/tourContacts.ts`
- Test: `app/test/tourContacts.test.ts` (create)

**Interfaces:**
- Produces (consumed by Tasks 4 and 5):

```ts
export interface TourContactNames {
  tenantFirstName?: string;
  tenantName?: string;
  propertyContactFirstName?: string;
  propertyContactName?: string;
}
export interface ResolvedTourNames {
  names: TourContactNames;
  /** true only when the TENANT contact read THREW. Absence (no contact, no
   *  name on it) is undefined fields with both flags false. The two flags
   *  are DISTINCT because failure only matters where the composed entry
   *  actually uses the read - that decision (`assessNamesReadFailure`) lives
   *  in messages/tourCopy.ts, Task 4, DERIVED from the catalog templates. */
  tenantReadFailed: boolean;
  /** true only when the PROPERTY-CONTACT read threw. */
  propertyReadFailed: boolean;
}
export async function resolveTourContactNames(args: {
  tenantId: string;
  unit: UnitItem | undefined;
  tenantContact?: ContactItem;
  contactsRepo: Pick<ContactsRepo, 'getById'>;
  logger?: Logger;
}): Promise<ResolvedTourNames>;
```

DESIGN NOTES the implementation must honour, each traceable to the spec:

- The property contact resolves by the ESTABLISHED rule (spec 6.1,
  `app/src/lib/rosterResolution.ts:273-275`): the roster's `primaryContact`
  flag first, else the landlord of record. `unitContacts()`
  (`app/src/repos/unitsRepo.ts:295-303`) already synthesizes a primary row
  from `landlordId` when `contacts[]` is absent, so the explicit
  `landlordId` fallback covers the ZERO-PRIMARY roster (legal and reachable,
  `rosterResolution.ts:269`). Do NOT read the `unit.primary_contact` scalar
  (`unitsRepo.ts:253`) - nothing else resolves from it.
- KEEP THE EMPTY-STRING GUARD (spec 6.1): a legacy `landlordId: ''` must read
  as "no property contact", never reach `getById('')`. `nonEmpty` in
  `rosterResolution.ts:151` is module-private and stays that way - write the
  one-line check inline.
- Read the LIVE contact for names; roster rows carry a denormalized `name`
  (`unitsRepo.ts:72`) that goes stale (spec 6.1).
- The first-name helper lives HERE, not in `app/src/lib/contactName.ts` -
  that file's scope guard says its exports are for push-copy sites only and
  "do not re-point them here as a drive-by" (spec 6.2). Add a
  `TODO(consolidate-contact-display-name-helpers)` marker on the local
  helpers.
- `firstName`/`lastName` ride `ContactItem`'s index signature - both reads
  are defensive (a non-string must never reach `.trim()`).
- The UNIT is passed in, not read here: every caller already holds (or has
  already failed) its own unit read; folding that failure in is the caller's
  job (Task 5).
- NEVER throws. A throwing contact read sets its OWN flag
  (`tenantReadFailed` / `propertyReadFailed`), warns with IDS ONLY (never a
  name or phone - PII rule), and keeps whatever names did resolve.
- Deliberately NO surname fallback: greeting a tenant "Hey Chen," is worse
  than the composer's "Hey there," fallback.
- This module deliberately does NOT decide which failures MATTER. That
  decision (`assessNamesReadFailure`) is built in Task 4, inside
  `messages/tourCopy.ts`, DERIVED from the catalog templates - because it
  must consult the NEW catalog and `idFor`, which do not exist until Task 4,
  and because a hand-written needs-table here would be a mirror of the copy
  that a "pure string edit" (the exact change spec 6's token contract exists
  to make safe) could silently desync. This module only REPORTS what failed;
  Task 5's five consumers ask Task 4's assessor what that failure means.

- [ ] **Step 1: Write the failing tests** (`app/test/tourContacts.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { resolveTourContactNames } from '../src/lib/tourContacts.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';

const contact = (o: Record<string, unknown>): ContactItem => o as unknown as ContactItem;
const unit = (o: Record<string, unknown>): UnitItem => o as unknown as UnitItem;

function repoOf(byId: Record<string, ContactItem | undefined>, calls: string[]) {
  return {
    async getById(id: string): Promise<ContactItem | undefined> {
      calls.push(id);
      return byId[id];
    },
  };
}

const TENANT = contact({ contactId: 'c-t', firstName: 'Alice', lastName: 'Rivera' });

describe('resolveTourContactNames', () => {
  it('resolves the roster PRIMARY and the tenant, first and full names', async () => {
    const calls: string[] = [];
    const r = await resolveTourContactNames({
      tenantId: 'c-t',
      unit: unit({
        unitId: 'u1',
        landlordId: 'c-ll',
        contacts: [
          { contactId: 'c-ll', role: 'landlord', primaryContact: false },
          { contactId: 'c-pm', role: 'pm', primaryContact: true, name: 'Stale Cached' },
        ],
      }),
      contactsRepo: repoOf({ 'c-t': TENANT, 'c-pm': contact({ contactId: 'c-pm', firstName: 'Dana', lastName: 'Ortiz' }) }, calls),
    });
    expect(r).toEqual({
      names: {
        tenantFirstName: 'Alice', tenantName: 'Alice Rivera',
        propertyContactFirstName: 'Dana', propertyContactName: 'Dana Ortiz',
      },
      tenantReadFailed: false,
      propertyReadFailed: false,
    });
    // LIVE read, not the roster's denormalized name.
    expect(calls).toContain('c-pm');
  });

  it('a ZERO-PRIMARY roster falls back to the landlord of record', async () => {
    const r = await resolveTourContactNames({
      tenantId: 'c-t',
      unit: unit({
        unitId: 'u1', landlordId: 'c-ll',
        contacts: [{ contactId: 'c-x', role: 'pm', primaryContact: false }],
      }),
      contactsRepo: repoOf({ 'c-t': TENANT, 'c-ll': contact({ contactId: 'c-ll', firstName: 'Lee' }) }, []),
    });
    expect(r.names.propertyContactFirstName).toBe('Lee');
    expect(r.propertyReadFailed).toBe(false);
  });

  it('NO roster at all resolves the landlord via the synthesized primary', async () => {
    const r = await resolveTourContactNames({
      tenantId: 'c-t',
      unit: unit({ unitId: 'u1', landlordId: 'c-ll' }),
      contactsRepo: repoOf({ 'c-t': TENANT, 'c-ll': contact({ contactId: 'c-ll', firstName: 'Lee', lastName: 'Park' }) }, []),
    });
    expect(r.names.propertyContactName).toBe('Lee Park');
  });

  it('an EMPTY-STRING landlordId is "no property contact" - getById is never called with it', async () => {
    const calls: string[] = [];
    const r = await resolveTourContactNames({
      tenantId: 'c-t',
      unit: unit({ unitId: 'u1', landlordId: '', contacts: [] }),
      contactsRepo: repoOf({ 'c-t': TENANT }, calls),
    });
    expect(r.names.propertyContactFirstName).toBeUndefined();
    expect(r.propertyReadFailed).toBe(false);
    expect(calls).not.toContain('');
  });

  it('a NAMELESS contact is ABSENCE: undefined fields, no failure flags, no surname fallback', async () => {
    const r = await resolveTourContactNames({
      tenantId: 'c-t',
      unit: undefined,
      contactsRepo: repoOf({ 'c-t': contact({ contactId: 'c-t', lastName: 'Chen' }) }, []),
    });
    expect(r.names.tenantFirstName).toBeUndefined();
    expect(r.names.tenantName).toBe('Chen'); // full-name join still has a surname
    expect(r.tenantReadFailed).toBe(false);
    expect(r.propertyReadFailed).toBe(false);
  });

  it('a THROWING property read sets ONLY propertyReadFailed, never throws out, partial names kept', async () => {
    const r = await resolveTourContactNames({
      tenantId: 'c-t',
      unit: unit({ unitId: 'u1', landlordId: 'c-boom' }),
      contactsRepo: {
        async getById(id: string) {
          if (id === 'c-boom') throw new Error('repo down');
          return TENANT;
        },
      },
    });
    expect(r.propertyReadFailed).toBe(true);
    expect(r.tenantReadFailed).toBe(false);
    expect(r.names.tenantFirstName).toBe('Alice');
    expect(r.names.propertyContactFirstName).toBeUndefined();
  });

  it('a THROWING tenant read sets ONLY tenantReadFailed', async () => {
    const r = await resolveTourContactNames({
      tenantId: 'c-boom',
      unit: unit({ unitId: 'u1', landlordId: 'c-ll' }),
      contactsRepo: {
        async getById(id: string) {
          if (id === 'c-boom') throw new Error('repo down');
          return contact({ contactId: 'c-ll', firstName: 'Lee' });
        },
      },
    });
    expect(r.tenantReadFailed).toBe(true);
    expect(r.propertyReadFailed).toBe(false);
    expect(r.names.propertyContactFirstName).toBe('Lee');
  });

  it('a supplied tenantContact skips the tenant read', async () => {
    const calls: string[] = [];
    const r = await resolveTourContactNames({
      tenantId: 'c-t',
      unit: undefined,
      tenantContact: TENANT,
      contactsRepo: repoOf({}, calls),
    });
    expect(r.names.tenantFirstName).toBe('Alice');
    expect(calls).toEqual([]);
  });
});
```

(The failure-scope truth table that used to sit here belongs to Task 4's
`assessNamesReadFailure` - it cannot be written before the new catalog
exists, and its expected values must be checked against the catalog, not
against this module.)

- [ ] **Step 2: Run and watch them fail.**
  `cd app && npx vitest run test/tourContacts.test.ts`
  Expected: FAIL - module does not exist.
- [ ] **Step 3: Implement** `app/src/lib/tourContacts.ts`:

```ts
// Name resolution for tour-reminder copy (spec section 6). The composer
// (messages/tourCopy.ts) stays pure and synchronous; every caller resolves
// names through THIS module before composing. NEVER throws: a throwing repo
// read is reported on a per-read failure flag - what a given failure MEANS
// for a given rung is not decided here but by assessNamesReadFailure in
// messages/tourCopy.ts, which derives it from the catalog templates.
//
// PII: log IDs only - never a name or phone.
import type { ContactItem, ContactsRepo } from '../repos/contactsRepo.js';
import { unitContacts, type UnitItem } from '../repos/unitsRepo.js';
import { logger as defaultLogger, type Logger } from './logger.js';

export interface TourContactNames {
  tenantFirstName?: string;
  tenantName?: string;
  propertyContactFirstName?: string;
  propertyContactName?: string;
}

export interface ResolvedTourNames {
  names: TourContactNames;
  /** true only when the TENANT contact read THREW. Absence (no such contact,
   *  or no name on it) is undefined fields with both flags false - failure
   *  and absence must never be conflated (spec 6.3b). */
  tenantReadFailed: boolean;
  /** true only when the PROPERTY-CONTACT read threw. */
  propertyReadFailed: boolean;
}

// Local first/full-name derivations. lib/contactName.ts carries an explicit
// scope guard ("consumed by PUSH-COPY sites only ... do not re-point them
// here as a drive-by"), so this module keeps its own copy - deliberately,
// spec 6.2. firstName/lastName ride ContactItem's index signature, so both
// reads are defensive: a non-string must never reach .trim().
// Deliberately NO surname fallback for the first name: greeting a tenant
// "Hey Chen," is worse than the composer's "Hey there," fallback.
// TODO(consolidate-contact-display-name-helpers): fold into the shared
// helper when that issue is worked.
function firstNameOf(c: ContactItem | undefined): string | undefined {
  if (c === undefined) return undefined;
  const first = typeof c['firstName'] === 'string' ? c['firstName'].trim() : '';
  return first.length > 0 ? first : undefined;
}
function fullNameOf(c: ContactItem | undefined): string | undefined {
  if (c === undefined) return undefined;
  const first = typeof c['firstName'] === 'string' ? c['firstName'].trim() : '';
  const last = typeof c['lastName'] === 'string' ? c['lastName'].trim() : '';
  const joined = [first, last].filter((p) => p.length > 0).join(' ');
  return joined.length > 0 ? joined : undefined;
}

/**
 * Resolve the two names tour-reminder copy interpolates: the TENANT, and the
 * unit's PRIMARY CONTACT falling back to the landlord of record - the
 * established rule (lib/rosterResolution.ts:273-275). Reads the LIVE contact
 * for names; roster rows carry a denormalized name that goes stale.
 *
 * The UNIT is passed in, not read here: every caller already holds (or has
 * already failed) its own unit read, and that failure is the caller's to
 * fold into the send/read failure split.
 */
export async function resolveTourContactNames(args: {
  tenantId: string;
  unit: UnitItem | undefined;
  /** Skip the tenant read when the caller already fetched the contact (the
   *  poll's 1:1 route has it as resolveReminderTarget's target.contact). */
  tenantContact?: ContactItem;
  contactsRepo: Pick<ContactsRepo, 'getById'>;
  logger?: Logger;
}): Promise<ResolvedTourNames> {
  const log = args.logger ?? defaultLogger;
  let tenantReadFailed = false;
  let propertyReadFailed = false;

  let tenant = args.tenantContact;
  if (tenant === undefined) {
    try {
      tenant = await args.contactsRepo.getById(args.tenantId);
    } catch (err) {
      tenantReadFailed = true;
      log.warn({ err, tenantId: args.tenantId }, 'tour names: tenant contact read failed');
    }
  }

  // Primary-contact rule, with the inline empty-string guard replacing
  // rosterResolution's module-private nonEmpty() (spec 6.1): a legacy
  // landlordId of '' must read as "no property contact", never as an id.
  let propertyContact: ContactItem | undefined;
  if (args.unit !== undefined) {
    const primary = unitContacts(args.unit).find((c) => c.primaryContact === true);
    const landlordId =
      typeof args.unit.landlordId === 'string' && args.unit.landlordId.length > 0
        ? args.unit.landlordId
        : undefined;
    const propertyContactId = primary?.contactId ?? landlordId;
    if (typeof propertyContactId === 'string' && propertyContactId.length > 0) {
      try {
        propertyContact = await args.contactsRepo.getById(propertyContactId);
      } catch (err) {
        propertyReadFailed = true;
        log.warn(
          { err, unitId: args.unit.unitId, propertyContactId },
          'tour names: property contact read failed',
        );
      }
    }
  }

  const tenantFirst = firstNameOf(tenant);
  const tenantFull = fullNameOf(tenant);
  const propFirst = firstNameOf(propertyContact);
  const propFull = fullNameOf(propertyContact);
  return {
    names: {
      ...(tenantFirst !== undefined && { tenantFirstName: tenantFirst }),
      ...(tenantFull !== undefined && { tenantName: tenantFull }),
      ...(propFirst !== undefined && { propertyContactFirstName: propFirst }),
      ...(propFull !== undefined && { propertyContactName: propFull }),
    },
    tenantReadFailed,
    propertyReadFailed,
  };
}
```

- [ ] **Step 4: Run and watch them pass** (8 resolver tests).
- [ ] **Step 5: Commit.**

```bash
git add app/src/lib/tourContacts.ts app/test/tourContacts.test.ts
git commit -m "feat(tours): resolve tenant + property-contact names for reminder copy"
```

---

### Task 3: `booked_too_late` skip reason, both unions

**Files:**
- Modify: `app/src/repos/tourRemindersRepo.ts` (union ends at `:71`),
  `dashboard/src/api/types.ts` (wire union `:1205-1216`, label map `:1262-1274`)
- Test: `dashboard/src/routes/tours/RemindersPanel.test.tsx`

**Interfaces:**
- Produces: `'booked_too_late'` on both `ReminderSkipReason` unions; operator
  label `booked too late for this reminder`. Consumed by Task 7.

There are NINE existing reasons (count them - an earlier document said eight
and omitted `invalid_schedule`). None means "booked too late for this rung":
`past_event` would be a lie (the rung would land BEFORE the tour), and
`quiet_hours_superseded` would be a lie (nothing superseded it) - spec 8.2.
The two unions are hand-duplicated with nothing enforcing agreement. Be
precise about what fails where: omitting the dashboard UNION member entirely
fails no build - the chip silently degrades to a reason-less "Skipped"
(`RemindersPanel.tsx:99-108`) - but adding the union member while forgetting
the LABEL is a hard typecheck failure, because `REMINDER_SKIP_REASON_LABELS`
is typed `Readonly<Record<NonNullable<TourReminderView['skipReason']>,
string>>` (`types.ts:1262-1263`). The label test below therefore guards the
union-omitted-entirely case and the label WORDING; the Record type guards the
half-added case.

- [ ] **Step 1: Write the failing test** (dashboard side - this one is
  genuinely red, because the label map is runtime data). Model it on the
  existing skip-chip test at `RemindersPanel.test.tsx:134-148` ("a
  claim-skipped rung reads ..."): copy that test's fetch-stub arrangement,
  change the stubbed rung to
  `state: 'skipped', skippedAt: <any ISO>, skipReason: 'booked_too_late'`,
  and assert:

```ts
expect(screen.getByText('Skipped - booked too late for this reminder')).toBeInTheDocument();
```

  NOTE: the APP-side union addition has NO runtime red state - vitest strips
  types, so only `npm run typecheck` sees it. Do not write a type-only "test"
  and call it TDD; the dashboard label test plus Step 4's typecheck are the
  verification.

- [ ] **Step 2: Run and watch it fail.**
  `cd dashboard && npx vitest run src/routes/tours/RemindersPanel.test.tsx`
  Expected: the new test fails rendering `Skipped` (no matching label).
- [ ] **Step 3: Implement.**
  - `app/src/repos/tourRemindersRepo.ts` - append to the union after
    `'invalid_schedule'`:

```ts
  /** ARM time (spec 2026-08-26 section 8): the tour was booked (or
   *  rescheduled/revived - `now` is the ARM instant) too close to the rung's
   *  RAW due time for it to usefully fire. Written as a VISIBLE skipped row,
   *  unlike the silent past-dueAt drop, so a founder who booked late sees WHY
   *  the rung is missing instead of finding a gap. dueAt on such a row is the
   *  CLAMPED value, like every other arm-time skip row. */
  | 'booked_too_late'
```

  - `dashboard/src/api/types.ts` - append `| 'booked_too_late'` to the
    `skipReason` union (after `'invalid_schedule'` at `:1216`, with a short
    comment) and to `REMINDER_SKIP_REASON_LABELS`:

```ts
  booked_too_late: 'booked too late for this reminder',
```

- [ ] **Step 4: Verify.**
  `cd dashboard && npx vitest run src/routes/tours/RemindersPanel.test.tsx` - PASS.
  `npm run typecheck` (repo root) - exit 0.
- [ ] **Step 5: Commit.**

```bash
git add app/src/repos/tourRemindersRepo.ts dashboard/src/api/types.ts dashboard/src/routes/tours/RemindersPanel.test.tsx
git commit -m "feat(tours): booked_too_late skip reason on both unions with operator label"
```

---

### Task 4: Catalog, composer, and EVERY compose path (absence semantics)

This is the largest task. It lands the founder copy, the new composer
signature, and REAL name resolution at every call site, so that at its end
`npm run typecheck` and the app suite are green and preview/send bodies carry
names. FAILURE semantics (a throwing read) are Task 5; this task delivers
ABSENCE semantics (missing contact / nameless contact composes fallbacks).

**Files:**
- Modify: `app/src/messages/catalog.ts`, `app/src/messages/tourCopy.ts`
- Modify: `app/src/jobs/tourReminders.ts` (`composeBodyForRow:532` + its three
  callers `:846`, `:1006`, `:1224`)
- Modify: `app/src/routes/tourReminders.ts` (`bodyFor:229`, the GET/PATCH/
  send-now handlers that feed it, and the no-show draft `:538-549`)
- Modify: `app/src/routes/contactTimeline.ts` (`tourReminderBodyOrEmpty:716`,
  `unitOnce:859`, the tour walk `:874-927`)
- Modify: `app/src/routes/relayGroups.ts` (the scheduled bucket `:222-278`)
- Modify: `e2e/scenarios/steps.ts` (`TourReminderContext:140`,
  `tourReminderContext:164`, `tourReminderBody:173`,
  `REMINDER_BODY_MARKERS:191`, `ActiveTour:329`,
  `teamCreatesTourFromInterest:1675`, `requireTourReminderContext:3457`)
- Modify (compile threading): `e2e/tests/dashboard-next/tour-comms-pane.spec.ts:230`,
  `e2e/tests/scenarios/scheduled-visibility.spec.ts:129,148,221`
- Modify (compile threading): `app/test/tourReminders.test.ts:101` (`rungBody`),
  `app/test/tourRemindersApi.test.ts:244,844,1088`,
  `app/test/contactTimeline.test.ts:1108,1113`, `app/test/devGating.test.ts:459,464`
- Modify (re-derive): `app/test/toursApi.test.ts:1494-1508` (the existing
  no-show draft pin - its expected body changes)
- Test: `app/test/tourCopy.test.ts` (rewrite), `app/test/tourCopyCallSites.test.ts`
  (whitelist removal), `app/test/tourRemindersApi.test.ts` (draft + pin),
  `app/test/relayApi.test.ts` (the group-bucket name pin)

**Interfaces:**
- Consumes: `TourContactNames`, `resolveTourContactNames` (Task 2).
- Produces (consumed by every later task):

```ts
export interface ComposeTourReminderInput {
  kind: ReminderKind;
  scheduledAt: string;        // unchanged docblock
  timezone: string;           // unchanged docblock
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
- Also produces: `composeBodyForRow` deps widen to
  `Pick<RunDueTourRemindersDeps, 'unitsRepo' | 'contactsRepo'>` and it gains a
  trailing optional `tenantContact?: ContactItem` parameter.
- Also produces (consumed by Task 5's five consumers), in `tourCopy.ts`:

```ts
/** Which name reads the copy for (kind, tourType) actually RENDERS - derived
 *  from the CATALOG TEMPLATES, never hand-mirrored. */
export function reminderNamesUsed(
  kind: ReminderKind,
  tourType: TourType,
): { tenantName: boolean; propertyContact: boolean };

/** What a set of failed reads MEANS for one rung. blocksSend: the send/draft
 *  paths defer or refuse. withholdPreview: the preview paths render body: ''
 *  (only where the failure would change WHICH ENTRY composes). */
export function assessNamesReadFailure(args: {
  kind: ReminderKind;
  tourType: TourType;
  tenantReadFailed: boolean;
  propertyReadFailed: boolean;
  unitReadFailed: boolean;
}): { blocksSend: boolean; withholdPreview: boolean };
```

IMPORT LAYERING WARNING: `tourCopy.ts` is imported by the Playwright harness
(`e2e/scenarios/steps.ts:37`) and must stay free of AWS-SDK value imports.
Import ONLY the type from the new module:
`import type { TourContactNames } from '../lib/tourContacts.js';` and
`import type { TourType } from '../lib/toursModel.js';` (toursModel is pure,
zero imports). Never a VALUE import of `tourContacts.ts` from the composer or
the harness - `tourContacts.ts` value-imports `unitContacts` from
`repos/unitsRepo.js`, which drags the AWS SDK into the e2e bundle.
BECAUSE a type-only import is NOT a re-export, the composer must also
RE-EXPORT the type for its downstream consumers (the harness and the test
helpers import it from `tourCopy.js`, never from `tourContacts.js`):

```ts
export type { TourContactNames } from '../lib/tourContacts.js';
```

That one line is what makes Task 4 Step 11's harness import and Step 12's
test imports compile; a `verbatimModuleSyntax`-style type re-export is erased
at runtime, so the bundle stays AWS-free.

- [ ] **Step 1: Rewrite `app/test/tourCopy.test.ts`.** DELETE the old-copy
  expectations as you go (the pins at `:22-49`, the no-address describe's
  day_before/morning_of/en_route cases at `:52-75`, and the "the home" test at
  `:66-70` - that entry is being deleted). DELETE the
  `analyzeSms(body).segments).toBe(1)` assertion at `:116`: it encodes a
  requirement nobody agreed to (RULED, spec 5). KEEP: the ASCII guard, the
  "THEIR data is NEVER sanitized" UCS-2 test (`:120-128`), and the
  scheduledAt-precondition describe (`:131-151`) - those update for the new
  signature only. The new file content, in full where new:

```ts
import { describe, expect, it } from 'vitest';
import {
  assessNamesReadFailure,
  composeTourReminderBody,
  reminderNamesUsed,
  UncomposableReminderError,
} from '../src/messages/tourCopy.js';
import { MESSAGE_CATALOG } from '../src/messages/catalog.js';
import { TOUR_TYPES } from '../src/lib/toursModel.js';
import type { ReminderKind } from '../src/repos/tourRemindersRepo.js';
import { analyzeSms } from '../src/lib/smsEncoding.js';
import type { Address } from '../src/lib/address.js';

const NY = 'America/New_York';
const AT = '2026-07-23T19:00:00.000Z'; // Jul 23 15:00 EDT -> time "3:00 PM"

const base = { scheduledAt: AT, timezone: NY, tourType: 'self_guided', names: {} } as const;
const NAMES = {
  tenantFirstName: 'Alice', tenantName: 'Alice Rivera',
  propertyContactFirstName: 'Dana', propertyContactName: 'Dana Ortiz',
} as const;

describe('composeTourReminderBody: the founder copy (Sam, 2026-08-24)', () => {
  it('day_before greets by first name and uses the BARE time', () => {
    const body = composeTourReminderBody({ ...base, kind: 'day_before', names: NAMES });
    expect(body).toBe('Hey Alice, confirming your tour tomorrow at 3:00 PM. Does that still work for you?');
    expect(body, 'the date would double up with "tomorrow"').not.toContain('Jul 23');
  });

  it('morning_of carries the address as a trailing sentence', () => {
    expect(composeTourReminderBody({ ...base, kind: 'morning_of', names: NAMES, address: '412 Oak St' }))
      .toBe('Hey Alice, looking forward to having you tour at 3:00 PM today. Does that still work for you? Address is 412 Oak St.');
  });

  it('morning_of with NO address ends cleanly - no trailing "Address is", no {where}, no double space', () => {
    const body = composeTourReminderBody({ ...base, kind: 'morning_of', names: NAMES });
    expect(body).toBe('Hey Alice, looking forward to having you tour at 3:00 PM today. Does that still work for you?');
    expect(body).not.toContain('Address is');
    expect(body).not.toContain('{');
    expect(body).not.toContain('  ');
    expect(body.endsWith(' ')).toBe(false);
  });

  it('en_route forks on TOUR TYPE, and pm_team takes the landlord-led wording', () => {
    expect(composeTourReminderBody({ ...base, kind: 'en_route', names: NAMES }))
      .toBe("Hey Alice, can you please text me when you're on the way?");
    const landlordLed =
      "Hey Alice, Dana will be headed that way shortly. Can you please text here when you're on the way?";
    expect(composeTourReminderBody({ ...base, kind: 'en_route', tourType: 'landlord_led', names: NAMES }))
      .toBe(landlordLed);
    expect(composeTourReminderBody({ ...base, kind: 'en_route', tourType: 'pm_team', names: NAMES }))
      .toBe(landlordLed);
  });

  it('no property-contact name DEGRADES landlord-led AND pm_team to the self-guided wording', () => {
    for (const tourType of ['landlord_led', 'pm_team'] as const) {
      expect(composeTourReminderBody({
        ...base, kind: 'en_route', tourType, names: { tenantFirstName: 'Alice' },
      })).toBe("Hey Alice, can you please text me when you're on the way?");
    }
  });

  it('no tenant first name greets with "there"', () => {
    expect(composeTourReminderBody({ ...base, kind: 'day_before', names: {} }))
      .toBe('Hey there, confirming your tour tomorrow at 3:00 PM. Does that still work for you?');
  });

  it('no_show_checkin greets by name (D2 reversed - ruled, spec section 3)', () => {
    expect(composeTourReminderBody({ ...base, kind: 'no_show_checkin', names: NAMES }))
      .toBe('Hi Alice! Do you need to reschedule?');
    expect(composeTourReminderBody({ ...base, kind: 'no_show_checkin', names: {} }))
      .toBe('Hi there! Do you need to reschedule?');
  });

  it('confirmation is UNTOUCHED in Phase A - old copy, address fork intact', () => {
    expect(composeTourReminderBody({ ...base, kind: 'confirmation', names: NAMES, address: '412 Oak St Apt 2' }))
      .toBe('Hey, your tour is set for Thu, Jul 23 at 3:00 PM at 412 Oak St Apt 2.');
    expect(composeTourReminderBody({ ...base, kind: 'confirmation', names: NAMES }))
      .toBe('Hey, your tour is set for Thu, Jul 23 at 3:00 PM.');
  });
});

describe('address shapes (all through the morning_of clause)', () => {
  const M = 'Hey Alice, looking forward to having you tour at 3:00 PM today. Does that still work for you?';
  it('an all-empty structured address takes the no-address rendering', () => {
    expect(composeTourReminderBody({ ...base, kind: 'morning_of', names: NAMES, address: {} })).toBe(M);
  });
  it('a NULL address composes cleanly instead of throwing (seeds write raw items)', () => {
    expect(composeTourReminderBody({
      ...base, kind: 'morning_of', names: NAMES, address: null as unknown as Address,
    })).toBe(M);
  });
  it('a structured address contributes street only', () => {
    expect(composeTourReminderBody({
      ...base, kind: 'morning_of', names: NAMES,
      address: { line1: '412 Oak St', line2: 'Apt 2', city: 'Atlanta', state: 'GA', zip: '30312' },
    })).toBe(`${M} Address is 412 Oak St Apt 2.`);
  });
  it('a legacy string address passes through whole', () => {
    expect(composeTourReminderBody({
      ...base, kind: 'morning_of', names: NAMES, address: '350 Boulevard SE, Atlanta, GA 30312',
    })).toBe(`${M} Address is 350 Boulevard SE, Atlanta, GA 30312.`);
  });
});

// Closes docs/issues/tourcopy-messageid-cast-unguarded.md (spec 9.1): every
// reachable input composes, so a kind without a catalog entry can no longer
// fail OPEN into a bare TypeError at runtime. Doubles as the ASCII guard for
// OUR copy in every variant (spec 5 keeps ASCII, drops the segment budget).
describe('EXHAUSTIVE compose matrix', () => {
  const NON_ASCII = /[^\x20-\x7e]/;
  const kinds: ReminderKind[] = ['confirmation', 'day_before', 'morning_of', 'en_route', 'no_show_checkin'];
  it('every kind x {address, none} x tourType x {names, none} composes, ASCII-clean', () => {
    for (const kind of kinds) {
      for (const address of [undefined, '350 Boulevard SE, Atlanta, GA 30312'] as const) {
        for (const tourType of TOUR_TYPES) {
          for (const names of [NAMES, {}] as const) {
            const label = `${kind}/${address === undefined ? 'no-addr' : 'addr'}/${tourType}/${names === NAMES ? 'named' : 'anon'}`;
            let body = '';
            expect(() => {
              body = composeTourReminderBody({
                ...base, kind, tourType, names, ...(address !== undefined && { address }),
              });
            }, label).not.toThrow();
            expect(body.length, label).toBeGreaterThan(0);
            expect(body, label).not.toMatch(NON_ASCII);
          }
        }
      }
    }
  });
});

describe('token declarations', () => {
  const NAME_VARS = ['tenantFirstName', 'tenantName', 'propertyContactFirstName', 'propertyContactName'];
  it('every tour entry declares all four name tokens plus when/time (spec 6)', () => {
    const tourIds = (Object.keys(MESSAGE_CATALOG) as Array<keyof typeof MESSAGE_CATALOG>)
      .filter((id) => id.startsWith('tour.'));
    expect(tourIds.length).toBe(7); // 2 confirmation + day_before + morning_of + 2 en_route + no_show
    for (const id of tourIds) {
      const vars = MESSAGE_CATALOG[id].vars;
      for (const v of [...NAME_VARS, 'when', 'time']) {
        expect(vars, `${id} must declare {${v}}`).toContain(v);
      }
      // Declaring unused tokens is legal ONLY on editable entries
      // (catalog.test.ts's no-dead-tokens rule) - do not flip this flag.
      expect(MESSAGE_CATALOG[id].editable, `${id} must stay editable`).toBe(true);
    }
  });
  it('the confirmation no-address twin still does NOT declare where (the leak guard)', () => {
    expect(MESSAGE_CATALOG['tour.confirmation_no_address'].vars).not.toContain('where');
    expect(MESSAGE_CATALOG['tour.confirmation'].vars).toContain('where');
  });
  it('morning_of declares BOTH where and addressLine (spec 6.4: where stays for future edits)', () => {
    expect(MESSAGE_CATALOG['tour.morning_of'].vars).toContain('where');
    expect(MESSAGE_CATALOG['tour.morning_of'].vars).toContain('addressLine');
  });
});

// THE COPY-EDIT TRIPWIRE. assessNamesReadFailure is DERIVED from the catalog
// templates, so these pins are how a future "pure string edit" that adds or
// removes a name token announces itself: the derived answer flips, a row here
// goes red, and the failure semantics get re-ruled consciously instead of
// silently desyncing (the drift class spec 6.3a names). Do not re-baseline a
// failing row without re-deriving what the send/preview paths should now do.
describe('assessNamesReadFailure - the derived failure-scope table', () => {
  const ok = { tenantReadFailed: false, propertyReadFailed: false, unitReadFailed: false };
  const NONE = { blocksSend: false, withholdPreview: false };

  it('reminderNamesUsed reads the TEMPLATES: confirmation renders no name, everything else greets the tenant', () => {
    for (const tourType of TOUR_TYPES) {
      expect(reminderNamesUsed('confirmation', tourType))
        .toEqual({ tenantName: false, propertyContact: false });
      expect(reminderNamesUsed('day_before', tourType).tenantName).toBe(true);
      expect(reminderNamesUsed('no_show_checkin', tourType).tenantName).toBe(true);
    }
    expect(reminderNamesUsed('en_route', 'self_guided').propertyContact).toBe(false);
    expect(reminderNamesUsed('en_route', 'landlord_led').propertyContact).toBe(true);
    expect(reminderNamesUsed('en_route', 'pm_team').propertyContact).toBe(true);
  });

  it('confirmation is never blocked - its untouched copy renders no name', () => {
    expect(assessNamesReadFailure({
      kind: 'confirmation', tourType: 'landlord_led',
      tenantReadFailed: true, propertyReadFailed: true, unitReadFailed: true,
    })).toEqual(NONE);
  });

  it('a tenant-read failure BLOCKS THE SEND but does NOT withhold the preview (6.3b: previews degrade to "Hey there,")', () => {
    // EVERY tour type, not just self_guided: en_route's landlord-led entry
    // greets the tenant too, and it is the one template no other row
    // watches - sweeping only self_guided would let a copy edit remove
    // {tenantFirstName} from tour.en_route_landlord_led with zero red (the
    // ninth of nine plausible edits; the other eight trip other rows).
    for (const tourType of TOUR_TYPES) {
      for (const kind of ['day_before', 'morning_of', 'en_route', 'no_show_checkin'] as const) {
        expect(assessNamesReadFailure({
          kind, tourType, ...ok, tenantReadFailed: true,
        }), `${kind}/${tourType}`).toEqual({ blocksSend: true, withholdPreview: false });
      }
    }
  });

  it('a property/unit read failure on the en_route type fork blocks send AND withholds the preview (never a different ENTRY)', () => {
    for (const tourType of ['landlord_led', 'pm_team'] as const) {
      expect(assessNamesReadFailure({
        kind: 'en_route', tourType, ...ok, propertyReadFailed: true,
      })).toEqual({ blocksSend: true, withholdPreview: true });
      expect(assessNamesReadFailure({
        kind: 'en_route', tourType, ...ok, unitReadFailed: true,
      })).toEqual({ blocksSend: true, withholdPreview: true });
      // The name the copy does not use must not block the copy that has none.
      expect(assessNamesReadFailure({
        kind: 'day_before', tourType, ...ok, propertyReadFailed: true,
      })).toEqual(NONE);
    }
    expect(assessNamesReadFailure({
      kind: 'en_route', tourType: 'self_guided', ...ok, propertyReadFailed: true,
    })).toEqual(NONE);
  });

  it('a unit-read failure alone never blocks an address-only rung (never lost over a missing street)', () => {
    expect(assessNamesReadFailure({
      kind: 'morning_of', tourType: 'landlord_led', ...ok, unitReadFailed: true,
    })).toEqual(NONE);
  });

  it('TRIPWIRE: no entry renders the property token without FORKING on it - red here means a copy edit just activated the dead tokenBlanked branch and owes a preview rule (see assessNamesReadFailure)', () => {
    // Pins the invariant that keeps assessNamesReadFailure's second
    // tokenBlanked disjunct structurally dead: wherever the property token
    // is USED, a property failure blocks via the ENTRY FORK (withholdPreview
    // true), never via the blanked-token path (which would let a preview
    // render a blank name mid-sentence - spec 6.3 forbids that). A future
    // entry using the token without forking flips withholdPreview away from
    // used.propertyContact and fails HERE, which is the point.
    const KINDS = ['confirmation', 'day_before', 'morning_of', 'en_route', 'no_show_checkin'] as const;
    for (const tourType of TOUR_TYPES) {
      for (const kind of KINDS) {
        const used = reminderNamesUsed(kind, tourType);
        const impact = assessNamesReadFailure({
          kind, tourType, ...ok, propertyReadFailed: true,
        });
        expect(impact.blocksSend, `${kind}/${tourType} blocksSend`).toBe(used.propertyContact);
        expect(impact.withholdPreview, `${kind}/${tourType} withholdPreview`).toBe(used.propertyContact);
      }
    }
  });
});
```

  Then update the KEPT blocks in place: the UCS-2 test and the three
  scheduledAt-precondition tests each add `tourType: 'self_guided'` via
  `...base` (they already spread `base`, which now carries it) and keep their
  assertions byte-identical - EXCEPT the UCS-2 test's composed body now reads
  `... Address is O'Brien Court cafe... .` shape; keep its two assertions
  (`toContain(street)` and `encoding === 'UCS-2'`) which survive unchanged.
  (The non-ASCII street constant already uses escapes; leave it.)

- [ ] **Step 2: Run and watch the new tests fail.**
  `cd app && npx vitest run test/tourCopy.test.ts`
  Expected: compile errors first (no `tourType`/`names` on the input type),
  then copy mismatches. Both are valid red.

- [ ] **Step 3: Rewrite the catalog tour block** (`app/src/messages/catalog.ts`).
  - `MessageId` union (`:31-39`): REMOVE `'tour.day_before_no_address'`,
    `'tour.morning_of_no_address'`, `'tour.en_route'`,
    `'tour.en_route_no_address'`; ADD `'tour.en_route_self_guided'`,
    `'tour.en_route_landlord_led'`. Update the union's comment: only the
    confirmation pair keeps an address twin now.
  - Replace the TOKEN CONTRACT comment (`:100-117`) - it describes the twin
    scheme this change removes. New comment, verbatim:

```ts
  // TOKEN CONTRACT (founder rewrite, Sam 2026-08-24, applied 2026-08-26).
  // Every tour entry declares the FULL token set - when/time/where plus the
  // four name tokens - even where the current copy does not use one:
  // interpolate() iterates DECLARED vars and skips tokens absent from the
  // template, so declaring is what lets a future wording change be a pure
  // string edit (legal ONLY because these entries are editable:true; the
  // no-dead-tokens rule in catalog.test.ts applies to non-editable entries).
  //   - {time} is the TIME ALONE ("3:00 PM"): day_before/morning_of say
  //     "tomorrow"/"today" in the copy, so {when} there would double up.
  //   - {when} is DATE + TIME - used only by the confirmation, which can go
  //     out weeks ahead.
  //   - {addressLine} (morning_of only) is a WHOLE trailing sentence computed
  //     in code (tourCopy.ts): "Address is <street>." or the empty string, so
  //     a unit with no address degrades to a sentence that simply ends -
  //     never "Address is ." and never a literal {where}. The _no_address
  //     twin mechanism survives ONLY on the confirmation pair, whose copy
  //     uses {where} MID-sentence (untouched in Phase A - spec section 2).
  //   - en_route forks on TOUR TYPE, not address: self_guided vs landlord-led
  //     wording, with pm_team taking the landlord-led entry (spec 9.0).
```

  - The entries. `tour.confirmation` / `tour.confirmation_no_address` keep
    their `default` strings EXACTLY as they are; only their `vars` change.
    Shared list (write it once as a local const above the block):

```ts
const TOUR_NAME_VARS = [
  'when', 'time', 'tenantFirstName', 'tenantName',
  'propertyContactFirstName', 'propertyContactName',
] as const;
```

    Then:
    - `tour.confirmation`: `vars: [...TOUR_NAME_VARS, 'where']`
    - `tour.confirmation_no_address`: `vars: [...TOUR_NAME_VARS]` (NO `where` -
      the leak guard, spec 6.5)
    - `tour.day_before`: default
      `'Hey {tenantFirstName}, confirming your tour tomorrow at {time}. Does that still work for you?'`,
      `vars: [...TOUR_NAME_VARS, 'where']`
    - `tour.morning_of`: default
      `'Hey {tenantFirstName}, looking forward to having you tour at {time} today. Does that still work for you? {addressLine}'`,
      `vars: [...TOUR_NAME_VARS, 'where', 'addressLine']`
    - `tour.en_route_self_guided`: default
      `"Hey {tenantFirstName}, can you please text me when you're on the way?"`,
      `vars: [...TOUR_NAME_VARS, 'where']`
    - `tour.en_route_landlord_led`: default
      `"Hey {tenantFirstName}, {propertyContactFirstName} will be headed that way shortly. Can you please text here when you're on the way?"`,
      `vars: [...TOUR_NAME_VARS, 'where']`
    - `tour.no_show_checkin`: default
      `'Hi {tenantFirstName}! Do you need to reschedule?'`,
      `vars: [...TOUR_NAME_VARS]`, with a comment recording the D2 reversal:
      `// D2 REVERSED (Sam via Cameron, 2026-08-26): the founder asked for the`
      `// name here; "vaguer is kinder" was considered and overruled - spec s3.`
    - DELETE `tour.day_before_no_address`, `tour.morning_of_no_address`,
      `tour.en_route`, `tour.en_route_no_address`.
  - Transcribe the copy from spec section 5 BYTE-FOR-BYTE. The apostrophes in
    "you're" are ASCII `'` - `messageCatalogAscii.test.ts` will fail the build
    on a pasted curly quote.

- [ ] **Step 4: Rewrite the composer** (`app/src/messages/tourCopy.ts`).
  Update the module header (the D2 sentence at `:51-52` is now false), add
  the input interface per the Interfaces block above, and add the type
  re-export from the IMPORT LAYERING WARNING
  (`export type { TourContactNames } from '../lib/tourContacts.js';`) next to
  the interface so downstream consumers import both names from this module.
  Body:

```ts
export function composeTourReminderBody(input: ComposeTourReminderInput): string {
  const { kind, scheduledAt, timezone, tourType, names, address, overrides } = input;

  // Fallbacks (spec 6.3): a missing tenant first name greets "there"; the
  // property-contact tokens fall back to '' but are never RENDERED blank -
  // idFor() degrades to the self-guided entry before that could happen.
  const nameVars = {
    tenantFirstName: names.tenantFirstName ?? 'there',
    tenantName: names.tenantName ?? names.tenantFirstName ?? 'there',
    propertyContactFirstName: names.propertyContactFirstName ?? '',
    propertyContactName: names.propertyContactName ?? '',
  };

  // no_show_checkin stays ABOVE the scheduledAt validation: it is manual-send
  // only and must compose for past (and even timeless) tours. Its copy now
  // greets by first name (D2 reversed - spec section 3), so it takes the name
  // vars; it uses no time token.
  if (kind === 'no_show_checkin') {
    return resolveMessage('tour.no_show_checkin', nameVars, overrides).trim();
  }

  if (Number.isNaN(new Date(scheduledAt).getTime())) {
    throw new UncomposableReminderError(
      `tour reminder body needs a usable scheduledAt (kind=${kind})`,
    );
  }

  const street = formatStreet(address);
  const date = formatLocalDate(scheduledAt, timezone);
  const time = formatLocalTime(scheduledAt, timezone);
  // The address clause lives in CODE, not the catalog (spec 6.4): street
  // present -> a whole trailing sentence; absent -> the empty string, and the
  // final trim() removes the space the empty clause leaves behind.
  const addressLine = street.length > 0 ? `Address is ${street}.` : '';

  const id = idFor(kind, street.length > 0, nameVars.propertyContactFirstName.length > 0, tourType);

  return resolveMessage(
    id,
    {
      ...nameVars,
      when: `${date} at ${time}`,
      time,
      addressLine,
      ...(street.length > 0 && { where: street }),
    },
    overrides,
  ).trim();
}

/** Exhaustive id selection - replaces the unguarded string cast
 *  (docs/issues/tourcopy-messageid-cast-unguarded.md): the compiler now
 *  fails on a new ReminderKind instead of a bare TypeError escaping every
 *  containment block at runtime. */
function idFor(
  kind: ReminderKind,
  hasStreet: boolean,
  hasPropertyContactFirstName: boolean,
  tourType: TourType,
): MessageId {
  switch (kind) {
    case 'confirmation':
      // UNTOUCHED in Phase A (spec section 2): keeps its address twin because
      // its copy uses {where} MID-sentence. Phase B disposes of both entries.
      return hasStreet ? 'tour.confirmation' : 'tour.confirmation_no_address';
    case 'day_before':
      return 'tour.day_before';
    case 'morning_of':
      return 'tour.morning_of';
    case 'en_route':
      // Branch on === 'self_guided' ONLY - pm_team takes the landlord-led
      // wording (spec 9.0); never enumerate landlord_led alone. No
      // property-contact name DEGRADES to the self-guided entry: "will be
      // headed that way shortly" with a blank name asserts what we cannot
      // back (spec 6.3).
      return tourType === 'self_guided' || !hasPropertyContactFirstName
        ? 'tour.en_route_self_guided'
        : 'tour.en_route_landlord_led';
    case 'no_show_checkin':
      return 'tour.no_show_checkin';
  }
}
```

  (An exhaustive switch with no trailing return compiles - `computeDueAt` in
  `jobs/tourReminders.ts:96-117` is the in-repo precedent.)

  Then add the two failure-scope helpers BELOW `idFor`, in this same module -
  they are pure (catalog + string inspection only), so the harness bundle
  stays AWS-free, and living beside `idFor` is what lets the needs-table be
  DERIVED instead of hand-mirrored:

```ts
/** Which name reads the copy for (kind, tourType) actually RENDERS - derived
 *  from the CATALOG TEMPLATES themselves, never hand-mirrored, so the copy
 *  edit spec section 6 promises is "a pure string edit" can never silently
 *  desync the failure semantics: change a template's tokens and this answer
 *  changes with it (and the pinned truth-table test goes red, forcing the
 *  semantics to be re-ruled consciously).
 *
 *  Inspects the entries idFor would select WHEN NAMES RESOLVE (both address
 *  branches - the landlord-led entry for a non-self_guided en_route, both
 *  twins where an address pair exists), because the question is "did the
 *  failed read corrupt what we MEANT to compose", not what the degraded
 *  fallback would render. DEFAULTS only: no tour.* operator override can
 *  exist in Phase A (settingsToOverrides maps only welcome.sms and
 *  missed_call.autotext - messages/resolve.ts:74-79, and no tour compose
 *  site passes an overrides argument at all).
 *  TODO(tour-reminder-ladder-phase-b): the day a generic override map lands,
 *  widen this to the EFFECTIVE template - ComposeTourReminderInput.overrides
 *  already exists, so activating the hazard is one call-site argument away,
 *  and an override could add a name token the default lacks. */
export function reminderNamesUsed(
  kind: ReminderKind,
  tourType: TourType,
): { tenantName: boolean; propertyContact: boolean } {
  // BOTH address branches, deduped - fully derived, no kind list: for
  // confirmation this yields its two twins automatically, everywhere else it
  // collapses to one id. Never special-case a kind here - "which kinds have
  // address twins" is itself a catalog fact, and hand-listing it inside the
  // function that exists to stop hand-listing catalog facts is how the
  // no-address half of a future twin gets silently skipped.
  const ids = [...new Set([
    idFor(kind, true, true, tourType),
    idFor(kind, false, true, tourType),
  ])];
  const templates = ids.map((id) => MESSAGE_CATALOG[id].default).join(' ');
  return {
    tenantName:
      templates.includes('{tenantFirstName}') || templates.includes('{tenantName}'),
    propertyContact:
      templates.includes('{propertyContactFirstName}') ||
      templates.includes('{propertyContactName}'),
  };
}

/** What a set of failed reads MEANS for one rung (spec 6.3a/6.3b, as ruled
 *  2026-08-26). Two distinct severities, because the two spec sentences
 *  collide in exactly one place:
 *  - blocksSend: the failed read blanks or corrupts something the composed
 *    copy RENDERS, so a send would be a wrong-but-valid message (6.3b) -
 *    the poll defers, force-send and the no-show draft refuse.
 *  - withholdPreview: the failed read would change WHICH ENTRY composes ON
 *    THE NAME AXIS (today, exactly the en_route tour-type fork), so a
 *    preview rendering the degraded entry would show text the send never
 *    produces - 6.3a's "never a different ENTRY". Previews render body: ''
 *    there, and ONLY there: for a mere blanked token (a tenant-read blip on
 *    a day_before) 6.3b's read-path instruction stands unopposed and the
 *    preview degrades to the absence fallbacks ("Hey there,") - a truthful
 *    preview of the copy shape, NOT a blank ladder.
 *  NOTE the ADDRESS axis also flips an entry (confirmation's twins, on
 *  hasStreet, which a failed unit read flips) and is DELIBERATELY exempt:
 *  preview and send degrade the address identically, so no preview/send
 *  divergence can arise, and "a reminder must never be lost over a missing
 *  street" governs. The unit read blocks only where it feeds the property
 *  contact. */
export function assessNamesReadFailure(args: {
  kind: ReminderKind;
  tourType: TourType;
  tenantReadFailed: boolean;
  propertyReadFailed: boolean;
  unitReadFailed: boolean;
}): { blocksSend: boolean; withholdPreview: boolean } {
  const used = reminderNamesUsed(args.kind, args.tourType);
  const propertyReadLost = args.propertyReadFailed || args.unitReadFailed;
  // Does the ENTRY CHOICE itself hinge on the property-contact NAME? Derived
  // structurally from idFor across BOTH address branches, not from token
  // usage - the two coincide today (only the en_route type fork), but they
  // answer different questions and a future entry could use the token
  // without forking on it.
  //
  // THE ADDRESS FORK IS DELIBERATELY EXEMPT: confirmation's idFor branch
  // also flips ENTRY on hasStreet, and a failed unit read does flip it
  // (tour.confirmation vs its twin). That one is never blocked, knowingly -
  // preview and send degrade the address IDENTICALLY, so 6.3a's actual
  // concern (a preview showing text the send never produces) cannot arise,
  // and "a reminder must never be lost over a missing street" governs. Only
  // the NAME axis blocks.
  const forksOnPropertyName =
    idFor(args.kind, true, true, args.tourType) !==
      idFor(args.kind, true, false, args.tourType) ||
    idFor(args.kind, false, true, args.tourType) !==
      idFor(args.kind, false, false, args.tourType);
  const entryCorrupted = forksOnPropertyName && propertyReadLost;
  // The second disjunct below is STRUCTURALLY UNREACHABLE under today's
  // catalog: used.propertyContact is true only where forksOnPropertyName is
  // too (the derived-table test's tripwire row pins that invariant). It
  // exists for a future entry that renders the property token WITHOUT
  // forking on it - and if that entry ever ships, note what this code then
  // does: blocksSend goes true while withholdPreview stays false, so the
  // PREVIEW would render a blank name mid-sentence, which spec 6.3 forbids.
  // Whoever creates such an entry owes a preview rule along with it.
  const tokenBlanked =
    (used.tenantName && args.tenantReadFailed) ||
    (used.propertyContact && !forksOnPropertyName && propertyReadLost);
  return {
    blocksSend: entryCorrupted || tokenBlanked,
    withholdPreview: entryCorrupted,
  };
}
```

- [ ] **Step 5: Run the composer tests.**
  `cd app && npx vitest run test/tourCopy.test.ts` - all pass, including the
  matrix. Also run
  `cd app && npx vitest run test/messages/catalog.test.ts test/messageCatalogAscii.test.ts`
  - the generic invariants must already be green (every used token declared;
  ASCII).

- [ ] **Step 6: Wire the SEND paths** (`app/src/jobs/tourReminders.ts`).
  Replace `composeBodyForRow` (`:532-555`) with:

```ts
async function composeBodyForRow(
  row: TourReminderItem,
  tour: TourItem,
  window: QuietHoursWindow,
  deps: Pick<RunDueTourRemindersDeps, 'unitsRepo' | 'contactsRepo'>,
  log: Logger,
  /** The poll's 1:1 route has already fetched the tenant
   *  (resolveReminderTarget target.contact) - pass it through rather than
   *  reading twice. The GROUP route has read nothing; both reads happen
   *  here (spec 6.3a, ruled in scope). */
  tenantContact?: ContactItem,
): Promise<string> {
  let unit: UnitItem | undefined;
  try {
    unit = await deps.unitsRepo.getById(tour.unitId);
  } catch (err) {
    log.warn(
      { err, tourId: tour.tourId, kind: row.kind },
      'tour reminder: unit read failed - composing without an address',
    );
  }
  const resolved = await resolveTourContactNames({
    tenantId: tour.tenantId,
    unit,
    ...(tenantContact !== undefined && { tenantContact }),
    contactsRepo: deps.contactsRepo,
    logger: log,
  });
  return composeTourReminderBody({
    kind: row.kind,
    scheduledAt: tour.scheduledAt ?? '',
    timezone: window.timezone,
    tourType: tour.tourType,
    names: resolved.names,
    ...(unit?.address !== undefined && { address: unit.address }),
  });
}
```

  (INTERIM state, stated honestly: the resolver never throws, so after THIS
  task a throwing contact read is swallowed into absence names and the send
  paths compose fallback copy - failure temporarily masquerades as absence.
  Task 5 closes that with the `assessNamesReadFailure` gate; the split
  exists so the failure semantics can be test-driven against a working
  baseline. A throwing UNIT read still degrades to no-address, as today.)
  Imports:
  `resolveTourContactNames` from `../lib/tourContacts.js`, `UnitItem` type
  from `../repos/unitsRepo.js`. Callers:
  - `:846` (processReminderRow, 1:1 route - `target` is narrowed past the
    group return): `composeBodyForRow(row, tour, window, deps, log, target.contact)`.
  - `:1006` (sendGroupReminder): unchanged arg list (no contact in hand).
  - `:1224` (forceSendReminder):
    `composeBodyForRow(row, target.tour, window, deps, log, target.route === 'one_to_one' ? target.contact : undefined)`.

- [ ] **Step 7: Wire the tour-reminders ROUTE previews**
  (`app/src/routes/tourReminders.ts`). Replace `addressOf` (`:200-211`) with a
  combined per-request resolver so the unit is still read ONCE:

```ts
  /** The composing inputs behind a tour's rungs, resolved ONCE per request:
   *  the unit (address + property-contact source), the two names, and the
   *  per-read failure flags. Read paths must never 500 the ladder over a
   *  name: absence composes the fallbacks here (Task 4), and Task 5 adds the
   *  failure consumers via assessNamesReadFailure (entry-corrupting failures
   *  render body: ''; token-blanking failures degrade) AND contains the
   *  OTHER tenant read on this route (resolveTenantSuppression - Task 5). */
  const composeInputsOf = async (
    tour: TourItem,
  ): Promise<{
    address?: Address | string;
    names: TourContactNames;
    tenantReadFailed: boolean;
    propertyReadFailed: boolean;
    unitReadFailed: boolean;
  }> => {
    let unit: UnitItem | undefined;
    let unitReadFailed = false;
    try {
      unit = await units.getById(tour.unitId);
    } catch (err) {
      unitReadFailed = true;
      log.warn(
        { err, tourId: tour.tourId },
        'tour reminder preview: unit read failed - composing without an address',
      );
    }
    const resolved = await resolveTourContactNames({
      tenantId: tour.tenantId, unit, contactsRepo: contacts, logger: log,
    });
    return {
      ...(unit?.address !== undefined && { address: unit.address }),
      names: resolved.names,
      tenantReadFailed: resolved.tenantReadFailed,
      propertyReadFailed: resolved.propertyReadFailed,
      unitReadFailed,
    };
  };
```

  `bodyFor` (`:229`) gains `names: TourContactNames` after `address` and passes
  `tourType: tour.tourType, names` into its compose call - keep the DUPLICATED
  SHAPE comment, and note in it that name resolution is HOISTED to the caller
  on all three copies. Update the three handlers (GET list `:417-418`, PATCH
  echo `:314-315,323,335`, send-now echo `:377-379`) to call
  `composeInputsOf(tour)` where they called `addressOf(tour)` and thread both
  values into `bodyFor`.

- [ ] **Step 8: Route the no-show draft through the composer** (spec 9.2 -
  this is the composer-bypassing throw site). Replace the handler body at
  `:538-549`'s response line with:

```ts
    const window = await readQuietHoursWindow(settings, log);
    const resolved = await resolveTourContactNames({
      tenantId: tour.tenantId, unit: undefined, contactsRepo: contacts, logger: log,
    });
    // Through the ONE composer (spec 9.2): the entry now carries
    // {tenantFirstName}, and a bare resolveMessage would throw in strict
    // mode. unit: undefined is deliberate - this copy names no property.
    res.json({
      body: composeTourReminderBody({
        kind: 'no_show_checkin',
        scheduledAt: tour.scheduledAt ?? '',
        timezone: window.timezone,
        tourType: tour.tourType,
        names: resolved.names,
      }),
    });
```

  Update the route's docblock (`:532-537`): the copy is no longer
  "tour-independent and var-less". DELETE the now-unused `resolveMessage`
  import at `routes/tourReminders.ts:43` - that line was its ONLY use, and a
  dangling import is the exact `no-unused-vars` gate-5 trap AGENTS.md calls
  out by name (the error fires on a line the diff never touched). Then in
  `app/test/tourCopyCallSites.test.ts` DELETE the `ALLOWED_DIRECT` constant
  (`:33`) and its `if (id === ALLOWED_DIRECT) continue;` line (`:49`), and
  update the header comment: no direct `tour.*` resolution is allowed anywhere
  any more - the former exception's "token-free by design (spec D2)"
  justification was reversed. Finally, re-derive the EXISTING draft pin at
  `app/test/toursApi.test.ts:1494-1508`
  (`expect(res.body).toEqual({ body: 'Hi! Do you need to reschedule?' })`):
  its fixture's tenant determines the new expectation -
  `Hi <fixture firstName>! Do you need to reschedule?`, or
  `Hi there! ...` if that fixture's contact carries no firstName (read the
  fixture, do not guess). This file is committed in THIS task - a re-derived
  test left for a later task's commit is exactly the mixed-commit staging
  trap the explicit-paths rule creates.

- [ ] **Step 9: Wire the contact-timeline preview**
  (`app/src/routes/contactTimeline.ts`). Inside `gatherUpcoming`:
  - Change `unitOnce` (`:859-870`) to memoize a RESULT that carries failure
    distinctly (spec 6.3a - the old memo swallowed a failed read into
    `undefined`, collapsing failure into absence):

```ts
  interface UnitRead { unit: UnitItem | undefined; failed: boolean; }
  const unitReads = new Map<string, Promise<UnitRead>>();
  const unitOnce = (unitId: string): Promise<UnitRead> => {
    let pending = unitReads.get(unitId);
    if (pending === undefined) {
      pending = repos.unitsRepo
        .getById(unitId)
        .then((unit): UnitRead => ({ unit, failed: false }))
        .catch((err: unknown): UnitRead => {
          log.warn({ err, unitId }, 'contact timeline: unit read failed - composing without an address');
          return { unit: undefined, failed: true };
        });
      unitReads.set(unitId, pending);
    }
    return pending;
  };
```

  - Add a property-names memo KEYED BY unitId (spec 6.3a: the property
    contact varies per tour, so one per-request value would stamp one name
    onto every row; the TENANT is constant for this request - it IS the
    `contact` whose timeline this is, already in hand, costing zero reads):

```ts
  type UnitNames = ResolvedTourNames & { unitReadFailed: boolean };
  const nameReads = new Map<string, Promise<UnitNames>>();
  const namesOnce = (unitId: string): Promise<UnitNames> => {
    let pending = nameReads.get(unitId);
    if (pending === undefined) {
      pending = unitOnce(unitId).then((read) =>
        resolveTourContactNames({
          tenantId: contactId, unit: read.unit, tenantContact: contact,
          contactsRepo, logger: log,
        }).then((r): UnitNames => ({ ...r, unitReadFailed: read.failed })),
      );
      nameReads.set(unitId, pending);
    }
    return pending;
  };
```

    (`gatherUpcoming` does not currently receive a contacts repo: add
    `contactsRepo: Pick<ContactsRepo, 'getById'>;` to its params interface,
    destructure it alongside `conversationsRepo` at `:774-784`, and pass the
    route's existing contacts repo instance at the call site - the same way
    `conversationsRepo` is threaded at `:757`.)
  - In the tour walk (`:900`), replace the address read with
    `const read = await unitOnce(tour.unitId); const address = read.unit?.address; const { names } = await namesOnce(tour.unitId);`
    and pass `tour.tourType` + `names` through `tourReminderBodyOrEmpty`
    (`:716` - add the two parameters to its signature and compose call; keep
    its containment and the DUPLICATED SHAPE comment).

- [ ] **Step 10: Wire the relay-groups scheduled bucket**
  (`app/src/routes/relayGroups.ts:222-278`). The compose runs inside a
  SYNCHRONOUS IIFE inside `.map()` - the resolve CANNOT go behind it; HOIST it
  above the map (spec 6.3a). There is exactly ONE tour per request here, so
  one resolve serves every row. Restructure the unit read to keep the unit
  object, then resolve once:

```ts
    let unit: UnitItem | undefined;
    try {
      unit = await units.getById(tour.unitId);
    } catch (err) {
      log.warn(
        { err, tourId: tour.tourId },
        'group scheduled bucket: unit read failed - composing without an address',
      );
    }
    const address = unit?.address;
    const resolved = await resolveTourContactNames({
      tenantId: tour.tenantId, unit, contactsRepo: contacts, logger: log,
    });
    const names = resolved.names;
```

  (track `unitReadFailed` in the unit catch, like the other two surfaces -
  Task 5's body-'' branch inside the IIFE consumes `resolved` and
  `unitReadFailed`) and add `tourType: tour.tourType, names` to the compose
  call inside the IIFE (`:258-263`). The router already holds `contacts`
  (`:147`).

- [ ] **Step 11: Thread the e2e harness** (`e2e/scenarios/steps.ts`) - COMPILE
  and value threading only; tick timing is Task 9.
  - Extend the imports: `import type { TourContactNames } from '../../app/src/messages/tourCopy.js';`
    (alongside the existing composer import at `:37` - this resolves ONLY
    because Step 4 added the `export type` re-export to `tourCopy.ts`; never
    import from `app/src/lib/tourContacts.js` here, its `unitContacts` value
    import drags the AWS SDK into the e2e bundle) and
    `import type { TourType } from '../../app/src/lib/toursModel.js';`
    (toursModel has zero imports). Type-only imports keep the bundle AWS-free.
  - `TourReminderContext` (`:140`) gains `tourType: TourType;` and
    `names: TourContactNames;`.
  - `tourReminderBody` (`:173`) passes both through.
  - `tourReminderContext(unit, times)` (`:164`) gains a third parameter:

```ts
export function tourReminderContext(
  unit: Unit,
  times: TourTimes,
  extra: { tourType: TourType; names: TourContactNames },
): TourReminderContext {
  return {
    scheduledAt: instantOf(times), timezone: ORG_TIMEZONE,
    address: unit.addressLine1, tourType: extra.tourType, names: extra.names,
  };
}
```

  - `ActiveTour` (`:329`) gains `tourType: TourType;` (required) and
    `tenantFirstName?: string;`. Deliberately NO
    `propertyContactFirstName` field: nothing in the harness records the
    landlord's name against the active tour, so a field would be a contract
    with no way to satisfy it (see the docblock instruction below).
    `grep -n "this.activeTour =" e2e/scenarios/steps.ts` and thread the type
    at every constructor site (there is exactly ONE, at `:1720`);
    `teamCreatesTourFromInterest` (`:1675`) maps its label with

```ts
const TOUR_TYPE_BY_LABEL = {
  'Self-guided': 'self_guided', 'Landlord-led': 'landlord_led', 'PM team': 'pm_team',
} as const satisfies Record<string, TourType>;
```

    and records `tenantFirstName: this.activeTenant?.firstName` (the tour is
    always created from the tenant's file, so `activeTenant` is the tenant).
  - `requireTourReminderContext` (`:3457`) returns the new fields:

```ts
    return {
      scheduledAt: tour.scheduledAt,
      timezone: ORG_TIMEZONE,
      tourType: tour.tourType,
      names: {
        ...(tour.tenantFirstName !== undefined && { tenantFirstName: tour.tenantFirstName }),
      },
      ...(tour.addressLine1 !== undefined && { address: tour.addressLine1 }),
    };
```

    Add to its docblock, verbatim in intent: exact-equality assertions on the
    `en_route` LANDLORD-LED body are NOT supported through the step helpers -
    the harness records no property-contact name, so this context composes
    the self-guided wording for that one rung, exactly as the server does for
    a nameless contact. A spec needing the landlord-led body must compose it
    spec-locally with an explicit `names` object (the unit-level pin lives in
    `app/test/relayApi.test.ts`); the gap is tracked in
    `docs/issues/tour-reminder-zero-primary-e2e-gap.md` (Task 10 widens that
    issue to cover it). No current spec asserts that body - verified
    (`tours.spec.ts` asserts `confirmation`/`day_before` in-group and
    `en_route` only on a self_guided 1:1).
  - `REMINDER_BODY_MARKERS` (`:191`): the invariant is that each fragment
    appears in EVERY variant of its rung - address forks AND tour-type forks
    (spec 13). New values:

```ts
export const REMINDER_BODY_MARKERS: Record<ReminderKind, string> = {
  confirmation: 'your tour is set for',
  day_before: 'confirming your tour tomorrow at',
  morning_of: 'looking forward to having you tour at',
  // The marker invariant (spec 13): the fragment must appear in EVERY
  // variant of its rung. Byte-check both en_route entries: self-guided ends
  // "...text me when you're on the way?" and landlord-led ends "...text here
  // when you're on the way?", so "when you're on the way" is a shared
  // substring of BOTH - the invariant holds. It is preferred over the bare
  // "on the way" tail because markers back ABSENCE assertions and this
  // suite relays tenant-authored "On my way!" texts; the longer fragment is
  // not something a tenant types, so an absence check cannot collide with
  // relayed traffic.
  en_route: "when you're on the way",
  no_show_checkin: 'Do you need to reschedule?',
};
```

  - Spec-file threading (compile):
    - `e2e/tests/scenarios/scheduled-visibility.spec.ts:129,148,221` -
      `tourReminderContext(unit, times, { tourType: 'self_guided', names: { tenantFirstName: tenant.firstName } })`.
      At `:148` and `:221` the tenant is already destructured; Part A's
      call at `:129` is NOT - its `:101` destructure is
      `const { unit, times } = ...` and must become
      `const { tenant, unit, times } = ...` (`bookedSelfGuidedTour` already
      returns it).
    - `e2e/tests/dashboard-next/tour-comms-pane.spec.ts:230-236` - the inline
      object gains `tourType: 'self_guided', names: { tenantFirstName: tenant.firstName }`.
      Also update the stale `scheduled - 24h` comment at `:202-203` to name
      the new anchor.

- [ ] **Step 12: Compile-fix the app test call sites.** Every
  `composeTourReminderBody({...})` in tests gains `tourType` and `names`.
  Test files import both types from the COMPOSER module (via Step 4's
  re-export), extending imports they already have - e.g. in
  `tourReminders.test.ts`:
  `import { composeTourReminderBody, type TourContactNames } from '../src/messages/tourCopy.js';`
  and `import type { TourType } from '../src/lib/toursModel.js';`.
  - `app/test/tourReminders.test.ts:101` - `rungBody` becomes:

```ts
function rungBody(
  kind: ReminderKind,
  scheduledAt: string,
  tourType: TourType = 'self_guided',
  names: TourContactNames = {},
): string {
  return composeTourReminderBody({
    kind, scheduledAt, timezone: DEFAULT_ORG_SETTINGS.timezone, tourType, names,
  });
}
```

    This file's fixture contacts carry NO firstName anywhere (verified), so
    the poll composes "Hey there," bodies and `names: {}` matches; and with no
    property-contact names, `en_route` degrades to the self-guided entry for
    every tour type, so the default `tourType` is VALUE-safe too. Update the
    helper's docblock to say both of those things so the next person does not
    "fix" it.
  - `app/test/tourRemindersApi.test.ts:244,844,1088`,
    `app/test/contactTimeline.test.ts:1108,1113`,
    `app/test/devGating.test.ts:459,464` - add
    `tourType: <the tour type that fixture books>, names: {...}`. RULE for the
    `names` value: pass exactly the names the fixture's seeded contact
    carries (grep the fixture's contact creation in the same file - if it has
    a `firstName`, thread it; if not, `{}`). NEVER weaken a `toBe` body
    assertion to `toContain` to dodge a name mismatch.

- [ ] **Step 13: New route tests** (append to `app/test/tourRemindersApi.test.ts`,
  reusing its existing world/harness idioms):
  1. The no-show draft resolves the tenant's first name (RED before Step 8 -
     the route 500s on the strict missing-var throw once the catalog changes):
     seed a tenant contact with `firstName: 'Alice'`, a tour for them, then
     `GET /api/tours/:tourId/no-show-checkin-draft` and assert
     `res.body.body === 'Hi Alice! Do you need to reschedule?'`.
  2. REGRESSION PIN, expected green on first run (the resolver never throws
     by contract - label the test as a pin, it is not TDD): a SELF_GUIDED
     tour whose unit's landlord contact read THROWS still answers
     `GET /:tourId/reminders` 200, bodies composed with the absence
     fallbacks. The fixture is deliberately self_guided: no rung of a
     self_guided tour needs the property contact, so this pin stays green
     when Task 5's withhold rule lands (Task 5's own cases cover the
     landlord_led side).
  3. The poll's absence semantics (RED before this task's wiring): a tenant
     contact that EXISTS but has no name still receives its reminder,
     greeting "there" - drive the existing tick/poll harness and assert the
     sent body starts `'Hey there, '`. (Genuine absence must SEND; only
     FAILURE - Task 5 - must not. Do not write a test that requires an ABSENT
     tenant to send on the 1:1 route: `contact_missing` claim-skips before
     compose, deliberately - spec 6.3b.)
  4. The GROUP-THREAD scheduled bucket resolves the property name (in
     `app/test/relayApi.test.ts`, using that file's existing rig around its
     scheduled-bucket tests at `:1445-1502`; RED before Step 10's hoist):
     a `landlord_led` tour whose unit's landlord contact has
     `firstName: 'Dana'`, bound to a usable relay group -
     `GET /api/conversations/:conversationId/scheduled` renders the
     `en_route` card with a body containing
     `'Dana will be headed that way'`. This is the ONE preview surface that
     serves ONLY non-self_guided tours (`relayGroups.ts:213-218`), i.e. the
     exact place a dropped `propertyContactFirstName` silently flips the
     preview to the self-guided entry while the group SEND says the
     landlord-led one - the single highest-value instance of the 6.3a drift.

- [ ] **Step 14: Typecheck the WHOLE repo.** `npm run typecheck` - exit 0.
  This is the step that catches a missed call site, in src, tests, or e2e.
- [ ] **Step 15: Run the app suite, then the FULL e2e suite.**
  `cd app && npx vitest run` - green. For each residual body-expectation
  failure, align by threading the fixture's real names (Step 12 rule).
  Confirm `tourReminders.test.ts` did NOT self-skip. Then, from the worktree
  root, UNPIPED:

```bash
npm run e2e > .artifacts/e2e-task4.log 2>&1
echo "REAL EXIT: $?"
```

  Expected: GREEN - timing is untouched until Task 6, so this run is the
  proof that the copy, the composer signature, and the harness threading
  (every `tenantFirstName` the specs now compose with) agree with the live
  stack. This run exists precisely so Task 4 breakage can never hide inside
  the Task 6-9 retiming red window; a body-mismatch here is a Task 4 bug,
  full stop.
- [ ] **Step 16: Commit.**

```bash
git add app/src/messages/catalog.ts app/src/messages/tourCopy.ts app/src/jobs/tourReminders.ts app/src/routes/tourReminders.ts app/src/routes/contactTimeline.ts app/src/routes/relayGroups.ts e2e/scenarios/steps.ts e2e/tests/scenarios/scheduled-visibility.spec.ts e2e/tests/dashboard-next/tour-comms-pane.spec.ts app/test/tourCopy.test.ts app/test/tourCopyCallSites.test.ts app/test/tourReminders.test.ts app/test/tourRemindersApi.test.ts app/test/relayApi.test.ts app/test/toursApi.test.ts app/test/contactTimeline.test.ts app/test/devGating.test.ts
git commit -m "feat(tours): founder reminder copy with resolved names on every compose path"
```

---

### Task 5: Failure is not absence - scoped deferral, refusal, and preview withholding

**Files:**
- Modify: `app/src/jobs/tourReminders.ts` (`composeBodyForRow`, the two poll
  catch blocks `:848` and `:1008`, the force-send catch `:1226` AND its
  target-resolution call `:1172`, `ForceSendRefusal:1098`, the two docblocks
  at `:371-374` and `:525-526`)
- Modify: `app/src/routes/tourReminders.ts` (`bodyFor` + its FOUR call sites
  `:323`, `:335`, `:379`, `:495` - four, not five; an earlier count
  double-counted the PATCH 409 echo - the no-show DRAFT handler, and the
  `resolveTenantSuppression` call site `:458`),
  `app/src/routes/contactTimeline.ts` (`tourReminderBodyOrEmpty` + the walk),
  `app/src/routes/relayGroups.ts` (the scheduled-bucket IIFE)
- Modify: `dashboard/src/api/types.ts` (`SEND_NOW_ERROR_COPY:1284`),
  `dashboard/src/routes/tours/TourDetail.tsx:341-346` (the draft fetch's
  error copy), `dashboard/src/routes/tours/RemindersPanel.tsx` (~`:352`,
  the blank-preview note), `dashboard/src/routes/contact/ScheduledCard.tsx:98`
  (same note)
- Test: `app/test/tourReminders.test.ts`, `app/test/tourRemindersApi.test.ts`,
  `app/test/relayApi.test.ts`, `app/test/contactTimeline.test.ts`,
  `dashboard/src/routes/tours/TourDetail.test.tsx`,
  `dashboard/src/routes/tours/RemindersPanel.test.tsx`

**Interfaces:**
- Consumes: `ResolvedTourNames.tenantReadFailed` / `.propertyReadFailed`
  (Task 2) and `assessNamesReadFailure` (Task 4, catalog-derived), plus the
  flags Task 4 already threads through `composeInputsOf` / `namesOnce` / the
  relayGroups hoist.
- Produces: `ReminderNamesUnavailableError` (exported from
  `jobs/tourReminders.ts`); `'names_unavailable'` on `ForceSendRefusal` and
  as the no-show draft's 409 code; `SEND_NOW_ERROR_COPY['names_unavailable']`;
  the entry-scoped body-'' withhold on all three preview copies plus its
  operator-facing blank-preview note on both `body` renderers; containment
  on `resolveTenantSuppression` (paused-fallback-preserving) AND on
  force-send's target resolution.

THE RULE THIS TASK DELIVERS, two severities, one derived assessor
(`assessNamesReadFailure`, Task 4):
- `blocksSend` - the failed read blanks or corrupts something the composed
  copy RENDERS: the poll defers, force-send REFUSES, and the no-show DRAFT
  answers 409 (it is the head of a hand send - the FIFTH consumer; an earlier
  enumeration said four and was wrong, per review). Spec 6.3b: failure must
  not masquerade as absence where the copy needed the read.
- `withholdPreview` - the failure would change WHICH ENTRY composes (only
  the en_route type fork): previews render `body: ''` there, and ONLY there.
  For a merely blanked token (a tenant-read blip on a day_before) previews
  DEGRADE to the absence fallbacks - "Hey there," is a truthful preview of
  the copy shape, and 6.3b's read-path instruction stands unopposed where no
  entry flip threatens. Note the consequence honestly: on those cells the
  preview shows a body the send currently refuses - that is 6.3b's OWN
  split posture (READ degrades, SEND waits), not a defect.
EVERYWHERE ELSE a failure degrades exactly like absence and the message still
goes out - a day_before is never lost over a landlord-row outage or a missing
street (`jobs/tourReminders.ts:525-526`, `:371-374` - both docblocks get a
carve-out edit below, in the SAME change, so neither is left stating the old
blanket rule). ONE STATED EXCEPTION to "everywhere else", so nobody files it
as a contradiction: the force-send's TARGET-RESOLUTION containment refuses
for EVERY kind, `confirmation` included - the reads it guards resolve the
tour, the RECIPIENT and the conversation, not merely a name, and a send with
no resolvable recipient cannot go out no matter what its copy renders. The
copy-scoped rule above governs the COMPOSE gate only. FIVE consumers total:
`composeBodyForRow` (all send paths), the three preview copies, and the
draft handler. A fix that lands in four of five is this feature's signature
failure mode - check off each one.

**READ BEFORE WRITING A TEST - know what state Task 4 left.** The resolver
never throws, so after Task 4 a throwing contact read is SWALLOWED into
absence names: the poll and force-send compose fallback copy and SEND, and
previews render the degraded body. (Pre-Task-4 the throw escaped via
`resolveReminderTarget:647`'s bare tenant read - that path still fails early
by design; never build a fixture on the 1:1 tenant read.) Your red states are
therefore "it wrongly SENDS/renders a degraded body today", not "it throws
today" - with two exceptions that ARE throw-shaped today, because they sit on
bare reads this task contains: case 10 (`resolveTenantSuppression`, a 500)
and case 13 (`resolveReminderTarget` inside force-send, a rejection). For the
COMPOSE-GATE fixtures (cases 1, 2, 4), make the failing read the
PROPERTY-CONTACT read or the UNIT read on an `en_route` rung of a
non-self_guided tour - the tenant read on the 1:1 route fails BEFORE compose
and belongs to case 13's containment, not the compose gate. The draft and
panel fixtures (cases 9-12) fail the TENANT read - those routes read the
tenant fresh. The POLL's side of the pre-compose tenant read stays untouched:
its throw lands in the per-row catch and leaves the rung unclaimed, the right
net outcome under a generic log line.

- [ ] **Step 1: Write the failing tests.**
  THE SHARED FIXTURE for cases 1, 2 and 4: a `landlord_led` tour with NO
  `groupThreadId` (group unusable, so delivery falls back to the tenant 1:1 -
  the tenant contact, phone and 1:1 conversation exist in the world fakes),
  whose unit carries `landlordId: 'c-boom'`, with `world.contactsRepo`
  shimmed so `getById('c-boom')` throws while every other id resolves. Create
  the reminder ROW under test directly via `tourReminders.create({ tourId,
  kind, dueAt })` rather than arming the whole ladder, so each case drives
  exactly one rung. Settings: `quietOff`.
  TWO NON-OBVIOUS PRECONDITIONS keep this fixture on the compose path, both
  true of the file as it stands - know them so a "red for the wrong reason"
  check can actually be answered: (a) the 1:1 fallback's D7 pending-open wait
  cannot fire because `runDeps` omits `pendingRosterActionsRepo` (the dep is
  optional and the wait is gated on its presence,
  `jobs/tourReminders.ts:770-782`); (b) the throwing `c-boom` read cannot
  make the ROSTER unreadable, because `memberFromContact` catches its own
  contact-read throw (`lib/rosterResolution.ts:162-171`), so
  `tenantRosterGate` still answers `'on'` and neither the
  `roster_unavailable` wait nor its refusal token can produce a false pass -
  which is also why cases 1/2/4 must assert the EXACT warn string and the
  EXACT refusal reason, never just "nothing sent".
  In `app/test/tourReminders.test.ts` (the file's existing arrangement:
  `world` fakes + `runDeps` + `logCapture`):
  1. POLL defers `en_route` when the property read throws: one `en_route` row
     due now; run the poll. Assert: nothing sent, the row has NO `sentAt` and
     NO `skippedAt`, and `logCapture` contains
     `'tour reminder: name resolution read failed - leaving the rung unclaimed'`.
     RED after Task 4: the resolver swallows the throw and the poll SENDS the
     degraded self-guided body.
  2. FORCE-SEND refuses representably: same fixture, `forceSendReminder(...)`
     resolves to `{ outcome: 'refused', reason: 'names_unavailable' }` and
     the row is still pending. RED after Task 4: it resolves
     `{ outcome: 'sent' }` with the degraded body.
  3. End-to-end degrade JOIN (spec 13: zero-primary + nameless landlord): a
     `landlord_led` tour, unit with `contacts: [{ contactId: 'c-ll', role: 'landlord', primaryContact: false }]`
     and `landlordId: 'c-ll'`, where `c-ll` EXISTS but has no firstName, and
     the tenant is named. Drive the poll for the `en_route` rung and assert
     the SENT body is exactly the self-guided wording
     (`"Hey <TenantFirst>, can you please text me when you're on the way?"`).
     This is red only if Task 4 mis-wired the join - if it is green on first
     run, verify by mutating: temporarily give `c-ll` a firstName and confirm
     the body flips to the landlord-led wording, then restore. Keep the test.
  In `app/test/tourRemindersApi.test.ts`:
  4. The send-now ROUTE surfaces the refusal: the shared fixture's `en_route`
     rung, `POST .../send-now` answers 409 with
     `body.error === 'names_unavailable'` and the echoed reminder still
     `state: 'upcoming'`. RED after Task 4: 200 with the degraded body sent.
  5. PREVIEW WITHHOLDING on the reminders API: same fixture,
     `GET /:tourId/reminders` answers 200; the `en_route` rung's `body` is
     exactly `''`; the `day_before` rung's body composes NORMALLY (its copy
     never uses the failed read). RED after Task 4: the en_route body renders
     the self-guided text.
  In `app/test/relayApi.test.ts` (extend Task 4 Step 13 case 4's fixture):
  6. PREVIEW WITHHOLDING on the group bucket: the same landlord_led tour WITH
     a usable group, property read throwing -
     `GET /api/conversations/:id/scheduled` renders the `en_route` card with
     `body: ''` while the `day_before` and `confirmation` cards compose
     normally. RED after Task 4: the en_route card renders the self-guided
     text.
  Back in `app/test/tourRemindersApi.test.ts` / `app/test/toursApi.test.ts`
  (whichever file hosts the draft coverage - `toursApi` holds the existing
  pin, `tourRemindersApi` Task 4's new one; put this beside the latter):
  9. THE DRAFT REFUSES - the FIFTH consumer, and the one Phase A actually
     uses: a tour whose TENANT contact read throws (shim `getById` for the
     tenant id only) - `GET /:tourId/no-show-checkin-draft` answers 409 with
     `body.error === 'names_unavailable'`. RED after Task 4: 200 with
     `body: 'Hi there! Do you need to reschedule?'` - a failure-masquerading
     prefill that a human would then SEND by hand.
  10. THE PANEL SURVIVES A TENANT-READ FAILURE, and previews DEGRADE rather
     than blank (findings 2 + 4): a SELF_GUIDED tour with upcoming rungs
     whose TENANT contact read throws, driven with the router's DEFAULT
     manual-only set - use plain `makeWebhookHarness()`, NOT this file's own
     `previewHarness()` (`tourRemindersApi.test.ts:164-165`), which exists
     to inject the EMPTY manual-only set and would make `paused` false and
     the assertion below unmeetable - `GET /:tourId/reminders` answers 200
     (not 500), every
     name-bearing rung's body composes with the "Hey there," fallback and
     confirmation composes its nameless copy (NO body is `''` - a
     tenant-read blip must not blank the ladder), and every upcoming rung
     STILL carries `suppression: { reason: 'paused' }` with NO
     recipient-derived reason (opt-out / manual mode / quiet hours) on any
     rung. THE PAUSED HALF IS THE POINT: a failed read must fall back to the
     no-IO paused chip, never leave a defined-but-empty evaluator that lets
     the amber "sends in Nh" promise through - asserting "no suppression
     anywhere" here would PIN that regression (a round-3 review caught
     exactly that in an earlier draft of this case). RED after Task 4:
     `resolveTenantSuppression`'s bare `contacts.getById`
     (`routes/tourReminders.ts:572`) rejects and Express 5 turns it into a
     500 for the whole ladder.
  In `dashboard/src/routes/tours/TourDetail.test.tsx` (model on the existing
  draft test at `:611-625`):
  11. The draft 409 renders OPERATOR COPY, never the raw code:
     `getNoShowCheckinDraft` rejects with
     `new ApiError(409, 'names_unavailable', 'names_unavailable')` - the
     constructor form is deliberate: code and message are set to the SAME
     string so the assertion cannot pass by reading the wrong field - and
     the action error shows
     `'Could not look up everything this message needs, so nothing was sent - please try again.'`
     while the composer is NOT prefilled. RED before the Step 3 dashboard
     edit: the catch at `TourDetail.tsx:345` renders `err.message` RAW,
     which the `SEND_NOW_ERROR_COPY` contract forbids for machine codes.
  12. The draft 404 gets the load-shaped fallback: `getNoShowCheckinDraft`
     rejects with `new ApiError(404, 'tour_not_found', 'tour_not_found')` -
     the action error shows `'Could not load the check-in message'` (never
     "Couldn't send that just now" - nothing was being sent, and never the
     raw code). This pins the narrow routing so a later "simplification"
     cannot widen the send map over a load failure. RED before Step 3: the
     current catch takes its `err instanceof ApiError` branch and renders
     the raw `'tour_not_found'` - the fallback string is UNREACHABLE for any
     ApiError today, so this case is a red case, not a pin. (An earlier
     draft mislabelled it green-before; a builder who trusted that label and
     re-baselined the red would have PINNED the raw machine-code render the
     fix exists to remove.)
  Back in `app/test/tourReminders.test.ts`:
  13. FORCE-SEND refuses on a throwing TENANT read - the dominant cell: a
     SELF_GUIDED tour whose tenant contact read throws (shim `getById` for
     the tenant id), one `day_before` row - `forceSendReminder(...)`
     resolves to `{ outcome: 'refused', reason: 'names_unavailable' }`, the
     row is still pending, and `logCapture` contains
     `'tour reminder force-send: target resolution read failed'`. RED
     today AND after Task 4: the call REJECTS (the throw escapes
     `resolveReminderTarget:647` unwrapped - the route turns it into a 500).
  In `dashboard/src/routes/tours/RemindersPanel.test.tsx`:
  14. The blank preview carries a sentence: a stubbed rung with
     `state: 'upcoming', body: ''` renders the muted note
     `Preview unavailable - this message cannot be composed right now.`
     instead of an empty paragraph beside a live Send-now button. RED
     before Step 3's renderer branch lands (today the row renders bare
     emptiness). If a `ScheduledCard` test file exists
     (`glob dashboard/src/**/ScheduledCard.test*`), add the same pin there;
     if none exists, this case is the pin - do not create a new test file
     for one branch.
  GUARDS - green BEFORE and AFTER this task; they pin the invariants the
  over-broad version of this change would have broken (review findings
  A8/B2), so label each with `guard` in its test name and do NOT delete them
  for being green:
  - g1 (in `tourReminders.test.ts`): the shared throwing-property fixture
    with a `day_before` row - the poll SENDS it, body exactly
    `rungBody('day_before', scheduledAt)` (nameless tenant -> "Hey there,"),
    and the deferral warn does NOT appear for it. A landlord-row outage must
    not block copy that never names the landlord.
  - g2: a throwing UNIT read (shim `world.unitsRepo.getById` to throw) with a
    `day_before` row - still SENDS, without an address. "A reminder must
    never be lost over a missing street" survives for every rung that does
    not need the property contact.
  - g3: `confirmation` force-send with the UNIT read throwing - outcome
    `'sent'` (composed without an address). Its untouched Phase A copy
    renders no name, so no failed read can corrupt it. FIXTURE FACT the
    builder must not "fix": with the unit read throwing, `unit` is
    `undefined`, and the resolver only ATTEMPTS the property read when a
    unit is in hand - so `propertyReadFailed` is structurally `false` here.
    That is correct behaviour, not a gap; do NOT alter
    `resolveTourContactNames` to report a failure for a read it never made.
    If property-read coverage on confirmation is wanted, write it as a
    SECOND case with the unit read SUCCEEDING and only `getById('c-boom')`
    throwing - also outcome `'sent'`. (Do not throw the TENANT read in
    either g3 variant: that read happens inside `resolveReminderTarget`
    BEFORE compose, so it exercises the target-resolution containment - a
    DIFFERENT behaviour with its own red case, number 13 - not the compose
    gate these guards pin.)
  PINS on Task 4's batching and cache keying - expected GREEN on first run
  (label them as pins; they exist to catch future drift):
  In `app/test/contactTimeline.test.ts` (the gather harness at `:1121`):
  7. Property names are memoized PER UNIT (spec 6.3a batching) and rendered
     correctly per unit: one tenant with TWO `landlord_led` tours that have
     NO `groupThreadId` (unusable group -> the Upcoming walk INCLUDES them,
     `contactTimeline.ts:883-899`) on DIFFERENT units whose landlords have
     different first names - each tour's `en_route` Upcoming body carries its
     OWN landlord's name (`toContain('Dana will be headed')` vs
     `toContain('Lee will be headed')`); plus a third tour on the FIRST unit,
     asserting `unitsRepo.getById` was called exactly ONCE for that unitId
     (count calls on the stub). This is the surface that MEMOIZES by unitId,
     so this is where the wrong cache key would stamp one person's name onto
     every row - the exact bug spec 6.3a names.
  In `app/test/tourRemindersApi.test.ts`:
  8. Per-tour correctness on the reminders API: two `landlord_led` tours on
     DIFFERENT units with differently-named landlords -
     `GET /api/tours/:tourId/reminders` for each renders its OWN landlord's
     first name in the `en_route` body.
- [ ] **Step 2: Run and confirm cases 1, 2, 4, 5, 6, 9, 10, 11, 12, 13 and
  14 are red for the RIGHT reason** (a degraded body is sent/rendered/
  prefilled where the new rule withholds or refuses it, a 500/rejection
  where the route must degrade or refuse, a raw machine code where operator
  copy belongs, or bare emptiness where the note belongs - not a broken
  fixture; the preconditions stated on the shared fixture are what to check
  when in doubt) and case 3 passes its mutation check. Any of those that is
  green before implementation gets deleted or re-pointed - a green "red
  state" is not a test. Guards g1-g3 and pins 7-8 are declared
  green-on-first-run and are exempt.
- [ ] **Step 3: Implement.**
  - New error class next to `UncomposableReminderError`'s import in
    `jobs/tourReminders.ts`:

```ts
/** Thrown by composeBodyForRow when a repo read that this rung's copy
 *  actually NEEDS threw (spec 6.3b via assessNamesReadFailure's blocksSend -
 *  failure is not absence, and must not degrade into a wrong-but-valid
 *  message; but a failure the copy never renders degrades exactly like
 *  absence and the message still goes out). The poll leaves the rung
 *  UNCLAIMED - it re-lists next tick; a force-send REFUSES with
 *  'names_unavailable' so the human gets an answer (the no-show DRAFT route
 *  makes the same refusal with the same token, without this error class).
 *  Never thrown for genuine absence: absent or nameless contacts compose
 *  the fallbacks. */
export class ReminderNamesUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReminderNamesUnavailableError';
  }
}
```

  - In `composeBodyForRow`: it already tracks `unitReadFailed` (Task 4).
    After resolving, gate on the SHARED assessor - never on a bare flag:

```ts
  const impact = assessNamesReadFailure({
    kind: row.kind,
    tourType: tour.tourType,
    tenantReadFailed: resolved.tenantReadFailed,
    propertyReadFailed: resolved.propertyReadFailed,
    unitReadFailed,
  });
  if (impact.blocksSend) {
    throw new ReminderNamesUnavailableError(
      `tour reminder name resolution read failed (tourId=${tour.tourId}, kind=${row.kind})`,
    );
  }
```

    (`assessNamesReadFailure` is a VALUE import from
    `../messages/tourCopy.js`, alongside the composer import the file
    already has - the module is pure.) A missing
    unit or contact (read succeeds, returns undefined) still composes - that
    is absence. THEN update the two docblocks that state the old blanket
    rule, in this same change, so neither is left lying:
    - the `composeBodyForRow` header (`:525-526` "a reminder must never be
      lost over a missing street"): append the carve-out - since 2026-08-26
      the unit read also FEEDS the property-contact resolution, so on an
      `en_route` rung of a non-self_guided tour a THROWING unit read raises
      `ReminderNamesUnavailableError` instead of degrading; every other rung
      keeps the never-lost-over-a-street rule.
    - the `RunDueTourRemindersDeps.unitsRepo` note (`:371-374` "never blocks
      a send"): same carve-out, one sentence.
  - `processReminderRow` (`:848`) and `sendGroupReminder` (`:1008`): extend
    each compose catch:

```ts
    if (err instanceof ReminderNamesUnavailableError) {
      log.warn(
        { reminderId: row.reminderId, tourId: row.tourId, kind: row.kind },
        'tour reminder: name resolution read failed - leaving the rung unclaimed for the next tick',
      );
      return;
    }
```

    (AFTER the `UncomposableReminderError` branch, before the rethrow. This
    is deliberately the quiet-backstop shape - no claim, no skip stamp. A
    PERMANENTLY failing read re-lists each tick with NO self-clearing bound;
    accepted for Phase A because the production poll sits behind the
    manual-only filter, and 8.2 grants no reason token for a bounded
    escalation. That acceptance expires with the pause, so it is RECORDED as
    item (7) of the Phase B ledger issue Task 10 creates - the ledger, not
    this plan, is what gets read at unpause.)
  - `forceSendReminder` (`:1226` catch): add the same instanceof branch
    returning `refuse('names_unavailable')`. Add to `ForceSendRefusal`
    (`:1098`):

```ts
  /** A repo read this send needed threw (spec 6.3b): the compose gate's
   *  name resolution, or ANY read inside target resolution (tour /
   *  recipient / conversation lookups) - the latter refuses every kind,
   *  confirmation included, because the failed read is the recipient
   *  lookup, not a name. Pre-claim, row left pending; the operator copy is
   *  deliberately cause-agnostic ("everything this message needs"). */
  | 'names_unavailable'
```

  - `dashboard/src/api/types.ts` `SEND_NOW_ERROR_COPY` - add (reminder-only;
    a NEW key cannot change nudge behaviour, which is the 6.3b constraint on
    this shared map):

```ts
  // Reminder-only (spec 2026-08-26 6.3b): a repo read this send needed
  // failed - the compose gate's name resolution, OR any read inside the
  // force-send's target resolution (tour / recipient / conversation lookups
  // share this refusal). Nothing was claimed. The copy is deliberately
  // cause-agnostic ("everything this message needs", not "the names"):
  // three of the four target-resolution reads are not name reads, and
  // telling an operator "could not look up the names" during a tours-table
  // outage sends them to the wrong next action.
  names_unavailable:
    'Could not look up everything this message needs, so nothing was sent - please try again.',
```

  - THE PREVIEW WITHHOLD, mirrored into ALL THREE hand-copied compose blocks
    (a fix landed in one and missed in two is this feature's signature
    failure mode - update every DUPLICATED SHAPE comment to name BOTH ''
    rules: the existing `UncomposableReminderError` catch AND this one):
    - `routes/tourReminders.ts` `bodyFor`: gains the three flags (Task 4's
      `composeInputsOf` already returns them). This is `bodyFor`'s SECOND
      widening (Task 4 added `names`), and every call site must move again
      in this task - FOUR today: the two PATCH echoes (the 409 branch at
      `:323` and the success echo at `:335`), the send-now echo (`:379`),
      and the GET list map (`:495`), plus any Task 4 added. Do not hunt for
      a fifth - an earlier review round double-counted the PATCH 409 echo;
      typecheck enumerates the real set. After the sentBody-snapshot check
      and BEFORE composing:

```ts
    // Spec 6.3a "never a different ENTRY": a failed read that would change
    // WHICH ENTRY composes renders NO body rather than a wrong one. A
    // failure that merely blanks a token the copy renders does NOT withhold:
    // per 6.3b the preview degrades to the absence fallbacks ("Hey there,")
    // while the SEND side waits - the spec's own split posture.
    if (
      assessNamesReadFailure({
        kind: row.kind,
        tourType: tour.tourType,
        tenantReadFailed: flags.tenantReadFailed,
        propertyReadFailed: flags.propertyReadFailed,
        unitReadFailed: flags.unitReadFailed,
      }).withholdPreview
    ) {
      return '';
    }
```

      (A SENT rung is untouched - its snapshot renders first, above this.)
    - `routes/contactTimeline.ts` `tourReminderBodyOrEmpty`: same branch;
      its flags come from `namesOnce(tour.unitId)` (Task 4's `UnitNames`
      carries all three).
    - `routes/relayGroups.ts`: same branch at the top of the scheduled-map
      IIFE, from the hoisted `resolved` + `unitReadFailed` locals.
    No extra warn in these branches: the resolver and the unit catches
    already logged the underlying failure once per request.
  - GIVE THE BLANK A SENTENCE (review A3): both surfaces that render a rung
    `body` take it bare, so a withheld preview would show a kind label, an
    "upcoming" chip, a LIVE Send-now button and no text - blank-with-a-button
    reads as a broken app, not a degraded read. Add a muted empty-state
    branch to BOTH renderers (the same two-component sweep as the labels -
    reviewer-verified that these are the only two `body` readers):
    - `dashboard/src/routes/tours/RemindersPanel.tsx` (~`:352`, the
      `<p className={styles.body}>{rung.body}</p>` line): when
      `rung.body === ''`, render instead the muted note
      `Preview unavailable - this message cannot be composed right now.`
      (reuse the panel's existing muted-note styling -
      `RemindersPanel.module.css` has `.muted` and the suppression-note
      block). The gate is DELIBERATELY state-agnostic: an empty body can
      ride any state (`bodyFor` withholds and the `UncomposableReminderError`
      catch empties regardless of state, and `booked_too_late` makes visible
      skipped rows common), and a bare empty paragraph under a
      "Skipped -" chip or a struck-through canceled row reads just as broken
      as the upcoming case. The sentence is state-agnostic, so one branch
      covers them all; the upcoming case (blank beside a live Send-now
      button) is merely the worst of them and is what case 14 pins.
    - `dashboard/src/routes/contact/ScheduledCard.tsx:98`: same note when
      `item.body === '' && item.source === 'tour_reminder'`. STYLING NOTE:
      this file's `styles` import does NOT resolve to a same-directory
      `ScheduledCard.module.css` - follow the import to the actual sheet and
      reuse a muted class there (or add one matching the sheet's
      conventions); never inline styles.
    The copy is deliberately cause-agnostic: `body: ''` has TWO producers
    (the pre-existing `UncomposableReminderError` catch on an unusable
    scheduledAt, and the new entry-fork withhold), and both leave Send now
    refusing (`invalid_schedule` / `names_unavailable`), so the sentence is
    true for both. Cause-specific wording would lie on one of them.
  - THE FIFTH CONSUMER - the no-show DRAFT handler (the head of a hand send,
    so it takes the SEND posture, not the preview one). In the handler Task 4
    rewrote, after resolving:

```ts
    const impact = assessNamesReadFailure({
      kind: 'no_show_checkin',
      tourType: tour.tourType,
      tenantReadFailed: resolved.tenantReadFailed,
      propertyReadFailed: resolved.propertyReadFailed,
      unitReadFailed: false, // the draft deliberately reads no unit
    });
    if (impact.blocksSend) {
      // A failure-masquerading "Hi there!" prefill would be hand-sent to a
      // real tenant - the exact wrong-but-valid message 6.3b forbids, on the
      // ONE path Phase A uses. Refuse with the same token as send-now; the
      // dashboard renders it through SEND_NOW_ERROR_COPY.
      res.status(409).json({ error: 'names_unavailable' });
      return;
    }
```

  - THE DASHBOARD HALF of that refusal: `TourDetail.tsx:341-346` currently
    renders `err.message` RAW on a draft failure, which the
    `SEND_NOW_ERROR_COPY` contract forbids for machine codes. TWO field
    rules govern the fix (both review-verified): read `err.code`, NEVER
    `err.message` - `client.ts:68-75` builds `message` as
    `code + ' (detail)'`, so the two diverge the moment any handler adds a
    detail, and the repo's canonical consumer says it in terms
    (`RemindersPanel.tsx:278-279`: "NEVER err.message - that is the raw
    machine code"). And do NOT shove every draft-LOAD failure through the
    send-shaped map: a 404 here is `tour_not_found` (not a map key - the
    map's tour key is `tour_missing`), and "Couldn't send that just now" is
    the wrong sentence for an operation that sent nothing. Route ONLY the
    refusal this handler can actually mean:

```ts
        // NEVER err.message - that is the raw machine code (RemindersPanel
        // precedent). Only the names_unavailable refusal is send-shaped;
        // every other failure here is a LOAD failure and keeps load copy.
        setActionError(
          err instanceof ApiError && err.code === 'names_unavailable'
            ? sendNowErrorMessage(err.code)
            : 'Could not load the check-in message',
        );
```

    (`sendNowErrorMessage` is exported from `../../api/index.js` alongside
    the `ApiError` import the file already has.)
  - CONTAIN `resolveTenantSuppression` (`routes/tourReminders.ts:566-589`) -
    the OTHER tenant read on the GET route, bare today, which 500s the whole
    ladder on a rejection and makes everything above unreachable for
    self_guided tours. THE SHAPE MATTERS - do NOT return an always-undefined
    evaluator (a round-3 review caught that regression before it shipped):
    the route's chip ternary (`:481-489`) reaches its no-IO
    `paused ? { reason: 'paused' } : undefined` fallback ONLY while
    `suppressionOf` is undefined, so a defined-but-empty evaluator would
    flip every self_guided chip from "Paused" to the amber "sends in Nh"
    promise during a contacts blip - the exact perpetual-"sending shortly"
    lie the 2026-08-20 pause chip exists to end (`RemindersPanel.tsx:110-116`
    says so in terms). Instead, contain at the CALL SITE (`:458`): wrap the
    `resolveTenantSuppression(...)` await in try/catch; on a throw, log ONE
    warn (ids only) and leave `suppressionOf` UNASSIGNED - the existing
    third branch then supplies `{ reason: 'paused' }` with zero IO, exactly
    as group-routed tours already behave. A tenant-read failure changes the
    BODY, never the pause state. This is what makes `composeInputsOf`'s
    "read paths must never 500 the ladder over a name" docblock TRUE rather
    than aspirational. KNOWN AND ACCEPTED: the GET route now reads the same
    tenant contact twice per request (`composeInputsOf` and this estimate).
    Deliberate - threading the contact through would mean
    `ResolvedTourNames` returning the raw `ContactItem` to every preview
    surface (PII-bearing objects none of them need) or a further interface
    revision, for one saved read; the doubling is per-REQUEST, not per-rung,
    so spec 10's batching rule ("do not read per rung") is honoured. Say so
    in the containment's code comment so nobody "optimizes" the two reads
    into one and couples the estimate's failure to the body's.
  - CONTAIN the force-send's TARGET RESOLUTION (`jobs/tourReminders.ts:1172`)
    - the second bare read on the same route pair, and the DOMINANT failure
    cell: a throwing tenant read on a self_guided tour currently escapes
    `resolveReminderTarget:647` through the unwrapped handler at
    `routes/tourReminders.ts:365` as a 500, where spec 6.3b demands "a
    REFUSAL the route can render, not silence". Same task, same shape, same
    ruling as the bullet above - a panel that degrades gracefully next to a
    Send-now button that 500s on the same outage would be indefensible.
    Wrap the call:

```ts
  let target: ReminderTarget;
  try {
    target = await resolveReminderTarget(row, deps, log);
  } catch (err) {
    log.warn(
      { err, reminderId, tourId, kind: row.kind },
      'tour reminder force-send: target resolution read failed - row left pending',
    );
    return { outcome: 'refused', reason: 'names_unavailable' };
  }
```

    (Inline the return - the `refuse` helper is declared BELOW this point at
    `:1183`.) THE BLANKET STAYS A BLANKET, deliberately: narrowing the catch
    to the `:647` tenant read alone would re-open the 500 escape chain for
    the OTHER three reads inside target resolution (`:625` tour, `:642`
    group conversation, `:665` conversation lookup), trading one wrong
    behaviour for another. What must not lie is the COPY, so the shared
    `names_unavailable` copy is cause-agnostic ("Could not look up
    everything this message needs...") - true for all four reads AND for the
    compose gate. Note the behavioural boundary this creates and the rule
    header states: a target-resolution failure refuses EVERY kind, including
    `confirmation` (the failed read is the recipient lookup); the
    per-copy scoping applies at the COMPOSE gate only. g3 still holds - its
    unit/property-read fixtures fail AFTER target resolution succeeds. The
    POLL side of the same read is deliberately NOT touched: its throw
    already lands in the per-row catch (`:490-497`) and leaves the rung
    unclaimed - the right net outcome under a generic log line, pre-existing
    and benign. (Also recorded by review, so nobody re-derives it as a gap:
    the row lookups - `forceSendReminder`'s own `listByTour:1165` and the
    route's `:359`/`:374` - stay bare; a reminders-table outage still 500s.
    Consistent: those are row lookups, and 6.3b's obligation is scoped to
    resolving the send.)
- [ ] **Step 4: Run and watch them pass**, then the full app suite and the
  dashboard suite:
  `cd app && npx vitest run` - green, no skips on the DynamoDB suites;
  `cd dashboard && npx vitest run src/routes/tours/TourDetail.test.tsx src/routes/tours/RemindersPanel.test.tsx` -
  green. Task 4 Step 13's case 2 pin (absence fallbacks on a throwing
  landlord read) must still be green - it is pinned to a `self_guided`
  fixture precisely so this task's withhold rule does not touch it, and
  under the narrowed rule its self_guided bodies degrade rather than blank
  even on a tenant-read failure.
- [ ] **Step 5: Commit.**

```bash
git add app/src/jobs/tourReminders.ts app/src/routes/tourReminders.ts app/src/routes/contactTimeline.ts app/src/routes/relayGroups.ts dashboard/src/api/types.ts dashboard/src/routes/tours/TourDetail.tsx dashboard/src/routes/tours/TourDetail.test.tsx dashboard/src/routes/tours/RemindersPanel.tsx dashboard/src/routes/tours/RemindersPanel.test.tsx dashboard/src/routes/contact/ScheduledCard.tsx app/test/tourReminders.test.ts app/test/tourRemindersApi.test.ts app/test/relayApi.test.ts app/test/contactTimeline.test.ts
git commit -m "feat(tours): scoped name-read failure - sends refuse, entry-forks withhold, panel degrades"
```

---

### Task 6: Retime the ladder - `computeDueAt`

**Files:**
- Modify: `app/src/jobs/tourReminders.ts:89-118` (export + retime)
- Modify: `app/test/seedLive.test.ts:53-78` (the DELIBERATE twin - lockstep)
- Create: `app/test/computeDueAt.test.ts`
- Modify (re-derive): `app/test/tourReminders.test.ts`,
  `app/test/toursApi.test.ts`, `app/test/devGating.test.ts`

**Interfaces:**
- Consumes: `shiftLocalDate` (Task 1).
- Produces: `computeDueAt` becomes EXPORTED (it is module-private today and no
  test calls it directly). It still returns a RAW, UNCLAMPED instant - the
  clamp lives in the caller (`:250`). Do not add clamping here. Task 7
  consumes the raw values.

New table (spec section 7):

| Kind | Raw due at | Change |
| --- | --- | --- |
| `confirmation` | `now` | UNCHANGED (still armed - spec 2) |
| `day_before` | 19:30 org-local on the day BEFORE the tour's local date | was `scheduledAt - 24h` |
| `morning_of` | `scheduledAt - 4h` | was 08:00 org-local on the tour's local date |
| `en_route` | `scheduledAt - 1h` | unchanged |
| `no_show_checkin` | `scheduledAt + 30m` | unchanged (manual only) |

- [ ] **Step 1: Create `app/test/computeDueAt.test.ts`** (pure - no Docker, no
  skipIf):

```ts
import { describe, expect, it } from 'vitest';
import { computeDueAt } from '../src/jobs/tourReminders.js';
import { quietHoursWindowOf } from '../src/lib/quietHours.js';

const WINDOW = quietHoursWindowOf({
  quietHoursEnabled: true, quietHoursStart: '21:00', quietHoursEnd: '08:00',
  timezone: 'America/New_York',
});
const NOW = '2026-07-01T12:00:00.000Z'; // far before every fixture tour

describe('computeDueAt (raw - the caller clamps)', () => {
  const TOUR = '2026-07-23T19:00:00.000Z'; // Thu Jul 23, 15:00 EDT

  it('confirmation is the arm instant, unchanged in Phase A', () => {
    expect(computeDueAt('confirmation', TOUR, NOW, WINDOW)).toBe(NOW);
  });
  it('day_before is 19:30 ORG-LOCAL the evening before the tour LOCAL date', () => {
    expect(computeDueAt('day_before', TOUR, NOW, WINDOW)).toBe('2026-07-22T23:30:00.000Z');
  });
  it('day_before in winter (EST) crosses the UTC midnight correctly', () => {
    // Tour Jan 20 15:00 EST; 19:30 EST Jan 19 = 00:30Z Jan 20.
    expect(computeDueAt('day_before', '2026-01-20T20:00:00.000Z', NOW, WINDOW))
      .toBe('2026-01-20T00:30:00.000Z');
  });
  it('the 19:30 anchor holds across the spring-forward transition (offset flips, wall time does not)', () => {
    // America/New_York springs forward 2026-03-08. A tour on Mar 9 anchors
    // day_before at 19:30 EDT (UTC-4) ON the transition day; a tour on Mar 6
    // anchors at 19:30 EST (UTC-5). A naive fixed-offset derivation gets one
    // of these wrong by an hour.
    expect(computeDueAt('day_before', '2026-03-09T16:00:00.000Z', NOW, WINDOW))
      .toBe('2026-03-08T23:30:00.000Z'); // 19:30 EDT Mar 8
    expect(computeDueAt('day_before', '2026-03-06T16:00:00.000Z', NOW, WINDOW))
      .toBe('2026-03-06T00:30:00.000Z'); // 19:30 EST Mar 5
  });
  it('morning_of is four hours before the tour', () => {
    expect(computeDueAt('morning_of', TOUR, NOW, WINDOW)).toBe('2026-07-23T15:00:00.000Z');
  });
  it('en_route is one hour before (unchanged)', () => {
    expect(computeDueAt('en_route', TOUR, NOW, WINDOW)).toBe('2026-07-23T18:00:00.000Z');
  });
  it('no_show_checkin is thirty minutes after (unchanged)', () => {
    expect(computeDueAt('no_show_checkin', TOUR, NOW, WINDOW)).toBe('2026-07-23T19:30:00.000Z');
  });
});
```

- [ ] **Step 2: Run and watch it fail.**
  `cd app && npx vitest run test/computeDueAt.test.ts`
  Expected: FAIL - `computeDueAt` is not exported.
- [ ] **Step 3: Implement.** Export the function and replace the two cases:

```ts
    case 'day_before':
      // 19:30 ORG-LOCAL the evening before the tour's LOCAL date (founder
      // retiming, Cameron 2026-08-26; was scheduledAt - 24h). Calendar-day
      // step via shiftLocalDate, local-time anchor via instantAtLocalTime -
      // the same mechanism the old 08:00 morning_of rung used. "7:30pm EST"
      // means 7:30pm local to the property; we hold one org-level zone
      // (spec 7).
      return instantAtLocalTime(
        shiftLocalDate(localDateOf(scheduledAt, window.timezone), -1),
        '19:30',
        window.timezone,
      );
    case 'morning_of':
      // FOUR hours before the tour (founder retiming, Cameron 2026-08-26;
      // was 08:00 org-local). The persisted KIND keeps its name - renaming
      // would orphan in-flight rows (spec 9); the staff-facing LABEL is
      // relabelled instead (dashboard REMINDER_KIND_LABELS).
      return new Date(scheduled - 4 * 60 * 60 * 1000).toISOString();
```

  Import `shiftLocalDate` from `../lib/localTime.js`.
- [ ] **Step 4: Update ONLY the `computeDueAt` TWIN in
  `app/test/seedLive.test.ts:53-78`** - it is a DELIBERATE drift guard and
  moves in lockstep (spec 10). Mirror the two cases exactly (the twin already
  imports `instantAtLocalTime`/`localDateOf`; add `shiftLocalDate` from
  `../src/lib/localTime.js`). Touch NOTHING else in that file: its local
  `REMINDER_KINDS` copy (`:84`) keeps `confirmation` (correct - Phase A never
  stops arming it), and its TOUR-A/TOUR-B assertions are expected to stay
  green after this task (verified derivation: TOUR-A's day_before raw is now
  Jul 14 23:30Z, still past `FIXED_NOW`, still silently dropped until Task 7;
  its morning_of raw 10:00Z clamps to the same 12:00Z the old 08:00-local rung
  had; TOUR-B's day_before moves to Jul 15 23:30Z, which the parity test
  tracks through the twin). If a TOUR assertion fails here, your
  `computeDueAt` is wrong - do not edit the assertion.
- [ ] **Step 5: Re-derive the timing pins the retime moved.** Formulas:
  `day_before = 19:30 org-local on (tour local date - 1)`;
  `morning_of = scheduledAt - 4h`; clamp per the test's stubbed window
  (`quietOff` = identity; `stubSettingsRepo()` = default 21:00-08:00 NY).
  Verified new values for the named anchors - re-check each against its
  fixture before pasting:
  - `app/test/tourReminders.test.ts` Test 1 (`:174-228`), tour Jan 20 20:00Z:
    `day_before` -> `'2026-01-20T00:30:00.000Z'`; `morning_of` ->
    `'2026-01-20T16:00:00.000Z'` (11:00 EST, unclamped). Rewrite the comments.
  - Test 1c (`:275-324`), tour Jan 21 03:00Z (a 10pm tour): its PREMISE is
    gone - `day_before` raw is now Jan 20 00:30Z (19:30 EST Jan 19), OUTSIDE
    the default window, so it never clamps onto the morning_of slot. New
    expected state: `day_before` ARMED at `'2026-01-20T00:30:00.000Z'`;
    `morning_of` ARMED at `'2026-01-20T23:00:00.000Z'` (sched Jan 20 22:00
    EST minus 4h = 18:00 EST, outside the window); `en_route` unchanged
    (21:00 EST, clamps to Jan 21 08:00 EST = past the tour ->
    `past_event`, exactly as today).
    ROW COUNTS, explicitly (do not let a builder "fix" them backwards):
    `:322`'s `toHaveLength(4)` survives; `:323`'s unskipped filter becomes
    `toHaveLength(3)` (confirmation, day_before, morning_of - only en_route
    is retired). RETITLE the test (it no longer shows day_before
    supersession) and note that the day_before-clamp scenario now requires
    `quietHoursStart <= 19:30` - which Task 7's warn test pins.
  - Test 1d (`:329-361`): `day_before` raw is now Jan 20 00:30Z, in the
    FUTURE of `now` (Jan 19 15:00Z) - the old "already past, silently
    dropped" assertion at `:359` INVERTS: expect an ARMED day_before at
    `'2026-01-20T00:30:00.000Z'`. `morning_of` raw = Jan 20 09:30Z (04:30
    EST, in-window) clamps to 13:00Z = the en_route slot -> still superseded
    (same outcome, new derivation - fix the comment). `en_route` unchanged.
    Counts: 4 rows, 3 unskipped (confirmation, day_before, en_route) -
    re-derive any length/filter assertion in the test to those values.
  - Test 1f (`:394-432`): `day_before` -> armed at
    `'2026-01-20T00:30:00.000Z'` (was 13:00Z); `morning_of` raw Jan 20 08:30Z
    (03:30 EST) clamps to 13:00Z, at/past the 07:30 EST start -> `past_event`
    (unchanged outcome); update `:427` and the comments - INCLUDING the
    preamble at `:396-398`, which cites Test 1g as the place the
    past-dueAt-vs-supersession interaction "is pinned instead": after this
    task that citation is stale (see the 1g entry below); re-point it at the
    Task 7 replacement test (the en_route silent-drop case) by NAME, not
    line number.
  - Test 1g (`:437-463`): `day_before` raw Jan 20 00:30Z > now -> ARMS (the
    `:459` `toBeUndefined` inverts; the `:462` pending array becomes
    `['confirmation', 'day_before']` - creation order, no sort). The test's
    TITLE ("a rung whose clamped dueAt is still in the past is skipped
    (past-dueAt rule)") is now FALSE of what it shows - its other two rungs
    are `past_event`, a DIFFERENT branch - so RETITLE it to what it now
    demonstrates (the retimed day_before arms where it once fell past-due)
    and add a comment: the silent past-dueAt drop itself loses its last
    day_before-based coverage here; its replacement pin is Task 7's case 9
    (an `en_route` booked inside its own lead time), because day_before and
    morning_of can no longer reach the branch un-intercepted once the
    booked-too-late rules land. Do NOT leave the branch trusting a comment -
    Task 7 owns the replacement test.
  - Test 5 (`:1191-1237`): interim state for THIS task only - `morning_of`
    dueAt becomes `'2026-07-13T10:00:00.000Z'` (quietOff; sched-4h), still
    armed; day_before still absent (raw Jul 12 23:30Z < now). Task 7 flips
    both to visible `booked_too_late` rows - note that in a plain comment on
    the test (not a `TODO(...)` marker; those need registry slugs here).
  - `app/test/toursApi.test.ts:1411-1414` (sched Jul 15 18:00Z):
    `day_before` -> `'2026-07-14T23:30:00.000Z'`; `morning_of` ->
    `'2026-07-15T14:00:00.000Z'`. `:1449-1450` (sched Jul 20 18:00Z):
    `day_before` -> `'2026-07-19T23:30:00.000Z'`. `:1593-1594`: same values
    as `:1411`. `:2727-2731`: re-derive from its own fixture with the
    formulas (its comment about a 06:00-EDT in-window raw is now false -
    19:30 local is outside the default window; check the surrounding skip
    assertions against the NEW raws and the clamp).
  - `app/test/devGating.test.ts` (`FIXED_NOW`/`SCHEDULED_AT` at `:451-452`):
    grep the file for tick instants derived from `SCHEDULED_AT` minus 24h and
    re-derive them from the new day_before formula (19:30 EDT Jul 14 =
    `'2026-07-14T23:30:00.000Z'` for the Jul 15 18:00Z tour). The BODY
    constants self-heal (they compose through the composer).
- [ ] **Step 6: Run.** `cd app && npx vitest run` - green; confirm
  `seedLive.test.ts` and `tourReminders.test.ts` did NOT skip (Docker up).
- [ ] **Step 7: Commit.**

```bash
git add app/src/jobs/tourReminders.ts app/test/computeDueAt.test.ts app/test/seedLive.test.ts app/test/tourReminders.test.ts app/test/toursApi.test.ts app/test/devGating.test.ts
git commit -m "feat(tours): retime day_before to 19:30 org-local and morning_of to T-4h"
```

NOTE: from here until Task 9, the e2e suite is expected RED (its ticks still
compute `times.dayBefore` host-locally as sched-24h, which no longer matches
any armed row). Do not run the e2e gate in between; Task 9 owns the repair.

---

### Task 7: The booked-too-late skip rules and the quiet-window warn

**Files:**
- Modify: `app/src/jobs/tourReminders.ts` (arm pass 1 `:248-251`, pass 2
  `:262-314`)
- Test: `app/test/tourReminders.test.ts`, `app/test/toursApi.test.ts`,
  `app/test/seedLive.test.ts` (re-derive), `app/test/tourRemindersApi.test.ts`
  (re-derive if counts move)

**Interfaces:**
- Consumes: `'booked_too_late'` (Task 3), raw `computeDueAt` values (Task 6).
- Produces: two arm-time rules writing VISIBLE skipped rows; a WARN when
  19:30 sits inside the org quiet window.

THE RULES (spec section 8), all comparisons against RAW offsets, BEFORE
clamping; boundaries strictly `>`; `now` is the ARM instant (booking,
reschedule, or status revival - `armTourReminders` is called from
`routes/tours.ts:350` and `:1178`):
1. `day_before` is skipped when `now > rawDueAt - 4h`.
2. `morning_of` is skipped when `sameDay && now > scheduledAt - 6h`, where
   `sameDay` compares `localDateOf` of tour and `now` in the window's zone
   (already `resolveQuietHoursTimezone`-resolved by `readQuietHoursWindow`).

CRITICAL - two traps the reviews caught:
- Pass 1 currently stores ONLY clamped values and discards the raw ones.
  Build a second map. Comparing against `dues` passes most tests by luck and
  is wrong for any tour whose day_before clamps.
- BOTH rules run BEFORE the past-dueAt branch at `:266` (which writes NO
  row): for a same-day tour day_before's raw is already past, and for a
  sub-4h booking morning_of's raw is already past - the MOST-late booking is
  exactly the one that would otherwise vanish silently (spec 8.1).
  Precedence per rung: (1) booked-too-late, (2) past-dueAt, (3) past-event,
  (4) supersession / staleDayBefore. Leave the past-dueAt branch itself
  untouched for every other rung. Accepted mis-attribution (spec 8.1): a
  rung that is both booked-too-late and clamped past the tour reports
  `booked_too_late`; do not "fix" it by reordering.
- COVERAGE DEBT this change creates and case 9 repays: every pre-change
  assertion of the silent past-dueAt drop rides `day_before`, and every one
  of them inverts (Tests 1d/1g in Task 6, Test 5 and seedLive TOUR-A in this
  task's Step 4). After the rules land, `day_before` and `morning_of` can no
  longer reach that branch un-intercepted - but the branch is NOT dead:
  `en_route` (no rule guards it) and clamped rungs still hit it. Case 9 is
  the branch's replacement pin; skipping it leaves a live production branch
  with zero coverage.

- [ ] **Step 1: Write the failing tests** (in `tourReminders.test.ts`, using
  the file's existing arm-test shape: `tours.create` + `armTourReminders` +
  `byKind`; settings per case). Concrete instants, all verified:

```ts
// Tour Thu Jul 23 2026, 15:00 EDT. day_before raw = Jul 22 19:30 EDT = 23:30Z.
// Rule 1 cutoff = raw - 4h = Jul 22 19:30Z (15:30 EDT).
const TOUR = '2026-07-23T19:00:00.000Z';
```

  1. Rule 1, just past the cutoff (`now = '2026-07-22T19:30:00.001Z'`,
     quietOff): `day_before` row EXISTS with
     `skipReason: 'booked_too_late'`, `skippedAt === now`, and
     `dueAt === '2026-07-22T23:30:00.000Z'` (the CLAMPED value - identity
     under quietOff; spec 8.2 stores clamped, exactly like the neighbouring
     skip branches). `morning_of` (15:00Z) and `en_route` (18:00Z) armed.
  2. Rule 1, exactly ON the cutoff (`now = '2026-07-22T19:30:00.000Z'`):
     `day_before` ARMS - strict `>`.
  3. Rule 1 beats past-dueAt (the ordering discriminator - without this
     fixture both placements of the branch pass identically): a SAME-DAY
     booking, `now = '2026-07-23T14:00:00.000Z'` (10:00 EDT tour day):
     day_before raw (Jul 22 23:30Z) is already PAST, and the row still
     EXISTS, visibly `booked_too_late` - the old code wrote nothing.
     (`morning_of` here: sameDay and 14:00Z > 13:00Z -> ALSO a visible
     `booked_too_late` row; assert both.)
  4. Rule 2 beats past-dueAt: `now = '2026-07-23T16:00:00.000Z'` (booked 3h
     out): morning_of raw (15:00Z) is already past; the row still EXISTS,
     `booked_too_late`. `en_route` (18:00Z) arms.
  5. Rule 2, exactly ON the cutoff (`now = '2026-07-23T13:00:00.000Z'`):
     `morning_of` ARMS - strict `>`.
  6. Rule 2 is SAME-DAY only (the midnight-crossing guard): tour
     `'2026-07-24T05:00:00.000Z'` (Jul 24 01:00 EDT, local date Jul 24),
     `now = '2026-07-24T01:00:00.000Z'` (Jul 23 21:00 EDT, local date Jul
     23): the 4h gap is inside the 6h lead but the local dates differ ->
     `morning_of` ARMS (quietOff so nothing clamps).
  7. RESCHEDULE re-evaluates (spec 8/11): book TOUR far out
     (`now = '2026-07-20T12:00:00.000Z'`, everything arms), then re-arm via
     the real path - in `toursApi.test.ts`, model on the existing reschedule
     coverage around `:1449`: PATCH `scheduledAt` to a time ~2h after a
     mocked `now` and assert the FRESH ladder carries visible
     `booked_too_late` rows for day_before AND morning_of. Also cover the
     REVIVAL wording of spec 11: a status move `canceled -> scheduled` onto
     the stored (near) time stamps the same chips - assert on whichever
     revival fixture the file already has, or add one with its idioms.
  8. The 7.1 WARN + retirement (`stubSettingsRepo({ quietHoursStart: '19:00' })`,
     default end 08:00, tour TOUR, `now = '2026-07-20T12:00:00.000Z'`):
     day_before raw 23:30Z is inside the window -> clamps to Jul 23 12:00Z
     (08:00 EDT, the tour's local date) -> retired
     `quiet_hours_superseded` by the existing staleDayBefore rule; AND
     `logCapture` contains the new warn naming the rung. The NEGATIVE half
     must use `stubSettingsRepo({ quietHoursEnabled: false, quietHoursStart: '19:00' })` -
     the SAME 19:00 start with the feature off - and assert no warn.
     `quietOffSettingsRepo()` is the WRONG fixture here: it keeps the default
     21:00 start, and 19:30 is outside [21:00, 08:00) regardless of the
     `enabled` flag, so with it the assertion passes whether or not
     `isQuietTime`'s enabled gate exists - a vacuous proof. Only a
     disabled-but-19:00 window separates "gated on enabled" from "outside the
     window anyway".
  9. THE PAST-DUEAT REPLACEMENT PIN (the silent drop's only coverage after
     this change - see the COVERAGE DEBT note above): quietOff,
     `now = '2026-07-23T18:30:00.000Z'` (14:30 EDT, booked 30 minutes before
     the 15:00 EDT tour). Assert the full arm outcome:
     - `en_route` (raw 18:00Z < now, no rule guards it): NO ROW AT ALL -
       `rows.map((r) => r.kind)` does not contain `'en_route'`, and
       `logCapture` contains the existing
       `'tour reminder skipped (dueAt in the past)'` line for it;
     - `day_before` and `morning_of`: VISIBLE `booked_too_late` rows (rule 1:
       now > Jul 22 19:30Z; rule 2: sameDay and now > 13:00Z);
     - `confirmation`: armed at `now` (18:30 < 19:00 start, so not
       past-event).
     Three rows total. Pre-implementation this case is RED on the
     booked_too_late halves and GREEN on the en_route half - both by
     design: the en_route assertions are the surviving pin of unchanged
     behaviour.
- [ ] **Step 2: Run and watch them fail** (cases 1, 3, 4, 7, 8 red; case 9
  red on its booked_too_late halves; 2, 5, 6 assert unchanged arming and may
  be green - keep them, they pin the boundaries the implementation could get
  wrong, and case 9's en_route half is deliberately the surviving pin of the
  silent past-dueAt drop).
- [ ] **Step 3: Implement** in `armTourReminders`:
  - Pass 1 keeps BOTH values:

```ts
  const raws = new Map<ReminderKind, string>();
  const dues = new Map<ReminderKind, string>();
  for (const kind of REMINDER_KINDS) {
    const raw = computeDueAt(kind, scheduledAt, now, window);
    raws.set(kind, raw);
    dues.set(kind, clampOutOfQuietHours(raw, window));
  }
```

  - The warn, after pass 1:

```ts
  // Spec 7.1: an org whose quiet window contains 19:30 makes every
  // day_before clamp onto the tour morning, where staleDayBefore retires it
  // 100% of the time as "superseded". Never fail and never validate the
  // setting - just name the cause so the panel's permanent chips are
  // explainable. isQuietTime gates on window.enabled, so a disabled window
  // never warns.
  const rawDayBefore = raws.get('day_before');
  if (rawDayBefore !== undefined && isQuietTime(rawDayBefore, window)) {
    log.warn(
      { tourId: tour.tourId, rawDayBefore, quietHoursStart: window.start, quietHoursEnd: window.end },
      'tour reminders: the 19:30 day_before anchor is inside the org quiet window - every day_before will clamp to the tour morning and be retired as superseded',
    );
  }
```

  - In pass 2, IMMEDIATELY BEFORE the `if (dueAt < now)` branch (`:266`):

```ts
    // BOOKED-TOO-LATE (spec section 8) - evaluated FIRST, ahead of the
    // silent past-dueAt drop below: the most-late booking is exactly the one
    // the founder needs explained, so both rules write a VISIBLE skipped row
    // (spec 8.1). RAW offsets, BEFORE clamping; strictly '>'; `now` is the
    // ARM instant, so a reschedule or revival re-evaluates both rules.
    // Precedence for these two rungs: booked-too-late > past-dueAt >
    // past-event > supersession/staleDayBefore. Known, accepted
    // mis-attribution: a rung that is also clamped past the tour reports
    // booked_too_late (spec 8.1 - do not reorder; that reopens the
    // vanishing-row problem).
    const rawAt = raws.get(kind);
    const bookedTooLate =
      rawAt !== undefined &&
      ((kind === 'day_before' &&
        now > new Date(new Date(rawAt).getTime() - 4 * 60 * 60 * 1000).toISOString()) ||
        (kind === 'morning_of' &&
          localDateOf(now, window.timezone) === tourLocalDate &&
          now > new Date(new Date(scheduledIso).getTime() - 6 * 60 * 60 * 1000).toISOString()));
    if (bookedTooLate) {
      const row = await deps.tourRemindersRepo.create({
        tourId: tour.tourId,
        kind,
        dueAt, // the CLAMPED value, like every arm-time skip row (spec 8.2)
        skipped: { at: now, reason: 'booked_too_late' },
      });
      created.push(row);
      log.info(
        { tourId: tour.tourId, kind, dueAt, reminderId: row.reminderId },
        'tour reminder retired at arm (booked too late for this rung) - visible skipped row',
      );
      continue;
    }
```

    (`tourLocalDate` is computed just above the loop at `:261` - move it
    above this branch if the declaration order requires. The supersession
    check below still consults the CLAMPED `dues` map for OTHER rungs and is
    deliberately untouched - see SPEC CONCERNS item 4 for the accepted
    cross-rung consequence.)
- [ ] **Step 4: Re-derive what the rules flip.** Verified derivations -
  re-check each before pasting:
  - `tourReminders.test.ts` Test 5 (`:1191-1237`, same-day pm_team tour,
    now Jul 13 09:00Z, sched 14:00Z): `day_before` now writes a VISIBLE
    `booked_too_late` row (dueAt Jul 12 23:30Z) - `:1213` inverts;
    `morning_of` (sameDay, 09:00Z > 08:00Z) becomes a visible
    `booked_too_late` row with dueAt `'2026-07-13T10:00:00.000Z'` - the
    "BOTH RUNGS NOW SURVIVE" block (`:1218-1229`) inverts; `en_route`
    (13:00Z) and `confirmation` still arm. Rewrite the comments to tell the
    new story.
  - `seedLive.test.ts` TOUR-A (`:180-208`): `day_before` now EXISTS as a
    `booked_too_late` row (raw Jul 14 23:30Z; rule-1 cutoff 19:30Z < seed
    now Jul 15 09:00Z) - `:207` inverts; `morning_of` (sameDay; 09:00Z >
    08:00Z) flips from armed to `booked_too_late` (dueAt stays the clamped
    12:00Z) - `:198-204` become `pending = ['en_route']` and a skipReason
    assertion; `confirmation` STAYS `quiet_hours_superseded` (the slot map
    still contains morning_of's clamped 12:00Z). TOUR-B (`:219-246`) is
    unaffected (booked a day-plus out; verified) - if it goes red, the
    implementation is wrong, not the test.
  - `tourRemindersApi.test.ts` / `relayApi.test.ts` / `contactTimeline.test.ts`:
    run the suite; any rung-COUNT or ordered-array change (`
    tourRemindersApi:237` style) re-derives from its own fixture with the
    two rules - and remember the counterintuitive direction: booked_too_late
    writes a VISIBLE row where past-dueAt wrote none, so near-term ladders
    get LONGER, not shorter (spec 13.2).
- [ ] **Step 5: Run.** `cd app && npx vitest run` - green, no skips.
- [ ] **Step 6: Commit.**

```bash
git add app/src/jobs/tourReminders.ts app/test/tourReminders.test.ts app/test/toursApi.test.ts app/test/seedLive.test.ts app/test/tourRemindersApi.test.ts
git commit -m "feat(tours): booked-too-late arm rules write visible rows; warn when 19:30 is quiet"
```

(Include `relayApi.test.ts` / `contactTimeline.test.ts` in the paths only if
Step 4 touched them.)

---

### Task 8: Relabel "Morning of" and the pinned accessible names

**Files:**
- Modify: `dashboard/src/api/types.ts:1242`,
  `dashboard/src/routes/tours/RemindersPanel.tsx:347,358`
- Modify: `dashboard/src/routes/tours/RemindersPanel.test.tsx`
- Modify: `e2e/scenarios/steps.ts:202-208` (`REMINDER_KIND_LABELS`),
  `e2e/tests/scenarios/quiet-hours.spec.ts:348`
- Modify: `e2e/support/selectors.md:72`

The label `morning_of: 'Morning of'` is now a staff-facing lie - for a 7pm
tour that rung fires at 3pm. DECIDED (spec 11): relabel to `4 hours before`.
The persisted KIND keeps its name. KNOCK-ON: the label is INTERPOLATED into
aria-labels (`RemindersPanel.tsx:347` -> "Send Morning of reminder now"), one
of which is a PINNED accessible-name contract (`e2e/support/selectors.md:72`).
"Send 4 hours before reminder now" does not read as English, so per the
spec's stated preference the SENTENCE changes: insert "the" -
`Send the <Kind label> reminder now` / `Cancel the <Kind label> reminder` -
uniformly for every kind, and move the pinned contract with it.

- [ ] **Step 1: Write the failing dashboard tests.** In
  `RemindersPanel.test.tsx`: change `:182-183` from `'Morning of'` to
  `'4 hours before'`; change every
  `'Send Day before reminder now'` (sites at `:261, :516, :540, :562, :571,
  :586, :603`) to `'Send the Day before reminder now'` (the `:261` regex and
  the `/reminder now$/` count at `:517` keep working); AND the second aria
  template's pins - `:418` (`'Cancel Day before reminder'`), `:424`
  (`'Restore Day before reminder'`), `:433` (`'Cancel Day before
  reminder'`) - become `'Cancel the Day before reminder'` /
  `'Restore the Day before reminder'`. Step 2 changes BOTH templates, so a
  Step 1 list that covers only the Send-now sites leaves Step 3 red. Run -
  `cd dashboard && npx vitest run src/routes/tours/RemindersPanel.test.tsx` -
  RED.
- [ ] **Step 2: Implement.**
  - `dashboard/src/api/types.ts:1242`: `morning_of: '4 hours before',` with a
    comment: `// Relabelled 2026-08-26: the rung fires at scheduledAt - 4h;`
    `// the persisted kind keeps its name (in-flight rows).`
  - `RemindersPanel.tsx:347`: `` aria-label={`Send the ${kindLabel} reminder now`} ``
  - `RemindersPanel.tsx:358`: `` aria-label={`${rung.state === 'upcoming' ? 'Cancel' : 'Restore'} the ${kindLabel} reminder`} ``
- [ ] **Step 3: Dashboard tests green**; `npm run typecheck` clean.
- [ ] **Step 4: Mirror the harness.**
  - `e2e/scenarios/steps.ts` `REMINDER_KIND_LABELS`:
    `morning_of: '4 hours before'` (it is a verbatim mirror - say so is why).
  - `e2e/tests/scenarios/quiet-hours.spec.ts:348`:
    `'Send the Day before reminder now'`.
  - `grep -rn "reminder now" e2e/ dashboard/src/` and update any further
    pinned name this list missed; also grep `"Cancel Day before"` /
    `"Restore"` for the second aria template.
- [ ] **Step 5: Update the pinned contract** `e2e/support/selectors.md:72`:
  the pattern becomes `Send the <Kind label> reminder now`, the example
  `Send the Day before reminder now`, and the kind-label list
  `Confirmation, Day before, 4 hours before, En route, No-show check-in`.
- [ ] **Step 6: Commit.**

```bash
git add dashboard/src/api/types.ts dashboard/src/routes/tours/RemindersPanel.tsx dashboard/src/routes/tours/RemindersPanel.test.tsx e2e/scenarios/steps.ts e2e/tests/scenarios/quiet-hours.spec.ts e2e/support/selectors.md
git commit -m "feat(dashboard): relabel morning_of to '4 hours before'; aria sentence carries it"
```

---

### Task 9: The e2e ladder mirror and the timing-contract rework

THIS IS THE HARDEST TASK IN THE PLAN. The 19:30 org-local rung cannot be
computed host-side, and `quiet-hours.spec.ts` carries an explicit
"deterministic at ANY wall clock" contract (its header, `:21-38`) built after
a documented time-of-day flake class. A solution that passes only between
certain hours is a regression against a contract someone paid for.

**Files:**
- Modify: `e2e/scenarios/steps.ts` (`TourTimes:211-218`, `tourSchedule:226-246`
  docblock, `timesFor:269-281`, new `armedReminderDueAt`)
- Modify: `e2e/tests/scenarios/scheduled-visibility.spec.ts:163,228`
- Modify: `e2e/tests/scenarios/tours.spec.ts:134`
- Modify: `e2e/tests/scenarios/quiet-hours.spec.ts` (window + bookings + ticks)
- Modify: `e2e/tests/tour-no-show-checkin.spec.ts`

**Interfaces:**
- Produces: `TourTimes` LOSES `dayBefore`, GAINS `morningOf` (the inversion,
  spec 13.1: `morning_of` is now a pure `-4h` offset and CAN be mirrored;
  `day_before` no longer can); `Scenario.armedReminderDueAt(kind)` reads the
  armed dueAt back from the API.

- [ ] **Step 1: Invert `TourTimes`.** Remove `dayBefore`, add
  `morningOf: string`; in `timesFor` compute
  `morningOf: new Date(t - 4 * 3_600_000).toISOString(),` (comment: mirrors
  `computeDueAt` - move both together). Rewrite the `tourSchedule` docblock's
  `morning_of` paragraph (`:236-241`) in the same voice, inverted:
  `day_before` is now the rung that is "removed rather than left as a wrong
  answer waiting to be used" (19:30 ORG-LOCAL, which a host-local helper
  cannot compute - read it back from the API instead, see
  `armedReminderDueAt`), while `morningOf` returns to the struct as a plain
  offset. Also re-check the `tourScheduleFullLadder` docblock arithmetic
  comment (`:248-261`): with the new ladder a 14:00-local booking two days
  out yields 19:30 D-1 < 10:00 D < 13:00 D < 14:00 start - update the
  inequality chain (spec 13.2 confirms this booking survives cleanly).
- [ ] **Step 2: Add the read-back helper** to `Scenario` (the
  `tour-roster.spec.ts:495-501` pattern, promoted):

```ts
  /** [App] The ARMED dueAt of one rung, read back from the reminders API.
   *  Since the 2026-08-26 retiming, day_before fires at 19:30 ORG-LOCAL the
   *  night before - a host-local mirror cannot compute it (the same reason
   *  morningOf once left TourTimes), so specs drive ticks from the value the
   *  server actually stored: correct by construction at any wall clock. */
  async armedReminderDueAt(kind: ReminderKind): Promise<string> {
    const tour = this.requireActiveTour();
    const res = await this.page.request.get(`${NEXT}/api/tours/${tour.tourId}/reminders`);
    expect(res.ok(), await res.text()).toBeTruthy();
    const body = (await res.json()) as {
      reminders: Array<{ kind: ReminderKind; dueAt: string; state: string }>;
    };
    const rung = body.reminders.find((r) => r.kind === kind && r.state === 'upcoming');
    if (rung === undefined) {
      throw new Error(`armedReminderDueAt: no upcoming '${kind}' rung on tour ${tour.tourId}`);
    }
    return rung.dueAt;
  }
```

- [ ] **Step 3: Repoint the two straightforward specs.**
  - `scheduled-visibility.spec.ts:163` and `:228`:
    `await flow.tickTourReminders(justAfter(await flow.armedReminderDueAt('day_before')));`
    (Safety, verified: these book via `tourScheduleFullLadder()` - at the
    day_before tick, morning_of (10:00 D) and en_route are not yet due, so
    release supersession cannot retire the asserted rung.)
  - `tours.spec.ts:134`: same replacement. (Books via `tourSchedule()`
    (48h); at `justAfter(19:30 D-1)` the earliest other rung is morning_of
    at `tod-4h` on D, which is at least 20:00 D-1 - 30 minutes clear at the
    worst wall clock. Safe at any hour; note it in a comment.)
  - HONESTY NOTE for both margin claims above: `timesFor` builds instants
    from HOST-local datetime strings while 19:30 is ORG-local, so the
    arithmetic assumes host zone == `ORG_TIMEZONE` (America/New_York). That
    assumption is PRE-EXISTING harness-wide (`scheduled-visibility.spec.ts`
    says so explicitly around `:124-126`), not something this change adds -
    but the 30-minute worst case is thin, so state the assumption in the
    comment rather than presenting the margin as unconditional.
- [ ] **Step 4: Rework `quiet-hours.spec.ts` - the timing contract.**
  TWO DIFFERENT ANCHORINGS, one per test, because the two tests prove
  different things:
  - Test (2) (defer + release) needs the RUNG's dueAt inside the stored
    window at tick time. The old contract got that from "day_before is ~24h
    out = the same local time of day as `windowAroundNow()`"; that property
    is gone, so test (2) anchors its window to the RUNG (19:30 org-local is
    now FIXED, so a fixed window contains it at any wall clock).
  - Test (3) (Send now, "even inside the quiet window") needs the WALL CLOCK
    inside the stored window - the panel's suppression estimate and the
    force-send's quiet-hours BYPASS are both wall-clock facts, and the test
    never ticks. It KEEPS `windowAroundNow()` UNCHANGED. Re-anchoring it to
    the rung would make the bypass proof vacuous at every wall clock outside
    17:30-21:30 org-local: with no window over the wall clock there is
    nothing for the force-send to bypass. Therefore `windowAroundNow()` and
    its `orgLocalHhMm` helper are NOT deleted.
  Concretely:
  - ADD (do not replace `windowAroundNow()`) a constant for test (2):

```ts
/** A REAL stored window that always contains the day_before anchor: the rung
 *  now fires 19:30 ORG-LOCAL, so [17:30, 21:30) org-local contains its dueAt
 *  at ANY wall clock - the window is anchored to the RUNG, not the clock
 *  (the retimed ladder's version of the old windowAroundNow trick). Wide
 *  enough that a DST shift cannot move 19:30 outside it; the release tick
 *  at dueAt + 5h (00:30 local) is comfortably outside. */
const QUIET_AROUND_DAY_BEFORE: QuietPatch = {
  quietHoursEnabled: true, quietHoursStart: '17:30', quietHoursEnd: '21:30',
};
```

  - `bookedSelfGuidedTour` (`:179-198`): book with
    `tourScheduleFullLadder(2)` instead of `tourSchedule()` (fixed 14:00
    local removes test (2)'s last wall-clock dependency and is harmless to
    test (3), which never ticks; the old comment steering quiet-hours flows
    toward `tourSchedule()` described the pre-retime contract - rewrite it).
  - Test (2) "Defer + release" (`:279-323`): after arming with quiet OFF,
    store `QUIET_AROUND_DAY_BEFORE`; read
    `const dueAt = await flow.armedReminderDueAt('day_before');` then defer
    tick at `justAfter(dueAt)` (org-locally 19:30:01 - inside the window at
    any wall clock) and release tick at
    `new Date(Date.parse(dueAt) + 5 * 3_600_000).toISOString()` (00:30
    org-local - outside the window, and still before morning_of at 10:00 on
    tour day, so nothing supersedes; keep the existing PAUSED_NOTE /
    QUIET_NOTE assertions - with the rung's dueAt deterministically inside
    the stored window, the paused-outranks-quiet negative assertion is now
    provable at any hour, which it previously was not).
  - Test (3) "Send now" (`:325+`): NO window change - it keeps
    `putQuietHours(request, windowAroundNow())` so the wall clock stays
    genuinely inside a stored window and the force-send has a real window to
    bypass. The only edits it takes are the booking helper above and the
    button name Task 8 already updated. Its PAUSED/QUIET chip assertions
    remain wall-clock-valid exactly as today (`paused` outranks
    `quiet_hours`, `routes/tourReminders.ts:481-489`).
  - REWRITE the file-header TIMING CONTRACT comment (`:21-38`) to describe
    BOTH anchorings and which test owns which: test (2)'s window is anchored
    to the RUNG's fixed 19:30 org-local dueAt (ticks driven from the
    read-back value), test (3)'s window stays anchored to the WALL CLOCK
    because a quiet-hours BYPASS is only provable while the clock is inside
    the window. The contract's PROMISE - deterministic at any wall clock -
    is unchanged for both; say so explicitly.
- [ ] **Step 5: Re-derive `tour-no-show-checkin.spec.ts`** (spec 13.2 - do
  not just re-baseline the string):
  - The comment at `:28-31` claimed the phrase IS the whole body; it is now
    the TAIL. Update it: the phrase remains rung-unique and appears in the
    named and "there" variants both, so it stays a valid absence marker.
  - `:64` comment: re-derive it to the ACTUAL post-change arm outcome for a
    scheduledAt PATCHed 26 hours into the past: `confirmation`'s dueAt is
    the ARM instant, which lands AT/AFTER the (past) tour start, so it is
    born a VISIBLE `past_event` row - NOT pending; `day_before` is a visible
    `booked_too_late` row; `morning_of` and `en_route` raws are long past
    and write no row (the tour's local date is not today's, so rule 2 never
    fires). NOTHING is pending, and the wall-clock tick fires NOTHING -
    which is also why Half 1's absence assertion holds. Do not write
    "confirmation still fires" anywhere in this spec; it does not.
  - Make half 2 the POSITIVE proof of the new draft behaviour: replace the
    `:97-99` regex `toHaveValue` with the exact prefill
    `` `Hi ${tenant.firstName}! Do you need to reschedule?` `` - the tenant
    name reaching the prefill is precisely what Task 4 built.
- [ ] **Step 6: Typecheck, then run the FULL e2e suite** from the worktree
  root, UNPIPED, no interactive e2e session running concurrently:

```bash
npm run typecheck
npm run e2e > .artifacts/e2e-task9.log 2>&1
echo "REAL EXIT: $?"
```

  Read the verdict from the log's summary AND the echoed exit code. Expected:
  green. If a tour spec fails, diagnose against THIS task's derivations
  before touching anything outside `e2e/` - and remember a green e2e proves
  the MACHINERY only: the dev tick injects an empty manual-only set that
  production does not have (spec section 2's harness trap).
- [ ] **Step 7: Commit.**

```bash
git add e2e/scenarios/steps.ts e2e/tests/scenarios/scheduled-visibility.spec.ts e2e/tests/scenarios/tours.spec.ts e2e/tests/scenarios/quiet-hours.spec.ts e2e/tests/tour-no-show-checkin.spec.ts
git commit -m "fix(e2e): drive day_before ticks from the armed dueAt; invert the TourTimes mirror"
```

---

### Task 10: Seeds, prose, and the issue registry

Non-test surfaces that STATE the ladder verbatim - each is a reader that
would otherwise disagree with the new rule (spec 13).

**Files:**
- Modify: `app/src/lib/seed/matrix.ts:958` (+ comments `:983-991`),
  `app/src/lib/seed/cast.ts:768-797`, `app/src/lib/seed/live.ts` (docblock)
- Modify: `documentation/tours-sequence-writeup.md:104-120`
- Modify: `docs/issues/tourcopy-messageid-cast-unguarded.md`,
  `docs/issues/founder-message-template-updates-owed.md`
- Create: `docs/issues/tour-reminder-zero-primary-e2e-gap.md`,
  `docs/issues/tour-reminder-ladder-phase-b.md`

- [ ] **Step 1: `seed/matrix.ts`.** Replace `:958` so the parity comment
  stays TRUE:

```ts
      // computeDueAt('day_before') parity (founder retiming 2026-08-26):
      // 19:30 ORG-LOCAL the evening before the tour's local date. Upcoming
      // matrix tours sit 3-5 days out, so this instant is always in the
      // future at seed time and listDue(now) can never return the pending
      // row - the live-fire invariant below survives the retime.
      const tz = DEFAULT_ORG_SETTINGS.timezone;
      const dayBeforeDueAt = instantAtLocalTime(
        shiftLocalDate(localDateOf(scheduledAt, tz), -1), '19:30', tz,
      );
```

  Add the imports (`instantAtLocalTime`, `localDateOf` from
  `../quietHours.js`; `shiftLocalDate` from `../localTime.js`;
  `DEFAULT_ORG_SETTINGS` from its settingsRepo home - adjust relative paths
  to matrix.ts's location and existing import style). `:930`'s `pm_team`
  generator needs NO change - it is the reason Task 4's pm_team coverage
  matters (every third demo tour; the lean e2e seed has none, so e2e is
  structurally blind to it - spec 9.0).
  THE CANCELED-ROW ORDERING TRAP (found in review; the pinned-NOW coherence
  test cannot see it): the `canceled` branch (`matrix.ts:995-999`) writes
  `canceledAt = scheduledMs - 6h` under a comment claiming "canceledAt sits
  between its dueAt and scheduledAt". Under the OLD `dueAt = sched - 24h`
  that held unconditionally; under the 19:30-anchor it FAILS for any past
  tour whose inherited local time-of-day is earlier than 01:30 - and matrix
  tours inherit the RESEED wall clock, while `seedMatrixCoherence.test.ts`
  pins `NOW` at 08:00 EDT and so can never catch it. Make the ordering hold
  by construction:

```ts
        // Canceled between the day_before due instant and the tour. The new
        // 19:30-anchored dueAt can land AFTER sched-6h for small local
        // times-of-day (the reseed clock leaks into past tours), so take the
        // later of the two candidates: the coherence invariant
        // createdAt <= dueAt <= canceledAt must hold at ANY reseed wall clock.
        const canceledAt = iso(Math.max(
          scheduledMs - 6 * HOUR_MS,
          Date.parse(dayBeforeDueAt) + HOUR_MS,
        ));
```

  Check `grep -n "dayBefore" app/test` for any matrix-pinning test and
  re-derive it, and run
  `cd app && npx vitest run test/seedMatrixCoherence.test.ts` after the edit.
- [ ] **Step 2: `seed/cast.ts:768-797`.** The historical SENT rows hardcode
  old-ladder instants. Update to new-ladder-plausible ones (tour
  `2026-05-10T18:00:00.000Z` = 14:00 EDT): `day_before` dueAt/sentAt
  `'2026-05-09T23:30:00.000Z'` (19:30 EDT May 9); `morning_of` dueAt/sentAt
  `'2026-05-10T14:00:00.000Z'` (T-4h). Update the `:768` comment.
  DECIDED (spec 13 asks for a decision, not a restated fact): seeds continue
  to write NO `sentBody`, so every seeded "already sent" row re-renders in
  the CURRENT copy - the demo shows months-old tours quoting today's
  wording. Accepted deliberately: the alternative, backfilling synthetic
  `sentBody` snapshots, would fabricate send history in a store whose whole
  point is that `sentBody` records what actually went out. Record this
  decision in a one-line comment beside the cast rows, and state it as a
  DECISION in the handback.
- [ ] **Step 3: `seed/live.ts`.** Fix the docblock lines found via
  `grep -n "5-rung\|ladder" app/src/lib/seed/live.ts` (`:7-9`, `:25`, `:366`,
  `:433`, `:478-530` region): the ladder description must name the new
  timings and say four auto-armed rungs plus the manual no-show check-in. The
  arming CODE uses the real `armTourReminders` and needs no change.
- [ ] **Step 4: `documentation/tours-sequence-writeup.md:108-120`.** Rewrite
  the table (it is stale twice over - `morning_of` still says 08:00 UTC and
  `en_route` says 2h):

```
| Rung | When it fires | Purpose |
|------|---------------|---------|
| `confirmation` | immediately, at booking | "Your tour is set." |
| `day_before` | 19:30 the evening before (org-local) | day-before check-in |
| `morning_of` | 4 hours before (staff label: "4 hours before") | same-day check-in, carries the address |
| `en_route` | 1h before | asks the tenant to text when on the way |
| `no_show_checkin` | 30m **after** the scheduled time (manual send) | check-in if they may have missed it |
```

  and extend the paragraph below it: rungs booked too late for their lead
  time are retired at arm time as visible "booked too late" rows; the ladder
  is currently PAUSED (manual-only, founder decision 2026-08-20) - rows arm
  and display, a human presses Send now.
- [ ] **Step 5: Issue registry.**
  - `tourcopy-messageid-cast-unguarded.md`: `status: resolved`,
    `resolved: 2026-08-26`, and append
    `**Resolution (2026-08-26).** The cast is gone: idFor() in
    messages/tourCopy.ts is an exhaustive switch over ReminderKind, and the
    exhaustive compose-matrix test in app/test/tourCopy.test.ts pins every
    kind x address x tourType x names combination composing without a throw.`
  - `founder-message-template-updates-owed.md`: stays `open` (relay items
    remain). Append a dated note under item 3: the tour-ladder half landed
    2026-08-26 on `feat/tour-reminder-ladder` - name resolution, retiming,
    skip rules, entry restructure; D2 (token-free no-show) REVERSED by Sam
    via Cameron 2026-08-26; the `no_show_checkin` name-token open question
    this file tracked is thereby closed. Do not touch items 1, 2, 4.
  - `docs/issues/tour-reminders-panel-e2e-flake.md:112`: its reproduction
    step quotes the panel label verbatim
    (`"App: Reminders panel shows 'Morning of' as upcoming"`). AGENTS.md
    treats this resolved issue as a live reopen trigger, so its repro
    instructions must not name a label that no longer exists after Task 8:
    update the quoted label to `'4 hours before'` with a bracketed note
    `[label renamed from 'Morning of', 2026-08-26]` so the historical
    signature stays recognizable. Body edit only - status stays resolved.
  - Create `docs/issues/tour-reminder-zero-primary-e2e-gap.md` from
    `_TEMPLATE.md` (type: debt, severity: low, area: e2e), covering BOTH
    e2e gaps on the property-contact name path: (a) the zero-primary
    fallback leg has unit coverage (`app/test/tourContacts.test.ts`,
    `app/test/tourReminders.test.ts`) but no e2e path - giving it one means
    changing the byte-stable lean seed, deferred by adjudication 2026-08-26;
    (b) the step helpers cannot compose an exact `en_route` LANDLORD-LED
    body (the harness records no property-contact name on the active tour -
    see the `requireTourReminderContext` docblock Task 4 writes), so that
    body's e2e-level pin is the unit/API-level tests
    (`app/test/relayApi.test.ts`, `app/test/tourRemindersApi.test.ts`) until
    someone threads the landlord name through the Scenario verbs.
  - Create `docs/issues/tour-reminder-ladder-phase-b.md` (type: improvement,
    severity: med, area: app/jobs): the unpause ledger, so spec obligations
    are findable when Phase B starts. Contents: (1) FIRST task - the
    one-time retirement sweep of stale pending rows, criterion THE TOUR IS
    PAST not the dueAt, never stamped `past_event`, needs its own reason
    token, proven on real dev data (spec 9.6); (2) empty
    `MANUAL_ONLY_REMINDER_KINDS` and, in the same change, remove
    `confirmation` from `REMINDER_KINDS` only, correcting the then-dead
    manual-only entry + comment (spec 9.5); (3) the harness needs a
    replacement immediate-send vehicle first (~40 unit sites + ~14 e2e sites
    ride confirmation's dueAt = now; a rung already due at arm time writes no
    row, so no armed rung can substitute - likely a dev seam that arms an
    arbitrary dueAt); (4) the quiet-hours exemption hook design in spec 7.3
    (both sites, arm-time clamp AND fire-time backstop), cut from Phase A;
    (5) the founder's open `en_route`-exemption question (spec 12.1);
    (6) in-flight rows armed under the OLD timings begin firing on unpause
    (spec 9.3); (7) THE UNBOUNDED NAMES-READ RE-LIST (Task 5): a rung whose
    name resolution keeps failing is left unclaimed with NO self-clearing
    bound - unlike its `roster_unavailable` twin, which the repo bounded
    precisely because a rung that re-lists forever "is never sent and never
    says so" (`tourRemindersRepo.ts:56-64`). Acceptable ONLY while the
    manual-only filter keeps the poll off those rows; before lifting the
    pause, either bound it (needs a new skip-reason ruling - 8.2 granted
    exactly one token) or re-accept it explicitly; (8) the cosmetic
    superseded-by-a-skipped-rung chip: `supersededBySlot` consults clamped
    dueAts without asking whether the later rung was itself retired, so a
    chip can read "superseded by a later reminder" pointing at a
    `booked_too_late` row (pre-existing behaviour - seedLive already pinned
    a confirmation superseded by a silently-dropped morning_of - but the
    visible skip rows make it easier to notice; a fix would require the
    later rung to be genuinely armable, which spec 8.1 put out of scope
    here); (9) the failure-scope derivation reads catalog DEFAULTS only
    (`reminderNamesUsed`, messages/tourCopy.ts - the matching
    `TODO(tour-reminder-ladder-phase-b)` marker sits on its docblock): safe
    while no tour.* override can exist (`settingsToOverrides` maps two
    non-tour ids and no tour compose site passes `overrides`), but
    `ComposeTourReminderInput.overrides` already exists on the signature, so
    the day a generic override map lands the derivation must widen to the
    EFFECTIVE template or an override could add a name token the failure
    semantics never learn about. Refs the spec by path.
- [ ] **Step 6: Regenerate the index.** `npm run issues` (never hand-edit
  `INDEX.md`).
- [ ] **Step 7: Verify.** `npm run typecheck`; `cd app && npx vitest run`
  (seed edits can move seed-adjacent tests - re-derive, never delete).
- [ ] **Step 8: Commit.**

```bash
git add app/src/lib/seed/matrix.ts app/src/lib/seed/cast.ts app/src/lib/seed/live.ts documentation/tours-sequence-writeup.md docs/issues/tourcopy-messageid-cast-unguarded.md docs/issues/founder-message-template-updates-owed.md docs/issues/tour-reminders-panel-e2e-flake.md docs/issues/tour-reminder-zero-primary-e2e-gap.md docs/issues/tour-reminder-ladder-phase-b.md
git commit -m "docs(tours): seeds, sequence writeup and issue registry follow the retimed ladder"
```

---

### Task 11: Main sync, the five gates, handback

- [ ] **Step 1: Sync `main` ONCE** (merge, preserving both sides' intent):
  `git fetch origin && git merge origin/main` (or local `main` if this repo
  has no remote flow - check `git remote -v` first). If the merge conflicts
  with active work on main, STOP and ask before resolving destructively.
- [ ] **Step 2: Gate 1.** `npm run typecheck` - bare, exit 0.
- [ ] **Step 3: Gate 2.** `npm test` - bare, Docker up. If red with timeouts
  and zero assertion failures, re-run under a clean access key
  (`AWS_ACCESS_KEY_ID=hccleanrun001`) and compare failing FILES per
  AGENTS.md before blaming the branch.
- [ ] **Step 4: Gate 3.** `npm run smoke` - bare.
- [ ] **Step 5: Gate 4.** `npm run e2e > .artifacts/e2e-gate.log 2>&1` then
  `echo "REAL EXIT: $?"` - NEVER piped; read both the exit code and the log
  summary. No concurrent interactive session in this worktree.
- [ ] **Step 6: Gate 5.** Lint the branch's OWN files:

```bash
npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')
```

  Note the two traps (AGENTS.md): `main...HEAD` is what lists the branch's
  files (a bare diff lists unstaged changes = nothing at gate time), and if
  the list is EMPTY, SKIP the gate (a bare `npx eslint` lints the repo and
  fails on ~117 pre-existing errors). Attribute any error by BASELINE
  COMPARISON (same command, same paths, at the merge base) - by baseline,
  not by line number; name pre-existing ones in the handback.
- [ ] **Step 7: Measure and report (NOT a gate).** Per spec 5 there is no
  segment budget any more; report the cost observation for the longest rung.
  Write a throwaway script in the SCRATCHPAD (not the repo), e.g.
  `measure-segments.mts`:

```ts
import { composeTourReminderBody } from '<worktree>/app/src/messages/tourCopy.js';
import { analyzeSms } from '<worktree>/app/src/lib/smsEncoding.js';
const body = composeTourReminderBody({
  kind: 'morning_of', scheduledAt: '2026-07-23T19:00:00.000Z',
  timezone: 'America/New_York', tourType: 'self_guided',
  names: { tenantFirstName: 'Alexandria' },
  address: '350 Boulevard SE, Atlanta, GA 30312',
});
console.log(body.length, analyzeSms(body).segments, JSON.stringify(body));
```

  run with `npx tsx <path>` from `app/`. Two segments is a cost note, not a
  failure - do NOT shorten the founder's copy over it.
- [ ] **Step 8: Write the handback.** It MUST name, plainly:
  - THE LADDER IS STILL PAUSED: `MANUAL_ONLY_REMINDER_KINDS` untouched;
    nothing sends automatically; `confirmation` still arms and its Send now
    button is live (accepted - spec section 2).
  - FORCE-SEND IS LIVE AND IS THE PATH THAT REACHES PEOPLE: every word of
    the new copy and every fallback (the "Hey there," greeting, the
    landlord-led -> self-guided degrade, the `names_unavailable` refusal)
    goes to a real tenant or landlord the moment the founder presses Send
    now.
  - THE HARNESS TRAP: the dev tick route passes an empty manual-only set, so
    a green e2e proves the machinery, NOT that anything sends in production
    (spec section 2 requires this stated).
  - `docs/issues/tourcopy-messageid-cast-unguarded.md` is CLOSED by the
    exhaustive matrix test (spec 9.1 asked for this to be said).
  - In-flight rows keep their OLD dueAts with NEW copy for one booking
    horizon (spec 9.3); and the DECISION from Task 10: seeds stay
    `sentBody`-less, so seeded "already sent" demo rows re-render in the
    current copy - chosen over fabricating synthetic send snapshots.
  - The failure posture, for the operator: when a read FAILS on a rung whose
    copy needs it, Send now and the no-show check-in draft answer "Could not
    look up everything this message needs" instead of sending or prefilling
    a wrong-but-valid text; the panel BLANKS a body only where the failure
    would flip the en_route wording between its self-guided and landlord-led
    entries - showing "Preview unavailable - this message cannot be composed
    right now." in its place - and otherwise previews the "Hey there," shape
    (so a preview can show a body the send is refusing - that split is the
    spec's own read/send posture, 6.3b). At the COMPOSE gate, rungs whose
    copy does not use the failed read (a day_before during a landlord-row
    outage, any confirmation) still preview and send normally - with the one
    boundary above it: when the TENANT or TOUR lookup itself fails, Send now
    refuses for EVERY kind, confirmation included, because there is no
    resolvable recipient, not because of a name. A read failure changes only
    BODIES and refusals, never the pause state: chips keep reading "Paused"
    (the estimate degrades to the no-IO paused fallback, never to a false
    "sends in Nh" promise).
  - The measured segment count for `morning_of` (Step 7).
  - The known cosmetic tail: an org with `quietHoursStart <= 19:30` retires
    every day_before as "superseded" with a WARN naming the cause (spec 7.1);
    reschedule/revival can stamp `booked too late for this reminder` on a
    tour nobody booked late - wording chosen not to accuse (spec 11).
  - Phase B's ledger lives in `docs/issues/tour-reminder-ladder-phase-b.md`.
- [ ] **Step 9: Commit anything the gates changed** (explicit paths), then
  stop. NEVER merge to `main` - that is the human's call.

---

## Spec coverage map (self-review)

| Spec section | Delivered by |
| --- | --- |
| 2 pause holds / confirmation stays armed | Global Constraints (no task touches the two sets); handback (Task 11) |
| 3 D2 reversal recorded | Task 4 (catalog comment), Task 10 (issue update) |
| 5 copy + segment-assertion deletion + ASCII kept | Task 4 |
| 6 token contract (declare all, editable stays true) | Task 4 (declaration test) |
| 6.1 resolver reuse + empty-string guard + live reads | Task 2 |
| 6.2 helper NOT in contactName.ts + TODO marker | Task 2 |
| 6.3 absence fallbacks ("there"; entry degrade) | Task 4 (composer tests, poll absence test) |
| 6.3a resolution in callers; group path in scope; hoists; per-unit memo; "never a different ENTRY" | Task 4 (all surfaces, relay-bucket name pin), Task 5 (preview withhold + keyed-memo pins) |
| 6.3b failure vs absence, scoped by what the copy needs; force-send reason token; draft refusal | Tasks 2 (flags), 4 (derived assessor), 5 (five consumers + the two bare-read containments) |
| 6.4 / 6.5 addressLine + clean-ending test | Task 4 |
| 7 retiming, D8 zone rule, DST test | Task 6 |
| 7.1 warn + retirement test | Task 7 |
| 7.2 early-tour retirement (accepted consequence) | unchanged behaviour; restated in writeup (Task 10) |
| 7.3 hook CUT from Phase A | no task builds it; ledger entry (Task 10) |
| 8 / 8.1 / 8.2 rules, precedence, visible rows, clamped dueAt | Tasks 3, 7 |
| 9 / 9.0 / 9.1 / 9.2 restructure, pm_team, matrix, no-show sites | Task 4 |
| 9.3 in-flight rows not re-armed | consequence; handback (Task 11) |
| 9.4 / 9.5 / 9.6 confirmation untouched; Phase B ledger | Global Constraints; Task 10 |
| 10 call sites + seedLive twin + batching | Tasks 4, 5, 6 |
| 11 relabel + aria knock-on + revival chip test | Tasks 7 (test 7), 8 |
| 12 open items do not block | Task 10 ledger |
| 13 / 13.1 / 13.2 test inventory, markers, TourTimes inversion, timing contract | Tasks 4, 6, 7, 9 |
| 14 gates, never piped | Task 11 |

Type-consistency check: `shiftLocalDate` (T1) -> T6, T10. `TourContactNames`
(T2, re-exported from `tourCopy.ts` in T4 for the harness/tests) /
`ResolvedTourNames{tenantReadFailed, propertyReadFailed}` /
`resolveTourContactNames` (T2) -> T4 (flags threaded through
`composeInputsOf` / `namesOnce` / the relay hoist), T5.
`reminderNamesUsed` / `assessNamesReadFailure{blocksSend, withholdPreview}`
(T4, catalog-derived - needs the new catalog, hence not T2) -> T5's five
consumers (composeBodyForRow, three preview copies, the draft handler).
`booked_too_late` (T3) -> T7.
`ComposeTourReminderInput.tourType`/`names` and
`composeBodyForRow(deps, ..., tenantContact?)` (T4) -> T5.
`ReminderNamesUnavailableError` / `names_unavailable` (T5) internal.
`computeDueAt` export (T6) -> T7 raw map. `armedReminderDueAt` (T9) internal.
Ordering: T3 before T7; T2 before T4; T1 before T6; T4 before T5/T6; T6
before T7; T8 before T9 (label mirror); Task 4 ends on a green e2e; e2e red
window T6..T9 stated.

## SPEC CONCERNS

Recorded per instruction; the plan implements the spec as written, taking the
stated reading wherever two sentences pull apart. None blocks the build.

1. **6.3a's parenthetical vs 6.3's own fallback - RESOLVED per-cell (revised
   again after the round-2 review, which correctly narrowed the round-1
   resolution).** 6.3b says READ paths "degrade to the absence fallbacks",
   6.3a closes with "(absence fallbacks, never a different ENTRY)", and
   6.3's property-contact ABSENCE fallback IS a different entry (the
   self-guided one). The two sentences collide in exactly ONE blocked cell -
   the en_route tour-type fork - so that is the only cell where previews
   render `body: ''` (`assessNamesReadFailure.withholdPreview`). In every
   other blocked cell the failure merely blanks a token, no entry flip
   threatens, and 6.3b's instruction stands unopposed: previews DEGRADE to
   the absence fallbacks ("Hey there,") while the send side waits or
   refuses. That preview/send disagreement is 6.3b's OWN split posture
   ("READ paths degrade ... SEND paths leave the rung UNCLAIMED"), not a
   defect - the round-1 revision overrode it on an agreement argument the
   spec never made, and the round-2 ruling reverses that. The `failed`
   carrier the memo holds is consumed on every path either way.
2. **6.3b's blanket sentences vs their own rationale - the plan scopes
   failure to what the copy needs (revised after the v2 reviews).** Two
   blanket phrases pull against the section's stated purpose ("must not
   silently degrade into a WRONG-but-valid message"): (a) "SEND paths leave
   the rung UNCLAIMED on a read failure" read literally would defer a
   `day_before` over a landlord-row outage - a message lost over a name its
   copy never renders - and reverse two documented invariants
   (`jobs/tourReminders.ts:525-526`, `:371-374`: a reminder is never lost
   over a missing street / a unit read never blocks a send); (b) the
   "roster_unavailable idiom" includes a grace-window escalation, but 8.2
   grants no reason token for it. The plan therefore defers/refuses ONLY
   where `assessNamesReadFailure.blocksSend` says the copy needed the failed
   read (per adjudicated findings A8/B2), derives that answer from the
   catalog templates so a "pure string edit" cannot silently desync it (per
   the round-2 ruling), keeps the unclaimed-with-no-bound shape for the rest
   of the idiom, and records the unbounded-re-list debt as Phase B ledger
   item (7) - bounded, in practice, by the pause it expires with. One more
   scope note the round-2 review forced into the open: 6.3b names "the three
   preview surfaces", but the compose-site count is FIVE - the no-show
   DRAFT (spec section 10 lists it separately) takes the SEND posture (409
   `names_unavailable`), because its output is hand-sent to a real person.
3. **6.3b's "or it degrades to a blank error".** `sendNowErrorMessage`
   (`dashboard/src/api/types.ts:1321-1323`) falls back to a generic retry
   sentence, not a blank - the copy-map entry is still added (Task 5), so
   this is a factual nit only.
4. **8.1 precedence is same-rung only; cross-rung supersession untouched -
   and the chip quirk is PRE-EXISTING (framing corrected after the v2
   reviews).** `supersededBySlot` already consults the clamped `dues` map
   for rungs the past-dueAt branch dropped silently, and `seedLive.test.ts`
   already pins a `confirmation` superseded by a morning_of that never
   armed - this change does not introduce the behaviour, it only makes it
   easier to NOTICE (the superseding rung can now be a visible
   `booked_too_late` row instead of an absent one). The spec forbids
   touching that machinery here; the cosmetic tail is recorded as Phase B
   ledger item (8) rather than in this appendix alone.
5. **Three Phase-B-era leftovers inside the spec's own text.** (a) Spec 13's
   suite list includes `tourReminders` "roughly FORTY structural sites keyed
   on confirmation" - with confirmation kept armed (section 2's own ruling)
   those sites do not break structurally in Phase A; the file still changes
   heavily, but for timing/rules reasons. (b) Spec 13's owed-coverage list
   includes "A pending `confirmation` row still composes after the rung
   stops arming" - nothing stops arming in Phase A. The
   composable-confirmation guarantee itself IS delivered (the Task 4
   exhaustive matrix covers both confirmation entries, named and anonymous,
   with and without an address); the "after the rung stops arming" clause
   belongs to Phase B and is carried in its ledger issue. (c) Spec 9.1's
   closing paragraph instructs "Remove `confirmation` from `REMINDER_KINDS`
   only" - the very edit section 2's ruling forbids in Phase A (9.4 confirms
   `REMINDER_KINDS` is not edited). A builder told to "read the spec fully
   before Task 1" will meet that sentence; this plan's Global Constraints
   override it, and the removal is Phase B ledger item (2). No action needed
   here beyond these notes.
