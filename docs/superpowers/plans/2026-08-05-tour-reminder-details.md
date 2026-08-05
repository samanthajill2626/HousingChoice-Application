# Tour Reminder Details Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tour reminder texts carry the actual tour time and the unit's address,
composed once and rendered identically everywhere they are previewed or sent.

**Architecture:** Two new pure modules (`lib/localTime.ts`, `messages/tourCopy.ts`)
plus a third for encoding analysis (`lib/smsEncoding.ts`). The catalog grows from
four tour entries to eight (an address-bearing and an `_no_address` variant per
rung). A single `composeTourReminderBody` serves all six token-bearing resolution
sites. The body composed at claim time is snapshotted onto the reminder row so
already-sent rungs never get retroactively rewritten.

**Sequencing note (READ THIS FIRST):** the copy change is deliberately the LAST
behavioral step. Tasks 4-8 introduce the composer, the deps, the snapshot and the
containment while every body stays byte-identical, so each task ends GREEN with no
test-expectation churn. Only Task 9 flips the actual copy. Do not reorder.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, Express,
DynamoDB (aws-sdk v3 lib-dynamodb), React dashboard, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-08-05-tour-reminder-details-design.md` (v4).
Read it before Task 1. Decisions are cited below as D1..D9, W1..W7.

## Global Constraints

- ASCII-only in every added line - source, comments, tests, test names, commit
  messages, docs. Verify: `tr -d '\11\12\15\40-\176' < FILE | wc -c` must print 0.
- COROLLARY, and this plan depends on it: where a non-ASCII character is genuinely
  REQUIRED by the code (the GSM-7 alphabet table, the U+00A0/U+202F normalizer,
  the em-dash and accented test fixtures), write it as a `\uXXXX` ESCAPE, never as
  a literal. Every code block below already does. Do NOT "clean this up" by pasting
  the real characters back in - that breaks the ASCII gate AND makes the file a
  mojibake target. An escape is also reviewable; a raw U+202F is visually
  identical to a space.
- Gates are run BARE, never piped: `npm run typecheck`, `npm test`,
  `timeout 1500 npm run e2e`. Redirect to a file and grep the file if you need to
  filter. `npm run typecheck` is REQUIRED and separate - the runtime suites strip
  types without checking them.
- e2e runs ONLY from this worktree. A stray root run targets the human's live dev
  stack.
- Commit discipline: a gating bare `git status` READ before EVERY commit, as its
  own command. Stage EXPLICIT paths only - never `git add -A`. Every commit ends
  with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Never rewrite a source file with PowerShell `Get-Content`/`-replace`/`Set-Content`
  (mojibake). Use the Edit tool.
- New automated user-facing copy goes ONLY through the message catalog.
- No infra: no terraform, no secrets push, no deploys, no real `.env` edits.
- Do NOT touch `placementNudgesRepo.claimSend` (`app/test/helpers/twilioWebhookHarness.ts:2179`).
  It is a different method that happens to share a name.

---

## File Structure

**Created:**
- `app/src/lib/smsEncoding.ts` - GSM-7/UCS-2 classification and segment pricing. Pure.
- `app/src/lib/localTime.ts` - org-local date/time rendering. Pure.
- `app/src/messages/tourCopy.ts` - the ONE tour reminder body composer. Pure.
- `app/test/smsEncoding.test.ts`, `app/test/localTime.test.ts`,
  `app/test/tourCopy.test.ts`, `app/test/messageCatalogAscii.test.ts`,
  `app/test/tourCopyCallSites.test.ts`

**Modified (app):**
- `app/src/lib/address.ts` - add `formatStreet`, refactor `formatAddress` to use it.
- `app/src/messages/catalog.ts` - 4 tour entries retemplated + 4 `_no_address`
  added; 3 em-dash fixes in the nudges.
- `app/src/repos/tourRemindersRepo.ts` - `sentBody` on the item; `claimSend` gains
  an optional third parameter; `invalid_schedule` joins `ReminderSkipReason`.
- `app/src/jobs/tourReminders.ts` - compose above claim at 3 sites; containment.
- `app/src/routes/tourReminders.ts` - composer + `unitsRepo` + timezone on the wire.
- `app/src/routes/contactTimeline.ts` - the seventh site; same.
- `app/src/routes/dev.ts` - `unitsRepo` into the dev tick deps.
- `app/src/worker.ts` - `unitsRepo` into the poll deps.

**Modified (dashboard):**
- `dashboard/src/routes/placements/placementsFormat.ts` - `dateTime` optional `timeZone`.
- `dashboard/src/api/types.ts` - `invalid_schedule` in two exhaustive places; `timezone` on both responses.
- `dashboard/src/routes/tours/RemindersPanel.tsx`, `dashboard/src/routes/contact/ScheduledCard.tsx` - format in the composing zone.

**Modified (e2e):** `e2e/scenarios/steps.ts` and its four consumer specs.

---

## Task 0: Prerequisites (DO THIS FIRST - nothing below runs without it)

This worktree was created by `git worktree add`, which copies tracked files ONLY.
It has NO `node_modules` - not at the root, not in `app/`. Dependencies are hoisted
to the workspace root, so `npx vitest` in Task 1 would not find vitest; `npx` would
then try to DOWNLOAD it rather than failing cleanly, which wastes minutes and can
produce a version skew against the repo's pinned vitest.

- [ ] **Step 1: Install dependencies from the worktree root**

```bash
cd w:/tmp/tour-reminder-details
npm install
```

Expected: a `node_modules` tree at the worktree root. This is a workspaces repo -
install from the ROOT, never from `app/` or `dashboard/`.

- [ ] **Step 2: Verify the toolchain actually resolves**

```bash
cd w:/tmp/tour-reminder-details/app && npx vitest --version
```
Expected: a version number printed with no download. If npx offers to install
anything, STOP - the install in Step 1 did not take.

- [ ] **Step 3: Warm the containers**

```bash
cd w:/tmp/tour-reminder-details
npm run db:start
npm run s3:start
```

DynamoDB Local backs the `tourReminders.test.ts` integration suite from Task 5
onward. That suite SELF-SKIPS when nothing answers, and a skipped suite is not a
pass - if you see the skip warning, the container is not up.

- [ ] **Step 4: Confirm the baseline is green BEFORE you change anything**

Run these BARE from the worktree root:

```bash
npm run typecheck
npm test
```
Expected: PASS. If either is red on an untouched worktree, STOP and report - you
cannot attribute a later failure to your own change without this baseline.

Do NOT commit anything in this task (`node_modules` is gitignored; verify with a
bare `git status` that the tree is clean).

---

## Task 1: SMS encoding analysis + the catalog ASCII guard

Folded in from `docs/issues/sms-copy-non-gsm7-characters.md` (spec section 7).
The three copy edits are NOT optional - the test in step 5 fails without them.

**Files:**
- Create: `app/src/lib/smsEncoding.ts`, `app/test/smsEncoding.test.ts`,
  `app/test/messageCatalogAscii.test.ts`
- Modify: `app/src/messages/catalog.ts` (3 nudge defaults only)

**Interfaces:**
- Consumes: nothing.
- Produces: `analyzeSms(body: string): { encoding: 'GSM-7' | 'UCS-2'; units: number; segments: number; nonGsm7Chars: string[] }`

- [ ] **Step 1: Write the failing test**

Create `app/test/smsEncoding.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { analyzeSms } from '../src/lib/smsEncoding.js';

describe('analyzeSms', () => {
  it('plain ASCII is GSM-7, one septet per character', () => {
    const r = analyzeSms('Hello');
    expect(r.encoding).toBe('GSM-7');
    expect(r.units).toBe(5);
    expect(r.segments).toBe(1);
    expect(r.nonGsm7Chars).toEqual([]);
  });

  it('160 GSM-7 characters is one segment; 161 is two', () => {
    expect(analyzeSms('a'.repeat(160)).segments).toBe(1);
    expect(analyzeSms('a'.repeat(161)).segments).toBe(2);
  });

  it('multi-segment GSM-7 prices at 153 per part (concatenation header)', () => {
    expect(analyzeSms('a'.repeat(306)).segments).toBe(2);
    expect(analyzeSms('a'.repeat(307)).segments).toBe(3);
  });

  it('extension-table characters cost 2 septets each', () => {
    const r = analyzeSms('[]');
    expect(r.encoding).toBe('GSM-7');
    expect(r.units).toBe(4);
  });

  it('an em dash forces UCS-2 and its 70-character budget', () => {
    const r = analyzeSms('a\u2014b');
    expect(r.encoding).toBe('UCS-2');
    expect(r.nonGsm7Chars).toEqual(['\u2014']);
    expect(analyzeSms('\u2014' + 'a'.repeat(69)).segments).toBe(1);
    expect(analyzeSms('\u2014' + 'a'.repeat(70)).segments).toBe(2);
  });

  it('UCS-2 multi-segment prices at 67 per part', () => {
    expect(analyzeSms('\u2014' + 'a'.repeat(133)).segments).toBe(2);
    expect(analyzeSms('\u2014' + 'a'.repeat(134)).segments).toBe(3);
  });

  it('accented letters are GSM-7 basic, not UCS-2', () => {
    expect(analyzeSms('caf\u00E9').encoding).toBe('GSM-7');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd app && npx vitest run test/smsEncoding.test.ts`
Expected: FAIL - cannot resolve `../src/lib/smsEncoding.js`.

- [ ] **Step 3: Implement `app/src/lib/smsEncoding.ts`**

```ts
// SMS encoding analysis - which alphabet a body lands in and what it costs.
//
// A single character outside GSM-7 flips the WHOLE message to UCS-2, collapsing
// the budget from 160 characters to 70 (and from 153 to 67 per part once it
// splits). This module is the single authority on that pricing; a naive
// body.length check gets it wrong in both directions.
//
// Pure: data + arithmetic only, no I/O (the messages/catalog.ts discipline).
export type SmsEncoding = 'GSM-7' | 'UCS-2';

export interface SmsAnalysis {
  encoding: SmsEncoding;
  /** Septets for GSM-7, UTF-16 code units for UCS-2. */
  units: number;
  segments: number;
  /** Distinct characters that forced UCS-2 - for a failure message, never a log. */
  nonGsm7Chars: string[];
}

// EVERY non-ASCII character below is written as a \u ESCAPE, deliberately. Two
// reasons: the repo's ASCII-only rule applies to source, and a file carrying raw
// U+00A0 / U+202F / accented literals is exactly the file a careless editor or a
// PowerShell rewrite turns into mojibake (a documented footgun here). Escapes are
// also self-documenting - \u202F says which space it is, a raw one does not.

/** GSM 03.38 basic alphabet. Order is irrelevant; membership is what matters. */
const GSM7_BASIC =
  '@\u00A3$\u00A5\u00E8\u00E9\u00F9\u00EC\u00F2\u00C7\n\u00D8\u00F8\r\u00C5\u00E5' +
  '\u0394_\u03A6\u0393\u039B\u03A9\u03A0\u03A8\u03A3\u0398\u039E\u00C6\u00E6\u00DF\u00C9' +
  ' !"#\u00A4%&\'()*+,-./0123456789:;<=>?' +
  '\u00A1ABCDEFGHIJKLMNOPQRSTUVWXYZ\u00C4\u00D6\u00D1\u00DC\u00A7' +
  '\u00BFabcdefghijklmnopqrstuvwxyz\u00E4\u00F6\u00F1\u00FC\u00E0';

/** GSM 03.38 extension table - each costs TWO septets (escape + character). */
const GSM7_EXTENSION = '\f^{}\\[~]|\u20AC';

const GSM7_SINGLE = 160;
const GSM7_CONCAT = 153;
const UCS2_SINGLE = 70;
const UCS2_CONCAT = 67;

export function analyzeSms(body: string): SmsAnalysis {
  const chars = [...body];
  const nonGsm7 = [
    ...new Set(chars.filter((c) => !GSM7_BASIC.includes(c) && !GSM7_EXTENSION.includes(c))),
  ];

  if (nonGsm7.length > 0) {
    // UCS-2 counts UTF-16 code units, so an astral character costs 2.
    const units = chars.reduce((n, c) => n + ((c.codePointAt(0) ?? 0) > 0xffff ? 2 : 1), 0);
    return {
      encoding: 'UCS-2',
      units,
      segments: units <= UCS2_SINGLE ? 1 : Math.ceil(units / UCS2_CONCAT),
      nonGsm7Chars: nonGsm7,
    };
  }

  const units = chars.reduce((n, c) => n + (GSM7_EXTENSION.includes(c) ? 2 : 1), 0);
  return {
    encoding: 'GSM-7',
    units,
    segments: units <= GSM7_SINGLE ? 1 : Math.ceil(units / GSM7_CONCAT),
    nonGsm7Chars: [],
  };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd app && npx vitest run test/smsEncoding.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the catalog ASCII guard (it will fail)**

Create `app/test/messageCatalogAscii.test.ts`:

```ts
// The durable guard from docs/issues/sms-copy-non-gsm7-characters.md.
//
// This asserts ASCII, which is STRICTER than GSM-7 - it rejects characters GSM-7
// would happily price at one septet (POUND SIGN, E-ACUTE, N-TILDE). That is
// deliberate: ASCII is a rule a human can apply by eye and a reviewer can enforce
// without consulting a table. Do NOT "fix" this into a GSM-7 check - that would
// let the em dash's cousins back in.
//
// It covers OUR strings only. User-supplied values (unit addresses, operator
// overrides, contact names) pass through verbatim by design (spec D6) and are
// never asserted here.
import { describe, expect, it } from 'vitest';
import { MESSAGE_CATALOG } from '../src/messages/catalog.js';
import { analyzeSms } from '../src/lib/smsEncoding.js';

const NON_ASCII = /[^\x09\x0a\x0d\x20-\x7e]/g;

describe('message catalog: every SMS default is ASCII', () => {
  for (const def of Object.values(MESSAGE_CATALOG)) {
    if (def.channel !== 'sms') continue;
    it(`${def.id} default is ASCII`, () => {
      const offenders = [...new Set(def.default.match(NON_ASCII) ?? [])];
      const named = offenders
        .map((c) => `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`)
        .join(' ');
      expect(offenders, `${def.id} contains non-ASCII: ${named}`).toEqual([]);
    });
  }
});

describe('message catalog: SMS defaults are GSM-7 (implied by ASCII)', () => {
  for (const def of Object.values(MESSAGE_CATALOG)) {
    if (def.channel !== 'sms') continue;
    it(`${def.id} encodes as GSM-7`, () => {
      expect(analyzeSms(def.default).encoding).toBe('GSM-7');
    });
  }
});
```

- [ ] **Step 6: Run it and confirm exactly three failures**

Run: `cd app && npx vitest run test/messageCatalogAscii.test.ts`
Expected: FAIL on `nudge.receipt_check`, `nudge.approval_check`,
`nudge.rta_window_closing`, each reporting `U+2014`. If ANY other entry fails,
STOP and report - the spec's verified claim was that these are the only three.

- [ ] **Step 7: Fix the three em dashes**

In `app/src/messages/catalog.ts`, replace the U+2014 EM DASH with an ASCII
hyphen-minus in exactly these three defaults. Use the Edit tool, one edit each.
Change nothing else about the strings.

- `nudge.receipt_check`: `'Just checking in - did the rental application come through? Let us know if you need it re-sent.'`
- `nudge.completion_check`: UNCHANGED (already ASCII - do not touch).
- `nudge.approval_check`: `'Checking in - any decision yet on the application we sent over?'`
- `nudge.rta_window_closing`: `'Friendly reminder - the 48-hour RTA window is closing. Have you been able to submit it?'`

- [ ] **Step 8: Run both suites and confirm green**

Run: `cd app && npx vitest run test/smsEncoding.test.ts test/messageCatalogAscii.test.ts`
Expected: PASS.

- [ ] **Step 9: Full app suite**

Run: `cd app && npx vitest run`
Expected: PASS with NO other changes needed - no nudge default is duplicated
outside `catalog.ts`, so the three edits break nothing. If something does fail,
read it carefully rather than assuming it is copy drift.

- [ ] **Step 10: ASCII check, then commit**

```bash
tr -d '\11\12\15\40-\176' < app/src/lib/smsEncoding.ts | wc -c
tr -d '\11\12\15\40-\176' < app/test/smsEncoding.test.ts | wc -c
tr -d '\11\12\15\40-\176' < app/test/messageCatalogAscii.test.ts | wc -c
```
All three must print 0. Then run a bare `git status` as its own command, then:

```bash
git commit -F - -- app/src/lib/smsEncoding.ts app/test/smsEncoding.test.ts app/test/messageCatalogAscii.test.ts app/src/messages/catalog.ts <<'EOF'
feat(sms): analyzeSms + an ASCII guard over every SMS catalog default

A single non-GSM-7 character flips a whole message to UCS-2 and drops the budget
from 160 characters to 70. Three placement-nudge defaults carried a U+2014 em
dash; two of them billed as two segments because of it.

analyzeSms prices GSM-7 (including the 2-septet extension characters) so segment
counts are real rather than inferred from length. The catalog test asserts the
STRICTER ASCII rule deliberately - a rule a reviewer can apply by eye.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 2: Org-local date and time formatting

**Files:**
- Create: `app/src/lib/localTime.ts`, `app/test/localTime.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `formatLocalDate(iso: string, timezone: string): string` -> `"Thu, Jul 23"`;
  `formatLocalTime(iso: string, timezone: string): string` -> `"3:00 PM"`

- [ ] **Step 1: Write the failing test**

Create `app/test/localTime.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatLocalDate, formatLocalTime } from '../src/lib/localTime.js';

const NY = 'America/New_York';

describe('formatLocalDate', () => {
  it('renders weekday, month and day in the given zone', () => {
    // 2026-07-23T19:00Z == Jul 23 15:00 EDT
    expect(formatLocalDate('2026-07-23T19:00:00.000Z', NY)).toBe('Thu, Jul 23');
  });

  it('uses the LOCAL day, not the UTC day', () => {
    // 2026-07-23T01:00Z == Jul 22 21:00 EDT - the local date is the 22nd.
    expect(formatLocalDate('2026-07-23T01:00:00.000Z', NY)).toBe('Wed, Jul 22');
  });

  it('honors a non-US zone', () => {
    expect(formatLocalDate('2026-07-23T19:00:00.000Z', 'Asia/Tokyo')).toBe('Fri, Jul 24');
  });
});

describe('formatLocalTime', () => {
  it('renders 12-hour time with a meridiem', () => {
    expect(formatLocalTime('2026-07-23T19:00:00.000Z', NY)).toBe('3:00 PM');
  });

  it('renders local midnight as 12:00 AM, not 0:00 or 24:00', () => {
    // 2026-07-23T04:00Z == Jul 23 00:00 EDT
    expect(formatLocalTime('2026-07-23T04:00:00.000Z', NY)).toBe('12:00 AM');
  });

  it('renders local noon as 12:00 PM', () => {
    expect(formatLocalTime('2026-07-23T16:00:00.000Z', NY)).toBe('12:00 PM');
  });

  it('is correct on both sides of a DST boundary', () => {
    // EST (UTC-5) in January, EDT (UTC-4) in July - same UTC clock time.
    expect(formatLocalTime('2026-01-15T17:00:00.000Z', NY)).toBe('12:00 PM');
    expect(formatLocalTime('2026-07-15T17:00:00.000Z', NY)).toBe('1:00 PM');
  });
});

describe('output is always ASCII (the SMS budget depends on it)', () => {
  // ICU 72 shipped U+202F NARROW NO-BREAK SPACE before AM/PM. One of those flips
  // a whole reminder to UCS-2 and halves its budget, so the formatters normalize
  // it and this test is the tripwire for a future Node/ICU bump.
  const NON_ASCII = /[^\x20-\x7e]/;
  const instants = [
    '2026-01-15T17:00:00.000Z', '2026-07-15T17:00:00.000Z',
    '2026-07-23T04:00:00.000Z', '2026-07-23T16:00:00.000Z',
  ];
  for (const iso of instants) {
    it(`no non-ASCII in either formatter at ${iso}`, () => {
      expect(formatLocalDate(iso, NY)).not.toMatch(NON_ASCII);
      expect(formatLocalTime(iso, NY)).not.toMatch(NON_ASCII);
    });
  }
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd app && npx vitest run test/localTime.test.ts`
Expected: FAIL - cannot resolve `../src/lib/localTime.js`.

- [ ] **Step 3: Implement `app/src/lib/localTime.ts`**

```ts
// Org-local date/time rendering for user-facing copy.
//
// Pure, structural inputs, no clock reads, no repo imports - the lib/quietHours.ts
// discipline, including its cached-formatter idiom (constructing an
// Intl.DateTimeFormat is the expensive part; formatToParts on a cached instance
// is cheap).
//
// ASCII NORMALIZATION IS LOAD-BEARING, not cosmetic. ICU 72 shipped U+202F
// NARROW NO-BREAK SPACE between the time and the meridiem. A single one of those
// inside an SMS body flips the whole message from GSM-7 to UCS-2, collapsing the
// budget from 160 characters to 70. This repo's Node 24 (ICU 78) emits a plain
// space, but a Node bump must never be able to double the SMS bill silently.
// app/test/localTime.test.ts is the tripwire.

const dateCache = new Map<string, Intl.DateTimeFormat>();
const timeCache = new Map<string, Intl.DateTimeFormat>();

function dateFormatterFor(timezone: string): Intl.DateTimeFormat {
  let f = dateCache.get(timezone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    dateCache.set(timezone, f);
  }
  return f;
}

function timeFormatterFor(timezone: string): Intl.DateTimeFormat {
  let f = timeCache.get(timezone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    timeCache.set(timezone, f);
  }
  return f;
}

/** U+00A0 NO-BREAK SPACE and U+202F NARROW NO-BREAK SPACE -> plain space. */
function toAscii(s: string): string {
  return s.replace(/[\u00A0\u202F]/g, ' ');
}

/** "Thu, Jul 23" in `timezone`. Throws RangeError on an unparseable instant. */
export function formatLocalDate(iso: string, timezone: string): string {
  return toAscii(dateFormatterFor(timezone).format(new Date(iso)));
}

/** "3:00 PM" in `timezone`. Throws RangeError on an unparseable instant. */
export function formatLocalTime(iso: string, timezone: string): string {
  return toAscii(timeFormatterFor(timezone).format(new Date(iso)));
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd app && npx vitest run test/localTime.test.ts`
Expected: PASS.

If `formatLocalDate` returns `"Thu, Jul 23"` but the test wanted a different
separator, trust the TEST and adjust nothing - `en-US` with `weekday: 'short'`
produces `"Thu, Jul 23"` on ICU 78. If your ICU differs, report it rather than
loosening the assertion: the exact string is what the copy depends on.

- [ ] **Step 5: ASCII check and commit**

```bash
tr -d '\11\12\15\40-\176' < app/src/lib/localTime.ts | wc -c
tr -d '\11\12\15\40-\176' < app/test/localTime.test.ts | wc -c
```
Both must print 0. Bare `git status`, then:

```bash
git commit -F - -- app/src/lib/localTime.ts app/test/localTime.test.ts <<'EOF'
feat(lib): org-local date/time formatters with ASCII normalization

formatLocalDate/formatLocalTime render an instant in a given IANA zone for
user-facing copy, following the quietHours.ts discipline (pure, cached
Intl formatters, no clock reads).

Both normalize U+00A0 and U+202F to a plain space. ICU 72 shipped U+202F before
the meridiem, and one of those inside an SMS flips the body to UCS-2 and halves
its budget. ICU 78 emits a plain space today; the test is the tripwire so a Node
bump cannot change that silently.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 3: `formatStreet` on the address module

**Files:**
- Modify: `app/src/lib/address.ts`
- Test: `app/test/address.test.ts` (extend if it exists; create if not)

**Interfaces:**
- Consumes: nothing.
- Produces: `formatStreet(a: Address | string | undefined): string`

**Context (spec D5):** street-only applies to a STRUCTURED address. Every seeded
unit stores a legacy plain STRING that already includes city/state/zip, and those
pass through verbatim. That is the honest behavior, not a bug to fix here.

- [ ] **Step 1: Write the failing test**

Add to `app/test/address.test.ts` (create with the standard header if absent):

```ts
import { describe, expect, it } from 'vitest';
import { formatAddress, formatStreet } from '../src/lib/address.js';

describe('formatStreet', () => {
  it('returns line1 alone', () => {
    expect(formatStreet({ line1: '412 Oak St' })).toBe('412 Oak St');
  });

  it('joins line1 and line2 with a space', () => {
    expect(formatStreet({ line1: '412 Oak St', line2: 'Apt 2' })).toBe('412 Oak St Apt 2');
  });

  it('EXCLUDES city, state and zip from a structured address', () => {
    expect(formatStreet({ line1: '412 Oak St', city: 'Atlanta', state: 'GA', zip: '30312' }))
      .toBe('412 Oak St');
  });

  it('returns a legacy plain-string address verbatim, trimmed', () => {
    // Every seeded unit is this shape - postal noise included, by design (D5).
    expect(formatStreet('  350 Boulevard SE, Atlanta, GA 30312 '))
      .toBe('350 Boulevard SE, Atlanta, GA 30312');
  });

  it('returns empty string for undefined, an empty object, or a blank string', () => {
    expect(formatStreet(undefined)).toBe('');
    expect(formatStreet({})).toBe('');
    expect(formatStreet('   ')).toBe('');
  });
});

describe('formatAddress still behaves after the refactor', () => {
  it('joins street with city, state and zip', () => {
    expect(formatAddress({ line1: '412 Oak St', line2: 'Apt 2', city: 'Atlanta', state: 'GA', zip: '30312' }))
      .toBe('412 Oak St Apt 2, Atlanta, GA 30312');
  });

  it('passes a legacy string through', () => {
    expect(formatAddress('350 Boulevard SE, Atlanta, GA 30312'))
      .toBe('350 Boulevard SE, Atlanta, GA 30312');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd app && npx vitest run test/address.test.ts`
Expected: FAIL - `formatStreet` is not exported.

- [ ] **Step 3: Add `formatStreet` and refactor `formatAddress`**

In `app/src/lib/address.ts`, insert `formatStreet` immediately BEFORE
`formatAddress` (around line 87), then change `formatAddress` to call it so the
two can never drift:

```ts
/**
 * The STREET portion only - line1 plus line2, no city/state/zip. This is what
 * user-facing SMS copy uses: a tenant needs the street to navigate, not the
 * postal tail (spec D5).
 *
 * Tolerant of a legacy plain-string address, which is returned trimmed and
 * VERBATIM - such a value usually contains city/state/zip and we do not attempt
 * to parse it out. Every seeded unit is this shape today.
 */
export function formatStreet(a: Address | string | undefined): string {
  if (a === undefined) return '';
  if (typeof a === 'string') return a.trim();
  return [a.line1, a.line2].filter((s) => s && s.length > 0).join(' ');
}
```

Then in `formatAddress`, replace the inline street computation (currently
`const street = [a.line1, a.line2].filter(...).join(' ');`) with:

```ts
  const street = formatStreet(a);
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd app && npx vitest run test/address.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full app suite (formatAddress has other consumers)**

Run: `cd app && npx vitest run`
Expected: PASS.

- [ ] **Step 6: ASCII check and commit**

```bash
tr -d '\11\12\15\40-\176' < app/src/lib/address.ts | wc -c
```
Note: `address.ts` is a PRE-EXISTING file that may contain non-ASCII in older
comments. Per the repo rule, only your ADDED lines must be ASCII - if this prints
non-zero, confirm via `git diff` that none of the offending characters are yours.

Bare `git status`, then commit `app/src/lib/address.ts` and `app/test/address.test.ts`
with message `feat(address): formatStreet - the street-only projection for SMS copy`
plus the Co-Authored-By trailer.

---

## Task 4: The composer, behavior-neutral

The composer lands FIRST returning today's exact copy, so Tasks 5-8 can wire
every site with zero test-expectation churn. Task 9 flips the copy.

**Step 0 first - split the repo dependency out of `resolve.ts`.** `resolve.ts`
VALUE-imports `createSettingsRepo`, which pulls `lib/dynamo.js` and
`@aws-sdk/client-dynamodb`. Task 12 imports the composer into the Playwright
harness, and `e2e/package.json` declares exactly ONE dependency
(`@playwright/test`) - so every e2e worker would load the AWS SDK. It resolves
today by hoisting and nothing executes at import time, so this is weight and
latent breakage rather than a hard failure - but the fix is small and it restores
the purity this layer's own header claims.

- [ ] **Step 0: Make `resolve.ts` pure**

Move ONLY `resolveWithSettings` into a new `app/src/messages/resolveWithSettings.ts`.
Leave `resolveMessage`, `interpolate` and `settingsToOverrides` in `resolve.ts`,
and change its settings import to TYPE-ONLY:

```ts
import type { OrgSettings } from '../repos/settingsRepo.js';
```

`settingsToOverrides` only needs the TYPE, so it stays pure. Then re-export both
from `app/src/messages/index.ts` so every existing importer is untouched:

```ts
export { resolveMessage, settingsToOverrides } from './resolve.js';
export { resolveWithSettings } from './resolveWithSettings.js';
```

Verify nothing else changed: `grep -rn "from './resolve.js'\|from '../messages/resolve.js'" app/src app/test`
should show only `index.ts` and the new module. Every consumer imports from
`messages/index.js` today (verified: `missedCallAutoText.ts`, `public.ts`,
`relayGroups.ts`, `webhooks/twilio.ts`), so this is additive.

Run `cd app && npx vitest run test/messages/resolve.test.ts` - PASS, unchanged.
Commit this as its own small commit before continuing.

**Files:**
- Create: `app/src/messages/resolveWithSettings.ts`, `app/src/messages/tourCopy.ts`,
  `app/test/tourCopy.test.ts`
- Modify: `app/src/messages/resolve.ts`, `app/src/messages/index.ts`

**Interfaces:**
- Consumes: `formatStreet` (Task 3), `formatLocalDate`/`formatLocalTime` (Task 2),
  `analyzeSms` (Task 1).
- Produces:
  - `composeTourReminderBody(input: ComposeTourReminderInput): string`
  - `class UncomposableReminderError extends Error`
  - `interface ComposeTourReminderInput { kind: ReminderKind; scheduledAt: string; timezone: string; address?: Address | string; overrides?: Partial<Record<MessageId, string>> }`

- [ ] **Step 1: Write the failing test**

Create `app/test/tourCopy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  composeTourReminderBody,
  UncomposableReminderError,
} from '../src/messages/tourCopy.js';
import { MESSAGE_CATALOG } from '../src/messages/catalog.js';

const NY = 'America/New_York';
const AT = '2026-07-23T19:00:00.000Z'; // Jul 23 15:00 EDT

const base = { scheduledAt: AT, timezone: NY } as const;

describe('composeTourReminderBody (behavior-neutral stage)', () => {
  // Task 9 replaces these with the real interpolated strings. Until then the
  // composer must return today's catalog copy EXACTLY, so every existing test
  // and every e2e body assertion keeps passing while the call sites are rewired.
  it('returns the current catalog default for each armed kind', () => {
    for (const kind of ['confirmation', 'day_before', 'morning_of', 'en_route'] as const) {
      expect(composeTourReminderBody({ ...base, kind, address: '412 Oak St' }))
        .toBe(MESSAGE_CATALOG[`tour.${kind}`].default);
    }
  });

  it('returns the same body with no address', () => {
    expect(composeTourReminderBody({ ...base, kind: 'morning_of' }))
      .toBe(MESSAGE_CATALOG['tour.morning_of'].default);
  });
});

describe('composeTourReminderBody: scheduledAt is a precondition', () => {
  it('throws UncomposableReminderError on an unparseable instant', () => {
    expect(() => composeTourReminderBody({ ...base, kind: 'morning_of', scheduledAt: 'nope' }))
      .toThrow(UncomposableReminderError);
  });

  it('throws UncomposableReminderError on an empty instant', () => {
    expect(() => composeTourReminderBody({ ...base, kind: 'morning_of', scheduledAt: '' }))
      .toThrow(UncomposableReminderError);
  });

  it('the error names the tour-copy origin, not a bare RangeError', () => {
    try {
      composeTourReminderBody({ ...base, kind: 'morning_of', scheduledAt: 'nope' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UncomposableReminderError);
      expect((err as Error).name).toBe('UncomposableReminderError');
    }
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd app && npx vitest run test/tourCopy.test.ts`
Expected: FAIL - cannot resolve `../src/messages/tourCopy.js`.

- [ ] **Step 3: Implement `app/src/messages/tourCopy.ts`**

```ts
// The ONE composer for tour reminder bodies.
//
// WHY THIS EXISTS: there are six places that need a rung's text - the poll's 1:1
// and group sends, the human force-send, both tour-reminder route surfaces, and
// the contact timeline's Upcoming bucket. Three of those are PREVIEWS the staff
// read as "this is what will be sent". If any of them built the string
// differently the dashboard would be lying, so every one of them calls this
// function and nothing else (enforced by app/test/tourCopyCallSites.test.ts).
//
// Pure: no repos, no clock, no I/O. Callers supply the instant, the zone and the
// address.
//
// PARTIAL BY DESIGN: this function THROWS UncomposableReminderError when
// scheduledAt is unusable. {when} and {time} sit mid-sentence and have no
// graceful empty shape, so there is nothing to degrade to HERE. Every caller is
// required to contain it - send paths claim-skip the rung with
// 'invalid_schedule', read paths fall back to body: '' - because an uncontained
// throw means either a 500 on a read path or an unclaimed row retried every 60s
// forever. See the spec's section 5 and W6/W7.
import type { Address } from '../lib/address.js';
import { formatStreet } from '../lib/address.js';
import { formatLocalDate, formatLocalTime } from '../lib/localTime.js';
import type { MessageId } from './catalog.js';
import { resolveMessage } from './resolve.js';
import type { ReminderKind } from '../repos/tourRemindersRepo.js';

/** Thrown when a rung's scheduledAt cannot produce a time. Callers MUST catch. */
export class UncomposableReminderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UncomposableReminderError';
  }
}

export interface ComposeTourReminderInput {
  kind: ReminderKind;
  /** REQUIRED even though TourItem.scheduledAt is optional: a reminder row cannot
   *  exist for a time-less tour (armTourReminders returns early without one, and
   *  PATCH cannot clear it), so every caller has one in hand. */
  scheduledAt: string;
  /** IANA zone. Resolve it via resolveQuietHoursTimezone - never read
   *  settings.timezone directly (spec D8). */
  timezone: string;
  address?: Address | string;
  overrides?: Partial<Record<MessageId, string>>;
}

export function composeTourReminderBody(input: ComposeTourReminderInput): string {
  const { kind, scheduledAt, timezone, address, overrides } = input;

  // no_show_checkin is manual-send only and deliberately token-free (spec D2):
  // when you are not certain someone no-showed, vaguer wording is kinder.
  if (kind === 'no_show_checkin') {
    return resolveMessage('tour.no_show_checkin', undefined, overrides);
  }

  if (Number.isNaN(new Date(scheduledAt).getTime())) {
    throw new UncomposableReminderError(
      `tour reminder body needs a usable scheduledAt (kind=${kind})`,
    );
  }

  // Composed but unused until Task 9 flips the catalog templates. Computing them
  // now means Task 9 is a catalog-and-selection change only.
  void formatStreet(address);
  void formatLocalDate(scheduledAt, timezone);
  void formatLocalTime(scheduledAt, timezone);

  return resolveMessage(`tour.${kind}`, undefined, overrides);
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd app && npx vitest run test/tourCopy.test.ts`
Expected: PASS.

- [ ] **Step 5: ASCII check and commit**

Both new files must print 0 from the `tr` check. Bare `git status`, then commit
`app/src/messages/tourCopy.ts` and `app/test/tourCopy.test.ts` with message
`feat(messages): composeTourReminderBody seam (behavior-neutral)` plus the trailer.
State in the body that the copy is unchanged and Task 9 flips it.

---

## Task 5: `sentBody` on the row and the claim

**Files:**
- Modify: `app/src/repos/tourRemindersRepo.ts`
- Modify: `app/test/helpers/twilioWebhookHarness.ts` (the fake at ~:2085)
- Test: `app/test/tourReminders.test.ts` (add one case)

**Interfaces:**
- Produces: `TourReminderItem.sentBody?: string`;
  `claimSend(reminderId: string, claimedAt: string, sentBody?: string): Promise<boolean>`;
  `ReminderSkipReason` gains `'invalid_schedule'`.

**Why optional (spec F3):** SEVEN existing call sites pass two arguments -
`relayApi.test.ts:1343`, `tourReminders.test.ts:655/1003/1099/2064`,
`tourRemindersApi.test.ts:556/692`. A required third parameter breaks all of them.
Optional erases that entirely and is honest: a claim with no body is exactly the
legacy-row case the read paths already handle.

- [ ] **Step 1: Write the failing test**

Add to `app/test/tourReminders.test.ts` (inside the existing describe block):

```ts
  it('claimSend stores the composed body on the row (and stays optional)', async () => {
    const tour = await tours.create({
      tenantId: 'contact-sentbody-1',
      unitId: 'unit-sentbody-1',
      scheduledAt: '2026-09-10T18:00:00.000Z',
      tourType: 'self_guided',
    });
    const withBody = await tourReminders.create({
      tourId: tour.tourId, kind: 'confirmation', dueAt: '2026-09-01T15:00:00.000Z',
    });
    const withoutBody = await tourReminders.create({
      tourId: tour.tourId, kind: 'day_before', dueAt: '2026-09-09T18:00:00.000Z',
    });

    expect(await tourReminders.claimSend(withBody.reminderId, '2026-09-01T15:00:01.000Z', 'Body text'))
      .toBe(true);
    // Two-arg call: the legacy shape every existing caller uses.
    expect(await tourReminders.claimSend(withoutBody.reminderId, '2026-09-09T18:00:01.000Z'))
      .toBe(true);

    const rows = await tourReminders.listByTour(tour.tourId);
    expect(rows.find((r) => r.reminderId === withBody.reminderId)?.sentBody).toBe('Body text');
    expect(rows.find((r) => r.reminderId === withoutBody.reminderId)?.sentBody).toBeUndefined();
  });
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd app && npx vitest run test/tourReminders.test.ts -t "stores the composed body"`
Expected: FAIL - `claimSend` takes 2 arguments / `sentBody` is not on the type.

Note: this suite needs DynamoDB Local. Start it with `npm run db:start` from the
worktree root first; the suite self-skips if nothing answers, and a skipped suite
is NOT a pass.

- [ ] **Step 3: Add `sentBody` to the item and the skip reason**

In `app/src/repos/tourRemindersRepo.ts`, add to `ReminderSkipReason`:

```ts
  /** ARM/SEND time: the rung's scheduledAt cannot produce a time, so no body can
   *  be composed. Retired rather than retried - an uncontained compose failure
   *  would leave the row unclaimed and re-listed by listDue every 60s forever. */
  | 'invalid_schedule'
```

And to `TourReminderItem`, beside `sentAt`:

```ts
  /** The body composed for the send that CLAIMED this row. NOT proof of delivery:
   *  claimSend IS the sentAt stamp, and a SendRefusedError leaves the claim in
   *  place with nothing delivered. Read paths render this for a sent rung so a
   *  later reschedule or address edit cannot retroactively rewrite history.
   *  Absent on rows claimed before this field existed - those compose live. */
  sentBody?: string;
```

- [ ] **Step 4: Widen `claimSend`**

Update the interface docstring and signature to
`claimSend(reminderId: string, claimedAt: string, sentBody?: string): Promise<boolean>`,
then in the implementation build the update expression conditionally so the
attribute is only written when supplied - keeping ONE atomic conditional write:

```ts
    async claimSend(reminderId, claimedAt, sentBody) {
      const setBody = typeof sentBody === 'string';
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { reminderId },
            UpdateExpression: setBody
              ? 'SET #sentAt = :sentAt, #sentBody = :sentBody'
              : 'SET #sentAt = :sentAt',
            ConditionExpression:
              'attribute_not_exists(#sentAt) AND attribute_not_exists(#canceledAt) AND attribute_not_exists(#skippedAt)',
            ExpressionAttributeNames: {
              '#sentAt': 'sentAt',
              '#canceledAt': 'canceledAt',
              '#skippedAt': 'skippedAt',
              ...(setBody && { '#sentBody': 'sentBody' }),
            },
            ExpressionAttributeValues: {
              ':sentAt': claimedAt,
              ...(setBody && { ':sentBody': sentBody }),
            },
          }),
        );
        log.info({ reminderId, claimedAt }, 'tour reminder claimed for send');
        return true;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.debug({ reminderId }, 'tour reminder claim lost (already claimed/canceled) - skipping');
          return false;
        }
        throw err;
      }
    },
```

Do NOT log `sentBody` - it is user-facing copy and the module header forbids it.

- [ ] **Step 5: Update the in-memory fake**

`app/test/helpers/twilioWebhookHarness.ts:2085` is `async claimSend(reminderId, claimedAt)`.
It still TYPECHECKS untouched (TypeScript permits an implementation with fewer
parameters), but it would silently drop `sentBody` and make Task 8's history test
meaningless. Add the third parameter and store it on the row exactly as the real
repo does. Leave `:2179` (`placementNudgesRepo`) alone.

- [ ] **Step 6: Run the test and confirm it passes**

Run: `cd app && npx vitest run test/tourReminders.test.ts -t "stores the composed body"`
Expected: PASS.

- [ ] **Step 7: Full app suite**

Run: `cd app && npx vitest run`
Expected: PASS - all seven two-arg callers still compile and behave.

- [ ] **Step 8: Typecheck, ASCII check, commit**

Run `npm run typecheck` from the worktree root, BARE. Then the `tr` checks on the
changed files (pre-existing files: only your added lines need to be ASCII).
Bare `git status`, then commit the three files with message
`feat(reminders): snapshot the composed body on the claim (optional sentBody)`
plus the trailer, explaining that optional keeps all seven existing callers valid.

---

## Task 6: Wire every send path through the composer

Still behavior-neutral: bodies are unchanged, so no expectation churn. This task
also performs the DANGEROUS REORDER (spec D4, W6).

**Files:**
- Modify: `app/src/jobs/tourReminders.ts`
- Modify: `app/src/worker.ts`, `app/src/routes/dev.ts`
- Test: `app/test/tourReminders.test.ts`

**Interfaces:**
- Consumes: `composeTourReminderBody`, `UncomposableReminderError` (Task 4);
  `claimSend(.., sentBody?)` (Task 5).
- Produces: `RunDueTourRemindersDeps` gains `unitsRepo: UnitsRepo`.

**THE REORDER (do not skip - this is the riskiest edit in the change):** only ONE
of the four send sites composes before it claims today. `claimSend` IS the
`sentAt` stamp, so composing AFTER it means a compose failure burns the rung
permanently.

| site | claims at | composes at | action |
|---|---|---|---|
| `processReminderRow` (poll 1:1) | `:587` | `:579` | already correct |
| `forceSendReminder` (1:1) | `:871` | `:903` | MOVE compose above the claim |
| `sendGroupReminder` (poll group) | `:715` | `:767` inside `announceGroupReminder` | caller composes, PASS the body in |
| `forceSendReminder` (group) | `:882` | `:767` same | caller composes, PASS the body in |

- [ ] **Step 1: Write the failing containment test**

Add to `app/test/tourReminders.test.ts`:

```ts
  it('a rung whose scheduledAt is unusable is claim-skipped, NOT retried forever', async () => {
    // The failure mode this guards: an uncontained compose throw escapes into the
    // per-row catch, the row is never claimed, and listDue hands it back every
    // 60s forever - the perpetual "sending shortly" bug claimSkip was built for.
    const tour = await tours.create({
      tenantId: 'contact-badsched-1',
      unitId: 'unit-badsched-1',
      scheduledAt: '2026-09-20T18:00:00.000Z',
      tourType: 'self_guided',
    });
    const row = await tourReminders.create({
      tourId: tour.tourId, kind: 'confirmation', dueAt: '2026-09-19T15:00:00.000Z',
    });
    // Corrupt the tour's time AFTER arming - the only way to reach this state.
    // The method is patch(), NOT update() - toursRepo has no update.
    await tours.patch(tour.tourId, { scheduledAt: 'not-an-instant' });

    const pollAt = '2026-09-19T15:00:01.000Z';
    await runDueTourReminders(pollAt, runDeps);

    const after = (await tourReminders.listByTour(tour.tourId))
      .find((r) => r.reminderId === row.reminderId);
    expect(after?.skippedAt).toBe(pollAt);
    expect(after?.skipReason).toBe('invalid_schedule');
    expect(after?.sentAt).toBeUndefined();

    // The point of the claim-skip: it leaves listDue permanently.
    expect((await tourReminders.listDue('2026-09-19T15:10:00.000Z'))
      .some((r) => r.reminderId === row.reminderId)).toBe(false);
  });
```

If `tours.patch` validates and rejects an invalid `scheduledAt`, write the row
directly with the doc client instead - the point is to reach the state, not to
prove the write surface allows it.

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd app && npx vitest run test/tourReminders.test.ts -t "claim-skipped, NOT retried"`
Expected: FAIL - the row is neither skipped nor claimed.

- [ ] **Step 3: Add `unitsRepo` to the deps and a compose helper**

In `app/src/jobs/tourReminders.ts`, add to `RunDueTourRemindersDeps`:

```ts
  /** Unit lookup for the address in reminder copy. A missing unit or a read
   *  failure degrades to the no-address variant - never blocks a send. */
  unitsRepo: UnitsRepo;
```

Then add a single shared helper used by all four send paths:

```ts
/**
 * Compose one rung's body, resolving the unit and the timezone. Total EXCEPT for
 * UncomposableReminderError, which the caller must contain (see the module
 * header). A unit-read failure degrades to no address rather than propagating -
 * a reminder must never be lost over a missing street.
 */
async function composeBodyForRow(
  row: TourReminderItem,
  tour: TourItem,
  window: QuietHoursWindow,
  deps: Pick<RunDueTourRemindersDeps, 'unitsRepo'>,
  log: Logger,
): Promise<string> {
  let address: Address | string | undefined;
  try {
    const unit = await deps.unitsRepo.getById(tour.unitId);
    address = unit?.address;
  } catch (err) {
    log.warn({ err, tourId: tour.tourId, kind: row.kind }, 'tour reminder: unit read failed - composing without an address');
  }
  return composeTourReminderBody({
    kind: row.kind,
    scheduledAt: tour.scheduledAt ?? '',
    timezone: window.timezone,
    ...(address !== undefined && { address }),
  });
}
```

`window.timezone` already comes from `readQuietHoursWindow`, which resolves through
`resolveQuietHoursTimezone` - do NOT read `settings.timezone` directly (spec D8).

- [ ] **Step 4: Rewire `processReminderRow` (already correctly ordered)**

Replace `const body = resolveMessage(\`tour.${row.kind}\`);` with a
`composeBodyForRow` call wrapped so the throw is contained:

```ts
  let body: string;
  try {
    body = await composeBodyForRow(row, tour, window, deps, log);
  } catch (err) {
    if (err instanceof UncomposableReminderError) {
      log.warn({ reminderId: row.reminderId, tourId: row.tourId, kind: row.kind },
        'tour reminder body uncomposable - retiring (claim-skipped)');
      await claimSkipRow(row, 'invalid_schedule', now, deps, tour.tenantId);
      return;
    }
    throw err;
  }
```

Then pass `body` into the claim: `deps.tourRemindersRepo.claimSend(row.reminderId, now, body)`.

- [ ] **Step 5: Reorder `forceSendReminder` (1:1)**

FIRST, note a signature gap: `forceSendReminder(reminderId, tourId, nowIso,
smsSendingEnabled, deps)` has NO quiet-hours window - only `runDueTourReminders`
calls `readQuietHoursWindow`. So `composeBodyForRow` cannot be called here as-is.
`forceSendReminder` must read its OWN window:

```ts
  const window = await readQuietHoursWindow(deps.settingsRepo, log);
```

Do this and nothing else. Do NOT reach for `settings.timezone` directly - D8/W5
forbid it, and `readQuietHoursWindow` is what routes through
`resolveQuietHoursTimezone`. (The window is used ONLY for its timezone here;
force-send deliberately bypasses quiet hours as a human action.)

Then compose BEFORE `claimSend` at `:871`, and pass the composed body into
`claimSend` and into the 1:1 `sendMessageService` call in place of the
`resolveMessage` at `:903`.

DECISION (do not improvise): a compose failure here is a PRE-CLAIM REFUSAL, never
a claim-skip - a human action must not retire a rung. Add `'invalid_schedule'` to
the `ForceSendRefusal` union and return
`{ outcome: 'refused', reason: 'invalid_schedule' }`.

A 500 would be wrong: the send-now route's whole design is a 409 carrying the
honest row view so the panel self-corrects. The dashboard degrades gracefully
before its copy line exists - `SEND_NOW_ERROR_COPY`
(`dashboard/src/api/types.ts:826`) is a `Readonly<Record<string, string>>` with a
documented generic fallback for unknown codes, so staff never see a raw token.
Add the copy line in Task 10 (you are already editing that file):
`invalid_schedule: 'That tour has no usable date and time, so nothing was sent.'`

NOTE for Task 10: unlike the two `skipReason` declarations, `SEND_NOW_ERROR_COPY`
is keyed by plain `string`, so typecheck will NOT force you to add this entry.
It is on you to remember.

- [ ] **Step 6: Hoist composition out of `announceGroupReminder`**

`announceGroupReminder` currently composes at `:767`. Change its signature to
accept the body from its caller:

```ts
async function announceGroupReminder(
  row: TourReminderItem,
  group: UsableGroup,
  body: string,
  deps: RunDueTourRemindersDeps,
): Promise<number>
```

Inside, pass `body` to `sendRelayAnnouncement`. KEEP the kind tag derived from the
rung, not from any catalog id: ``kind: `tour.${row.kind}` ``. Forking that by
address presence would fork every log line (spec section 6).

Then in `sendGroupReminder` and in `forceSendReminder`'s group branch, compose
BEFORE the claim and pass the body through. `sendGroupReminder` contains the throw
with the same claim-skip as step 4; `forceSendReminder` treats it as a pre-claim
refusal like step 5.

- [ ] **Step 7: Wire the three deps construction sites**

- `app/src/worker.ts` (~:244) - add `unitsRepo: createUnitsRepo({ logger })` to the
  tour-reminder deps literal. Import lazily, matching the surrounding style.
- `app/src/routes/dev.ts:241` - add `unitsRepo` to `tourReminderDeps`. THIS IS THE
  PATH EVERY E2E REMINDER ASSERTION RUNS THROUGH; an unwired dev tick silently
  strips the address from every e2e body in Task 11.
- `app/src/routes/tourReminders.ts:140` - add `unitsRepo` to `pollerDeps`, sourced
  from a new optional `deps.unitsRepo` with a `createUnitsRepo` fallback, matching
  its siblings.
- `app/test/tourReminders.test.ts:107` - add `unitsRepo` to the single `runDeps`
  literal (the seven spreads inherit it).

- [ ] **Step 8: Run the containment test and the full suite**

Run: `cd app && npx vitest run test/tourReminders.test.ts`
Expected: PASS, including the new containment test.

Run: `cd app && npx vitest run`
Expected: PASS - bodies are unchanged, so no expectation churn.

- [ ] **Step 9: Typecheck, ASCII, commit**

`npm run typecheck` BARE from the worktree root. If it passes but you did NOT add
`unitsRepo` to `contactTimeline.ts`, that is expected - the cast at
`contactTimeline.ts:613` hides it, and Task 7 handles that router.

Bare `git status`, then commit with message
`refactor(reminders): compose bodies above the claim on all four send paths`
plus the trailer, naming the three reordered sites explicitly.

---

## Task 7: The three preview surfaces

**Files:**
- Modify: `app/src/routes/tourReminders.ts`, `app/src/routes/contactTimeline.ts`
- Test: `app/test/tourRemindersApi.test.ts`, `app/test/contactTimeline.test.ts`

**W2 - the highest-risk line in this change:** `contactTimeline.ts:613` builds
`{ conversationsRepo } as unknown as RunDueTourRemindersDeps`. That cast SILENTLY
SWALLOWS the `unitsRepo` field Task 6 made required, so typecheck will NOT flag
the one router that most needs the unit read. You must add it by hand.

- [ ] **Step 1: Write the failing parity test**

READ THE SUITE'S SEAMS FIRST. `app/test/tourRemindersApi.test.ts` builds its app
through `makeWebhookHarness` -> `buildApp` with in-memory fakes: no DynamoDB, no
network, and NO dev router (the `__dev` routes are opt-in and this suite never
mounts them). So there is no `POST /__dev/tour-reminders/tick` and no
`GET /__dev/outbox` to call.

Use what the suite actually has:
- `authed(app)` (`:34-44`) wraps every request with `x-origin-verify` and
  `TEST_SESSION_COOKIE`. A bare `request(app)` is REJECTED.
- `makeSendSpy()` (`:46-58`) is the send-observation seam - it records
  `SendMessageInput[]` on `.sent`.
- Drive the send by calling `runDueTourReminders(now, deps)` DIRECTLY with the
  suite's deps, rather than through an HTTP tick that does not exist here.

```ts
  it('the GET preview body EQUALS what the send path composes', async () => {
    // W1: the panel renders this string as "what will be sent". If the preview and
    // the send path ever build it differently, the dashboard is lying.
    const spy = makeSendSpy();
    const { app, deps, tourId } = /* the suite's existing setup, wired with spy.service */;

    const listed = await authed(app).get(`/api/tours/${tourId}/reminders`);
    const preview = listed.body.reminders.find(
      (r: { kind: string; state: string }) => r.kind === 'confirmation' && r.state === 'upcoming',
    );
    expect(preview).toBeDefined();

    await runDueTourReminders(preview.dueAt, deps);

    expect(spy.sent.at(-1)?.body).toBe(preview.body);
  });
```

Fill the setup line from the suite's existing pattern - do NOT introduce a new
harness, and do NOT add the dev router to this suite just to make an HTTP tick
work.

- [ ] **Step 2: Run it and confirm it fails or is inconclusive**

Run: `cd app && npx vitest run test/tourRemindersApi.test.ts -t "EQUALS what the send path"`
At this stage bodies are identical everywhere, so it may PASS immediately. That is
fine and expected - it is a REGRESSION test that must keep passing through Task 9,
which is when it earns its keep.

- [ ] **Step 3: Rewire the two `routes/tourReminders.ts` sites**

`viewOf` is SYNC and serves four responses (`:209`, `:221`, `:269`, `:280`). The
body needs async unit and settings reads, so resolve it ONCE per request and pass
it IN - never per row inside `viewOf`:

```ts
  const viewOf = (row: TourReminderItem, body: string): TourReminderView => { ... }
```

Each handler computes the tour, the window and the unit address once, composes per
rung with `composeTourReminderBody`, and contains the throw with `body: ''`:

```ts
  const bodyFor = (row: TourReminderItem, tour: TourItem, tz: string, address?: Address | string): string => {
    // A sent rung renders what was actually sent; only pending rungs recompose.
    if (row.sentAt !== undefined && typeof row.sentBody === 'string') return row.sentBody;
    try {
      return composeTourReminderBody({
        kind: row.kind, scheduledAt: tour.scheduledAt ?? '', timezone: tz,
        ...(address !== undefined && { address }),
      });
    } catch (err) {
      if (err instanceof UncomposableReminderError) {
        log.warn({ reminderId: row.reminderId, tourId: tour.tourId, kind: row.kind },
          'tour reminder body uncomposable on a read path - returning an empty body');
        return '';
      }
      throw err;
    }
  };
```

`body: ''` is the SPECIFIED output (spec F1). Do not omit the field: `body` is
required on `TourReminderView`, on the dashboard mirror at
`dashboard/src/api/types.ts:771`, and on `TimelineScheduled`.

The GET handler currently reads the window only inside
`if (tour.tourType === 'self_guided' && hasUpcoming)` at `:324`. Hoist
`readQuietHoursWindow` so EVERY response has a timezone - a `landlord_led` GET and
all four `viewOf` responses read settings zero times today.

Leave the `no-show-checkin-draft` handler on `resolveMessage('tour.no_show_checkin')`
- that rung is token-free (spec D2).

- [ ] **Step 4: Rewire `routes/contactTimeline.ts`**

Add `unitsRepo` to the cast at `:613` (it already exists in the router's deps at
`:102`; `settingsRepo` at `:95`). Replace ``resolveMessage(`tour.${row.kind}`)`` at
`:626` with the same `bodyFor` shape, including the `body: ''` containment.

Cost control: `:597-633` is a `Promise.all` over `toursRepo.listByTenant`, so this
is one unit read PER TOUR per contact-page load. DEDUPLICATE by `unitId` within the
walk (a `Map<string, Promise<UnitItem | undefined>>` is enough). Read the window
ONCE outside the walk.

- [ ] **Step 5: Run both suites**

Run: `cd app && npx vitest run test/tourRemindersApi.test.ts test/contactTimeline.test.ts`
Expected: PASS.

- [ ] **Step 6: Full suite, typecheck, ASCII, commit**

`cd app && npx vitest run`, then `npm run typecheck` BARE from the worktree root.
Bare `git status`, then commit with message
`feat(reminders): all three preview surfaces compose through the shared composer`
plus the trailer, naming the `contactTimeline.ts:613` cast fix explicitly.

---

## Task 8: Sent-rung history, pinned

**Files:**
- Test only: `app/test/tourRemindersApi.test.ts`

Task 7 already implemented the `sentBody` read. This task PROVES the D4 invariant,
which is the whole reason the snapshot exists.

- [ ] **Step 1: Write the failing test**

Same seam constraints as Task 7 Step 1 - `authed()`, no `__dev` routes, drive the
send directly. Reschedule by mutating the WORLD FAKE's tour rather than calling
`PATCH /api/tours/:tourId`, which would additionally require the tour to be in a
reschedulable status - status rules are not what this test is about.

```ts
  it('a SENT rung keeps its original body after the tour is rescheduled', async () => {
    // D4: sent rows survive a reschedule (only PENDING rungs are canceled). Without
    // the snapshot, a read path would recompose them with the NEW time and claim we
    // texted something we never texted - and disagree with the thread.
    const spy = makeSendSpy();
    const { app, deps, world, tourId } = /* the suite's existing setup, wired with spy.service */;

    const listed = await authed(app).get(`/api/tours/${tourId}/reminders`);
    const target = listed.body.reminders.find(
      (r: { kind: string; state: string }) => r.kind === 'confirmation' && r.state === 'upcoming',
    );
    await runDueTourReminders(target.dueAt, deps);

    const afterSend = await authed(app).get(`/api/tours/${tourId}/reminders`);
    const sentBefore = afterSend.body.reminders.find(
      (r: { reminderId: string }) => r.reminderId === target.reminderId,
    );
    expect(sentBefore.state).toBe('sent');

    // Reschedule on the fake directly - no status gate, no HTTP.
    await world.toursRepo.patch(tourId, { scheduledAt: '2026-12-01T20:00:00.000Z' });

    const afterReschedule = await authed(app).get(`/api/tours/${tourId}/reminders`);
    const sentAfter = afterReschedule.body.reminders.find(
      (r: { reminderId: string }) => r.reminderId === target.reminderId,
    );
    expect(sentAfter.body).toBe(sentBefore.body);
  });
```

- [ ] **Step 2: Run it**

Run: `cd app && npx vitest run test/tourRemindersApi.test.ts -t "keeps its original body"`
Expected: PASS (Task 7 implemented it). If it FAILS, the `sentBody` read path is
wrong - fix it in `routes/tourReminders.ts`, not here.

At this stage bodies are still identical before and after, so this test cannot yet
distinguish snapshot from recompose. It becomes meaningful in Task 9; keep it.

- [ ] **Step 3: ASCII check and commit**

Bare `git status`, commit the test file with message
`test(reminders): pin that a sent rung's body survives a reschedule` plus the trailer.

---

## Task 9: Flip the copy

The only behavioral copy change in this plan. Everything before it was scaffolding.

**Files:**
- Modify: `app/src/messages/catalog.ts`, `app/src/messages/tourCopy.ts`
- Modify: `app/test/messages/resolve.test.ts`, `app/test/contactTimeline.test.ts`,
  `app/test/devGating.test.ts`, `app/test/relayApi.test.ts`
- Test: `app/test/tourCopy.test.ts`

- [ ] **Step 1: Write the failing test**

REPLACE the behavior-neutral block in `app/test/tourCopy.test.ts` with the real
expectations, and ADD the boundary pair:

```ts
describe('composeTourReminderBody: rendered copy', () => {
  const addr = '412 Oak St Apt 2';

  it('confirmation names the address and the full date-time', () => {
    expect(composeTourReminderBody({ ...base, kind: 'confirmation', address: addr }))
      .toBe("Tour confirmed at 412 Oak St Apt 2 for Thu, Jul 23 at 3:00 PM. We'll text reminders as it gets closer.");
  });

  it('day_before says tomorrow AND the explicit date', () => {
    expect(composeTourReminderBody({ ...base, kind: 'day_before', address: addr }))
      .toBe('Reminder: tour at 412 Oak St Apt 2 is tomorrow, Thu, Jul 23 at 3:00 PM.');
  });

  it('morning_of uses the bare time', () => {
    expect(composeTourReminderBody({ ...base, kind: 'morning_of', address: addr }))
      .toBe('Good morning! Tour at 412 Oak St Apt 2 is today at 3:00 PM.');
  });

  it('en_route keeps its tenant-facing closing line', () => {
    expect(composeTourReminderBody({ ...base, kind: 'en_route', address: addr }))
      .toBe("Tour at 412 Oak St Apt 2 starts at 3:00 PM. Text us when you're on the way!");
  });

  it('no_show_checkin is untouched and token-free', () => {
    expect(composeTourReminderBody({ ...base, kind: 'no_show_checkin', address: addr }))
      .toBe('Hi! We noticed you may have missed your tour. Want to reschedule?');
  });
});

describe('composeTourReminderBody: the no-address variants', () => {
  it('drops the address clause cleanly - no double spaces, no stray {where}', () => {
    expect(composeTourReminderBody({ ...base, kind: 'confirmation' }))
      .toBe("Tour confirmed for Thu, Jul 23 at 3:00 PM. We'll text reminders as it gets closer.");
    expect(composeTourReminderBody({ ...base, kind: 'day_before' }))
      .toBe('Reminder: tour is tomorrow, Thu, Jul 23 at 3:00 PM.');
    expect(composeTourReminderBody({ ...base, kind: 'morning_of' }))
      .toBe('Good morning! Tour is today at 3:00 PM.');
    expect(composeTourReminderBody({ ...base, kind: 'en_route' }))
      .toBe("Tour starts at 3:00 PM. Text us when you're on the way!");
  });

  it('an all-empty structured address takes the no-address path', () => {
    expect(composeTourReminderBody({ ...base, kind: 'morning_of', address: {} }))
      .toBe('Good morning! Tour is today at 3:00 PM.');
  });

  it('a structured address contributes street only', () => {
    expect(composeTourReminderBody({
      ...base, kind: 'morning_of',
      address: { line1: '412 Oak St', line2: 'Apt 2', city: 'Atlanta', state: 'GA', zip: '30312' },
    })).toBe('Good morning! Tour at 412 Oak St Apt 2 is today at 3:00 PM.');
  });

  it('a legacy string address passes through whole (D5 - what every seed looks like)', () => {
    expect(composeTourReminderBody({
      ...base, kind: 'morning_of', address: '350 Boulevard SE, Atlanta, GA 30312',
    })).toBe('Good morning! Tour at 350 Boulevard SE, Atlanta, GA 30312 is today at 3:00 PM.');
  });
});

describe('the ASCII boundary, pinned from BOTH sides (spec D6)', () => {
  it('OUR copy is ASCII and single-segment with the seeded address', () => {
    const NON_ASCII = /[^\x20-\x7e]/;
    for (const kind of ['confirmation', 'day_before', 'morning_of', 'en_route'] as const) {
      const body = composeTourReminderBody({
        ...base, kind, address: '350 Boulevard SE, Atlanta, GA 30312',
      });
      expect(body).not.toMatch(NON_ASCII);
      expect(analyzeSms(body).segments).toBe(1);
    }
  });

  it("THEIR data is NEVER sanitized - a non-ASCII address survives UNCHANGED", () => {
    // This is an anti-regression test against a future "helpful" normalizer.
    // Rewriting a landlord's address is the same category of mistake as stripping
    // the accent from a tenant named Jose. We accept the UCS-2 cost instead.
    const street = "O\u2019Brien Court caf\u00E9";
    const body = composeTourReminderBody({ ...base, kind: 'morning_of', address: street });
    expect(body).toContain(street);
    expect(analyzeSms(body).encoding).toBe('UCS-2');
  });
});
```

Add `import { analyzeSms } from '../src/lib/smsEncoding.js';` at the top.

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd app && npx vitest run test/tourCopy.test.ts`
Expected: FAIL - the composer still returns the old copy.

- [ ] **Step 3: Retemplate the four entries and add four variants**

In `app/src/messages/catalog.ts`, add the four new ids to the `MessageId` union
beside their siblings, then set all eight defaults:

```
tour.confirmation             Tour confirmed at {where} for {when}. We'll text reminders as it gets closer.
tour.confirmation_no_address  Tour confirmed for {when}. We'll text reminders as it gets closer.
tour.day_before               Reminder: tour at {where} is tomorrow, {when}.
tour.day_before_no_address    Reminder: tour is tomorrow, {when}.
tour.morning_of               Good morning! Tour at {where} is today at {time}.
tour.morning_of_no_address    Good morning! Tour is today at {time}.
tour.en_route                 Tour at {where} starts at {time}. Text us when you're on the way!
tour.en_route_no_address      Tour starts at {time}. Text us when you're on the way!
```

Address-bearing entries get `vars: ['when', 'time', 'where']`; `_no_address`
entries get `vars: ['when', 'time']`. Every entry keeps `class: 'operational'`,
`editable: true`, `channel: 'sms'`.

Add this comment above the tour block (spec N8 - a documented gap, deliberately
not "fixed"):

```ts
  // TOKEN CONTRACT. Address-bearing entries accept {when} {time} {where}; the
  // _no_address twins accept {when} {time} ONLY. interpolate() iterates over the
  // DECLARED vars, so a token that is not declared is never inspected - an
  // override of a _no_address entry containing {where} would emit that text
  // literally. Declaring {where} on the twins would suppress it only by always
  // passing a string, which reopens the hole the split exists to close (spec D7).
  // Unreachable today regardless: settingsToOverrides maps only welcome.sms and
  // missed_call.autotext, so no tour.* override can exist.
```

- [ ] **Step 4: Make the composer select and interpolate**

Replace the three `void` lines and the final `resolveMessage` in
`app/src/messages/tourCopy.ts`:

```ts
  const street = formatStreet(address);
  const date = formatLocalDate(scheduledAt, timezone);
  const time = formatLocalTime(scheduledAt, timezone);

  const id: MessageId = street.length > 0
    ? (`tour.${kind}` as MessageId)
    : (`tour.${kind}_no_address` as MessageId);

  return resolveMessage(
    id,
    { when: `${date} at ${time}`, time, ...(street.length > 0 && { where: street }) },
    overrides,
  );
```

- [ ] **Step 5: Run the composer test**

Run: `cd app && npx vitest run test/tourCopy.test.ts`
Expected: PASS.

- [ ] **Step 6: Fix the four known-broken suites**

Run: `cd app && npx vitest run` and expect these, all caused by the copy change:

- `app/test/messages/resolve.test.ts:21` - uses `tour.day_before` as its
  TOKEN-FREE example, which now throws. Switch it to a genuinely token-free
  editable entry such as `relay.group_closed`.
- `app/test/contactTimeline.test.ts:673-674` - `resolveMessage('tour.confirmation')`
  at MODULE SCOPE, so the whole file fails to load. Replace with
  `composeTourReminderBody({...})` using the fixture's tour time, zone and address.
- `app/test/devGating.test.ts:263-264` - identical module-scope problem, same fix.
- `app/test/relayApi.test.ts:1335` - `toContain('Your tour is confirmed')`. The new
  copy is `Tour confirmed at ...`; update the expectation.

- [ ] **Step 7: Full suite green**

Run: `cd app && npx vitest run`
Expected: PASS. The Task 7 parity test and the Task 8 history test now carry real
weight - if either fails, a preview surface is composing differently from the send
path, or a sent rung is being recomposed. Fix the surface, never the test.

- [ ] **Step 8: Typecheck, ASCII, commit**

`npm run typecheck` BARE. `tr` checks on the catalog and the composer (added lines).
Bare `git status`, then commit with message
`feat(reminders): tour texts carry the tour time and the unit address` plus the
trailer, noting the eight-entry split and that no_show_checkin is unchanged.

---

## Task 10: The dashboard renders in the composing timezone

**Files:**
- Modify: `dashboard/src/routes/placements/placementsFormat.ts`,
  `dashboard/src/api/types.ts`,
  `dashboard/src/routes/tours/RemindersPanel.tsx`,
  `dashboard/src/routes/contact/ScheduledCard.tsx`
- Modify (app): `app/src/routes/tourReminders.ts`, `app/src/routes/contactTimeline.ts`
  - add `timezone` to both responses
- Test: `dashboard/src/routes/placements/placementsFormat.test.ts` (extend/create)

**Why (spec D8):** `dateTime` calls `toLocaleString` with NO `timeZone`, i.e. the
browser's. Once a body carries an org-local time, staff outside America/New_York
see a chip and a body that disagree. Before this change no disagreement was
possible, so this change introduces the defect and must fix it.

**Constraint (spec N4):** `dateTime` has FIVE consumers - `ScheduledCard`,
`RemindersPanel`, `DeadlinesNudgesCard`, `PlacementNowCard`, `TourDetail`.
Re-zoning it in place would silently move every placement and activity timestamp.
The parameter MUST be additive and optional. `sendRelative` is purely relative and
therefore zone-independent - do NOT touch it.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { dateTime } from './placementsFormat.js';

describe('dateTime timeZone parameter', () => {
  const iso = '2026-07-23T19:00:00.000Z';

  it('renders in an explicitly supplied zone', () => {
    expect(dateTime(iso, 'America/New_York')).toBe('Jul 23, 3:00 PM');
    expect(dateTime(iso, 'America/Los_Angeles')).toBe('Jul 23, 12:00 PM');
  });

  it('OMITTING the parameter is byte-identical to the previous behavior', () => {
    // This is what proves DeadlinesNudgesCard / PlacementNowCard / TourDetail are
    // untouched by this change.
    const legacy = new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
    expect(dateTime(iso)).toBe(legacy);
  });

  it('still falls back to the normalized string when unparseable', () => {
    expect(dateTime('not-a-date', 'America/New_York')).toBe('not-a-date');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd dashboard && npx vitest run src/routes/placements/placementsFormat.test.ts`
Expected: FAIL - `dateTime` takes one argument.

- [ ] **Step 3: Add the optional parameter**

```ts
export function dateTime(iso: string, timeZone?: string): string {
  const norm = isoOf(iso);
  const d = new Date(norm);
  if (Number.isNaN(d.getTime())) return norm;
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone !== undefined && { timeZone }),
  });
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `cd dashboard && npx vitest run src/routes/placements/placementsFormat.test.ts`
Expected: PASS.

- [ ] **Step 5: Put `timezone` on both wire types and both responses**

In `dashboard/src/api/types.ts`:
- add `'invalid_schedule'` to the `skipReason` union at `:764`;
- add `invalid_schedule: 'schedule unusable'` to `REMINDER_SKIP_REASON_LABELS` at
  `:806-815` (both are exhaustive, so typecheck fails loudly if either is missed);
- add `timezone: string` to the reminders-LIST response type and to the contact
  timeline response type - the IANA zone the bodies were composed in;
- add the send-now copy line Task 6 Step 5 deferred here:
  `invalid_schedule: 'That tour has no usable date and time, so nothing was sent.'`
  NOTE: unlike the two declarations above, `SEND_NOW_ERROR_COPY` is keyed by plain
  `string`, so typecheck will NOT force this. Nothing but this instruction will
  catch it.

In `app/src/routes/tourReminders.ts` and `app/src/routes/contactTimeline.ts`,
include `timezone: window.timezone` in the JSON. Both already have the window in
hand after Task 7.

SCOPE OF `timezone` ON THE WIRE: it lands on the reminders-LIST response and the
timeline response only - NOT on the PATCH / send-now `{ reminder }` payloads,
which return a single row. That is deliberate and fine because the panel holds the
list's zone in component state and re-uses it when re-rendering a patched row.
Make sure the component reads the zone from that state, NOT from the patch
response, or it will format a chip from `undefined` and silently fall back to the
browser zone - reintroducing exactly the mismatch this task exists to fix.

- [ ] **Step 6: Use it in both components**

- `RemindersPanel.tsx:79` and `:103` - pass the response `timezone` into `dateTime`.
  Leave `sendRelative` alone.
- `ScheduledCard.tsx:37` - same, threading the timeline response's `timezone` down.

- [ ] **Step 7: Run the dashboard suite**

Run: `cd dashboard && npx vitest run`
Expected: PASS.

- [ ] **Step 8: Typecheck, ASCII, commit**

`npm run typecheck` BARE from the worktree root. Bare `git status`, then commit
with message `feat(dashboard): render reminder times in the composing timezone`
plus the trailer, noting that `dateTime`'s new parameter is additive and its
default is pinned byte-identical.

---

## Task 11: The mechanical call-site guard

Placed AFTER the flip so it locks in a state that already holds. The missed
seventh site is exactly what this test would have caught.

**Files:**
- Create: `app/test/tourCopyCallSites.test.ts`

- [ ] **Step 1: Write the test**

```ts
// The structural defense for W1. Nothing at the TYPE level ties "this catalog id
// declares tokens" to "this call site supplies them" - resolveMessage(id) is valid
// TypeScript for every id - so a new call site that forgets the composer fails
// OPEN into a runtime 500 rather than a typecheck error.
//
// That is not hypothetical: the contact-timeline site was missed during design and
// would have 500'd GET /api/contacts/:id/timeline for any tenant with an upcoming
// tour rung.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// path.dirname(fileURLToPath(...)), NOT new URL(...).pathname - on win32 the
// latter yields "/W:/tmp/..." with a leading slash and readdirSync throws ENOENT.
// This is the idiom every tree-walking test in this repo already uses
// (lane.test.ts:27, otel.test.ts:18, scaffold.test.ts:9).
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
/** The ONE module allowed to resolve a tokenized tour.* id. */
const COMPOSER = join('messages', 'tourCopy.ts');
/** Token-free by design (spec D2), so direct resolution stays legal. */
const ALLOWED_DIRECT = 'tour.no_show_checkin';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

describe('only tourCopy.ts may resolve a tokenized tour.* message', () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    if (file.endsWith(COMPOSER)) continue;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/resolveMessage\(\s*[`'"]?(tour\.[A-Za-z_.${}]*)/g)) {
      const id = m[1] ?? '';
      if (id === ALLOWED_DIRECT) continue;
      offenders.push(`${file}: ${id}`);
    }
  }

  it('has no direct tour.* resolution outside the composer', () => {
    expect(offenders, `use composeTourReminderBody instead:\n${offenders.join('\n')}`).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it**

Run: `cd app && npx vitest run test/tourCopyCallSites.test.ts`
Expected: PASS. If it reports an offender, that site was missed in Task 6 or 7 -
fix the SITE, never the test's allow-list.

- [ ] **Step 3: Prove the test actually bites**

Temporarily add ``const x = resolveMessage(`tour.morning_of`);`` to any file under
`app/src`, re-run, and confirm it FAILS naming that file. Then REVERT the temporary
line. A guard nobody has seen fail is not a guard.

- [ ] **Step 4: ASCII check and commit**

Bare `git status`, commit with message
`test(reminders): forbid direct tour.* resolution outside the composer` plus the trailer.

---

## Task 12: e2e harness and specs

**Files:**
- Modify: `e2e/scenarios/steps.ts`
- Modify: `e2e/tests/scenarios/tours.spec.ts`,
  `e2e/tests/scenarios/scheduled-visibility.spec.ts`,
  `e2e/tests/scenarios/quiet-hours.spec.ts`

**The problem (spec section 8):** `steps.ts:131-136` derives
`TOUR_REMINDER_BODIES` from `MESSAGE_CATALOG[...].default`, which after Task 9
literally contains `{when}`. THREE helpers consume it and they do NOT all assert
the same way:
- `:1801` and `:1839` compare against the fake-provider OUTBOX (`m.body === body`
  at `:1811` and `:1848`) - `expectReminderInGroup`, `expectReminderTo1to1`.
- `:1827` (`expectReminderVisibleInGroupThread`) asserts `getByText(body)` against
  the DASHBOARD group thread. A DOM text match, not an outbox match - it fails
  differently and is the easiest of the three to miss.

- [ ] **Step 1: Replace the constant with a composer call**

`steps.ts` already imports `MESSAGE_CATALOG` cross-workspace, so importing
`composeTourReminderBody` needs no new plumbing. Replace `TOUR_REMINDER_BODIES`
with a function taking the fixture's tour context:

```ts
/** Rung bodies composed by the APP's own composer (the single source of truth),
 *  so exact-equality assertions survive a copy change. */
export function tourReminderBody(
  kind: ReminderKind,
  ctx: { scheduledAt: string; timezone: string; address?: string },
): string {
  return composeTourReminderBody({
    kind,
    scheduledAt: ctx.scheduledAt,
    timezone: ctx.timezone,
    ...(ctx.address !== undefined && { address: ctx.address }),
  });
}
```

- [ ] **Step 2: Thread the tour context into all three helpers**

Each of `:1801`, `:1827` and `:1839` must obtain the seeded tour's `scheduledAt`
and the seeded unit's address. Take them from the same fixture the step already
uses to find the tour; do NOT hardcode a date. The org timezone is
`America/New_York` (`DEFAULT_ORG_SETTINGS`).

Where a step genuinely lacks the tour context, assert a kind-distinctive substring
instead - `'is tomorrow,'` for `day_before`, `'is today at'` for `morning_of` -
and add a comment saying why exact equality was not available there.

- [ ] **Step 3: Update the three in-repo consumer specs**

`tours.spec.ts`, `scheduled-visibility.spec.ts`, `quiet-hours.spec.ts`. A fourth
consumer, `e2e/tests/dashboard-next/tour-comms-pane.spec.ts`, lives on the
UNMERGED `feat/contact-comms-pane` branch (W4) - it does NOT exist in this
worktree. Do not create it; note it in the handback as a merge-time reconciliation.

- [ ] **Step 4: Warm containers, then run the full e2e suite**

```bash
npm run db:start
npm run s3:start
timeout 1500 npm run e2e
```
BARE, from the worktree root. Expected: PASS.

`tour-reminders-panel-e2e-flake` is a KNOWN flake (`docs/issues/`). If it fails,
re-run the full suite before blaming the change, and report BOTH runs.

- [ ] **Step 5: ASCII check and commit**

Bare `git status`, commit the e2e files with message
`test(e2e): compose expected reminder bodies from the app composer` plus the trailer.

---

## Task 13: Close-out

**Files:**
- Modify: `docs/issues/sms-copy-non-gsm7-characters.md`
- Create: `docs/issues/seed-addresses-unstructured.md`
- Modify: `documentation/GLOSSARY.md` (only if a new domain noun was introduced -
  it was not, so verify and skip)
- Modify: the feature's memory topic file and its `MEMORY.md` index line

- [ ] **Step 1: Narrow the folded-in issue**

In `docs/issues/sms-copy-non-gsm7-characters.md`, record what shipped (the
`analyzeSms` helper, the catalog ASCII test, the three em-dash fixes) and narrow
the remaining scope to the deferred Settings-UI encoding/segment advisory. Keep
`status: open`.

- [ ] **Step 2: File the seed-address follow-up (spec section 10, item 1)**

Copy `docs/issues/_TEMPLATE.md` to `docs/issues/seed-addresses-unstructured.md`.
Record: `cast.ts`, `lean.ts` and `matrix.ts` store plain-string addresses including
city/state/zip, so reminder copy reads `Tour at 350 Boulevard SE, Atlanta, GA
30312 is today at 3:00 PM` in every demo and across the whole e2e suite. Converting
them touches the byte-stable `lean` profile the e2e goldens depend on, which is why
it was deferred. `type: improvement`, `severity: low`, `area: app`.

`docs/issues/automated-sms-length-guard.md` is ALREADY FILED on `main`
(commits `ee82772a` + `354c6f33`) but is NOT in this worktree - the branch was cut
from `ed75d9e8`, before it. It arrives with the `git merge main` in Step 4.

So: do NOT re-file it now (you would create a conflicting duplicate). AFTER Step
4's merge, VERIFY it is present:

```bash
ls docs/issues/automated-sms-length-guard.md
```

If the merge did not bring it in, THEN file it - D9 accepts unbounded
multi-segment texts specifically because that guard is tracked somewhere, and
losing the issue silently deletes the only record of the deferral.

- [ ] **Step 3: Run the derived index and ASCII-check the new issue**

```bash
npm run issues
tr -d '\11\12\15\40-\176' < docs/issues/seed-addresses-unstructured.md | wc -c
```
`INDEX.md` is gitignored and derived - never hand-edit it, never commit it.

- [ ] **Step 4: Sync `main` ONCE, then re-run all three gates**

```bash
git merge main
```
Resolve conflicts keeping BOTH sides' intent. Then, BARE, from the worktree root:

```bash
npm run typecheck
npm test
timeout 1500 npm run e2e
```

Green only counts against current `main`. If `feat/contact-comms-pane` has landed,
expect to reconcile `e2e/tests/dashboard-next/tour-comms-pane.spec.ts` here (W4).

- [ ] **Step 5: Refresh memory and commit**

Update the feature's memory topic file and its one-line `MEMORY.md` index entry
(tight - mind the index size budget). Bare `git status`, then commit the docs and
issue files with message `docs: close out tour-reminder-details` plus the trailer.

- [ ] **Step 6: Write the handback**

`<worktree>/.superpowers/sdd/handback.md`: per-spec-item status, the three quoted
gate exit codes from the FINAL commit, owed post-merge ops (expected: NONE - no
schema migration, no infra, no new dependency; `sentBody` is an optional attribute
on an existing table), and the W4 merge-time note about `tour-comms-pane.spec.ts`.

---

## Self-Review

**Spec coverage.** D1 -> Task 9 copy. D2 -> Task 9 step 1 (`no_show_checkin`
unchanged) and Task 4's early return. D3 -> Task 9 `en_route` string. D4 -> Tasks
5, 6, 7, 8. D5 -> Task 3 and Task 9's legacy-string test. D6 -> Tasks 1 and 9's
two-sided boundary pair. D7 -> Task 9's eight entries and token contract comment.
D8 -> Task 10. D9 (no cap) -> nothing to build, correctly. Section 6's seven sites
-> Tasks 6, 7, 11. Section 7 -> Task 1. Section 8's regression list -> Task 9 step
6 and Task 12. W1 -> Tasks 7, 11. W2 -> Task 7 step 4. W4 -> Tasks 12, 13. W6 ->
Task 6's reorder table. W7 -> Task 7's `body: ''`. Section 10 follow-ups -> Task 13.

**Placeholders.** None. Every code step carries real code; every run step names a
command and an expected result.

**Type consistency.** `composeTourReminderBody` / `ComposeTourReminderInput` /
`UncomposableReminderError` are named identically in Tasks 4, 6, 7, 9 and 12.
`claimSend(reminderId, claimedAt, sentBody?)` matches between Tasks 5 and 6.
`formatStreet` matches between Tasks 3, 4 and 9. `analyzeSms` matches between
Tasks 1 and 9. `dateTime(iso, timeZone?)` matches between Tasks 10's steps.

**Known ordering hazard.** Tasks 4-8 are deliberately behavior-neutral; a builder
who "helpfully" flips the copy early will produce a large red window and lose the
ability to tell a wiring bug from a copy-expectation change. Task 4's comment and
the plan header both say so.

**Environment and harness assumptions, verified rather than assumed** (a second
review caught each of these as a plan-stopper):
- The worktree has NO `node_modules` - Task 0 installs before anything runs.
- `tourRemindersApi.test.ts` mounts NO dev router and rejects unauthenticated
  requests. Tasks 7 and 8 use its real seams (`authed()`, `makeSendSpy()`, a
  direct `runDueTourReminders` call), never `__dev` HTTP or bare `request(app)`.
- `toursRepo` exposes `patch`, not `update` (Task 6).
- `forceSendReminder` has no quiet-hours window and must read its own (Task 6
  Step 5) - the natural improvisation, reading `settings.timezone` directly, is
  exactly what D8/W5 forbid.
- `new URL(..).pathname` is broken on win32; Task 11 uses the repo's
  `fileURLToPath` idiom.
- `automated-sms-length-guard` exists on `main` but NOT in this worktree until the
  Task 13 merge - verify post-merge, do not re-file.
- `SEND_NOW_ERROR_COPY` is keyed by plain `string`, so unlike the two `skipReason`
  declarations it gives NO typecheck protection for the new refusal code.
