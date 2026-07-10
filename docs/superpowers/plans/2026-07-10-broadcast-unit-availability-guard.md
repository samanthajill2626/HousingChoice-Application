# Broadcast Unit-Availability Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Block sending a broadcast whose attached property is not Available (its flyer link would be dead), with a composer banner, a blocking "Make Available & send" dialog, and a server-side 400.

**Architecture:** Three thin layers reusing existing seams. (1) The send route re-checks the unit against the same `SHAREABLE_STATUSES` gate the public flyer routes use and refuses with `400 unit_not_available`. (2) `RecipientPreview` gains a send pre-flight: re-fetch the unit, and if not Available open a Modal whose confirm flips the status through the existing listing-status transition API, then sends. (3) `BroadcastComposer` renders a passive warning banner and passes `unitId` down. E2e specs stop leaning on seeded `unit-0001` (which MUST stay `under_application` for `public-pages.spec.ts`) and create their own per-run units.

**Tech Stack:** Express router (app workspace), React + CSS modules (dashboard), Vitest + supertest + Testing Library, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-07-10-broadcast-unit-availability-guard-design.md` (approved 2026-07-10).

## Global Constraints

- Work in a git worktree under `w:\tmp` (e.g. `git worktree add w:/tmp/broadcast-guard -b feat/broadcast-unit-availability-guard` from the main repo). NEVER move the shared repo's HEAD.
- Gates run BARE - never pipe a test/gate command into `tail`/`grep`/anything (a pipe masks the exit code). Filter output only after the run completes.
- `npm run typecheck` is a REQUIRED gate in addition to the test suites (tests run through esbuild/tsx and do NOT typecheck).
- The server error code is exactly `unit_not_available`; the shareability predicate is the exported `SHAREABLE_STATUSES` set - never a second hard-coded literal on the server.
- Seeded `unit-0001` stays `under_application`: `e2e/tests/dashboard-next/public-pages.spec.ts` depends on it being non-shareable. E2e work must NOT flip any shared seeded unit's status; create per-run units instead.
- New user-facing copy in this feature avoids em dashes (plain ASCII text); match the exact strings given below - e2e selectors assert on them.
- UI copy verbatim (used across tasks and asserted in tests):
  - Dialog title: `Property isn't Available`
  - Confirm button: `Make Available & send`
  - Banner: `This property is <Label>, so its flyer link won't work. You'll be asked to make it Available when you send.`
- Commit after every task with explicit paths (`git add <paths>`; never `git add -A`). Run a gating `git status` before EVERY commit.
- Do not merge into `main`; finish with the branch pushed-ready and report for review.

## File Structure

- `app/src/routes/broadcasts.ts` - send-route guard (modify).
- `app/test/broadcastApi.test.ts` - server guard tests (modify).
- `dashboard/src/routes/broadcasts/RecipientPreview.tsx` (+ `.module.css`) - send pre-flight + Modal (modify).
- `dashboard/src/routes/broadcasts/RecipientPreview.test.tsx` - dialog tests (modify).
- `dashboard/src/routes/broadcasts/BroadcastComposer.tsx` (+ `.module.css`) - banner + `unitId` pass-through (modify).
- `dashboard/src/routes/broadcasts/BroadcastComposer.test.tsx` - banner tests (modify).
- `e2e/tests/dashboard-next/broadcasts.spec.ts` - hermetic per-run units + the new warn-flow spec (modify).

---

### Task 1: Server-side send guard (400 unit_not_available)

**Files:**
- Modify: `app/src/routes/broadcasts.ts` (the `POST /broadcasts/:broadcastId/send` handler, after the `broadcast_not_draft` 409 guard at ~line 465-469; and the unitsRepo import)
- Test: `app/test/broadcastApi.test.ts`

**Interfaces:**
- Consumes: `SHAREABLE_STATUSES`, `isDeleted` from `app/src/repos/unitsRepo.js` (already exported; `app/src/routes/public.ts:32` imports them the same way). The router already builds `units` (`createUnitsRepo`) at ~line 293.
- Produces: `POST /api/broadcasts/:id/send` returns `400 { error: 'unit_not_available' }` when the attached unit is missing, soft-deleted, or not `available`; the broadcast stays `draft`. Tasks 2 and 4 depend on this exact error code.

- [ ] **Step 1: Write the failing tests**

Add to `app/test/broadcastApi.test.ts` (inside the top-level describe; reuse the existing `seedTenant`/`seedUnit` helpers and the `.set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE)` header pattern used by every request in this file):

```ts
  describe('send guard: unit availability (spec 2026-07-10)', () => {
    async function draftWithUnit(app: import('express').Express): Promise<string> {
      const create = await request(app)
        .post('/api/broadcasts')
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({
          unitId: 'unit-1',
          body_template: 'Hi [TenantName], see [FlyerLink]',
          audience_filter: { contact_type: 'tenant' },
        });
      expect(create.status).toBe(201);
      return create.body.broadcastId as string;
    }

    it('refuses to send when the unit is not available (flyer link would be dead)', async () => {
      seedTenant(world, { contactId: 'c-1' });
      const unit = seedUnit(world);
      unit.status = 'on_hold'; // any non-shareable status
      const { app } = makeWebhookHarness({ world });
      const id = await draftWithUnit(app);

      const res = await request(app)
        .post(`/api/broadcasts/${id}/send`)
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ recipientContactIds: ['c-1'] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('unit_not_available');
      // The broadcast is untouched - still a sendable draft.
      const after = await world.broadcastsRepo.getById(id);
      expect(after?.status).toBe('draft');
    });

    it('refuses when the unit was deleted after the draft was created', async () => {
      seedTenant(world, { contactId: 'c-1' });
      seedUnit(world); // available at create time
      const { app } = makeWebhookHarness({ world });
      const id = await draftWithUnit(app);
      world.units.delete('unit-1'); // gone by send time

      const res = await request(app)
        .post(`/api/broadcasts/${id}/send`)
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ recipientContactIds: ['c-1'] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('unit_not_available');
    });

    it('a broadcast with NO attached unit sends without any unit lookup', async () => {
      seedTenant(world, { contactId: 'c-1' });
      const { app } = makeWebhookHarness({ world });
      const create = await request(app)
        .post('/api/broadcasts')
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ body_template: 'hi', audience_filter: { contact_type: 'tenant' } });
      expect(create.status).toBe(201);

      const res = await request(app)
        .post(`/api/broadcasts/${create.body.broadcastId}/send`)
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ recipientContactIds: ['c-1'] });

      expect(res.status).toBe(200);
    });
  });
```

Note: `world.units` is a `Map<string, UnitItem>` (see `seedUnit`), so mutating `unit.status` / `world.units.delete` is the established way to change world state mid-test. If `UnitItem.status` is typed as `ListingStatus`, `'on_hold'` is a valid member (see `LISTING_STATUSES` in `app/src/lib/statusModel.ts`).

- [ ] **Step 2: Run the new tests to verify they fail**

Run (from the worktree root): `npm test --workspace @housingchoice/app -- broadcastApi`
Expected: the first two new tests FAIL (send returns 200, not 400); the no-unit test passes (it matches current behavior).

- [ ] **Step 3: Implement the guard**

In `app/src/routes/broadcasts.ts`:

(a) Extend the unitsRepo import (top of file) to include the gate helpers, mirroring `public.ts`:

```ts
import { createUnitsRepo, SHAREABLE_STATUSES, isDeleted } from '../repos/unitsRepo.js';
```

(Keep whatever is already imported from that module; just add the two names.)

(b) In the send handler, directly AFTER the `broadcast_not_draft` 409 guard (`if (broadcast.status !== 'draft') { ... }`) and BEFORE the recipients/selection block, insert:

```ts
    // Availability guard (spec 2026-07-10): the flyer link stamped into every
    // recipient's message only resolves while the unit is SHAREABLE (only
    // 'available' - the same gate public.ts serves). Re-check at SEND time,
    // not create time - a draft can outlive a status change. Missing and
    // soft-deleted units get the same refusal (the link is equally dead).
    // The dashboard maps this 400 to its make-available dialog.
    if (broadcast.unitId !== undefined) {
      const unit = await units.getById(broadcast.unitId);
      if (!unit || isDeleted(unit) || !SHAREABLE_STATUSES.has(unit.status)) {
        res.status(400).json({ error: 'unit_not_available' });
        return;
      }
    }
```

(`units` is the repo instance already created near the top of the router factory.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test --workspace @housingchoice/app -- broadcastApi`
Expected: ALL tests in the file pass (the pre-existing send tests use `seedUnit`'s default `status: 'available'`, so they are unaffected).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck --workspace @housingchoice/app`
Expected: clean.

```bash
git status   # gating check: only the two files below are modified
git add app/src/routes/broadcasts.ts app/test/broadcastApi.test.ts
git commit -m "feat(broadcasts): send route refuses a non-available property (unit_not_available)"
```

---

### Task 2: RecipientPreview send pre-flight + "Make Available & send" dialog

**Files:**
- Modify: `dashboard/src/routes/broadcasts/RecipientPreview.tsx`
- Modify: `dashboard/src/routes/broadcasts/RecipientPreview.module.css`
- Test: `dashboard/src/routes/broadcasts/RecipientPreview.test.tsx`

**Interfaces:**
- Consumes: `getUnit(unitId, signal?) => Promise<UnitItem>` and `setListingStatus(unitId, { toStatus, source, reason? }) => Promise<UnitItem>` from `../../api/index.js` (both exist in `dashboard/src/api/endpoints.ts`); `Modal` from `../contact/Modal.js`; `Button` from `../../ui/index.js` (the same pair `BroadcastsList.tsx:11,13` uses); `LISTING_STATUS_LABELS` + `type ListingStatus` from `../../api/index.js` (exported via `dashboard/src/api/types.ts`); the server's `400 unit_not_available` from Task 1.
- Produces: `RecipientPreviewProps` gains optional `unitId?: string`. When absent, behavior is EXACTLY today's (no pre-flight, no dialog) - Task 3 passes it from the composer.

- [ ] **Step 1: Write the failing tests**

In `RecipientPreview.test.tsx`:

(a) Add the two new endpoint mocks next to the existing ones:

```ts
const sendBroadcast = vi.fn();
const deleteBroadcast = vi.fn();
const getUnit = vi.fn();
const setListingStatus = vi.fn();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    sendBroadcast: (...a: unknown[]) => sendBroadcast(...a),
    deleteBroadcast: (...a: unknown[]) => deleteBroadcast(...a),
    getUnit: (...a: unknown[]) => getUnit(...a),
    setListingStatus: (...a: unknown[]) => setListingStatus(...a),
  };
});
```

(b) Extend the `renderPreview` helper's props with `unitId?: string` and thread it through:

```ts
function renderPreview(props: {
  preview: PreviewResponse;
  tenantCandidates?: Contact[];
  candidatesLoading?: boolean;
  draftId?: string;
  unitId?: string;
}): void {
  render(
    <MemoryRouter initialEntries={['/broadcasts/new']}>
      <Routes>
        <Route
          path="/broadcasts/new"
          element={
            <RecipientPreview
              draftId={props.draftId ?? 'bcast_1'}
              preview={props.preview}
              tenantCandidates={props.tenantCandidates ?? []}
              candidatesLoading={props.candidatesLoading ?? false}
              {...(props.unitId !== undefined && { unitId: props.unitId })}
            />
          }
        />
        {/* keep the existing LocationProbe route(s) exactly as they are */}
      </Routes>
    </MemoryRouter>,
  );
}
```

(c) Add a describe (the `candidate`/`previewOf` factories already exist; a minimal unit object is enough because the mock controls the shape):

```ts
describe('availability pre-flight on Send (spec 2026-07-10)', () => {
  const PREVIEW = previewOf({ count: 1, candidates: [candidate()] });

  it('non-Available unit: Send opens the dialog and does NOT send', async () => {
    const user = userEvent.setup();
    getUnit.mockResolvedValue({ unitId: 'u1', landlordId: 'll1', status: 'on_hold' });
    renderPreview({ preview: PREVIEW, unitId: 'u1' });

    await user.click(screen.getByRole('button', { name: /Send to 1 tenant/ }));

    const dialog = await screen.findByRole('dialog', { name: "Property isn't Available" });
    expect(within(dialog).getByText(/On hold/)).toBeInTheDocument();
    expect(getUnit).toHaveBeenCalledWith('u1');
    expect(sendBroadcast).not.toHaveBeenCalled();
  });

  it('"Make Available & send" flips the status FIRST, then sends', async () => {
    const user = userEvent.setup();
    getUnit.mockResolvedValue({ unitId: 'u1', landlordId: 'll1', status: 'setup' });
    setListingStatus.mockResolvedValue({ unitId: 'u1', landlordId: 'll1', status: 'available' });
    sendBroadcast.mockResolvedValue({ broadcastId: 'bcast_1', status: 'sending', count: 1 });
    renderPreview({ preview: PREVIEW, unitId: 'u1' });

    await user.click(screen.getByRole('button', { name: /Send to 1 tenant/ }));
    await user.click(await screen.findByRole('button', { name: 'Make Available & send' }));

    await waitFor(() =>
      expect(setListingStatus).toHaveBeenCalledWith('u1', {
        toStatus: 'available',
        source: 'manual',
      }),
    );
    await waitFor(() => expect(sendBroadcast).toHaveBeenCalledWith('bcast_1', ['c1']));
    expect(setListingStatus.mock.invocationCallOrder[0]).toBeLessThan(
      sendBroadcast.mock.invocationCallOrder[0],
    );
  });

  it('Cancel closes the dialog without flipping or sending', async () => {
    const user = userEvent.setup();
    getUnit.mockResolvedValue({ unitId: 'u1', landlordId: 'll1', status: 'occupied' });
    renderPreview({ preview: PREVIEW, unitId: 'u1' });

    await user.click(screen.getByRole('button', { name: /Send to 1 tenant/ }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(setListingStatus).not.toHaveBeenCalled();
    expect(sendBroadcast).not.toHaveBeenCalled();
  });

  it('Available unit: sends straight through with no dialog', async () => {
    const user = userEvent.setup();
    getUnit.mockResolvedValue({ unitId: 'u1', landlordId: 'll1', status: 'available' });
    sendBroadcast.mockResolvedValue({ broadcastId: 'bcast_1', status: 'sending', count: 1 });
    renderPreview({ preview: PREVIEW, unitId: 'u1' });

    await user.click(screen.getByRole('button', { name: /Send to 1 tenant/ }));

    await waitFor(() => expect(sendBroadcast).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(setListingStatus).not.toHaveBeenCalled();
  });

  it('no unitId prop: no pre-flight at all (legacy behavior)', async () => {
    const user = userEvent.setup();
    sendBroadcast.mockResolvedValue({ broadcastId: 'bcast_1', status: 'sending', count: 1 });
    renderPreview({ preview: PREVIEW });

    await user.click(screen.getByRole('button', { name: /Send to 1 tenant/ }));

    await waitFor(() => expect(sendBroadcast).toHaveBeenCalled());
    expect(getUnit).not.toHaveBeenCalled();
  });

  it('surfaces the server race: 400 unit_not_available renders the inline error', async () => {
    const user = userEvent.setup();
    getUnit.mockResolvedValue({ unitId: 'u1', landlordId: 'll1', status: 'available' });
    sendBroadcast.mockRejectedValue(new ApiError(400, 'unit_not_available', 'unit_not_available'));
    renderPreview({ preview: PREVIEW, unitId: 'u1' });

    await user.click(screen.getByRole('button', { name: /Send to 1 tenant/ }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/isn't Available/),
    );
  });
});
```

Add `getUnit.mockReset(); setListingStatus.mockReset();` to the file's existing `beforeEach` mock-reset block (match how `sendBroadcast`/`deleteBroadcast` are reset there).

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npm test --workspace @housingchoice/dashboard -- RecipientPreview`
Expected: the new describe FAILS (unknown prop / no dialog); pre-existing tests still pass.

- [ ] **Step 3: Implement**

In `RecipientPreview.tsx`:

(a) Imports - extend the api import block and add the dialog pieces:

```ts
import {
  ApiError,
  deleteBroadcast,
  getUnit,
  sendBroadcast,
  setListingStatus,
  LISTING_STATUS_LABELS,
  type Contact,
  type ListingStatus,
  type PreviewResponse,
} from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { Modal } from '../contact/Modal.js';
```

(Keep the existing `Spinner` import line and everything else as-is.)

(b) Props - add `unitId`:

```ts
export interface RecipientPreviewProps {
  draftId: string;
  preview: PreviewResponse;
  /** Tenant candidates for the "add a tenant" search (getContacts({type:'tenant'})). */
  tenantCandidates: Contact[];
  /** Whether the tenant-candidate list is still loading (disables add until ready). */
  candidatesLoading: boolean;
  /** The attached property, when composing from one. Send re-checks its status
   *  (spec 2026-07-10): a non-Available unit's flyer link is dead, so the send
   *  is blocked behind a "Make Available & send" dialog. */
  unitId?: string;
}
```

Destructure `unitId` in the component signature.

(c) State - next to the existing `sending`/`error` state:

```ts
  /** Availability gate (spec 2026-07-10): set when Send found the property in a
   *  non-Available status - renders the blocking Make-Available dialog. */
  const [availGate, setAvailGate] = useState<ListingStatus | string | null>(null);
  const [gateBusy, setGateBusy] = useState(false);
```

(d) Split `onSend`: rename the CURRENT body of `onSend` to `doSend` unchanged EXCEPT for one added error branch, and make `onSend` the pre-flight:

```ts
  async function onSend(): Promise<void> {
    if (sending || checkedCount === 0) return;
    // Pre-flight (spec 2026-07-10): the flyer link only resolves while the
    // property is Available. Check FRESH status (never the compose-time object;
    // a resumed draft can be days old).
    if (unitId !== undefined) {
      setError(null);
      let status: string;
      try {
        status = (await getUnit(unitId)).status;
      } catch {
        setError("Couldn't check the property's status. Try again.");
        return;
      }
      if (status !== 'available') {
        setAvailGate(status);
        return;
      }
    }
    await doSend();
  }

  async function doSend(): Promise<void> {
    // ... the existing onSend body verbatim (guard line included) ...
  }

  async function onMakeAvailableAndSend(): Promise<void> {
    if (gateBusy || unitId === undefined) return;
    setGateBusy(true);
    try {
      // Through the single status-transition service, same as the property
      // page's status pill - the property's activity trail records it.
      await setListingStatus(unitId, { toStatus: 'available', source: 'manual' });
      setAvailGate(null);
      await doSend();
    } catch {
      setAvailGate(null);
      setError("Couldn't make the property Available. Change its status on the property page, then send.");
    } finally {
      setGateBusy(false);
    }
  }
```

In `doSend`'s existing `catch`, insert ONE new branch ABOVE the generic `err.status === 400` fallbacks (after the `empty_audience` branch is fine):

```ts
        } else if (err.status === 400 && err.code === 'unit_not_available') {
          // Race: the property left Available between our pre-flight and the
          // server's own guard (or another session flipped it back).
          setError("This property isn't Available, so its flyer link won't work. Make it Available, then send.");
        }
```

(e) Dialog JSX - at the end of the returned tree (sibling of the existing content, same pattern as the `BroadcastsList` delete confirm):

```tsx
      {availGate !== null ? (
        <Modal
          title="Property isn't Available"
          onClose={() => setAvailGate(null)}
          footer={
            <>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => setAvailGate(null)}
                disabled={gateBusy}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                type="button"
                onClick={() => void onMakeAvailableAndSend()}
                disabled={gateBusy}
              >
                {gateBusy ? 'Working\u2026' : 'Make Available & send'}
              </Button>
            </>
          }
        >
          <p className={styles.availGateBody}>
            The flyer link in this broadcast only works while the property is Available. Its
            status is currently{' '}
            <strong>{LISTING_STATUS_LABELS[availGate as ListingStatus] ?? availGate}</strong>.
          </p>
        </Modal>
      ) : null}
```

If the `Button` component's variant set differs (check `dashboard/src/ui/Button.tsx` for the exact union; `BroadcastsList` uses `variant="secondary"` and `variant="danger"`), use `variant="primary"` if it exists, else the default/brand variant that file exposes.

Note: `'Working\u2026'` is the ellipsis as a JS escape (this plan file is ASCII-only); it renders the same `...` the file's existing `'Sending...'` / `'Deleting...'` labels use. Keep the escape or type the literal character in the source - either is fine in the .tsx.

(f) CSS - add to `RecipientPreview.module.css`:

```css
.availGateBody {
  margin: 0;
  font-size: var(--fs-md);
  line-height: 1.5;
}
```

- [ ] **Step 4: Run to verify green**

Run: `npm test --workspace @housingchoice/dashboard -- RecipientPreview`
Expected: ALL pass (pre-existing send tests pass because they render without `unitId`).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck --workspace @housingchoice/dashboard`
Expected: clean. (`exactOptionalPropertyTypes` is on - hence the `{...(cond && { unitId })}` spread idiom in tests.)

```bash
git status   # gating check
git add dashboard/src/routes/broadcasts/RecipientPreview.tsx dashboard/src/routes/broadcasts/RecipientPreview.module.css dashboard/src/routes/broadcasts/RecipientPreview.test.tsx
git commit -m "feat(broadcasts): Send re-checks the property and offers Make Available & send"
```

---

### Task 3: Composer banner + unitId pass-through

**Files:**
- Modify: `dashboard/src/routes/broadcasts/BroadcastComposer.tsx`
- Modify: `dashboard/src/routes/broadcasts/BroadcastComposer.module.css`
- Test: `dashboard/src/routes/broadcasts/BroadcastComposer.test.tsx`

**Interfaces:**
- Consumes: `RecipientPreviewProps.unitId` from Task 2; `LISTING_STATUS_LABELS` + `type ListingStatus` from `../../api/index.js`; the composer's already-loaded `unit: UnitItem | null` state.
- Produces: nothing downstream; the banner copy (Global Constraints) is asserted by Task 4's e2e.

- [ ] **Step 1: Write the failing tests**

Add to `BroadcastComposer.test.tsx` (the `unit()` factory and `renderComposer` helper already exist; `getUnit` is already mocked):

```ts
describe('BroadcastComposer - non-Available property banner (spec 2026-07-10)', () => {
  it('warns when the attached property is not Available (with the human label)', async () => {
    getUnit.mockResolvedValue(unit({ status: 'on_hold' }));
    renderComposer('?unitId=unit-0001');
    const note = await screen.findByRole('status');
    expect(note).toHaveTextContent(/This property is On hold/);
    expect(note).toHaveTextContent(/its flyer link won't work/);
    expect(note).toHaveTextContent(/make it Available when you send/);
  });

  it('no banner for an Available property', async () => {
    getUnit.mockResolvedValue(unit()); // status 'available'
    renderComposer('?unitId=unit-0001');
    // Wait for the unit load to land (the pre-fill tag proves it).
    await screen.findByText(/matches property/i);
    expect(screen.queryByText(/flyer link won't work/)).not.toBeInTheDocument();
  });

  it('no banner when composing without a property', () => {
    renderComposer();
    expect(screen.queryByText(/flyer link won't work/)).not.toBeInTheDocument();
  });
});
```

If other tests in the file render `role="status"` elements, scope the first assertion with `screen.findByText(/flyer link won't work/)` and assert on its closest paragraph instead of `findByRole('status')`.

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npm test --workspace @housingchoice/dashboard -- BroadcastComposer`
Expected: new describe FAILS; existing tests pass.

- [ ] **Step 3: Implement**

In `BroadcastComposer.tsx`:

(a) Extend the api type import with `LISTING_STATUS_LABELS` and `type ListingStatus` (they live in `../../api/index.js`, same barrel the file already imports from).

(b) Banner element, defined once above the two returns (compose + preview steps both show it):

```tsx
  // Spec 2026-07-10: a non-Available property's flyer link is dead (public.ts
  // serves only 'available'). Warn EARLY - before the operator curates a whole
  // audience - that the Send step will ask to make it Available.
  const unavailableNote =
    unit !== null && unit.status !== 'available' ? (
      <p className={styles.unavailableNote} role="status">
        This property is{' '}
        <strong>{LISTING_STATUS_LABELS[unit.status as ListingStatus] ?? unit.status}</strong>, so
        its flyer link won't work. You'll be asked to make it Available when you send.
      </p>
    ) : null;
```

(c) Render it in BOTH steps, directly under each `<h1>`:
- In the PREVIEW step return (`Review recipients`), after the back button, before `<RecipientPreview .../>`.
- In the COMPOSE step return, right after `<h1 className={styles.title}>New broadcast</h1>`.

(d) Pass `unitId` into `RecipientPreview` (exactOptionalPropertyTypes spread):

```tsx
        <RecipientPreview
          draftId={draft.draftId}
          preview={preview}
          tenantCandidates={tenants}
          candidatesLoading={tenantsLoading}
          {...(unitId !== undefined && { unitId })}
        />
```

(e) CSS - add to `BroadcastComposer.module.css` (match the repo's token names; these are the tokens `RecipientPreview.module.css` uses):

```css
.unavailableNote {
  margin: 0 0 var(--sp-4);
  padding: var(--sp-2) var(--sp-4);
  border: 1px solid var(--c-warn-border, #f0c36d);
  border-radius: var(--radius-md);
  background: var(--c-warn-bg, #fff7e6);
  color: var(--c-warn-text, #7a5200);
  font-size: var(--fs-sm);
}
```

Before committing, check whether the dashboard defines warn tokens (grep `--c-warn` under `dashboard/src`). If it does, drop the hex fallbacks and use the real token names; if the amber "already sent" badge in `RecipientPreview.module.css` uses different tokens, reuse THOSE - one amber, not two.

- [ ] **Step 4: Run to verify green**

Run: `npm test --workspace @housingchoice/dashboard -- BroadcastComposer`
Expected: ALL pass.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck --workspace @housingchoice/dashboard`

```bash
git status   # gating check
git add dashboard/src/routes/broadcasts/BroadcastComposer.tsx dashboard/src/routes/broadcasts/BroadcastComposer.module.css dashboard/src/routes/broadcasts/BroadcastComposer.test.tsx
git commit -m "feat(broadcasts): composer banner warns when the property is not Available"
```

---

### Task 4: E2e - hermetic per-run units + the warn-and-flip spec

**Files:**
- Modify: `e2e/tests/dashboard-next/broadcasts.spec.ts`

**Interfaces:**
- Consumes: the dialog title `Property isn't Available`, button `Make Available & send`, banner fragment `its flyer link won't work` (Tasks 2-3); the `400 unit_not_available` server guard (Task 1); `POST /api/units` (creates status `setup`) + `PATCH /api/units/:id/listing-status`.
- Produces: nothing downstream.

**Why this rework is required:** the spec's `SEEDED_UNIT = 'unit-0001'` is seeded `under_application` (`app/src/lib/seed/lean.ts` - derived from placement-0001), and `public-pages.spec.ts` REQUIRES it to stay non-shareable. With Task 1's guard, every send against unit-0001 (the UI compose spec, its prior-send API seeding, and the API-driven live-progress spec) would 400. So the two send-ful describes create their own per-run unit; the delete-draft describe never sends and keeps unit-0001.

- [ ] **Step 1: Add the unit factory helper**

Below `createTenant` in `broadcasts.spec.ts`:

```ts
/** Create a fresh per-run property via the API. New units start in 'setup'
 *  (not shareable); pass available: true to flip it Available through the
 *  transition route - the status the send guard (spec 2026-07-10) requires.
 *  Hermetic on purpose: shared seeded units keep their statuses (unit-0001
 *  MUST stay under_application for public-pages.spec.ts). */
async function createUnitViaApi(
  request: APIRequestContext,
  stamp: string,
  opts: { available: boolean },
): Promise<string> {
  const res = await request.post(`${NEXT}/api/units`, {
    data: {
      landlordId: 'contact-landlord-0001',
      beds: 2,
      jurisdiction: 'atlanta_housing',
      address: { line1: `${stamp} Broadcast Guard Ave`, city: 'Atlanta', state: 'GA', zip: '30314' },
      rent_min: 1500,
      rent_max: 1600,
    },
  });
  expect(res.ok()).toBeTruthy();
  const unitId = (await res.json()).unit.unitId as string;
  if (opts.available) {
    const flip = await request.patch(`${NEXT}/api/units/${unitId}/listing-status`, {
      data: { toStatus: 'available', source: 'manual' },
    });
    expect(flip.ok()).toBeTruthy();
  }
  return unitId;
}
```

(If `POST /api/units` rejects the structured address shape, mirror whatever `e2e/scenarios/steps.ts`'s `teamCreatesUnitFromIntake` submits - the New-property form is the canonical payload.)

- [ ] **Step 2: Rework the compose describe to use a per-run Available unit**

In the compose-from-a-property test (the first `test.describe` in the file, the one running kebab -> composer -> curate -> Send -> Results), after `devLogin` and the stamp/tenant setup, create the unit and swap every `SEEDED_UNIT` in THIS test for it:

```ts
    const unitId = await createUnitViaApi(page.request, stamp, { available: true });
```

- Prior-send seeding body: `unitId: unitId` (was `unitId: SEEDED_UNIT`).
- Navigation: `await page.goto(`${NEXT}/listings/${unitId}`);`
- URL assertion: `await expect(page).toHaveURL(new RegExp(`/broadcasts/new\\?unitId=${unitId}`));`
- Any later `SEEDED_UNIT` references inside this test body.

Leave the rest of the flow (voucher pre-fill, curation, fake-twilio asserts) untouched - the created unit also has beds 2 / atlanta_housing.

- [ ] **Step 3: Rework the API-driven live-progress describe the same way**

In the `'live send progress'` describe (the one that creates + sends via `page.request.post` around line 247): create `const unitId = await createUnitViaApi(page.request, stamp, { available: true });` in its setup (add a stamp if it has none) and replace `unitId: SEEDED_UNIT` in its create payload. Read the describe first and mirror its existing request-context usage exactly.

Do NOT touch the delete-draft describe (`?unitId=${SEEDED_UNIT}` at ~line 332): it never sends, and a draft against a non-available unit is still legal (create is ungated). It now shows the banner, which it does not assert on either way.

- [ ] **Step 4: Add the warn-and-flip spec**

New test inside the compose describe block:

```ts
  test('sending a non-Available property warns, and Make Available & send flips it + sends', async ({
    page,
  }) => {
    await devLogin(page);
    const stamp = `${Date.now()}`.slice(-6);
    // A sendable 2-BR tenant the default audience will catch.
    await createTenant(page.request, `Warnme${stamp}`);
    // Fresh unit left in 'setup' - NOT shareable, so the flyer link is dead.
    const unitId = await createUnitViaApi(page.request, stamp, { available: false });

    await page.goto(`${NEXT}/broadcasts/new?unitId=${unitId}`);
    // The early banner names the coming ask.
    await expect(page.getByText(/its flyer link won't work/i)).toBeVisible();

    await page.getByLabel('Message').fill(`Warn flow ${stamp} - see [FlyerLink]`);
    await page.getByRole('button', { name: 'Preview recipients' }).click();
    await page.getByRole('button', { name: /^Send to \d+ tenants?$/ }).click();

    // The blocking dialog - nothing sent yet.
    const dialog = page.getByRole('dialog', { name: "Property isn't Available" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Make Available & send' }).click();

    // The send proceeded to the results page.
    await expect(page).toHaveURL(/\/broadcasts\/bcast-/);

    // The flip really persisted server-side.
    const unitRes = await page.request.get(`${NEXT}/api/units/${unitId}`);
    expect(unitRes.ok()).toBeTruthy();
    expect(((await unitRes.json()) as { unit: { status: string } }).unit.status).toBe('available');
  });
```

Adjust the two navigation/URL assertions to match the file's existing post-Send assertions if they differ (read how the compose test asserts landing on Results and mirror it).

- [ ] **Step 5: Typecheck + run the file, then the full suite**

Run: `npm run typecheck --workspace @housingchoice/e2e`
Then the single file against a session stack, or go straight to the full hermetic suite (bare, NEVER piped):

Run: `npm run e2e`
Expected: ALL specs pass, including `public-pages.spec.ts` (unit-0001 untouched) and the reworked broadcasts specs.

- [ ] **Step 6: Commit**

```bash
git status   # gating check
git add e2e/tests/dashboard-next/broadcasts.spec.ts
git commit -m "test(e2e): broadcasts specs use per-run units + cover the availability warn-and-flip"
```

---

### Task 5: Sync main, full gates, live QA

**Files:**
- No new code; merge + verification only.

- [ ] **Step 1: Merge the latest main**

```bash
git fetch origin  # if a remote exists in the worktree; otherwise merge the local main
git merge main
```

Resolve any conflicts keeping BOTH sides' intent (watch `BroadcastComposer.tsx` / `broadcasts.ts` - the parked Matching-property-sends branch may have landed).

- [ ] **Step 2: Full gates on the merged base (each bare, in order)**

```bash
npm run typecheck
npm test --workspace @housingchoice/app
npm test --workspace @housingchoice/dashboard
npm run e2e
```

Expected: all green. If any fails, fix within this branch before proceeding.

- [ ] **Step 3: Live QA on the dev stack (self-QA, not the human)**

Use the e2e session stack (`npm run e2e:session`) + the Playwright MCP, or the running dev stack on :5174. Verify by driving the real UI:
1. Compose from a NON-available property (create one via the New property form, or use an existing non-available one WITHOUT changing seeded statuses): banner visible on the compose step and the preview step.
2. Send: dialog appears; Cancel leaves the draft intact; reopening Send and confirming "Make Available & send" lands on Results and the property page now shows Available.
3. Compose from an Available property: no banner, Send goes straight through.
4. Revert any status/QA data you changed on shared dev-stack entities.

- [ ] **Step 4: Final commit (if QA produced fixes) and report**

Report the branch ready for review with the gate results. Do NOT merge into main - that needs explicit human approval.
