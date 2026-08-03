# Quiet Hours + Send Now Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No automated SMS ever sends during the org's quiet hours (default 21:00-08:00 America/New_York); scheduled reminder/nudge rows carry honest, pre-clamped dueAts; staff can force-send any pending reminder/nudge immediately.

**Architecture:** A pure `quietHours` lib module (Intl-based, no new deps) feeds (1) arm-time clamping in `armTourReminders`/`armNudgeForStage` so stored dueAts already avoid the window, with a supersession rule that retires rungs whose copy would go stale, and (2) a pre-claim fire-time backstop in both worker pollers for legacy rows and catch-up. Settings live on the existing `OrgSettings` singleton with a Settings-UI section; Send-now endpoints reuse the pollers' claim-and-send path with `automated: false` semantics.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), Express, DynamoDB (lib-dynamodb), Vitest, React dashboard, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-08-03-quiet-hours-design.md` - read it first; it is the contract.

## Global Constraints

- `npm run typecheck` + `npm test` + `npm run e2e` must all pass; typecheck is a REQUIRED gate (tests run through esbuild and do NOT type-check).
- Gate commands run BARE (never piped); e2e only via the root npm scripts.
- No new npm dependencies. Timezone math uses `Intl.DateTimeFormat` only.
- No inline `Date.now()` / `new Date()` in job/lib logic - time comes in as a parameter (`now`/`nowIso`), matching the codebase discipline.
- ISO timestamps are compared lexicographically; every stored/compared timestamp must be normalized via `new Date(x).toISOString()`.
- NEVER implement quiet hours as a `SendRefusedError` after `claimSend` - refusals keep the claim and would permanently destroy the message. All new gates run PRE-claim.
- PII: never log a phone number, name, or body. IDs/kinds/counts only.
- Exempt paths (missed-call auto-text, relay fan-out of member texts, public-intake welcome, STOP/HELP, cell verification) and human-triggered paths (composer, broadcasts, relay announcements) are NOT touched by this plan. Do not add gates to them.
- Dashboard mirrors backend types by hand: any `OrgSettings` change edits BOTH `app/src/repos/settingsRepo.ts` and `dashboard/src/api/types.ts`.
- Commit discipline: run `git status` (bare, separate command) before every commit; commit by explicit pathspec (`git commit -m "..." -- <paths>`).
- All files ASCII-only.

---

### Task 1: Core quietHours module

**Files:**
- Create: `app/src/lib/quietHours.ts`
- Test: `app/test/quietHours.test.ts`

**Interfaces:**
- Consumes: nothing (pure module; structural types only - deliberately does NOT import from repos).
- Produces (later tasks rely on these exact names):

```typescript
export interface QuietHoursWindow {
  enabled: boolean;
  start: string;    // "HH:MM" 24h wall clock
  end: string;      // "HH:MM" 24h wall clock
  timezone: string; // IANA zone id
}
export function quietHoursWindowOf(settings: {
  quietHoursEnabled: boolean; quietHoursStart: string;
  quietHoursEnd: string; timezone: string;
}): QuietHoursWindow;
export function resolveQuietHoursTimezone(settings: { timezone: string }, _contact?: unknown): string;
export function isQuietTime(nowIso: string, window: QuietHoursWindow): boolean;
export function clampOutOfQuietHours(dueIso: string, window: QuietHoursWindow): string;
export function localDateOf(iso: string, timezone: string): string; // "YYYY-MM-DD"
export function instantAtLocalTime(localDate: string, hhmm: string, timezone: string): string; // ISO
export function isValidHhMm(v: string): boolean;
export function isValidIanaTimezone(v: string): boolean;
```

- [ ] **Step 1: Write the failing tests**

Create `app/test/quietHours.test.ts`. Fixed dates; America/New_York is UTC-5 (EST) in January, UTC-4 (EDT) in July; in 2026 DST springs forward Mar 8 and falls back Nov 1.

```typescript
import { describe, expect, it } from 'vitest';
import {
  clampOutOfQuietHours,
  instantAtLocalTime,
  isQuietTime,
  isValidHhMm,
  isValidIanaTimezone,
  localDateOf,
  quietHoursWindowOf,
  resolveQuietHoursTimezone,
  type QuietHoursWindow,
} from '../src/lib/quietHours.js';

const NY: QuietHoursWindow = {
  enabled: true, start: '21:00', end: '08:00', timezone: 'America/New_York',
};

describe('isQuietTime (wrapping window, America/New_York)', () => {
  it('21:00 ET exactly is quiet (start-inclusive)', () => {
    // 2026-01-15T02:00Z == Jan 14 21:00 EST
    expect(isQuietTime('2026-01-15T02:00:00.000Z', NY)).toBe(true);
  });
  it('20:59 ET is not quiet', () => {
    expect(isQuietTime('2026-01-15T01:59:00.000Z', NY)).toBe(false);
  });
  it('08:00 ET exactly is NOT quiet (end-exclusive)', () => {
    // 2026-01-15T13:00Z == Jan 15 08:00 EST
    expect(isQuietTime('2026-01-15T13:00:00.000Z', NY)).toBe(false);
  });
  it('07:59 ET is quiet', () => {
    expect(isQuietTime('2026-01-15T12:59:00.000Z', NY)).toBe(true);
  });
  it('4am ET is quiet (the motivating bug)', () => {
    expect(isQuietTime('2026-01-15T09:00:00.000Z', NY)).toBe(true);
  });
  it('noon ET is not quiet', () => {
    expect(isQuietTime('2026-01-15T17:00:00.000Z', NY)).toBe(false);
  });
  it('23:00 ET is quiet even though the UTC date has already rolled over', () => {
    // Jan 15 23:00 EST == 2026-01-16T04:00Z - local date Jan 15, UTC date Jan 16
    expect(isQuietTime('2026-01-16T04:00:00.000Z', NY)).toBe(true);
  });
  it('19:00 ET and 20:01 ET on the SAME UTC date are both not quiet', () => {
    expect(isQuietTime('2026-01-16T00:00:00.000Z', NY)).toBe(false); // 19:00 EST Jan 15
    expect(isQuietTime('2026-01-16T01:01:00.000Z', NY)).toBe(false); // 20:01 EST Jan 15
  });
  it('summer (EDT, UTC-4): 22:00 ET is quiet', () => {
    // 2026-07-15T02:00Z == Jul 14 22:00 EDT
    expect(isQuietTime('2026-07-15T02:00:00.000Z', NY)).toBe(true);
  });
  it('disabled window is never quiet', () => {
    expect(isQuietTime('2026-01-15T09:00:00.000Z', { ...NY, enabled: false })).toBe(false);
  });
  it('non-wrapping window (01:00-05:00) is quiet inside, not outside', () => {
    const w: QuietHoursWindow = { ...NY, start: '01:00', end: '05:00' };
    expect(isQuietTime('2026-01-15T08:00:00.000Z', w)).toBe(true);  // 03:00 EST
    expect(isQuietTime('2026-01-15T15:00:00.000Z', w)).toBe(false); // 10:00 EST
  });
  it('start === end is treated as no window (never quiet)', () => {
    const w: QuietHoursWindow = { ...NY, start: '08:00', end: '08:00' };
    expect(isQuietTime('2026-01-15T09:00:00.000Z', w)).toBe(false);
  });
});

describe('clampOutOfQuietHours', () => {
  it('identity outside the window', () => {
    expect(clampOutOfQuietHours('2026-01-15T17:00:00.000Z', NY))
      .toBe('2026-01-15T17:00:00.000Z');
  });
  it('evening side clamps to 08:00 local NEXT day', () => {
    // Jan 14 22:00 EST -> Jan 15 08:00 EST == 13:00Z
    expect(clampOutOfQuietHours('2026-01-15T03:00:00.000Z', NY))
      .toBe('2026-01-15T13:00:00.000Z');
  });
  it('morning side clamps to 08:00 local SAME day', () => {
    // Jan 15 04:00 EST (09:00Z) -> Jan 15 08:00 EST == 13:00Z
    expect(clampOutOfQuietHours('2026-01-15T09:00:00.000Z', NY))
      .toBe('2026-01-15T13:00:00.000Z');
  });
  it('23:00 ET (UTC date already tomorrow) clamps to 08:00 local the next local day', () => {
    // Jan 15 23:00 EST == Jan 16 04:00Z -> Jan 16 08:00 EST == Jan 16 13:00Z
    expect(clampOutOfQuietHours('2026-01-16T04:00:00.000Z', NY))
      .toBe('2026-01-16T13:00:00.000Z');
  });
  it('summer clamp lands 08:00 EDT (12:00Z)', () => {
    // Jul 14 22:00 EDT (02:00Z Jul 15) -> Jul 15 08:00 EDT == 12:00Z
    expect(clampOutOfQuietHours('2026-07-15T02:00:00.000Z', NY))
      .toBe('2026-07-15T12:00:00.000Z');
  });
  it('spring-forward night (Mar 7->8 2026) clamps to 08:00 EDT', () => {
    // Mar 7 21:30 EST == 02:30Z Mar 8 -> Mar 8 08:00 EDT == 12:00Z
    expect(clampOutOfQuietHours('2026-03-08T02:30:00.000Z', NY))
      .toBe('2026-03-08T12:00:00.000Z');
  });
  it('fall-back night (Nov 1 2026): both occurrences of 01:30 clamp to 08:00 EST', () => {
    // 01:30 EDT == 05:30Z and 01:30 EST == 06:30Z; both -> Nov 1 08:00 EST == 13:00Z
    expect(clampOutOfQuietHours('2026-11-01T05:30:00.000Z', NY))
      .toBe('2026-11-01T13:00:00.000Z');
    expect(clampOutOfQuietHours('2026-11-01T06:30:00.000Z', NY))
      .toBe('2026-11-01T13:00:00.000Z');
  });
  it('disabled window is identity', () => {
    expect(clampOutOfQuietHours('2026-01-15T09:00:00.000Z', { ...NY, enabled: false }))
      .toBe('2026-01-15T09:00:00.000Z');
  });
});

describe('helpers', () => {
  it('localDateOf uses the LOCAL date, not the UTC date', () => {
    expect(localDateOf('2026-01-16T04:00:00.000Z', 'America/New_York')).toBe('2026-01-15');
    expect(localDateOf('2026-01-15T17:00:00.000Z', 'America/New_York')).toBe('2026-01-15');
  });
  it('instantAtLocalTime materializes a local wall time as a UTC instant', () => {
    expect(instantAtLocalTime('2026-01-15', '08:00', 'America/New_York'))
      .toBe('2026-01-15T13:00:00.000Z');
    expect(instantAtLocalTime('2026-07-15', '08:00', 'America/New_York'))
      .toBe('2026-07-15T12:00:00.000Z');
  });
  it('quietHoursWindowOf projects settings fields', () => {
    expect(quietHoursWindowOf({
      quietHoursEnabled: true, quietHoursStart: '21:00',
      quietHoursEnd: '08:00', timezone: 'America/New_York',
    })).toEqual(NY);
  });
  it('resolveQuietHoursTimezone returns the org timezone (per-recipient seam)', () => {
    expect(resolveQuietHoursTimezone({ timezone: 'America/New_York' })).toBe('America/New_York');
    expect(resolveQuietHoursTimezone({ timezone: 'America/Chicago' }, { some: 'contact' }))
      .toBe('America/Chicago');
  });
  it('isValidHhMm', () => {
    expect(isValidHhMm('21:00')).toBe(true);
    expect(isValidHhMm('08:05')).toBe(true);
    expect(isValidHhMm('24:00')).toBe(false);
    expect(isValidHhMm('8:00')).toBe(false);
    expect(isValidHhMm('0800')).toBe(false);
    expect(isValidHhMm('')).toBe(false);
  });
  it('isValidIanaTimezone', () => {
    expect(isValidIanaTimezone('America/New_York')).toBe(true);
    expect(isValidIanaTimezone('UTC')).toBe(true);
    expect(isValidIanaTimezone('Not/AZone')).toBe(false);
    expect(isValidIanaTimezone('')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from repo root): `npm test -- quietHours`
Expected: FAIL - module `../src/lib/quietHours.js` does not exist.
(If `npm test -- <filter>` does not forward in this repo, run the app workspace's vitest directly: `cd app` then `npx vitest run test/quietHours.test.ts`.)

- [ ] **Step 3: Implement `app/src/lib/quietHours.ts`**

```typescript
// Quiet-hours core (spec: docs/superpowers/specs/2026-08-03-quiet-hours-design.md).
// Pure functions, structural inputs, no repo imports, no inline clock reads -
// callers pass ISO instants in. Timezone math via Intl.DateTimeFormat only.
//
// Window semantics: start-inclusive, end-exclusive ([21:00, 08:00) local).
// A wrapping window (start > end) wraps LOCAL midnight, never UTC midnight.
// DST: instantAtLocalTime converges via a two-pass offset correction; the
// pollers' pre-claim backstop (jobs/*) is the guarantee that even a wrong
// clamp on a DST night can never SEND inside the window.

export interface QuietHoursWindow {
  enabled: boolean;
  start: string;    // "HH:MM" 24h
  end: string;      // "HH:MM" 24h
  timezone: string; // IANA zone id
}

export function quietHoursWindowOf(settings: {
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  timezone: string;
}): QuietHoursWindow {
  return {
    enabled: settings.quietHoursEnabled,
    start: settings.quietHoursStart,
    end: settings.quietHoursEnd,
    timezone: settings.timezone,
  };
}

/**
 * The per-recipient timezone seam (spec section 4). Today every recipient uses
 * the org timezone; when the org scales beyond one timezone, a contact-level
 * (or client-org-level) timezone field overrides HERE and every call site
 * becomes recipient-local without further change. `_contact` is accepted and
 * ignored on purpose - call sites already thread it where they have one.
 */
export function resolveQuietHoursTimezone(
  settings: { timezone: string },
  _contact?: unknown,
): string {
  return settings.timezone;
}

const HH_MM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidHhMm(v: string): boolean {
  return HH_MM_RE.test(v);
}

export function isValidIanaTimezone(v: string): boolean {
  if (v.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v });
    return true;
  } catch {
    return false;
  }
}

interface LocalParts { y: number; m: number; d: number; hh: number; mm: number }

// One cached formatter per zone - Intl.DateTimeFormat construction is the
// expensive part; formatToParts on a cached instance is cheap.
const formatterCache = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timezone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timezone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
    formatterCache.set(timezone, f);
  }
  return f;
}

function localPartsOf(ms: number, timezone: string): LocalParts {
  const parts = formatterFor(timezone).formatToParts(new Date(ms));
  const num = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    return part === undefined ? 0 : Number(part.value);
  };
  // Some ICU builds render midnight as "24" even with h23 - normalize.
  const hh = num('hour') === 24 ? 0 : num('hour');
  return { y: num('year'), m: num('month'), d: num('day'), hh, mm: num('minute') };
}

function minutesOfDay(p: LocalParts): number {
  return p.hh * 60 + p.mm;
}

function parseHhMm(v: string): number {
  const hh = Number(v.slice(0, 2));
  const mm = Number(v.slice(3, 5));
  return hh * 60 + mm;
}

/**
 * Materialize local wall-clock (y, m, d, hh, mm) in `timezone` as a UTC ms
 * timestamp. Two-pass offset correction: guess the instant as if the wall time
 * were UTC, read back what wall time that instant actually is in the zone, and
 * shift by the difference; a second pass converges across DST boundaries.
 * (Date.UTC handles day overflow, so callers may pass d+1 freely.)
 */
function utcMsForLocal(
  y: number, m: number, d: number, hh: number, mm: number, timezone: string,
): number {
  const target = Date.UTC(y, m - 1, d, hh, mm);
  let ts = target;
  for (let i = 0; i < 2; i += 1) {
    const p = localPartsOf(ts, timezone);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
    ts += target - asUtc;
  }
  return ts;
}

export function localDateOf(iso: string, timezone: string): string {
  const p = localPartsOf(Date.parse(iso), timezone);
  const mm = String(p.m).padStart(2, '0');
  const dd = String(p.d).padStart(2, '0');
  return `${p.y}-${mm}-${dd}`;
}

export function instantAtLocalTime(localDate: string, hhmm: string, timezone: string): string {
  const y = Number(localDate.slice(0, 4));
  const m = Number(localDate.slice(5, 7));
  const d = Number(localDate.slice(8, 10));
  const t = parseHhMm(hhmm);
  return new Date(utcMsForLocal(y, m, d, Math.floor(t / 60), t % 60, timezone)).toISOString();
}

export function isQuietTime(nowIso: string, window: QuietHoursWindow): boolean {
  if (!window.enabled) return false;
  const start = parseHhMm(window.start);
  const end = parseHhMm(window.end);
  if (start === end) return false; // zero-length window - validation rejects it, but be safe
  const now = minutesOfDay(localPartsOf(Date.parse(nowIso), window.timezone));
  return start > end
    ? now >= start || now < end // wraps local midnight (21:00 -> 08:00)
    : now >= start && now < end; // same-day window (01:00 -> 05:00)
}

/**
 * Identity outside the window; inside it, the END of the window containing
 * `due` (e.g. 08:00 local that morning - or the NEXT morning for an
 * evening-side instant of a wrapping window).
 */
export function clampOutOfQuietHours(dueIso: string, window: QuietHoursWindow): string {
  if (!isQuietTime(dueIso, window)) return dueIso;
  const p = localPartsOf(Date.parse(dueIso), window.timezone);
  const start = parseHhMm(window.start);
  const end = parseHhMm(window.end);
  const now = minutesOfDay(p);
  // Wrapping window, evening side: the window ends TOMORROW local.
  const bumpDay = start > end && now >= start ? 1 : 0;
  return new Date(
    utcMsForLocal(p.y, p.m, p.d + bumpDay, Math.floor(end / 60), end % 60, window.timezone),
  ).toISOString();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- quietHours` - Expected: PASS (all cases).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck` - Expected: clean.
Then `git status` (bare), then:

```bash
git add app/src/lib/quietHours.ts app/test/quietHours.test.ts
git commit -m "feat(quiet-hours): pure quiet-hours window module (Intl-based, DST-safe)" -- app/src/lib/quietHours.ts app/test/quietHours.test.ts
```

---

### Task 2: OrgSettings fields + API validation

**Files:**
- Modify: `app/src/repos/settingsRepo.ts` (interface `OrgSettings`, `DEFAULT_ORG_SETTINGS`, `toOrgSettings`)
- Modify: `app/src/routes/settings.ts` (`parsePatch` + merged start/end check in the PUT handler)
- Test: `app/test/settings.test.ts` (extend the existing suite)

**Interfaces:**
- Consumes: `isValidHhMm`, `isValidIanaTimezone` from `app/src/lib/quietHours.ts` (Task 1).
- Produces: `OrgSettings` gains exactly these fields (Tasks 3-8 rely on the names):

```typescript
quietHoursEnabled: boolean;  // default true
quietHoursStart: string;     // "HH:MM", default "21:00"
quietHoursEnd: string;       // "HH:MM", default "08:00"
timezone: string;            // IANA, default "America/New_York"
```

- [ ] **Step 1: Write the failing tests**

Extend `app/test/settings.test.ts`, following that file's existing route-level test pattern (in-memory `SettingsRepo` stub + supertest against `createSettingsRouter`; read the file first and copy its helpers). New cases:

```typescript
// Defaults: GET on a fresh stack returns the quiet-hours defaults.
//   settings.quietHoursEnabled === true
//   settings.quietHoursStart === '21:00'
//   settings.quietHoursEnd === '08:00'
//   settings.timezone === 'America/New_York'

// PUT accepts a valid quiet-hours patch (admin):
//   { quietHoursEnabled: false } -> 200, echoed false
//   { quietHoursStart: '22:00', quietHoursEnd: '07:30' } -> 200, echoed

// PUT rejects malformed values with 400:
//   { quietHoursStart: '9:00' }   -> 400 (not HH:MM)
//   { quietHoursStart: '24:00' }  -> 400
//   { quietHoursEnd: 800 }        -> 400 (not a string)
//   { quietHoursEnabled: 'yes' }  -> 400
//   { timezone: 'Not/AZone' }     -> 400
//   { timezone: '' }              -> 400

// PUT rejects a MERGED start === end with 400 'quiet_hours_zero_length':
//   stored end is '08:00'; PUT { quietHoursStart: '08:00' } -> 400
//   (the check merges the patch over the STORED settings, so a one-field
//   patch cannot sneak a zero-length window in)

// toOrgSettings defensive parsing: a stored item with quietHoursStart: 'garbage'
// projects the DEFAULT '21:00' (test at the repo level if the suite has repo
// tests; else via a stub returning the malformed item).
```

Write them as real `it()` blocks in the existing style.

- [ ] **Step 2: Run to verify the new cases fail**

Run: `npm test -- settings` - Expected: new cases FAIL (fields missing / no validation).

- [ ] **Step 3: Implement**

In `app/src/repos/settingsRepo.ts`:

1. Add to `interface OrgSettings` (after `preRingPauseSeconds`):

```typescript
  /** Quiet hours (spec 2026-08-03): automated sends DEFER during this window. */
  quietHoursEnabled: boolean;
  /** "HH:MM" 24h local wall clock - window start (start-inclusive). */
  quietHoursStart: string;
  /** "HH:MM" 24h local wall clock - window end (end-exclusive). */
  quietHoursEnd: string;
  /** IANA org timezone - the FIRST server-side timezone; also used by the
   *  morning_of tour reminder. Per-recipient override rides the
   *  resolveQuietHoursTimezone seam (lib/quietHours.ts), not extra fields here. */
  timezone: string;
```

2. Add to `DEFAULT_ORG_SETTINGS`:

```typescript
  quietHoursEnabled: true,
  quietHoursStart: '21:00',
  quietHoursEnd: '08:00',
  timezone: 'America/New_York',
```

3. In `toOrgSettings`, project defensively (same posture as `preRingPauseSeconds`), importing `isValidHhMm, isValidIanaTimezone` from `../lib/quietHours.js`:

```typescript
      quietHoursEnabled:
        typeof item?.['quietHoursEnabled'] === 'boolean'
          ? (item['quietHoursEnabled'] as boolean)
          : DEFAULT_ORG_SETTINGS.quietHoursEnabled,
      quietHoursStart:
        typeof item?.['quietHoursStart'] === 'string' && isValidHhMm(item['quietHoursStart'] as string)
          ? (item['quietHoursStart'] as string)
          : DEFAULT_ORG_SETTINGS.quietHoursStart,
      quietHoursEnd:
        typeof item?.['quietHoursEnd'] === 'string' && isValidHhMm(item['quietHoursEnd'] as string)
          ? (item['quietHoursEnd'] as string)
          : DEFAULT_ORG_SETTINGS.quietHoursEnd,
      timezone:
        typeof item?.['timezone'] === 'string' && isValidIanaTimezone(item['timezone'] as string)
          ? (item['timezone'] as string)
          : DEFAULT_ORG_SETTINGS.timezone,
```

In `app/src/routes/settings.ts`:

4. Extend `parsePatch` (import the validators):

```typescript
  if ('quietHoursEnabled' in b) {
    const v = b['quietHoursEnabled'];
    if (typeof v !== 'boolean') return { error: 'quietHoursEnabled must be a boolean' };
    patch.quietHoursEnabled = v;
  }
  if ('quietHoursStart' in b) {
    const v = b['quietHoursStart'];
    if (typeof v !== 'string' || !isValidHhMm(v)) {
      return { error: 'quietHoursStart must be "HH:MM" (24-hour)' };
    }
    patch.quietHoursStart = v;
  }
  if ('quietHoursEnd' in b) {
    const v = b['quietHoursEnd'];
    if (typeof v !== 'string' || !isValidHhMm(v)) {
      return { error: 'quietHoursEnd must be "HH:MM" (24-hour)' };
    }
    patch.quietHoursEnd = v;
  }
  if ('timezone' in b) {
    const v = b['timezone'];
    if (typeof v !== 'string' || !isValidIanaTimezone(v)) {
      return { error: 'timezone must be a valid IANA timezone id' };
    }
    patch.timezone = v;
  }
```

5. In the PUT handler, AFTER `parsePatch` succeeds and BEFORE `putOrgSettings`, reject a merged zero-length window:

```typescript
    if (parsed.patch.quietHoursStart !== undefined || parsed.patch.quietHoursEnd !== undefined) {
      const current = await settings.getOrgSettings();
      const start = parsed.patch.quietHoursStart ?? current.quietHoursStart;
      const end = parsed.patch.quietHoursEnd ?? current.quietHoursEnd;
      if (start === end) {
        res.status(400).json({ error: 'quiet_hours_zero_length' });
        return;
      }
    }
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test -- settings` then `npm run typecheck` - Expected: PASS / clean. (Other suites that assert on `DEFAULT_ORG_SETTINGS` object equality may need the four new fields added to expectations - fix any that fail, they are legitimate mirrors.)

- [ ] **Step 5: Commit**

`git status`, then:

```bash
git add app/src/repos/settingsRepo.ts app/src/routes/settings.ts app/test/settings.test.ts
git commit -m "feat(quiet-hours): org settings fields + API validation" -- app/src/repos/settingsRepo.ts app/src/routes/settings.ts app/test/settings.test.ts
```

---

### Task 3: Arm-time clamping + supersession for tour reminders

**Files:**
- Modify: `app/src/jobs/tourReminders.ts` (`computeDueAt`, `armTourReminders`, `ArmTourRemindersDeps`)
- Modify: `app/src/routes/tours.ts` (both `armTourReminders` call sites, ~lines 295 and 586)
- Modify: `app/src/lib/seed/live.ts` (three `armTourReminders` call sites, ~lines 456-471)
- Test: `app/test/tourReminders.test.ts` (update `morning_of` expectations; add clamp + supersession cases)

**Interfaces:**
- Consumes: Task 1 module; `SettingsRepo`/`DEFAULT_ORG_SETTINGS` from `../repos/settingsRepo.js`.
- Produces: `ArmTourRemindersDeps` gains REQUIRED `settingsRepo: SettingsRepo` (compile errors force every call site to update - that is deliberate). Exports `LADDER_ORDER` for Task 5:

```typescript
export const LADDER_ORDER: ReminderKind[] = [
  'confirmation', 'day_before', 'morning_of', 'en_route', 'no_show_checkin',
];
```

- [ ] **Step 1: Write the failing tests**

In `app/test/tourReminders.test.ts`: first READ the whole file. Update the existing arm tests (`armTourReminders creates all 4 reminder rows with correct dueAts`, `skips day_before when it is in the past`) for the new dep and the new `morning_of` semantics, and add new cases. The existing in-memory repo fixtures stay; add a stub settings repo:

```typescript
const stubSettingsRepo = (over: Partial<OrgSettings> = {}) => ({
  getOrgSettings: async () => ({ ...DEFAULT_ORG_SETTINGS, ...over }),
  putOrgSettings: async () => { throw new Error('unused'); },
});
```

New/updated cases (concrete instants; org tz America/New_York, EST=UTC-5 in January):

```typescript
// UPDATED: morning_of is 08:00 ORG-LOCAL on tour day (was 08:00 UTC).
//   Tour scheduledAt 2026-01-20T20:00:00.000Z (Jan 20 15:00 EST),
//   now 2026-01-19T15:00:00.000Z (Jan 19 10:00 EST - daytime, no clamps):
//   confirmation -> now
//   day_before   -> 2026-01-19T20:00:00.000Z (raw -24h, daytime, unclamped)
//   morning_of   -> 2026-01-20T13:00:00.000Z (08:00 EST tour day)
//   en_route     -> 2026-01-20T18:00:00.000Z (raw -2h, daytime)

// NEW: clamped day_before is SUPERSEDED by morning_of (same slot).
//   Tour Jan 21 03:00:00.000Z == Jan 20 22:00 EST (a 10pm tour);
//   now Jan 19 15:00Z. day_before raw = Jan 20 03:00Z == Jan 19 22:00 EST
//   (quiet) -> clamps to Jan 20 13:00Z, which EQUALS morning_of's slot
//   (08:00 EST on Jan 20... note the tour's LOCAL date is Jan 20, so
//   morning_of = Jan 20 13:00Z). Assert: NO day_before row created;
//   morning_of row exists at 2026-01-20T13:00:00.000Z.

// NEW: en_route clamp collides with morning_of -> only en_route survives.
//   Tour Jan 20 13:30:00.000Z == Jan 20 08:30 EST; now Jan 19 15:00Z.
//   en_route raw = Jan 20 11:30Z == 06:30 EST (quiet) -> clamps to Jan 20
//   13:00Z == morning_of slot. Assert: en_route row at 13:00Z exists,
//   NO morning_of row.

// NEW: confirmation clamps out of evening quiet hours.
//   now = Jan 19 03:00:00.000Z == Jan 18 22:00 EST (staff scheduling late);
//   tour Jan 25 20:00Z. confirmation -> 2026-01-19T13:00:00.000Z (08:00 EST),
//   NOT `now`.

// NEW: past-event clamp skips the rung.
//   Tour Jan 20 12:30:00.000Z == Jan 20 07:30 EST; now Jan 19 15:00Z.
//   morning_of (13:00Z) >= scheduledAt (12:30Z) -> NO morning_of row.
//   en_route raw = Jan 20 10:30Z == 05:30 EST (quiet) -> clamp 13:00Z >=
//   start -> NO en_route row. day_before raw = Jan 19 12:30Z (07:30 EST,
//   quiet) -> clamps to Jan 19 13:00Z; local date Jan 19 != tour local date
//   Jan 20 -> ARMED. Assert: rows are exactly confirmation + day_before.

// NEW: quiet hours disabled -> morning_of still 08:00 org-local, no clamping
//   of evening rungs (day_before at 22:00 EST stays 22:00 EST).

// NEW: settings read failure falls back to defaults (armer still clamps).
//   settingsRepo.getOrgSettings throws -> rows match the DEFAULT-window
//   expectations of the first case above.
```

- [ ] **Step 2: Run to verify failures**

Run: `npm test -- tourReminders` - Expected: FAIL (missing dep, old morning_of).

- [ ] **Step 3: Implement**

In `app/src/jobs/tourReminders.ts`:

1. Imports:

```typescript
import {
  clampOutOfQuietHours,
  instantAtLocalTime,
  isQuietTime,
  localDateOf,
  quietHoursWindowOf,
  resolveQuietHoursTimezone,
  type QuietHoursWindow,
} from '../lib/quietHours.js';
import {
  DEFAULT_ORG_SETTINGS,
  type SettingsRepo,
} from '../repos/settingsRepo.js';
```

2. Export the ladder order (used by supersession here and by Task 5's batch check):

```typescript
/** Ladder order by proximity to the event - supersession keeps the LATEST. */
export const LADDER_ORDER: ReminderKind[] = [
  'confirmation', 'day_before', 'morning_of', 'en_route', 'no_show_checkin',
];
```

3. Add a settings->window helper both arm and poll reuse (defensive read - the `resolveWithSettings` posture: a settings failure must never break arming/sending):

```typescript
/** Read the org quiet-hours window; a settings failure falls back to defaults. */
export async function readQuietHoursWindow(
  settingsRepo: SettingsRepo,
  log: Logger,
): Promise<QuietHoursWindow> {
  try {
    const settings = await settingsRepo.getOrgSettings();
    return quietHoursWindowOf({
      quietHoursEnabled: settings.quietHoursEnabled,
      quietHoursStart: settings.quietHoursStart,
      quietHoursEnd: settings.quietHoursEnd,
      timezone: resolveQuietHoursTimezone(settings),
    });
  } catch (err) {
    log.warn({ err }, 'quiet hours: settings read failed - falling back to defaults');
    return quietHoursWindowOf(DEFAULT_ORG_SETTINGS);
  }
}
```

4. Rewrite `computeDueAt` (keep the same signature shape, add the window; `morning_of` becomes 08:00 org-local):

```typescript
function computeDueAt(
  kind: ReminderKind,
  scheduledAt: string,
  now: string,
  window: QuietHoursWindow,
): string {
  const scheduled = new Date(scheduledAt).getTime();
  switch (kind) {
    case 'confirmation':
      return now; // immediate (clamped by the caller like every rung)
    case 'day_before':
      return new Date(scheduled - 24 * 60 * 60 * 1000).toISOString();
    case 'morning_of':
      // 08:00 ORG-LOCAL on the tour's local day (was 08:00 UTC == 3-4am ET -
      // the motivating 4am-text bug).
      return instantAtLocalTime(localDateOf(scheduledAt, window.timezone), '08:00', window.timezone);
    case 'en_route':
      return new Date(scheduled - 2 * 60 * 60 * 1000).toISOString();
    case 'no_show_checkin':
      return new Date(scheduled + 30 * 60 * 1000).toISOString();
  }
}
```

5. Rewrite the `armTourReminders` loop. `ArmTourRemindersDeps` gains `settingsRepo: SettingsRepo` (required). New body after the `scheduledAt` guard:

```typescript
  const window = await readQuietHoursWindow(deps.settingsRepo, log);
  const scheduledIso = new Date(scheduledAt).toISOString();

  // Pass 1: compute every rung's CLAMPED dueAt (the stored time IS the real
  // send time - the dashboard's honesty depends on it).
  const dues = new Map<ReminderKind, string>();
  for (const kind of REMINDER_KINDS) {
    dues.set(kind, clampOutOfQuietHours(computeDueAt(kind, scheduledAt, now, window), window));
  }

  // Pass 2: arm, applying the spec's skip rules (skips create NO row - the
  // existing past-dueAt precedent):
  //  (a) past-dueAt (pre-existing rule),
  //  (b) past-event: a clamp landing at-or-past the tour start,
  //  (c) same-slot supersession: an earlier rung clamped onto a later rung's
  //      slot loses (the later rung's copy is the current one),
  //  (d) copy-validity: day_before landing on the tour's LOCAL date is stale
  //      ("your tour is tomorrow" on tour day) regardless of exact slot.
  const tourLocalDate = localDateOf(scheduledIso, window.timezone);
  for (const kind of REMINDER_KINDS) {
    const dueAt = dues.get(kind);
    if (dueAt === undefined) continue;
    if (dueAt < now) {
      log.info({ tourId: tour.tourId, kind, dueAt }, 'tour reminder skipped (dueAt in the past)');
      continue;
    }
    if (dueAt >= scheduledIso) {
      log.info(
        { tourId: tour.tourId, kind, dueAt },
        'tour reminder skipped (quiet-hours clamp lands at/past tour start)',
      );
      continue;
    }
    const myOrder = LADDER_ORDER.indexOf(kind);
    const supersededBySlot = REMINDER_KINDS.some((other) => {
      if (LADDER_ORDER.indexOf(other) <= myOrder) return false;
      const otherDue = dues.get(other);
      // The later rung must itself be armable (not past-event) to supersede.
      return otherDue === dueAt && otherDue < scheduledIso;
    });
    const staleDayBefore =
      kind === 'day_before' && localDateOf(dueAt, window.timezone) === tourLocalDate;
    if (supersededBySlot || staleDayBefore) {
      log.info(
        { tourId: tour.tourId, kind, dueAt },
        'tour reminder skipped (quiet-hours superseded by a later rung)',
      );
      continue;
    }
    const row = await deps.tourRemindersRepo.create({ tourId: tour.tourId, kind, dueAt });
    created.push(row);
    log.info({ tourId: tour.tourId, kind, dueAt, reminderId: row.reminderId }, 'tour reminder armed');
  }
```

6. Update call sites (each constructs or already has a settings repo):
   - `app/src/routes/tours.ts` (~295, ~586): the router already builds repos at creation; add `const settingsRepo = deps.settingsRepo ?? createSettingsRepo({ logger: deps.logger });` beside the other repo defaults (add `settingsRepo?: SettingsRepo` to the router's deps interface, import `createSettingsRepo`), and pass `settingsRepo` in both arm calls.
   - `app/src/lib/seed/live.ts`: build one `const settingsRepo = createSettingsRepo(...)` with the same `RepoDeps`-style arguments the file's `remindersRepo` uses, pass to all three `armTourReminders` calls.

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test -- tourReminders` then `npm run typecheck`. Typecheck is what catches any missed call site. Expected: PASS / clean.

- [ ] **Step 5: Commit**

`git status`, then commit exactly the touched files:

```bash
git add app/src/jobs/tourReminders.ts app/src/routes/tours.ts app/src/lib/seed/live.ts app/test/tourReminders.test.ts
git commit -m "feat(quiet-hours): arm-time clamping + supersession for tour reminders; morning_of is 08:00 org-local" -- app/src/jobs/tourReminders.ts app/src/routes/tours.ts app/src/lib/seed/live.ts app/test/tourReminders.test.ts
```

---

### Task 4: Arm-time clamping for placement nudges

**Files:**
- Modify: `app/src/jobs/placementNudges.ts` (`ArmNudgeForStageDeps`, `armNudgeForStage`)
- Modify: `app/src/routes/api.ts` (~line 831, the `armNudgeForStage` call)
- Test: `app/test/placementNudges.test.ts`

**Interfaces:**
- Consumes: `readQuietHoursWindow` (exported from `../jobs/tourReminders.js` in Task 3), `clampOutOfQuietHours`.
- Produces: `ArmNudgeForStageDeps` gains REQUIRED `settingsRepo: SettingsRepo`.

- [ ] **Step 1: Write the failing tests**

In `app/test/placementNudges.test.ts` (read the file; extend the `armNudgeForStage` describe with the stub settings repo from Task 3):

```typescript
// UPDATED existing dueAt-per-rung cases: pass settingsRepo; daytime arms are
// unchanged (now + delayMs when that lands outside quiet hours).

// NEW: a rung landing in quiet hours is clamped to quiet-end.
//   now = 2026-01-19T04:00:00.000Z (Jan 18 23:00 EST);
//   awaiting_receipt (delay 24h) -> raw Jan 20 04:00Z == Jan 19 23:00 EST
//   (quiet) -> clamped dueAt 2026-01-20T13:00:00.000Z (Jan 20 08:00 EST).

// NEW: quiet hours disabled -> raw now+delay stored unchanged.

// NEW: settings read failure -> defaults still applied (clamped as above).
```

- [ ] **Step 2: Run to verify failures**

Run: `npm test -- placementNudges` - Expected: FAIL.

- [ ] **Step 3: Implement**

In `app/src/jobs/placementNudges.ts`:

```typescript
import { readQuietHoursWindow } from './tourReminders.js';
import { clampOutOfQuietHours } from '../lib/quietHours.js';
import type { SettingsRepo } from '../repos/settingsRepo.js';
```

`ArmNudgeForStageDeps` gains `settingsRepo: SettingsRepo;`. In `armNudgeForStage`, replace the dueAt line:

```typescript
  const window = await readQuietHoursWindow(deps.settingsRepo, log);
  const dueAt = clampOutOfQuietHours(
    new Date(Date.parse(nowIso) + rung.delayMs).toISOString(),
    window,
  );
```

Update the `app/src/routes/api.ts` call site (~831): the api router has repo construction near its top - add a settings repo (or reuse one if the file already constructs it for another route) and pass `settingsRepo` in the deps object of the `armNudgeForStage` call.

- [ ] **Step 4: Run tests + typecheck**

`npm test -- placementNudges` then `npm run typecheck` - Expected: PASS / clean.

- [ ] **Step 5: Commit**

`git status`, then:

```bash
git add app/src/jobs/placementNudges.ts app/src/routes/api.ts app/test/placementNudges.test.ts
git commit -m "feat(quiet-hours): arm-time clamping for placement nudges" -- app/src/jobs/placementNudges.ts app/src/routes/api.ts app/test/placementNudges.test.ts
```

---

### Task 5: Fire-time backstop + quiet_hours suppression reason

**Files:**
- Modify: `app/src/jobs/tourReminders.ts` (poller: pre-claim quiet check + batch supersession)
- Modify: `app/src/jobs/placementNudges.ts` (poller: pre-claim quiet check)
- Modify: `app/src/repos/tourRemindersRepo.ts` (`ReminderSkipReason` += `'quiet_hours_superseded'`)
- Modify: `app/src/services/scheduledSendSuppression.ts` (`'quiet_hours'` reason, lowest precedence)
- Modify: `app/src/routes/tourReminders.ts` + `app/src/routes/placementNudges.ts` (pass `quietNow` into the evaluator; settings repo dep)
- Modify: `app/src/worker.ts` (+`settingsRepo` in both poll deps blocks)
- Modify: `app/src/routes/dev.ts` (+`settingsRepo` in both tick dep builders)
- Test: `app/test/tourReminders.test.ts`, `app/test/placementNudges.test.ts`, `app/test/scheduledSendSuppression.test.ts`, `app/test/tourRemindersApi.test.ts`, `app/test/placementNudgesApi.test.ts`

**Interfaces:**
- Consumes: Task 1 + Task 3 exports.
- Produces:
  - `RunDueTourRemindersDeps` and `RunDuePlacementNudgesDeps` gain REQUIRED `settingsRepo: SettingsRepo`.
  - `ScheduledSuppressionReason` gains `'quiet_hours'`; `evaluateScheduledSendSuppression` input gains `quietNow?: boolean`.
  - `ReminderSkipReason` gains `'quiet_hours_superseded'`.

- [ ] **Step 1: Write the failing tests**

`app/test/scheduledSendSuppression.test.ts`:

```typescript
// quietNow: true alone -> { reason: 'quiet_hours' }
// precedence: quietNow: true PLUS opted-out -> 'contact_opted_out' (quiet is lowest)
// precedence: quietNow: true PLUS staleStage -> 'stale_stage' outranks quiet_hours
// quietNow: false / undefined -> undefined (with all else clear)
```

`app/test/tourReminders.test.ts` (poller describe; use the existing fixture style - build a due row directly via the in-memory repo with an ARBITRARY dueAt, which is exactly the legacy-row case):

```typescript
// BACKSTOP DEFER: a due row processed while `now` is inside quiet hours
//   (now = 2026-01-15T09:00:00.000Z == 04:00 EST) is NOT claimed, NOT sent,
//   and still pending afterward (sentAt/skippedAt/canceledAt all unset).
//   A second run with now = 2026-01-15T13:05:00.000Z (08:05 EST) sends it.

// RELEASE SUPERSESSION: two due rows for the SAME tour, day_before and
//   morning_of, both dueAt <= now (now = 13:05 EST-morning instant).
//   day_before is claim-skipped with skipReason 'quiet_hours_superseded'
//   (no send), morning_of sends. Assert outbox/sent-call count is exactly 1.

// DIFFERENT tours do not supersede each other: day_before for tour A and
//   morning_of for tour B, both due -> both send.
```

`app/test/placementNudges.test.ts` (poller): same defer case (in-quiet run leaves the row pending and sends nothing; post-quiet run sends).

`app/test/tourRemindersApi.test.ts` / `app/test/placementNudgesApi.test.ts` (read their existing suppression-view fixtures): with a settings stub whose window makes "now" quiet, an upcoming rung's view carries `suppression: { reason: 'quiet_hours' }`; with a non-quiet now, no suppression.

- [ ] **Step 2: Run to verify failures**

`npm test -- scheduledSendSuppression`, `npm test -- tourReminders`, `npm test -- placementNudges` - Expected: FAIL.

- [ ] **Step 3: Implement**

1. `app/src/services/scheduledSendSuppression.ts`:

```typescript
export type ScheduledSuppressionReason =
  | 'sms_sending_disabled' | 'contact_opted_out' | 'manual_mode' | 'stale_stage'
  | 'quiet_hours';
```

Add `quietNow?: boolean;` to the input and, as the LAST branch before `return undefined`:

```typescript
  if (input.quietNow === true) return { reason: 'quiet_hours' };
```

2. `app/src/repos/tourRemindersRepo.ts`: `ReminderSkipReason` += `| 'quiet_hours_superseded'`.

3. `app/src/jobs/tourReminders.ts`:
   - `RunDueTourRemindersDeps` += `settingsRepo: SettingsRepo;`.
   - `runDueTourReminders`: after the empty-check, read the window ONCE per tick and thread it plus the batch through:

```typescript
  const window = await readQuietHoursWindow(deps.settingsRepo, log);
  for (const row of dueRows) {
    try {
      await processReminderRow(row, now, window, dueRows, deps, log);
    } catch (err) { /* existing per-row catch unchanged */ }
  }
```

   - `processReminderRow(row, now, window, batch, deps, log)` - as its FIRST two checks (before any resolution or claim):

```typescript
  // RELEASE SUPERSESSION (backstop twin of arm-time supersession): if a LATER
  // rung of the same tour is also due in this batch, this rung's copy is
  // stale - retire it unsent. Covers legacy rows released together at
  // quiet-end (e.g. a pre-feature 4am morning_of plus a deferred day_before).
  const myOrder = LADDER_ORDER.indexOf(row.kind);
  const supersededInBatch = batch.some(
    (other) =>
      other.tourId === row.tourId &&
      other.reminderId !== row.reminderId &&
      LADDER_ORDER.indexOf(other.kind) > myOrder,
  );
  if (supersededInBatch) {
    log.info(
      { reminderId: row.reminderId, tourId: row.tourId, kind: row.kind },
      'tour reminder superseded by a later due rung - retiring (claim-skipped)',
    );
    await claimSkipRow(row, 'quiet_hours_superseded', now, deps);
    return;
  }

  // QUIET-HOURS BACKSTOP (pre-claim, spec section 6): rows are normally
  // pre-clamped at arm time, so this fires only for legacy rows and
  // worker-downtime catch-up. Returning WITHOUT claiming leaves the row in
  // listDue - it re-fires within one poll tick of quiet-end. NEVER a
  // post-claim refusal (that would destroy the message).
  if (isQuietTime(now, window)) {
    log.info(
      { reminderId: row.reminderId, tourId: row.tourId, kind: row.kind },
      'tour reminder due during quiet hours - deferred (not claimed)',
    );
    return;
  }
```

4. `app/src/jobs/placementNudges.ts`: `RunDuePlacementNudgesDeps` += `settingsRepo: SettingsRepo;`; `runDuePlacementNudges` reads the window once (same `readQuietHoursWindow`) and passes it to `processNudgeRow(row, nowIso, window, deps, log)`, whose FIRST check is the same pre-claim defer (no supersession - one rung per stage):

```typescript
  if (isQuietTime(nowIso, window)) {
    log.info(
      { nudgeId: row.nudgeId, placementId: row.placementId, kind: row.kind },
      'placement nudge due during quiet hours - deferred (not claimed)',
    );
    return;
  }
```

5. Suppression views:
   - `app/src/routes/tourReminders.ts`: add `settingsRepo?: SettingsRepo` to `TourRemindersRouterDeps` (default `createSettingsRepo({ logger: deps.logger })`). In the GET handler, alongside the existing `resolveTenantSuppression` call, compute once per request:

```typescript
    const window = await readQuietHoursWindow(settingsRepo, log);
    const quietNow = isQuietTime(new Date().toISOString(), window);
```

     and pass `quietNow` into `evaluateScheduledSendSuppression` inside `resolveTenantSuppression` (thread it as a parameter). NOTE: this route computes suppression only for self_guided tours today; pass `quietNow` there - do not widen the group case in this task.
   - `app/src/routes/placementNudges.ts`: same pattern for the nudge view's evaluator call.
6. Wiring:
   - `app/src/worker.ts`: in BOTH poll dep blocks add `const { createSettingsRepo } = await import('./repos/settingsRepo.js');` and `settingsRepo: createSettingsRepo({ logger }),`.
   - `app/src/routes/dev.ts`: add `settingsRepo: createSettingsRepo({ logger: log }),` to both lazy tick dep builders (import at top with the other repo imports).

- [ ] **Step 4: Run the whole app suite + typecheck**

Run: `npm test` (full - the dep additions ripple through many poller tests; every existing poller test needs the stub settings repo added to its deps object, mechanical) then `npm run typecheck`. Expected: PASS / clean.

- [ ] **Step 5: Commit**

`git status`, then:

```bash
git add app/src/jobs/tourReminders.ts app/src/jobs/placementNudges.ts app/src/repos/tourRemindersRepo.ts app/src/services/scheduledSendSuppression.ts app/src/routes/tourReminders.ts app/src/routes/placementNudges.ts app/src/worker.ts app/src/routes/dev.ts app/test/tourReminders.test.ts app/test/placementNudges.test.ts app/test/scheduledSendSuppression.test.ts app/test/tourRemindersApi.test.ts app/test/placementNudgesApi.test.ts
git commit -m "feat(quiet-hours): pre-claim fire-time backstop, release supersession, quiet_hours suppression reason" -- app/src app/test
```

(For this one commit the pathspec `app/src app/test` is acceptable ONLY if `git status` shows no unrelated modified files; otherwise enumerate the files exactly as in the `git add`.)

---

### Task 6: Send-now backend (tour reminders + placement nudges)

**Files:**
- Modify: `app/src/jobs/tourReminders.ts` (export `forceSendReminder`)
- Modify: `app/src/jobs/placementNudges.ts` (export `forceSendNudge`)
- Modify: `app/src/routes/tourReminders.ts` (POST `/:tourId/reminders/:reminderId/send-now`)
- Modify: `app/src/routes/placementNudges.ts` (POST `/:placementId/nudges/:nudgeId/send-now`)
- Test: `app/test/tourReminders.test.ts`, `app/test/placementNudges.test.ts`, `app/test/tourRemindersApi.test.ts`, `app/test/placementNudgesApi.test.ts`

**Interfaces:**
- Consumes: existing claim/resolve/send internals of both jobs; `isKillSwitchOff`, `isOptedOut` from `scheduledSendSuppression.js`; the consent helper `sendMessage.ts` imports (find its `hasSmsConsent` import and import from the same module).
- Produces:

```typescript
// jobs/tourReminders.ts
export type ForceSendRefusal =
  | 'sms_sending_disabled' | 'contact_opted_out' | 'no_consent'
  | 'no_conversation' | 'contact_missing' | 'contact_no_phone' | 'tour_missing';
export type ForceSendResult =
  | { outcome: 'sent' }
  | { outcome: 'not_pending' }            // claim lost: already sent/canceled/skipped
  | { outcome: 'refused'; reason: ForceSendRefusal };
export async function forceSendReminder(
  reminderId: string,
  tourId: string,
  nowIso: string,
  smsSendingEnabled: boolean | undefined,
  deps: RunDueTourRemindersDeps,
): Promise<ForceSendResult>;

// jobs/placementNudges.ts - same shape, plus 'stage_moved' refusals:
export type NudgeForceSendRefusal =
  | 'sms_sending_disabled' | 'contact_opted_out' | 'no_consent' | 'stage_moved'
  | 'placement_missing' | 'unit_missing' | 'no_landlord' | 'contact_missing'
  | 'contact_no_phone' | 'unknown_kind';
export type NudgeForceSendResult =
  | { outcome: 'sent' }
  | { outcome: 'not_pending' }
  | { outcome: 'refused'; reason: NudgeForceSendRefusal };
export async function forceSendNudge(
  nudgeId: string,
  placementId: string,
  nowIso: string,
  smsSendingEnabled: boolean | undefined,
  deps: RunDuePlacementNudgesDeps,
): Promise<NudgeForceSendResult>;
```

**Semantics (from spec section 7 - copy into the implementations' doc comments):** human-triggered, so it bypasses quiet hours, manual mode, and the breaker (send with `automated: false`), but respects kill-switch + opt-out + consent + staleness, all checked BEFORE claiming; refusals never leave the row claimed-but-unsent. The narrow race (opt-out arriving between the pre-check and the provider send) surfaces as a post-claim `SendRefusedError` -> warn, claim kept - the same accepted tradeoff as the poller. Force-sending does not touch the ladder's other rungs.

- [ ] **Step 1: Write the failing job-level tests**

`app/test/tourReminders.test.ts` (new describe `forceSendReminder`):

```typescript
// sends immediately during quiet hours (now = 04:00 EST instant), automated:false
//   -> outcome 'sent'; the sendMessageService stub records automated === false;
//   row has sentAt set.
// claim race: row already sent -> { outcome: 'not_pending' }, no second send.
// kill-switch: smsSendingEnabled === false -> refused 'sms_sending_disabled',
//   row still pending (NOT claimed).
// opt-out (contact.sms_opt_out) -> refused 'contact_opted_out', row pending.
// no consent (contact exists, hasSmsConsent false) -> refused 'no_consent',
//   row pending.
// missing 1:1 conversation -> refused 'no_conversation', row pending
//   (NOT claim-skipped - a force-send failure must not retire the rung;
//   the poller can still handle it at dueAt).
// group-routed tour (usable group) -> sends via the announcement path
//   (existing group fixtures), outcome 'sent'.
```

`app/test/placementNudges.test.ts` (new describe `forceSendNudge`): the analogous cases plus:

```typescript
// stale stage: placement.stage !== the rung's stage -> refused 'stage_moved',
//   row pending (not skipped - mirror the honest-error contract).
```

- [ ] **Step 2: Run to verify failures**

`npm test -- tourReminders` / `npm test -- placementNudges` - Expected: FAIL.

- [ ] **Step 3: Implement the job functions**

Structure inside `jobs/tourReminders.ts` - reuse, do not duplicate, the existing resolution: refactor `processReminderRow`'s target-resolution portion (tour fetch, group resolution, contact/phone/conversation lookup) into a shared internal:

```typescript
type ReminderTarget =
  | { route: 'group'; tour: TourItem; group: UsableGroup }
  | { route: 'one_to_one'; tour: TourItem; contact: ContactItem; conversationId: string }
  | { unresolvable: ForceSendRefusal };
async function resolveReminderTarget(
  row: TourReminderItem,
  deps: RunDueTourRemindersDeps,
  log: Logger,
): Promise<ReminderTarget>;
```

`processReminderRow` keeps its EXACT current behavior by mapping `unresolvable` reasons onto its existing claim-skips (`tour_missing`/`contact_missing`/`contact_no_phone`/`no_conversation`); `forceSendReminder` maps them onto refusals WITHOUT claim-skipping. Then `forceSendReminder`:

```typescript
export async function forceSendReminder(reminderId, tourId, nowIso, smsSendingEnabled, deps) {
  const log = deps.logger ?? defaultLogger;
  const rows = await deps.tourRemindersRepo.listByTour(tourId);
  const row = rows.find((r) => r.reminderId === reminderId);
  if (row === undefined) return { outcome: 'refused', reason: 'tour_missing' };
  if (row.sentAt !== undefined || row.canceledAt !== undefined || row.skippedAt !== undefined) {
    return { outcome: 'not_pending' };
  }
  const target = await resolveReminderTarget(row, deps, log);
  if ('unresolvable' in target) return { outcome: 'refused', reason: target.unresolvable };

  // Pre-claim absolute gates (spec: check BEFORE claiming so a refusal never
  // consumes the row). Manual mode + breaker are deliberately NOT checked -
  // this is a human send.
  if (isKillSwitchOff(smsSendingEnabled)) {
    return { outcome: 'refused', reason: 'sms_sending_disabled' };
  }
  if (target.route === 'one_to_one') {
    const conv = await deps.conversationsRepo.getById(target.conversationId);
    if (isOptedOut(conv?.sms_opt_out, target.contact.sms_opt_out === true)) {
      return { outcome: 'refused', reason: 'contact_opted_out' };
    }
    if (!hasSmsConsent(target.contact)) {
      return { outcome: 'refused', reason: 'no_consent' };
    }
  }

  const claimed = await deps.tourRemindersRepo.claimSend(row.reminderId, nowIso);
  if (!claimed) return { outcome: 'not_pending' };
  (deps.events ?? appEvents).emit('scheduled.updated', { contactId: target.tour.tenantId });

  if (target.route === 'group') {
    // Same announcement chain the poller uses (per-member opt-out suppression
    // and pacing live inside sendRelayAnnouncement).
    await sendRelayAnnouncement(/* identical deps/args to sendGroupReminder */);
    return { outcome: 'sent' };
  }
  try {
    await deps.sendMessageService({
      conversationId: target.conversationId,
      body: resolveMessage(`tour.${row.kind}`),
      author: 'teammate',
      automated: false, // human force-send: bypasses manual mode + breaker
    });
    return { outcome: 'sent' };
  } catch (err) {
    if (err instanceof SendRefusedError) {
      log.warn({ reminderId: row.reminderId, refusal: err.code },
        'force-send refused post-claim (race) - claim kept, not retried');
      return { outcome: 'sent' }; // row consumed; report honestly via logs
    }
    throw err;
  }
}
```

(Adjust to the file's real local helpers while implementing - the contract that MUST hold: gate checks precede the claim; group route reuses `sendRelayAnnouncement`; 1:1 uses `automated: false`.)

`jobs/placementNudges.ts`: same refactor shape (`resolveNudgeTarget` from `processNudgeRow`'s resolution portion, including on-demand conversation creation) and `forceSendNudge` with the stale-stage pre-check `if (placement.stage !== rungStage) return { outcome: 'refused', reason: 'stage_moved' };`.

- [ ] **Step 4: Run job tests**

`npm test -- tourReminders` / `npm test -- placementNudges` - Expected: PASS.

- [ ] **Step 5: Write the failing route tests**

`app/test/tourRemindersApi.test.ts` (existing router fixture; new describe):

```typescript
// POST /api/tours/:tourId/reminders/:reminderId/send-now
//   200 { reminder } with state 'sent' on success (view re-read after send)
//   409 { error: 'reminder_not_pending', reminder } when already sent/canceled/skipped
//   409 { error: 'contact_opted_out', reminder } on refusal (row still upcoming)
//   404 on unknown tour or reminder
//   emits an audit event 'reminder_force_sent' with { reminderId, kind, actor }
```

`app/test/placementNudgesApi.test.ts`: the nudge equivalents (including `409 { error: 'stage_moved' }`).

- [ ] **Step 6: Implement the routes**

`app/src/routes/tourReminders.ts` - the router deps grow the poller-deps it lacks (all optional with factory defaults, EXACTLY mirroring the dev.ts tick builder): `messagesRepo`, `sendMessageService`, `adapter`, `auditRepo`, `settingsRepo` (settingsRepo exists from Task 5). Then:

```typescript
  router.post('/:tourId/reminders/:reminderId/send-now', async (req: AuthedRequest, res) => {
    const tourId = String(req.params['tourId'] ?? '');
    const reminderId = String(req.params['reminderId'] ?? '');
    const tour = await tours.get(tourId);
    if (!tour) { res.status(404).json({ error: 'tour_not_found' }); return; }
    const rows = await reminders.listByTour(tourId);
    if (!rows.some((r) => r.reminderId === reminderId)) {
      res.status(404).json({ error: 'reminder_not_found' }); return;
    }
    const result = await forceSendReminder(
      reminderId, tourId, new Date().toISOString(), config.smsSendingEnabled, pollerDeps,
    );
    const after = (await reminders.listByTour(tourId)).find((r) => r.reminderId === reminderId)!;
    if (result.outcome === 'sent') {
      await audit.append(`tours#${tourId}`, 'reminder_force_sent', {
        reminderId, kind: after.kind, actor: req.user?.userId,
      });
      res.json({ reminder: viewOf(after) });
      return;
    }
    res.status(409).json({
      error: result.outcome === 'refused' ? result.reason : 'reminder_not_pending',
      reminder: viewOf(after),
    });
  });
```

`pollerDeps` is a `RunDueTourRemindersDeps` object assembled once at router creation from the router's repos/services. Auth: the route sits behind the existing `/api` requireAuth mount - any staff role, no `requireRole('admin')` (spec: composer parity implies no new privilege). The placement-nudge route mirrors this in `app/src/routes/placementNudges.ts`.

- [ ] **Step 7: Run route tests + typecheck**

`npm test -- tourRemindersApi` / `npm test -- placementNudgesApi` then `npm run typecheck` - Expected: PASS / clean.

- [ ] **Step 8: Commit**

`git status`, then:

```bash
git add app/src/jobs/tourReminders.ts app/src/jobs/placementNudges.ts app/src/routes/tourReminders.ts app/src/routes/placementNudges.ts app/test/tourReminders.test.ts app/test/placementNudges.test.ts app/test/tourRemindersApi.test.ts app/test/placementNudgesApi.test.ts
git commit -m "feat(quiet-hours): send-now force-send for reminders and nudges (pre-claim gates, human semantics)" -- app/src/jobs/tourReminders.ts app/src/jobs/placementNudges.ts app/src/routes/tourReminders.ts app/src/routes/placementNudges.ts app/test/tourReminders.test.ts app/test/placementNudges.test.ts app/test/tourRemindersApi.test.ts app/test/placementNudgesApi.test.ts
```

---

### Task 7: Settings UI - Quiet hours section (System tab)

**Files:**
- Modify: `dashboard/src/api/types.ts` (`OrgSettings` mirror += the four fields, same doc comments)
- Create: `dashboard/src/routes/settings/QuietHoursSection.tsx` (+ a `.module.css` only if the System tab's existing styles do not cover a simple labeled row group)
- Modify: the System tab's rendered element so the section appears ABOVE `SystemStatusSection` (read `dashboard/src/routes/settings/SettingsPage.tsx` and the app's route config to find where the `system` tab renders `SystemStatusSection`; wrap in a fragment)
- Test: `dashboard/src/routes/settings/QuietHoursSection.test.tsx`

**Interfaces:**
- Consumes: `useSettings()` (`status`, `settings`, `save`) - unchanged; `getSettings`/`putSettings` need no changes (generic over the patch).
- Produces: a self-contained `<QuietHoursSection />` component (no props), gated read-only for VAs the same way `TemplatesSection` gates (read that file and reuse its admin-detection + disabled-input pattern exactly).

- [ ] **Step 1: Write the failing tests**

`QuietHoursSection.test.tsx`, following `TemplatesSection.test.tsx`'s harness (mock the api module the same way):

```typescript
// renders the stored values: toggle checked from quietHoursEnabled, time
//   inputs showing quietHoursStart / quietHoursEnd, and the fixed timezone
//   line "Eastern - America/New_York" (plain text, no input).
// admin can save: change end time to 09:00, click Save -> putSettings called
//   with EXACTLY { quietHoursEnd: '09:00' } (changed fields only).
// toggle off: uncheck -> Save -> putSettings with { quietHoursEnabled: false }.
// VA sees inputs disabled and no enabled Save button.
// 400 from the server (e.g. quiet_hours_zero_length) surfaces as inline error
//   text, not a crash.
```

- [ ] **Step 2: Run to verify failures**

Run the dashboard suite filtered: `npm test -- QuietHoursSection` - Expected: FAIL.

- [ ] **Step 3: Implement**

1. `dashboard/src/api/types.ts` - extend the `OrgSettings` mirror (keep the "MIRRORS app/src/repos/settingsRepo.ts" comment accurate):

```typescript
  /** Quiet hours: automated sends defer during this window (spec 2026-08-03). */
  quietHoursEnabled: boolean;
  /** "HH:MM" 24h - window start (inclusive). */
  quietHoursStart: string;
  /** "HH:MM" 24h - window end (exclusive). */
  quietHoursEnd: string;
  /** IANA org timezone (read-only in the UI this phase). */
  timezone: string;
```

2. `QuietHoursSection.tsx` - structure (adapt markup/classes to the Templates/System sections' existing conventions; accessibility-first labels):

```tsx
// Quiet hours editor (System tab): on/off toggle + start/end <input type="time">.
// Timezone is fixed text this phase ("Eastern - America/New_York").
// VAs view read-only (PUT is admin-only server-side; inputs disabled client-side).
export function QuietHoursSection(): JSX.Element {
  const { status, settings, save } = useSettings();
  // local draft state for the three editable fields; Save sends ONLY changed
  // fields; on ApiError show its message inline (same pattern as Templates).
  // Inputs: <input type="checkbox"> labeled "Pause automated messages overnight",
  // <input type="time"> labeled "Start" and "End", both step={60}.
  // Chrome renders type="time" as HH:MM; values are already "HH:MM" strings -
  // no conversion needed.
}
```

3. Mount it on the System tab above `SystemStatusSection`.

- [ ] **Step 4: Run dashboard tests + typecheck**

`npm test -- QuietHoursSection` (plus `SettingsPage`/`SystemStatusSection` suites if the mount point changed their render tree) and `npm run typecheck` - Expected: PASS / clean.

- [ ] **Step 5: Commit**

`git status`, then:

```bash
git add dashboard/src/api/types.ts dashboard/src/routes/settings/QuietHoursSection.tsx dashboard/src/routes/settings/QuietHoursSection.test.tsx
git commit -m "feat(quiet-hours): settings UI section on the System tab" -- dashboard/src/api/types.ts dashboard/src/routes/settings/
```

(Include the modified System-tab mount file in the pathspec - its exact path is discovered in Step 3.3.)

---

### Task 8: Dashboard Send-now buttons + new reason labels

**Files:**
- Modify: `dashboard/src/api/endpoints.ts` (two new POST helpers), `dashboard/src/api/types.ts` (if reminder/nudge view types enumerate skip/suppression reasons, extend the unions)
- Modify: `dashboard/src/routes/tours/RemindersPanel.tsx` (+ its test)
- Modify: `dashboard/src/routes/placements/DeadlinesNudgesCard.tsx` (+ its test)

**Interfaces:**
- Consumes: Task 6's endpoints.
- Produces:

```typescript
// endpoints.ts
export async function postReminderSendNow(tourId: string, reminderId: string): Promise<{ reminder: TourReminderView }>;
export async function postNudgeSendNow(placementId: string, nudgeId: string): Promise<{ nudge: PlacementNudgeView }>;
```

(Use the file's existing fetch-helper conventions; on 409 the shared error path throws `ApiError` carrying the server's `error` code.)

- [ ] **Step 1: Write the failing tests**

Extend `RemindersPanel.test.tsx` (read its harness first):

```typescript
// an 'upcoming' rung renders a "Send now" button (role button, accessible
//   name "Send now"); sent/canceled/skipped rungs do NOT.
// clicking it calls postReminderSendNow(tourId, reminderId) and on success
//   the panel refetches (assert via the existing refetch/mock convention).
// a 409 ApiError (e.g. 'contact_opted_out') surfaces as inline error text
//   and the button re-enables.
// suppression reason 'quiet_hours' renders its chip label (add the label
//   "Quiet hours" to wherever the existing reason->label map lives).
// skipReason 'quiet_hours_superseded' renders "Superseded by a later reminder".
```

Extend `DeadlinesNudgesCard.test.tsx` with the same four shapes for nudges (including 'stage_moved' -> inline error).

- [ ] **Step 2: Run to verify failures**

`npm test -- RemindersPanel` / `npm test -- DeadlinesNudgesCard` - Expected: FAIL.

- [ ] **Step 3: Implement**

Buttons sit beside the existing per-rung cancel control in each panel; disabled while the request is in flight; errors render in the panel's existing inline-error slot. Refetch on success via each panel's existing data hook (`useTour` / `usePlacementNudges`). Add the two reason labels to the panels' reason-label maps (grep each panel for the existing `skipReason`/`suppression` label mapping and extend in place).

- [ ] **Step 4: Run tests + typecheck**

`npm test -- RemindersPanel`, `npm test -- DeadlinesNudgesCard`, `npm run typecheck` - Expected: PASS / clean.

- [ ] **Step 5: Commit**

`git status`, then:

```bash
git add dashboard/src/api/endpoints.ts dashboard/src/api/types.ts dashboard/src/routes/tours/RemindersPanel.tsx dashboard/src/routes/tours/RemindersPanel.test.tsx dashboard/src/routes/placements/DeadlinesNudgesCard.tsx dashboard/src/routes/placements/DeadlinesNudgesCard.test.tsx
git commit -m "feat(quiet-hours): send-now buttons + quiet-hours labels in reminder/nudge panels" -- dashboard/src/api/endpoints.ts dashboard/src/api/types.ts dashboard/src/routes/tours/ dashboard/src/routes/placements/
```

---

### Task 9: E2e spec + full gates

**Files:**
- Create: `e2e/tests/scenarios/quiet-hours.spec.ts`
- Reference: `e2e/tests/scenarios/scheduled-visibility.spec.ts` (the closest precedent - read it fully and reuse its seeding/steps vocabulary), `e2e/support/selectors.md`, `e2e/README.md`

**Interfaces:**
- Consumes: dev seams `POST /auth/dev-login`, `POST /__dev/reseed`, `POST /__dev/tour-reminders/tick { now }`, `GET /__dev/outbox`; the Settings System tab; a seeded/created tour with reminders.

- [ ] **Step 1: Write the spec**

Scenarios (accessibility-first selectors; follow the file conventions of `scheduled-visibility.spec.ts` including its reseed/login hooks):

```typescript
// 1. Settings round-trip: dev-login (admin) -> Settings -> System tab ->
//    "Quiet hours" section visible with 21:00/08:00 defaults -> change end to
//    08:30 -> Save -> reload -> 08:30 persisted. (Restore 08:00 afterward or
//    reseed - leave the lane clean.)
// 2. Defer + release: create/seed a tour whose ladder has an upcoming rung,
//    then POST /__dev/tour-reminders/tick with a `now` that is 04:00 ET on
//    the rung's due date (an in-window instant AFTER its dueAt - use a
//    directly-created legacy-style row via the seed if the UI path cannot
//    produce one; the scheduled-visibility spec shows how rows are made).
//    Assert: outbox unchanged, rung still shows as upcoming in the tour's
//    Reminders panel WITH the "Quiet hours" chip.
//    Tick again with now = 13:05Z (08:05 ET). Assert: outbox gained exactly
//    the reminder body; panel shows the rung Sent.
// 3. Send now: with another upcoming rung and NO tick, click its "Send now"
//    button in the Reminders panel. Assert: outbox gains the body
//    immediately and the rung flips to Sent.
```

- [ ] **Step 2: Run the new spec against a session stack**

`npm run e2e:session` (if not already up), then run the spec from the `e2e/` workspace per `e2e/README.md` (NEVER from the repo root). After any backend change since the stack started: `npm run e2e:restart` first. Expected: 3/3 PASS.

- [ ] **Step 3: Full gates on the branch**

Run each BARE, sequentially: `npm run typecheck` then `npm test` then `npm run e2e`. Expected: all green, e2e exit code 0.

- [ ] **Step 4: Commit**

`git status`, then:

```bash
git add e2e/tests/scenarios/quiet-hours.spec.ts
git commit -m "test(quiet-hours): e2e - settings round-trip, defer+release via tick seam, send-now" -- e2e/tests/scenarios/quiet-hours.spec.ts
```

---

## Self-review checklist (run after Task 9)

1. Spec coverage: every numbered spec section maps to a task (1->T2/T7, 2->T1, 3->T3/T4, 4->T5, 5->T2, 6->T5, 7->T6/T8, 8->T7, 9->T1-T9, 10 out of scope respected).
2. `grep -rn "quiet" app/src app/test dashboard/src e2e/tests` - no TODO/placeholder strings.
3. Exempt paths untouched: `git diff main --stat` shows NO changes under `app/src/jobs/missedCallAutoText.ts`, `app/src/jobs/relayFanOut.ts`, `app/src/routes/public.ts`, `app/src/routes/webhooks/`, `app/src/services/relayAnnouncements.ts`, `app/src/routes/voiceApi.ts`.
4. `npm run typecheck` + `npm test` + `npm run e2e` all green on the branch after a `git merge main`.
