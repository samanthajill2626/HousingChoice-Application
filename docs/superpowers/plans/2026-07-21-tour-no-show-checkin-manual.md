# Manual "Send no-show check-in" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** De-automate the `tour.no_show_checkin` reminder and replace it with a manual "Send no-show check-in" kebab action that opens the tenant's 1:1 composer pre-filled with the editable template.

**Architecture:** One backend change (drop `no_show_checkin` from the auto-arm list) + one tiny read endpoint (resolve the template copy for the client) + frontend plumbing to seed the shared `Timeline` composer draft, driven by a kebab menu item whose behavior is owned by `TourDetail` so it can move later.

**Tech Stack:** TypeScript, Node 24, Express (app), React + Vite (dashboard), Vitest, Playwright (e2e). Server modules are ESM with `.js` import specifiers.

## Global Constraints

- Design doc (authoritative): `docs/superpowers/specs/2026-07-21-tour-no-show-checkin-manual-design.md`.
- ASCII-only in source, specs, and log strings. Use `\uXXXX` escapes for any non-ASCII glyph (existing files already do this).
- `unit` in code/data; human copy is "property" (staff) / "home" (tenant). This feature adds no new domain noun.
- Sub-agents (if any are dispatched): pass an explicit `model` (default `opus`).
- Gates that must be green on current `main` before "done": `npm run typecheck` + `npm test` + `npm run e2e`. `typecheck` is REQUIRED and separate (the runtime suites strip types without checking).
- The templated copy is `tour.no_show_checkin` = "Hi! We noticed you may have missed your tour. Want to reschedule?" (`app/src/messages/catalog.ts`, `vars: []`, `editable: true`).
- Do NOT proactively cancel already-armed `no_show_checkin` rows (out of scope; prod SMS gated off, dev reseeds clear the table).

---

### Task 1: Stop auto-arming `no_show_checkin` (backend)

**Files:**
- Modify: `app/src/jobs/tourReminders.ts:78-84` (the `REMINDER_KINDS` array)
- Test: `app/test/tourReminders.test.ts` (flip the "armed" assertions)
- Test: `app/test/toursApi.test.ts` (flip the arm/book/reschedule assertions)

**Interfaces:**
- Consumes: nothing new.
- Produces: after this task, `armTourReminders` creates only 4 rungs (`confirmation`, `day_before`, `morning_of`, `en_route`). The `ReminderKind` union, `computeDueAt`'s `no_show_checkin` case, the catalog entry, and the dashboard labels all remain valid and unchanged (the kind is still a legal value, just never auto-armed).

- [ ] **Step 1: Update the unit-test assertions to expect no_show_checkin is NOT armed**

In `app/test/tourReminders.test.ts`, find the assertions that expect the rung to be armed (around lines 143-144, 372-374, 446-447, plus the "all 5 kinds" comment near line 124). Change them so:
- any `expect(...).toContain('no_show_checkin')` becomes `expect(kinds).not.toContain('no_show_checkin')`;
- any assertion reading the armed `no_show_checkin` `dueAt` is removed or asserted absent;
- a count of "5 kinds armed" becomes "4 kinds armed"; update the comment to "confirmation, day_before, morning_of, en_route (no_show_checkin is manual-send only)".

Add an explicit guard test near the other arm tests:

```ts
it('does not auto-arm the no_show_checkin rung (manual send only)', async () => {
  const repo = makeInMemoryTourRemindersRepo(); // use whatever the file already uses
  const tour = makeTour({ scheduledAt: futureIso });
  const rows = await armTourReminders(tour, nowIso, { tourRemindersRepo: repo });
  const kinds = rows.map((r) => r.kind);
  expect(kinds).not.toContain('no_show_checkin');
  expect(kinds).toHaveLength(4);
});
```

(Reuse the file's existing helpers/fixtures — do not invent new ones; match the names already in the test file.)

- [ ] **Step 2: Update `toursApi.test.ts` assertions**

In `app/test/toursApi.test.ts`, at the arm/book/reschedule assertions (around lines 1163-1164, 1195-1196, 1275-1276, 1975), any `byKind['no_show_checkin']?.dueAt` expectation becomes an assertion that the kind is absent, e.g.:

```ts
expect(byKind['no_show_checkin']).toBeUndefined();
```

Leave the assertions for the other four kinds intact.

- [ ] **Step 3: Run the tests to verify they now FAIL against the current code**

Run: `npm test -- tourReminders toursApi`
Expected: FAIL — current code still arms 5 kinds, so the new `not.toContain` / `toBeUndefined` / `toHaveLength(4)` assertions fail.

- [ ] **Step 4: Remove `no_show_checkin` from the auto-arm list**

In `app/src/jobs/tourReminders.ts`, change:

```ts
const REMINDER_KINDS: ReminderKind[] = [
  'confirmation',
  'day_before',
  'morning_of',
  'en_route',
  'no_show_checkin',
];
```

to:

```ts
// no_show_checkin is intentionally NOT auto-armed: whether a no-show happened is
// a human judgment the system cannot verify, so it is sent manually from the tour
// page ("Send no-show check-in"). The kind stays valid everywhere else (catalog,
// ReminderKind union, computeDueAt case) for that manual send.
const REMINDER_KINDS: ReminderKind[] = [
  'confirmation',
  'day_before',
  'morning_of',
  'en_route',
];
```

Leave `computeDueAt`'s `no_show_checkin` case exactly as-is (it keeps the `switch` exhaustive).

- [ ] **Step 5: Run the tests to verify they PASS**

Run: `npm test -- tourReminders toursApi`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: clean (the `computeDueAt` switch is still exhaustive over `ReminderKind`).

- [ ] **Step 7: Commit**

```bash
git add app/src/jobs/tourReminders.ts app/test/tourReminders.test.ts app/test/toursApi.test.ts
git commit -m "feat(tours): stop auto-arming the no_show_checkin reminder rung"
```

---

### Task 2: Read endpoint + API client for the template copy (backend + dashboard api)

**Files:**
- Modify: `app/src/routes/tourReminders.ts` (add one GET route inside `createTourRemindersRouter`)
- Test: `app/test/toursApi.test.ts` (add a test for the new route, mirroring the existing GET-reminders route tests)
- Modify: `dashboard/src/api/endpoints.ts` (add `getNoShowCheckinDraft`)
- Modify: `dashboard/src/api/index.ts` (re-export `getNoShowCheckinDraft` if the file re-exports endpoints explicitly; skip if it does `export *`)

**Interfaces:**
- Produces (server): `GET /api/tours/:tourId/no-show-checkin-draft` -> `{ body: string }` (200). No tour lookup required — the copy is tour-independent; `:tourId` is in the path for locality/authz-mount only.
- Produces (client): `getNoShowCheckinDraft(tourId: string, signal?: AbortSignal): Promise<{ body: string }>`.
- Consumes: `resolveMessage` (already imported in `tourReminders.ts:35`).

- [ ] **Step 1: Write the failing server test**

In `app/test/toursApi.test.ts`, near the existing GET-reminders route tests, add:

```ts
it('GET /api/tours/:tourId/no-show-checkin-draft returns the templated copy', async () => {
  // Reuse the file's existing app/agent bootstrap + a seeded/booked tour id.
  const res = await agent.get(`/api/tours/${tourId}/no-show-checkin-draft`);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({
    body: 'Hi! We noticed you may have missed your tour. Want to reschedule?',
  });
});
```

(Match the file's existing request harness — `agent`/`request(app)` — and how it obtains a `tourId`.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- toursApi`
Expected: FAIL with 404 (route not defined).

- [ ] **Step 3: Add the route**

In `app/src/routes/tourReminders.ts`, inside `createTourRemindersRouter`, after the existing `router.get('/:tourId/reminders', ...)` block and before `return router;`, add:

```ts
// GET /:tourId/no-show-checkin-draft -> the templated body for the MANUAL
// no-show check-in send. The no_show_checkin rung is no longer auto-armed
// (jobs/tourReminders.ts), so there is no armed row to read the copy from; the
// tour page fetches it here to PREFILL the tenant 1:1 composer. Copy is
// tour-independent and var-less; resolveMessage keeps it in sync with any
// editable override, exactly like the reminder-body resolution above.
router.get('/:tourId/no-show-checkin-draft', (_req, res) => {
  res.json({ body: resolveMessage('tour.no_show_checkin') });
});
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -- toursApi`
Expected: PASS.

- [ ] **Step 5: Add the API client function**

In `dashboard/src/api/endpoints.ts`, after `getTourReminders` (around line 1775), add:

```ts
/** GET /api/tours/:tourId/no-show-checkin-draft -> the templated body used to
 *  PREFILL the tenant 1:1 composer for a manual no-show check-in send. */
export async function getNoShowCheckinDraft(
  tourId: string,
  signal?: AbortSignal,
): Promise<{ body: string }> {
  return request<{ body: string }>(
    `/api/tours/${encodeURIComponent(tourId)}/no-show-checkin-draft`,
    { ...(signal !== undefined && { signal }) },
  );
}
```

- [ ] **Step 6: Ensure it is exported from the api barrel**

Open `dashboard/src/api/index.ts`. If it re-exports endpoints by name, add `getNoShowCheckinDraft` to that list; if it does `export * from './endpoints.js'`, no change is needed. Confirm `import { getNoShowCheckinDraft } from '../../api/index.js'` resolves (used in Task 5).

- [ ] **Step 7: Typecheck both packages**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add app/src/routes/tourReminders.ts app/test/toursApi.test.ts dashboard/src/api/endpoints.ts dashboard/src/api/index.ts
git commit -m "feat(tours): endpoint + client to resolve the no-show check-in draft copy"
```

---

### Task 3: `Timeline` accepts an `initialDraft` seed (dashboard)

**Files:**
- Modify: `dashboard/src/routes/contact/Timeline.tsx` (props interface + draft `useState` initializer + a one-shot mount effect)
- Test: `dashboard/src/routes/contact/Timeline.test.tsx` (create if absent; else extend)

**Interfaces:**
- Produces: two new optional `TimelineProps` fields:
  - `initialDraft?: string` — seeds the composer textarea ON MOUNT ONLY (via the `useState` initializer). Changing it after mount does nothing (so it can be cleared by the parent without wiping an in-progress draft).
  - `onDraftSeeded?: () => void` — called once, on mount, iff `initialDraft` was a non-empty string. Lets the parent clear its seed so a later remount does not re-seed.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing test**

In `dashboard/src/routes/contact/Timeline.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { Timeline } from './Timeline.js';

it('seeds the composer from initialDraft and fires onDraftSeeded once', () => {
  const onDraftSeeded = vi.fn();
  render(
    <Timeline
      status="ready"
      items={[]}
      source="server"
      canSend
      onSend={async () => {}}
      initialDraft="Hi! We noticed you may have missed your tour. Want to reschedule?"
      onDraftSeeded={onDraftSeeded}
    />,
  );
  const box = screen.getByRole('textbox');
  expect(box).toHaveValue(
    'Hi! We noticed you may have missed your tour. Want to reschedule?',
  );
  expect(onDraftSeeded).toHaveBeenCalledTimes(1);
});

it('does not fire onDraftSeeded when initialDraft is empty/absent', () => {
  const onDraftSeeded = vi.fn();
  render(
    <Timeline status="ready" items={[]} source="server" canSend onSend={async () => {}} onDraftSeeded={onDraftSeeded} />,
  );
  expect(screen.getByRole('textbox')).toHaveValue('');
  expect(onDraftSeeded).not.toHaveBeenCalled();
});
```

(Match the existing test file's setup/imports if it already exists — some suites need a wrapping provider; copy whatever the sibling `*.test.tsx` files use. The composer textarea is the accessible `textbox`; if the file already has a more specific selector for it, use that.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- Timeline`
Expected: FAIL — textbox value is empty (no `initialDraft` support yet) and `onDraftSeeded` is not called.

- [ ] **Step 3: Add the props to `TimelineProps`**

In `dashboard/src/routes/contact/Timeline.tsx`, inside `interface TimelineProps` (ends at line 236), add:

```ts
  /** Seed the composer textarea with this body ON MOUNT ONLY (read by the draft
   *  useState initializer). Used by the tour page's "Send no-show check-in" to
   *  prefill the tenant 1:1 composer with the editable template. Changing it
   *  after mount is inert, so the parent can clear its seed (see onDraftSeeded)
   *  without wiping an in-progress draft. */
  initialDraft?: string;
  /** Fired once, on mount, iff initialDraft was a non-empty string. Lets the
   *  parent clear its seed so a later remount of this timeline does not re-seed. */
  onDraftSeeded?: () => void;
```

- [ ] **Step 4: Seed the draft state and fire the mount callback**

In the component body, the draft state is declared at line 791 as `const [draft, setDraft] = useState('');`. Change it to seed from the prop:

```ts
  const [draft, setDraft] = useState(props.initialDraft ?? '');
```

Then, immediately after the existing `clearDraftSignal` effect (lines 818-828), add a mount-only effect:

```ts
  // Seed announcement: if we mounted with a non-empty initialDraft, tell the
  // parent once so it can clear its seed (a later remount must start empty).
  // Mount-only (empty deps): initialDraft is read by useState above; we never
  // re-seed on prop changes.
  useEffect(() => {
    if (props.initialDraft !== undefined && props.initialDraft.length > 0) {
      props.onDraftSeeded?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

Note: `props` is already destructured earlier in the component; if `initialDraft`/`onDraftSeeded` are not in the existing destructure, either add them there and reference bare (`initialDraft`, `onDraftSeeded`) or reference via `props.` as shown. Match the file's prevailing style (it uses `props.emailChannel` directly at line 782, so `props.initialDraft` is consistent).

- [ ] **Step 5: Run it to verify it passes**

Run: `npm test -- Timeline`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/routes/contact/Timeline.tsx dashboard/src/routes/contact/Timeline.test.tsx
git commit -m "feat(timeline): optional initialDraft seed + onDraftSeeded consume hook"
```

---

### Task 4: Thread the seed through `TourConversation` to the tenant pane (dashboard)

**Files:**
- Modify: `dashboard/src/routes/tours/TourConversation.tsx` (new prop, seed state, effect, and thread `initialDraft`/`onDraftSeeded` + a seed key into the tenant `ContactThread`/`NewContactThread`, and from there into `Timeline`)
- Test: `dashboard/src/routes/tours/TourConversation.test.tsx` (create if absent; else extend)

**Interfaces:**
- Consumes: `Timeline`'s `initialDraft` + `onDraftSeeded` (Task 3).
- Produces: a new `TourConversationProps` field:
  - `noShowDraft?: { body: string; nonce: number }` — when `nonce` changes to a new positive value, switch to the Tenant tab and seed that body into the tenant composer (remounting the tenant pane so the seed applies). The parent bumps `nonce` on each "Send no-show check-in" click.

- [ ] **Step 1: Write the failing test**

In `dashboard/src/routes/tours/TourConversation.test.tsx` (mirror the imports/mocks used by other `tours/*.test.tsx` — mock `useRelayThread`, `../../api/index.js` sends, etc., or render with the real ones if the suite does):

```tsx
it('switches to the tenant tab and seeds the composer when noShowDraft nonce bumps', async () => {
  const body = 'Hi! We noticed you may have missed your tour. Want to reschedule?';
  const { rerender } = renderTourConversation({ /* group thread present so it starts on Group */ });
  // Starts on Group tab (tour has groupThreadId) -> composer not seeded.
  rerender(<TourConversation {...baseProps} noShowDraft={{ body, nonce: 1 }} />);
  // Tenant tab becomes selected and its composer shows the seeded copy.
  expect(await screen.findByRole('tab', { name: /Tenant/, selected: true })).toBeInTheDocument();
  expect(screen.getByRole('textbox')).toHaveValue(body);
});
```

(Use whatever render helper/fixtures the sibling tour tests use for `tour`, `tenant`, `landlord`, `channels`. If none exists, build minimal fixtures: a `tour` with `groupThreadId` set and `status: 'scheduled'`, a `channels` stub from a light `useTourChannels` mock. Keep it small.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- TourConversation`
Expected: FAIL — `noShowDraft` is not a prop yet; tab stays on Group and textbox is empty.

- [ ] **Step 3: Add the prop and seed state**

In `TourConversation.tsx`, add to `TourConversationProps` (ends line 70):

```ts
  /** "Send no-show check-in" from the tour header: when `nonce` bumps to a new
   *  positive value, switch to the Tenant tab and PREFILL its composer with
   *  `body` (the editable no_show_checkin template). The tenant pane is remounted
   *  so the seed lands via Timeline's initialDraft initializer. */
  noShowDraft?: { body: string; nonce: number };
```

Add `noShowDraft` to the destructured params of `TourConversation({ ... })` (line 89-98).

Inside the component (after the `activeKey` state, ~line 102), add:

```ts
  // "Send no-show check-in" seed: on a new nonce we (1) select the Tenant tab and
  // (2) hand `seededBody` to the tenant pane, bumping `seedKey` to REMOUNT it so
  // Timeline's initialDraft initializer picks up the copy. `seededBody` is cleared
  // once the pane reports it consumed the seed (onDraftSeeded), so a later manual
  // switch back to Tenant starts with an empty composer.
  const [seededBody, setSeededBody] = useState<string | null>(null);
  const [seedKey, setSeedKey] = useState(0);
  const lastSeedNonce = useRef(0);
  useEffect(() => {
    const nonce = noShowDraft?.nonce ?? 0;
    if (nonce > 0 && nonce !== lastSeedNonce.current) {
      lastSeedNonce.current = nonce;
      setActiveKey('tenant');
      setSeededBody(noShowDraft?.body ?? '');
      setSeedKey((k) => k + 1);
    }
  }, [noShowDraft?.nonce, noShowDraft?.body]);
```

(Add `useRef` to the React import at line 22: `import { useEffect, useMemo, useRef, useState } from 'react';`.)

- [ ] **Step 4: Pass the seed into the tenant pane only**

The seed must reach the tenant 1:1 composer, never the landlord one. Compute a per-render tenant-only seed:

```ts
  const isTenantChannel = oneToOneKey === 'tenant';
  const tenantSeed = isTenantChannel && seededBody !== null ? seededBody : undefined;
```

Then thread it into BOTH the existing (`ContactThread`) and new (`NewContactThread`) tenant renders. For `ContactThread` (line 259-278), extend its `key` with `seedKey` and add the two props:

```tsx
          <ContactThread
            key={`${active.conversationId}:${isTenantChannel ? seedKey : 'x'}`}
            conversationId={active.conversationId}
            {...(oneToOnePhone !== undefined && { replyToPhone: oneToOnePhone })}
            {...(tourMilestones !== undefined && { tourMilestones })}
            clearDraftSignal={clearSignals[oneToOneKey]}
            {...(tenantSeed !== undefined && { initialDraft: tenantSeed })}
            onDraftSeeded={() => setSeededBody(null)}
            onConsentRefused={/* unchanged */}
          />
```

For `NewContactThread` (line 282-303), likewise:

```tsx
          <NewContactThread
            key={`${activeKey}:${isTenantChannel ? seedKey : 'x'}`}
            contactId={oneToOneContactId}
            name={oneToOneName}
            {...(oneToOnePhone !== undefined && { replyToPhone: oneToOnePhone })}
            {...(tourMilestones !== undefined && { tourMilestones })}
            onCreated={(id) => channels.setConversationId(activeKey, id)}
            clearDraftSignal={clearSignals[oneToOneKey]}
            {...(tenantSeed !== undefined && { initialDraft: tenantSeed })}
            onDraftSeeded={() => setSeededBody(null)}
            onConsentRefused={/* unchanged */}
          />
```

- [ ] **Step 5: Add the passthrough props to `ContactThread` and `NewContactThread`**

Both inner components must forward `initialDraft`/`onDraftSeeded` to `Timeline`. In `ContactThread`'s prop type (line 394-416) add:

```ts
  /** Seed the composer once on mount (no-show check-in prefill). */
  initialDraft?: string;
  /** Fired once when a non-empty initialDraft seeded the composer. */
  onDraftSeeded?: () => void;
```

destructure them, and pass to its `<Timeline .../>` (line 442-451):

```tsx
      {...(initialDraft !== undefined && { initialDraft })}
      {...(onDraftSeeded !== undefined && { onDraftSeeded })}
```

Repeat the identical additions for `NewContactThread` (prop type 466-482, its `<Timeline .../>` 502-514).

- [ ] **Step 6: Run it to verify it passes**

Run: `npm test -- TourConversation Timeline`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add dashboard/src/routes/tours/TourConversation.tsx dashboard/src/routes/tours/TourConversation.test.tsx
git commit -m "feat(tours): thread no-show check-in seed into the tenant 1:1 composer"
```

---

### Task 5: Kebab action + `TourDetail` handler, gating, and mobile pane (dashboard)

**Files:**
- Modify: `dashboard/src/routes/tours/TourActionsMenu.tsx` (new `canSendNoShowCheckin` + `onSendNoShowCheckin` props + menu item)
- Modify: `dashboard/src/routes/tours/TourDetail.tsx` (handler that fetches copy, flips the mobile pane, and bumps the seed nonce; gating; wire both children)
- Test: `dashboard/src/routes/tours/TourDetail.test.tsx` (create if absent; else extend)

**Interfaces:**
- Consumes: `TourConversation`'s `noShowDraft` (Task 4), `getNoShowCheckinDraft` (Task 2).
- Produces (menu): `canSendNoShowCheckin: boolean`, `onSendNoShowCheckin: () => void` on `TourActionsMenuProps`.

- [ ] **Step 1: Write the failing menu test**

In a `TourActionsMenu.test.tsx` (create/extend), assert the item renders and calls back when `canSendNoShowCheckin`:

```tsx
it('shows "Send no-show check-in" and calls onSendNoShowCheckin', async () => {
  const onSend = vi.fn();
  render(
    <TourActionsMenu
      canReschedule={false} onReschedule={() => {}}
      canCancel={false} onCancel={() => {}}
      canMarkNoShow={false} onMarkNoShow={() => {}}
      canOpenGroup={false} onOpenGroup={() => {}}
      canSendNoShowCheckin onSendNoShowCheckin={onSend}
    />,
  );
  await userEvent.click(screen.getByRole('button', { name: /more actions/i }));
  await userEvent.click(screen.getByRole('menuitem', { name: /send no-show check-in/i }));
  expect(onSend).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- TourActionsMenu`
Expected: FAIL — prop/menuitem do not exist; also the kebab renders `null` because no guard is true (this drives Step 3's guard update too).

- [ ] **Step 3: Add the menu prop + item**

In `TourActionsMenu.tsx`, add to `TourActionsMenuProps` (after `onMarkNoShow`, line 20):

```ts
  /** Send the manual no-show check-in (tour start passed; scheduled or no_show). */
  canSendNoShowCheckin: boolean;
  onSendNoShowCheckin: () => void;
```

Add both to the destructure (line 28-38). Include the new guard in the "nothing qualifies" short-circuit (line 60):

```ts
  if (!canReschedule && !canCancel && !canMarkNoShow && !canOpenGroup && !canSendNoShowCheckin)
    return null;
```

Add the menu item as a sibling of "Mark no-show" (after that block, ~line 105):

```tsx
          {canSendNoShowCheckin ? (
            <button
              type="button"
              role="menuitem"
              className={styles.item}
              disabled={busy}
              onClick={() => run(onSendNoShowCheckin)}
            >
              Send no-show check-in
            </button>
          ) : null}
```

- [ ] **Step 4: Run the menu test to verify it passes**

Run: `npm test -- TourActionsMenu`
Expected: PASS.

- [ ] **Step 5: Write the failing `TourDetail` integration test**

In `TourDetail.test.tsx` (mirror sibling fixtures/mocks; mock `getNoShowCheckinDraft` to resolve the template body, and render a `tour` whose `scheduledAt` is in the PAST with `status: 'scheduled'`):

```tsx
it('Send no-show check-in prefills the tenant composer with the template', async () => {
  vi.mocked(getNoShowCheckinDraft).mockResolvedValue({
    body: 'Hi! We noticed you may have missed your tour. Want to reschedule?',
  });
  renderTourDetail({ tour: pastScheduledTour });
  await userEvent.click(screen.getByRole('button', { name: /more actions/i }));
  await userEvent.click(screen.getByRole('menuitem', { name: /send no-show check-in/i }));
  expect(await screen.findByRole('tab', { name: /Tenant/, selected: true })).toBeInTheDocument();
  expect(screen.getByRole('textbox')).toHaveValue(
    'Hi! We noticed you may have missed your tour. Want to reschedule?',
  );
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npm test -- TourDetail`
Expected: FAIL — no handler/wiring yet.

- [ ] **Step 7: Implement the gating, handler, and wiring in `TourDetail.tsx`**

Add the import (line 21-34 block):

```ts
  getNoShowCheckinDraft,
```

Add the seed state next to the other `useState`s (near line 162-165):

```ts
  // "Send no-show check-in" seed handed to TourConversation (nonce bumps per click).
  const [noShowSeed, setNoShowSeed] = useState<{ body: string; nonce: number } | null>(null);
```

Add the gating guard next to the others (near line 184-190). "Tour start passed" = a real `scheduledAt` earlier than now:

```ts
  const startPassed =
    typeof tour.scheduledAt === 'string' && new Date(tour.scheduledAt).getTime() <= Date.now();
  const canSendNoShowCheckin =
    startPassed && (tour.status === 'scheduled' || tour.status === 'no_show');
```

Add the handler near the other mutations (after `markNoShow`, ~line 208). It fetches the copy, reveals the composer on mobile, and bumps the nonce:

```ts
  // Manual no-show check-in: fetch the editable template, switch the mobile pane to
  // the conversation, and hand the body to TourConversation which selects the Tenant
  // tab and prefills its composer. Kept HERE (not in the kebab) so the trigger can
  // move to a standalone button later without rewiring the behavior. Fetch failure
  // surfaces in the header alert; nothing is seeded.
  const handleSendNoShowCheckin = (): void => {
    setActionError(null);
    setPane('conversation');
    void getNoShowCheckinDraft(tourId)
      .then(({ body }) => setNoShowSeed((prev) => ({ body, nonce: (prev?.nonce ?? 0) + 1 })))
      .catch((err: unknown) =>
        setActionError(err instanceof ApiError ? err.message : 'Could not load the check-in message'),
      );
  };
```

Wire the kebab (line 404-414) — add:

```tsx
            canSendNoShowCheckin={canSendNoShowCheckin}
            onSendNoShowCheckin={handleSendNoShowCheckin}
```

Wire `TourConversation` (line 449-458) — add:

```tsx
            {...(noShowSeed !== null && { noShowDraft: noShowSeed })}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm test -- TourDetail TourActionsMenu`
Expected: PASS.

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add dashboard/src/routes/tours/TourActionsMenu.tsx dashboard/src/routes/tours/TourDetail.tsx dashboard/src/routes/tours/TourActionsMenu.test.tsx dashboard/src/routes/tours/TourDetail.test.tsx
git commit -m "feat(tours): Send no-show check-in kebab action prefills the tenant composer"
```

---

### Task 6: End-to-end coverage (e2e)

**Files:**
- Create/extend: `e2e/tests/tour-no-show-checkin.spec.ts` (mirror an existing tour spec for setup/fixtures)
- Reference: `e2e/README.md`, `e2e/support/selectors.md`, existing `e2e/tests/tour*.spec.ts`

**Interfaces:**
- Consumes: dev-login (`POST /auth/dev-login`), the seeded tour data, and `GET /__dev/outbox` to assert what SMS would have gone out.

- [ ] **Step 1: Write the e2e spec (accessibility-first selectors)**

Assert the two halves of the behavior — auto-send is gone, manual send works:

```ts
import { test, expect } from '@playwright/test';
// reuse the repo's fixtures/helpers (dev login, reseed, a booked tour).

test('no_show_checkin is not auto-sent; staff send it manually with prefilled copy', async ({ page, request }) => {
  // Arrange: a tour whose scheduledAt is in the PAST and status 'scheduled'
  // (book/patch via the API helper the other tour specs use), then reseed/reset
  // the fake outbox so the assertion starts clean.
  // ... set up tour, navigate to /tours/<id> ...

  // 1) The 30-min-past no_show_checkin did NOT auto-send.
  const before = await (await request.get('/__dev/outbox')).json();
  expect(before.messages.filter((m) => m.body.includes('may have missed your tour'))).toHaveLength(0);

  // 2) Staff send it manually.
  await page.getByRole('button', { name: /more actions/i }).click();
  await page.getByRole('menuitem', { name: /send no-show check-in/i }).click();
  await expect(page.getByRole('tab', { name: /Tenant/, selected: true })).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveValue(/may have missed your tour/);
  await page.getByRole('button', { name: /^send$/i }).click();

  // 3) Exactly that message is now in the outbox, to the tenant.
  await expect.poll(async () => {
    const after = await (await request.get('/__dev/outbox')).json();
    return after.messages.filter((m) => m.body.includes('may have missed your tour')).length;
  }).toBe(1);
});
```

(Match the repo's actual outbox JSON shape and tour-setup helpers — read a sibling `tour*.spec.ts` first. Use `request` bound to the harness base URL, NOT the dev :5174 stack.)

- [ ] **Step 2: Run the single spec via the session harness**

Boot/refresh the hermetic stack per `e2e/README.md`, then run just this spec (from the `e2e/` workspace dir — a root run targets the live :5174 stack):

Run: `npm run e2e -- tour-no-show-checkin` (or the file path per the repo's convention)
Expected: PASS. If the outbox shape or a selector is off, fix the spec, not the app, unless the app genuinely lacks an accessible name.

- [ ] **Step 3: Commit**

```bash
git add e2e/tests/tour-no-show-checkin.spec.ts
git commit -m "test(e2e): manual no-show check-in send + no auto-send"
```

---

### Task 7: Full-gate verification on current `main`

- [ ] **Step 1: Sync with `main` (branch hygiene)**

If this work is on a feature branch, merge the latest `main` in first (`git merge main`), resolving conflicts keeping both sides' intent. (Ask before syncing if unsure per repo rules.)

- [ ] **Step 2: Run the full gates**

Run each BARE (never piped), in order:
- `npm run typecheck` — Expected: clean.
- `npm test` — Expected: all green.
- `npm run e2e` — Expected: all green.

- [ ] **Step 3: Self-QA the UI in the live harness**

Per CLAUDE.md UI rule: with `npm run e2e:session` up, drive the tour page via the Playwright MCP — confirm the kebab item appears only when the tour start has passed, that clicking it selects the Tenant tab and seeds the composer, that editing then sending works, and that on a narrow viewport the pane flips to Conversation so the seeded composer is visible. Screenshot into `.playwright-mcp/`.

- [ ] **Step 4: Final commit if any QA fixes were needed**

```bash
git add -A
git commit -m "fix(tours): no-show check-in QA polish"
```

---

## Notes for the implementer

- **Why remounting the tenant pane on seed:** `Timeline` owns its draft below a keyed boundary (deliberate, so drafts never leak across conversations). Seeding therefore rides the `useState` initializer on a fresh mount (the `seedKey` bump), and `onDraftSeeded` clears the parent seed so a later manual return to the Tenant tab starts empty. Accepted trade-off: if staff already had an unsent draft in the tenant composer and then click "Send no-show check-in," that draft is replaced by the template (the action is deliberate).
- **Consent gate still applies:** the manual send goes through the normal `sendMessage` path, so the just-in-time consent modal, opt-out refusal, and `SMS_SENDING_ENABLED` kill-switch all behave exactly as for any manual 1:1 send. No special-casing.
- **Do not** add a new reminder state or a "Send now" button in `RemindersPanel` — that tracked-held-rung variant is explicitly deferred (see the design doc).
```
