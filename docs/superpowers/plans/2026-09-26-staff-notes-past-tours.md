# Staff Notes + Past Tours Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Status: v6 - after plan reviews R1 and R2 (adjudications in `docs/superpowers/reviews/2026-09-26-staff-notes-past-tours/plan-r1-adjudications.md` and `plan-r2-adjudications.md`); aligned to spec DRAFT 4; written for the overnight unattended mission of 2026-09-26

Already on the branch before the build starts (no task needed): the GLOSSARY
entry (spec 3.8) and all six `docs/issues/` files (spec 8) are committed.

Lint rule that shapes three tasks: the dashboard preset
(`eslint.config.mjs:50-51`, eslint-plugin-react-hooks 7.1.1
`recommended-latest`) makes `react-hooks/set-state-in-effect` an ERROR in
non-test dashboard files. No new code may call a `useState` setter
synchronously inside a `useEffect` body (setters inside an awaited callback
are fine). Tasks 6, 7 and 8 are written around it: the hook sets state only
from its async callback, the page resets by REMOUNT (`key={view}`), and the
tour page initializes the dialog from the URL in the state initializer.

Commit trailer: every commit ends with `Co-Authored-By: <the model you are
running as> <noreply@anthropic.com>` - a child running on Opus names Opus,
not the planner's model. The commands below show the placeholder
`<AUTHORING-MODEL>`.
Date: 2026-09-26
Branch: `feat/staff-notes-past-tours`
Worktree: `W:\tmp\staff-notes-past-tours`
Base: `main` at `0dafe3c12291f60a69cccaf5a8a65bcb8d252452`

**Goal:** A hand-written "Staff notes" card on the tenant file (Sam's item 22)
and a Past tab on the Tours page listing the last 90 days of tours that still
need a human decision, with per-row and bulk "Mark toured" (items 18 + 20, list
half).

**Architecture:** Part 1 adds one plain string field (`staff_notes`) plus a
server-stamped companion timestamp to the contact record, allowlists it on the
existing PATCH route, and renders a self-contained card that saves through the
existing `updateContact` endpoint and hands the returned contact up to the file
pane. Part 2 adds a lazy hook that reuses the existing scheduled-range endpoint
and selects rows on the client, a third view on the Tours page whose rows carry
a checkbox and actions beside (not inside) the row link, a sequential bulk
runner that re-reads each tour before its `patchTour`, a one-shot `?outcome=1`
deep link on the tour page that opens the existing Record-outcome dialog, and a
back arrow that honors router state.

**Tech Stack:** React 19, TypeScript ESM, CSS Modules, react-router-dom 7,
Vitest + Testing Library (jsdom) for the dashboard; Express + supertest against
the in-memory fake world (`app/test/helpers/twilioWebhookHarness.ts`) for the
app; Playwright against the hermetic e2e lane.

**Spec:** `docs/superpowers/specs/2026-09-26-staff-notes-past-tours-design.md`
(DRAFT 4, approved). Section numbers below refer to it.

## Global Constraints (copied from the spec)

- `staff_notes` is a plain string, no length cap, `''` clears (3.1). The
  server stamps `staff_notes_updated_at` (ISO 8601) on EVERY PATCH that
  carries `staff_notes`; a client-supplied `staff_notes_updated_at` is ignored
  (3.1, 3.2). Neither name enters `PROVENANCE_FIELDS` (3.1). The contacts
  parser's no-field error is `no updatable fields supplied` (2.1).
- The create paths (`parseCreateBody`, the import, the seeds, the public
  sign-up) are NOT changed (3.3). `toProfile`, `applyExtraction` and the
  prompt are NOT changed (3.4).
- Card (3.6): rendered by `TenantFile` ONLY when `contact.type === 'tenant'`,
  directly above "Preferences & notes". Title "Staff notes"; empty line "No
  staff notes yet."; "Last edited Sep 26, 2026" (en-US short month, numeric
  day, numeric year) ONLY when the trimmed value is non-empty; aside "Edit" /
  aria-label "Edit staff notes" when non-empty, "+ Add" / aria-label "Add staff
  notes" when empty, and NO aside in edit mode; textarea labeled "Staff notes"
  (a real, visually hidden `<label>`), `rows={4}`, focused on entry; buttons
  "Save" and "Cancel"; the save client is `updateContact`; alert is exactly
  "Could not save staff notes. Try again.".
- Past window (4.2): `from` = start of the local calendar day 90 days before
  today, built as `new Date(y, m, d - 90, 0, 0, 0, 0)`; `to` = end of today
  local, built as `new Date(y, m, d + 1, 0, 0, 0, 0)` minus 1 ms. Selection:
  keep `scheduled | toured | no_show`; drop a `scheduled` row with
  `scheduledAt >= start of today local`; drop a `toured` row with an `outcome`
  UNLESS `convertible === true && convertedPlacementId === undefined`; sort
  `scheduledAt` DESC, ties by `tourId` ASC.
- State chips (4.3): scheduled -> "Not marked"; toured without outcome ->
  "Needs outcome"; toured with outcome, convertible, no convertedPlacementId ->
  "Needs placement"; no_show -> "No show"; anything else ->
  `TOUR_STATUS_LABELS[status]`.
- Every row label carries the date-time (4.3, 4.4): `Tour for <tenant> at
  <property> on <date-time>`, `Select tour for ... on ...`, `Mark toured: ...
  on ...`, `Record outcome: ... on ...`, where `<date-time>` is the row's own
  "Sep 24, 2026, 2:30 PM" string.
- Page copy (4.1): heading "Past tours"; intro "Last 90 days: tours that were
  never marked toured, toured tours still waiting on an outcome or a
  placement, and no-shows."; empty "No past tours need attention in the last
  90 days."
- Bulk (4.5): toolbar checkbox "Select all not marked"; button text
  `Mark toured (N)`; runner is SEQUENTIAL; at batch start it snapshots the
  listed rows; per id: `getTour(id)` first; a failed re-read -> `{ ok: false,
  message: 'Could not check the tour' }`; current status not `scheduled` OR
  current `scheduledAt` different from the listed one -> `{ ok: false,
  message: 'Changed since the list loaded' }`; else `patchTour(id, { status:
  'toured' })` -> `{ ok: true }` or `{ ok: false, message: 'The update
  failed' }`. Per-row "Marked toured" (`role="status"`) or "Could not mark
  toured: <message>" (`role="alert"`); EVERY result whose id is not listed
  after the reload renders in a block above the toolbar from the snapshot, as
  `<tenant> at <property> on <date-time>: Marked toured` (`role="status"`) or
  `<tenant> at <property> on <date-time>: <message>` (`role="alert"`). Every
  mark control is disabled while a batch runs; the runner ignores a call while
  one is in flight. Selection = raw ticked ids intersected with the listed
  "Not marked" ids. Selection and results reset on a view change. A failed
  RELOAD keeps the rows and results: the hook stays `ready` with
  `reloadFailed: true` (cleared by the next success) and the page shows one
  `role="alert"` line above the toolbar, "Could not refresh the list. Reload
  the page to see the latest."; only a failed FIRST load is `status: 'error'`.
- Row link and "Record outcome" link carry router `state: { back: '/tours/past' }`
  (4.3, 4.4). The tour page's back arrow uses `location.state.back` only when it
  is exactly `/tours`, `/tours/past` or `/tours/closed`, else `/tours` (4.6).
- `?outcome=1` (4.6): ONLY when the param is present, open the dialog if the
  tour is toured with no outcome, and strip the param with
  `setSearchParams(next, { replace: true, state: location.state })` so the
  back pointer survives the strip.
- Playwright locators for the bulk button are anchored
  (`/^Mark toured \(N\)$/`): `getByRole` there is a substring match and the
  row buttons also start with "Mark toured". Testing Library's string `name`
  is an exact full-name match, so the unit tests need no anchoring.
- ASCII only in every new or touched line. Commit explicit paths. Never touch
  the off-limits files in spec section 7.
- Gates (bare, from `W:\tmp\staff-notes-past-tours`): `npm run typecheck`,
  `npm test`, `npm run smoke`, `timeout 1500 npm run e2e`, and
  `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')`.

## Shell notes for every task

- Every command below is run from an explicit directory. Bash cwd drifts;
  `cd` on every command.
- App unit tests: `cd /w/tmp/staff-notes-past-tours/app && npx vitest run test/<file>`.
- Dashboard unit tests: `cd /w/tmp/staff-notes-past-tours/dashboard && npx vitest run src/<path>`.
- ASCII check: `tr -d '\11\12\15\40-\176' < FILE | wc -c` must print 0. On a
  pre-existing file that already carries non-ASCII (e.g. em dashes in
  `ToursPage.tsx` line 3, `TenantFile.tsx`, `TourDetail.tsx`), check only the
  added lines: `git diff -- FILE | grep '^+' | grep -v '^+++' | tr -d '\11\12\15\40-\176' | wc -c`.
- Before every commit: `git -C /w/tmp/staff-notes-past-tours status --porcelain` and
  `ls "W:/AI Projects/Housing Choice/HC Application/.git/worktrees/staff-notes-past-tours/MERGE_HEAD" 2>/dev/null` (must not exist).

---

## Part 1 - staff notes (build first)

### Task 1: App - the field, the PATCH allowlist, the server stamp

**Files:**
- Modify: `app/src/repos/contactsRepo.ts` (type only, after `park_reason`)
- Modify: `app/src/routes/contacts.ts` (header comment, `parseTriageBody`, the PATCH handler)
- Create: `app/test/contactStaffNotes.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `app/test/contactStaffNotes.test.ts`:

```ts
// Staff notes (Sam's item 22, spec 2026-09-26-staff-notes-past-tours-design.md
// sections 3.1-3.4): the hand-written box on the tenant file.
//   PATCH /api/contacts/:id { staff_notes } -> stored, staff_notes_updated_at
//                                              server-stamped, notes untouched
//   POST  /api/contacts { staff_notes }     -> ignored (create paths never set it)
//   toProfile / applyExtraction             -> the AI neither reads nor writes it
// Runs on the shared in-memory world (makeWebhookHarness), like contactsCrud.
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { toProfile } from '../src/jobs/extraction.js';
import { applyExtraction, type ApplyDeps } from '../src/services/extraction/apply.js';
import { createLogger } from '../src/lib/logger.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createLogCapture } from './helpers/logCapture.js';
import { createFakeWorld, makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';

type World = ReturnType<typeof createFakeWorld>;

const auth = (req: request.Test) =>
  req.set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function seedTenant(world: World, over: Partial<ContactItem> = {}): void {
  world.contacts.push({
    contactId: 'c-sn-1',
    type: 'tenant',
    status: 'searching',
    firstName: 'Tasha',
    lastName: 'Nguyen',
    phone: '+15550100001',
    notes: 'prefers mornings',
    ...over,
  });
}

function stored(world: World): ContactItem {
  const c = world.contacts.find((x) => x.contactId === 'c-sn-1');
  if (!c) throw new Error('seed missing');
  return c;
}

describe('PATCH /api/contacts/:id - staff_notes (spec 3.1, 3.2)', () => {
  it('stores the text, stamps staff_notes_updated_at, leaves notes alone, audits the field', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world);

    const res = await auth(request(app).patch('/api/contacts/c-sn-1')).send({
      staff_notes: 'Has a service dog - call before visits',
    });

    expect(res.status).toBe(200);
    expect(res.body.contact.staff_notes).toBe('Has a service dog - call before visits');
    expect(res.body.contact.staff_notes_updated_at).toMatch(ISO);
    expect(res.body.contact.notes).toBe('prefers mornings');
    expect(stored(world).staff_notes).toBe('Has a service dog - call before visits');
    expect(stored(world).staff_notes_updated_at).toMatch(ISO);
    expect(stored(world).notes).toBe('prefers mornings');
    // No provenance marker is ever written for this field.
    expect('staff_notes_source' in stored(world)).toBe(false);

    const audit = world.auditEvents.find((e) => e.event_type === 'contact_updated');
    expect(audit?.entityKey).toBe('contacts#c-sn-1');
    expect(audit?.payload).toMatchObject({ fields: ['staff_notes'] });
  });

  it('an empty string clears the text and re-stamps the instant', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world, {
      staff_notes: 'old',
      staff_notes_updated_at: '2020-01-01T00:00:00.000Z',
    });

    const res = await auth(request(app).patch('/api/contacts/c-sn-1')).send({ staff_notes: '' });

    expect(res.status).toBe(200);
    expect(stored(world).staff_notes).toBe('');
    expect(stored(world).staff_notes_updated_at).toMatch(ISO);
    expect(stored(world).staff_notes_updated_at).not.toBe('2020-01-01T00:00:00.000Z');
  });

  it('400s a non-string', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world);

    const res = await auth(request(app).patch('/api/contacts/c-sn-1')).send({ staff_notes: 5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('staff_notes must be a string');
    expect('staff_notes' in stored(world)).toBe(false);
  });

  it('ignores a client-supplied staff_notes_updated_at: alone it changes nothing (400), beside staff_notes the server stamp wins', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world);

    const alone = await auth(request(app).patch('/api/contacts/c-sn-1')).send({
      staff_notes_updated_at: '2020-01-01T00:00:00.000Z',
    });
    expect(alone.status).toBe(400);
    expect(alone.body.error).toBe('no updatable fields supplied');
    expect('staff_notes_updated_at' in stored(world)).toBe(false);

    const beside = await auth(request(app).patch('/api/contacts/c-sn-1')).send({
      staff_notes: 'x',
      staff_notes_updated_at: '2020-01-01T00:00:00.000Z',
    });
    expect(beside.status).toBe(200);
    expect(stored(world).staff_notes_updated_at).toMatch(ISO);
    expect(stored(world).staff_notes_updated_at).not.toBe('2020-01-01T00:00:00.000Z');
  });

  it('a notes-only PATCH does not stamp or touch staff_notes', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world, { staff_notes: 'keep me', staff_notes_updated_at: '2020-01-01T00:00:00.000Z' });

    const res = await auth(request(app).patch('/api/contacts/c-sn-1')).send({ notes: 'new notes' });

    expect(res.status).toBe(200);
    expect(stored(world).notes).toBe('new notes');
    expect(stored(world).staff_notes).toBe('keep me');
    expect(stored(world).staff_notes_updated_at).toBe('2020-01-01T00:00:00.000Z');
  });
});

describe('POST /api/contacts - staff_notes is never set on create (spec 3.3)', () => {
  it('drops staff_notes from a manual-create body', async () => {
    const { app, world } = makeWebhookHarness();

    const res = await auth(request(app).post('/api/contacts')).send({
      type: 'tenant',
      firstName: 'Pat',
      lastName: 'Renter',
      phone: '(555) 010-7000',
      staff_notes: 'should be dropped',
    });

    expect(res.status).toBe(201);
    expect('staff_notes' in res.body.contact).toBe(false);
    expect('staff_notes_updated_at' in res.body.contact).toBe(false);
    const created = world.contacts.find((c) => c.contactId === res.body.contact.contactId);
    expect(created).toBeDefined();
    expect('staff_notes' in created!).toBe(false);
  });
});

describe('the AI neither reads nor writes staff_notes (spec 3.4)', () => {
  it('toProfile omits staff_notes even though it carries notes', () => {
    const profile = toProfile({
      contactId: 'c-sn-1',
      type: 'tenant',
      notes: 'profile notes',
      staff_notes: 'staff only',
    } as ContactItem);

    expect(profile.notes).toBe('profile notes');
    expect('staff_notes' in profile).toBe(false);
    expect(JSON.stringify(profile)).not.toContain('staff only');
  });

  it('applyExtraction direct-writes a field and appends a note line, and NO update call carries staff_notes', async () => {
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const logCapture = createLogCapture();
    const deps: ApplyDeps = {
      contacts: {
        getById: vi.fn(async () => undefined),
        update: vi.fn(async (id: string, patch: Record<string, unknown>) => {
          updates.push({ id, patch });
          return { contactId: id, type: 'tenant', ...patch } as ContactItem;
        }),
        addPhone: vi.fn(async (id: string) => ({ contactId: id, type: 'tenant' }) as ContactItem),
        findByPhone: vi.fn(async () => undefined),
      },
      extraction: {
        putSuggestion: vi.fn(async () => ({ state: 'stored' }) as never),
        deleteSuggestion: vi.fn(async () => undefined),
        deleteTypeSuggestionIfCurrentAtContactRevision: vi.fn(async () => 'deleted' as never),
        hasDismissal: vi.fn(async () => false),
      } as unknown as ApplyDeps['extraction'],
      audit: { append: vi.fn(async () => undefined) },
      events: { emit: vi.fn() },
      logger: createLogger({ destination: logCapture.stream, level: 'debug' }),
      now: () => '2026-09-26T15:00:00.000Z',
    };

    const contact = {
      contactId: 'c-sn-1',
      type: 'tenant',
      notes: 'existing',
      staff_notes: 'staff only',
    } as ContactItem;

    const outcome = await applyExtraction(deps, {
      contact,
      conversationId: 'conv-1',
      cursorTsMsgId: 'ts-1',
      // One direct field write (the schema-keyed patch, apply.ts:455-460) AND
      // one note line (the notes append, apply.ts:704): two update calls.
      result: { fields: { pets: { op: 'write', value: 'has a dog' } }, noteLines: ['stairs are a problem'] },
    });

    expect(outcome.wrote).toEqual(['pets']);
    expect(outcome.notedLines).toBe(1);
    expect(updates.length).toBeGreaterThanOrEqual(2);
    // Across EVERY update the apply made, neither staff key ever appears.
    for (const u of updates) {
      expect('staff_notes' in u.patch).toBe(false);
      expect('staff_notes_updated_at' in u.patch).toBe(false);
    }
    expect(updates.some((u) => u.patch['pets'] === 'has a dog')).toBe(true);
    expect(updates.some((u) => u.patch['notes'] === 'existing\n[Auto - Sep 26] stairs are a problem')).toBe(true);
    expect(contact.staff_notes).toBe('staff only');
  });
});
```

The `applyExtraction` second argument mirrors `run(...)` in
`app/test/extractionApply.test.ts:100-111` (`contact`, `conversationId`,
`cursorTsMsgId`, `result`). The four `extraction` stub names are the ones
`ApplyDeps['extraction']` picks on `main` @0dafe3c1
(`app/src/services/extraction/apply.ts:36-39`). `autoPrefix` (`apply.ts:154-158`)
formats the pinned `now` in UTC as `[Auto - Sep 26]`. If the `pets` write is
demoted to a suggestion by the inferred-role rule (`extractionApply.test.ts:732-765`
shows when that happens - only with a `roles` map), pass no roles; if it still
does not land, use a field the contact already carries (e.g. seed `pets:
'cat'` and write `'has a dog'`), keeping the two-call shape.

- [ ] **Step 2: Run the tests, expect red**

```
cd /w/tmp/staff-notes-past-tours/app && npx vitest run test/contactStaffNotes.test.ts
```

Expected: four of the five PATCH tests fail (the first because `staff_notes`
is not stored - the allowlist drops it, so the body changes no known field
and the route 400s `no updatable fields supplied`; the non-string test fails
on the message). The notes-only PATCH test, the POST test and the two AI tests
PASS already (they pin behavior that exists by construction) - that is
expected; they are regression pins.

- [ ] **Step 3: Declare the fields on `ContactItem`**

In `app/src/repos/contactsRepo.ts`, directly after the `park_reason?: string;`
line (line 134), add:

```ts
  /**
   * Staff notes (Sam's item 22, 2026-09-26): free text staff write BY HAND on
   * the tenant file - a second box kept apart from `notes`, which the AI
   * appends its dated "[Auto - <date>]" lines to. NOTHING machine-writes or
   * machine-reads THIS field: not the import, not the seeds, not the public
   * sign-up, not the transition service, not extraction (toProfile names its
   * fields and omits it). PATCH only; `''` clears. Not a provenance field.
   */
  staff_notes?: string;
  /**
   * ISO 8601 - when `staff_notes` was last written (a clear included).
   * Stamped by the PATCH route on every staff_notes write; never
   * client-settable (the parser does not copy it).
   */
  staff_notes_updated_at?: string;
```

- [ ] **Step 4: Allowlist `staff_notes` in `parseTriageBody`**

In `app/src/routes/contacts.ts`, directly after the `notes` block (the block
ending `changedFields.push('notes');` at line 572 and its closing `}` at 573),
add:

```ts
  // Staff notes (item 22): the hand-written box on the tenant file. Same
  // string-only validation as `notes`; '' clears. NOT a provenance field and
  // never machine-written - the route stamps staff_notes_updated_at itself,
  // and a client-supplied staff_notes_updated_at is ignored like any unknown key.
  if ('staff_notes' in b) {
    const v = b['staff_notes'];
    if (typeof v !== 'string') return { error: 'staff_notes must be a string' };
    patch['staff_notes'] = v;
    changedFields.push('staff_notes');
  }
```

Update the header comment at line 7 so the documented PATCH body reads
`{ type?, firstName?, lastName?, voucherSize?, status?, notes?, staff_notes? }`.

- [ ] **Step 5: Stamp `staff_notes_updated_at` in the PATCH handler**

In the same file, inside `router.patch('/:contactId', ...)`, directly after
the consent stamp block (the block starting `if (parsed.consentCaptured === true) {`
around line 1503 and ending with its `}`), add:

```ts
    // Staff notes (item 22): stamp the last-edited instant server-side on
    // every write, a clear included. The parser never copies a client value
    // for this key, so this is the only writer.
    if ('staff_notes' in parsed.patch) {
      parsed.patch['staff_notes_updated_at'] = new Date().toISOString();
    }
```

- [ ] **Step 6: Run the tests, expect green**

```
cd /w/tmp/staff-notes-past-tours/app && npx vitest run test/contactStaffNotes.test.ts
```

Expected: 8 passed. Then the neighbors:

```
cd /w/tmp/staff-notes-past-tours/app && npx vitest run test/contactTriage.test.ts test/contactsCrud.test.ts test/extractionApply.test.ts test/extractionJob.test.ts
```

Expected: all green (no test there asserts the exact allowlist).

- [ ] **Step 7: Typecheck the app workspace and commit**

```
cd /w/tmp/staff-notes-past-tours/app && npm run typecheck
```

Expected: exit 0. Then:

```
cd /w/tmp/staff-notes-past-tours && git status --porcelain
cd /w/tmp/staff-notes-past-tours && ls "W:/AI Projects/Housing Choice/HC Application/.git/worktrees/staff-notes-past-tours/MERGE_HEAD" 2>/dev/null
cd /w/tmp/staff-notes-past-tours && git add app/src/repos/contactsRepo.ts app/src/routes/contacts.ts app/test/contactStaffNotes.test.ts && git commit -m "feat(contacts): staff_notes field - PATCH allowlist + server-stamped staff_notes_updated_at (item 22, spec 3.1-3.4)

Co-Authored-By: <AUTHORING-MODEL> <noreply@anthropic.com>"
```

### Task 2: Dashboard types

**Files:**
- Modify: `dashboard/src/api/types.ts` (additive only)

- [ ] **Step 1: Add the fields**

In `dashboard/src/api/types.ts`, in `export interface Contact` directly after
`notes?: string;` (line 2005), add:

```ts
  /** Staff notes (item 22): the hand-written box on the tenant file, kept apart
   *  from `notes` (which the AI appends dated lines to). Never machine-written
   *  or machine-read. MIRRORS ContactItem.staff_notes. */
  staff_notes?: string;
  /** ISO 8601 - server-stamped on every staff_notes write (a clear included).
   *  Renders as "Last edited <date>" while the box holds text. */
  staff_notes_updated_at?: string;
```

In `export interface ContactPatch` directly after `notes?: string;` (line
2098), add:

```ts
  /** Staff notes (item 22). PATCH-allowlisted app-side; '' clears. The server
   *  stamps staff_notes_updated_at itself - never send one. */
  staff_notes?: string;
```

- [ ] **Step 2: Typecheck and commit**

```
cd /w/tmp/staff-notes-past-tours/dashboard && npm run typecheck
```

Expected: exit 0.

```
cd /w/tmp/staff-notes-past-tours && git status --porcelain
cd /w/tmp/staff-notes-past-tours && ls "W:/AI Projects/Housing Choice/HC Application/.git/worktrees/staff-notes-past-tours/MERGE_HEAD" 2>/dev/null
cd /w/tmp/staff-notes-past-tours && git add dashboard/src/api/types.ts && git commit -m "feat(dashboard/api): Contact.staff_notes + staff_notes_updated_at, ContactPatch.staff_notes (additive)

Co-Authored-By: <AUTHORING-MODEL> <noreply@anthropic.com>"
```

### Task 3: The StaffNotesCard component

**Files:**
- Create: `dashboard/src/routes/contact/StaffNotesCard.tsx`
- Create: `dashboard/src/routes/contact/StaffNotesCard.module.css`
- Create: `dashboard/src/routes/contact/StaffNotesCard.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `dashboard/src/routes/contact/StaffNotesCard.test.tsx`:

```tsx
// StaffNotesCard - the tenant file's hand-written notes box (spec 3.6).
// Mocks updateContact from the api barrel; asserts accessibility-first.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { Contact } from '../../api/index.js';

const updateContact = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return { ...actual, updateContact: (...a: unknown[]) => updateContact(...a) };
});

import { StaffNotesCard, formatLastEdited } from './StaffNotesCard.js';

const CONTACT: Contact = {
  contactId: 'c1',
  type: 'tenant',
  firstName: 'Tasha',
  lastName: 'Nguyen',
  staff_notes: 'Has a service dog',
  staff_notes_updated_at: '2026-09-26T15:00:00.000Z',
};

beforeEach(() => {
  updateContact.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('formatLastEdited', () => {
  it('formats an ISO instant as a short en-US date', () => {
    // Read back in local time; only the shape is asserted so the test is TZ-safe.
    expect(formatLastEdited('2026-09-26T15:00:00.000Z')).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
  });
  it('returns an empty string for absent or unparseable input', () => {
    expect(formatLastEdited(undefined)).toBe('');
    expect(formatLastEdited('nope')).toBe('');
  });
});

describe('StaffNotesCard - read mode', () => {
  it('renders the title, the text and the Last edited line, with an Edit affordance', () => {
    render(
      <StaffNotesCard
        contactId="c1"
        value={CONTACT.staff_notes}
        updatedAt={CONTACT.staff_notes_updated_at}
        onContactUpdated={() => {}}
      />,
    );
    expect(screen.getByRole('heading', { name: /Staff notes/ })).toBeInTheDocument();
    expect(screen.getByText('Has a service dog')).toBeInTheDocument();
    expect(screen.getByText(/^Last edited [A-Z][a-z]{2} \d{1,2}, \d{4}$/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit staff notes' })).toHaveTextContent('Edit');
    expect(screen.queryByRole('button', { name: 'Add staff notes' })).not.toBeInTheDocument();
  });

  it('renders the empty line and a + Add affordance when there is no text, and no Last edited line even with a stamp', () => {
    render(
      <StaffNotesCard
        contactId="c1"
        value=""
        updatedAt="2026-09-26T15:00:00.000Z"
        onContactUpdated={() => {}}
      />,
    );
    expect(screen.getByText('No staff notes yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add staff notes' })).toHaveTextContent('+ Add');
    expect(screen.queryByText(/Last edited/)).not.toBeInTheDocument();
  });

  it('treats a whitespace-only value as empty', () => {
    render(<StaffNotesCard contactId="c1" value="   " updatedAt={undefined} onContactUpdated={() => {}} />);
    expect(screen.getByText('No staff notes yet.')).toBeInTheDocument();
  });

  it('is read-only without onContactUpdated (no button)', () => {
    render(<StaffNotesCard contactId="c1" value="x" updatedAt={undefined} />);
    expect(screen.getByText('x')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('Edit')).toBeInTheDocument();
  });
});

describe('StaffNotesCard - edit mode', () => {
  it('Edit hides the aside, opens a prefilled focused textarea; Save PATCHes { staff_notes } and hands the returned contact up', async () => {
    const user = userEvent.setup();
    const onContactUpdated = vi.fn();
    const returned: Contact = {
      ...CONTACT,
      staff_notes: 'Has a service dog. Call first.',
      staff_notes_updated_at: '2026-09-27T09:00:00.000Z',
    };
    updateContact.mockResolvedValue(returned);
    render(
      <StaffNotesCard
        contactId="c1"
        value={CONTACT.staff_notes}
        updatedAt={CONTACT.staff_notes_updated_at}
        onContactUpdated={onContactUpdated}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Edit staff notes' }));
    expect(screen.queryByRole('button', { name: 'Edit staff notes' })).not.toBeInTheDocument();
    const box = screen.getByLabelText('Staff notes');
    expect(box).toHaveValue('Has a service dog');
    expect(box).toHaveFocus();
    await user.clear(box);
    await user.type(box, 'Has a service dog. Call first.');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onContactUpdated).toHaveBeenCalledWith(returned));
    expect(updateContact).toHaveBeenCalledTimes(1);
    expect(updateContact).toHaveBeenCalledWith('c1', { staff_notes: 'Has a service dog. Call first.' });
    // Back in read mode (the textarea is gone, the aside is back).
    expect(screen.queryByLabelText('Staff notes')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit staff notes' })).toBeInTheDocument();
  });

  it('Cancel discards the draft with no request', async () => {
    const user = userEvent.setup();
    render(<StaffNotesCard contactId="c1" value="keep" updatedAt={undefined} onContactUpdated={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Edit staff notes' }));
    await user.type(screen.getByLabelText('Staff notes'), ' typed');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(updateContact).not.toHaveBeenCalled();
    expect(screen.getByText('keep')).toBeInTheDocument();
    expect(screen.queryByLabelText('Staff notes')).not.toBeInTheDocument();
  });

  it('Save with an unchanged draft sends no request and returns to read mode', async () => {
    const user = userEvent.setup();
    render(<StaffNotesCard contactId="c1" value="same" updatedAt={undefined} onContactUpdated={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Edit staff notes' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(updateContact).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Staff notes')).not.toBeInTheDocument();
  });

  it('a failed save keeps the draft, stays in edit mode and shows the fixed alert (no server text)', async () => {
    const user = userEvent.setup();
    updateContact.mockRejectedValue(new ApiError(500, 'boom', 'boom'));
    render(<StaffNotesCard contactId="c1" value={undefined} updatedAt={undefined} onContactUpdated={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Add staff notes' }));
    await user.type(screen.getByLabelText('Staff notes'), 'draft text');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not save staff notes. Try again.');
    expect(alert).not.toHaveTextContent('boom');
    expect(screen.getByLabelText('Staff notes')).toHaveValue('draft text');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });
});
```

`ApiError` is `new ApiError(status, code, message, body?)`
(`dashboard/src/api/client.ts:21`).

- [ ] **Step 2: Run, expect red (module not found)**

```
cd /w/tmp/staff-notes-past-tours/dashboard && npx vitest run src/routes/contact/StaffNotesCard.test.tsx
```

- [ ] **Step 3: Write the styles**

Create `dashboard/src/routes/contact/StaffNotesCard.module.css`:

```css
/* StaffNotesCard - the in-place editor for the tenant file's staff notes.
 * Field/textarea styling mirrors ContactEditForm.module.css so the box reads
 * like the edit dialog's Notes field; the label is visually hidden because the
 * card heading already says "Staff notes" (it stays in the DOM for getByLabel
 * and screen readers). Tokens only, never hard-coded values. */

.form {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}

.srOnly {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.textarea {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-sm);
  padding: var(--sp-2);
  font: inherit;
  font-size: var(--fs-sm);
  color: var(--c-text);
  background: var(--c-surface);
  resize: vertical;
  min-height: 3.5rem;
}

.textarea:focus-visible {
  outline: 2px solid var(--c-focus-ring);
  outline-offset: 1px;
}

.actions {
  display: flex;
  gap: var(--sp-2);
  flex-wrap: wrap;
}

.error {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--c-danger);
}

.lastEdited {
  margin: var(--sp-2) 0 0;
  font-size: var(--fs-xs);
}
```

- [ ] **Step 4: Write the component**

Create `dashboard/src/routes/contact/StaffNotesCard.tsx`:

```tsx
// StaffNotesCard - the tenant file's hand-written notes box (Sam's item 22,
// spec 2026-09-26-staff-notes-past-tours-design.md section 3.6).
//
// A SECOND notes card, kept apart from "Preferences & notes" (which the AI
// appends dated "[Auto - <date>]" lines to): one free-text value staff edit IN
// PLACE - textarea, Save, Cancel - saved through PATCH /api/contacts/:id
// { staff_notes } (updateContact). The server stamps staff_notes_updated_at,
// rendered here as "Last edited <date>" while the box holds text. The card
// owns its edit state and its save call and hands the returned contact up
// through onContactUpdated so the file pane applies it in place (the same
// setContact path the edit dialog uses). Without that handler the card is
// read-only, mirroring how the sibling cards degrade without onEdit.
//
// Two staff saving at once is last-write-wins, like every contact field.
import { useEffect, useId, useRef, useState } from 'react';
import { updateContact, type Contact } from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { Card, CardAction, EmptyRow, NotesText, responseClass } from './Card.js';
import styles from './StaffNotesCard.module.css';

export interface StaffNotesCardProps {
  contactId: string;
  /** The stored staff_notes (undefined when never set). */
  value: string | undefined;
  /** The stored staff_notes_updated_at (undefined when never saved). */
  updatedAt: string | undefined;
  /** Receives the PATCHed contact. Absent -> read-only card (no Edit / + Add). */
  onContactUpdated?: (updated: Contact) => void;
}

/** The one user-facing failure line. No server code or message is appended
 *  (raw error codes stay out of user copy). */
const SAVE_FAILED = 'Could not save staff notes. Try again.';

/** "Sep 26, 2026" (en-US short month, numeric day and year) or '' when absent
 *  or unparseable. Same shape the Closed tours rows use for a date. */
export function formatLastEdited(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function StaffNotesCard({
  contactId,
  value,
  updatedAt,
  onContactUpdated,
}: StaffNotesCardProps): React.JSX.Element {
  const stored = typeof value === 'string' ? value : '';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(stored);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const textareaId = useId();

  // Focus the box on entry to edit mode (the click that opened it was on the
  // heading affordance, which is gone once the form renders).
  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  const startEdit = (): void => {
    setDraft(stored);
    setError(null);
    setEditing(true);
  };
  const cancel = (): void => {
    setEditing(false);
    setError(null);
  };
  const save = async (): Promise<void> => {
    // An unchanged draft is a no-op: no request, back to read mode.
    if (draft === stored) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await updateContact(contactId, { staff_notes: draft });
      onContactUpdated?.(updated);
      setEditing(false);
    } catch {
      setError(SAVE_FAILED);
    } finally {
      setSaving(false);
    }
  };

  const trimmed = stored.trim();
  const hasText = trimmed.length > 0;
  // Only while the box holds text: a cleared box reads as never set even
  // though the server keeps the stamp (spec 3.6).
  const lastEdited = hasText ? formatLastEdited(updatedAt) : '';
  const asideLabel = hasText ? 'Edit staff notes' : 'Add staff notes';
  const asideText = hasText ? 'Edit' : '+ Add';
  const aside = onContactUpdated ? (
    <CardAction onClick={startEdit} label={asideLabel}>
      {asideText}
    </CardAction>
  ) : (
    asideText
  );

  return (
    <Card title="Staff notes" aside={editing ? undefined : aside}>
      {editing ? (
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {/* The label is a SIBLING associated by id, never a wrapper: React
              mirrors a controlled textarea's value into its text content, and
              a wrapping <label> would then carry the draft as part of its
              accessible text, so getByLabel('Staff notes', { exact: true })
              would miss a prefilled box. */}
          <div className={styles.field}>
            <label htmlFor={textareaId} className={styles.srOnly}>
              Staff notes
            </label>
            <textarea
              id={textareaId}
              ref={textareaRef}
              className={styles.textarea}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={4}
              readOnly={saving}
            />
          </div>
          {error !== null ? (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          ) : null}
          <div className={styles.actions}>
            <Button type="submit" size="sm" variant="primary" disabled={saving}>
              Save
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={cancel} disabled={saving}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <>
          {hasText ? <NotesText text={trimmed} /> : <EmptyRow>No staff notes yet.</EmptyRow>}
          {lastEdited.length > 0 ? (
            <p className={`${styles.lastEdited} ${responseClass.muted}`}>Last edited {lastEdited}</p>
          ) : null}
        </>
      )}
    </Card>
  );
}
```

- [ ] **Step 5: Run, expect green**

```
cd /w/tmp/staff-notes-past-tours/dashboard && npx vitest run src/routes/contact/StaffNotesCard.test.tsx
```

Expected: 10 passed. If `toHaveFocus` fails under jsdom, keep the assertion
and add `autoFocus` to the textarea in addition to the effect.

- [ ] **Step 6: ASCII check, typecheck, commit**

```
cd /w/tmp/staff-notes-past-tours && for f in dashboard/src/routes/contact/StaffNotesCard.tsx dashboard/src/routes/contact/StaffNotesCard.module.css dashboard/src/routes/contact/StaffNotesCard.test.tsx; do printf '%s ' "$f"; tr -d '\11\12\15\40-\176' < "$f" | wc -c; done
cd /w/tmp/staff-notes-past-tours/dashboard && npm run typecheck
cd /w/tmp/staff-notes-past-tours && git status --porcelain
cd /w/tmp/staff-notes-past-tours && ls "W:/AI Projects/Housing Choice/HC Application/.git/worktrees/staff-notes-past-tours/MERGE_HEAD" 2>/dev/null
cd /w/tmp/staff-notes-past-tours && git add dashboard/src/routes/contact/StaffNotesCard.tsx dashboard/src/routes/contact/StaffNotesCard.module.css dashboard/src/routes/contact/StaffNotesCard.test.tsx && git commit -m "feat(dashboard/contact): StaffNotesCard - in-place editor for staff_notes with Last edited line (spec 3.6)

Co-Authored-By: <AUTHORING-MODEL> <noreply@anthropic.com>"
```

### Task 4: Wire the card into the tenant file (tenants only)

**Files:**
- Modify: `dashboard/src/routes/contact/TenantFile.tsx`
- Modify: `dashboard/src/routes/contact/ContactDetail.tsx` (one prop at the TenantFile call site, line 1058-1087)
- Create: `dashboard/src/routes/contact/TenantFile.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `dashboard/src/routes/contact/TenantFile.test.tsx`:

```tsx
// TenantFile - the staff-notes slice (spec 3.6): "Staff notes" renders
// directly ABOVE "Preferences & notes" for a TENANT, not at all for a
// team_member (TenantFile serves both kinds), and the existing card keeps its
// copy and its "+ Add" affordance untouched.
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { Contact } from '../../api/index.js';
import { TenantFile } from './TenantFile.js';

// The media gallery and the group cards fetch nothing when handed empty
// arrays; the Eligibility intake card reads only the contact.
const CONTACT: Contact = {
  contactId: 'c1',
  type: 'tenant',
  status: 'searching',
  firstName: 'Tasha',
  lastName: 'Nguyen',
  phone: '+14045550111',
  staff_notes: 'Has a service dog',
  staff_notes_updated_at: '2026-09-26T15:00:00.000Z',
};

function renderFile(over: Partial<Contact> = {}): void {
  render(
    <MemoryRouter>
      <TenantFile
        contact={{ ...CONTACT, ...over }}
        phones={[{ phone: '+14045550111', primary: true }]}
        placements={[]}
        tours={[]}
        units={[]}
        listingsSentPending={false}
        listingsSent={[]}
        relayGroupsPending={false}
        relayGroups={[]}
        groupThreadsPending={false}
        groupThreads={[]}
        groupThreadsTruncated={false}
        media={[]}
        onEdit={vi.fn()}
        onContactUpdated={vi.fn()}
      />
    </MemoryRouter>,
  );
}

describe('TenantFile - Staff notes card placement', () => {
  it('renders Staff notes directly above Preferences & notes for a tenant, both with their own affordances', () => {
    renderFile();
    const staff = screen.getByRole('heading', { name: /Staff notes/ });
    const prefs = screen.getByRole('heading', { name: /Preferences & notes/ });
    // Document order: the staff card precedes the preferences card.
    expect(staff.compareDocumentPosition(prefs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('Has a service dog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit staff notes' })).toBeInTheDocument();
    // The existing card is untouched: its "+ Add" still opens the edit dialog.
    expect(screen.getByRole('button', { name: 'Add a note' })).toBeInTheDocument();
    expect(screen.getByText(/No preferences yet/)).toBeInTheDocument();
  });

  it('renders NO Staff notes card for a team_member (TenantFile serves that kind too)', () => {
    renderFile({ type: 'team_member', status: 'active' });
    expect(screen.queryByRole('heading', { name: /Staff notes/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Has a service dog')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Preferences & notes/ })).toBeInTheDocument();
  });
});
```

`ContactPhone` is `{ phone, primary, label?, firstSeenAt?, lastSeenAt? }`
(`types.ts:2367`).

- [ ] **Step 2: Run, expect red**

```
cd /w/tmp/staff-notes-past-tours/dashboard && npx vitest run src/routes/contact/TenantFile.test.tsx
```

Expected: fails on the missing "Staff notes" heading (and a TS error on the
unknown `onContactUpdated` prop under typecheck).

- [ ] **Step 3: Wire TenantFile**

In `dashboard/src/routes/contact/TenantFile.tsx`:

1. Add the import next to the other card imports:
   ```tsx
   import { StaffNotesCard } from './StaffNotesCard.js';
   ```
2. Add to `TenantFileProps` (after `onEdit?: () => void;`):
   ```tsx
     /** Apply a contact the Staff notes card saved (the file pane's setContact).
      *  Absent -> that card is read-only. */
     onContactUpdated?: (updated: Contact) => void;
   ```
3. Destructure `onContactUpdated,` in the component's parameter list (after
   `onEdit,`).
4. Directly BEFORE the `<Card title="Preferences & notes"` element, add:
   ```tsx
         {/* Staff notes (item 22): the hand-written box, kept apart from the
             AI-appended "Preferences & notes" below. TENANTS ONLY - this file
             also serves team_member contacts, who do not get it. */}
         {contact.type === 'tenant' ? (
           <StaffNotesCard
             contactId={contact.contactId}
             value={contact.staff_notes}
             updatedAt={contact.staff_notes_updated_at}
             onContactUpdated={onContactUpdated}
           />
         ) : null}
   ```
5. Update the header comment's card list (line 2-3) to read
   `Details ... - Staff notes (tenants only) - Preferences & notes - Properties sent ...`.

In `dashboard/src/routes/contact/ContactDetail.tsx`, at the `<TenantFile`
call site (line 1058), add the prop directly after `onEdit={() => setEditing(true)}`:

```tsx
                onContactUpdated={setContact}
```

- [ ] **Step 4: Run, expect green; run the neighbors**

```
cd /w/tmp/staff-notes-past-tours/dashboard && npx vitest run src/routes/contact/TenantFile.test.tsx src/routes/contact/ContactDetail.test.tsx
```

Expected: all green. `ContactDetail.test.tsx` renders the real TenantFile for
tenant contacts; if any of its tests asserts an exact heading COUNT or a
`getByRole('button', { name: /Add/ })` that now matches two buttons, tighten
that test's selector to `'Add a note'` (the existing card's aria-label) and
note it in the slice report.

- [ ] **Step 5: Typecheck and commit**

```
cd /w/tmp/staff-notes-past-tours/dashboard && npm run typecheck
cd /w/tmp/staff-notes-past-tours && git status --porcelain
cd /w/tmp/staff-notes-past-tours && ls "W:/AI Projects/Housing Choice/HC Application/.git/worktrees/staff-notes-past-tours/MERGE_HEAD" 2>/dev/null
cd /w/tmp/staff-notes-past-tours && git add dashboard/src/routes/contact/TenantFile.tsx dashboard/src/routes/contact/ContactDetail.tsx dashboard/src/routes/contact/TenantFile.test.tsx && git commit -m "feat(dashboard/contact): Staff notes card on the tenant file above Preferences & notes, tenants only (spec 3.6)

Co-Authored-By: <AUTHORING-MODEL> <noreply@anthropic.com>"
```

### Task 5: Playwright - staff notes round-trip; scope the existing notes locators

**Files:**
- Modify: `e2e/tests/dashboard-next/contact-detail.spec.ts` (lines 59 and 73)
- Create: `e2e/tests/dashboard-next/tenant-staff-notes.spec.ts`

- [ ] **Step 1: Scope the two existing locators**

In `e2e/tests/dashboard-next/contact-detail.spec.ts`, the test "editing a
contact PATCHes and persists across a reload" holds page-wide
`page.getByLabel('Notes')` locators (lines 59 and 73). Playwright's
`getByLabel` also matches `aria-label` as a case-insensitive substring, so the
new card's "Add staff notes" / "Edit staff notes" buttons would make them
ambiguous (spec 2.1, 5). Scope both to the dialog:

- line 58-59 become:
  ```ts
      const dialog = page.getByRole('dialog', { name: /Edit contact/i });
      await expect(dialog).toBeVisible();
      const notes = dialog.getByLabel('Notes');
  ```
- line 73 becomes:
  ```ts
      await page.getByRole('dialog', { name: /Edit contact/i }).getByLabel('Notes').fill('');
  ```

No assertion changes. Add one line to the file's header comment: `Notes
locators are scoped to the Edit dialog because the tenant file's Staff notes
card (item 22) also carries "notes" in an aria-label.`

- [ ] **Step 2: Write the new spec**

Create `e2e/tests/dashboard-next/tenant-staff-notes.spec.ts`:

```ts
// Staff notes on the tenant file (Sam's item 22; spec
// docs/superpowers/specs/2026-09-26-staff-notes-past-tours-design.md 3.6).
// Against the real backend on the hermetic lane: add -> save -> the text and a
// "Last edited" line show -> a reload still shows them -> the AI-appended
// "Preferences & notes" card is byte-identical throughout -> clear (cleanup:
// the box reads as never set again; the server keeps a stamp by design).
// Also proves the card in edit mode does not overflow at 360px.
//
// getByLabel is a case-insensitive SUBSTRING match that also reads aria-label,
// so every label here is `exact: true`: "Edit staff notes" / "Add staff notes"
// would otherwise match "Staff notes".
import { test, expect, type Page } from '@playwright/test';
import { expectTodayReady } from '../../support/today.js';
import { NARROW_360, WIDE_RESTORE, expectNoHorizontalOverflow } from '../../support/viewport.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const TENANT = 'contact-tenant-0001'; // Tasha Nguyen (lean seed)

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expectTodayReady(page);
}

test.beforeAll(async ({ request }) => {
  const res = await request.post(`${NEXT}/__dev/reseed`);
  expect(res.ok(), `reseed failed: ${res.status()} ${await res.text()}`).toBeTruthy();
});

test.describe('Tenant file - Staff notes card', () => {
  test('add, save, survive a reload, leave Preferences & notes untouched, then clear', async ({ page }) => {
    await devLogin(page);
    await page.goto(`${NEXT}/contacts/${TENANT}`);
    await expect(page.getByRole('heading', { name: 'Details' })).toBeVisible();

    const staffCard = page.locator('section', { has: page.getByRole('heading', { name: /Staff notes/ }) });
    const prefsCard = page.locator('section', { has: page.getByRole('heading', { name: /Preferences & notes/ }) });
    await expect(staffCard).toBeVisible();
    await expect(prefsCard).toBeVisible();
    const prefsBefore = await prefsCard.innerText();

    // Empty at seed time.
    await expect(staffCard.getByText('No staff notes yet.')).toBeVisible();
    await expect(staffCard.getByText(/Last edited/)).toHaveCount(0);

    const marker = 'E2E staff note marker';
    await staffCard.getByRole('button', { name: 'Add staff notes', exact: true }).click();
    const box = staffCard.getByLabel('Staff notes', { exact: true });
    await expect(box).toBeVisible();
    await expect(box).toBeFocused();
    // The aside affordance is hidden while editing.
    await expect(staffCard.getByRole('button', { name: /staff notes/i })).toHaveCount(0);
    await box.fill(marker);
    await staffCard.getByRole('button', { name: 'Save', exact: true }).click();

    // Live, from the returned contact.
    await expect(staffCard.getByText(marker)).toBeVisible();
    await expect(staffCard.getByText(/^Last edited [A-Z][a-z]{2} \d{1,2}, \d{4}$/)).toBeVisible();
    await expect(staffCard.getByLabel('Staff notes', { exact: true })).toHaveCount(0);
    // The AI's card did not move.
    expect(await prefsCard.innerText()).toBe(prefsBefore);

    // Persisted: a full reload refetches and still shows it.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Details' })).toBeVisible();
    await expect(staffCard.getByText(marker)).toBeVisible();
    await expect(staffCard.getByText(/Last edited/)).toBeVisible();
    expect(await prefsCard.innerText()).toBe(prefsBefore);

    // Narrow: the editor must not push the file pane sideways. At phone width
    // the contact page opens on the Comms pane and the profile pane (the
    // file cards) is display:none until the segmented "View" toggle's
    // "Profile" button is pressed (ContactDetail.tsx, the `pane` state).
    await page.setViewportSize(NARROW_360);
    await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Profile' }).click();
    await expect(staffCard).toBeVisible();
    await staffCard.getByRole('button', { name: 'Edit staff notes', exact: true }).click();
    await expect(staffCard.getByLabel('Staff notes', { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page, 'tenant file with the Staff notes editor open at 360px');
    await staffCard.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.setViewportSize(WIDE_RESTORE);

    // Cleanup: clear so the seeded tenant reads pristine for other specs. The
    // server keeps a stamp on a clear (spec 3.1) but the card hides it while
    // the box is empty (spec 3.6).
    await staffCard.getByRole('button', { name: 'Edit staff notes', exact: true }).click();
    await staffCard.getByLabel('Staff notes', { exact: true }).fill('');
    await staffCard.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(staffCard.getByText('No staff notes yet.')).toBeVisible();
    await expect(staffCard.getByText(marker)).toHaveCount(0);
    await expect(staffCard.getByText(/Last edited/)).toHaveCount(0);
  });
});
```

The 360px step above presses the "Profile" toggle first because the page
opens on Comms at that width; restoring the wide viewport shows both panes
again, so the cleanup steps need no toggle.

- [ ] **Step 3: Run both specs against a hermetic session**

```
cd /w/tmp/staff-notes-past-tours && npm run e2e:session
```

(leave it running in the background; wait for its ready line), then:

```
cd /w/tmp/staff-notes-past-tours && npm run e2e -w @housingchoice/e2e -- --grep "Staff notes card|editing a contact PATCHes"
```

Expected: 2 passed. Fix and re-run until green. Stop the session with
`cd /w/tmp/staff-notes-past-tours && npm run e2e:stop` before any full
`npm run e2e` later (never both at once from one worktree).

- [ ] **Step 4: ASCII check and commit**

```
cd /w/tmp/staff-notes-past-tours && tr -d '\11\12\15\40-\176' < e2e/tests/dashboard-next/tenant-staff-notes.spec.ts | wc -c
cd /w/tmp/staff-notes-past-tours && git diff -- e2e/tests/dashboard-next/contact-detail.spec.ts | grep '^+' | grep -v '^+++' | tr -d '\11\12\15\40-\176' | wc -c
cd /w/tmp/staff-notes-past-tours && git status --porcelain
cd /w/tmp/staff-notes-past-tours && ls "W:/AI Projects/Housing Choice/HC Application/.git/worktrees/staff-notes-past-tours/MERGE_HEAD" 2>/dev/null
cd /w/tmp/staff-notes-past-tours && git add e2e/tests/dashboard-next/tenant-staff-notes.spec.ts e2e/tests/dashboard-next/contact-detail.spec.ts && git commit -m "test(e2e): tenant file staff notes round-trip, reload, prefs card untouched, 360px; scope contact-detail Notes locators to the dialog (spec 5)

Co-Authored-By: <AUTHORING-MODEL> <noreply@anthropic.com>"
```

---

## Part 2 - the Past tab

### Task 6: `useTours.ts` - window, selection, state, and the lazy hook

**Files:**
- Modify: `dashboard/src/routes/tours/useTours.ts`
- Modify: `dashboard/src/routes/tours/useTours.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `dashboard/src/routes/tours/useTours.test.ts`. Add `act` to the
`@testing-library/react` import, add `import type { Tour } from '../../api/index.js';`
(a type-only import survives the module mock), and change the post-mock import
to `import { pastState, pastToursDateRange, selectPastTours, useClosedTours, usePastTours, useTours } from './useTours.js';`
(the first `toursDateRange` import stays).

The file's api mock is a bare object exposing only `getTours`; the hook module
now also value-imports `TOUR_STATUS_LABELS` from the barrel, which Vitest's
strict mock would report as a missing export. Change the mock to spread the
real module:

```ts
const getToursMock = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return { ...actual, getTours: (...args: unknown[]) => getToursMock(...args) };
});
```

```ts
// ---------------------------------------------------------------------------
// Past tab (spec 4.2 / 4.3): window, selection, state chip, lazy hook
// ---------------------------------------------------------------------------

describe('pastToursDateRange', () => {
  it('from = start of the local day 90 calendar days ago; to = end of today local (DST-safe)', () => {
    const now = new Date('2026-09-26T15:30:00'); // local
    const { from, to } = pastToursDateRange(now);
    // Same calendar construction the implementation uses - not a millisecond
    // subtraction, which drifts by an hour across a DST change.
    const expectedFrom = new Date(2026, 8, 26 - 90, 0, 0, 0, 0);
    const expectedTo = new Date(2026, 8, 27, 0, 0, 0, 0).getTime() - 1;
    expect(new Date(from).getTime()).toBe(expectedFrom.getTime());
    expect(new Date(to).getTime()).toBe(expectedTo);
  });

  it('the Past window ends 1 ms before tomorrow starts, so the Active window (from = start of today) overlaps only today', () => {
    const now = new Date('2026-09-26T15:30:00');
    const activeFrom = new Date(toursDateRange(now).from).getTime();
    expect(new Date(pastToursDateRange(now).to).getTime()).toBeGreaterThan(activeFrom);
    expect(new Date(pastToursDateRange(now).to).getTime()).toBe(new Date(2026, 8, 27).getTime() - 1);
  });

  it('spans a DST change without an hour of drift (November)', () => {
    const now = new Date('2026-11-15T12:00:00'); // local; 90 days back crosses the fall change in US zones
    const { from } = pastToursDateRange(now);
    const d = new Date(from);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getDate()).toBe(new Date(2026, 10, 15 - 90).getDate());
  });
});

describe('selectPastTours', () => {
  /** A fixed "now": 2026-09-26 15:30 local. */
  const NOW = new Date(2026, 8, 26, 15, 30, 0, 0);
  const at = (y: number, m: number, d: number, h: number): string =>
    new Date(y, m - 1, d, h, 0, 0, 0).toISOString();
  const ROWS = [
    { tourId: 'ns', tenantId: 'c1', unitId: 'u1', scheduledAt: at(2026, 9, 23, 14), tourType: 'self_guided', status: 'no_show' },
    { tourId: 'cx', tenantId: 'c1', unitId: 'u1', scheduledAt: at(2026, 9, 24, 14), tourType: 'self_guided', status: 'canceled' },
    { tourId: 'sc', tenantId: 'c1', unitId: 'u1', scheduledAt: at(2026, 9, 25, 14), tourType: 'self_guided', status: 'scheduled' },
    { tourId: 'cl', tenantId: 'c2', unitId: 'u2', scheduledAt: at(2026, 9, 25, 15), tourType: 'self_guided', status: 'closed' },
    { tourId: 'tb', tenantId: 'c2', unitId: 'u2', scheduledAt: at(2026, 9, 24, 16), tourType: 'self_guided', status: 'toured' },
    { tourId: 'ta', tenantId: 'c2', unitId: 'u2', scheduledAt: at(2026, 9, 24, 16), tourType: 'self_guided', status: 'toured' },
    // A recorded not_a_fit left un-closed: decided, excluded.
    { tourId: 'to', tenantId: 'c2', unitId: 'u2', scheduledAt: at(2026, 9, 22, 16), tourType: 'self_guided', status: 'toured', outcome: 'not_a_fit', moveForward: false },
    // A move_forward whose conversion never happened: Needs placement, kept.
    { tourId: 'np', tenantId: 'c2', unitId: 'u2', scheduledAt: at(2026, 9, 21, 16), tourType: 'self_guided', status: 'toured', outcome: 'move_forward', moveForward: true, convertible: true },
    // A converted tour is closed by the conversion, but pin the rule anyway.
    { tourId: 'cv', tenantId: 'c2', unitId: 'u2', scheduledAt: at(2026, 9, 20, 16), tourType: 'self_guided', status: 'toured', outcome: 'move_forward', moveForward: true, convertible: true, convertedPlacementId: 'pl-1' },
    // Today: a still-scheduled 9:00 tour stays on Active; a toured 10:00, a
    // no-show 11:00 and a tour marked toured EARLY for 17:00 belong here.
    { tourId: 'sc-today', tenantId: 'c1', unitId: 'u1', scheduledAt: at(2026, 9, 26, 9), tourType: 'self_guided', status: 'scheduled' },
    { tourId: 't-today', tenantId: 'c1', unitId: 'u1', scheduledAt: at(2026, 9, 26, 10), tourType: 'self_guided', status: 'toured' },
    { tourId: 'ns-today', tenantId: 'c1', unitId: 'u1', scheduledAt: at(2026, 9, 26, 11), tourType: 'self_guided', status: 'no_show' },
    { tourId: 't-later', tenantId: 'c1', unitId: 'u1', scheduledAt: at(2026, 9, 26, 17), tourType: 'self_guided', status: 'toured' },
  ] as Tour[];

  it('keeps scheduled / toured / no_show only, drops a scheduled row dated today and a decided toured row, keeps a Needs-placement row, most recent first, ties by tourId', () => {
    expect(selectPastTours(ROWS, NOW).map((t) => t.tourId)).toEqual([
      't-later',
      'ns-today',
      't-today',
      'sc',
      'ta',
      'tb',
      'ns',
      'np',
    ]);
  });

  it('returns a new array and never mutates its input', () => {
    const input = [...ROWS];
    selectPastTours(input, NOW);
    expect(input.map((t) => t.tourId)).toEqual(ROWS.map((t) => t.tourId));
  });
});

describe('pastState', () => {
  const base = { tourId: 't', tenantId: 'c', unitId: 'u', tourType: 'self_guided' } as const;
  it('scheduled -> Not marked', () => {
    expect(pastState({ ...base, status: 'scheduled' } as Tour)).toBe('Not marked');
  });
  it('toured without an outcome -> Needs outcome', () => {
    expect(pastState({ ...base, status: 'toured' } as Tour)).toBe('Needs outcome');
  });
  it('toured, convertible, no placement -> Needs placement', () => {
    expect(pastState({ ...base, status: 'toured', outcome: 'move_forward', moveForward: true, convertible: true } as Tour)).toBe('Needs placement');
  });
  it('no_show -> No show', () => {
    expect(pastState({ ...base, status: 'no_show' } as Tour)).toBe('No show');
  });
  it('anything else -> the status label (never blank)', () => {
    expect(pastState({ ...base, status: 'canceled' } as Tour)).toBe('Canceled');
  });
  it('precedence: a toured row with NO outcome reads Needs outcome even if it is convertible (an API-only shape)', () => {
    expect(pastState({ ...base, status: 'toured', convertible: true } as Tour)).toBe('Needs outcome');
  });
});

describe('usePastTours', () => {
  beforeEach(() => {
    getToursMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const yesterdayAt = (h: number): string => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    d.setHours(h, 0, 0, 0);
    return d.toISOString();
  };
  const WINDOW_ROWS = [
    { tourId: 'sc', tenantId: 'c1', unitId: 'u1', scheduledAt: yesterdayAt(14), tourType: 'self_guided', status: 'scheduled' },
    { tourId: 'cx', tenantId: 'c1', unitId: 'u1', scheduledAt: yesterdayAt(10), tourType: 'self_guided', status: 'canceled' },
  ];

  it('stays idle and fetches NOTHING while disabled', () => {
    const { result } = renderHook(() => usePastTours(false));
    expect(result.current.status).toBe('idle');
    expect(getToursMock).not.toHaveBeenCalled();
  });

  it('once enabled, fetches ONE range query with the Past window (through end of today) and applies selectPastTours', async () => {
    getToursMock.mockResolvedValue(WINDOW_ROWS);
    const { result } = renderHook(() => usePastTours(true));
    // No synchronous 'loading' write (the lint preset forbids setState in an
    // effect body): the hook reads 'idle' until the first result lands.
    expect(result.current.status).toBe('idle');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(getToursMock).toHaveBeenCalledTimes(1);
    const [params] = getToursMock.mock.calls[0] as [Record<string, string>];
    expect(Object.keys(params).sort()).toEqual(['from', 'to']);
    const n = new Date();
    const endOfToday = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1, 0, 0, 0, 0).getTime() - 1;
    expect(new Date(params['to']!).getTime()).toBe(endOfToday);
    expect(new Date(params['from']!).getTime()).toBe(new Date(n.getFullYear(), n.getMonth(), n.getDate() - 90, 0, 0, 0, 0).getTime());
    expect(result.current.past.map((t) => t.tourId)).toEqual(['sc']);
  });

  it('reload() refetches and keeps the current rows on screen until the new page lands', async () => {
    getToursMock.mockResolvedValue(WINDOW_ROWS);
    const { result } = renderHook(() => usePastTours(true));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    getToursMock.mockResolvedValue([]);
    act(() => result.current.reload());
    // Still ready with the old rows while the refetch is in flight.
    expect(result.current.status).toBe('ready');
    expect(result.current.past.map((t) => t.tourId)).toEqual(['sc']);
    await waitFor(() => expect(getToursMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.past).toEqual([]));
  });

  it('sets status=error when the FIRST fetch fails', async () => {
    getToursMock.mockRejectedValue(new Error('network error'));
    const { result } = renderHook(() => usePastTours(true));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.past).toEqual([]);
    expect(result.current.reloadFailed).toBe(false);
  });

  it('a failed RELOAD keeps the rows, stays ready and sets reloadFailed; the next success clears it', async () => {
    getToursMock.mockResolvedValue(WINDOW_ROWS);
    const { result } = renderHook(() => usePastTours(true));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    getToursMock.mockRejectedValueOnce(new Error('network error'));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.reloadFailed).toBe(true));
    expect(result.current.status).toBe('ready');
    expect(result.current.past.map((t) => t.tourId)).toEqual(['sc']);
    getToursMock.mockResolvedValue([]);
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.reloadFailed).toBe(false));
    expect(result.current.past).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, expect red**

```
cd /w/tmp/staff-notes-past-tours/dashboard && npx vitest run src/routes/tours/useTours.test.ts
```

- [ ] **Step 3: Implement**

In `dashboard/src/routes/tours/useTours.ts`:

1. Change the imports to
   `import { useCallback, useEffect, useState } from 'react';` and
   `import { getTours, TOUR_STATUS_LABELS, type Tour, type TourStatus } from '../../api/index.js';`
2. Extend the header comment with a third bullet:
   ```
   // Plus usePastTours(enabled) - the Past tab's fetch (spec 4.2): ONE range
   // query over [start of the local day 90 days ago, end of today], selected
   // on the client (the range GSI matches on scheduledAt alone, same as
   // Upcoming): scheduled / toured / no_show only, minus a still-scheduled
   // tour dated today (Active's Today group has it) and minus a toured tour
   // whose outcome is recorded - unless that outcome is a move-forward whose
   // placement was never created (Needs placement). Most recent first.
   // `reload()` refetches after a bulk action while keeping the current rows
   // on screen; a failed reload keeps them too and sets reloadFailed.
   ```
3. Append at the end of the file:

```ts
// ---------------------------------------------------------------------------
// Past tab (spec 4.2 / 4.3)
// ---------------------------------------------------------------------------

/** How far back the Past tab looks. Said aloud in the tab's intro line. */
export const PAST_TAB_DAYS = 90;

/** The Past tab's statuses: a tour whose time has passed and that still needs a
 *  human decision. Canceled and closed belong to Closed; requested has no time. */
export const PAST_TAB_STATUSES: ReadonlySet<TourStatus> = new Set<TourStatus>([
  'scheduled',
  'toured',
  'no_show',
]);

/** Start of `now`'s LOCAL calendar day. */
function startOfLocalDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
}

/** [start of the local day 90 calendar days ago, end of today local] as UTC
 *  ISO strings. Calendar arithmetic, not a millisecond subtraction: across a
 *  DST change the two differ by an hour and the window would start at 23:00
 *  or 01:00. The window runs THROUGH today (not to `now`) so a tour marked
 *  toured or no-show before its time today is listed; selectPastTours drops
 *  today's still-scheduled rows, which Active's Today group already shows. */
export function pastToursDateRange(now: Date = new Date()): { from: string; to: string } {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - PAST_TAB_DAYS, 0, 0, 0, 0);
  const to = new Date(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0).getTime() - 1);
  return { from: from.toISOString(), to: to.toISOString() };
}

/** A toured tour whose move-forward decision never became a placement (a
 *  failed conversion - the tour page's "Start placement" is the retry). */
function needsPlacement(t: Tour): boolean {
  return t.status === 'toured' && t.convertible === true && t.convertedPlacementId === undefined;
}

/** Select and order the Past rows (spec 4.2). Pure; never mutates its input.
 *  1. keep scheduled / toured / no_show;
 *  2. drop a scheduled row dated today (Active's Today group shows it all day;
 *     it is not "past" until the day ends);
 *  3. drop a toured row that carries an outcome (its decision is recorded)
 *     UNLESS it still needs its placement;
 *  4. most recent scheduledAt first, ties by tourId. */
export function selectPastTours(tours: Tour[], now: Date = new Date()): Tour[] {
  const todayStart = startOfLocalDay(now).toISOString();
  return tours
    .filter((t) => PAST_TAB_STATUSES.has(t.status))
    .filter((t) => !(t.status === 'scheduled' && (t.scheduledAt ?? '') >= todayStart))
    .filter((t) => !(t.status === 'toured' && t.outcome !== undefined && !needsPlacement(t)))
    .sort((a, b) => {
      const aAt = a.scheduledAt ?? '';
      const bAt = b.scheduledAt ?? '';
      if (aAt !== bAt) return aAt > bAt ? -1 : 1;
      return a.tourId < b.tourId ? -1 : a.tourId > b.tourId ? 1 : 0;
    });
}

/** The plain-words state chip for a Past row (spec 4.3). Any other status
 *  falls back to its label so a mis-selected row is never blank. */
export function pastState(tour: Tour): string {
  if (tour.status === 'scheduled') return 'Not marked';
  if (tour.status === 'toured' && tour.outcome === undefined) return 'Needs outcome';
  if (needsPlacement(tour)) return 'Needs placement';
  if (tour.status === 'no_show') return 'No show';
  return TOUR_STATUS_LABELS[tour.status] ?? tour.status;
}

export interface PastToursState {
  /** 'idle' until the first result lands (the page shows its spinner for idle);
   *  'error' ONLY when the first load fails (a failed reload keeps the rows
   *  and sets reloadFailed). There is no 'loading' value: writing one
   *  synchronously in the effect is what react-hooks/set-state-in-effect
   *  forbids, and idle already means "nothing shown yet". */
  status: 'idle' | 'ready' | 'error';
  /** The selected Past rows, most recent first. */
  past: Tour[];
  /** Refetch (after a bulk action). Keeps the current rows until the new page lands. */
  reload: () => void;
  /** The last reload failed; the rows on screen are stale. Cleared by the next
   *  successful load. Never true alongside status 'error'. */
  reloadFailed: boolean;
}

/** LAZY fetch for the Past view - one range query, client-selected. */
export function usePastTours(enabled: boolean): PastToursState {
  const [state, setState] = useState<{
    status: PastToursState['status'];
    past: Tour[];
    reloadFailed: boolean;
  }>({ status: 'idle', past: [], reloadFailed: false });
  const [epoch, setEpoch] = useState(0);
  const reload = useCallback(() => setEpoch((e) => e + 1), []);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const { signal } = controller;
    // NO synchronous setState here (react-hooks/set-state-in-effect is an
    // error in this workspace): the first load leaves status 'idle', which
    // the page renders as its spinner; a reload keeps the rows on screen (no
    // spinner flash under a bulk result). Every write below is in the async
    // callback.

    (async () => {
      try {
        const now = new Date();
        const { from, to } = pastToursDateRange(now);
        const rows = await getTours({ from, to }, signal);
        if (signal.aborted) return;
        setState({ status: 'ready', past: selectPastTours(rows, now), reloadFailed: false });
      } catch (err) {
        if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        // A failed RELOAD must not wipe the rows and the per-row results under
        // them (spec 4.2): stay ready, flag it. A failed FIRST load is an error.
        setState((s) =>
          s.status === 'ready' ? { ...s, reloadFailed: true } : { status: 'error', past: [], reloadFailed: false },
        );
      }
    })();

    return () => controller.abort();
  }, [enabled, epoch]);

  return { status: state.status, past: state.past, reload, reloadFailed: state.reloadFailed };
}
```

The `(t.scheduledAt ?? '') >= todayStart` comparison is a lexicographic
compare of two UTC ISO strings of equal shape (`toISOString` output on both
sides: the server canonicalizes `scheduledAt` with `toISOString`, `tours.ts`
create and patch), which is why it is safe.

- [ ] **Step 4: Run, expect green**

```
cd /w/tmp/staff-notes-past-tours/dashboard && npx vitest run src/routes/tours/useTours.test.ts
```

Expected: all green (the pre-existing tests plus 15 new).

- [ ] **Step 5: Typecheck and commit**

```
cd /w/tmp/staff-notes-past-tours/dashboard && npm run typecheck
cd /w/tmp/staff-notes-past-tours && git status --porcelain
cd /w/tmp/staff-notes-past-tours && ls "W:/AI Projects/Housing Choice/HC Application/.git/worktrees/staff-notes-past-tours/MERGE_HEAD" 2>/dev/null
cd /w/tmp/staff-notes-past-tours && git add dashboard/src/routes/tours/useTours.ts dashboard/src/routes/tours/useTours.test.ts && git commit -m "feat(dashboard/tours): Past tab data - 90-day window through end of today, client selection, state chip, lazy usePastTours with reload (spec 4.2, 4.3)

Co-Authored-By: <AUTHORING-MODEL> <noreply@anthropic.com>"
```

### Task 7: ToursPage - the Past view, rows, actions, bulk runner; App routes

**Files:**
- Modify: `dashboard/src/routes/tours/ToursPage.tsx`
- Modify: `dashboard/src/routes/tours/ToursPage.module.css`
- Modify: `dashboard/src/routes/tours/ToursPage.test.tsx`
- Modify: `dashboard/src/App.tsx` (lines 237-240)

- [ ] **Step 1: Write the failing tests**

In `dashboard/src/routes/tours/ToursPage.test.tsx`:

1. Add a Past hook mock beside the closed one (top of file, after
   `closedState`):
   ```tsx
   import type { PastToursState } from './useTours.js';
   let pastRows: Omit<PastToursState, 'reload'> = { status: 'ready', past: [], reloadFailed: false };
   const reloadPast = vi.fn();
   const usePastToursSpy = vi.fn(
     (enabled: boolean): PastToursState =>
       enabled
         ? { ...pastRows, reload: reloadPast }
         : { status: 'idle', past: [], reload: reloadPast, reloadFailed: false },
   );
   ```
   and convert the `vi.mock('./useTours.js', ...)` factory to the spread form
   so the pure helpers the page imports from that module stay real:
   ```tsx
   vi.mock('./useTours.js', async () => {
     const actual = await vi.importActual<typeof import('./useTours.js')>('./useTours.js');
     return {
       ...actual,
       useTours: () => toursState,
       useClosedTours: (enabled: boolean) => useClosedToursSpy(enabled),
       usePastTours: (enabled: boolean) => usePastToursSpy(enabled),
     };
   });
   ```
2. Add `getTour` and `patchTour` to the api mock:
   `const getTour = vi.fn(); const patchTour = vi.fn();` and
   `getTour: (...a: unknown[]) => getTour(...(a as [])), patchTour: (...a: unknown[]) => patchTour(...(a as [])),`
   in the `vi.mock('../../api/index.js', ...)` return. Import `ApiError` from
   `'../../api/index.js'` (a value import; the api mock spreads `actual`).
3. Update `renderPage` to the three views plus a location probe:
   ```tsx
   import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

   /** Shows where a row link landed and what state it carried (unit-test only). */
   function LocationProbe(): React.JSX.Element {
     const l = useLocation();
     return (
       <output data-testid="loc">
         {l.pathname}
         {l.search}|{JSON.stringify(l.state ?? null)}
       </output>
     );
   }

   function renderPage(initialPath = '/tours'): void {
     render(
       <MemoryRouter initialEntries={[initialPath]}>
         <Routes>
           <Route path="/tours" element={<ToursPage />} />
           <Route path="/tours/past" element={<ToursPage view="past" />} />
           <Route path="/tours/closed" element={<ToursPage view="closed" />} />
           <Route path="/tours/:tourId" element={<LocationProbe />} />
         </Routes>
       </MemoryRouter>,
     );
   }
   ```
   Also add `waitFor` to the file's `@testing-library/react` import (the
   base import at line 12 has only `render, screen, within`; the new tests
   below use `waitFor` and `findBy*`).
4. In `beforeEach`, add `pastRows = { status: 'ready', past: [], reloadFailed: false }; reloadPast.mockClear(); usePastToursSpy.mockClear(); getTour.mockReset(); patchTour.mockReset();`.
5. In the existing 'Active view: renders the view tabs ...' test, add:
   ```tsx
       const pastTab = within(tabs).getByRole('link', { name: 'Past' });
       expect(pastTab).not.toHaveAttribute('aria-current');
       expect(pastTab).toHaveAttribute('href', '/tours/past');
       // The Past data hook lives in a Past-only child, so it is never even
       // called on the Active view.
       expect(usePastToursSpy).not.toHaveBeenCalled();
   ```
6. Append a new describe block. Use the file's real `CONTACTS` / `UNITS`
   fixtures for the names below (replace "Alice Smith" and "12 Peach St,
   Atlanta, GA" with the actual `c1` name and `u1` address the file defines):

```tsx
// ---------------------------------------------------------------------------
// Past view (/tours/past) - spec 4.1, 4.3, 4.4, 4.5
// ---------------------------------------------------------------------------

describe('ToursPage - Past view', () => {
  /** `days` days ago at `hours`:00 local, as the wire ISO string. */
  function daysAgoAt(days: number, hours: number): string {
    const d = new Date();
    d.setDate(d.getDate() - days);
    d.setHours(hours, 0, 0, 0);
    return d.toISOString();
  }
  /** The row's own "Sep 24, 2026, 2:30 PM" string for an ISO instant. */
  function whenLabel(iso: string): string {
    const d = new Date(iso);
    return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  }
  const NOT_MARKED: Tour = { tourId: 'p1', tenantId: 'c1', unitId: 'u1', scheduledAt: daysAgoAt(1, 14), tourType: 'self_guided', status: 'scheduled' };
  const NEEDS_OUTCOME: Tour = { tourId: 'p2', tenantId: 'c2', unitId: 'u2', scheduledAt: daysAgoAt(2, 10), tourType: 'landlord_led', status: 'toured' };
  const NO_SHOW: Tour = { tourId: 'p3', tenantId: 'c1', unitId: 'u2', scheduledAt: daysAgoAt(3, 9), tourType: 'pm_team', status: 'no_show' };
  const NOT_MARKED_2: Tour = { tourId: 'p4', tenantId: 'c2', unitId: 'u1', scheduledAt: daysAgoAt(4, 11), tourType: 'self_guided', status: 'scheduled' };
  const NEEDS_PLACEMENT: Tour = { tourId: 'p5', tenantId: 'c2', unitId: 'u2', scheduledAt: daysAgoAt(5, 12), tourType: 'self_guided', status: 'toured', outcome: 'move_forward', moveForward: true, convertible: true };
  // Labels use the file's real fixtures: c1 = Alice Smith, c2 = Bob Jones,
  // u1 = "123 Peachtree St, Atlanta, GA, 30303", u2 = "456 Oak Ave, Decatur,
  // GA, 30030" (formatAddress joins line1, city, state, zip with ", ").
  const U1 = '123 Peachtree St, Atlanta, GA, 30303';
  const P1_LABEL = `Alice Smith at ${U1} on ${whenLabel(NOT_MARKED.scheduledAt!)}`;
  const P4_LABEL = `Bob Jones at ${U1} on ${whenLabel(NOT_MARKED_2.scheduledAt!)}`;

  function readyPast(rows: Tour[], reloadFailed = false): void {
    readyAll([], []);
    pastRows = { status: 'ready', past: rows, reloadFailed };
  }

  it('renders the heading, the 90-day intro, the Past tab current, and the empty state', () => {
    readyPast([]);
    renderPage('/tours/past');
    expect(screen.getByRole('heading', { level: 1, name: 'Past tours' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Last 90 days: tours that were never marked toured, toured tours still waiting on an outcome or a placement, and no-shows.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Past' })).toHaveAttribute('aria-current', 'page');
    expect(usePastToursSpy).toHaveBeenCalledWith(true);
    expect(screen.getByText('No past tours need attention in the last 90 days.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ New tour' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Upcoming tours' })).not.toBeInTheDocument();
  });

  it('rows: date + time, tenant, property, plain-words state, date-time in the label, and the row link carrying state.back', async () => {
    const user = userEvent.setup();
    readyPast([NOT_MARKED, NEEDS_OUTCOME, NO_SHOW]);
    renderPage('/tours/past');
    const region = screen.getByRole('region', { name: 'Past tours' });
    const items = within(region).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    // Order is the hook's order (most recent first).
    const rowLink = within(items[0]!).getByRole('link', { name: `Tour for ${P1_LABEL}` });
    expect(rowLink).toHaveAttribute('href', '/tours/p1');
    expect(within(items[0]!).getByText('Not marked')).toBeInTheDocument();
    expect(within(items[0]!).getByText(whenLabel(NOT_MARKED.scheduledAt!))).toBeInTheDocument();
    expect(within(items[1]!).getByText('Needs outcome')).toBeInTheDocument();
    expect(within(items[2]!).getByText('No show')).toBeInTheDocument();
    // No tour-type badge on Past rows.
    expect(within(region).queryByText('Self-guided')).not.toBeInTheDocument();
    // The row link carries the back pointer.
    await user.click(rowLink);
    expect(screen.getByTestId('loc')).toHaveTextContent('/tours/p1|{"back":"/tours/past"}');
  });

  it('row actions: Mark toured + checkbox on Not marked; Record outcome deep link (with state.back) on Needs outcome; none on No show or Needs placement', async () => {
    const user = userEvent.setup();
    readyPast([NOT_MARKED, NEEDS_OUTCOME, NO_SHOW, NEEDS_PLACEMENT]);
    renderPage('/tours/past');
    const items = within(screen.getByRole('region', { name: 'Past tours' })).getAllByRole('listitem');
    expect(within(items[3]!).getByText('Needs placement')).toBeInTheDocument();
    expect(within(items[3]!).queryByRole('button')).not.toBeInTheDocument();
    expect(within(items[3]!).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(items[3]!).queryByRole('link', { name: /Record outcome/ })).not.toBeInTheDocument();
    expect(within(items[0]!).getByRole('button', { name: `Mark toured: ${P1_LABEL}` })).toBeInTheDocument();
    expect(within(items[0]!).getByRole('checkbox', { name: `Select tour for ${P1_LABEL}` })).toBeInTheDocument();
    const record = within(items[1]!).getByRole('link', { name: /^Record outcome: .* on /, });
    expect(record).toHaveAttribute('href', '/tours/p2?outcome=1');
    expect(within(items[1]!).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(items[2]!).queryByRole('button')).not.toBeInTheDocument();
    expect(within(items[2]!).queryByRole('link', { name: /Record outcome/ })).not.toBeInTheDocument();
    expect(within(items[2]!).queryByRole('checkbox')).not.toBeInTheDocument();
    await user.click(record);
    expect(screen.getByTestId('loc')).toHaveTextContent('/tours/p2?outcome=1|{"back":"/tours/past"}');
  });

  it('bulk: select all -> Mark toured (N) re-reads then PATCHes each id sequentially, disables every control meanwhile, reports per row, reloads', async () => {
    const user = userEvent.setup();
    readyPast([NOT_MARKED, NEEDS_OUTCOME, NOT_MARKED_2]);
    // The re-read agrees with the list for p1 and reports p4 as canceled since.
    getTour.mockImplementation((id: string) =>
      Promise.resolve(id === 'p4' ? { ...NOT_MARKED_2, status: 'canceled' } : NOT_MARKED),
    );
    const order: string[] = [];
    let release: (() => void) | null = null;
    patchTour.mockImplementation((id: string) => {
      order.push(id);
      // Hold the FIRST call so we can prove nothing else has started.
      return new Promise((resolve) => {
        release = () => resolve({ ...NOT_MARKED, tourId: id, status: 'toured' });
      });
    });
    renderPage('/tours/past');

    expect(screen.getByRole('button', { name: 'Mark toured (0)' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Select all not marked' }));
    expect(screen.getByRole('button', { name: 'Mark toured (2)' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Mark toured (2)' }));
    // p1 was re-read and PATCHed; p4 has not been touched yet (sequential).
    await waitFor(() => expect(order).toEqual(['p1']));
    expect(getTour).toHaveBeenCalledTimes(1);
    // Every mark control is disabled while the batch runs.
    expect(screen.getByRole('button', { name: 'Mark toured (2)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: `Mark toured: ${P1_LABEL}` })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Select all not marked' })).toBeDisabled();
    for (const box of screen.getAllByRole('checkbox')) expect(box).toBeDisabled();
    release!();

    // p4's re-read says canceled -> skipped, never PATCHed.
    await waitFor(() => expect(getTour).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(reloadPast).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['p1']);
    expect(patchTour).toHaveBeenCalledWith('p1', { status: 'toured' });

    const items = within(screen.getByRole('region', { name: 'Past tours' })).getAllByRole('listitem');
    expect(within(items[0]!).getByRole('status')).toHaveTextContent('Marked toured');
    expect(within(items[2]!).getByRole('alert')).toHaveTextContent('Could not mark toured: Changed since the list loaded');
    // The failed row stays selected; the succeeded one left the selection.
    expect(screen.getByRole('button', { name: 'Mark toured (1)' })).toBeEnabled();
    expect(within(items[2]!).getByRole('checkbox')).toBeChecked();
    expect(within(items[0]!).getByRole('checkbox')).not.toBeChecked();
  });

  it('results whose rows the reload dropped are reported above the toolbar (a failure as alert, a success as status), from the snapshot', async () => {
    const user = userEvent.setup();
    readyPast([NOT_MARKED, NOT_MARKED_2]);
    getTour.mockImplementation((id: string) =>
      Promise.resolve(id === 'p4' ? { ...NOT_MARKED_2, status: 'canceled' } : NOT_MARKED),
    );
    patchTour.mockResolvedValue({ ...NOT_MARKED, status: 'toured' });
    // The mocked hook is not reactive, so the "reload" swaps its rows
    // SYNCHRONOUSLY inside reloadPast(): the runner calls reloadPast() and
    // then setBulkBusy(false) in the same async continuation, and React
    // batches both into ONE render that reads the new rows. Here the reload
    // drops BOTH ids: p4 is canceled now, and p1 (marked toured) is gone
    // because its "toured" row was, say, given an outcome meanwhile.
    reloadPast.mockImplementation(() => {
      pastRows = { status: 'ready', past: [], reloadFailed: false };
    });
    renderPage('/tours/past');
    await user.click(screen.getByRole('checkbox', { name: 'Select all not marked' }));
    await user.click(screen.getByRole('button', { name: 'Mark toured (2)' }));
    await waitFor(() => expect(reloadPast).toHaveBeenCalledTimes(1));

    // The list is empty now; both results survive above it, named from the
    // snapshot. findBy* waits for the batched render to commit.
    const region = await screen.findByRole('region', { name: 'Past tours' });
    expect(await within(region).findByText('No past tours need attention in the last 90 days.')).toBeInTheDocument();
    expect(await within(region).findByRole('alert')).toHaveTextContent(`${P4_LABEL}: Changed since the list loaded`);
    expect(await within(region).findByRole('status')).toHaveTextContent(`${P1_LABEL}: Marked toured`);
    // No per-row line is left dangling.
    expect(screen.queryByText('Could not mark toured: Changed since the list loaded')).not.toBeInTheDocument();
    expect(screen.queryByText('Marked toured', { exact: true })).not.toBeInTheDocument();
  });

  it('switching tabs unmounts the Past view: selection and results are gone when Past shows again', async () => {
    const user = userEvent.setup();
    readyPast([NOT_MARKED, NOT_MARKED_2]);
    getTour.mockResolvedValue({ ...NOT_MARKED_2, status: 'canceled' });
    renderPage('/tours/past');
    await user.click(screen.getByRole('checkbox', { name: 'Select all not marked' }));
    await user.click(screen.getByRole('button', { name: 'Mark toured (2)' }));
    await waitFor(() => expect(reloadPast).toHaveBeenCalledTimes(1));
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('link', { name: 'Active' }));
    expect(screen.queryByRole('region', { name: 'Past tours' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Past' }));
    const region = await screen.findByRole('region', { name: 'Past tours' });
    expect(within(region).queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark toured (0)' })).toBeDisabled();
    for (const box of within(region).getAllByRole('checkbox')) {
      expect(box).not.toBeChecked();
    }
  });

  it('the row button marks that one tour (one re-read, one PATCH), and the batch never sends an outcome or closed', async () => {
    const user = userEvent.setup();
    readyPast([NOT_MARKED, NOT_MARKED_2]);
    getTour.mockResolvedValue(NOT_MARKED);
    patchTour.mockResolvedValue({ ...NOT_MARKED, status: 'toured' });
    renderPage('/tours/past');
    await user.click(screen.getByRole('button', { name: `Mark toured: ${P1_LABEL}` }));
    await waitFor(() => expect(patchTour).toHaveBeenCalledTimes(1));
    expect(getTour).toHaveBeenCalledTimes(1);
    expect(patchTour).toHaveBeenCalledWith('p1', { status: 'toured' });
    for (const [, body] of patchTour.mock.calls as [string, Record<string, unknown>][]) {
      expect(Object.keys(body)).toEqual(['status']);
    }
    expect(reloadPast).toHaveBeenCalledTimes(1);
  });

  it('a tour RESCHEDULED since the list loaded (still scheduled, different time) is skipped as Changed since the list loaded', async () => {
    const user = userEvent.setup();
    readyPast([NOT_MARKED]);
    getTour.mockResolvedValue({ ...NOT_MARKED, scheduledAt: '2030-01-10T15:00:00.000Z' });
    renderPage('/tours/past');
    await user.click(screen.getByRole('button', { name: `Mark toured: ${P1_LABEL}` }));
    await waitFor(() => expect(reloadPast).toHaveBeenCalledTimes(1));
    expect(patchTour).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not mark toured: Changed since the list loaded');
  });

  it('a PATCH failure reads The update failed', async () => {
    const user = userEvent.setup();
    readyPast([NOT_MARKED]);
    getTour.mockResolvedValue(NOT_MARKED);
    patchTour.mockRejectedValue(new ApiError(409, 'illegal_status_transition', 'illegal_status_transition'));
    renderPage('/tours/past');
    await user.click(screen.getByRole('button', { name: `Mark toured: ${P1_LABEL}` }));
    await waitFor(() => expect(reloadPast).toHaveBeenCalledTimes(1));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Could not mark toured: The update failed');
    expect(alert).not.toHaveTextContent('illegal_status_transition');
  });

  it('a failed re-read is reported as Could not check the tour and the tour is not PATCHed', async () => {
    const user = userEvent.setup();
    readyPast([NOT_MARKED]);
    getTour.mockRejectedValue(new ApiError(500, 'boom', 'boom'));
    renderPage('/tours/past');
    await user.click(screen.getByRole('button', { name: `Mark toured: ${P1_LABEL}` }));
    await waitFor(() => expect(reloadPast).toHaveBeenCalledTimes(1));
    expect(patchTour).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not mark toured: Could not check the tour');
  });

  it('shows the page error when the FIRST Past fetch fails', () => {
    readyAll([], []);
    pastRows = { status: 'error', past: [], reloadFailed: false };
    renderPage('/tours/past');
    expect(screen.getByRole('alert')).toHaveTextContent(/couldn.t load/i);
    expect(screen.queryByRole('region', { name: 'Past tours' })).not.toBeInTheDocument();
  });

  it('a failed RELOAD keeps the rows and adds one refresh alert above the toolbar', () => {
    readyPast([NOT_MARKED], true);
    renderPage('/tours/past');
    const region = screen.getByRole('region', { name: 'Past tours' });
    expect(within(region).getAllByRole('listitem')).toHaveLength(1);
    expect(within(region).getByRole('alert')).toHaveTextContent(
      'Could not refresh the list. Reload the page to see the latest.',
    );
  });
});
```

The "dropped rows" test relies on React batching `reloadPast()`'s synchronous
row swap with the `setBulkBusy(false)` that follows it into one render. If
that render does not observe the swap, make `usePastToursSpy` reactive with a
tiny `useSyncExternalStore` store around `pastRows` and note it in the slice
report; do not weaken the assertions.

- [ ] **Step 2: Run, expect red**

```
cd /w/tmp/staff-notes-past-tours/dashboard && npx vitest run src/routes/tours/ToursPage.test.tsx
```

- [ ] **Step 3: Styles**

Append to `dashboard/src/routes/tours/ToursPage.module.css`:

```css
/* --- Past view (spec 4.3-4.5) ------------------------------------------- */

/* A Past row is NOT one link: the checkbox and the actions sit BESIDE the link
 * (interactive content cannot nest inside an <a>). The link keeps .row's
 * card look and takes the room; the leading checkbox and trailing actions
 * stay out of its flow. */
.pastRow {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.pastRow > .row {
  flex: 1 1 auto;
  min-width: 0;
}

.check {
  flex: 0 0 auto;
  width: 1.1rem;
  height: 1.1rem;
  margin: 0;
  accent-color: var(--c-brand);
}

.rowActions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.actionLink {
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  color: var(--c-brand);
  white-space: nowrap;
}

.actionLink:focus-visible {
  outline: 2px solid var(--c-focus-ring);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}

/* Per-row bulk result, under the row. */
.rowResult {
  margin: var(--sp-1) 0 0 var(--sp-4);
  font-size: var(--fs-xs);
  color: var(--c-text-muted);
}

.rowResultError {
  color: var(--c-danger);
}

/* Failures for rows the reload dropped: one line per tour, above the toolbar. */
.vanished {
  margin: 0 0 var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md);
  background: var(--c-surface);
  color: var(--c-danger);
  font-size: var(--fs-sm);
}

.vanishedOk {
  margin: 0 0 var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md);
  background: var(--c-surface);
  color: var(--c-text-muted);
  font-size: var(--fs-sm);
}

.vanished p,
.vanishedOk p {
  margin: 0;
}

/* The refresh alert reuses .vanished; as a <p> it needs its own margin reset. */
p.vanished {
  margin: 0 0 var(--sp-3);
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  flex-wrap: wrap;
  margin-bottom: var(--sp-3);
}

.selectAll {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-sm);
  color: var(--c-text-muted);
}

/* Tight pane: the actions wrap under the link, right-aligned; the checkbox
 * stays leading on the first line. */
@container (max-width: 560px) {
  .pastRow {
    flex-wrap: wrap;
  }
  .rowActions {
    flex: 1 1 100%;
    justify-content: flex-end;
  }
}
```

- [ ] **Step 4: The page**

In `dashboard/src/routes/tours/ToursPage.tsx`:

1. Imports: react becomes `import { useMemo, useRef, useState } from 'react';`;
   the api import adds `getTour, patchTour`:
   ```tsx
   import {
     TOUR_STATUS_LABELS,
     TOUR_TYPE_LABELS,
     getTour,
     patchTour,
     type Tour,
     type Contact,
     type UnitItem,
   } from '../../api/index.js';
   ```
   and the hook import becomes
   `import { pastState, useClosedTours, usePastTours, useTours } from './useTours.js';`
2. Replace the `ToursPageProps` / `VIEW_TABS` block with:

```tsx
export type ToursView = 'active' | 'past' | 'closed';

export interface ToursPageProps {
  /** Which URL-backed view: the default active list, the Past tab (spec 4.1),
   *  or the Closed tab. */
  view?: ToursView;
}

/** Active / Past / Closed view tabs. Links to the three routes so the URL is
 *  the source of truth (mirrors the properties list's Active/Deleted tabs). */
const VIEW_TABS: { view: ToursView; label: string; to: string }[] = [
  { view: 'active', label: 'Active', to: '/tours' },
  { view: 'past', label: 'Past', to: '/tours/past' },
  { view: 'closed', label: 'Closed', to: '/tours/closed' },
];

const PAGE_TITLE: Record<ToursView, string> = {
  active: 'Tours',
  past: 'Past tours',
  closed: 'Closed tours',
};

const PAGE_INTRO: Record<ToursView, string> = {
  active: 'Upcoming scheduled tours and unbooked tour requests.',
  past: 'Last 90 days: tours that were never marked toured, toured tours still waiting on an outcome or a placement, and no-shows.',
  closed: 'Tours that ended - converted into a placement, closed as not a fit, or canceled.',
};

/** Router state the Past tab's links carry so the tour page's back arrow
 *  returns here (spec 4.6). */
const BACK_TO_PAST = { back: '/tours/past' } as const;

/** One bulk "Mark toured" result, per tour (spec 4.5). The three messages are
 *  fixed strings - never a raw server code. */
type MarkResult = { ok: true } | { ok: false; message: MarkFailure };
type MarkFailure = 'Could not check the tour' | 'Changed since the list loaded' | 'The update failed';

/** The row's "Sep 24, 2026, 2:30 PM" string (also the suffix of every label). */
function whenLabel(iso: string | undefined): string {
  return [formatDate(iso), formatTime(iso)].filter((s) => s.length > 0).join(', ');
}
```

3. Add the Past row component after `TourRow`:

```tsx
interface PastTourRowProps {
  tour: Tour;
  contacts: Map<string, Contact>;
  units: Map<string, UnitItem>;
  selected: boolean;
  onToggle: () => void;
  onMarkToured: () => void;
  busy: boolean;
  result: MarkResult | undefined;
}

/** A Past row (spec 4.3): the link carries identity + meta and the back
 *  pointer; the checkbox and the actions sit BESIDE it (interactive content
 *  cannot nest inside an <a>). Every accessible name ends with the row's
 *  date-time so two tours for one tenant at one property stay distinct. */
function PastTourRow({
  tour,
  contacts,
  units,
  selected,
  onToggle,
  onMarkToured,
  busy,
  result,
}: PastTourRowProps): React.JSX.Element {
  const tenant = tenantName(contacts, tour.tenantId);
  const property = propertyLabel(units, tour.unitId);
  const when = whenLabel(tour.scheduledAt);
  const who = `${tenant} at ${property} on ${when}`;
  const notMarked = tour.status === 'scheduled';
  const needsOutcome = tour.status === 'toured' && tour.outcome === undefined;

  return (
    <li className={styles.rowItem}>
      <div className={styles.pastRow}>
        {notMarked ? (
          <input
            type="checkbox"
            className={styles.check}
            checked={selected}
            disabled={busy}
            onChange={onToggle}
            aria-label={`Select tour for ${who}`}
          />
        ) : null}
        <Link
          to={`/tours/${tour.tourId}`}
          state={BACK_TO_PAST}
          className={styles.row}
          aria-label={`Tour for ${who}`}
        >
          <span className={styles.main}>
            <span className={styles.tenant}>{tenant}</span>
            <span className={styles.property}>{property}</span>
          </span>
          <span className={styles.meta}>
            {when.length > 0 ? <span className={styles.time}>{when}</span> : null}
            <span className={styles.badge}>{pastState(tour)}</span>
          </span>
        </Link>
        {notMarked || needsOutcome ? (
          <span className={styles.rowActions}>
            {notMarked ? (
              <Button
                size="sm"
                variant="secondary"
                type="button"
                disabled={busy}
                onClick={onMarkToured}
                aria-label={`Mark toured: ${who}`}
              >
                Mark toured
              </Button>
            ) : null}
            {needsOutcome ? (
              <Link
                to={`/tours/${tour.tourId}?outcome=1`}
                state={BACK_TO_PAST}
                className={styles.actionLink}
                aria-label={`Record outcome: ${who}`}
              >
                Record outcome
              </Link>
            ) : null}
          </span>
        ) : null}
      </div>
      {result !== undefined ? (
        result.ok ? (
          <p role="status" className={styles.rowResult}>
            Marked toured
          </p>
        ) : (
          <p role="alert" className={`${styles.rowResult} ${styles.rowResultError}`}>
            Could not mark toured: {result.message}
          </p>
        )
      ) : null}
    </li>
  );
}
```

4. Add the Past VIEW component after `PastTourRow`. It is a Past-only child:
   it mounts only while the Past tab shows and UNMOUNTS on a tab switch, so
   its selection, batch results and snapshot start fresh every time Past
   shows - with no reset effect (the lint preset forbids setState in an
   effect) and no route keys (a keyed remount of the whole page would refetch
   the contact and unit lookups behind a spinner on every Active/Closed tab
   click, which the existing tabs never did). The page keeps owning the
   cross-reference maps and the tabs.

```tsx
interface PastToursViewProps {
  contacts: Map<string, Contact>;
  units: Map<string, UnitItem>;
}

/** The Past tab's body (spec 4.2-4.5): the lazy data hook, the bulk runner
 *  and every piece of batch state. Mounted ONLY while the Past view shows. */
function PastToursView({ contacts, units }: PastToursViewProps): React.JSX.Element {
  // Enabled for this component's whole life: it exists only on the Past view.
  const { status: pastStatus, past: pastTours, reload: reloadPast, reloadFailed } = usePastTours(true);

  // Bulk "Mark toured" (spec 4.5): the raw selection, the running flag, and the
  // per-row results of the LAST batch (cleared when the next one starts).
  // `snapshot` remembers what each id looked like when the batch ran, so a row
  // the reload drops can still be named in the above-toolbar block.
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // The in-flight guard is a REF, not the render-time `bulkBusy` value: two
  // clicks in one render would both read the stale false.
  const bulkBusyRef = useRef(false);
  const [results, setResults] = useState<ReadonlyMap<string, MarkResult>>(new Map());
  const [snapshot, setSnapshot] = useState<ReadonlyMap<string, Tour>>(new Map());

  // Only "Not marked" rows can be selected; a row that left that state (marked
  // elsewhere, then reloaded) drops out of the effective selection.
  const notMarkedIds = useMemo(
    () => pastTours.filter((t) => t.status === 'scheduled').map((t) => t.tourId),
    [pastTours],
  );
  const selected = useMemo(
    () => new Set(notMarkedIds.filter((id) => selectedIds.has(id))),
    [notMarkedIds, selectedIds],
  );
  const allSelected = notMarkedIds.length > 0 && selected.size === notMarkedIds.length;
  const someSelected = selected.size > 0 && !allSelected;

  // Results for ids the reload no longer lists - named from the snapshot, so
  // no result is ever silent (spec 4.5). Successes and failures are split
  // because they render with different roles.
  const vanished = useMemo(() => {
    const listed = new Set(pastTours.map((t) => t.tourId));
    const ok: { id: string; tour: Tour }[] = [];
    const failed: { id: string; tour: Tour; message: MarkFailure }[] = [];
    for (const [id, r] of results) {
      const tour = snapshot.get(id);
      if (listed.has(id) || tour === undefined) continue;
      if (r.ok) ok.push({ id, tour });
      else failed.push({ id, tour, message: r.message });
    }
    return { ok, failed };
  }, [results, snapshot, pastTours]);

  const toggleOne = (id: string): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = (): void => {
    setSelectedIds(allSelected ? new Set() : new Set(notMarkedIds));
  };

  // The runner: ONE tour at a time, IN LIST ORDER. Per id: re-read the tour
  // (the list is a snapshot, and the server accepts canceled -> toured,
  // no_show -> toured and a reschedule that keeps `scheduled`, so a tour a
  // colleague has since canceled, marked no-show or rebooked must not be
  // flipped, given a false "Tour took place" milestone and stripped of its
  // fresh reminders); PATCH only when the CURRENT status is scheduled AND the
  // current scheduledAt is the one the list showed. The GET is eventually
  // consistent, so the window is one round trip plus replication lag.
  // Sequential on purpose - each PATCH rotates that tour's reminder ladder and
  // writes audit/activity rows; serial keeps those ordered and the per-row
  // result deterministic. Sends ONLY { status: 'toured' } - never an outcome,
  // never closed. Ignores a call while a batch is in flight.
  const markToured = async (ids: string[]): Promise<void> => {
    if (bulkBusyRef.current) return;
    const listed = new Map(pastTours.map((t) => [t.tourId, t]));
    const eligible = ids.filter((id) => notMarkedIds.includes(id));
    if (eligible.length === 0) return;
    bulkBusyRef.current = true;
    setBulkBusy(true);
    setResults(new Map());
    setSnapshot(listed);
    const next = new Map<string, MarkResult>();
    for (const id of eligible) {
      let current: Tour;
      try {
        current = await getTour(id);
      } catch {
        next.set(id, { ok: false, message: 'Could not check the tour' });
        continue;
      }
      if (current.status !== 'scheduled' || current.scheduledAt !== listed.get(id)?.scheduledAt) {
        next.set(id, { ok: false, message: 'Changed since the list loaded' });
        continue;
      }
      try {
        await patchTour(id, { status: 'toured' });
        next.set(id, { ok: true });
      } catch {
        next.set(id, { ok: false, message: 'The update failed' });
      }
    }
    setResults(next);
    setSelectedIds((prev) => {
      const remaining = new Set(prev);
      for (const [id, r] of next) if (r.ok) remaining.delete(id);
      return remaining;
    });
    reloadPast();
    bulkBusyRef.current = false;
    setBulkBusy(false);
    // If the user switched tabs mid-batch this view unmounted and these
    // setters landed on the unmounted instance (a no-op in React 19); the
    // PATCHes already sent stand, and the next Past view lists the truth.
  };

  if (pastStatus === 'idle') return <Spinner center />;
  if (pastStatus === 'error') {
    return (
      <p className={styles.error} role="alert">
        We couldn&apos;t load tours. Please try again.
      </p>
    );
  }

  return (
    <section className={styles.section} aria-label="Past tours">
      {reloadFailed ? (
        <p role="alert" className={styles.vanished}>
          Could not refresh the list. Reload the page to see the latest.
        </p>
      ) : null}
      {vanished.ok.length > 0 ? (
        <div role="status" className={styles.vanishedOk}>
          {vanished.ok.map((v) => (
            <p key={v.id}>
              {tenantName(contacts, v.tour.tenantId)} at {propertyLabel(units, v.tour.unitId)} on{' '}
              {whenLabel(v.tour.scheduledAt)}: Marked toured
            </p>
          ))}
        </div>
      ) : null}
      {vanished.failed.length > 0 ? (
        <div role="alert" className={styles.vanished}>
          {vanished.failed.map((f) => (
            <p key={f.id}>
              {tenantName(contacts, f.tour.tenantId)} at {propertyLabel(units, f.tour.unitId)} on{' '}
              {whenLabel(f.tour.scheduledAt)}: {f.message}
            </p>
          ))}
        </div>
      ) : null}
      {pastTours.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyText}>No past tours need attention in the last 90 days.</p>
        </div>
      ) : (
        <>
          <div className={styles.toolbar}>
            <label className={styles.selectAll}>
              <input
                type="checkbox"
                className={styles.check}
                checked={allSelected}
                ref={(el) => {
                  if (el) el.indeterminate = someSelected;
                }}
                disabled={bulkBusy || notMarkedIds.length === 0}
                onChange={toggleAll}
              />
              Select all not marked
            </label>
            <Button
              size="sm"
              variant="primary"
              type="button"
              disabled={selected.size === 0 || bulkBusy}
              onClick={() => void markToured([...selected])}
            >
              Mark toured ({selected.size})
            </Button>
          </div>
          <ul className={styles.rows} aria-label="Past tours list">
            {pastTours.map((t) => (
              <PastTourRow
                key={t.tourId}
                tour={t}
                contacts={contacts}
                units={units}
                selected={selected.has(t.tourId)}
                onToggle={() => toggleOne(t.tourId)}
                onMarkToured={() => void markToured([t.tourId])}
                busy={bulkBusy}
                result={results.get(t.tourId)}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
```

   `[...selected]` iterates in the insertion order of `notMarkedIds`, which
   is the list order - that is what makes "in list order" true.

5. In `ToursPage`, replace the signature and the derived flags:

```tsx
export function ToursPage({ view = 'active' }: ToursPageProps): React.JSX.Element {
  const navigate = useNavigate();
  const closed = view === 'closed';
  const past = view === 'past';
```

   Keep every existing line that reads `closed`. The page does NOT call
   `usePastTours` (the child does). Update `loading` / `error` so the Past
   view waits only for the cross-reference maps (the child owns its own
   spinner and error):

```tsx
  const loading = closed
    ? closedStatus === 'loading' || closedStatus === 'idle' || crossRefLoading
    : past
      ? crossRefLoading
      : toursStatus === 'loading' || crossRefLoading;
  const error = closed
    ? closedStatus === 'error' || crossRefError
    : past
      ? crossRefError
      : toursStatus === 'error' || crossRefError;
```

6. In the JSX: the title becomes `{PAGE_TITLE[view]}`; the "+ New tour" button
   condition becomes `{view === 'active' ? (...) : null}`; the intro becomes
   `{PAGE_INTRO[view]}`; the tabs map becomes

```tsx
        {VIEW_TABS.map((t) => (
          <Link
            key={t.view}
            to={t.to}
            className={`${styles.tab} ${t.view === view ? styles.tabActive : ''}`}
            {...(t.view === view && { 'aria-current': 'page' })}
          >
            {t.label}
          </Link>
        ))}
```

   The Active block's condition becomes `{!loading && !error && view === 'active' ? (` and the Closed block's stays `closed`. Insert the Past block between them:

```tsx
      {/* --- Past view (/tours/past) - spec 4.3-4.5. The child owns every
          piece of batch state and unmounts on a tab switch. --- */}
      {!loading && !error && past ? <PastToursView contacts={contactsMap} units={unitsMap} /> : null}
```

7. Update the header comment: the views list gains
   `Past (/tours/past) - the last 90 days' tours (through the end of today) that still need a decision (spec 4): rows carry a plain-words state, a Mark toured button / Record outcome link, a checkbox, and a bulk Mark toured (N) toolbar; each mark re-reads the tour first. PastToursView is a Past-only child, so its selection and batch results never survive a tab switch.`

8. `dashboard/src/App.tsx` lines 237-240 become (no keys - the page instance
   is shared across tabs exactly as today; only the Past child unmounts):

```tsx
            {/* Tours list page at /tours (+ the Past view at /tours/past and the
                Closed view at /tours/closed). The static paths rank above the
                dynamic tours/:tourId segment below. */}
            <Route path="tours" element={<ToursPage />} />
            <Route path="tours/past" element={<ToursPage view="past" />} />
            <Route path="tours/closed" element={<ToursPage view="closed" />} />
```

- [ ] **Step 5: Run, expect green**

```
cd /w/tmp/staff-notes-past-tours/dashboard && npx vitest run src/routes/tours/ToursPage.test.tsx src/routes/tours/useTours.test.ts
```

Expected: all green. If the `indeterminate` ref callback trips the React 19
ref-cleanup typing, write it as `ref={(el) => { if (el) el.indeterminate = someSelected; return undefined; }}`.

- [ ] **Step 6: ASCII, typecheck, commit**

```
cd /w/tmp/staff-notes-past-tours && for f in dashboard/src/routes/tours/ToursPage.tsx dashboard/src/routes/tours/ToursPage.module.css dashboard/src/routes/tours/ToursPage.test.tsx dashboard/src/App.tsx; do printf '%s ' "$f"; git diff -- "$f" | grep '^+' | grep -v '^+++' | tr -d '\11\12\15\40-\176' | wc -c; done
cd /w/tmp/staff-notes-past-tours/dashboard && npm run typecheck
cd /w/tmp/staff-notes-past-tours && git status --porcelain
cd /w/tmp/staff-notes-past-tours && ls "W:/AI Projects/Housing Choice/HC Application/.git/worktrees/staff-notes-past-tours/MERGE_HEAD" 2>/dev/null
cd /w/tmp/staff-notes-past-tours && git add dashboard/src/routes/tours/ToursPage.tsx dashboard/src/routes/tours/ToursPage.module.css dashboard/src/routes/tours/ToursPage.test.tsx dashboard/src/App.tsx && git commit -m "feat(dashboard/tours): Past tab - /tours/past view, state rows with date-time labels, Mark toured + Record outcome actions, sequential re-read-then-PATCH bulk Mark toured (spec 4.1, 4.3-4.5)

Co-Authored-By: <AUTHORING-MODEL> <noreply@anthropic.com>"
```

### Task 8: TourDetail - the `?outcome=1` deep link and the back arrow

**Files:**
- Modify: `dashboard/src/routes/tours/TourDetail.tsx`
- Modify: `dashboard/src/routes/tours/TourDetail.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append to `dashboard/src/routes/tours/TourDetail.test.tsx` a new TOP-LEVEL
describe block (the file has several; its loaded-page `beforeEach` is
module-level at line 222, so every top-level describe inherits it):

```tsx
describe('TourDetail - ?outcome=1 deep link and the back arrow (spec 4.6)', () => {
  /** Shows the current search string (unit-test only). */
  function SearchProbe(): React.JSX.Element {
    const l = useLocation();
    return <output data-testid="search">{l.search}</output>;
  }

  function renderAt(path: string, state?: unknown) {
    return render(
      <MemoryRouter initialEntries={[{ pathname: '/tours/tour-abc', search: path, state }]}>
        <Routes>
          <Route
            path="/tours/:tourId"
            element={
              <>
                <TourDetail />
                <SearchProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('opens the Record-outcome dialog on a toured tour with no outcome, and strips the param', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'toured' }));
    renderAt('?outcome=1');
    await waitLoaded();
    expect(await screen.findByRole('dialog', { name: 'Record outcome' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent(''));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Record outcome' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record outcome' })).toBeInTheDocument();
  });

  it('strips the param WITHOUT losing state.back (the Record-outcome path from Past)', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'toured' }));
    renderAt('?outcome=1', { back: '/tours/past' });
    await waitLoaded();
    expect(await screen.findByRole('dialog', { name: 'Record outcome' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent(''));
    expect(screen.getByRole('link', { name: 'Back to tours' })).toHaveAttribute('href', '/tours/past');
  });

  it('opens nothing on a scheduled tour (and still strips the param)', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'scheduled' }));
    renderAt('?outcome=1');
    await waitLoaded();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark toured' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent(''));
  });

  it('opens nothing on a toured tour that already has an outcome', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'toured', outcome: 'move_forward', moveForward: true, convertible: true }));
    renderAt('?outcome=1');
    await waitLoaded();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens nothing without the param', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'toured' }));
    renderAt('');
    await waitLoaded();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('the back arrow honors state.back for a tours route and ignores anything else', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'toured' }));
    renderAt('', { back: '/tours/past' });
    await waitLoaded();
    expect(screen.getByRole('link', { name: 'Back to tours' })).toHaveAttribute('href', '/tours/past');
  });

  it('the back arrow falls back to /tours without state or with a foreign path', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'toured' }));
    renderAt('', { back: '/contacts/evil' });
    await waitLoaded();
    expect(screen.getByRole('link', { name: 'Back to tours' })).toHaveAttribute('href', '/tours');
  });
});
```

Import `useLocation` alongside `MemoryRouter, Route, Routes` from
`react-router-dom` at the top of the test file (the file already re-exports
`actual` from its router mock, so `useLocation` is real).

- [ ] **Step 2: Run, expect red**

```
cd /w/tmp/staff-notes-past-tours/dashboard && npx vitest run src/routes/tours/TourDetail.test.tsx
```

- [ ] **Step 3: Implement**

In `dashboard/src/routes/tours/TourDetail.tsx`:

1. Router import (line 26) becomes
   `import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';`
   and make sure `useEffect` is in the react import.
2. Near the other module constants (above `TourDetailLoaded`), add:

```tsx
/** The tours-list routes a back pointer may name (spec 4.6). Anything else
 *  falls back to /tours - router state is client-supplied. */
const BACK_TARGETS: ReadonlySet<string> = new Set(['/tours', '/tours/past', '/tours/closed']);

/** Where the back arrow goes: the tab that opened this page when its link
 *  said so (the Past tab's rows), else the Active list. */
function backHref(state: unknown): string {
  const back = typeof state === 'object' && state !== null ? (state as { back?: unknown }).back : undefined;
  return typeof back === 'string' && BACK_TARGETS.has(back) ? back : '/tours';
}
```

3. Inside `TourDetailLoaded`, REPLACE the `modal` state declaration (lines
   237-239, `const [modal, setModal] = useState<...>(null);`) with the block
   below, which reads the URL FIRST and initializes the dialog from it. The
   dialog must not be opened from an effect: `react-hooks/set-state-in-effect`
   is an error in this workspace, and `TourDetailLoaded` mounts only after
   the tour has loaded (and is keyed by tourId), so the initializer already
   knows the tour's status.

```tsx
  // The back arrow returns to the tab that opened this page (spec 4.6).
  const location = useLocation();
  const backTo = backHref(location.state);
  // Deep link from the Tours page's Past tab (spec 4.6): /tours/:id?outcome=1
  // opens the Record-outcome dialog ONCE, on a toured tour with no outcome.
  // The dialog is opened in the STATE INITIALIZER (this component mounts after
  // the tour loads and remounts per tourId, so the URL and the tour are both
  // known here) - never from an effect. The effect below only STRIPS the
  // param (replace, not push) so a reload or the Back button never reopens
  // it, and it CARRIES THE LOCATION STATE FORWARD: a navigation without
  // `state` resets it to null (react-router createLocation), which would drop
  // the back pointer on exactly this path. It runs only while the param is
  // present, so the plain row-link path never touches its state. The Past
  // tab's "Record outcome" is the only producer.
  const [searchParams, setSearchParams] = useSearchParams();
  const wantsOutcome = searchParams.get('outcome') === '1';
  const [modal, setModal] = useState<
    'book' | 'reschedule' | 'outcome' | 'cancel' | 'already-toured' | null
  >(() => (wantsOutcome && tour.status === 'toured' && tour.outcome === undefined ? 'outcome' : null));
  useEffect(() => {
    if (!wantsOutcome) return;
    const next = new URLSearchParams(searchParams);
    next.delete('outcome');
    setSearchParams(next, { replace: true, state: location.state });
  }, [wantsOutcome, searchParams, setSearchParams, location.state]);
```

`setSearchParams` is a navigation, not a `useState` setter, so the effect is
clean under the preset; the full dependency list satisfies
`react-hooks/exhaustive-deps`, and the early return makes every re-run after
the strip a no-op.

4. The back link (line 595) becomes `<Link to={backTo} className={styles.backBtn} aria-label="Back to tours">`.
5. Update the file's header comment (the CTA-ladder paragraph, lines 17-22)
   with one sentence: `The Past tab's "Record outcome" deep-links here with ?outcome=1, which opens the same modal once and strips itself; its rows also pass state.back so the back arrow returns to Past.`

- [ ] **Step 4: Run, expect green**

```
cd /w/tmp/staff-notes-past-tours/dashboard && npx vitest run src/routes/tours/TourDetail.test.tsx
```

Expected: every pre-existing test still green plus 7 new.

- [ ] **Step 5: Typecheck and commit**

```
cd /w/tmp/staff-notes-past-tours/dashboard && npm run typecheck
cd /w/tmp/staff-notes-past-tours && git status --porcelain
cd /w/tmp/staff-notes-past-tours && ls "W:/AI Projects/Housing Choice/HC Application/.git/worktrees/staff-notes-past-tours/MERGE_HEAD" 2>/dev/null
cd /w/tmp/staff-notes-past-tours && git add dashboard/src/routes/tours/TourDetail.tsx dashboard/src/routes/tours/TourDetail.test.tsx && git commit -m "feat(dashboard/tours): ?outcome=1 deep link opens the Record-outcome dialog once and strips itself; back arrow honors state.back (spec 4.6)

Co-Authored-By: <AUTHORING-MODEL> <noreply@anthropic.com>"
```

### Task 9: Playwright - the Past tab end to end

**Files:**
- Create: `e2e/tests/dashboard-next/tours-past.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
// The Tours page's Past tab (Sam's items 18 + 20, list half; spec
// docs/superpowers/specs/2026-09-26-staff-notes-past-tours-design.md section 4).
//
// Against the real backend on the hermetic lane. The lean world seeds NO tours,
// so this spec creates three PAST-DATED tours through POST /api/tours (the
// route accepts any valid ISO scheduledAt; the arm writes a visible
// booked_too_late skipped reminder row and sends nothing), then advances two
// of them through the API: one to toured (no outcome) and one to no_show.
//
//   /tours/past lists exactly those three, most recent first, with the
//   plain-words states; none of them is in Active; bulk "Mark toured (1)"
//   re-reads and PATCHes the scheduled one to "Needs outcome" with a "Record
//   outcome" link that lands on the tour page with the dialog open and no
//   ?outcome in the URL; the fake Twilio THREAD store's outbound count is
//   unchanged by the batch; the back arrow returns to Past; no horizontal
//   overflow at 360px.
import { test, expect, type Page } from '@playwright/test';
import { expectTodayReady } from '../../support/today.js';
import { NARROW_360, WIDE_RESTORE, expectNoHorizontalOverflow } from '../../support/viewport.js';
import { listThreads } from '../../fixtures/fakeTwilio.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const TENANT_ID = 'contact-tenant-0001'; // Tasha Nguyen
const UNIT_A = 'unit-0001'; // 1450 Joseph E. Boone Blvd NW
const UNIT_B = 'unit-0002'; // 88 Sycamore St

/** `daysAgo` days before today at `hour`:00 LOCAL, as an ISO instant. */
function pastAt(daysAgo: number, hour: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

/** Every outbound message the fake's thread store holds, across all parties. */
async function outboundCount(page: Page): Promise<number> {
  const threads = await listThreads(page.request);
  return threads.reduce((n, t) => n + t.messages.filter((m) => m.direction === 'outbound').length, 0);
}

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expectTodayReady(page);
}

async function createTour(page: Page, unitId: string, scheduledAt: string): Promise<string> {
  const res = await page.request.post(`${NEXT}/api/tours`, {
    data: { tenantId: TENANT_ID, unitId, scheduledAt, tourType: 'self_guided' },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { tour: { tourId: string } }).tour.tourId;
}

async function patchStatus(page: Page, tourId: string, status: string): Promise<void> {
  const res = await page.request.patch(`${NEXT}/api/tours/${tourId}`, { data: { status } });
  expect(res.ok(), await res.text()).toBeTruthy();
}

test.beforeAll(async ({ request }) => {
  const res = await request.post(`${NEXT}/__dev/reseed`);
  expect(res.ok(), `reseed failed: ${res.status()} ${await res.text()}`).toBeTruthy();
});

test.describe('Tours page - Past tab', () => {
  test('lists past tours needing a decision, bulk Mark toured, Record outcome deep link, back arrow, 360px', async ({ page }) => {
    await devLogin(page); // page.request carries the session cookie for /api writes

    // Three past-dated tours: yesterday (stays scheduled = "Not marked"), two
    // days ago (-> toured, no outcome = "Needs outcome"), three days ago
    // (-> no_show = "No show"). Two units so the labels differ by property too.
    const notMarkedId = await createTour(page, UNIT_A, pastAt(1, 10));
    const needsOutcomeId = await createTour(page, UNIT_B, pastAt(2, 10));
    const noShowId = await createTour(page, UNIT_A, pastAt(3, 10));
    await patchStatus(page, needsOutcomeId, 'toured');
    await patchStatus(page, noShowId, 'no_show');

    // Active never shows them (their time has passed). Wait for BOTH Active
    // sections to have rendered before the negative count, or an unloaded
    // list passes it vacuously.
    await page.goto(`${NEXT}/tours`);
    await expect(page.getByRole('heading', { name: 'Tours' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Upcoming tours' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Needs booking' })).toBeVisible();
    for (const id of [notMarkedId, needsOutcomeId, noShowId]) {
      await expect(page.locator(`a[href="/tours/${id}"]`)).toHaveCount(0);
    }

    // The Past tab.
    const tabs = page.getByRole('navigation', { name: 'Tours view' });
    await tabs.getByRole('link', { name: 'Past' }).click();
    await expect(page).toHaveURL(/\/tours\/past$/);
    await expect(page.getByRole('heading', { name: 'Past tours' })).toBeVisible();
    await expect(tabs.getByRole('link', { name: 'Past' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByText(/^Last 90 days:/)).toBeVisible();

    const region = page.getByRole('region', { name: 'Past tours' });
    const rowFor = (id: string) =>
      region.getByRole('listitem').filter({ has: page.locator(`a[href="/tours/${id}"]`) });
    await expect(region.getByRole('listitem')).toHaveCount(3);
    // Most recent first.
    const hrefs = await region
      .getByRole('listitem')
      .getByRole('link', { name: /^Tour for .* on / })
      .evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    expect(hrefs).toEqual([`/tours/${notMarkedId}`, `/tours/${needsOutcomeId}`, `/tours/${noShowId}`]);

    await expect(rowFor(notMarkedId).getByText('Not marked', { exact: true })).toBeVisible();
    await expect(rowFor(notMarkedId).getByRole('button', { name: /^Mark toured: .* on / })).toBeVisible();
    await expect(rowFor(needsOutcomeId).getByText('Needs outcome', { exact: true })).toBeVisible();
    await expect(rowFor(needsOutcomeId).getByRole('link', { name: /^Record outcome: .* on / })).toBeVisible();
    await expect(rowFor(noShowId).getByText('No show', { exact: true })).toBeVisible();
    await expect(rowFor(noShowId).getByRole('button')).toHaveCount(0);
    await expect(rowFor(noShowId).getByRole('checkbox')).toHaveCount(0);

    // Bulk: tick the one "Not marked" row, Mark toured (1). No text goes out.
    // The bulk button is located by an ANCHORED name: getByRole's default is
    // a substring match, and every row button also starts with "Mark toured".
    const outboundBefore = await outboundCount(page);
    await expect(page.getByRole('button', { name: /^Mark toured \(0\)$/ })).toBeDisabled();
    await rowFor(notMarkedId).getByRole('checkbox').check();
    await page.getByRole('button', { name: /^Mark toured \(1\)$/ }).click();
    await expect(rowFor(notMarkedId).getByRole('status')).toHaveText('Marked toured');
    await expect(rowFor(notMarkedId).getByText('Needs outcome', { exact: true })).toBeVisible();
    await expect(rowFor(notMarkedId).getByRole('checkbox')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Mark toured \(0\)$/ })).toBeDisabled();
    // Give the worker a moment: a regression that ENQUEUED a send would land
    // in the fake's thread store asynchronously, after the PATCH returned.
    await page.waitForTimeout(2000);
    expect(await outboundCount(page)).toBe(outboundBefore);
    // Verified on the wire too: the tour is toured with no outcome, nothing closed.
    const after = await page.request.get(`${NEXT}/api/tours/${notMarkedId}`);
    expect(after.ok()).toBeTruthy();
    const tour = ((await after.json()) as { tour: { status: string; outcome?: string } }).tour;
    expect(tour.status).toBe('toured');
    expect(tour.outcome).toBeUndefined();

    // Record outcome deep link -> the tour page with the dialog open, param stripped.
    await rowFor(notMarkedId).getByRole('link', { name: /^Record outcome: .* on / }).click();
    await expect(page).toHaveURL(new RegExp(`/tours/${notMarkedId}$`));
    await expect(page.getByRole('dialog', { name: 'Record outcome' })).toBeVisible();
    await page.getByRole('dialog', { name: 'Record outcome' }).getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // The state SURVIVED the strip: the back arrow on this very page goes to Past.
    await page.getByRole('link', { name: 'Back to tours' }).click();
    await expect(page).toHaveURL(/\/tours\/past$/);
    await expect(page.getByRole('heading', { name: 'Past tours' })).toBeVisible();

    // A reload of the stripped URL does not reopen the dialog (the param is gone).
    await page.goto(`${NEXT}/tours/${notMarkedId}`);
    await expect(page.getByRole('button', { name: 'Record outcome' })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // The plain row link carries the pointer too.
    await page.goto(`${NEXT}/tours/past`);
    await rowFor(needsOutcomeId).getByRole('link', { name: /^Tour for .* on / }).click();
    await expect(page).toHaveURL(new RegExp(`/tours/${needsOutcomeId}$`));
    await page.getByRole('link', { name: 'Back to tours' }).click();
    await expect(page).toHaveURL(/\/tours\/past$/);

    // Narrow: rows with a checkbox and actions must not push the page sideways.
    await expect(page.getByRole('heading', { name: 'Past tours' })).toBeVisible();
    await page.setViewportSize(NARROW_360);
    await expect(region.getByRole('listitem')).toHaveCount(3);
    await expectNoHorizontalOverflow(page, 'Past tours at 360px');
    await page.setViewportSize(WIDE_RESTORE);
  });
});
```

`FakeThread` / `FakeThreadMessage` shapes: read `e2e/fixtures/fakeTwilio.ts`
around line 340-375 for the exact field names (`messages[].direction` is what
`getOutboundTo` filters on, line 207-209); adjust `outboundCount` if the field
is named differently.

- [ ] **Step 2: Run it against the hermetic session**

```
cd /w/tmp/staff-notes-past-tours && npm run e2e:session
```

(wait for ready; if a session from Task 5 is still up, run
`cd /w/tmp/staff-notes-past-tours && npm run e2e:restart` after the Part 2
dashboard changes instead), then:

```
cd /w/tmp/staff-notes-past-tours && npm run e2e -w @housingchoice/e2e -- --grep "Past tab"
```

Expected: 1 passed. Then stop the session:

```
cd /w/tmp/staff-notes-past-tours && npm run e2e:stop
```

- [ ] **Step 3: ASCII check and commit**

```
cd /w/tmp/staff-notes-past-tours && tr -d '\11\12\15\40-\176' < e2e/tests/dashboard-next/tours-past.spec.ts | wc -c
cd /w/tmp/staff-notes-past-tours && git status --porcelain
cd /w/tmp/staff-notes-past-tours && ls "W:/AI Projects/Housing Choice/HC Application/.git/worktrees/staff-notes-past-tours/MERGE_HEAD" 2>/dev/null
cd /w/tmp/staff-notes-past-tours && git add e2e/tests/dashboard-next/tours-past.spec.ts && git commit -m "test(e2e): Past tab - past tours listed with states, bulk Mark toured, Record outcome deep link, no send, back arrow, 360px (spec 5)

Co-Authored-By: <AUTHORING-MODEL> <noreply@anthropic.com>"
```

---

## Task 10: Gates, records, handback

- [ ] **Step 1: Sync main once**

```
cd /w/tmp/staff-notes-past-tours && git merge main --no-edit
```

(`main` is local; if it advanced since `0dafe3c1`, resolve any conflict
preserving both sides' intent, then `npm run typecheck` before anything
else.) If no advance: "Already up to date."

- [ ] **Step 2: The five gates, bare, in this order, each to its own log**

```
cd /w/tmp/staff-notes-past-tours && npm run typecheck
cd /w/tmp/staff-notes-past-tours && npm test
cd /w/tmp/staff-notes-past-tours && npm run smoke
cd /w/tmp/staff-notes-past-tours && timeout 2700 npm run e2e
cd /w/tmp/staff-notes-past-tours && npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')
```

Quote every exit code. `npm test` needs DynamoDB Local (`npm run db:start`
from the worktree if it is not up). The e2e cap is 2700s (45 min): the
suite's idle baseline is ~18 min and it runs at ~2x on a shared box
(`e2e/playwright.config.ts:105-109`), and another mission's e2e runs on this
machine tonight.

If `timeout` fires (exit 124), the stack is ORPHANED. Recipe, in this order:

1. Read this worktree's lane BEFORE stopping anything:
   `cat /w/tmp/staff-notes-past-tours/e2e/.artifacts/lane.json` (e2e:stop
   deletes it). Do NOT run `node e2e/support/lane.mjs` to "print the ports":
   it RESERVES a fresh lane lease for 240 s, so a live orphan makes it skip to
   another lane and the next isolate run lands somewhere else.
2. `cd /w/tmp/staff-notes-past-tours && npm run e2e:stop`.
3. Prove no listener survives on the ports from step 1 (PowerShell:
   `Get-NetTCPConnection -LocalPort <port> -State Listen -ErrorAction SilentlyContinue`
   for each; kill ONLY a PID whose command line names this worktree).
4. If the partial report names a failing FILE, isolate it
   (`npm run e2e -w @housingchoice/e2e -- --grep "<title>"`) and diagnose; if
   it timed out with NO failure yet (a slow box), re-run the suite once with
   `timeout 3600`, and say so in the handback.

Never kill a process that is not this worktree's.

For gate 5, attribute any error by BASELINE COMPARISON, by RULE and CONTEXT
rather than line number (edits shift lines): run the same command on the
same files at the merge base in a scratch checkout, or read the file at
`main`. Pre-existing errors in the touched files as of main @0dafe3c1:
`useTours.ts` - `react-hooks/set-state-in-effect` in `useClosedTours`
(line 116 at base); `TourDetail.tsx` - `react-hooks/purity` (line 269 at
base, shifts down after Task 8's insertion); `TenantFile.tsx` - an unused
`FieldSource` import (line 14). Anything else in those files, and anything
at all in a NEW file, is yours.

- [ ] **Step 3: Records**

Write, to `docs/superpowers/reviews/2026-09-26-staff-notes-past-tours/`, as
they are produced: the per-slice reports, the code-review round(s) and their
adjudications, the fix-wave reports, the self-QA notes, and `handback.md`.
Commit each with explicit paths. The handback opens with the mission's
restatement and the section-9 decisions from the spec (the questions Cameron
would have been asked), then the per-spec-item table, the quoted gate exit
codes on the final commit, the reviewer findings and adjudications, the
`main` drift, and the issues filed (spec section 8).
