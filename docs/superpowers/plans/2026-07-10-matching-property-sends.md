<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-07-10).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.

# Matching Property Sends Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One send pipeline for one-to-one and one-to-many property sends: seedable recipients on the existing broadcast draft/preview/send flow, "+ Send" entry points on the tenant-file and property-page cards, a resolved-text message editor for single-recipient sends, and a copy-level rename of the "Broadcasts" surface to "Matching".

**Architecture:** The existing broadcast pipeline already converges to an explicit curated recipient list at send time (POST /api/broadcasts/:id/send takes recipientContactIds). We add seed_contact_ids + audience_mode to the draft, union seeds into preview, and let entry points open the composer pre-seeded. Drafts are create-only (edits recreate the draft, useComposerDraft); a small PATCH persists hand-picked additions. All copy renames are display-only: broadcast* identifiers, tables, and /broadcasts routes are unchanged.

**Tech Stack:** Express + DynamoDB (app workspace), React 19 + react-router + CSS modules + vitest/RTL (dashboard workspace), Playwright (e2e workspace).

**Spec:** docs/superpowers/specs/2026-07-10-matching-property-sends-design.md

## Global Constraints

- Code/data keep broadcast* names everywhere (types, routes, tables, jobs, log fields). ONLY human-visible copy changes.
- URLs unchanged: /broadcasts, /broadcasts/new, /broadcasts/:broadcastId.
- New human-facing nouns: section "Matching"; one item is a "send" / "property send"; primary action "Send a property".
- Glossary discipline: documentation/GLOSSARY.md is updated in the same feature (Task 12).
- New doc/plan/log text is plain ASCII. Existing copy strings keep their existing characters (some contain typographic quotes or arrows; when editing those lines, match the file's existing characters exactly).
- Gates run BARE (never pipe a gate through tail/grep). `npm run typecheck` is a REQUIRED gate in addition to `npm test` and `npm run e2e`.
- Worktree: w:/tmp/matching-sends, branch feat/matching-property-sends. Before declaring done: merge latest main, re-run all gates.
- MAX_TEMPLATE_LEN = 1600; MAX_BROADCAST_RECIPIENTS = 1500 (existing constants; do not change).

---

### Task 1: Backend - seeds + audience_mode on the draft (create path)

**Files:**
- Modify: `app/src/repos/broadcastsRepo.ts` (BroadcastItem ~lines 110-140, CreateBroadcastInput ~231-240, create() ~402)
- Modify: `app/src/routes/broadcasts.ts` (createDraft handler ~line 305)
- Modify: `app/src/routes/units.ts:384-391` (stale seam comment)
- Test: `app/test/broadcastApi.test.ts`

**Interfaces:**
- Consumes: existing `parseRecipientContactIds(raw)` (broadcasts.ts ~123), `hasSmsConsent` (src/lib/smsCompliance.js), `AudienceResolutionService`, `ContactsRepo.getById`.
- Produces (later tasks rely on these exact names):
  - `BroadcastItem.seed_contact_ids?: string[]`
  - `BroadcastItem.audience_mode?: 'filter' | 'seeds_only'` (absent = 'filter')
  - `CreateBroadcastInput.seedContactIds?: string[]`, `CreateBroadcastInput.audienceMode?: 'filter' | 'seeds_only'`
  - createDraft 201 response gains `flyerUrl?: string` (echo of the stored flyer_url)
  - Route-file helper `resolveSeeds(contactsRepo, ids)` returning `{ contacts: ResolvedContact[]; unresolved: string[] }` (reused by Tasks 2 and 3)

- [ ] **Step 1: Write the failing tests** (append to the `share-broadcast API (M1.8a)` describe in `app/test/broadcastApi.test.ts`, mimicking the existing `createDraft` helper + seedTenant/seedUnit setup):

```ts
it('createDraft with seedContactIds and NO audience_filter stores a seeds_only draft and estimates from the seeds', async () => {
  const app = makeWebhookHarness({ world }).app;
  seedTenant(world, { contactId: 'c-seed', phone: '+15550001001', firstName: 'Brianna' });
  seedTenant(world, { contactId: 'c-other', phone: '+15550001002' }); // must NOT count
  const unitId = seedUnit(world);
  const res = await request(app)
    .post('/api/broadcasts')
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send({ unitId, body_template: 'Hi!', seedContactIds: ['c-seed'] });
  expect(res.status).toBe(201);
  expect(res.body.estimatedCount).toBe(1); // seeds only, not the whole tenant base
  expect(typeof res.body.flyerUrl).toBe('string');
  expect(res.body.flyerUrl).toContain(`/p/${unitId}`);
  const stored = world.broadcasts.get(res.body.broadcastId);
  expect(stored?.seed_contact_ids).toEqual(['c-seed']);
  expect(stored?.audience_mode).toBe('seeds_only');
});

it('createDraft with seedContactIds AND an audience_filter stays in filter mode and estimates the union', async () => {
  const app = makeWebhookHarness({ world }).app;
  seedTenant(world, { contactId: 'c-1', phone: '+15550001001' });
  seedTenant(world, { contactId: 'c-2', phone: '+15550001002' });
  const res = await request(app)
    .post('/api/broadcasts')
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send({
      body_template: 'Hi!',
      audience_filter: { contact_type: 'tenant' },
      seedContactIds: ['c-1'], // already inside the audience: union must not double-count
    });
  expect(res.status).toBe(201);
  expect(res.body.estimatedCount).toBe(2);
  expect(world.broadcasts.get(res.body.broadcastId)?.audience_mode).toBe('filter');
});

it('createDraft drops unresolvable seeds from the estimate (unknown id, opted-out)', async () => {
  const app = makeWebhookHarness({ world }).app;
  seedTenant(world, { contactId: 'c-ok', phone: '+15550001001' });
  seedTenant(world, { contactId: 'c-optout', phone: '+15550001002', sms_opt_out: true });
  const res = await request(app)
    .post('/api/broadcasts')
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send({ body_template: 'Hi!', seedContactIds: ['c-ok', 'c-optout', 'c-ghost'] });
  expect(res.status).toBe(201);
  expect(res.body.estimatedCount).toBe(1);
});
```

- [ ] **Step 2: Run to verify RED**

Run (from `w:/tmp/matching-sends`): `npx vitest run test/broadcastApi.test.ts --root app`
Expected: the three new tests FAIL (estimatedCount reflects the whole tenant base / seed_contact_ids undefined / no flyerUrl in body).

- [ ] **Step 3: Implement**

In `app/src/repos/broadcastsRepo.ts`:

```ts
/** How preview/send derive candidates: 'filter' resolves the audience filter
 *  (and unions any seeds); 'seeds_only' uses ONLY seed_contact_ids (the seeded
 *  1:1 entry - the default filter would otherwise propose every tenant).
 *  Absent on legacy rows = 'filter'. */
export type BroadcastAudienceMode = 'filter' | 'seeds_only';
```

Add to `BroadcastItem`:

```ts
  /** Explicit recipients attached to the draft (entry-point seed or the
   *  review step's hand-picked additions). Independent of audience_filter. */
  seed_contact_ids?: string[];
  audience_mode?: BroadcastAudienceMode;
```

Add to `CreateBroadcastInput`:

```ts
  seedContactIds?: string[];
  audienceMode?: BroadcastAudienceMode;
```

In `create()` (where the item literal is built, ~line 402), add:

```ts
    ...(input.seedContactIds !== undefined &&
      input.seedContactIds.length > 0 && { seed_contact_ids: input.seedContactIds }),
    ...(input.audienceMode !== undefined && { audience_mode: input.audienceMode }),
```

In `app/src/routes/broadcasts.ts`, add a module-level helper near `parseRecipientContactIds` (it needs the router's `contacts` repo, so make it a closure inside `createBroadcastsRouter` after the deps are resolved):

```ts
  /** Resolve seed contact ids to sendable tenants using the SAME fences as the
   *  explicit-selection send path: exists, type 'tenant', has phone, not
   *  sms_opt_out, not sms_unreachable. Anything else lands in `unresolved`.
   *  Seeds are few (1..handful), so per-id getById is fine. */
  async function resolveSeeds(
    ids: string[],
  ): Promise<{ contacts: ResolvedContact[]; unresolved: string[] }> {
    const resolved: ResolvedContact[] = [];
    const unresolved: string[] = [];
    for (const id of ids) {
      const c = await contacts.getById(id);
      if (
        !c ||
        c.type !== 'tenant' ||
        typeof c.phone !== 'string' ||
        c.phone.length === 0 ||
        c.sms_opt_out === true ||
        c.sms_unreachable === true
      ) {
        unresolved.push(id);
        continue;
      }
      resolved.push({
        contactId: c.contactId,
        phone: c.phone,
        ...(typeof c.firstName === 'string' && { firstName: c.firstName }),
        ...(typeof c.lastName === 'string' && { lastName: c.lastName }),
        ...(typeof c.voucherSize === 'number' && { voucherSize: c.voucherSize }),
        ...(typeof c.housingAuthority === 'string' && { housingAuthority: c.housingAuthority }),
        has_consent: hasSmsConsent(c),
      });
    }
    return { contacts: resolved, unresolved };
  }
```

(Import `ResolvedContact` from `../services/audienceResolution.js` and `hasSmsConsent` from `../lib/smsCompliance.js` if not already imported in this file.)

In the createDraft handler (~line 305):

```ts
    const seedContactIds = parseRecipientContactIds(
      (req.body as Record<string, unknown> | undefined)?.['seedContactIds'],
    );
    const rawFilterProvided =
      (req.body as Record<string, unknown> | undefined)?.['audience_filter'] !== undefined;
    const audienceMode: BroadcastAudienceMode =
      seedContactIds !== undefined && !rawFilterProvided ? 'seeds_only' : 'filter';
```

Compute the estimate (replacing the single `resolveAudience` result usage for the count):

```ts
    const seeds =
      seedContactIds !== undefined ? await resolveSeeds(seedContactIds) : { contacts: [], unresolved: [] };
    let estimatedAudience: number;
    let truncated = false;
    if (audienceMode === 'seeds_only') {
      estimatedAudience = seeds.contacts.length;
    } else {
      const audience = await resolveAudience(filter);
      const union = new Set(audience.contactIds);
      for (const s of seeds.contacts) union.add(s.contactId);
      estimatedAudience = union.size;
      truncated = audience.truncated;
    }
```

Pass to `broadcasts.create({ ..., estimatedAudience, ...(seedContactIds !== undefined && { seedContactIds }), audienceMode })` and extend the 201 response with `...(flyer_url !== undefined && { flyerUrl: flyer_url })` (keep the existing `estimatedCount`/`truncated` response fields fed from the values above).

In `app/src/routes/units.ts:384-391`, replace the stale seam comment body with:

```ts
  // Individual flyer sends are the SEEDED broadcast-pipeline flow (see
  // docs/superpowers/specs/2026-07-10-matching-property-sends-design.md):
  // a draft created with seedContactIds sends through the same fan-out and
  // records listing_sends per recipient. No separate individual-send route.
```

- [ ] **Step 4: Run to verify GREEN**

Run: `npx vitest run test/broadcastApi.test.ts --root app`
Expected: all tests pass (including every pre-existing test in the file - the default path with no seeds must be byte-identical in behavior).

- [ ] **Step 5: Commit**

```bash
git add app/src/repos/broadcastsRepo.ts app/src/routes/broadcasts.ts app/src/routes/units.ts app/test/broadcastApi.test.ts
git commit -m "feat(broadcasts): drafts carry seed_contact_ids + audience_mode (seeded 1:1 entry)"
```

---

### Task 2: Backend - preview unions seeds and reports unresolved

**Files:**
- Modify: `app/src/routes/broadcasts.ts` (preview handler ~line 383, candidate build ~403-426, response ~433-438)
- Test: `app/test/broadcastApi.test.ts`

**Interfaces:**
- Consumes: `resolveSeeds` (Task 1), `broadcast.seed_contact_ids`, `broadcast.audience_mode`.
- Produces (dashboard Task 5 mirrors these):
  - Preview candidate rows gain `seeded: boolean` (true when the row came from seed_contact_ids; a contact both in audience and seeds is ONE row with `seeded: true`).
  - Preview response gains `seedContactIds: string[]` (as stored) and `unresolvedSeedIds: string[]`.

- [ ] **Step 1: Write the failing tests**

```ts
it('preview unions seeds into candidates, flags them seeded, and reports unresolved seeds', async () => {
  const app = makeWebhookHarness({ world }).app;
  seedTenant(world, { contactId: 'c-aud', phone: '+15550001001', voucherSize: 2 });
  seedTenant(world, { contactId: 'c-seed', phone: '+15550001002', voucherSize: 3 }); // outside bedroomSize filter
  const draft = await request(app)
    .post('/api/broadcasts')
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send({
      body_template: 'Hi!',
      audience_filter: { contact_type: 'tenant', bedroomSize: 2 },
      seedContactIds: ['c-seed', 'c-ghost'],
    });
  const res = await request(app)
    .post(`/api/broadcasts/${draft.body.broadcastId}/preview`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send({});
  expect(res.status).toBe(200);
  const byId = new Map(res.body.candidates.map((c: { contactId: string }) => [c.contactId, c]));
  expect(byId.get('c-aud')).toMatchObject({ seeded: false });
  expect(byId.get('c-seed')).toMatchObject({ seeded: true });
  expect(res.body.seedContactIds).toEqual(['c-seed', 'c-ghost']);
  expect(res.body.unresolvedSeedIds).toEqual(['c-ghost']);
});

it('preview on a seeds_only draft returns ONLY the seeds (never the whole tenant base)', async () => {
  const app = makeWebhookHarness({ world }).app;
  seedTenant(world, { contactId: 'c-seed', phone: '+15550001001' });
  seedTenant(world, { contactId: 'c-other', phone: '+15550001002' });
  const draft = await request(app)
    .post('/api/broadcasts')
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send({ body_template: 'Hi!', seedContactIds: ['c-seed'] });
  const res = await request(app)
    .post(`/api/broadcasts/${draft.body.broadcastId}/preview`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send({});
  expect(res.body.candidates.map((c: { contactId: string }) => c.contactId)).toEqual(['c-seed']);
  expect(res.body.candidates[0]).toMatchObject({ seeded: true });
  expect(res.body.count).toBe(1);
});
```

- [ ] **Step 2: Run to verify RED** - `npx vitest run test/broadcastApi.test.ts --root app` - the two new tests fail (`seeded` undefined / whole base returned).

- [ ] **Step 3: Implement** (preview handler): after `broadcasts.getById`:

```ts
    const seedIds = broadcast.seed_contact_ids ?? [];
    const seeds = seedIds.length > 0 ? await resolveSeeds(seedIds) : { contacts: [], unresolved: [] };
    const audience =
      broadcast.audience_mode === 'seeds_only'
        ? { contacts: [], contactIds: [], count: 0, truncated: false }
        : await resolveAudience(broadcast.audience_filter);
    const seedIdSet = new Set(seeds.contacts.map((c) => c.contactId));
    // Union: audience rows first (stable order), then seeds not already present.
    const combined = [
      ...audience.contacts.filter((c) => !seedIdSet.has(c.contactId)),
      ...seeds.contacts,
    ];
```

Build candidates from `combined` instead of `audience.contacts`, adding to each mapped row:

```ts
        seeded: seedIdSet.has(c.contactId),
```

Extend the response object:

```ts
      seedContactIds: seedIds,
      unresolvedSeedIds: seeds.unresolved,
```

Keep `count`/`truncated` derived from `combined.length` (post-union, pre-slice) and the audience truncation flag.

- [ ] **Step 4: Run to verify GREEN** - `npx vitest run test/broadcastApi.test.ts --root app` - all pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/routes/broadcasts.ts app/test/broadcastApi.test.ts
git commit -m "feat(broadcasts): preview unions seeded recipients + reports unresolved seeds"
```

---

### Task 3: Backend - seeds_only send fallback + audience_mode on the wire

**Files:**
- Modify: `app/src/routes/broadcasts.ts` (send handler path (b) ~540-577; list + results response mapping)
- Test: `app/test/broadcastApi.test.ts`

**Interfaces:**
- Consumes: `resolveSeeds`, `broadcast.audience_mode`.
- Produces: list rows (GET /api/broadcasts) and results (GET /api/broadcasts/:id/results) include `audience_mode` when present. Dashboard Task 5 adds it to `BroadcastSummary` and `BroadcastResults`.

- [ ] **Step 1: Write the failing test**

```ts
it('send with NO body on a seeds_only draft sends to the seeds (not the whole base)', async () => {
  const app = makeWebhookHarness({ world }).app;
  seedTenant(world, { contactId: 'c-seed', phone: '+15550001001' });
  seedTenant(world, { contactId: 'c-other', phone: '+15550001002' });
  const unitId = seedUnit(world);
  const draft = await request(app)
    .post('/api/broadcasts')
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send({ unitId, body_template: 'Hi [TenantName]!', seedContactIds: ['c-seed'] });
  const res = await request(app)
    .post(`/api/broadcasts/${draft.body.broadcastId}/send`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send({});
  expect(res.status).toBe(200);
  expect(res.body.count).toBe(1);
  await queueAdapter.settle();
  const stored = world.broadcasts.get(draft.body.broadcastId);
  expect(Object.keys(stored?.recipients ?? {})).toEqual(['c-seed']);
});
```

- [ ] **Step 2: Run to verify RED** - the test fails (path (b) resolves the default filter and sends to both tenants).

- [ ] **Step 3: Implement.** In the send handler's no-body branch, before the existing filter resolve:

```ts
      if (broadcast.audience_mode === 'seeds_only') {
        const seeds = await resolveSeeds(broadcast.seed_contact_ids ?? []);
        if (seeds.contacts.length === 0) {
          res.status(400).json({ error: 'empty_audience' });
          return;
        }
        // Reuse the explicit-selection recipient build with the seed ids.
        recipients = buildRecipientsFrom(seeds.contacts); // extract the existing per-contact
        // {status:'queued'} map construction into a tiny local helper shared by both paths
      } else {
        // ... existing filter-resolve branch unchanged
      }
```

(Extract the `recipients: Record<contactKey, {status:'queued'}>` construction that the explicit path already performs into a helper `buildRecipientsFrom(list: ResolvedContact[])` used by both.)

For the wire: wherever list rows and the results payload are assembled from `BroadcastItem`, pass through `...(b.audience_mode !== undefined && { audience_mode: b.audience_mode })`.

- [ ] **Step 4: Run to verify GREEN** - `npx vitest run test/broadcastApi.test.ts --root app` - all pass.
- [ ] **Step 5: Commit**

```bash
git add app/src/routes/broadcasts.ts app/test/broadcastApi.test.ts
git commit -m "feat(broadcasts): seeds_only no-body send resolves the seeds; audience_mode on the wire"
```

---

### Task 4: Backend - PATCH persists hand-picked seeds

**Files:**
- Modify: `app/src/repos/broadcastsRepo.ts` (new method), `app/src/routes/broadcasts.ts` (new route)
- Test: `app/test/broadcastApi.test.ts`, `app/test/broadcastsRepo.integration.test.ts`

**Interfaces:**
- Produces:
  - Repo: `setSeedContactIds(broadcastId: string, seedContactIds: string[]): Promise<BroadcastItem>` - conditional on `status = 'draft'`; throws ConditionalCheckFailedException otherwise.
  - Route: `PATCH /api/broadcasts/:broadcastId` body `{ seedContactIds: string[] }` -> 200 `{ broadcastId, seedContactIds }`; 404 `broadcast_not_found`; 409 `broadcast_not_draft`.
  - Dashboard endpoint (Task 5): `updateBroadcastSeeds(broadcastId, seedContactIds)`.

- [ ] **Step 1: Write the failing tests**

```ts
it('PATCH replaces seedContactIds on a draft', async () => {
  const app = makeWebhookHarness({ world }).app;
  seedTenant(world, { contactId: 'c-1', phone: '+15550001001' });
  const draft = await createDraft(app);
  const res = await request(app)
    .patch(`/api/broadcasts/${draft.broadcastId}`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send({ seedContactIds: ['c-1'] });
  expect(res.status).toBe(200);
  expect(world.broadcasts.get(draft.broadcastId)?.seed_contact_ids).toEqual(['c-1']);
});

it('PATCH on a non-draft returns 409 broadcast_not_draft', async () => {
  const app = makeWebhookHarness({ world }).app;
  seedTenant(world, { contactId: 'c-1', phone: '+15550001001' });
  const draft = await createDraft(app);
  await request(app)
    .post(`/api/broadcasts/${draft.broadcastId}/send`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send({ recipientContactIds: ['c-1'] });
  await queueAdapter.settle();
  const res = await request(app)
    .patch(`/api/broadcasts/${draft.broadcastId}`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send({ seedContactIds: ['c-1'] });
  expect(res.status).toBe(409);
  expect(res.body.error).toBe('broadcast_not_draft');
});
```

- [ ] **Step 2: RED** - `npx vitest run test/broadcastApi.test.ts --root app` (404 on PATCH: route missing).
- [ ] **Step 3: Implement** repo method (mirror `markSending`'s conditional-update shape):

```ts
  async setSeedContactIds(broadcastId: string, seedContactIds: string[]): Promise<BroadcastItem> {
    const { Attributes } = await doc.send(
      new UpdateCommand({
        TableName: table,
        Key: { broadcastId },
        UpdateExpression: 'SET seed_contact_ids = :s, updated_at = :t',
        ConditionExpression: '#st = :draft',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: { ':s': seedContactIds, ':draft': 'draft', ':t': new Date().toISOString() },
        ReturnValues: 'ALL_NEW',
      }),
    );
    return Attributes as BroadcastItem;
  }
```

Route:

```ts
  router.patch('/broadcasts/:broadcastId', async (req, res) => {
    const broadcastId = String(req.params['broadcastId'] ?? '');
    const seedContactIds = parseRecipientContactIds(
      (req.body as Record<string, unknown> | undefined)?.['seedContactIds'],
    );
    if (seedContactIds === undefined) {
      res.status(400).json({ error: 'bad_request' });
      return;
    }
    const existing = await broadcasts.getById(broadcastId);
    if (!existing) {
      res.status(404).json({ error: 'broadcast_not_found' });
      return;
    }
    try {
      await broadcasts.setSeedContactIds(broadcastId, seedContactIds);
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        res.status(409).json({ error: 'broadcast_not_draft' });
        return;
      }
      throw err;
    }
    res.status(200).json({ broadcastId, seedContactIds });
  });
```

Also add the method to the world fake the harness uses (follow how the fake implements `markSending` in `app/test/helpers/twilioWebhookHarness.ts`).

- [ ] **Step 4: GREEN** - both broadcast test files pass:
`npx vitest run test/broadcastApi.test.ts test/broadcastsRepo.integration.test.ts --root app`
- [ ] **Step 5: Commit**

```bash
git add app/src/repos/broadcastsRepo.ts app/src/routes/broadcasts.ts app/test/broadcastApi.test.ts app/test/broadcastsRepo.integration.test.ts app/test/helpers/twilioWebhookHarness.ts
git commit -m "feat(broadcasts): PATCH /api/broadcasts/:id persists hand-picked seedContactIds"
```

---

### Task 5: Dashboard API layer

**Files:**
- Modify: `dashboard/src/api/types.ts` (PreviewCandidate ~1581, PreviewResponse ~1599, BroadcastSummary ~1506, BroadcastResults ~1547)
- Modify: `dashboard/src/api/endpoints.ts` (createBroadcast ~986, new updateBroadcastSeeds)

**Interfaces:**
- Produces (consumed by Tasks 6-8, 11):
  - `PreviewCandidate.seeded: boolean`
  - `PreviewResponse.seedContactIds: string[]`, `PreviewResponse.unresolvedSeedIds: string[]`
  - `BroadcastSummary.audience_mode?: 'filter' | 'seeds_only'`, same on `BroadcastResults`
  - `createBroadcast(body: { unitId?: string; body_template: string; audience_filter?: AudienceFilter; seedContactIds?: string[] })` - note `audience_filter` becomes OPTIONAL - response type gains `flyerUrl?: string`
  - `updateBroadcastSeeds(broadcastId: string, seedContactIds: string[]): Promise<{ broadcastId: string; seedContactIds: string[] }>` - PATCH /api/broadcasts/:id

- [ ] **Step 1: Apply the type + endpoint changes** exactly as listed (this is a types/plumbing task; its test is the compiler plus the consumer tests in Tasks 6-8).

```ts
/** PATCH /api/broadcasts/:id - replace the draft's hand-picked seed list. */
export async function updateBroadcastSeeds(
  broadcastId: string,
  seedContactIds: string[],
): Promise<{ broadcastId: string; seedContactIds: string[] }> {
  return request(`/api/broadcasts/${encodeURIComponent(broadcastId)}`, {
    method: 'PATCH',
    body: { seedContactIds },
  });
}
```

(Match the file's existing request-helper call shape - check how `sendBroadcast` passes its body and mirror it exactly.)

- [ ] **Step 2: Verify** - `npm run typecheck` (bare) from the worktree root. Expected: green (composer still compiles because `audience_filter` went optional, not removed).
- [ ] **Step 3: Commit**

```bash
git add dashboard/src/api/types.ts dashboard/src/api/endpoints.ts
git commit -m "feat(api): seeded-recipient fields + updateBroadcastSeeds on the dashboard client"
```

---

### Task 6: Composer seeding - ?contactId=, seeds-only banner, property picker

**Files:**
- Modify: `dashboard/src/routes/broadcasts/BroadcastComposer.tsx`
- Modify: `dashboard/src/routes/broadcasts/useComposerDraft.ts`
- Test: `dashboard/src/routes/broadcasts/BroadcastComposer.test.tsx`

**Interfaces:**
- Consumes: `getContact(contactId, signal)` (endpoints.ts ~679), `UnitSearchField` + `UnitSearchValue` (`dashboard/src/routes/contact/UnitSearchField.tsx`; used exactly as `ScheduleTourForm.tsx:292-296` does: `value`, `onChange`, `candidates`, `inputLabel`), `getUnits({}, signal)`.
- Produces:
  - `ComposerDraftInput` becomes `{ unitId?: string; bodyTemplate: string; filter?: AudienceFilter; seedContactIds?: string[] }` - `filter` OPTIONAL (absent = seeds-only draft; `createBroadcast` body omits `audience_filter`).
  - `materialKey` covers all four inputs (a seed or filter-enable change recreates the draft, consistent with the existing recreate-on-change model).
  - Composer state: `audienceEnabled: boolean` (starts false iff seeded), `pickedUnit` via UnitSearchField when no ?unitId=.

- [ ] **Step 1: Write the failing tests** (in `BroadcastComposer.test.tsx`, following its existing `initialEntries=['/broadcasts/new?...']` render helper at ~line 49):

```tsx
it('?contactId= seeds the draft: createBroadcast gets seedContactIds and NO audience_filter', async () => {
  renderComposer('?contactId=c-seed'); // follow the file's helper naming
  await typeTemplate('Hi!');           // however the file drives the textarea
  await waitFor(() => expect(createBroadcast).toHaveBeenCalled());
  expect(createBroadcast.mock.calls.at(-1)?.[0]).toMatchObject({
    seedContactIds: ['c-seed'],
  });
  expect(createBroadcast.mock.calls.at(-1)?.[0]).not.toHaveProperty('audience_filter');
});

it('seeded entry shows the seeds-only banner; "Add more tenants by filters" enables the filter', async () => {
  renderComposer('?contactId=c-seed');
  expect(await screen.findByText(/Sending to/)).toBeInTheDocument();
  expect(screen.queryByRole('group', { name: /Insert a merge field/ })).not.toBeInTheDocument(); // resolved-mode is Task 7; here just assert AudienceFilters hidden:
  expect(screen.queryByLabelText('Housing authority')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Add more tenants by filters' }));
  expect(await screen.findByLabelText('Housing authority')).toBeInTheDocument();
});

it('no ?unitId= shows the Property picker; picking a unit flows into the draft', async () => {
  renderComposer('?contactId=c-seed');
  const picker = await screen.findByRole('combobox', { name: 'Property' });
  // drive UnitSearchField the way ScheduleTourForm tests do (type + pick option)
  // then:
  await waitFor(() =>
    expect(createBroadcast.mock.calls.at(-1)?.[0]).toMatchObject({ unitId: 'u-1' }),
  );
});
```

(Adapt the AudienceFilters field queries to the actual labels in `AudienceFilters.tsx` - the housing-authority input and voucher-size chips; assert on whichever label the file uses verbatim.)

- [ ] **Step 2: RED** - `npx vitest run src/routes/broadcasts/BroadcastComposer.test.tsx --root dashboard`

- [ ] **Step 3: Implement.**

`useComposerDraft.ts`:
- `ComposerDraftInput`: `filter?: AudienceFilter; seedContactIds?: string[]`.
- `materialKey`: add `s: input.seedContactIds?.join(',') ?? null` and encode filter as `f: input.filter === undefined ? null : { h: ..., s: ... }`.
- create call:

```ts
        const created = await createBroadcast({
          ...(unitId !== undefined && { unitId }),
          body_template: input.bodyTemplate,
          ...(input.filter !== undefined && { audience_filter: input.filter }),
          ...(input.seedContactIds !== undefined &&
            input.seedContactIds.length > 0 && { seedContactIds: input.seedContactIds }),
        });
```

- Also surface the new `flyerUrl` from the response in the hook's returned state (`flyerUrl: string | null`) for Task 7.

`BroadcastComposer.tsx`:

```tsx
  const seedContactId = params.get('contactId') ?? undefined;
  const seedContactIds = useMemo(
    () => (seedContactId !== undefined ? [seedContactId] : []),
    [seedContactId],
  );
  const [audienceEnabled, setAudienceEnabled] = useState(seedContactIds.length === 0);
  const [seedContact, setSeedContact] = useState<Contact | null>(null);
  // resolve the seeded tenant for the banner (and Task 7's resolved mode)
  useEffect(() => {
    if (seedContactId === undefined) return;
    const controller = new AbortController();
    getContact(seedContactId, controller.signal)
      .then(setSeedContact)
      .catch(() => setSeedContact(null)); // banner falls back to the raw id; preview reports unresolved
    return () => controller.abort();
  }, [seedContactId]);

  // Property picker when the entry did not fix a unit
  const [unitCandidates, setUnitCandidates] = useState<UnitItem[]>([]);
  const [unitPick, setUnitPick] = useState<UnitSearchValue>({ label: '' });
  const effectiveUnitId = unitId ?? unitPick.unitId;
  useEffect(() => {
    if (unitId !== undefined) return; // fixed by the entry point
    const controller = new AbortController();
    getUnits({}, controller.signal)
      .then((page) => setUnitCandidates(page.units))
      .catch(() => {});
    return () => controller.abort();
  }, [unitId]);
```

- Every existing use of `unitId` for unit-loading/prefill switches to `effectiveUnitId` (the `getUnit` effect, `propertyLabel`, bedroomSize prefill).
- Draft wiring: `useComposerDraft({ ...(effectiveUnitId !== undefined && { unitId: effectiveUnitId }), bodyTemplate, ...(audienceEnabled && { filter }), ...(seedContactIds.length > 0 && { seedContactIds }) })`.
- Compose-step left column:

```tsx
  {seedContactIds.length > 0 && !audienceEnabled ? (
    <div className={styles.seedBanner}>
      <p>
        Sending to <strong>{seedContact ? contactDisplayName(seedContact) : seedContactId}</strong>.
      </p>
      <button type="button" onClick={() => setAudienceEnabled(true)}>
        Add more tenants by filters
      </button>
    </div>
  ) : (
    <AudienceFilters ... existing props ... />
  )}
  {unitId === undefined ? (
    <label>
      <span>Property</span>
      <UnitSearchField value={unitPick} onChange={setUnitPick} candidates={unitCandidates} inputLabel="Property" />
    </label>
  ) : null}
```

(Use the existing `contactDisplayName` helper the contact routes use; add a `.seedBanner` class to `BroadcastComposer.module.css` styled like the module's existing panels.)

- [ ] **Step 4: GREEN** - `npx vitest run src/routes/broadcasts/BroadcastComposer.test.tsx --root dashboard` and the untouched suites: `npx vitest run src/routes/broadcasts --root dashboard`.
- [ ] **Step 5: Commit**

```bash
git add dashboard/src/routes/broadcasts/BroadcastComposer.tsx dashboard/src/routes/broadcasts/BroadcastComposer.module.css dashboard/src/routes/broadcasts/useComposerDraft.ts dashboard/src/routes/broadcasts/BroadcastComposer.test.tsx
git commit -m "feat(composer): ?contactId= seeding, seeds-only banner, property picker"
```

---

### Task 7: Resolved message mode at exactly one recipient

**Files:**
- Create: `dashboard/src/routes/broadcasts/resolveTemplate.ts`
- Create: `dashboard/src/routes/broadcasts/resolveTemplate.test.ts`
- Modify: `dashboard/src/routes/broadcasts/MessageEditor.tsx` (+ its test), `dashboard/src/routes/broadcasts/BroadcastComposer.tsx` (+ its test)

**Interfaces:**
- Produces:
  - `DEFAULT_SEND_TEMPLATE` (the string currently used as the MessageEditor placeholder at MessageEditor.tsx:76 - move it here and import it there).
  - `resolveTemplateForTenant(template: string, unit: UnitItem | null, firstName: string | undefined, flyerLink: string | undefined): string` - literal token replacement mirroring `app/src/lib/mergeFields.ts` (TenantName fallback 'there'; Beds/Address/Rent from the unit; FlyerLink from the argument; unresolvable tokens replace to '').
  - `MessageEditorProps.resolved?: boolean` - when true, hide the merge-chip row and the flyer note (the text IS the message).
- Resolved-mode rules (composer):
  - Active iff `seedContactIds.length === 1 && !audienceEnabled`.
  - Flyer link: prefer `draft.flyerUrl` (server truth from Task 1); until the first draft exists fall back to the same-origin funnel `${window.location.origin}/p/<unitId>` (the blessed pattern from ListingDetail.tsx:151-161).
  - The editor body auto-seeds with the resolved DEFAULT_SEND_TEMPLATE when (a) resolved mode is active, (b) a unit is attached, and (c) the staff user has not manually edited the body (track `bodyEdited` set true on the first keystroke). Re-seeds on unit change while unedited.
  - Crossing the boundary (enabling filters, or adding a second seed later) with `bodyEdited === true` asks `window.confirm('Switching the audience resets the message to the template. Discard your edits?')` - on cancel, the toggle does not proceed; on confirm, body resets ('' in token mode; re-resolved default in resolved mode).

- [ ] **Step 1: Write the failing tests** - `resolveTemplate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveTemplateForTenant, DEFAULT_SEND_TEMPLATE } from './resolveTemplate.js';

const UNIT = {
  unitId: 'u1', beds: 2, address: '44 Clifton Rd NE, Atlanta, GA 30307',
  rent_min: 1600, rent_max: 1600,
} as never; // cast to UnitItem in the real test via a helper matching the file's conventions

describe('resolveTemplateForTenant', () => {
  it('resolves every token for a known tenant + unit + link', () => {
    const out = resolveTemplateForTenant(DEFAULT_SEND_TEMPLATE, UNIT, 'Brianna', 'https://x/p/u1');
    expect(out).toContain('Hi Brianna,');
    expect(out).toContain('2 BR home'); // adjust to the exact Beds phrasing chosen below
    expect(out).toContain('44 Clifton Rd NE');
    expect(out).toContain('$1,600/mo'.replace(',', '')); // match rentText output exactly
    expect(out).toContain('https://x/p/u1');
  });
  it('falls back to "there" with no first name and drops unit tokens with no unit', () => {
    const out = resolveTemplateForTenant(DEFAULT_SEND_TEMPLATE, null, undefined, undefined);
    expect(out).toContain('Hi there,');
    expect(out).not.toContain('[Beds]');
    expect(out).not.toContain('[FlyerLink]');
  });
});
```

Composer test additions: resolved mode shows no merge chips; typing then clicking "Add more tenants by filters" fires the confirm (mock `window.confirm`).

- [ ] **Step 2: RED** - `npx vitest run src/routes/broadcasts/resolveTemplate.test.ts src/routes/broadcasts/BroadcastComposer.test.tsx --root dashboard`

- [ ] **Step 3: Implement** `resolveTemplate.ts` (server parity: see `app/src/lib/mergeFields.ts:81-96` - literal replaces, `[Beds]` = String(beds), `[Rent]` = `$min-$max` or `$value` when equal, `[TenantName]` fallback 'there'):

```ts
import type { UnitItem } from '../../api/index.js';

export const DEFAULT_SEND_TEMPLATE =
  'Hi [TenantName], a [Beds] home at [Address] is available for [Rent]/mo. Details: [FlyerLink]';

const NEUTRAL_TENANT_NAME = 'there';

function rentText(unit: UnitItem): string {
  const min = typeof unit.rent_min === 'number' ? unit.rent_min : undefined;
  const max = typeof unit.rent_max === 'number' ? unit.rent_max : undefined;
  if (min !== undefined && max !== undefined && max !== min) return `$${min}-$${max}`;
  const v = min ?? max;
  return v !== undefined ? `$${v}` : '';
}

function tokenRegex(token: string): RegExp {
  return new RegExp(token.replace(/[[\]]/g, '\\$&'), 'g');
}

/** Client-side mirror of the backend's renderBody (mergeFields.ts) so the
 *  single-recipient editor can show EXACTLY what will send. Unresolvable
 *  tokens become '' (same as the backend with no unit). */
export function resolveTemplateForTenant(
  template: string,
  unit: UnitItem | null,
  firstName: string | undefined,
  flyerLink: string | undefined,
): string {
  const name = firstName !== undefined && firstName.trim().length > 0 ? firstName.trim() : NEUTRAL_TENANT_NAME;
  return template
    .replace(tokenRegex('[TenantName]'), name)
    .replace(tokenRegex('[Beds]'), unit && typeof unit.beds === 'number' ? String(unit.beds) : '')
    .replace(tokenRegex('[Address]'), unit && typeof unit.address === 'string' ? unit.address : '')
    .replace(tokenRegex('[Rent]'), unit ? rentText(unit) : '')
    .replace(tokenRegex('[FlyerLink]'), flyerLink ?? '');
}
```

(Before finalizing `[Address]`: check what `UnitItem.address` is on the client - if the codebase formats it via a helper like `shortAddress`, use the same full-address accessor the flyer/property pages display; match ONE existing accessor rather than inventing formatting. Update the test expectation accordingly.)

MessageEditor: add `resolved?: boolean`; when true skip the chips `<div role="group">` and the propertyLabel flyer note; keep the counter.

Composer: mode condition + auto-seed effect + confirm-on-boundary as specified in Interfaces; pass `resolved={resolvedMode}` to MessageEditor.

- [ ] **Step 4: GREEN** - `npx vitest run src/routes/broadcasts --root dashboard`
- [ ] **Step 5: Commit**

```bash
git add dashboard/src/routes/broadcasts/resolveTemplate.ts dashboard/src/routes/broadcasts/resolveTemplate.test.ts dashboard/src/routes/broadcasts/MessageEditor.tsx dashboard/src/routes/broadcasts/MessageEditor.test.tsx dashboard/src/routes/broadcasts/BroadcastComposer.tsx dashboard/src/routes/broadcasts/BroadcastComposer.test.tsx
git commit -m "feat(composer): resolved-text message mode for single-recipient sends"
```

---

### Task 8: RecipientPreview - seeded rows pre-checked, hand-picks persisted, unresolved notice

**Files:**
- Modify: `dashboard/src/routes/broadcasts/RecipientPreview.tsx` (initialRows ~53-65, addTenant, banner area)
- Test: `dashboard/src/routes/broadcasts/RecipientPreview.test.tsx`

**Interfaces:**
- Consumes: `PreviewCandidate.seeded`, `PreviewResponse.seedContactIds` / `.unresolvedSeedIds` (Task 5), `updateBroadcastSeeds` (Task 5).

- [ ] **Step 1: Write the failing tests** (use the file's `candidate()`/`previewOf()`/`renderPreview()` factories):

```tsx
it('a seeded candidate is pre-checked even when alreadySentThisProperty', () => {
  renderPreview({
    preview: previewOf({
      candidates: [candidate({ contactId: 'c1', seeded: true, alreadySentThisProperty: true })],
      seedContactIds: ['c1'],
    }),
  });
  expect(screen.getByRole('checkbox')).toBeChecked();
});

it('adding a tenant persists it to the draft seeds (best-effort PATCH)', async () => {
  renderPreview({ preview: previewOf({ seedContactIds: ['c1'] }), tenantCandidates: [tenant({ contactId: 'cX', firstName: 'Added' })] });
  // drive the existing Add-a-tenant combobox exactly like the "sends ONLY the checked ids" test (~line 347)
  await waitFor(() =>
    expect(updateBroadcastSeeds).toHaveBeenCalledWith('bcast_1', ['c1', 'cX']),
  );
});

it('shows a count-based notice when preview reports unresolved seeds', () => {
  renderPreview({ preview: previewOf({ unresolvedSeedIds: ['ghost'] }) });
  expect(screen.getByText(/1 added tenant can't receive texts/)).toBeInTheDocument();
});
```

(Mock `updateBroadcastSeeds` in the existing `vi.mock('../../api/index.js', ...)` block. Match the notice apostrophe to the copy you implement.)

- [ ] **Step 2: RED** - `npx vitest run src/routes/broadcasts/RecipientPreview.test.tsx --root dashboard`

- [ ] **Step 3: Implement.**
- `initialRows`: `checked: c.has_consent && (c.seeded || !c.alreadySentThisProperty)`.
- Keep a `seedsRef = useRef<string[]>(preview.seedContactIds)`; in the existing add-tenant handler, after the row is added: `seedsRef.current = [...seedsRef.current, added.contactId]; void updateBroadcastSeeds(draftId, seedsRef.current).catch(() => {});` (best-effort - a failure never blocks the review).
- Notice (above the candidate list) when `preview.unresolvedSeedIds.length > 0`:

```tsx
  <p className={styles.seedNotice} role="status">
    {preview.unresolvedSeedIds.length === 1
      ? "1 added tenant can't receive texts (unknown, opted out, or unreachable) and was left out."
      : `${preview.unresolvedSeedIds.length} added tenants can't receive texts (unknown, opted out, or unreachable) and were left out.`}
  </p>
```

(Use the module's existing note styling; add `.seedNotice` to `RecipientPreview.module.css`.)

- [ ] **Step 4: GREEN** - `npx vitest run src/routes/broadcasts/RecipientPreview.test.tsx --root dashboard`
- [ ] **Step 5: Commit**

```bash
git add dashboard/src/routes/broadcasts/RecipientPreview.tsx dashboard/src/routes/broadcasts/RecipientPreview.module.css dashboard/src/routes/broadcasts/RecipientPreview.test.tsx
git commit -m "feat(review): seeded rows pre-checked, hand-picks persisted, unresolved-seed notice"
```

---

### Task 9: Tenant-file entry point

**Files:**
- Modify: `dashboard/src/routes/contact/TenantFile.tsx` (props ~40-69; Properties sent card ~188-208)
- Modify: `dashboard/src/routes/contact/ContactDetail.tsx` (TenantFile render ~587-603)
- Test: `dashboard/src/routes/contact/files.test.tsx` (TenantFile card behavior lives here)

**Interfaces:**
- Produces: `TenantFileProps.onSendProperty?: () => void`.
- ContactDetail wires: `onSendProperty={() => navigate(`/broadcasts/new?contactId=${encodeURIComponent(contact.contactId)}`)}`.

- [ ] **Step 1: Write the failing test** (mirror how files.test.tsx asserts the Tours card's "+ Schedule"):

```tsx
it('Properties sent card shows "+ Send" and fires onSendProperty', async () => {
  const onSendProperty = vi.fn();
  renderTenantFile({ onSendProperty }); // follow the file's existing render helper
  await userEvent.click(screen.getByRole('button', { name: 'Send a property to this tenant' }));
  expect(onSendProperty).toHaveBeenCalled();
});

it('Properties sent keeps its count visible next to the action', () => {
  const send = (unitId: string) => ({
    unitId,
    contactId: 'c1',
    via: 'broadcast',
    response: 'no_reply',
    sentAt: '2026-07-01T12:00:00.000Z',
  });
  renderTenantFile({ onSendProperty: vi.fn(), listingsSent: [send('u1'), send('u2')] });
  expect(screen.getByRole('heading', { name: 'Properties sent (2)' })).toBeInTheDocument();
});
// (Match the row shape to the ListingSendRow type files.test.tsx already uses
// for the Properties sent card; reuse its existing fixture builder if one exists.)
```

- [ ] **Step 2: RED** - `npx vitest run src/routes/contact/files.test.tsx --root dashboard`
- [ ] **Step 3: Implement** (mirror the Tours card at TenantFile.tsx:210-218):

```tsx
      <Card
        title={listingsSent.length > 0 ? `Properties sent (${listingsSent.length})` : 'Properties sent'}
        aside={
          onSendProperty ? (
            <CardAction onClick={onSendProperty} label="Send a property to this tenant">
              + Send
            </CardAction>
          ) : listingsSent.length > 0 ? (
            String(listingsSent.length)
          ) : undefined
        }
      >
```

And in ContactDetail.tsx add the prop next to `onScheduleTour` (line ~602):

```tsx
          onSendProperty={() => navigate(`/broadcasts/new?contactId=${encodeURIComponent(contact.contactId)}`)}
```

- [ ] **Step 4: GREEN** - `npx vitest run src/routes/contact/files.test.tsx src/routes/contact/ContactDetail.test.tsx --root dashboard`
- [ ] **Step 5: Commit**

```bash
git add dashboard/src/routes/contact/TenantFile.tsx dashboard/src/routes/contact/ContactDetail.tsx dashboard/src/routes/contact/files.test.tsx
git commit -m "feat(tenant-file): + Send on Properties sent opens the seeded composer"
```

---

### Task 10: Property-page entry point + relabels

**Files:**
- Modify: `dashboard/src/routes/listing/ListingDetail.tsx` (Sent to tenants card ~443; kebab wiring ~226-237)
- Modify: `dashboard/src/routes/listing/ListingActionsMenu.tsx` (menu item label line 107 + onBroadcast doc-comment line 16)
- Modify: `dashboard/src/routes/listing/listingFormat.ts:104` (activity label)
- Test: `dashboard/src/routes/listing/ListingDetail.test.tsx` (lines ~434-444), `dashboard/src/routes/listing/listingFormat.test.ts` (lines ~167-176)

**Interfaces:**
- The card action navigates to the SAME URL the kebab uses: `/broadcasts/new?unitId=<unitId>`.
- New copy: kebab menuitem `Send to tenants` (was `Broadcast to tenants`); activity label `Sent to N tenant(s)` (was `Broadcast to N tenant(s)`).

- [ ] **Step 1: Update/extend the tests first** - change the ListingDetail.test.tsx menuitem assertions from the old label to `Send to tenants`; change listingFormat.test.ts expectations to `Sent to 1 tenant` / `Sent to 2 tenants`; add:

```tsx
it('Sent to tenants card has a "+ Send" action that opens the composer for this property', async () => {
  renderListing(); // file's existing helper
  await userEvent.click(screen.getByRole('button', { name: 'Send this property to tenants' }));
  expect(screen.getByTestId('path')).toHaveTextContent('/broadcasts/new?unitId=u1');
});
```

- [ ] **Step 2: RED** - `npx vitest run src/routes/listing --root dashboard`
- [ ] **Step 3: Implement.**
- ListingDetail: extract the navigate into a shared callback and use it for both the kebab `onBroadcast` and the card:

```tsx
  const goToSend = (): void => navigate(`/broadcasts/new?unitId=${encodeURIComponent(unit.unitId)}`);
```

Card (replace the static aside string at line 443):

```tsx
          <Card
            title="Sent to tenants"
            aside={
              !deleted ? (
                <CardAction onClick={goToSend} label="Send this property to tenants">
                  + Send
                </CardAction>
              ) : (
                'recipients + responses'
              )
            }
          >
```

(Import `Card`/`CardAction` the way this file already imports its Card primitives - check the top of the file; ListingDetail has its own Card import.)
- ListingActionsMenu.tsx:107: label text becomes `Send to tenants`.
- listingFormat.ts:104: label becomes `` `Sent to ${n} ${n === 1 ? 'tenant' : 'tenants'}` ``.

- [ ] **Step 4: GREEN** - `npx vitest run src/routes/listing --root dashboard`
- [ ] **Step 5: Commit**

```bash
git add dashboard/src/routes/listing/ListingDetail.tsx dashboard/src/routes/listing/ListingActionsMenu.tsx dashboard/src/routes/listing/listingFormat.ts dashboard/src/routes/listing/ListingDetail.test.tsx dashboard/src/routes/listing/listingFormat.test.ts
git commit -m "feat(property): + Send entry on Sent to tenants; Broadcast copy becomes Send"
```

---

### Task 11: The Matching rename sweep

**Files:**
- Modify: `dashboard/src/app/nav.ts:78`; `dashboard/src/routes/broadcasts/BroadcastsList.tsx` (lines 64, 82, 90, 94, 113, 122, 124, 131); `dashboard/src/routes/broadcasts/BroadcastComposer.tsx:148`; `dashboard/src/routes/broadcasts/BroadcastResults.tsx` (99, 101, 106, 123); `dashboard/src/routes/broadcasts/RecipientPreview.tsx:195`; `dashboard/src/routes/broadcasts/broadcastFormat.ts` (new helper)
- Test: `dashboard/src/app/AppFrame.test.tsx:75`, `dashboard/src/routes/broadcasts/BroadcastsList.test.tsx`, `dashboard/src/routes/broadcasts/BroadcastResults.test.tsx:162`

Copy map (old -> new; identifiers and URLs untouched). Lines whose existing text contains non-ASCII characters (arrow, curly quotes, ellipsis) keep those characters - edit only the words:

| Location | New copy |
| --- | --- |
| nav.ts:78 label | `Matching` |
| BroadcastsList.tsx:82 h1 | `Matching` |
| BroadcastsList.tsx:90 button | `Send a property` |
| BroadcastsList.tsx:94 aria-label | `Send status filter` |
| BroadcastsList.tsx:113 error | `We couldn't load your sends.` (match the file's apostrophe character) |
| BroadcastsList.tsx:122 empty title | `No sends yet` |
| BroadcastsList.tsx:124 empty body | `Start one from a property's "Send to tenants", from a tenant's "Properties sent", or with "Send a property".` (keep the line's existing quote characters) |
| BroadcastsList.tsx:131 list aria-label | `Property sends` |
| BroadcastsList.tsx:64 delete-409 | `This send already started, so it can no longer be deleted.` |
| BroadcastComposer.tsx:148 h1 | `Send a property` |
| BroadcastResults.tsx:99 | `This send doesn't exist (it may have been deleted).` |
| BroadcastResults.tsx:101 | `Back to Matching` |
| BroadcastResults.tsx:106 | `We couldn't load this send.` |
| BroadcastResults.tsx:123 back link | keep the existing arrow character, text `Matching` |
| RecipientPreview.tsx:195 send-409 | `This send already went out (or is sending).` |

Also, seeds_only reach copy: in `broadcastFormat.ts` add

```ts
/** Reach line for a seeds-only send, where the audience filter says nothing. */
export function sendReachLabel(count: number): string {
  return `To ${count} ${count === 1 ? 'tenant' : 'tenants'}`;
}
```

and in BroadcastsList row rendering + BroadcastResults header, use it instead of `audienceSummary(filter)` when `audience_mode === 'seeds_only'` (count = `stats.audience`).

- [ ] **Step 1: Update the unit tests first** (RED): AppFrame.test.tsx:75 `['Inbox', 'Matching']`; BroadcastsList.test.tsx - button name `Send a property` (~108), empty text `No sends yet` (81/106/151), list/tablist names (`Property sends` / `Send status filter`); BroadcastResults.test.tsx:162 link `/Back to Matching/i`; add one `sendReachLabel` test in `broadcastFormat.test.ts`.
- [ ] **Step 2: RED** - `npx vitest run src/app src/routes/broadcasts --root dashboard`
- [ ] **Step 3: Apply the copy map + helper.**
- [ ] **Step 4: GREEN** - same command; then sweep for stragglers: `rg -n "roadcast" dashboard/src --glob '!*.test.*'` and confirm every remaining hit is an identifier, import, comment, or URL (NOT rendered copy).
- [ ] **Step 5: Commit**

```bash
git add dashboard/src/app/nav.ts dashboard/src/app/AppFrame.test.tsx dashboard/src/routes/broadcasts
git commit -m "feat(matching): rename the Broadcasts surface to Matching (copy only)"
```

---

### Task 12: Glossary entry

**Files:**
- Modify: `documentation/GLOSSARY.md` - replace the stale `**"Share Properties"**` bullet (lines ~117-121, which documents a label the UI no longer shows) under `## Feature & label notes`.

- [ ] **Step 1: Replace the bullet with** (plain ASCII):

```markdown
- **"Matching"** - the staff dashboard section for sending properties to tenants,
  one-to-one or one-to-many (nav item, list page). One item is a "send" or
  "property send"; the primary action is "Send a property"; a property page
  offers "Send to tenants". Replaces the earlier on-screen label "Broadcasts"
  (and the still-earlier "Share Properties" note that had drifted from the UI).
  Internal identifiers are unchanged: the `broadcast` entity, `/broadcasts`
  routes, jobs, tables, and log fields all keep their names - only displayed
  copy follows the audience rule.
```

- [ ] **Step 2: Verify ASCII** - `tr -d '\11\12\15\40-\176' < documentation/GLOSSARY.md | wc -c` must not INCREASE versus before the edit (the file may already contain non-ASCII elsewhere; your added lines must be pure ASCII).
- [ ] **Step 3: Commit**

```bash
git add documentation/GLOSSARY.md
git commit -m "docs(glossary): Matching / property send <-> broadcast* mapping"
```

---

### Task 13: e2e - update renamed copy, cover both entry points, full gates

**Files:**
- Modify: `e2e/scenarios/steps.ts` (655-657: menuitem `Send to tenants`, heading `Send a property`)
- Modify: `e2e/tests/dashboard-next/broadcasts.spec.ts` (106, 108, 333: same relabels), `e2e/tests/dashboard-next/a2p-compliance.spec.ts:358`, `e2e/tests/dashboard-next/frame.spec.ts:29` (`'Matching'`), `e2e/tests/dashboard-next/landlord-activity.spec.ts:121` + `e2e/tests/dashboard-next/listing-activity.spec.ts:142` (`/Sent to 2 tenants/`)
- Create: `e2e/tests/dashboard-next/matching-entry-points.spec.ts`

**Interfaces:**
- Consumes: dev-login + outbox helpers exactly as `broadcasts.spec.ts` uses them; accessibility-first selectors per `e2e/support/selectors.md`.

- [ ] **Step 1: Apply the copy updates** to the five existing files (mechanical; the selectors are listed above with lines).

- [ ] **Step 2: Write the new spec** (shape below; reuse broadcasts.spec.ts's login/seed conventions verbatim - same fixtures, same outbox assertion helper):

```ts
test('tenant-file + Send: seeded 1:1 send lands in the outbox and on the card', async ({ page }) => {
  // 1. dev-login; open a seeded consenting tenant's contact page (use the same
  //    tenant broadcasts.spec.ts targets).
  // 2. Click the "Properties sent" card button: getByRole('button', { name: 'Send a property to this tenant' }).
  // 3. Expect heading 'Send a property'; expect text /Sending to/.
  // 4. Pick a property via getByRole('combobox', { name: 'Property' }) (type the
  //    seeded unit's address, pick the option).
  // 5. The message textarea now contains resolved text (expect it to contain 'Hi '
  //    and '/p/' - no '[TenantName]').
  // 6. Preview recipients -> exactly one pre-checked row -> click /^Send to/.
  // 7. Assert the dev outbox gained exactly ONE message to the tenant's phone
  //    containing '/p/<unitId>'.
  // 8. Navigate back to the contact page: the "Properties sent" card now lists the unit.
});

test('property-page + Send: hand-picked single recipient', async ({ page }) => {
  // 1. dev-login; open the seeded unit's property page.
  // 2. Click getByRole('button', { name: 'Send this property to tenants' }).
  // 3. Expect heading 'Send a property' (composer, unit context, filters visible).
  // 4. Type a template; Preview recipients; uncheck all; add one tenant via the
  //    'Add a tenant' combobox; click /^Send to 1 tenant/.
  // 5. Assert outbox got exactly one message to that tenant; property page's
  //    "Sent to tenants" card lists them.
});
```

- [ ] **Step 3: Run the e2e suite** (bare): `npm run e2e`
Expected: all pass including the two new tests.
- [ ] **Step 4: Full gates** (bare, from the worktree root): `npm run typecheck` then `npm test` then `npm run e2e`. All green.
- [ ] **Step 5: Sync main** - `git merge main` (resolve keeping both sides' intent), re-run all three gates green on the merged base.
- [ ] **Step 6: Commit**

```bash
git add e2e
git commit -m "test(e2e): Matching entry points + renamed copy"
```

---

## Definition of done

- All 13 tasks committed on feat/matching-property-sends.
- Full gates green on a base synced with current main: `npm run typecheck`, `npm test`, `npm run e2e` (run bare).
- Live self-QA in an e2e session (npm run e2e:session + Playwright MCP): drive BOTH entry points by hand, screenshot the seeded composer and the sent result, confirm no user-visible "Broadcast" copy remains (spot-check nav, list, composer, results, property kebab).
- No merge to main without explicit approval.
