# Activity Coverage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every entity's activity surface reflect the state changes that matter — tenant/landlord status + opt-out and placement-stage + tour milestones on the contact timeline, broadcasts + tours on the property, and a landlord's *properties'* activity interleaved into their timeline.

**Architecture:** Extend the two existing systems — **activity events** (`activityEventsRepo`, contact-keyed → contact timeline milestones) and the **audit trail** (`auditRepo`, `<entity>#<id>` → placement History + property Activity). New event types ride existing tables/GSIs (confirmed: no new storage). Emitters are best-effort (never fail the operator action) and idempotent (emit once per real transition). Cross-entity reads (landlord aggregation) are bounded N+1 fan-outs on the `byLandlord` GSI, no scans.

**Tech Stack:** TypeScript, Vitest, Express (`app/`), React + Vite + Vitest/RTL (`dashboard/`), Playwright (`e2e/`), DynamoDB (local for tests).

## Global Constraints

- **Vocabulary:** the entity is `unit` in code/data; UI copy is **"property"** (staff/landlord), **"home"** (tenant). (`.claude/CLAUDE.md`, `documentation/GLOSSARY.md`)
- **PII (doc §9):** NEVER log a phone number or message body. Activity/audit *labels* may carry a name but **labels/payloads must not be logged** — log ids/types/counts/markers only.
- **Best-effort writes:** an activity/audit write must **never** throw out of the operator's action (state is already persisted). try/catch + `log.error({ err, <id> }, '… (best-effort)')`, mirroring `recordPlacementMilestone` (`app/src/routes/placements.ts:337-349`).
- **Idempotency:** emit once per REAL transition — mirror `tour_took_place`'s `newStatus === 'toured' && currentStatus !== 'toured'` guard (`app/src/routes/tours.ts:469`) and the placement field-diff guards (`placements.ts:696-731`). Never on a no-op re-write.
- **Enum lockstep:** `ActivityEventType` (`app/src/repos/activityEventsRepo.ts:33-43`) is shared **verbatim** with the frontend `TimelineMilestoneType` (`dashboard/src/api/types.ts:1082-1092`). Every add touches BOTH in the same task.
- **Excluded from every timeline (human decision):** routine field edits — tenant/landlord **name / voucher / other field edits / delete / restore**, and **property `unit_updated` field-edits** on the landlord feed. They stay in the audit as provenance, unsurfaced.
- **Forward-only:** no backfill. **Tokens-only CSS**, accessibility-first selectors. Branch off `main`, sync before finishing, **no merge without human approval**. Explicit sub-agent models. Commit per task with trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

### Resolved decisions (human, 2026-07-03)
- **Status milestones:** emit on **both** explicit (`setTenantStatus`) **and** derived (`deriveTenantStatus`) status changes — only when `from !== to`.
- **Landlord feed scope:** interleave the property **lifecycle subset** — `broadcast_sent`, `tour_*`, `listing_status_changed`, `unit_contact_added/removed`, `listing_response_set` — but **NOT** `unit_updated`/`unit_created`/`unit_deleted`/`unit_restored` field-edit churn.
- Voice opt-out: YES (both channels). Tour `confirmed`: SKIP. Broadcast N = total recipients.

---

## File Structure

**Backend (`app/`):**
- `src/repos/activityEventsRepo.ts` — widen `ActivityEventType` union (WS0).
- `src/services/statusTransition.ts` — inject `activityEventsRepo`; emit `contact_status_changed` (explicit + derived) and `stage_changed`/`placement_closed` (WS1).
- `src/routes/statusTransition.ts` + `src/routes/api.ts` — thread `activityEventsRepo` into the transition service (WS1).
- `src/routes/contacts.ts` — emit `opt_out_changed` on both opt-out routes; emit `contact_status_changed` on the generic-edit status write (WS1/WS3).
- `src/routes/tours.ts` — inject `auditRepo`; dual-write tenant activity + `units#` audit on tour transitions (WS4).
- `src/jobs/broadcastFanOut.ts` — inject `auditRepo`; write `units#<unitId>` `broadcast_sent` in `finalize` (WS2).
- `src/routes/units.ts` — extend `toUnitActivityEvent` projected keys (WS2).
- `src/routes/contactTimeline.ts` — inject `unitsRepo`+`auditRepo`; landlord branch interleaving unit-audit milestones (WS3).

**Frontend (`dashboard/`):**
- `src/api/types.ts` — widen `TimelineMilestoneType` (lockstep) + add optional fields to `UnitActivityEvent`.
- `src/routes/contact/Timeline.tsx` — `milestoneVariant` colours for new types.
- `src/routes/listing/listingFormat.ts` — `describeUnitActivity` cases for `broadcast_sent` + tour kinds.

**Issues (`docs/issues/`):** WS5.

**E2E (`e2e/`):** extend `contact-detail`, `listing-activity`, `placement-history`, `tours`, `broadcasts` specs (Phase 4).

---

## WS0 — Foundation: widen the shared milestone union

### Task 0.1: Add the new `ActivityEventType` members (backend + frontend lockstep + variants)

**Files:**
- Modify: `app/src/repos/activityEventsRepo.ts:33-43`
- Modify: `dashboard/src/api/types.ts:1082-1092`
- Modify: `dashboard/src/routes/contact/Timeline.tsx:101-114`
- Test: `dashboard/src/routes/contact/Timeline.test.tsx` (extend)

**Interfaces:**
- Produces: `ActivityEventType` now includes `'contact_status_changed' | 'opt_out_changed' | 'tour_canceled' | 'tour_no_show' | 'tour_outcome'` (in addition to the existing `tour_scheduled | tour_took_place | stage_changed | placement_closed | placement_opened | listing_sent | listing_reviewed | number_added | added_to_group_text | removed_from_group_text`). `TimelineMilestoneType` mirrors it verbatim.

- [ ] **Step 1: Write the failing test** — assert a landlord-status milestone renders as a pin with its label and no crash for the new type. Append to `Timeline.test.tsx` (reuse its existing render harness — inspect the top of the file for the `renderTimeline`/items helper it already uses and match it):

```tsx
it('renders a contact_status_changed milestone pin with its label', () => {
  renderTimeline([
    { kind: 'milestone', id: 'evt-1', at: '2026-07-03T10:00:00.000Z',
      type: 'contact_status_changed', label: 'Status → Active' },
  ]);
  expect(screen.getByText('Status → Active')).toBeInTheDocument();
});

it('renders a tour_canceled milestone pin as a tour deep-link', () => {
  renderTimeline([
    { kind: 'milestone', id: 'evt-2', at: '2026-07-03T10:00:00.000Z',
      type: 'tour_canceled', label: 'Tour canceled', refType: 'tour', refId: 't-9' },
  ]);
  const link = screen.getByRole('link', { name: /Tour canceled/ });
  expect(link).toHaveAttribute('href', '/tours/t-9');
});
```

- [ ] **Step 2: Run it — expect FAIL** (TS: `type` not assignable to `TimelineMilestoneType`).

Run: `cd dashboard && npx vitest run src/routes/contact/Timeline.test.tsx`
Expected: FAIL — `'contact_status_changed'`/`'tour_canceled'` not in `TimelineMilestoneType`.

- [ ] **Step 3: Widen the backend union** — `app/src/repos/activityEventsRepo.ts`, replace lines 33-43:

```ts
export type ActivityEventType =
  | 'placement_opened'
  | 'placement_closed'
  | 'listing_sent'
  | 'listing_reviewed'
  | 'tour_scheduled'
  | 'tour_took_place'
  | 'tour_canceled'
  | 'tour_no_show'
  | 'tour_outcome'
  | 'stage_changed'
  | 'contact_status_changed'
  | 'opt_out_changed'
  | 'number_added'
  | 'added_to_group_text'
  | 'removed_from_group_text';
```

- [ ] **Step 4: Widen the frontend union (lockstep)** — `dashboard/src/api/types.ts`, replace the `TimelineMilestoneType` union (1082-1092) with the identical member list (same order). Keep the existing doc-comment noting the lockstep with the backend.

- [ ] **Step 5: Add `milestoneVariant` colours** — `dashboard/src/routes/contact/Timeline.tsx:101-114`. Extend the switch so:
  - `tour_took_place | tour_outcome | placement_closed` → `styles.green`
  - `tour_canceled | tour_no_show` → `styles.neutral` (unchanged default is fine, but make explicit for clarity)
  - `tour_scheduled` → `styles.green`
  - `contact_status_changed | opt_out_changed | stage_changed` → `styles.neutral` (default)

Only add the cases that change a colour from the neutral default (i.e. the green ones + `tour_scheduled`); leave the rest to the `default` branch.

- [ ] **Step 6: Run — expect PASS.**

Run: `cd dashboard && npx vitest run src/routes/contact/Timeline.test.tsx`
Expected: PASS.

- [ ] **Step 7: Typecheck both packages.**

Run: `cd app && npx tsc --noEmit; echo "APP_EXIT=$?"` then `cd dashboard && npx tsc --noEmit; echo "DASH_EXIT=$?"`
Expected: `APP_EXIT=0`, `DASH_EXIT=0`.

- [ ] **Step 8: Commit.**

```bash
git add app/src/repos/activityEventsRepo.ts dashboard/src/api/types.ts \
  dashboard/src/routes/contact/Timeline.tsx dashboard/src/routes/contact/Timeline.test.tsx
git commit -m "feat(activity): widen milestone union for status/opt-out/tour events"
```

---

## WS1 — Tenant contact timeline coverage

### Task 1.1: Thread `activityEventsRepo` into the transition service + emit `contact_status_changed`

**Files:**
- Modify: `app/src/services/statusTransition.ts` (deps interface :52-72; factory :167-172; `setTenantStatus` :438-472; `deriveTenantStatus` :186-202)
- Modify: `app/src/routes/statusTransition.ts` (`StatusTransitionRouterDeps` :40-56; factory wiring :60-88)
- Modify: `app/src/routes/api.ts` (`createStatusTransitionRouter({...})` call ~:508)
- Test: `app/test/statusTransition.test.ts` (extend)

**Interfaces:**
- Consumes: `world.activityEventsRepo` / `world.activityEvents` from the test harness.
- Produces: the service constructor accepts optional `activityEventsRepo`; on a real tenant/landlord status change it records `{ type: 'contact_status_changed', contactId, label: 'Status → <Label>' }` (no refType).

- [ ] **Step 1: Write the failing test** — append to `statusTransition.test.ts`. Use the existing `makeService(world)` helper but pass `activityEventsRepo`:

```ts
function makeServiceWithActivity(world: FakeWorld): StatusTransitionService {
  return createStatusTransitionService({
    placementsRepo: world.placementsRepo,
    unitsRepo: world.unitsRepo,
    contactsRepo: world.contactsRepo,
    auditRepo: world.auditRepo,
    activityEventsRepo: world.activityEventsRepo,
    events: world.events,
    logger: createLogger({ destination: createLogCapture().stream }),
  });
}

describe('statusTransition — contact_status_changed milestone', () => {
  let world: FakeWorld;
  beforeEach(async () => {
    world = createFakeWorld();
    await world.contactsRepo.create({ contactId: 'tenant-1', type: 'tenant', status: 'active' });
  });

  it('records a contact_status_changed activity event on an explicit tenant status change', async () => {
    const svc = makeServiceWithActivity(world);
    await svc.setTenantStatus('tenant-1', { toStatus: 'parked', source: 'manual', actor: 'usr_va', reason: undefined });
    const ev = world.activityEvents.filter((e) => e.type === 'contact_status_changed');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ contactId: 'tenant-1', label: expect.stringContaining('Parked') });
    expect(ev[0].refType).toBeUndefined();
  });

  it('does NOT record when the status is unchanged (no-op)', async () => {
    const svc = makeServiceWithActivity(world);
    await svc.setTenantStatus('tenant-1', { toStatus: 'active', source: 'manual', actor: 'usr_va' });
    expect(world.activityEvents.filter((e) => e.type === 'contact_status_changed')).toHaveLength(0);
  });

  it('never throws out of setTenantStatus if the milestone write fails (best-effort)', async () => {
    world.activityEventsRepo.record = async () => { throw new Error('boom'); };
    const svc = makeServiceWithActivity(world);
    await expect(svc.setTenantStatus('tenant-1', { toStatus: 'parked', source: 'manual' })).resolves.toBeTruthy();
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`activityEventsRepo` not a valid dep / no milestone recorded).

Run: `cd app && npx vitest run test/statusTransition.test.ts -t "contact_status_changed"`
Expected: FAIL.

- [ ] **Step 3: Extend `StatusTransitionDeps`** — `app/src/services/statusTransition.ts`. Import `type ActivityEventsRepo` from `../repos/activityEventsRepo.js` and `TENANT_STATUS_LABELS, LANDLORD_STATUS_LABELS` from `../lib/statusModel.js`. Add to the deps interface (near the optional hooks ~:65):

```ts
  /** Contact-timeline milestone emitter (best-effort). Optional — absent in legacy callers. */
  activityEventsRepo?: ActivityEventsRepo;
```

Destructure it in the factory (~:170): `const { placementsRepo, unitsRepo, contactsRepo, auditRepo, events, logger, armStageNudge, closeRelayForLostPlacement, activityEventsRepo } = deps;`

- [ ] **Step 4: Add a best-effort emit helper + call it from `setTenantStatus`** — inside `createStatusTransitionService`, after the deps destructure add:

```ts
  const statusLabel = (contactType: string | undefined, status: string): string =>
    (contactType === 'landlord'
      ? (LANDLORD_STATUS_LABELS as Record<string, string>)[status]
      : (TENANT_STATUS_LABELS as Record<string, string>)[status]) ?? status;

  // Best-effort contact-timeline milestone on a REAL status change. Never throws
  // out of the operator action; PII-safe log (ids/type only, never the label).
  async function recordStatusMilestone(contactId: string, contactType: string | undefined, to: string): Promise<void> {
    if (!activityEventsRepo || typeof contactId !== 'string' || contactId.length === 0) return;
    try {
      await activityEventsRepo.record({ contactId, type: 'contact_status_changed', label: `Status → ${statusLabel(contactType, to)}` });
    } catch (err) {
      logger?.error({ err, contactId }, 'contact_status_changed milestone record failed (best-effort)');
    }
  }
```

In `setTenantStatus`, read the stored contact before the write (there is already a `getById`/current read — inspect :438-460) and, **only when `from !== to`**, after the successful `contactsRepo.update`, call `await recordStatusMilestone(contactId, stored.type, input.toStatus);`. (Match the existing `from`/`to` locals the audit at :462-468 already computes.)

- [ ] **Step 5: Emit on the derived path too** — in `deriveTenantStatus` (:186-202), the existing guards already skip override-pinned (:191) and no-op equal-status (:192). After the derived audit write (:194-198), add `await recordStatusMilestone(tenantId, stored?.type, toStatus);` (reuse whatever current-contact read the guard already performed; if none carries `.type`, fetch it once — a landlord is never on the derived tenant-status path, so `undefined` → tenant labels is acceptable, but prefer the real type if already in hand).

- [ ] **Step 6: Thread the dep through the router + api** — `app/src/routes/statusTransition.ts`: add `activityEventsRepo?: ActivityEventsRepo;` to `StatusTransitionRouterDeps` (import the type + `createActivityEventsRepo`), default it (`const activityEvents = deps.activityEventsRepo ?? createActivityEventsRepo({ logger: deps.logger });`) and pass `activityEventsRepo: activityEvents` into `createStatusTransitionService({...})`. In `app/src/routes/api.ts` at the `createStatusTransitionRouter({...})` call (~:508), add `...(deps.activityEventsRepo !== undefined && { activityEventsRepo: deps.activityEventsRepo }),` (the api deps already carry `activityEventsRepo`).

- [ ] **Step 7: Run — expect PASS.**

Run: `cd app && npx vitest run test/statusTransition.test.ts`
Expected: PASS (new + existing cases).

- [ ] **Step 8: Commit.**

```bash
git add app/src/services/statusTransition.ts app/src/routes/statusTransition.ts \
  app/src/routes/api.ts app/test/statusTransition.test.ts
git commit -m "feat(activity): emit contact_status_changed milestone on tenant/landlord status change"
```

### Task 1.2: Emit `stage_changed` / `placement_closed` from the transition service

**Files:**
- Modify: `app/src/services/statusTransition.ts` (`transitionPlacement` :272-436, near the audit at :320-329)
- Test: `app/test/statusTransition.test.ts` (extend)

**Interfaces:**
- Consumes: the injected `activityEventsRepo` from Task 1.1.
- Produces: on a real placement stage move, records `{ contactId: <placement.tenantId>, type: TERMINAL ? 'placement_closed' : 'stage_changed', label, refType: 'placement', refId: placementId }`.

- [ ] **Step 1: Write the failing test:**

```ts
describe('statusTransition — placement stage milestone', () => {
  let world: FakeWorld;
  beforeEach(async () => {
    world = createFakeWorld();
    await world.contactsRepo.create({ contactId: 'tenant-1', type: 'tenant' });
    await world.unitsRepo.create({ unitId: 'unit-1', landlordId: 'll-1', status: 'available' });
  });

  it('records a stage_changed milestone on a non-terminal move', async () => {
    const svc = makeServiceWithActivity(world);
    const p = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'send_application' });
    await svc.transitionPlacement(p.placementId, { toStage: 'collect_rta', source: 'manual', actor: 'usr_va' });
    const ev = world.activityEvents.filter((e) => e.type === 'stage_changed');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ contactId: 'tenant-1', refType: 'placement', refId: p.placementId, label: expect.stringContaining('Collect RTA') });
  });

  it('records a placement_closed milestone (with lost category, no free text) on a terminal move', async () => {
    const svc = makeServiceWithActivity(world);
    const p = await world.placementsRepo.create({ tenantId: 'tenant-1', unitId: 'unit-1', stage: 'send_application' });
    await svc.transitionPlacement(p.placementId, { toStage: 'lost', source: 'manual', lostReason: { category: 'chose_other_unit', text: 'secret note' } });
    const ev = world.activityEvents.filter((e) => e.type === 'placement_closed');
    expect(ev).toHaveLength(1);
    expect(ev[0].label).toContain('chose_other_unit');
    expect(ev[0].label).not.toContain('secret note');
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

Run: `cd app && npx vitest run test/statusTransition.test.ts -t "placement stage milestone"`
Expected: FAIL (no milestones recorded).

- [ ] **Step 3: Implement** — in `transitionPlacement`, after the `placement_stage_changed` audit (:320-329), guard on a real move (`before.stage !== updated.stage`, using whatever pre/post locals exist there) and emit. Import `STAGE_LABELS, TERMINAL_STAGES` from statusModel (already imported list — extend it). Add a local best-effort helper mirroring `recordStatusMilestone`:

```ts
  async function recordStageMilestone(tenantId: string, placementId: string, toStage: PlacementStage, lostCategory: string | undefined, lostHasText: boolean): Promise<void> {
    if (!activityEventsRepo || typeof tenantId !== 'string' || tenantId.length === 0) return;
    try {
      if (TERMINAL_STAGES.has(toStage)) {
        const reason = lostCategory && lostCategory.length > 0 ? ` · ${lostCategory}` : (lostHasText ? ' · reason on file' : '');
        await activityEventsRepo.record({ contactId: tenantId, type: 'placement_closed', label: `Placement closed · ${STAGE_LABELS[toStage]}${reason}`, refType: 'placement', refId: placementId });
      } else {
        await activityEventsRepo.record({ contactId: tenantId, type: 'stage_changed', label: `Stage → ${STAGE_LABELS[toStage]}`, refType: 'placement', refId: placementId });
      }
    } catch (err) {
      logger?.error({ err, placementId }, 'placement stage milestone record failed (best-effort)');
    }
  }
```

Call it only when the stage actually changed: derive `lostCategory`/`lostHasText` from `input.lostReason` (the structured `{category, text}`) exactly as `placements.ts:707-718` does — **category only, never the free text** into the label. `tenantId` is on the placement item read in the method.

- [ ] **Step 4: Run — expect PASS** (and re-run the whole file for regressions).

Run: `cd app && npx vitest run test/statusTransition.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add app/src/services/statusTransition.ts app/test/statusTransition.test.ts
git commit -m "feat(activity): emit stage_changed/placement_closed milestone from the transition service (resolves transition-service-no-activity-milestones)"
```

### Task 1.3: Emit `opt_out_changed` on both opt-out routes

**Files:**
- Modify: `app/src/routes/contacts.ts` (SMS opt-out :1265-1297; voice opt-out :1304-1333)
- Test: `app/test/contactsCrud.test.ts` (or the closest existing contacts-route test — inspect for the opt-out coverage; extend it)

**Interfaces:**
- Consumes: `activityEvents` (already a dep at contacts.ts:75).
- Produces: each opt-out route records `{ contactId, type: 'opt_out_changed', label }` where label ∈ {`Marked Do Not Contact`, `Do Not Contact cleared`, `Marked Do Not Call`, `Do Not Call cleared`}.

- [ ] **Step 1: Write the failing test** — a supertest route test on `makeWebhookHarness().app` (mirror the auth pattern from `toursApi.test.ts`): seed a contact, POST `/api/contacts/:id/opt-out {optOut:true}`, assert `world.activityEvents` gains a `opt_out_changed` with label `'Marked Do Not Contact'`; repeat `{optOut:false}` → `'Do Not Contact cleared'`; and `/voice-opt-out` → the Do-Not-Call labels.

```ts
it('records an opt_out_changed milestone on SMS opt-out toggle', async () => {
  const { app, world } = makeWebhookHarness();
  world.contacts.push({ contactId: 'c1', type: 'tenant', phone: '+15550100001' } as ContactItem);
  await authed(app).post('/api/contacts/c1/opt-out').send({ optOut: true }).expect(200);
  const ev = world.activityEvents.filter((e) => e.type === 'opt_out_changed');
  expect(ev.map((e) => e.label)).toContain('Marked Do Not Contact');
});
```

- [ ] **Step 2: Run — expect FAIL.**

Run: `cd app && npx vitest run test/contactsCrud.test.ts -t "opt_out_changed"`
Expected: FAIL.

- [ ] **Step 3: Implement** — in the SMS opt-out handler after the existing audit (:1290-1293), add a best-effort emit (wrap in try/catch, log `{ err, contactId }`):

```ts
try {
  await activityEvents.record({ contactId, type: 'opt_out_changed', label: optOut ? 'Marked Do Not Contact' : 'Do Not Contact cleared' });
} catch (err) {
  log.error({ err, contactId }, 'opt_out_changed (sms) milestone record failed (best-effort)');
}
```

In the voice handler after :1327-1330, the same with labels `'Marked Do Not Call'` / `'Do Not Call cleared'`.

- [ ] **Step 4: Run — expect PASS.**

Run: `cd app && npx vitest run test/contactsCrud.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add app/src/routes/contacts.ts app/test/contactsCrud.test.ts
git commit -m "feat(activity): emit opt_out_changed milestone on SMS/voice opt-out toggles"
```

---

## WS4 — Tour lifecycle → tenant + property (feeds WS1/WS2)

### Task 4.1: Inject `auditRepo` into the tours router + dual-write on tour transitions

**Files:**
- Modify: `app/src/routes/tours.ts` (deps + PATCH handler :271-485, extend the block at :464-481)
- Modify: `app/src/routes/api.ts` (`createToursRouter`/tours wiring — add `auditRepo` if not already passed)
- Test: `app/test/toursApi.test.ts` (extend)

**Interfaces:**
- Consumes: `world.auditRepo`/`world.auditEvents`, `world.activityEvents`, existing `activityEvents` dep.
- Produces: on each surfaced tour transition, records a tenant activity event `{ contactId: tour.tenantId, type, label, refType:'tour', refId: tourId }` AND a unit audit row `audit.append('units#'+tour.unitId, <auditType>, { tourId, ... })`.

Transition → (activity type, audit type, label):
| Into | activity type | audit type | label |
|---|---|---|---|
| `scheduled` (incl. booking auto-advance) | `tour_scheduled` | `tour_scheduled` | `Tour scheduled` |
| `rescheduled` | `tour_scheduled` | `tour_rescheduled` | `Tour rescheduled` |
| `toured` | `tour_took_place` | `tour_took_place` | `Tour took place` (existing) |
| `no_show` | `tour_no_show` | `tour_no_show` | `Tour no-show` |
| `canceled` | `tour_canceled` | `tour_canceled` | `Tour canceled` |
| exit-gate `outcome` set | `tour_outcome` | `tour_outcome` | `Tour outcome · <moved forward\|not a fit>` |

- [ ] **Step 1: Write the failing tests** — in `toursApi.test.ts`, drive PATCH transitions and assert both surfaces. Example:

```ts
describe('PATCH /api/tours/:id — activity + property audit propagation', () => {
  async function seedScheduledTour(app, world) {
    world.units.set('unit-abc', { unitId: 'unit-abc', landlordId: 'c-ll', status: 'available' } as UnitItem);
    const res = await authed(app).post('/api/tours').send(BASE_CREATE_BODY); // status 'scheduled'
    return res.body.tour.tourId as string;
  }

  it('emits tour_scheduled activity + units# tour_scheduled audit on create-scheduled', async () => {
    const { app, world } = makeWebhookHarness();
    const tourId = await seedScheduledTour(app, world);
    expect(world.activityEvents.filter((e) => e.type === 'tour_scheduled' && e.refId === tourId)).toHaveLength(1);
    expect(world.auditEvents.filter((e) => e.entityKey === 'units#unit-abc' && e.event_type === 'tour_scheduled')).toHaveLength(1);
  });

  it('emits tour_canceled to tenant + property on cancel, once (idempotent)', async () => {
    const { app, world } = makeWebhookHarness();
    const tourId = await seedScheduledTour(app, world);
    await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'canceled' }).expect(200);
    await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'canceled' }).expect(200); // re-write, no re-emit
    expect(world.activityEvents.filter((e) => e.type === 'tour_canceled')).toHaveLength(1);
    expect(world.auditEvents.filter((e) => e.entityKey === 'units#unit-abc' && e.event_type === 'tour_canceled')).toHaveLength(1);
  });

  it('emits tour_no_show and tour_outcome on the toured→outcome path', async () => {
    const { app, world } = makeWebhookHarness();
    const tourId = await seedScheduledTour(app, world);
    await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'toured' }).expect(200);
    await authed(app).patch(`/api/tours/${tourId}`).send({ outcome: 'move_forward', moveForward: true }).expect(200);
    expect(world.activityEvents.filter((e) => e.type === 'tour_took_place')).toHaveLength(1);
    expect(world.activityEvents.filter((e) => e.type === 'tour_outcome')).toHaveLength(1);
    expect(world.auditEvents.filter((e) => e.entityKey === 'units#unit-abc' && e.event_type === 'tour_outcome')).toHaveLength(1);
  });
});
```

> Note: confirm the exact `outcome`/`moveForward` body field names and legal values against `tours.ts:392-425` and adjust the test literals; the exit-gate only applies when `currentStatus === 'toured'`.

- [ ] **Step 2: Run — expect FAIL.**

Run: `cd app && npx vitest run test/toursApi.test.ts -t "propagation"`
Expected: FAIL.

- [ ] **Step 3: Inject `auditRepo`** — add `auditRepo?: AuditRepo` to the tours router deps, default `createAuditRepo({ logger })`, and ensure `api.ts` forwards `auditRepo` (it already has `audit`). Name the local `const audit = deps.auditRepo ?? createAuditRepo(...)`.

- [ ] **Step 4: Implement the dual-write** — replace/extend the `tour_took_place` block (:464-481). Compute `newStatus`/`currentStatus` (already in scope). Add a single best-effort helper that writes both surfaces, then call it per INTO-status guard:

```ts
async function recordTourEvent(activityType: ActivityEventType, auditType: string, label: string): Promise<void> {
  try {
    await activityEvents.record({ contactId: current.tenantId, type: activityType, label, refType: 'tour', refId: tourId });
  } catch (err) { log.error({ err, tourId }, `${activityType} milestone record failed (best-effort)`); }
  try {
    await audit.append(`units#${current.unitId}`, auditType, { tourId });
  } catch (err) { log.error({ err, tourId }, `${auditType} unit audit failed (best-effort)`); }
}

const wasReschedule = /* the PATCH set a new scheduledAt on an already-scheduled tour — match tours.ts:379-384 logic */;
if (newStatus === 'scheduled' && currentStatus !== 'scheduled') await recordTourEvent('tour_scheduled', 'tour_scheduled', 'Tour scheduled');
else if (wasReschedule) await recordTourEvent('tour_scheduled', 'tour_rescheduled', 'Tour rescheduled');
if (newStatus === 'toured' && currentStatus !== 'toured') await recordTourEvent('tour_took_place', 'tour_took_place', 'Tour took place');
if (newStatus === 'no_show' && currentStatus !== 'no_show') await recordTourEvent('tour_no_show', 'tour_no_show', 'Tour no-show');
if (newStatus === 'canceled' && currentStatus !== 'canceled') await recordTourEvent('tour_canceled', 'tour_canceled', 'Tour canceled');
// exit-gate: outcome newly set while toured
if (outcomeNewlySet) await recordTourEvent('tour_outcome', 'tour_outcome', `Tour outcome · ${moveForward ? 'moved forward' : 'not a fit'}`);
```

Preserve the existing `tour_took_place` semantics exactly (it stays a tenant activity event; the audit row is additive). Derive `wasReschedule`/`outcomeNewlySet` from the same locals the handler already computes for its state machine (inspect :379-425). `current.unitId` is on the tour.

- [ ] **Step 5: Run — expect PASS** (whole tours file, regression check).

Run: `cd app && npx vitest run test/toursApi.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add app/src/routes/tours.ts app/src/routes/api.ts app/test/toursApi.test.ts
git commit -m "feat(activity): propagate tour lifecycle to tenant timeline + property audit"
```

---

## WS2 — Property (unit) Activity coverage

### Task 2.1: Write a `broadcast_sent` unit-audit row on fan-out completion

**Files:**
- Modify: `app/src/jobs/broadcastFanOut.ts` (`finalize` :469-494; deps/factory for `auditRepo`)
- Test: `app/test/broadcastFanOut.test.ts` (extend)

**Interfaces:**
- Consumes: `world.auditRepo`/`world.auditEvents`.
- Produces: on terminal fan-out, when `broadcast.unitId` is set, `audit.append('units#'+unitId, 'broadcast_sent', { broadcastId, tenantCount })` (tenantCount = total recipients).

- [ ] **Step 1: Write the failing test** — inspect `broadcastFanOut.test.ts` for how it constructs the job + world and drives a fan-out to completion; add:

```ts
it('writes a units# broadcast_sent audit row with the recipient count on completion', async () => {
  // ...arrange a broadcast with unitId='unit-x' and 2 recipients, run fan-out to terminal...
  const rows = world.auditEvents.filter((e) => e.entityKey === 'units#unit-x' && e.event_type === 'broadcast_sent');
  expect(rows).toHaveLength(1);
  expect(rows[0].payload).toMatchObject({ broadcastId: expect.any(String), tenantCount: 2 });
});

it('writes NO units# audit row for a unit-less broadcast', async () => {
  // ...broadcast with unitId undefined...
  expect(world.auditEvents.filter((e) => e.event_type === 'broadcast_sent')).toHaveLength(0);
});
```

- [ ] **Step 2: Run — expect FAIL.**

Run: `cd app && npx vitest run test/broadcastFanOut.test.ts -t "broadcast_sent audit"`
Expected: FAIL.

- [ ] **Step 3: Implement** — add `auditRepo` to the fan-out job's dep set (inspect how it receives repos — a factory or the job registration; default `createAuditRepo`). In `finalize` (:469-494), after `total` is computed, if `fresh.unitId` is a non-empty string, best-effort:

```ts
if (typeof fresh.unitId === 'string' && fresh.unitId.length > 0) {
  try {
    await audit.append(`units#${fresh.unitId}`, 'broadcast_sent', { broadcastId, tenantCount: total });
  } catch (err) { log.error({ err, broadcastId }, 'broadcast_sent unit audit failed (best-effort)'); }
}
```

- [ ] **Step 4: Run — expect PASS.**

Run: `cd app && npx vitest run test/broadcastFanOut.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add app/src/jobs/broadcastFanOut.ts app/test/broadcastFanOut.test.ts
git commit -m "feat(activity): record broadcast_sent on the property audit at fan-out completion"
```

### Task 2.2: Project the new payload keys in `toUnitActivityEvent`

**Files:**
- Modify: `app/src/routes/units.ts` (`UnitActivityEvent` :118-135; `toUnitActivityEvent` :138-162; doc-comment :111-114)
- Test: `app/test/unitsApiActivity.test.ts` (extend)

**Interfaces:**
- Produces: `UnitActivityEvent` gains optional `broadcastId?`, `tenantCount?`, `tourId?`, `outcome?`; the projection lifts them from the audit payload for the new event types.

- [ ] **Step 1: Write the failing test** — seed unit audit rows directly via `world.auditRepo.append` then GET `/api/units/:id/activity`:

```ts
it('projects broadcast_sent and tour audit rows onto the activity wire', async () => {
  const { app, world } = makeWebhookHarness();
  seedUnit(world, 'u1');
  await world.auditRepo.append('units#u1', 'broadcast_sent', { broadcastId: 'b9', tenantCount: 3 });
  await world.auditRepo.append('units#u1', 'tour_scheduled', { tourId: 't5' });
  const res = await authedGet(app, '/api/units/u1/activity');
  const b = res.body.events.find((e) => e.type === 'broadcast_sent');
  expect(b).toMatchObject({ broadcastId: 'b9', tenantCount: 3 });
  const t = res.body.events.find((e) => e.type === 'tour_scheduled');
  expect(t).toMatchObject({ tourId: 't5' });
});
```

- [ ] **Step 2: Run — expect FAIL** (`broadcastId`/`tourId` undefined on the wire).

Run: `cd app && npx vitest run test/unitsApiActivity.test.ts -t "projects broadcast_sent"`
Expected: FAIL.

- [ ] **Step 3: Implement** — extend the `UnitActivityEvent` interface (:118-135) with `broadcastId?: string; tenantCount?: number; tourId?: string; outcome?: string;`. In `toUnitActivityEvent` (:138-162) lift those keys from `e.payload` with the same defensive typeof checks the existing keys use. Update the doc-comment (:111-114) to list the new event types (`broadcast_sent`, `tour_scheduled`, `tour_rescheduled`, `tour_took_place`, `tour_no_show`, `tour_canceled`, `tour_outcome`).

- [ ] **Step 4: Run — expect PASS.**

Run: `cd app && npx vitest run test/unitsApiActivity.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add app/src/routes/units.ts app/test/unitsApiActivity.test.ts
git commit -m "feat(activity): project broadcast/tour payload keys onto the property Activity wire"
```

### Task 2.3: Render the new property-activity kinds (frontend)

**Files:**
- Modify: `dashboard/src/api/types.ts` (`UnitActivityEvent` type — add the optional fields, lockstep with Task 2.2)
- Modify: `dashboard/src/routes/listing/listingFormat.ts` (`describeUnitActivity` :86-130)
- Test: `dashboard/src/routes/listing/listingFormat.test.ts` (extend)

**Interfaces:**
- Produces: `describeUnitActivity` returns `{ label, sub?, to? }` for the new kinds:
  - `broadcast_sent` → `{ label: 'Broadcast to N tenants', to: '/broadcasts/<broadcastId>' }`
  - `tour_scheduled` → `{ label: 'Tour scheduled', to: '/tours/<tourId>' }` (and `tour_rescheduled`→'Tour rescheduled', `tour_took_place`→'Tour took place', `tour_no_show`→'Tour no-show', `tour_canceled`→'Tour canceled', `tour_outcome`→'Tour outcome')

- [ ] **Step 1: Write the failing test** — extend `listingFormat.test.ts`:

```ts
it('describes broadcast_sent with a recipient count and a broadcast deep-link', () => {
  expect(describeUnitActivity({ id: 'a', at: 'x', type: 'broadcast_sent', broadcastId: 'b1', tenantCount: 5 } as any))
    .toEqual({ label: 'Broadcast to 5 tenants', to: '/broadcasts/b1' });
});
it('describes tour lifecycle rows with tour deep-links', () => {
  expect(describeUnitActivity({ id: 'a', at: 'x', type: 'tour_canceled', tourId: 't2' } as any))
    .toMatchObject({ label: 'Tour canceled', to: '/tours/t2' });
});
```

- [ ] **Step 2: Run — expect FAIL.**

Run: `cd dashboard && npx vitest run src/routes/listing/listingFormat.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** — add the optional fields to `UnitActivityEvent` in `types.ts`, then add cases to `describeUnitActivity`:

```ts
if (e.type === 'broadcast_sent') {
  const n = typeof e.tenantCount === 'number' ? e.tenantCount : 0;
  return { label: `Broadcast to ${n} ${n === 1 ? 'tenant' : 'tenants'}`, ...(e.broadcastId ? { to: `/broadcasts/${e.broadcastId}` } : {}) };
}
const TOUR_LABELS: Record<string, string> = {
  tour_scheduled: 'Tour scheduled', tour_rescheduled: 'Tour rescheduled', tour_took_place: 'Tour took place',
  tour_no_show: 'Tour no-show', tour_canceled: 'Tour canceled', tour_outcome: 'Tour outcome',
};
if (e.type in TOUR_LABELS) {
  return { label: TOUR_LABELS[e.type], ...(e.tourId ? { to: `/tours/${e.tourId}` } : {}) };
}
```

Place these before the `default` fallthrough.

- [ ] **Step 4: Run — expect PASS.** Then typecheck dashboard.

Run: `cd dashboard && npx vitest run src/routes/listing/listingFormat.test.ts && npx tsc --noEmit; echo "EXIT=$?"`
Expected: PASS, `EXIT=0`.

- [ ] **Step 5: Commit.**

```bash
git add dashboard/src/api/types.ts dashboard/src/routes/listing/listingFormat.ts \
  dashboard/src/routes/listing/listingFormat.test.ts
git commit -m "feat(activity): render broadcast + tour rows on the property Activity card"
```

---

## WS3 — Landlord status + property-activity aggregation

### Task 3.1: Emit `contact_status_changed` on the generic-edit status write

**Files:**
- Modify: `app/src/routes/contacts.ts` (`PATCH /api/contacts/:id` :1061-1210, near the write :1137 and audit :1177)
- Test: `app/test/contactsCrud.test.ts` (extend)

**Interfaces:**
- Produces: when a `PATCH /api/contacts/:id` changes `status`, records `{ contactId, type: 'contact_status_changed', label: 'Status → <Label>' }`. (The transition-service path from Task 1.1 already covers the kanban/status-picker path; this closes the edit-form gap for landlords AND tenants.)

- [ ] **Step 1: Write the failing test:**

```ts
it('records a contact_status_changed milestone when the edit form changes a landlord status', async () => {
  const { app, world } = makeWebhookHarness();
  world.contacts.push({ contactId: 'll1', type: 'landlord', status: 'needs_review' } as ContactItem);
  await authed(app).patch('/api/contacts/ll1').send({ status: 'active' }).expect(200);
  const ev = world.activityEvents.filter((e) => e.type === 'contact_status_changed');
  expect(ev).toHaveLength(1);
  expect(ev[0].label).toContain('Active');
});
it('records NO status milestone when the edit does not change status', async () => {
  const { app, world } = makeWebhookHarness();
  world.contacts.push({ contactId: 'll2', type: 'landlord', status: 'active', firstName: 'A' } as ContactItem);
  await authed(app).patch('/api/contacts/ll2').send({ firstName: 'B' }).expect(200);
  expect(world.activityEvents.filter((e) => e.type === 'contact_status_changed')).toHaveLength(0);
});
```

- [ ] **Step 2: Run — expect FAIL.**

Run: `cd app && npx vitest run test/contactsCrud.test.ts -t "edit form changes a landlord status"`
Expected: FAIL.

- [ ] **Step 3: Implement** — in the PATCH handler, after the successful `contacts.update` (:1137) and only when `parsed.patch.status` is present AND differs from the stored status (the handler already reads `stored`/current at :1080-1091), best-effort record. Import `TENANT_STATUS_LABELS, LANDLORD_STATUS_LABELS` from `../lib/statusModel.js`; pick the map by `stored.type`:

```ts
if (typeof parsed.patch.status === 'string' && parsed.patch.status !== stored.status) {
  const labels = stored.type === 'landlord' ? LANDLORD_STATUS_LABELS : TENANT_STATUS_LABELS;
  try {
    await activityEvents.record({ contactId, type: 'contact_status_changed', label: `Status → ${(labels as Record<string,string>)[parsed.patch.status] ?? parsed.patch.status}` });
  } catch (err) { log.error({ err, contactId }, 'contact_status_changed (edit) milestone record failed (best-effort)'); }
}
```

> Guard against double-emit: this edit path and the transition-service `setTenantStatus` path are **distinct routes** (`PATCH /api/contacts/:id` vs `PATCH /api/contacts/:id/tenant-status`) — a single request goes through one, not both, so no dedupe needed.

- [ ] **Step 4: Run — expect PASS.**

Run: `cd app && npx vitest run test/contactsCrud.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add app/src/routes/contacts.ts app/test/contactsCrud.test.ts
git commit -m "feat(activity): emit contact_status_changed on the contact edit-form status write"
```

### Task 3.2: Interleave a landlord's property activity into their timeline

**Files:**
- Modify: `app/src/routes/contactTimeline.ts` (deps :63-70; construct :283-289; landlord branch after milestone gather ~:378)
- Test: `app/test/contactTimeline.test.ts` (extend)

**Interfaces:**
- Consumes: `unitsRepo.listByLandlord`, `auditRepo.listByEntity`.
- Produces: for a `landlord` contact, the timeline merges each owned unit's **lifecycle** audit rows (`broadcast_sent`, `tour_*`, `listing_status_changed`, `unit_contact_added`, `unit_contact_removed`, `listing_response_set` — **NOT** `unit_created`/`unit_updated`/`unit_deleted`/`unit_restored`) as `TimelineMilestone` candidates (deep-linked: broadcast→broadcast, tour→tour, else unit).

- [ ] **Step 1: Write the failing test:**

```ts
describe('GET /api/contacts/:id/timeline — landlord property interleave', () => {
  it('merges owned-unit lifecycle audit into the landlord timeline, excluding field-edits', async () => {
    const h = makeWebhookHarness(); const app = h.app, world = h.world;
    world.contacts.push({ contactId: 'll1', type: 'landlord', phone: '+15550100009', phones: [{ phone: '+15550100009', primary: true }] } as ContactItem);
    world.units.set('u1', { unitId: 'u1', landlordId: 'll1', status: 'available' } as UnitItem);
    await world.auditRepo.append('units#u1', 'broadcast_sent', { broadcastId: 'b1', tenantCount: 4 });
    await world.auditRepo.append('units#u1', 'tour_scheduled', { tourId: 't1' });
    await world.auditRepo.append('units#u1', 'unit_updated', { fields: ['rent_min'] }); // EXCLUDED
    const res = await request(app).get('/api/contacts/ll1/timeline').set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    const ms = res.body.items.filter((i) => i.kind === 'milestone');
    const types = ms.map((m) => m.type);
    expect(types).toContain('broadcast_sent');
    expect(types).toContain('tour_scheduled');
    expect(types).not.toContain('unit_updated');
    const bc = ms.find((m) => m.type === 'broadcast_sent');
    expect(bc).toMatchObject({ refType: 'broadcast', refId: 'b1', label: expect.stringContaining('4') });
  });

  it('does NOT interleave property activity for a tenant contact', async () => {
    const h = makeWebhookHarness(); const app = h.app, world = h.world;
    world.contacts.push({ contactId: 't1', type: 'tenant', phone: '+15550100010', phones: [{ phone: '+15550100010', primary: true }] } as ContactItem);
    world.units.set('u2', { unitId: 'u2', landlordId: 't1', status: 'available' } as UnitItem); // even if mis-owned
    await world.auditRepo.append('units#u2', 'broadcast_sent', { broadcastId: 'b2', tenantCount: 1 });
    const res = await request(app).get('/api/contacts/t1/timeline').set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);
    expect(res.body.items.filter((i) => i.kind === 'milestone' && i.type === 'broadcast_sent')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

Run: `cd app && npx vitest run test/contactTimeline.test.ts -t "landlord property interleave"`
Expected: FAIL.

- [ ] **Step 3: Add deps** — add `unitsRepo?: UnitsRepo; auditRepo?: AuditRepo;` to `ContactTimelineRouterDeps` (:63-70), import + default them (`createUnitsRepo`, `createAuditRepo`) at the construct site (:283-289). Confirm `api.ts` forwards both (it already carries `unitsRepo` + `auditRepo`).

- [ ] **Step 4: Implement a server-side audit→milestone mapper + the landlord branch.** Add a module-level constant + helper:

```ts
const LANDLORD_FEED_TYPES = new Set([
  'broadcast_sent', 'tour_scheduled', 'tour_rescheduled', 'tour_took_place',
  'tour_no_show', 'tour_canceled', 'tour_outcome', 'listing_status_changed',
  'unit_contact_added', 'unit_contact_removed', 'listing_response_set',
]);

function unitAuditToMilestone(unitId: string, e: AuditEvent): TimelineMilestone | null {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const at = /* ISO prefix of e.ts */ (typeof e.ts === 'string' ? e.ts.split('#')[0] : '');
  const base = { kind: 'milestone' as const, id: e.ts ?? `${unitId}-${e.event_type}`, at };
  switch (e.event_type) {
    case 'broadcast_sent': {
      const n = typeof p['tenantCount'] === 'number' ? p['tenantCount'] : 0;
      return { ...base, type: 'listing_sent', label: `Broadcast to ${n} ${n === 1 ? 'tenant' : 'tenants'}`, refType: 'broadcast', ...(typeof p['broadcastId'] === 'string' ? { refId: p['broadcastId'] } : {}) };
    }
    case 'tour_scheduled': case 'tour_rescheduled': case 'tour_took_place':
    case 'tour_no_show': case 'tour_canceled': case 'tour_outcome':
      return { ...base, type: mapTourAuditToMilestoneType(e.event_type), label: tourAuditLabel(e.event_type), refType: 'tour', ...(typeof p['tourId'] === 'string' ? { refId: p['tourId'] } : {}) };
    case 'listing_status_changed':
      return { ...base, type: 'stage_changed', label: `Property status → ${typeof p['to'] === 'string' ? p['to'] : ''}`, refType: 'unit', refId: unitId };
    case 'unit_contact_added': case 'unit_contact_removed':
      return { ...base, type: e.event_type === 'unit_contact_added' ? 'added_to_group_text' : 'removed_from_group_text', label: e.event_type === 'unit_contact_added' ? 'Property contact added' : 'Property contact removed', refType: 'unit', refId: unitId };
    case 'listing_response_set':
      return { ...base, type: 'listing_reviewed', label: `Tenant response · ${typeof p['response'] === 'string' ? p['response'] : ''}`, refType: 'unit', refId: unitId };
    default:
      return null;
  }
}
```

> **Constraint:** the `type` on a `TimelineMilestone` MUST be an existing `ActivityEventType` (the frontend renders by it). Reuse the closest existing members (as above) — do NOT emit raw audit type strings as milestone `type`s. The **label** carries the human-facing wording; the `type` only drives colour/link. `mapTourAuditToMilestoneType` maps `tour_rescheduled`→`tour_scheduled`, others 1:1 to the same-named `ActivityEventType`.

Then, after the milestone gather (~:378), inside `if (wantMilestone)`:

```ts
if (contact.type === 'landlord') {
  const owned = await units.listByLandlord(contactId, { limit: MAX_LANDLORD_UNITS });
  if (owned.items.length >= MAX_LANDLORD_UNITS) log.warn({ contactId, count: owned.items.length }, 'landlord unit fan-out capped');
  for (const u of owned.items) {
    const rows = await audit.listByEntity(`units#${u.unitId}`, { limit: limit + 1, ...(boundaryKey !== undefined && { before: boundaryKey }) });
    for (const r of rows) {
      if (!LANDLORD_FEED_TYPES.has(r.event_type)) continue;
      const ms = unitAuditToMilestone(u.unitId, r);
      if (ms) candidates.push({ /* globalKey from ms.at#ms.id */ globalKey: `${ms.at}#${ms.id}`, item: ms });
    }
  }
}
```

Match the exact `candidates`/`globalKey` shape the file already uses (inspect :353-387). Add `const MAX_LANDLORD_UNITS = 25;` near the other limit consts.

- [ ] **Step 5: Run — expect PASS** (whole file).

Run: `cd app && npx vitest run test/contactTimeline.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck app.**

Run: `cd app && npx tsc --noEmit; echo "EXIT=$?"`
Expected: `EXIT=0`.

- [ ] **Step 7: Commit.**

```bash
git add app/src/routes/contactTimeline.ts app/test/contactTimeline.test.ts
git commit -m "feat(activity): interleave a landlord's property lifecycle activity into their timeline"
```

---

## WS5 — Issues (docs)

### Task 5.1: File + refresh the issue registry

**Files:**
- Create: `docs/issues/tour-activity-no-tour-page-surface.md`
- Create: `docs/issues/excluded-field-edits-unsurfaced.md`
- Modify: `docs/issues/transition-service-no-activity-milestones.md` (→ resolved)

- [ ] **Step 1: Create `tour-activity-no-tour-page-surface.md`** (copy `docs/issues/_TEMPLATE.md`): `type: improvement`, `severity: low`, `status: open`, `area: dashboard/tours`, `created: 2026-07-03`. Problem: this feature propagates tour lifecycle to the tenant timeline + property Activity, but the **tour detail page itself shows none of its own lifecycle history**. Pairs with `[[scheduled-message-visibility]]` (the reminder-ladder panel). Suggested fix: a tour History panel reading the tour's audit/events.

- [ ] **Step 2: Create `excluded-field-edits-unsurfaced.md`**: `type: decision`, `severity: low`, `status: wontfix`, `created: 2026-07-03`. Record the deliberate choice (human, 2026-07-03) that routine field edits — tenant/landlord name/voucher/other-field edits/delete/restore, and property `unit_updated` field-edits on the landlord feed — are intentionally NOT surfaced on any activity timeline; they remain in the audit trail as provenance. So a future reader knows it's a choice, not an oversight.

- [ ] **Step 3: Resolve `transition-service-no-activity-milestones.md`** — set `status: resolved`, add `resolved: 2026-07-03` and a `**Resolution (2026-07-03).**` note: the transition service now emits `stage_changed`/`placement_closed` (Task 1.2) and `contact_status_changed` (Task 1.1) alongside its audit writes; see `app/src/services/statusTransition.ts`.

- [ ] **Step 4: Commit.**

```bash
git add docs/issues/tour-activity-no-tour-page-surface.md \
  docs/issues/excluded-field-edits-unsurfaced.md \
  docs/issues/transition-service-no-activity-milestones.md
git commit -m "docs(issues): file tour-page + excluded-edits notes; resolve transition-service-no-activity-milestones"
```

---

## Phase 4 — E2E verification

### Task E.1: Extend e2e specs to assert the surfaces

**Files (extend, don't rewrite):**
- `e2e/tests/dashboard-next/contact-detail.spec.ts` — opt-out (both channels) → milestone pins on the tenant timeline.
- `e2e/tests/dashboard-next/placement-history.spec.ts` — a placement transition → `stage_changed` pin on the tenant timeline AND the placement History panel.
- `e2e/tests/dashboard-next/listing-activity.spec.ts` — a broadcast → "Broadcast to N tenants" row on the property, click → `/broadcasts/:id`; a tour scheduled/canceled → tour rows on the property Activity.
- `e2e/tests/scenarios/tours.spec.ts` — tour scheduled + toured + canceled → tenant timeline pins.
- A landlord spec (extend `contact-detail.spec.ts` or add `landlord-activity.spec.ts`) — a broadcast/tour on an owned property → interleaved milestone on the landlord's timeline.

**Seams (from research):** opt-out `POST /api/contacts/:id/opt-out` + `/voice-opt-out` (or `ContactActionsMenu`); placement `Scenario.teamMovesPlacementTo`; tours `teamBooksTour`/`teamMarksToured` + **`PATCH /api/tours/:id {status:'canceled'}`** (no cancel verb — add one or call the API); broadcast composer UI then **poll fake-twilio** (no fan-out tick — worker drains SQS). Assert timeline pins with `getByRole`/`getByText` per `e2e/support/selectors.md`.

- [ ] **Step 1: Add a `teamCancelsTour` step verb** (if a UI control exists) OR a direct-API helper in the spec — inspect `e2e/scenarios/steps.ts:2279` `tourStatusAction`; if the UI has a cancel action, add `teamCancelsTour` mirroring `teamMarksNoShow`; else the spec PATCHes the API.

- [ ] **Step 2: Write the opt-out timeline assertion** (contact-detail.spec.ts) — drive the opt-out, reload the contact, assert a "Marked Do Not Contact" pin (and Do-Not-Call). Match existing spec structure.

- [ ] **Step 3: Write the placement stage assertion** (placement-history.spec.ts) — move a placement, assert both the History row and the tenant timeline pin.

- [ ] **Step 4: Write the property broadcast + tour assertions** (listing-activity.spec.ts) — send a broadcast to a property, poll the property Activity card for "Broadcast to N tenants", assert the row links to `/broadcasts/`; schedule + cancel a tour, assert tour rows.

- [ ] **Step 5: Write the landlord interleave assertion** — on a landlord contact owning that property, assert the broadcast/tour milestone appears on the landlord timeline.

- [ ] **Step 6: Warm containers, then run the full e2e suite in this worktree's lane.**

Run: `cd "w:/tmp/activity-coverage" && npm run db:start && npm run s3:start && npm run e2e > e2e-out.txt 2>&1; echo "E2E_EXIT=$?"`
Expected: `E2E_EXIT=0`. (Inspect `e2e-out.txt` — never `| tail` a test run; read the file for the real exit code + failures.)

- [ ] **Step 7: Commit.**

```bash
git add e2e/ && git commit -m "test(e2e): assert activity coverage across contact/property/landlord/tour surfaces"
```

### Task E.2: Full green on synced main

- [ ] **Step 1: Sync main** — `git fetch origin && git merge main` (resolve conflicts keeping both intents; re-run affected tests). If deps changed, `npm install`.
- [ ] **Step 2: Full unit suites.** `cd app && npx vitest run > ../app-test.txt 2>&1; echo "APP=$?"` and `cd dashboard && npx vitest run > ../dash-test.txt 2>&1; echo "DASH=$?"`. Expected `APP=0`, `DASH=0`.
- [ ] **Step 3: Typecheck both.** `cd app && npx tsc --noEmit; echo $?` / `cd dashboard && npx tsc --noEmit; echo $?` → 0/0.
- [ ] **Step 4: Full e2e** (as E.1 Step 6) → `E2E_EXIT=0`.
- [ ] **Step 5:** Report green + a decisions/deferrals summary. **Do NOT merge** — await human approval.

---

## Self-Review (spec coverage)

- WS1 status (explicit+derived), opt-out (both channels), placement stage → tenant timeline ✓ (Tasks 1.1–1.3)
- WS2 broadcast "to N tenants" deep-link + tours on property ✓ (Tasks 2.1–2.3)
- WS3 landlord status (both write paths: transition service via 1.1 + edit form via 3.1) + property interleave lifecycle-only ✓ (Tasks 3.1–3.2)
- WS4 tour lifecycle scheduled/rescheduled/toured/no_show/canceled/outcome, no `confirmed`, dual-write, idempotent ✓ (Task 4.1)
- WS5 issues filed + transition-service issue resolved + excluded-edits decision ✓ (Task 5.1)
- Enum lockstep, best-effort, idempotency, PII, no new tables/GSIs ✓ (Global Constraints; confirmed in research)
- e2e assertions for every surface ✓ (Task E.1); full green on synced main ✓ (E.2)
- **Deferred:** tour detail-page history (issue only); broadcast fan-out has no dev tick (e2e polls).
