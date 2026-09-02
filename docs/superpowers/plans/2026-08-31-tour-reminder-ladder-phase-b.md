<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-09-01).** This document
> describes how this work was *designed/planned at the time of writing*. Phase B shipped to
> `main`, was swept and deployed on dev and prod, and its branch + worktree were deleted
> during worktree cleanup. **This file is NOT current documentation, and the live code may
> have drifted from it.** Phase A's spec, which this names as its predecessor, is frozen too -
> both are history, so read the CODE for current behaviour. A third effort, tour-reminder
> supersession cleanup, is IN FLIGHT on this same seam and will move these files again. The
> mission's review record is preserved at
> `docs/superpowers/reviews/2026-08-31-tour-reminder-ladder-phase-b/`.

# Tour Reminder Ladder Phase B + Relay Group Templates - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the tour reminder ladder on (with the guards that make that safe) and rewrite the relay group templates to Sam's 2026-08-24 wording.

**Architecture:** Tour side: a permanent `DISCONTINUED_REMINDER_KINDS` guard retires `confirmation` on every send path; a fire-time past-tour gate (shared predicate with the ops sweep script) stops stale backlogs; `en_route` is exempted from quiet hours with a widened supersession predicate absorbing the collision that creates; the names re-list gets the one-hour bound; the view gains a derived `overdue` boolean. Relay side: owner-routed intro variants and a per-recipient `member_added` split, composed by the existing pure-composer pattern behind one shared async resolver keyed on the OWNER, previews and jobs funneling through the same code. Plus the single-pass `interpolate` fix everything else leans on.

**Tech Stack:** TypeScript (Node 24 ESM), Vitest + DynamoDB Local, Playwright e2e, React dashboard.

**Spec:** `docs/superpowers/specs/2026-08-31-tour-reminder-ladder-phase-b-design.md` - the plan argues from it; executors read both. Spec section numbers below refer to it.

## Global Constraints

- ASCII-only in every NEW/touched line of tests, specs, comments, seed strings, issue files. (Existing non-ASCII lines you do not touch are fine.)
- Never pipe a gate command; run gates bare from the worktree `W:\tmp\tour-reminder-ladder-phase-b`.
- Stage explicit paths only; never `git add -A`. `git status` (bare) before every commit. Every commit carries `Co-Authored-By:` naming the authoring model.
- `npm test` needs DynamoDB Local running (`npm run db:start` once). If red on Dynamo suites, re-run under a clean key per AGENTS.md before diagnosing.
- Do NOT run the sweep script against any non-hermetic environment. Unit tests and local lanes only (spec 4.4).
- New user-facing copy goes through the message catalog; no new dependencies anywhere in this plan.
- Founder copy is byte-exact where the spec gives it in a fenced block. Do not re-word, re-punctuate, or "fix" it.
- The five completion gates (typecheck, test, smoke, e2e, scoped eslint) run at the end from the worktree; per-task verification is the named test file(s) for that task.
- Run unit tests as `cd app && npx vitest run test/<file>` (vitest workspace lives in `app/`).

## File Structure (created / modified)

| file | role in this plan |
|---|---|
| `app/src/messages/resolve.ts` | Task 1: single-pass `interpolate` |
| `app/test/messages/resolve.test.ts` | Task 1 (new file if absent; else extend) |
| `app/src/repos/tourRemindersRepo.ts` | Task 2: skip-reason union |
| `dashboard/src/api/types.ts` | Tasks 2, 8, 12: wire unions, labels, SEND_NOW copy, `overdue` |
| `dashboard/src/api/types.test.ts` | Tasks 2, 8: SKIP_REASONS + new SEND_NOW completeness test |
| `app/src/jobs/tourReminders.ts` | Tasks 3, 7, 10, 11: predicate, gate, discontinued set, exemption, widening, names bound |
| `app/test/tourReminders.test.ts` | Tasks 3, 5, 7, 10, 11: new cases + vehicle conversion |
| `app/scripts/retire-paused-tour-reminders.ts` | Task 4 (new): sweep script |
| `app/test/retirePausedTourReminders.test.ts` | Task 4 (new): planner tests |
| `RUNBOOK.md` | Task 4: sweep runbook entry |
| `e2e/scenarios/steps.ts` | Tasks 6, 14: vehicle helpers, intro step updates |
| `e2e/tests/scenarios/scheduled-visibility.spec.ts`, `e2e/tests/scenarios/tours.spec.ts`, `e2e/tests/tour-roster.spec.ts` | Tasks 6, 9, 14 |
| `app/src/routes/tourReminders.ts` | Tasks 7, 8, 12: refusal wiring, discontinued chip, `overdue` |
| `app/src/routes/contactTimeline.ts` | Task 8: discontinued read |
| `app/src/services/scheduledSendSuppression.ts` | Task 8: union widening |
| `dashboard/src/routes/tours/RemindersPanel.tsx` | Tasks 8, 12: "no longer sent" chip, overdue chip |
| `dashboard/src/routes/placements/DeadlinesNudgesCard.tsx` | Task 8: one label entry (compile completeness ONLY) |
| `app/src/routes/dev.ts` | Task 7: dev-tick override removal |
| `app/src/lib/seed/matrix.ts`, `live.ts`, `lean.ts`, `cast.ts` | Task 9: seed re-baselines |
| `app/src/messages/catalog.ts` | Task 13: new entries, `MessageId` union, naked-intro rewrite |
| `app/test/messages/catalog.test.ts` | Task 13: tripwire rewrite + byte-identity pin |
| `app/src/jobs/relayFanOut.ts` | Tasks 13, 14: composers, resolver, job wiring |
| `app/test/relayFanOut.test.ts` | Tasks 13, 14 |
| `app/src/services/rosterEdits.ts` | Task 14: preview parity |
| `app/src/services/relayAnnouncements.ts` | Task 14: `bodyFor` selector |
| `app/test/toursApi.test.ts`, `app/test/placementsApi.test.ts`, `app/test/relayGroupPreview.test.ts` | Task 14: parity-pin re-baselines |
| `app/src/messages/tourCopy.ts` | Task 15: TODO re-point |
| `docs/issues/*.md` | Task 15: issue updates |

## Derived conversion inventory (spec 10a - carried here, not re-counted)

`confirmation` sites by file, with 10a.1 category:

| file | sites | category |
|---|---|---|
| `app/test/tourReminders.test.ts` | 88 lines mentioning `confirmation` | mostly cat 1 (immediate-send rides); a minority are cat 2 (assert it arms / is first) - classify per site in Task 5 step 1 |
| `app/test/tourRemindersApi.test.ts`, `app/test/toursApi.test.ts`, `app/test/contactTimeline.test.ts`, `app/test/relayApi.test.ts`, `app/test/devGating.test.ts`, `app/test/placementConvert.test.ts`, `app/test/seedLive.test.ts` | assorted | mix of cat 1 and cat 2 - classify in Task 5 step 1 |
| `app/test/computeDueAt.test.ts`, `app/test/tourCopy.test.ts` | raw-table / copy pins | KEEP UNCHANGED - the kind stays in the union, `computeDueAt` and the catalog entries stay (spec 5) |
| `app/src/lib/seed/matrix.ts:987`, `live.ts:506,523`, `lean.ts:423`, `cast.ts:769-784` | seed rows/comments | cat 3 (Task 9). `cast.ts` seeds SENT confirmation rows - historical, valid, KEEP |
| `e2e/tests/scenarios/scheduled-visibility.spec.ts` (6), `tours.spec.ts` (6), `tour-roster.spec.ts` (1), `e2e/scenarios/steps.ts` (2) | see Task 6 | cat 1 conversions + cat 2 deletions (`tour-roster.spec.ts:488-501`, `scheduled-visibility.spec.ts:234-259`) |
| `e2e/tests/scenarios/tours.spec.ts:283-287` | ticks past tour; earlier rungs fire | **cat 4** (behaviour changes green) - Task 3 step 8 rewrites its assertions |

Relay tripwires (spec 10a.2 - the known floor): `app/test/messages/catalog.test.ts:66-69` (THROWS on rename), `e2e/tests/tour-roster.spec.ts:252-269` (splits on literal `{members}`), `e2e/scenarios/steps.ts:1887,1930-1949` (shared steps asserting the connection sentence), parity pins in `toursApi.test.ts:3989-3998,4096`, `placementsApi.test.ts:989,1007`, `relayGroupPreview.test.ts:151,208`, `relayFanOut.test.ts:703-716`. Tasks 13-14 name each.

Task order satisfies spec 3.2's build order: sweep (4) before vehicle conversion (5-6) before the manual-only change (7).

---

### Task 1: Single-pass `interpolate` (spec 11)

**Files:**
- Modify: `app/src/messages/resolve.ts:24-45`
- Test: `app/test/messages/resolve.test.ts` (create if absent; `ls app/test/messages/` first)

**Interfaces:**
- Consumes: nothing new.
- Produces: `interpolate` keeps its exact signature `(template: string, vars: Record<string,string>|undefined, allowed: readonly string[], strict: boolean): string` and `resolveMessage` is untouched. Every later task relies on: substituted values are NEVER rescanned, `$`-patterns in values are inert.

- [ ] **Step 1: Write the failing tests.** `app/test/messages/resolve.test.ts` EXISTS (~134 lines) - READ it first, APPEND the describe block below, and keep every existing case (they pin behaviour this task must preserve). Never overwrite the file.

```ts
// APPENDED to app/test/messages/resolve.test.ts
import { describe, expect, it } from 'vitest';
import { resolveMessage } from '../../src/messages/resolve.js';

// relay.member_added declares ['joined','members'] today (pre-Task-13) and is
// non-editable, which makes it the strict-mode probe. If Task 13 has already
// landed when you run this, switch the probe id to 'relay.member_added_role'
// with vars { name, role } - the four behaviours pinned here are id-agnostic.
describe('interpolate is single-pass', () => {
  it('a substituted value containing a later declared token is NOT re-expanded', () => {
    const out = resolveMessage('relay.member_added', {
      joined: 'A {members} joined this group chat.',
      members: 'SECRET LIST',
    });
    // Pre-fix this emits 'A SECRET LIST joined...' - the token inside the
    // substituted value must survive as literal text instead.
    expect(out).toContain('A {members} joined this group chat.');
    expect(out).toContain('SECRET LIST'); // the real token still resolves
  });

  it('replacement-pattern characters in values are inert ($& / $1 / $`)', () => {
    const out = resolveMessage('relay.member_added', {
      joined: '$& $1 $` $\' joined.',
      members: 'M.',
    });
    expect(out).toContain("$& $1 $` $' joined.");
  });

  it('an UNDECLARED token in the template stays literal', () => {
    const out = resolveMessage('relay.member_added', { joined: 'J.', members: 'M.' });
    // No entry declares {nope}; craft via override path instead: undeclared
    // tokens simply are not in `allowed`, so assert on a template that has one.
    // relay.media_only declares only ['name'].
    const out2 = resolveMessage('relay.media_only', { name: 'Ann' }, {
      'relay.media_only': '{name} sent {nope}.',
    });
    expect(out2).toBe('Ann sent {nope}.');
    expect(out).toBeTypeOf('string');
  });

  it('strict default THROWS on a declared-but-missing token; override degrades to empty', () => {
    expect(() => resolveMessage('relay.member_added', { joined: 'J.' })).toThrow(
      /missing interpolation var "members"/,
    );
    const out = resolveMessage('relay.media_only', {}, { 'relay.media_only': 'Hi {name}!' });
    expect(out).toBe('Hi !');
  });

  it('a declared token ABSENT from the template needs no value', () => {
    // welcome.sms declares {firstName}; its default copy does not use it.
    expect(() => resolveMessage('welcome.sms', {})).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify the first two FAIL** - `cd app && npx vitest run test/messages/resolve.test.ts`. Expected: re-expansion test fails (value got expanded), `$&` test may pass today (split/join is immune) - keep it as the regression pin for the new code. The last three pass today; they pin preserved behaviour.

- [ ] **Step 3: Replace the loop with one callback-replacement pass**

```ts
function interpolate(
  template: string,
  vars: Record<string, string> | undefined,
  allowed: readonly string[],
  strict: boolean,
): string {
  // SINGLE PASS over the ORIGINAL template: a substituted value is never part
  // of the string being scanned, so it can never re-open a token
  // (message-interpolate-token-reexpansion). The replacement is a CALLBACK,
  // never a string - String.replace with a string interprets $&/$1/$`/$' in
  // the VALUE, which would trade token re-expansion for $-expansion.
  const allowedSet = new Set(allowed);
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, token: string) => {
    if (!allowedSet.has(token)) return match; // undeclared -> literal, as before
    const value = vars?.[token];
    if (typeof value !== 'string') {
      if (strict) {
        throw new Error(`resolveMessage: missing interpolation var "${token}"`);
      }
      return ''; // operator override degrades, never crashes a send path
    }
    return value;
  });
}
```

Keep the existing docblock, appending one paragraph explaining single-pass + callback (cite the issue slug). The token-charset assumption (`[A-Za-z][A-Za-z0-9_]*`) is guarded STRUCTURALLY, not by grep (seven `vars` arrays are spread-built and grep cannot see them): add one test iterating `MESSAGE_CATALOG` and asserting every declared var of every entry matches `/^[A-Za-z][A-Za-z0-9_]*$/` - it guards future entries too.

- [ ] **Step 4: Run the full messages suite** - `cd app && npx vitest run test/messages/ test/tourCopy.test.ts`. Expected: PASS (tour copy composes through this function; a behaviour change here shows up there first).
- [ ] **Step 5: Commit** - `git add app/src/messages/resolve.ts app/test/messages/resolve.test.ts && git commit` with message `fix(messages): single-pass interpolate - substituted values are never rescanned`.
- [ ] **Step 6: Mark the issue** - edit `docs/issues/message-interpolate-token-reexpansion.md`: `status: resolved`, `resolved: 2026-08-31`, add `**Resolution (2026-08-31).** Single-pass callback replacement in interpolate(); regression tests in app/test/messages/resolve.test.ts.` Commit it (`docs(issues): close message-interpolate-token-reexpansion`).

### Task 2: Three skip tokens across all six sites (spec 4.3, 7.2)

**Files:**
- Modify: `app/src/repos/tourRemindersRepo.ts:38` (`ReminderSkipReason`)
- Modify: `app/src/jobs/tourReminders.ts:1317-1330` (`ForceSendRefusal` union)
- Modify: `dashboard/src/api/types.ts` - `TourReminderView.skipReason` union (`:1207-1223`), `REMINDER_SKIP_REASON_LABELS` (`:1271`), `SEND_NOW_ERROR_COPY` (`:1294`)
- Test: `dashboard/src/api/types.test.ts` (`SKIP_REASONS` at `:95` + a NEW send-now completeness test)

**Interfaces:**
- Produces (later tasks consume these exact strings): skip reasons `'tour_already_passed' | 'kind_retired' | 'names_unavailable'`; refusal reasons `'tour_already_passed' | 'kind_retired'` added to `ForceSendRefusal`; labels `the tour had already happened` / `this reminder is no longer sent` / `couldn't look up the names`.

- [ ] **Step 1: Extend `SKIP_REASONS` in `dashboard/src/api/types.test.ts` first** - add the three strings to the array at `:95`. Run `cd dashboard && npx vitest run src/api/types.test.ts`. Expected: FAIL twice ("carries a staff-facing label" and the exact-keys test) - proving site 4 enforces sites 2-3.
- [ ] **Step 2: Add a send-now completeness test in the same file** (spec 4.3: site 6 is the one nothing enforces):

```ts
describe('SEND_NOW_ERROR_COPY', () => {
  // Refusal codes whose generic "try again" fallback would be a LIE - the
  // condition is permanent, retrying can never work. Every such code MUST
  // carry explicit copy. names_unavailable is deliberately absent: there the
  // generic retry sentence is the right advice (spec 7.2).
  const PERMANENT_REFUSALS = ['tour_already_passed', 'kind_retired'];
  it('carries explicit copy for every permanent refusal', () => {
    for (const code of PERMANENT_REFUSALS) {
      expect(sendNowErrorMessage(code), code).not.toBe(
        "Couldn't send that just now - please try again.",
      );
    }
  });
});
```

`SEND_NOW_ERROR_COPY` is module-private; test through the exported `sendNowErrorMessage` as above. Run: FAIL (both fall through to the fallback).

- [ ] **Step 3: Make all six sites green.** App side - `ReminderSkipReason` gains three members with docblocks:

```ts
  /** Phase B (2026-08-31): the tour had already started when this rung came
   *  due (fire-time past-tour gate, jobs/tourReminders.ts) or was swept
   *  (scripts/retire-paused-tour-reminders.ts). Applies only to rungs whose
   *  own dueAt precedes the tour - never no_show_checkin. */
  | 'tour_already_passed'
  /** Phase B: the rung's KIND is discontinued (confirmation). Written by the
   *  one-time sweep script ONLY - the runtime poll EXCLUDES discontinued
   *  kinds rather than claim-skipping them (DISCONTINUED_REMINDER_KINDS),
   *  so this token has no in-app writer. */
  | 'kind_retired'
  /** Phase B (ledger item 7): name resolution kept THROWING for more than
   *  ROSTER_UNAVAILABLE_GRACE_MS past dueAt - the bounded twin of
   *  roster_unavailable, decided at both unclaimed-return sites. */
  | 'names_unavailable'
```

`ForceSendRefusal` (jobs/tourReminders.ts:1317-1330) gains `'tour_already_passed' | 'kind_retired'` with one-line docblocks (produced in Tasks 3 and 7; the union lands here so both tasks compile against it). Dashboard - mirror the three into the `skipReason` wire union, add the three label entries (exact copy from the Interfaces block above; labels use no underscore - the "never a machine token" test enforces that), and add to `SEND_NOW_ERROR_COPY`:

```ts
  // Reminder-only, PERMANENT refusals (Phase B). The generic retry fallback
  // would be a lie for both - nothing about retrying can change the outcome.
  tour_already_passed: 'That tour has already happened, so nothing was sent.',
  kind_retired: 'Confirmation texts are no longer sent, so nothing was sent.',
```

- [ ] **Step 4: Run** `cd dashboard && npx vitest run src/api/types.test.ts` (PASS) and `cd app && npx tsc --noEmit -p .` via `npm run typecheck` from the repo root (PASS - the refusal members are additive).
- [ ] **Step 5: Commit** - explicit paths, message `feat(reminders): three Phase B skip/refusal tokens across all six sites`.

### Task 3: Shared past-tour predicate + fire-time gate + force-send refusal (spec 4.2, 6.1a)

**Files:**
- Modify: `app/src/jobs/tourReminders.ts` (new export + `processReminderRow` head + `forceSendReminder` + `resolveReminderTarget` signature)
- Test: `app/test/tourReminders.test.ts`

**Interfaces:**
- Produces: `export function retiredByTourStart(row: Pick<TourReminderItem, 'dueAt'>, scheduledAt: string | undefined, now: string): boolean` - Task 4's sweep planner imports THIS function (spec 4.2: one predicate, two enforcements). `resolveReminderTarget` gains an optional trailing `tour?: TourItem` param (pre-fetched tour; skips its own read when supplied).

- [ ] **Step 1: Write the predicate tests** (append a `describe('retiredByTourStart')` block):

```ts
import { retiredByTourStart } from '../src/jobs/tourReminders.js';

describe('retiredByTourStart - the ONE past-tour predicate (poll gate, force-send, sweep)', () => {
  const T = '2026-08-01T15:00:00.000Z'; // tour start
  it('true: a pre-tour rung after the tour started', () => {
    expect(retiredByTourStart({ dueAt: '2026-08-01T14:00:00.000Z' }, T, '2026-08-01T15:00:01.000Z')).toBe(true);
  });
  it('false: the tour has not started yet', () => {
    expect(retiredByTourStart({ dueAt: '2026-08-01T14:00:00.000Z' }, T, '2026-08-01T14:59:59.000Z')).toBe(false);
  });
  it('false: no_show_checkin shape - dueAt AFTER the tour is exempt by construction', () => {
    expect(retiredByTourStart({ dueAt: '2026-08-01T15:30:00.000Z' }, T, '2026-08-01T16:00:00.000Z')).toBe(false);
  });
  it('false: absent or unparseable scheduledAt (invalid_schedule owns those)', () => {
    expect(retiredByTourStart({ dueAt: '2026-08-01T14:00:00.000Z' }, undefined, '2026-08-02T00:00:00.000Z')).toBe(false);
    expect(retiredByTourStart({ dueAt: '2026-08-01T14:00:00.000Z' }, 'not-a-date', '2026-08-02T00:00:00.000Z')).toBe(false);
  });
  it('normalizes a non-canonical ISO scheduledAt before comparing', () => {
    expect(retiredByTourStart({ dueAt: '2026-08-01T14:00:00.000Z' }, '2026-08-01T15:00:00Z', '2026-08-01T15:00:01.000Z')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to FAIL** ("retiredByTourStart is not a function").
- [ ] **Step 3: Implement the predicate** (place near `computeDueAt`; NOT named "start passed" - spec 6.1a naming rule):

```ts
/**
 * THE past-tour predicate (Phase B 6.1a): a rung whose OWN dueAt precedes the
 * tour, on a tour that has already started, must not send - its copy assumes
 * the tour has not happened yet. no_show_checkin (dueAt = scheduledAt + 30m)
 * is exempt BY CONSTRUCTION, never by a name in a list: its dueAt does not
 * precede the tour. Absent/unparseable scheduledAt -> false; invalid_schedule
 * owns those rows and this gate must not steal the more accurate token.
 *
 * SHARED with scripts/retire-paused-tour-reminders.ts (sweep population A) so
 * the sweep and the runtime can never disagree about the same row.
 */
export function retiredByTourStart(
  row: Pick<TourReminderItem, 'dueAt'>,
  scheduledAt: string | undefined,
  now: string,
): boolean {
  if (typeof scheduledAt !== 'string') return false;
  const start = Date.parse(scheduledAt);
  if (!Number.isFinite(start)) return false;
  const startIso = new Date(start).toISOString();
  return row.dueAt < startIso && now >= startIso;
}
```

- [ ] **Step 4: Run to PASS**, commit (`feat(reminders): shared past-tour predicate`).
- [ ] **Step 5: Write the gate tests** - in the existing poll rigs (the `createFakeWorld` pattern, e.g. the test at `app/test/tourReminders.test.ts:1933` shows arm-then-tick):

```ts
it('past-tour gate: a pre-tour rung due after the tour started is claim-skipped tour_already_passed on the FIRST tick', async () => {
  // Arm a normal future ladder via armTourReminders, then tick with now AFTER
  // the tour (this task is SELF-SUFFICIENT - do not depend on Task 5's helper).
  // Assert: the en_route row has skippedAt defined, skipReason 'tour_already_passed',
  // world.sent stays empty, and a SECOND tick sends nothing and re-skips nothing.
});
it('past-tour gate outranks supersededInBatch: a post-tour catch-up batch gives BOTH rungs tour_already_passed', async () => {
  // Seed morning_of AND en_route both pending and due via tourRemindersRepo
  // .create directly (self-sufficient), tour already past. Tick once.
  // Assert BOTH rows carry skipReason 'tour_already_passed' and NEITHER
  // carries 'quiet_hours_superseded' - the ledger-item-8 chip shape must not
  // appear (spec 6.1a precedence table).
});
it('past-tour gate outranks the quiet-hours backstop: a past-tour rung due inside the window retires instead of re-listing', async () => {
  // quietHoursEnabled with `now` inside the window and the tour in the past:
  // assert skippedAt set on the first tick (today it would return unclaimed).
});
it('no_show_checkin survives the gate: force-send after the tour still sends', async () => {
  // Create a no_show_checkin row (manual kind - repo.create), tour in the past;
  // forceSendReminder -> outcome 'sent'.
});
it('force-send on a past-tour pre-tour rung refuses tour_already_passed and leaves the row pending', async () => {
  // forceSendReminder on a morning_of with the tour past ->
  // { outcome: 'refused', reason: 'tour_already_passed' }; row still has no skippedAt.
});
```

Write them as real tests against the rigs in the file (copy the seeding idioms of the neighbouring cases); the comments above are the required assertions, not placeholders to leave.

- [ ] **Step 6: Run to FAIL, then implement.** In `processReminderRow`, ABOVE the `supersededInBatch` block (`:888`): fetch the tour first and gate:

```ts
  // PAST-TOUR GATE (Phase B 6.1a) - FIRST, above supersededInBatch and the
  // quiet-hours backstop. Below supersededInBatch, a post-tour catch-up batch
  // retires morning_of as "superseded by" an en_route this gate then retires,
  // putting the ledger-item-8 chip shape on the panel on the ROUTINE
  // worker-downtime path. Below isQuietTime, a past-tour rung due inside the
  // window re-lists unclaimed every tick until quiet-end instead of retiring
  // once. The tour read moves up here with it (resolveReminderTarget accepts
  // the pre-fetched tour, so this is a hoist, not a second read).
  const tour = await deps.toursRepo.getById(row.tourId);
  if (tour === undefined) {
    await claimSkipRow(row, 'tour_missing', now, deps);
    return;
  }
  if (retiredByTourStart(row, tour.scheduledAt, now)) {
    log.info(
      { reminderId: row.reminderId, tourId: row.tourId, kind: row.kind },
      'tour reminder: tour already started - retiring (claim-skipped)',
    );
    await claimSkipRow(row, 'tour_already_passed', now, deps, tour.tenantId);
    return;
  }
```

**The tours repo method is `get`, not `getById`** (`toursRepo.ts:131`) - the snippet above uses `deps.toursRepo` naming; verify the deps member name AND use `.get(row.tourId)`. Match the existing tour-missing behaviour inside `resolveReminderTarget` (mirror its claim-skip reason exactly - read it before writing this), and grep the comments around its tour fetch for any the hoist falsifies. STATED CONSEQUENCE OF THE HOIST, pin it in a test: a row that is both superseded-in-batch AND tour-missing now takes `tour_missing` (previously `quiet_hours_superseded`) - more truthful, accepted. Thread `tour` into `resolveReminderTarget(row, deps, log, tour)` and have it skip its own fetch when the argument is present.

In `forceSendReminder`, READ THE FUNCTION'S STRUCTURE FIRST and place the refusal where the local `refuse` helper is in scope, after target resolution succeeds and BEFORE compose/claim:

```ts
  if (retiredByTourStart(row, target.tour.scheduledAt, nowIso)) {
    // PRE-CLAIM REFUSAL, same predicate as the poll gate (never a name-in-a-
    // list exception): no_show_checkin's dueAt follows the tour, so the one
    // rung an operator NEEDS after a no-show passes this untouched.
    return refuse('tour_already_passed');
  }
```

**NO route edit.** The send-now handler (`routes/tourReminders.ts:421-472`) passes `result.reason` through generically at `:466` with the honest re-read view attached - a new refusal reason reaches the wire and the dashboard copy map (Task 2) with zero route changes. (An earlier draft pointed at `:654-690`, which is the no-show-DRAFT route, and prescribed a shape that would have dropped the `reminder` field the panel needs.) Refusal PRECEDENCE, pinned by a test in Task 7: `kind_retired` (row lookup, Task 7) outranks `tour_already_passed` (post-target-resolution, here) outranks `names_unavailable` (compose).

- [ ] **Step 7: Also rewrite the two comments the gate falsifies** - the `beforeStart` docblock's "can never be held past the tour" sentence (`:944-951`) now holds because of THIS gate; say so. And the `claimSkipRow` docblock (`:640-643`) gains the third reason-category sentence: sweep-only tokens (`kind_retired`) that no poll path passes.
- [ ] **Step 8: Fix the cat-4 e2e site NOW, in this task** - `e2e/tests/scenarios/tours.spec.ts:283-287` ticks past the tour and documents that earlier rungs fire. Rewrite that block's comment and assertions: the tick now RETIRES pre-tour rungs `tour_already_passed`; assert the retirement (panel or API state), not arrival. Do not leave a green-but-wrong spec for Task 6 to find.
- [ ] **Step 9: Run** `cd app && npx vitest run test/tourReminders.test.ts`, then the FULL app suite (`cd app && npx vitest run`) so red from this task is attributed here, not discovered at Task 9. PASS both. Commit (`feat(reminders): fire-time past-tour gate, first in precedence`).

### Task 4: Retirement sweep script + RUNBOOK (spec 4)

**Files:**
- Create: `app/scripts/retire-paused-tour-reminders.ts` (model: `app/scripts/backfill-relay-optout-flag.ts`)
- Create: `app/test/retirePausedTourReminders.test.ts`
- Modify: `RUNBOOK.md` (new operational entry)

**Interfaces:**
- Consumes: `retiredByTourStart` from Task 3; `ReminderSkipReason` tokens from Task 2.
- Produces: `export function planReminderRetirement(row: Pick<TourReminderItem,'kind'|'dueAt'|'sentAt'|'canceledAt'|'skippedAt'>, scheduledAt: string | undefined, now: string): 'tour_already_passed' | 'kind_retired' | 'skip'` (exported from the script file, like `planRelayOptOutBackfill`).

- [ ] **Step 1: Write the planner tests** (pure; no DynamoDB):

```ts
import { describe, expect, it } from 'vitest';
import { planReminderRetirement } from '../scripts/retire-paused-tour-reminders.js';

const NOW = '2026-08-31T12:00:00.000Z';
const PAST = '2026-08-30T15:00:00.000Z';
const FUTURE = '2026-09-05T15:00:00.000Z';
const pending = (kind: string, dueAt: string) => ({ kind, dueAt }) as never;

describe('planReminderRetirement', () => {
  it('population A: pre-tour pending rung on a past tour -> tour_already_passed', () => {
    expect(planReminderRetirement(pending('morning_of', '2026-08-30T11:00:00.000Z'), PAST, NOW)).toBe('tour_already_passed');
  });
  it('population A uses the SHARED predicate: no_show_checkin on a past tour is NOT swept', () => {
    expect(planReminderRetirement(pending('no_show_checkin', '2026-08-30T15:30:00.000Z'), PAST, NOW)).toBe('skip');
  });
  it('population B: pending confirmation on a FUTURE tour -> kind_retired', () => {
    expect(planReminderRetirement(pending('confirmation', '2026-08-20T09:00:00.000Z'), FUTURE, NOW)).toBe('kind_retired');
  });
  it('both populations: confirmation on a PAST tour takes population A token', () => {
    expect(planReminderRetirement(pending('confirmation', '2026-08-30T09:00:00.000Z'), PAST, NOW)).toBe('tour_already_passed');
  });
  it('a pending non-confirmation rung on a future tour is untouched', () => {
    expect(planReminderRetirement(pending('day_before', '2026-09-04T23:30:00.000Z'), FUTURE, NOW)).toBe('skip');
  });
  it('idempotent: sent, canceled, and already-skipped rows all skip', () => {
    for (const marker of [{ sentAt: NOW }, { canceledAt: NOW }, { skippedAt: NOW }]) {
      expect(planReminderRetirement({ kind: 'confirmation', dueAt: PAST, ...marker } as never, PAST, NOW)).toBe('skip');
    }
  });
  it('operator-restored past-tour rung is swept too (spec 4.2 ruling)', () => {
    // restore clears canceledAt -> plain pending; nothing distinguishes it, by design.
    expect(planReminderRetirement(pending('en_route', '2026-08-30T14:00:00.000Z'), PAST, NOW)).toBe('tour_already_passed');
  });
});
```

- [ ] **Step 2: FAIL, then implement.** Planner:

```ts
export function planReminderRetirement(
  row: Pick<TourReminderItem, 'kind' | 'dueAt' | 'sentAt' | 'canceledAt' | 'skippedAt'>,
  scheduledAt: string | undefined,
  now: string,
): 'tour_already_passed' | 'kind_retired' | 'skip' {
  if (row.sentAt !== undefined || row.canceledAt !== undefined || row.skippedAt !== undefined) {
    return 'skip'; // terminal rows are never touched - what makes re-runs safe
  }
  // Population A first: a row in both populations takes A's token (spec 4.2).
  if (retiredByTourStart(row, scheduledAt, now)) return 'tour_already_passed';
  if (row.kind === 'confirmation') return 'kind_retired';
  return 'skip';
}
```

Script body: copy `backfill-relay-optout-flag.ts`'s frame verbatim (Scan pages over reminder rows, resolve each row's tour once via a `Map<tourId, TourItem|undefined>` cache, plan, then a CONDITIONAL `UpdateCommand` setting `skippedAt`/`skipReason` with `attribute_not_exists(sentAt) AND attribute_not_exists(canceledAt) AND attribute_not_exists(skippedAt)`, catching `ConditionalCheckFailedException` as a logged skip). `--dry-run` prints counts per token and writes nothing. Logs COUNTS + tourId/reminderId only - never a name, phone, or body. Header comment: the run instructions, the "human runs this against real envs, agents hermetic-local only" rule, and that re-running after the deploy is safe and expected. Check the reminder rows' actual key/table layout in `tourRemindersRepo.ts` BEFORE writing the Scan (do not guess the PK shape).

- [ ] **Step 3: REQUIRED - integration-test the mutating half against DynamoDB Local** (the repo's standard dynamo-backed test idiom - `hc-test-*` tables, same as the repo suites). Export the script's apply function and, in `retirePausedTourReminders.test.ts`, seed one row per planner outcome plus one already-skipped row, then assert: `--dry-run` writes NOTHING and reports the right counts; a real run stamps exactly the planned rows with the planned tokens; a rung that went `sentAt` between plan and write is left untouched (the conditional); a SECOND run is a no-op. The scan pagination, tour cache, conditional write, and PII-safe logging are exactly the parts the pure planner tests cannot see - they do not ship untested.
- [ ] **Step 4: RUNBOOK entry** - add a section "One-time: retire tour reminders armed during the 2026-08 pause": the exact command for dev and prod (`tsx app/scripts/retire-paused-tour-reminders.ts --dry-run` first), what the two tokens mean, safe-to-re-run note, and the spec 3.2 preferred order (sweep, then deploy).
- [ ] **Step 5: Commit** all three files, message `feat(scripts): one-time sweep retiring reminders armed during the pause`.

### Task 5: Unit-test immediate-send vehicle + convert the confirmation rides (spec 10, 10a.1)

**Files:**
- Modify: `app/test/tourReminders.test.ts` (helper + conversions)
- Possibly touched by classification: `app/test/tourRemindersApi.test.ts`, `toursApi.test.ts`, `contactTimeline.test.ts`, `relayApi.test.ts`, `devGating.test.ts`, `placementConvert.test.ts`, `seedLive.test.ts`

**Interfaces:**
- Produces: a file-local helper in `tourReminders.test.ts`:

```ts
/** Immediate-send vehicle (Phase B spec 10): repo.create does NOT drop a
 *  past-due row (only armTourReminders does), so this yields a due row of any
 *  kind with zero production code. PRECONDITION (6.1a): dueAt must be BEFORE
 *  the tour's scheduledAt or the past-tour gate retires it - callers pass the
 *  tour's own times, never hardcoded dates. */
async function createDueReminder(
  repo: TourRemindersRepo,
  tourId: string,
  kind: ReminderKind,
  dueAt: string,
): Promise<TourReminderItem> {
  return repo.create({ tourId, kind, dueAt });
}
```

- [ ] **Step 1: Derive the per-site classification.** Run `grep -n "confirmation" app/test/tourReminders.test.ts` and each of the seven other test files; write the classification (cat 1 convert / cat 2 arm-assertion / keep) as a table into `.superpowers/sdd/confirmation-conversion-worklist.md` (run state, not committed). Rules: a site that arms a ladder and then ticks at `now0` to get a send is cat 1 -> replace with `createDueReminder(tourReminders, tour.tourId, 'day_before', now0)` where the tour's `scheduledAt` is after `now0`, and update the asserted body from `rungBody('confirmation', ...)` to the new kind's body. A site asserting confirmation ARMS, or its position (`pending set is ['confirmation', ...]`, "next" chips) is cat 2 -> LEAVE IT GREEN in this task (confirmation still arms); Task 9 rewrites those alongside the kind removal. `computeDueAt.test.ts` and `tourCopy.test.ts` sites: keep unchanged, both pin surfaces the kind stays valid on.
- [ ] **Step 2: Add the helper and convert every cat-1 site in `tourReminders.test.ts`.** Mechanical but per-site: the replacement rung's dueAt must satisfy `dueAt < scheduledAt` AND `dueAt <= now-of-tick`. Where a case needs "armed at booking AND due immediately" semantics that no real rung has anymore, the helper IS the semantics - the case now tests the send path against a directly-created row, which is what it was really testing all along.
- [ ] **Step 3: Convert cat-1 sites in the other seven files** the worklist found, same pattern (each file has its own rig; reuse its local repo handle).
- [ ] **Step 4: Run the touched files** - `cd app && npx vitest run test/tourReminders.test.ts test/tourRemindersApi.test.ts test/toursApi.test.ts test/contactTimeline.test.ts test/relayApi.test.ts test/devGating.test.ts test/placementConvert.test.ts test/seedLive.test.ts`. Expected: PASS - nothing production-side changed in this task.
- [ ] **Step 5: Commit** (`test(reminders): immediate-send vehicle replaces confirmation rides`).

### Task 6: E2E vehicle conversion (spec 10, 10a.1)

**Files:**
- Modify: `e2e/tests/scenarios/scheduled-visibility.spec.ts`, `e2e/tests/scenarios/tours.spec.ts`, `e2e/tests/tour-roster.spec.ts`, `e2e/scenarios/steps.ts`

- [ ] **Step 1: Classify the 15 e2e sites** (6+6+1 spec sites + 2 steps.ts) into the worklist file. Known cat-2 anchors: `tour-roster.spec.ts:488-501` and `scheduled-visibility.spec.ts:234-259` (arm-time/next-rung semantics - Task 9 territory; leave green now). `tours.spec.ts:283-287` was already rewritten in Task 3 step 8.
- [ ] **Step 2: Convert the cat-1 sites** to the existing vehicle: `await flow.tickTourReminders(justAfter(await flow.armedReminderDueAt('day_before')))` (both helpers exist, `steps.ts:2013-2046`). EVERY converted site adds the supersession expectation (spec 10): a clock-travel tick past a later rung's dueAt claim-skips the earlier same-tour rungs `quiet_hours_superseded` - assert the retirement (via the reminders API or the panel chip) in the same spec instead of being surprised by it. Where a spec only needs "a reminder arrived", prefer ticking the EARLIEST still-pending rung so nothing else is pulled into the batch.
- [ ] **Step 2a: LIVE-WORKER AUDIT (the unpause races the suite).** With the pause lifted (Task 7), the e2e stack's REAL worker poll becomes a live wall-clock sender for the first time since 2026-08-20. The harness's standing discipline already covers arrivals (`steps.ts:1711-1713`: assert ARRIVAL, never which trigger fired), but a rung a spec leaves PENDING and asserts as `upcoming` can now be fired mid-spec if its dueAt passes during the run. Audit EVERY touched spec (and `quiet-hours.spec.ts`) for pending-rung assertions whose dueAt could fall inside the spec's runtime window; fixtures for rungs meant to stay upcoming use far-future dueAts (`tourSchedule(72)`-style), never near-now ones. Record the audit's per-spec outcome in the conversion worklist.
- [ ] **Step 3: Update the shared docblocks this conversion falsifies** - `tickTourReminders`'s docblock (`steps.ts:2034-2038`) says "Omitting `now` ... fires the just-armed 'confirmation' rung", which Task 9 makes false; rewrite it now to describe the future-rung idiom as the primary use.
- [ ] **Step 4: Do not run the full e2e suite here** (Task 9 runs it); the conversions are proven by that run.
- [ ] **Step 5: Commit** (`test(e2e): reminder specs ride the future-rung tick vehicle`).

### Task 7: `DISCONTINUED_REMINDER_KINDS` - app side (spec 3.1, 5-interlock)

**Files:**
- Modify: `app/src/jobs/tourReminders.ts` (new set, poll filter `:602-603`, `forceSendReminder`, `MANUAL_ONLY_REMINDER_KINDS` empty + docblock rewrite `:173-206`)
- Modify: `app/src/routes/tourReminders.ts` (send-now 409 mapping for `kind_retired`)
- Modify: `app/src/routes/dev.ts:404-422` (delete the divergence override)
- Test: `app/test/tourReminders.test.ts`, `app/test/devGating.test.ts`

**Interfaces:**
- Produces: `export const DISCONTINUED_REMINDER_KINDS: ReadonlySet<ReminderKind>` (holding `'confirmation'`) - Task 8's route/timeline reads import it. `MANUAL_ONLY_REMINDER_KINDS` becomes an EMPTY set (kept exported; its docblock now describes the empty-idle state and points discontinued readers at the new set).

- [ ] **Step 1: Write the failing tests:**

```ts
describe('DISCONTINUED_REMINDER_KINDS', () => {
  it('the poll EXCLUDES a due discontinued row - not sent, not claim-skipped, left pending', async () => {
    // createDueReminder(..., 'confirmation', ...) with a FUTURE tour, tick at now:
    // world.sent empty, row still has no sentAt/skippedAt after two ticks.
  });
  it('with MANUAL_ONLY empty, the three live rungs auto-send', async () => {
    // Arm a ladder, tick past day_before: it SENDS - the unpause, pinned.
  });
  it('forceSendReminder REFUSES kind_retired for a discontinued kind, pre-claim', async () => {
    // outcome 'refused', reason 'kind_retired'; row untouched.
  });
  it('refusal precedence: a discontinued rung on a PAST tour refuses kind_retired, not tour_already_passed', async () => {
    // Pins the order Task 3 stated: kind check at row lookup runs first.
  });
  it('the dev tick does NOT bypass the discontinued set', async () => {
    // runDueTourReminders with manualOnlyKinds: new Set() (the old override
    // shape) still refuses to send a confirmation row - the discontinued
    // filter is not injectable.
  });
});
```

Write them fully against the existing rigs.

- [ ] **Step 2: FAIL, then implement.** New set directly below the (now empty) manual-only set:

```ts
/**
 * do-not-remove-without-reading - PERMANENT, Phase B (2026-08-31).
 *
 * Kinds that are DISCONTINUED: no path may ever send one. Distinct from
 * MANUAL_ONLY_REMINDER_KINDS on purpose - "paused" means a human decides WHEN
 * this goes out (Send now works, chip says Paused); "discontinued" means it
 * NEVER goes out (force-send refuses kind_retired, chip says "no longer
 * sent"). Conflating them put a working Send now button beside a Paused chip
 * on a kind we had retired. Four read surfaces, all mandatory: the poll
 * filter below, forceSendReminder, routes/tourReminders.ts's chip branch, and
 * routes/contactTimeline.ts's own read. NOT injectable via deps - e2e must
 * never grow a send path production lacks.
 *
 * confirmation: founder decision, Sam 2026-08-24 - "No confirmation text at
 * all - I'm scheduling manually, so it's redundant." Armed rows from the
 * pause era are retired by scripts/retire-paused-tour-reminders.ts; this set
 * is what makes that sweep hygiene rather than a race against the deploy.
 */
export const DISCONTINUED_REMINDER_KINDS: ReadonlySet<ReminderKind> = new Set<ReminderKind>([
  'confirmation',
]);
```

Poll filter becomes `const blocked = (r: TourReminderItem) => manualOnly.has(r.kind) || DISCONTINUED_REMINDER_KINDS.has(r.kind);` applied where `:603` filters today (keep the held-back log line; count both causes separately in its fields). `forceSendReminder` refuses immediately after the row lookup - CHECK where the local `refuse` helper is declared first and place the guard where it is in scope: `if (DISCONTINUED_REMINDER_KINDS.has(row.kind)) return refuse('kind_retired');`. This position (before target resolution) IS the refusal precedence Task 3 stated - the precedence test above pins it. NO route edit (the send-now handler's generic `result.reason` passthrough at `routes/tourReminders.ts:466` carries it). Empty `MANUAL_ONLY_REMINDER_KINDS` (`new Set<ReminderKind>([])`) and REWRITE its whole docblock (spec 3.1/R3-9): what the set is FOR (a temporary human hold with Send now intact), that it is empty = fully automatic today, the 2026-08-20..2026-08-31 pause as history with the founder attributions kept, "TO PAUSE AGAIN: add kinds here. Nothing else has to change." and a pointer: "a kind that must NEVER send belongs in DISCONTINUED_REMINDER_KINDS below, not here."

- [ ] **Step 3: Delete the dev-tick divergence** - `app/src/routes/dev.ts:404-422`: remove `manualOnlyKinds: new Set()` and the whole DELIBERATE DIVERGENCE comment (its own text orders this deletion); the tick now runs production semantics. Fix `app/test/devGating.test.ts` expectations accordingly (classified in Task 5's worklist).
- [ ] **Step 4: Sweep the other `manualOnlyKinds` injectors** - `grep -rn "manualOnlyKinds\|manualOnlyReminderKinds" app/src e2e` and re-read each: injection seams REMAIN, and their documented purpose CHANGES with the empty default - they are now the way tests exercise pause-mode behaviour that production no longer exhibits by default. Rewrite each seam docblock to say exactly that (`routes/api.ts:389`, `routes/contactTimeline.ts:115`, `routes/tourReminders.ts:110` at minimum), and rewrite any comment claiming "production holds everything back".
- [ ] **Step 5: Run** `cd app && npx vitest run test/tourReminders.test.ts test/devGating.test.ts test/tourRemindersApi.test.ts`, then the FULL app suite (`cd app && npx vitest run`) - the unpause fans out further than its named files. PASS both. Commit (`feat(reminders): discontinued-kind guard; MANUAL_ONLY emptied - the unpause`).

### Task 8: Discontinued on the read surfaces (spec 3.1 rows 3-4, 3.1a)

**Files:**
- Modify: `app/src/services/scheduledSendSuppression.ts:1-4` (union), `dashboard/src/api/types.ts` (union `:1144-1177`, lead `:1167`, **`REMINDER_SUPPRESSION_LABELS` `:1259-1268`** - the map that actually renders the TOUR panel chip), `app/src/routes/tourReminders.ts:576-597` (chip branch), `app/src/routes/contactTimeline.ts` (its own read - see step 2a), `dashboard/src/routes/tours/RemindersPanel.tsx` (chip copy), **the contact timeline's scheduled-card renderer** (its own exhaustive `Record` over the same union - find it: `grep -rln "suppressionNote\|TimelineScheduled" dashboard/src/routes/contact/`), `dashboard/src/routes/placements/DeadlinesNudgesCard.tsx:64` (ONE label entry)
- Test: `app/test/tourRemindersApi.test.ts`, `app/test/contactTimeline.test.ts`, `dashboard/src/api/types.test.ts`

**Widening the union breaks THREE exhaustive `Record`s at compile time - all three get an entry, and only the placement one is compile-completeness-only:** `REMINDER_SUPPRESSION_LABELS` (the tour chip pairs `suppressionLead` + this label), the timeline scheduled-card's record (the FOURTH unenumerated reader the spec's standing hazard predicted), and `DeadlinesNudgesCard`'s (nothing else on the placement surface - spec 3.1a's scope ruling). Label value for all three: `turned off` (step 2b's copy ruling). `npm run typecheck` after the union edit is the enumerator: every red site is a reader; fix each, and if it finds a record this list missed, add it to the findings for the handback. The typecheck CANNOT see the two equality-tested label FUNCTIONS - step 2b handles those by hand.

- [ ] **Step 1: Failing tests.** (a) Route test: GET reminders for a tour with a pending `confirmation` row returns `suppression: { reason: 'discontinued' }` on that rung - for BOTH a self_guided AND a landlord_led tour (the group-routed case is the one `suppressionOf` would lose, spec 3.1a). (b) Timeline test: the upcoming bucket's confirmation card carries the discontinued suppression, not `paused`, with the timeline's OWN read (inject nothing). (c) Dashboard: extend the types test - `suppressionLead('discontinued')` returns `'No longer sent'`, `REMINDER_SUPPRESSION_LABELS['discontinued']` is `'turned off'`, and `suppressionNote('discontinued', ...)` contains no repeated phrase (the stutter guard).
- [ ] **Step 2: Implement.** Widen both unions with `| 'discontinued'`. `suppressionLead`: add `if (reason === 'discontinued') return 'No longer sent';` with a docblock line (terminal - neither a deferral nor a human hold; never "Paused"). Route chip branch (`:589-597`) - discontinued FIRST, outside the evaluator:

```ts
        const discontinued = DISCONTINUED_REMINDER_KINDS.has(row.kind);
        const paused = manualOnlyKinds.has(row.kind);
        const suppression =
          state !== 'upcoming'
            ? undefined
            : discontinued
              ? ({ reason: 'discontinued' } as const) // terminal; NEVER through suppressionOf - group-routed tours have no evaluator (spec 3.1a)
              : suppressionOf !== undefined
                ? suppressionOf(row.dueAt, paused)
                : paused
                  ? ({ reason: 'paused' } as const)
                  : undefined;
```

- [ ] **Step 2a: The timeline's derivation is NOT a copy of the tour panel's - READ IT FIRST.** `grep -n "manualOnlyReminderKinds" app/src/routes/contactTimeline.ts`, then read the whole consuming expression. It covers 1:1-routed rungs only and computes suppression in a single call-shaped formula, so the discontinued branch there is a simpler short-circuit ahead of that call, not a transplant of the tour route's ternary. Assert through the file's existing test idiom.
- [ ] **Step 2b: Renderers - the label FUNCTIONS fall through, not just the maps** (plan review PR2-2). `RemindersPanel.tsx:116-118` returns the Paused chip on `reason === 'paused'` EQUALITY and otherwise falls through to the "sends in Nh" fire-time promise - a `discontinued` reason renders the exact lie this mechanism ends. Add an explicit `discontinued` branch ABOVE the paused branch returning a "No longer sent" chip (lead alone, matching how Paused renders); failing test first. `ScheduledCard.tsx` has the same equality-then-fallthrough shape (`grep -n "paused" <the card file>` and read it) - same explicit branch, failing test first.
  **COPY RULING (PR2-3, avoids the "No longer sent - no longer sent" stutter):** `suppressionLead('discontinued')` = `No longer sent`; the LABEL entry in all three records = `turned off` - note form renders "No longer sent - turned off". `DeadlinesNudgesCard.tsx:64`: `discontinued: 'turned off',` - compile completeness only.

- [ ] **Step 3: Run** the three test files + `npm run typecheck` (the exhaustive Record is the compile check). PASS. Commit (`feat(reminders): discontinued reads on all four surfaces`).

### Task 9: Stop arming `confirmation` (spec 5) + cat-2 re-baselines + seeds

**Files:**
- Modify: `app/src/jobs/tourReminders.ts:235-240` (`REMINDER_KINDS`)
- Modify: cat-2 test sites (worklist from Tasks 5-6), `e2e/tests/tour-roster.spec.ts:488-501`, `e2e/tests/scenarios/scheduled-visibility.spec.ts:234-259` and the other arm-set assertions
- Modify: `app/src/lib/seed/matrix.ts:880-990`, `live.ts:9,506-523`, `lean.ts:423` (comments + pending confirmation rows)

- [ ] **Step 1: Remove `'confirmation'` from `REMINDER_KINDS`** with a comment mirroring the `no_show_checkin` note above it: the kind stays in the union / `computeDueAt` / `LADDER_ORDER` / catalog so in-flight and seeded rows still compose and display; arming stopped 2026-08-31 (founder decision 2026-08-24); sending is separately guarded by `DISCONTINUED_REMINDER_KINDS`.
- [ ] **Step 2: Run the app suite; re-baseline every red site by RE-DERIVING it** (never flip an expectation blind): arm-set assertions drop `confirmation` from expected pending sets ("the whole ladder" is now three auto rungs); "next rung" assertions shift to `day_before`.
- [ ] **Step 2a: The two e2e anchors are REDESIGNS, not re-baselines** - both mix cat-1 ticks with cat-2 position assertions and their PROOF STRATEGY dies with the kind. `scheduled-visibility.spec.ts:225-259`: its re-arm proof rides "the fresh confirmation arrives on a tick" - rebuild it on `day_before` (reschedule cancels the pending old row, a fresh one arms off the new time, and a FUTURE tick at `justAfter(armedReminderDueAt('day_before'))` proves arrival with a body composed off the new time - the block's own 2026-08-26 re-derivation comment shows the reasoning shape to follow, and the comment must be re-derived with it). Its `:111-165` confirmation panel walk becomes a `day_before` walk. `tour-roster.spec.ts:488-501`: same treatment - read the block's intent from its comments, rebuild on a live kind.
- [ ] **Step 3: Seeds.** `matrix.ts:987` seeds a pending confirmation row directly - decide per its own comment at `:880`: rows seeded to demo the PANEL keep the row (it now demos the "no longer sent" chip - update the comment to say that); rows seeded to be SENT by a tick must convert to a live kind. `live.ts:9,506-523`: the "four auto-armed rungs" comment becomes three; its armed-at-now confirmation expectations go. `lean.ts:423`: comment references the confirmation clamp - rewrite. `cast.ts:769-784` seeds SENT rows - keep, historical.
- [ ] **Step 4: Run** `cd app && npx vitest run` (full app suite - the arming change fans out) - PASS. Then run the FULL e2e suite (`npm run e2e` from the worktree root) - this is the tour half's checkpoint: Tasks 3-9 made a dozen e2e edits and this is their first pass/fail signal; do not let it wait for the final gate. PASS. Commit (`feat(reminders): confirmation no longer arms`).

### Task 10: `en_route` quiet-hours exemption + supersession widening (spec 6, 6.2)

**Files:**
- Modify: `app/src/jobs/tourReminders.ts` - arm loop (`:303-307`), fire-time backstop (`:910-916`), `supersededBySlot` (`:412-417`), `LADDER_ORDER` docblock (`:158-164`)
- Test: `app/test/tourReminders.test.ts`, plus `e2e/tests/scenarios/quiet-hours.spec.ts` re-read

- [ ] **Step 1: Failing tests:**

```ts
describe('en_route quiet-hours exemption (spec 6) + widened supersession (6.2)', () => {
  it('arm-time: en_route stores its RAW dueAt inside the quiet window; other rungs clamp', async () => {
    // Tour 04:00 local, quiet 21:00-08:00: en_route row dueAt is 03:00 local
    // (unclamped); morning_of row is clamped to 08:00 -> past_event/skip per
    // existing rules. Assert the stored en_route dueAt exactly.
  });
  it('fire-time: a due en_route sends during the quiet window; day_before defers', async () => {
    // Two due rows, now inside the window: en_route sends, day_before is left
    // unclaimed (re-listed), not skipped.
  });
  it('REGRESSION (the 08:30 double-send): morning_of clamped ONTO or PAST en_route is superseded at arm', async () => {
    // Tour 08:30 local, quiet 21:00-08:00, armed the evening before:
    // en_route dueAt 07:30 (unclamped), morning_of clamps to 08:00.
    // Assert morning_of is born skipped quiet_hours_superseded and en_route
    // is the only pending morning rung - ONE text will go out.
  });
  it('widened predicate is a NO-OP on an unclamped ladder', async () => {
    // Quiet hours disabled, ordinary afternoon tour: every rung arms pending,
    // zero supersession rows - byte-for-byte the pre-change arm result.
  });
});
```

- [ ] **Step 2: FAIL, then implement.** Arm loop: `dues.set(kind, kind === 'en_route' ? raw : clampOutOfQuietHours(raw, window));` with the founder-decision comment (Sam approved; spec 6; `clampOutOfQuietHours` itself untouched - shared helper). Fire-time backstop: `if (row.kind !== 'en_route' && isQuietTime(now, window)) { ...defer... }` plus a sentence in its comment (exempt kind; the past-tour gate above is what bounds the catch-up backlog). `supersededBySlot`:

```ts
    const supersededBySlot = REMINDER_KINDS.some((other) => {
      if (LADDER_ORDER.indexOf(other) <= myOrder) return false;
      const otherDue = dues.get(other);
      // WIDENED (Phase B 6.2): a LATER rung firing at or BEFORE this one makes
      // this one's copy stale - equality was only ever a proxy that held while
      // every rung clamped to the same window edge; the en_route exemption
      // breaks that coincidence (08:30 tour: en_route 07:30, morning_of
      // clamped 08:00 - reverse ladder order without this). On an unclamped
      // ladder rungs are strictly increasing, so this is false for every pair.
      // `undefined` never supersedes: absence is not an earlier send time.
      return otherDue !== undefined && otherDue <= dueAt && otherDue < scheduledIso;
    });
```

Rewrite the `LADDER_ORDER` docblock (`:158-164`): the old "clamping can only push an earlier rung forward onto a later one's slot" sentence is now false and is exactly what a reader would use to revert the predicate - replace with the inequality rationale. Leave `supersededInBatch` UNTOUCHED (spec 6.2 last paragraph - it already covers the catch-up case; do not "make it symmetric").

- [ ] **Step 3: THE THIRD SITE - the panel's quiet-hours suppression ESTIMATE** (spec 6 addendum, plan review P5). The route's estimate (`routes/tourReminders.ts:558-564`) evaluates the quiet-window disjuncts for EVERY rung, so an `en_route` due inside the window would chip "Will wait" while the poll now sends it - a promise the machinery immediately breaks. Exempt `en_route` from the QUIET disjuncts (not from the whole evaluator - opt-out / kill-switch / manual-mode reasons still apply) at BOTH tour surfaces that compute the estimate: `routes/tourReminders.ts:558-564`, and in `contactTimeline.ts` **at the REMINDER call site of the `quietFor` closure - never inside the closure itself** (plan review PR2-5: `quietFor` at `contactTimeline.ts:1305` is kind-blind and SHARED with the placement-nudge walk via `suppressionFor` at `:845`; an exemption inside it would strip quiet suppression from placement nudges too). `placementNudges.ts` has no `en_route` and is untouched. Failing test first: a pending `en_route` with dueAt inside the window carries NO `quiet_hours` suppression, while its `day_before` sibling does.
- [ ] **Step 4:** Re-read `e2e/tests/scenarios/quiet-hours.spec.ts` end to end against the new behaviour (its `:58` comment reasons about batches) and re-baseline any assertion the exemption changes - re-derive, never flip.
- [ ] **Step 5: Run** `cd app && npx vitest run test/tourReminders.test.ts test/tourRemindersApi.test.ts test/contactTimeline.test.ts test/seedLive.test.ts` - PASS (seedLive pins arm results and may need the exemption's dueAts re-derived). Commit (`feat(reminders): en_route quiet-hours exemption; supersession predicate widened`).

### Task 11: Bound the names re-list at BOTH sites (spec 7)

**Files:**
- Modify: `app/src/jobs/tourReminders.ts:1037-1043` (1:1) and `:1205-1216` (group)
- Test: `app/test/tourReminders.test.ts`

- [ ] **Step 1: Failing tests** - for EACH route (self_guided/1:1 and landlord_led/group): with the contacts (or units) repo stubbed to THROW, (a) inside the hour past dueAt the rung stays unclaimed and re-lists; (b) past the hour it is claim-skipped `names_unavailable` exactly once; (c) `forceSendReminder` on the still-pending rung refuses `names_unavailable` and never retires it. Drive the clock by ticking with `now = dueAt + 61min`.
- [ ] **Step 2: Implement** - both catch branches gain the bound, mirroring `roster_unavailable`'s shape at `:984-991`:

```ts
    if (err instanceof ReminderNamesUnavailableError) {
      // BOUNDED (Phase B, ledger item 7 - the acceptance that expired with the
      // pause): same grace as the roster twin. Past it the copy is stale
      // regardless of recovery - retire visibly instead of re-listing forever.
      if (rosterWaitExpired(row.dueAt, now)) {
        log.error(
          { reminderId: row.reminderId, tourId: row.tourId, kind: row.kind, dueAt: row.dueAt },
          'tour reminder: name resolution STILL failing past the grace window - retiring (claim-skipped)',
        );
        await claimSkipRow(row, 'names_unavailable', now, deps, tour.tenantId);
        return;
      }
      log.warn(
        { reminderId: row.reminderId, tourId: row.tourId, kind: row.kind },
        'tour reminder: name resolution read failed - leaving the rung unclaimed for the next tick',
      );
      return;
    }
```

At the group site, replace the ledger-item-7 acceptance comment (`:1205-1209`) - it is now discharged, not carried. `rosterWaitExpired` is already imported (`:56`). Force-send is UNCHANGED.

- [ ] **Step 3: Run, PASS, commit** (`feat(reminders): one-hour names bound at both unclaimed-return sites`).

### Task 12: The `overdue` flag (spec 8)

**Files:**
- Modify: `app/src/routes/tourReminders.ts` - `TourReminderView` (`:138`), `viewOf` (`:336-345`), GET projection (`:598-609`)
- Modify: `dashboard/src/api/types.ts:1191` (wire twin), `dashboard/src/routes/tours/RemindersPanel.tsx` (chip)
- Test: `app/test/tourRemindersApi.test.ts`, one e2e assertion in an existing scheduled-visibility case

- [ ] **Step 1: Failing route tests** - GET: an upcoming rung with `dueAt` in the past carries `overdue: true`; a future one carries NO `overdue` key (conditional-spread omission); a sent/skipped rung never carries it. PATCH (cancel/restore round-trip): the state echo computes it identically.
- [ ] **Step 2: Implement.** Both builders compute their own `nowIso` (spec 8.2 - the GET route's existing one is block-scoped; do NOT lift it):

```ts
    const overdue = state === 'upcoming' && row.dueAt < nowIso;
    ...
      ...(overdue && { overdue: true }),
```

Wire type + docblock exactly as spec 8.1's block. Panel: on an upcoming rung with `overdue`, replace the "sends in Nh" promise with an amber "Overdue" chip that PAIRS with the suppression note when one exists ("Overdue - will wait - quiet hours" composition per the existing chip copy patterns; plain hyphens). The discontinued chip from Task 8 wins over overdue (a discontinued rung is not "overdue" - it is never sending).
- [ ] **Step 3:** Add one e2e assertion to an existing scheduled-visibility case (a rung driven past its dueAt without ticking shows the Overdue chip) rather than a new spec file.
- [ ] **Step 4: Run, PASS, commit** (`feat(reminders): derived overdue flag on both view builders`).

### Task 13: Relay catalog rewrite - `{names}`, `{name}`, five entries (spec 9.1, 9.2, 9.2a, 9.4-copy)

**Files:**
- Modify: `app/src/messages/catalog.ts` (`MessageId` union `:36-52`, the two relay entries + three new, docblocks)
- Modify: `app/src/jobs/relayFanOut.ts:180-250` (`composeConnectionSentence` -> name list; `composeIntroBody` / `composeMemberAddedBody` signatures in Task 14 - here only the pure list builder + `{name}` totality helper)
- Test: `app/test/messages/catalog.test.ts` (tripwire at `:66-69` rewritten), `app/test/relayFanOut.test.ts`

**Interfaces:**
- Produces (Task 14 consumes): `MessageId` gains `'relay.intro_tour_today' | 'relay.intro_tour' | 'relay.intro_placement' | 'relay.member_added_role'`. `export function composeNameList(memberNames: (string | undefined)[]): string` (the TOTAL `{names}` value per spec 9.2's four-row table). `export function joinedName(name: string | undefined): string` (first name, else `'a new member'`).

- [ ] **Step 1: Failing tests:**

```ts
describe('composeNameList - the TOTAL {names} value (spec 9.2)', () => {
  it('Oxford list of FIRST names', () => {
    expect(composeNameList(['Alicia Reyes', 'Marcus Webb', 'Dana Cole'])).toBe('Alicia, Marcus, and Dana');
    expect(composeNameList(['Alicia Reyes', 'Marcus Webb'])).toBe('Alicia and Marcus');
    expect(composeNameList(['Alicia Reyes'])).toBe('Alicia');
  });
  it('no names known: count phrase, never empty, never a phone', () => {
    expect(composeNameList([undefined, undefined, undefined])).toBe('2 other people');
    expect(composeNameList([undefined, undefined])).toBe('1 other person');
    expect(composeNameList([undefined])).toBe('1 other person'); // zero-others row: mildly wrong beats a strict-mode throw
  });
});
describe('joinedName - the TOTAL {name} value (spec 9.4)', () => {
  it('first name, else the lower-cased neutral phrase', () => {
    expect(joinedName('Dana Cole')).toBe('Dana');
    expect(joinedName(undefined)).toBe('a new member');
    expect(joinedName('  ')).toBe('a new member');
  });
});
describe('relay catalog entries (spec 9.2a)', () => {
  it('naked intro composed output is BYTE-IDENTICAL to the pre-change body', () => {
    // The old pipeline: 'Hey, it's Sam. ' + connection sentence + trailing copy.
    const names = ['Alicia Reyes', 'Marcus Webb'];
    expect(resolveMessage('relay.intro', { names: composeNameList(names) })).toBe(
      "Hey, it's Sam. You're now connected with Alicia and Marcus on this number. " +
        'Reply here and everyone in the group sees it. Use this group text for anything ' +
        'that comes up. It can be a long process, so ask me anything in here!',
    );
  });
});
```

Derive the byte-identity literal by RUNNING the pre-change `composeIntroBody(['Alicia Reyes','Marcus Webb'])` first (one-off `npx tsx -e` from `app/`) and pasting its exact output - do not hand-assemble it.

- [ ] **Step 2: FAIL, then implement - AND KEEP EVERY CALL SITE GREEN IN THIS TASK.** Two rules make that true (plan reviews P6 and PR2-1): the intro rewiring is byte-identical, and **`relay.member_added` is NOT TOUCHED in this task at all** - an interim one-body copy change would break seven assertion sites across three app suites and three e2e files and force a double re-baseline; the member_added rewrite lands ONCE, in Task 14, with the split. So here:
  - `composeConnectionSentence` becomes `composeNameList` (rename; grep every import AND the comments naming the old symbol - `grep -rn "composeConnectionSentence" app dashboard e2e` until zero hits).
  - `composeIntroBody(memberNames)` keeps its CURRENT signature and internally becomes `resolveMessage('relay.intro', { names: composeNameList(memberNames) })` - the byte-identity pin proves the seam. Task 14 changes the signature.
  - `composeMemberAddedBody` is UNCHANGED (it still consumes the old `relay.member_added` entry, which is also unchanged). `joinedName` is written and unit-tested here (its tests import nothing catalog-side) but wired in Task 14; `ANONYMOUS_JOINED_LABEL` is deleted in Task 14 when `joinedName` replaces it - not left orphaned in between.
  - Catalog: rewrite `relay.intro` to the spec 9.2 fenced text with `vars: ['names']`; ADD `relay.intro_tour_today`, `relay.intro_tour`, `relay.intro_placement`, `relay.member_added_role` with the EXACT fenced copy and the 9.2a metadata (vars order, `{where}` LAST, `MessageId` union). Docblocks: founder wording 2026-08-24; the "on" vs "at" ruling; the housing-authority note beside `relay.intro_placement`; STOP omitted per changelog 1.2.1 #7.
- [ ] **Step 3: Rewrite the tripwires this breaks NOW:** `catalog.test.ts:66-69` (the `{members}` override pin - re-target to `{names}` with the same editable-flag intent) and any catalog test asserting the `{members}` declaration. Cross-ref: `resolve.test.ts`'s Task 1 probe can stay on `relay.member_added`'s old shape until Task 14 switches it to `relay.member_added_role` (`{ name, role }`).
- [ ] **Step 4: Run** `cd app && npx vitest run test/messages/ test/relayFanOut.test.ts test/toursApi.test.ts test/placementsApi.test.ts test/relayGroupPreview.test.ts test/relayApi.test.ts` - ALL green at this task's commit (byte-identical naked intro; member_added untouched). PASS, commit (`feat(relay): founder intro entries; names token; member_added deferred to the split`).

### Task 14: Relay resolver, intro routing, member_added split, preview parity (spec 9.0, 9.3, 9.4, 9.5, 9.6)

**Files:**
- Modify: `app/src/jobs/relayFanOut.ts` (resolver + both job handlers + composer signatures)
- Modify: `app/src/services/relayAnnouncements.ts` (`bodyFor` selector)
- Modify: `app/src/services/rosterEdits.ts` (`buildOpenPreviewFromParts` callers, `buildOpenPreview`, `buildAddPreview` + docblock)
- Modify: the preview ROUTES and call sites - derive the true set first: `grep -rn "buildOpenPreview\|buildAddPreview\|buildStandaloneOpenPreview" app/src` (plan review P14: there are TWO routes but FOUR call sites, `buildStandaloneOpenPreview` included - a fifth composer path an earlier draft missed. The standalone preview has NO owner, takes the resolver's null-owner path, and composes the naked intro BYTE-IDENTICAL to today: its pins are re-baselined to UNCHANGED, i.e. verified, not moved)
- Modify: `e2e/scenarios/steps.ts:1887,1930-1949`, `e2e/tests/tour-roster.spec.ts:252-269`
- Test: `app/test/relayFanOut.test.ts`, `app/test/toursApi.test.ts:3989-4096`, `app/test/placementsApi.test.ts:989,1007`, `app/test/relayGroupPreview.test.ts:151,208`; one new e2e spec

**Interfaces:**
- Produces:

```ts
export interface RelayComposeInputs {
  variant: 'tour_today' | 'tour' | 'placement' | 'naked';
  tenantFirstName?: string;        // absent -> composer substitutes 'there'
  propertyContactFirstName?: string; // absence forces variant: 'naked' (9.5)
  where?: string;                  // ditto
  when?: string;
  time?: string;
  role?: 'property manager' | 'landlord' | 'tenant'; // member_added only
}
// TOTALITY (plan review P3, the round's unique BLOCKING find): the tour and
// placement entries open "Hey {tenantFirstName}!" and are STRICT non-editable
// defaults - an absent tenant name must NEVER reach resolveMessage undefined
// (it throws AFTER the intro job's idempotency marker, losing the
// announcement). The composer builds its vars with the SAME fallback Phase A
// uses (tourCopy.ts:80-85): tenantFirstName: inputs.tenantFirstName ?? 'there'.
// Test: a tour-variant compose with no tenant name yields "Hey there! ..."
// and does not throw.
export async function resolveRelayComposeInputs(
  owner: { type: 'tour' | 'placement'; id: string } | { type: null },
  deps: {
    toursRepo: Pick<ToursRepo, 'getById'>;
    placementsRepo: Pick<PlacementsRepo, 'getById'>;
    unitsRepo: Pick<UnitsRepo, 'getById'>;
    contactsRepo: Pick<ContactsRepo, 'getById'>;
    settingsRepo: Pick<SettingsRepo, 'getOrgSettings'>;
    logger?: Logger;
  },
  addedContactId?: string, // member_added: resolve {role} for THIS contact
): Promise<RelayComposeInputs>;
export function composeIntroBody(inputs: RelayComposeInputs, memberNames: (string | undefined)[]): string;
export function composeMemberAddedGroupBody(inputs: RelayComposeInputs, newMemberName: string | undefined): string;
// sendRelayAnnouncement input gains:
//   bodyFor?: (member: ConversationParticipant) => string;  // per-member body; `body` stays the persisted/preview one
```

- [ ] **Step 1: Failing resolver + composer tests** (fake repos, per the file's stub idiom): tour owner today -> `relay.intro_tour_today` with `{time}`; tour other-day -> `relay.intro_tour` with `{when}` ("today" judged in `resolveQuietHoursTimezone(settings)`); placement -> `relay.intro_placement`; null owner -> naked; EACH missing input (no property contact, no street, no scheduledAt, tour/unit read THROWS) -> `variant: 'naked'`, never a throw (spec 9.3/9.5); missing tenant first name keeps the variant and degrades in-sentence; role mapping table rows (`pm` -> property manager, `landlord`/`owner` -> landlord, the owner's tenantId -> tenant, `other`/none -> `role` absent -> `relay.member_added` no-role entry).
- [ ] **Step 2: Implement the resolver** in `relayFanOut.ts` (rosterEdits already imports from here; no new layering): owner -> `toursRepo/placementsRepo.getById` -> `unitsRepo.getById(unitId)` -> `resolveTourContactNames({ tenantId, unit, contactsRepo })` (REUSE - spec 9.3) -> `formatStreet` / `formatLocalDate` / `formatLocalTime`; every read in its own try/catch degrading toward `'naked'`. Composer selects the entry id from `variant` (+ street presence for the naked fallback per 9.5) and calls `resolveMessage` with exactly the declared vars.
- [ ] **Step 3: Job handlers, and the DEFERRED member_added rewrite lands here ONCE** (PR2-1). Catalog: rewrite `relay.member_added` to `'Hey, adding {name} to the group.'` `vars: ['name']`, with the 2026-07-14 reversal docblock WITH DATE (spec 9.4). Wire `joinedName` into the composers; delete `ANONYMOUS_JOINED_LABEL` now that its replacement is live. Re-baseline EVERY member_added copy pin in one pass - the full derived list: `relayFanOut.test.ts:630-662,703-716`, `toursApi.test.ts:3813`, `placementsApi.test.ts:1007`, `relayApi.test.ts:1046,1052`, and e2e `relay-group-view.spec.ts:161,172` (`:172` is the ONLY nameless-joiner coverage - retarget it to the `a new member` copy, never delete it) and `roster-quiet-hours.spec.ts:485-486`. Switch `resolve.test.ts`'s probe to `relay.member_added_role` (`{ name, role }`). Intro job (`:608-657`): after the existing `edited` check (precedence 1 verbatim - operator body still wins), `getOwner(conversation)` -> resolver -> `composeIntroBody(inputs, roster.map(m => m.name))`. Wire `units ??= createUnitsRepo(...)`, `tours ??= createToursRepo(...)`, `placements ??= createPlacementsRepo(...)`, `settings ??= createSettingsRepo(...)` in the handler closure, matching the existing lazy pattern. Member-added job (`:664-698`): resolver with `addedContactId` from the payload's member key -> group body via `composeMemberAddedGroupBody`, new-member body via `composeIntroBody(inputs-with-variant-naked, postAddRoster)`; call `sendRelayAnnouncement` with `body` = the NEW MEMBER's body (persisted - spec 9.6) and `bodyFor: (m) => relayMemberKey(m) === payload.addedMemberKey ? newMemberBody : groupBody`.
- [ ] **Step 4: `sendRelayAnnouncement`** - add the optional `bodyFor` to `RelayAnnouncementInput` with the spec 9.6 docblock (named dated exception to the 2026-07-14 visibility rule; one row, persisted body = `body`; `bodyFor` overrides per LEG only; works identically in `persist:false` legs-only mode); in the roster loop, `const legBody = input.bodyFor?.(member) ?? body;` used for the adapter send - persistence, `touchLastActivity` preview, and slots all keep `body`. Default byte-identical: assert in a test that omitting `bodyFor` sends `body` to every member.
- [ ] **Step 5: Preview parity** (spec 9.0/9.3). `buildOpenPreview`: derive `{ type: owner.type, id: owner.id }` from its `RosterOwner`, call the resolver, pass `inputs` through `OpenPreviewParts` into `buildOpenPreviewFromParts`, which calls the new `composeIntroBody(inputs, ...)`. `buildAddPreview`: resolver (owner + `candidate.contactId`), preview body = `composeMemberAddedGroupBody(...)` (the GROUP body - spec 9.0 ruling); amend its docblock: the new member receives the naked intro instead, defined at `jobs/relayFanOut.ts` member-added handler. Extend `RosterResolutionDeps` (or thread a second deps arg - follow whichever the routes can wire with least churn) with `tours`/`placements`/`settings` picks; update the three preview routes' construction sites.
- [ ] **Step 6: Re-baseline the parity pins** (`toursApi.test.ts:3989-3998,4096`, `placementsApi.test.ts:989,1007`, `relayGroupPreview.test.ts:151,208`, `relayFanOut.test.ts` job cases): each now expects the OWNER-ROUTED body; standalone-preview pins re-verify UNCHANGED. The new parity-contract pins are SPLIT PER MESSAGE (plan review P13 - a single "preview === job" pin contradicts spec 9.6): INTRO - preview body === the body the intro job composes for the same owner/roster. MEMBER_ADDED - preview body === the job's GROUP body, AND the persisted row's body === the job's NEW-MEMBER body. Pin both directions.
- [ ] **Step 7: E2E.** `steps.ts:1887` and `expectGroupIntros` (`:1930-1949`): parameterize by expected variant - tour-owned groups assert Sam's tour wording (`Putting you in a group text with`), placement-owned assert `Excited to have you move into`, naked keep `/You're now connected with/`. `tour-roster.spec.ts:252-269`: the split-on-literal tripwire stays aimed at the NAKED entry (`relay.intro`) with `'{names}'` - its guard works because `{names}` sits MID-template there. Do NOT transplant the split trick to the tour entries: they OPEN with a token, so `introHead` would be empty - the exact failure the guard's own message names (plan review P9). The tour-preview half of that block becomes resolved-copy assertions instead: body starts with `Hey <tenant first name>!`, contains the street and `Putting you in a group text with`. Add one new e2e scenario spec (or extend `tour-roster.spec.ts`): open a tour relay -> every member's fake thread gets the tour intro with resolved names; add a member -> new member's thread carries the naked intro, existing members carry `Hey, adding <name> to the group as the landlord.`, dashboard thread shows ONE bubble whose body is the NEW member's, preview-add showed the GROUP body.
- [ ] **Step 8: Run** `cd app && npx vitest run test/relayFanOut.test.ts test/toursApi.test.ts test/placementsApi.test.ts test/relayGroupPreview.test.ts test/relayApi.test.ts test/messages/`, then the FULL app suite (`cd app && npx vitest run`) - PR2-4: without it, red in a file outside the named run set survives to gate 2. Then the FULL e2e suite (`npm run e2e`) - the relay half's checkpoint, same rationale as Task 9's. PASS all three. Commit (`feat(relay): owner-routed intros and per-recipient member_added`).

### Task 15: Docs closure

**Files:**
- Modify: `app/src/messages/tourCopy.ts` (the `TODO(tour-reminder-ladder-phase-b)` marker on `reminderNamesUsed` -> `TODO(tour-copy-where-token-declared-not-passed)`, spec 12 item 9)
- Modify: `docs/issues/tour-reminder-ladder-phase-b.md` (status: resolved, dated resolution paragraph mapping the nine items to spec 12's dispositions)
- Verify: `npm run issues` regenerates the index cleanly

- [ ] **Step 1:** Make both edits; the ledger's resolution paragraph is a nine-row list, one line each, citing the spec section that discharged or re-deferred it (copy spec section 12's table).
- [ ] **Step 2: The founder items get an artifact** (plan review P20). Write `docs/superpowers/reviews/2026-08-31-tour-reminder-ladder-phase-b/founder-handback-items.md` carrying spec section 15's five items verbatim - including item 2's SEQUENCING line (Sam can be asked about sender identity BEFORE the deploy that first sends a tour/placement intro). Committed with this task; the mission handback references the file rather than restating the items.
- [ ] **Step 3:** `npm run issues` (regenerates gitignored INDEX; do not commit the index). Commit the files (`docs(issues): discharge the Phase B unpause ledger`).

---

## Final gates (from `W:\tmp\tour-reminder-ladder-phase-b`, after a single main sync)

1. `npm run typecheck`
2. `npm test` (DynamoDB Local up)
3. `npm run smoke`
4. `npm run e2e`
5. `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')` - attribute by BASELINE comparison per AGENTS.md; the deleted `ANONYMOUS_JOINED_LABEL` class of finding is exactly what line-number attribution misses.

## Self-review checklist (ran at plan time)

- Spec coverage: 3.1/3.1a -> T7+T8; 3.2 build order -> task order 4<5,6<7; 4 -> T2+T4; 5 -> T9; 6/6.1a/6.2 -> T3+T10; 7 -> T11; 8 -> T12; 9.0-9.6 -> T13+T14; 10/10a -> inventory + T5+T6 (+T3 step 8 for cat 4); 11 -> T1; 12 item 9 -> T15; 14 -> distributed test steps; 15 -> handback (planner-side, not build work).
- Interfaces: `retiredByTourStart` (T3) consumed by T4; tokens (T2) consumed by T3/T4/T7/T11; `DISCONTINUED_REMINDER_KINDS` (T7) consumed by T8; `composeNameList`/`joinedName` (T13) consumed by T14; `createDueReminder` (T5) used by T3 tests where noted (T3's own tests fall back to arm+past-now where T5 has not landed - both orderings work).
- No placeholder patterns remain; test-shape comments in T3 step 5 and T7 step 1 are required-assertion specs the builder writes out fully, per their instruction lines.
