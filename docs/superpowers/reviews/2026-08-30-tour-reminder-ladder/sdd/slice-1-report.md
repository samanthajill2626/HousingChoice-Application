# Slice S1 report - Tasks 1, 2, 3

Worktree: `W:\tmp\tour-reminder-ladder`, branch `feat/tour-reminder-ladder`.
Base at slice start: `01550c91` (docs-only, clean). Three commits landed.
`.git/MERGE_HEAD` confirmed absent before every commit; bare `git status` read
before every commit; explicit paths only.

---

## Task 1 - `shiftLocalDate()`

**Wrote:**

- `app/src/lib/localTime.ts` - appended `shiftLocalDate(localDate, days)`
  verbatim from the plan (Step 3 block), below `formatLocalTime`.
- `app/test/localTime.test.ts` - appended the plan's `describe('shiftLocalDate')`
  block (5 tests). Per **worklist C12** the import was MERGED into the existing
  line 2 statement rather than added as a second statement:
  `import { formatLocalDate, formatLocalTime, shiftLocalDate, toAscii } from '../src/lib/localTime.js';`

**RED** (`cd app && npx vitest run test/localTime.test.ts -t shiftLocalDate`, exit 1):

```
 Test Files  1 failed (1)
      Tests  5 failed | 14 skipped (19)

 FAIL  test/localTime.test.ts > shiftLocalDate > steps back one day
TypeError: (0 , shiftLocalDate) is not a function

 FAIL  test/localTime.test.ts > shiftLocalDate > throws its OWN error on a malformed date, never a bare RangeError
AssertionError: expected [Function] to throw error matching /shiftLocalDate: unparseable/ but got '(0 , shiftLocal...'
- Expected: /shiftLocalDate: unparseable/
+ Received: "(0 , __vite_ssr_import_1__.shiftLocalDate) is not a function"
```

Right reason: the export did not exist. All five failed on the missing symbol,
not on a wrong expectation.

**GREEN** (`cd app && npx vitest run test/localTime.test.ts`, exit 0):

```
 ✓ test/localTime.test.ts (19 tests) 20ms
 Test Files  1 passed (1)
      Tests  19 passed (19)
```

**Commit:** `7a98bb3c9522f3cdf437c690242d3f45f083c469`
`feat(lib): shiftLocalDate for calendar-day arithmetic`

---

## Task 2 - `app/src/lib/tourContacts.ts`

**Wrote:**

- `app/test/tourContacts.test.ts` - the plan's full test file, byte-for-byte
  (8 resolver tests).
- `app/src/lib/tourContacts.ts` - the plan's full module, byte-for-byte.

Every DESIGN NOTE honoured and verified against the live tree before writing:

- Empty-string `landlordId` guard written INLINE
  (`typeof args.unit.landlordId === 'string' && args.unit.landlordId.length > 0`).
  `nonEmpty` in `rosterResolution.ts` was NOT exported or touched.
- The first-name / full-name helpers (`firstNameOf`, `fullNameOf`) live in this
  module. `app/src/lib/contactName.ts` was not opened or edited.
- `TODO(consolidate-contact-display-name-helpers):` marker present on the local
  helper comment block.
- Never throws: both reads are individually wrapped; a throw sets only its own
  flag and the partial names survive.
- PII: the two `log.warn` calls carry `{ err, tenantId }` and
  `{ err, unitId, propertyContactId }` - IDs only. Verified in the green run's
  captured pino output: no name or phone field appears.
- `firstName` / `lastName` reads are defensive (`typeof c['x'] === 'string'`);
  confirmed both ride `ContactItem`'s index signature at
  `app/src/repos/contactsRepo.ts:290`.
- Live-tree checks made before writing: `unitContacts` is exported from
  `app/src/repos/unitsRepo.ts:295` and already synthesizes the landlord primary
  at `:299-301`; `ContactsRepo.getById` is `:495`; `Logger` is re-exported from
  `app/src/lib/logger.ts:14` and `logger` at `:261`. All matched the plan.

**RED** (`cd app && npx vitest run test/tourContacts.test.ts`, exit 1):

```
 FAIL  test/tourContacts.test.ts [ test/tourContacts.test.ts ]
Error: Cannot find module '../src/lib/tourContacts.js' imported from
'W:/tmp/tour-reminder-ladder/app/test/tourContacts.test.ts'
 Test Files  1 failed (1)
      Tests  no tests
```

Right reason: the module did not exist yet (collection failure, as the plan
predicted).

**GREEN** (exit 0):

```
 ✓ test/tourContacts.test.ts (8 tests) 11ms
 Test Files  1 passed (1)
      Tests  8 passed (8)
```

**Commit:** `e500aa0cba37a90d5e66c85765e3fcffd7458ac7`
`feat(tours): resolve tenant + property-contact names for reminder copy`

---

## Task 3 - `booked_too_late` on both unions (+ worklist A10-11)

**Wrote:**

- `dashboard/src/routes/tours/RemindersPanel.test.tsx` - a new test
  `'a rung skipped as booked_too_late names the reason, not a bare "Skipped"'`,
  modelled on the existing claim-skipped test (now at `:134`), asserting
  `screen.getByText('Skipped - booked too late for this reminder')` and that a
  bare `'Skipped'` is absent.
- `dashboard/src/api/types.test.ts` - **worklist A10-11**: a new
  `describe('REMINDER_SKIP_REASON_LABELS')` with a `SKIP_REASONS` const of the
  TEN reasons as plain string literals, modelled on the file's `SERVER_CODES`
  idiom (`:9-24`) including the "listed here rather than imported" rationale
  comment. Three cases: every reason has a non-empty label; the map's key set is
  exactly those ten; no label contains a machine token (`_`).
- `app/src/repos/tourRemindersRepo.ts` - `| 'booked_too_late'` appended after
  `'invalid_schedule'` with the plan's docblock verbatim.
- `dashboard/src/api/types.ts` - `| 'booked_too_late'` appended to the
  `skipReason` union with a short comment, and
  `booked_too_late: 'booked too late for this reminder',` appended to
  `REMINDER_SKIP_REASON_LABELS`.

**RED** (`cd dashboard && npx vitest run src/routes/tours/RemindersPanel.test.tsx src/api/types.test.ts`, exit 1):

```
 Test Files  2 failed (2)
      Tests  3 failed | 40 passed (43)

 FAIL  src/api/types.test.ts > REMINDER_SKIP_REASON_LABELS > carries a staff-facing label for every reason the app can send
AssertionError: booked_too_late: expected undefined to be defined

 FAIL  src/api/types.test.ts > REMINDER_SKIP_REASON_LABELS > carries no label for a reason the app cannot send
AssertionError: expected [ 'contact_missing', ...(8) ] to deeply equal [ 'booked_too_late', ...(9) ]

 FAIL  src/routes/tours/RemindersPanel.test.tsx > RemindersPanel > a rung skipped as booked_too_late names the reason, not a bare "Skipped"
Unable to find an element with the text: Skipped - booked too late for this reminder.
```

Right reason on all three: the label map had no `booked_too_late` entry, so the
chip degraded to a reason-less "Skipped" - exactly the silent-degradation shape
spec 8.2 describes.

**GREEN** (exit 0):

```
 ✓ src/routes/tours/RemindersPanel.test.tsx (33 tests) 678ms
 Test Files  2 passed (2)
      Tests  43 passed (43)
```

**Typecheck gate** - `npm run typecheck` from the worktree root, **exit 0**
(app tsconfig.json + tsconfig.scripts.json + tsconfig.test.json, dashboard, e2e,
fake-twilio, fake-twilio-web all clean). This is the only verification the
app-side union addition has, as the plan states; no fake type-only "red" was
staged for it.

**Commit:** `e8e20c92eca23ce505e582bc83f791337f8fa6ce`
`feat(tours): booked_too_late skip reason on both unions with operator label`

---

## Deviations from the plan

1. **Task 1 import (worklist C12, mandated).** The plan's Step 1 block opens
   with a standalone `import { shiftLocalDate } ...` statement. Merged into the
   existing line-2 import instead, per C12, to avoid `no-duplicate-imports`.
   No other change to the plan's code.

2. **Task 3 / A10-11: `SKIP_REASONS` is a plain `string[]`, not typed against
   the wire union.** Deliberate, and it is the whole point of the guard. Typing
   the array as `NonNullable<TourReminderView['skipReason']>[]` would make
   "app added a reason, dashboard union never touched" a *typecheck error on the
   test file* rather than a *test failure naming the missing label* - i.e. it
   would invert the direction A10-11 asks for. Lookup therefore goes through a
   widened local alias:
   `const labels: Readonly<Record<string, string | undefined>> = REMINDER_SKIP_REASON_LABELS;`
   (accepted by tsc via the mapped type's implicit index signature; typecheck
   is green).

3. **A10-11 got three cases, not one.** The mandated one (every reason has a
   label) plus two cheap invariants in the file's own idiom: exact key-set
   equality (so DELETING a label, or adding a dashboard-only reason, is a
   failure - mirroring the `SERVER_CODES` comment's stated purpose), and the
   `never puts a machine token in front of staff` case copied from the
   `suggestionResolutionErrorMessage` describe above it.
   **Honest note on TDD:** of those three, two were genuinely red before the
   implementation and the machine-token one was **GREEN from the moment it was
   written** - it is a standing invariant over the existing nine labels, not a
   guard on this feature. Reported rather than dressed up as a red state.

4. **No other deviations.** Task 2's module and test file are the plan's text
   byte-for-byte.

## Constraints re-confirmed

- `app/src/jobs/tourReminders.ts` was **not opened for edit and not touched**.
  `MANUAL_ONLY_REMINDER_KINDS` and `REMINDER_KINDS` are untouched; the ladder
  stays paused. Branch diff vs `main` on the code side is exactly the eight
  files listed in the three commits.
- ASCII: verified mechanically -
  `git diff <base>...HEAD -U0 -- app dashboard | grep '^+' | LC_ALL=C grep '[^ -~\t]'`
  returns nothing.
- No slow gate was run (`npm test`, `npm run e2e`, `npm run smoke` all
  untouched). No background command is left running.

## Noticed and NOT fixed

1. **Pre-existing lint error in a file I touched.**
   `npx eslint` over my eight files reports exactly one problem:

   ```
   app/src/repos/tourRemindersRepo.ts
     14:3  error  'GetCommand' is defined but never used. ... @typescript-eslint/no-unused-vars
   ```

   **Attributed by baseline:** `GetCommand` is imported at `:14` on `main` too
   and appears exactly ONCE in the whole file (the import) both before and after
   my change - my diff is a pure union addition ~55 lines below it. Pre-existing,
   left alone per the gate-5 ratchet, named here so the branch's gate-5 run does
   not re-diagnose it as ours. Worth a look by whoever owns that file: an unused
   import can mean the code that used it was deleted by mistake.

2. **`RemindersPanel.test.tsx`'s file header comment (`:1-7`) still uses non-ASCII
   punctuation** (an em dash in "Will be skipped — <reason>" and arrows in the
   bullet list). Pre-existing lines; my added lines are ASCII. Not touched -
   the ASCII rule is added-lines-only on a pre-existing non-ASCII file.

3. **Nothing in my three tasks surfaced an unpredicted importer, type cycle, or
   contract mismatch.** Every plan anchor I depended on
   (`unitsRepo.ts:295`/`:299`, `contactsRepo.ts:290`/`:495`, `logger.ts:14`,
   `RemindersPanel.tsx:99-108`, `types.ts` union + label map, `types.test.ts`
   `SERVER_CODES` at `:9-24`) matched the live tree.

## Next step for S2

Slice S2 = Task 4 Steps 1-5 (catalog + composer + composer tests). Note the
slice-order rule: **S2 must NOT commit** - it leaves the tree red until S3
finishes Task 4. `TourContactNames` is now available for import from
`app/src/lib/tourContacts.js`; worklist **A4-8** requires the `tourCopy.ts`
re-export to be the erased form
`export type { TourContactNames } from '../lib/tourContacts.js';`.
