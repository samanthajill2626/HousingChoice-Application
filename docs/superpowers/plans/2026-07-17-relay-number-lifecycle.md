# Relay Number Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One pool number hosts many participant-disjoint relay groups (permanent
(number, person) burn), inbound routes on (To, From) with closed-group texts
intercepted into the sender's 1:1, nothing auto-closes (inline ask + 28-day
Today nag + final catalog message), and idle numbers release to Twilio after a
180-day grace, behind a config gate.

**Architecture:** The burn set on the pool record IS the claim (one conditional
UpdateItem enforces the invariant race-free). pool_number never clears off a
conversation, so byPoolNumber becomes a multi-match index and the webhook
resolves open-roster -> relay, closed-roster -> 1:1-with-provenance. Close
becomes a human choice surfaced at outcome recording and on Today.

**Tech Stack:** Express + DynamoDB (lib-dynamodb) + vitest/supertest (app),
React + testing-library (dashboard), Playwright (e2e).

## Global Constraints

- Spec: docs/superpowers/specs/2026-07-17-relay-number-lifecycle-design.md - APPROVED; deviations stop-and-report.
- ASCII only in every added line (`tr -d '\11\12\15\40-\176' < FILE | wc -c` -> 0).
- Phone numbers are PII: log states/counts/IDs, never a number (existing repo/service convention).
- New automated copy ONLY via the message catalog (app/src/messages/catalog.ts).
- NO migration scripts; seeds emit the new shape natively (spec section 6).
- Gates after each task: `npm run typecheck` + the touched workspace's tests, bare, from /w/tmp/relay-number-lifecycle. e2e deferred to Task 8.
- Commit per task, explicit paths, gating `git status` read first.
- 28-day nag constant; 180-day release constant; both named exports (no magic numbers inline).

## File structure (decomposition)

- `app/src/repos/poolNumbersRepo.ts` - REWRITE: states active|released; burned_phones set; burnClaim; noteGroupClosed; listActive; releaseNumber. Quarantine/claim/reassign/reclaimExpired DELETED.
- `app/src/services/poolNumbers.ts` - REWRITE: provisionForGroup(rosterPhones,...) burn-as-claim ladder; retireEligible sweep; RELAY_NUMBER_RELEASE_ENABLED gate.
- `app/src/adapters/messaging.ts` - ADD releasePhoneNumber to the adapter interface + twilio impl + console no-op.
- `app/src/lib/config.ts` - ADD relayNumberReleaseEnabled.
- `app/src/repos/conversationsRepo.ts` - getAllByPoolNumber (multi); setRelayStatus keeps pool_number; close_nag_next_at helpers.
- `app/src/services/relayProvisioning.ts` - pass roster phones to provisionForGroup; drop assignConversation stamping.
- `app/src/routes/webhooks/twilio.ts` - (To,From) resolution; closed->1:1 provenance; echo-guard update.
- `app/src/routes/relayGroups.ts` - close: final message + nag clear + last-close stamp, NO release; reopen: same number, no provisioning; keep-open nag endpoint.
- `app/src/services/placementRelayLifecycle.ts` + its statusTransition hook - DELETED (replaced by the ask).
- `app/src/services/relayAnnouncements.ts` - gate on status==='open'.
- `app/src/messages/catalog.ts` - relay.group_closed entry.
- `app/src/routes/today.ts` - relay-close-nag items + keep-open action route (in relayGroups.ts).
- `app/src/lib/seed/*` - seeded relay groups/pool records emit burned_phones + active.
- dashboard: today nag card (buildToday.ts/Today.tsx), inline ask dialogs (TourModals.tsx / TourDetail.tsx / placement status UI), via_closed_group timeline badge, relayGroupsApi close/keep-open.
- e2e: `e2e/tests/dashboard-next/relay-number-lifecycle.spec.ts` (new) + updates where relay close is already exercised.

---

### Task 1: Pool repo rewrite - burn model

**Files:**
- Modify: `app/src/repos/poolNumbersRepo.ts` (full rewrite of states/methods)
- Test: `app/test/poolNumbersRepo.test.ts` (extend/rework existing)

**Interfaces:**
- Produces (consumed by Tasks 2-3):

```ts
export type PoolNumberLifecycleState = 'active' | 'released';
export const RELEASE_GRACE_MS = 180 * 24 * 60 * 60 * 1000; // 180 days
export interface PoolNumberItem {
  poolNumber: string;
  lifecycle_state: PoolNumberLifecycleState;
  /** GSI RANGE placeholder retained so byLifecycleState keeps indexing (see step note). */
  quarantine_until: string; // stays the '0000-..' sentinel on every item
  voice_capable: boolean;
  sms_capable: boolean;
  provisioned_via?: 'console' | 'twilio';
  /** Every E.164 ever rostered on this number. DynamoDB string set (may be absent when brand new). */
  burned_phones?: Set<string> | string[];
  /** Monotonic max of group-close times on this number. */
  last_group_closed_at?: string;
  placement_tag?: string;
  provisioned_at: string;
  released_at?: string;
  [key: string]: unknown;
}
export interface PoolNumbersRepo {
  get(poolNumber: string): Promise<PoolNumberItem | undefined>;
  /** Create ACTIVE with burned_phones seeded from `burn` (roster of the first group). */
  create(input: { poolNumber: string; voiceCapable: boolean; smsCapable: boolean; provisionedVia?: 'console'|'twilio'; burn: string[]; tag?: string }): Promise<PoolNumberItem>;
  /** All active numbers (paged Query on byLifecycleState 'active'). */
  listActive(): Promise<PoolNumberItem[]>;
  /** THE atomic burn-as-claim. ADDs phones to burned_phones conditional on NONE being present already (and lifecycle_state='active'). Returns updated item, or undefined on condition failure (overlap or not active). */
  burnClaim(poolNumber: string, phones: string[], tag?: string): Promise<PoolNumberItem | undefined>;
  /** Stamp last_group_closed_at = max(existing, closedAt). Never throws on missing record (logged). */
  noteGroupClosed(poolNumber: string, closedAt: string): Promise<void>;
  /** active -> released (+released_at), conditional on active. Idempotent-tolerant: condition failure returns undefined. */
  releaseNumber(poolNumber: string): Promise<PoolNumberItem | undefined>;
}
```

- [ ] **Step 1: Write the failing tests** - extend `app/test/poolNumbersRepo.test.ts` (it already has a DynamoDB-local harness pattern; follow the file's existing setup). New describe:

```ts
describe('poolNumbersRepo - burn model', () => {
  it('create seeds burned_phones from the first roster and lands active', async () => {
    const item = await repo.create({ poolNumber: '+15550100001', voiceCapable: true, smsCapable: true, provisionedVia: 'console', burn: ['+15551110001', '+15551110002'] });
    expect(item.lifecycle_state).toBe('active');
    expect([...(await repo.get('+15550100001'))!.burned_phones as Set<string>].sort())
      .toEqual(['+15551110001', '+15551110002']);
  });

  it('burnClaim adds a disjoint roster and returns the item', async () => {
    await repo.create({ poolNumber: '+15550100002', voiceCapable: true, smsCapable: true, provisionedVia: 'console', burn: ['+15551110001'] });
    const claimed = await repo.burnClaim('+15550100002', ['+15551110003', '+15551110004']);
    expect(claimed).toBeDefined();
  });

  it('burnClaim REFUSES any overlap - even one phone', async () => {
    await repo.create({ poolNumber: '+15550100003', voiceCapable: true, smsCapable: true, provisionedVia: 'console', burn: ['+15551110001', '+15551110002'] });
    expect(await repo.burnClaim('+15550100003', ['+15551110009', '+15551110002'])).toBeUndefined();
    // And the non-overlapping phone was NOT partially added (atomicity):
    const after = await repo.get('+15550100003');
    expect([...(after!.burned_phones as Set<string>)]).not.toContain('+15551110009');
  });

  it('burnClaim races: two overlapping claims on one number - exactly one wins', async () => {
    await repo.create({ poolNumber: '+15550100004', voiceCapable: true, smsCapable: true, provisionedVia: 'console', burn: ['+15551119999'] });
    const [a, b] = await Promise.all([
      repo.burnClaim('+15550100004', ['+15551110005', '+15551110006']),
      repo.burnClaim('+15550100004', ['+15551110006', '+15551110007']), // shares ...0006
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('burnClaim refuses a released number', async () => {
    await repo.create({ poolNumber: '+15550100005', voiceCapable: true, smsCapable: true, provisionedVia: 'console', burn: ['+15551110001'] });
    await repo.releaseNumber('+15550100005');
    expect(await repo.burnClaim('+15550100005', ['+15551119998'])).toBeUndefined();
  });

  it('noteGroupClosed keeps the max timestamp', async () => {
    await repo.create({ poolNumber: '+15550100006', voiceCapable: true, smsCapable: true, provisionedVia: 'console', burn: ['+15551110001'] });
    await repo.noteGroupClosed('+15550100006', '2026-07-01T00:00:00.000Z');
    await repo.noteGroupClosed('+15550100006', '2026-06-01T00:00:00.000Z'); // older - must not regress
    expect((await repo.get('+15550100006'))!.last_group_closed_at).toBe('2026-07-01T00:00:00.000Z');
  });

  it('releaseNumber flips active->released once; second call returns undefined', async () => {
    await repo.create({ poolNumber: '+15550100007', voiceCapable: true, smsCapable: true, provisionedVia: 'console', burn: ['+15551110001'] });
    expect(await repo.releaseNumber('+15550100007')).toMatchObject({ lifecycle_state: 'released' });
    expect(await repo.releaseNumber('+15550100007')).toBeUndefined();
  });

  it('listActive excludes released numbers', async () => {
    await repo.create({ poolNumber: '+15550100008', voiceCapable: true, smsCapable: true, provisionedVia: 'console', burn: ['+15551110001'] });
    await repo.create({ poolNumber: '+15550100009', voiceCapable: true, smsCapable: true, provisionedVia: 'console', burn: ['+15551110002'] });
    await repo.releaseNumber('+15550100009');
    const active = (await repo.listActive()).map((i) => i.poolNumber);
    expect(active).toContain('+15550100008');
    expect(active).not.toContain('+15550100009');
  });
});
```

Delete/rework the old quarantine-era tests in the same file (claim/reassign/release-to-quarantine/reclaimExpired) - they test deleted methods.

- [ ] **Step 2: Run to verify failure** - `cd /w/tmp/relay-number-lifecycle/app && npx vitest run test/poolNumbersRepo.test.ts` -> FAIL (methods missing).

- [ ] **Step 3: Implement the repo rewrite.** Key implementation points (keep file header comments accurate - rewrite them for the burn model):
  - Keep the byLifecycleState GSI AS-IS (HASH lifecycle_state, RANGE quarantine_until): every item keeps `quarantine_until` = the existing `NOT_QUARANTINED_SENTINEL` constant so items still index. NO table/GSI change (spec section 9). Rename nothing in tables.ts.
  - `burnClaim` - the novel piece:

```ts
async burnClaim(poolNumber, phones, tag) {
  if (phones.length === 0) return undefined; // never claim with an empty roster
  const names: Record<string, string> = { '#bp': 'burned_phones' };
  const values: Record<string, unknown> = {
    ':phones': new Set(phones),
    ':active': 'active',
  };
  const notContains = phones
    .map((p, i) => {
      values[`:p${i}`] = p;
      return `NOT contains(#bp, :p${i})`;
    })
    .join(' AND ');
  try {
    const { Attributes } = await doc.send(
      new UpdateCommand({
        TableName: table,
        Key: { poolNumber },
        UpdateExpression:
          'ADD #bp :phones' + (tag !== undefined ? ' SET placement_tag = :tag' : ''),
        // The whole invariant in one condition: number is active AND no roster
        // phone was ever burned here. attribute_not_exists(#bp) covers a legacy
        // record with no set yet.
        ConditionExpression:
          `lifecycle_state = :active AND (attribute_not_exists(#bp) OR (${notContains}))`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: { ...values, ...(tag !== undefined && { ':tag': tag }) },
        ReturnValues: 'ALL_NEW',
      }),
    );
    log.info({ burnCount: phones.length }, 'pool number burn-claimed');
    return Attributes as PoolNumberItem;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return undefined;
    throw err;
  }
}
```

  - `create` takes `burn: string[]` and writes `burned_phones: new Set(input.burn)` (only when non-empty - DynamoDB forbids empty sets), `lifecycle_state: 'active'`.
  - `noteGroupClosed`: UpdateItem `SET last_group_closed_at = :t` with condition `attribute_not_exists(last_group_closed_at) OR last_group_closed_at < :t`; swallow ConditionalCheckFailedException (older timestamp) and log-not-throw on missing record.
  - `releaseNumber`: `SET lifecycle_state=:released, released_at=:now` condition `lifecycle_state = :active`; ConditionalCheckFailedException -> undefined.
  - `listActive`: paged Query loop on byLifecycleState `:s='active'` (follow LastEvaluatedKey; the pool is small but never truncate silently).
  - DELETE: `claim`, `reassign`, `release`, `reclaimExpired`, `findAvailable`, `QUARANTINE_WINDOW_MS`, `assigned_conversation_id` writes. Export `RELEASE_GRACE_MS`.

- [ ] **Step 4: Run to verify pass** - same command -> PASS. Then `npx tsc --noEmit -p .` will FAIL on service callers - expected; Task 2 fixes them. Do NOT run the full app suite yet.

- [ ] **Step 5: Commit** - `git add app/src/repos/poolNumbersRepo.ts app/test/poolNumbersRepo.test.ts && git commit -m "feat(relay): pool repo burn model - atomic burn-as-claim, active/released states"`
(Typecheck is red until Task 2 - Tasks 1+2 may be committed together if the builder prefers a green-per-commit history; if so, note it in the slice report.)

---

### Task 2: Pool service + adapter release + config gate

**Files:**
- Modify: `app/src/services/poolNumbers.ts` (rewrite provisioning ladder + add retirement)
- Modify: `app/src/adapters/messaging.ts` (interface ~:104-135, twilio impl ~:454-520, console impl ~:676-700)
- Modify: `app/src/lib/config.ts` (near relayLiveProvisioning, ~:412-436) + `app/src/services/relayProvisioning.ts:81` caller + `app/src/routes/relayGroups.ts` reopen caller (see Task 5)
- Test: `app/test/poolNumbersService.test.ts` (or the file that tests provisionForPlacement today - locate by `rg -l provisionForPlacement app/test`)

**Interfaces:**
- Consumes: Task 1 repo. Produces:

```ts
export interface PoolNumbersService {
  /** Burn-as-claim ladder: retire sweep -> reuse first non-overlapping active number -> buy fresh. rosterPhones = every member phone of the NEW group. */
  provisionForGroup(rosterPhones: string[], tag?: string): Promise<ProvisionForGroupResult>;
  /** Stamp a group-close time onto the number (delegates noteGroupClosed). */
  noteGroupClosed(poolNumber: string, closedAt: string): Promise<void>;
  /** Release-eligibility sweep (config-gated). Returns numbers released. Exposed for the ops script. */
  retireEligible(): Promise<string[]>;
}
export interface ProvisionForGroupResult { poolNumber: string; record: PoolNumberItem; provisioned: boolean; }
```

- Adapter: `releasePhoneNumber(phoneNumber: string): Promise<void>` - twilio: look up the IncomingPhoneNumber SID for the number (same lookup pattern setVoiceWebhook uses at ~:508-518) then DELETE the resource; console: log no-op (parity with setVoiceWebhook).
- Config: `relayNumberReleaseEnabled: boolean` from `RELAY_NUMBER_RELEASE_ENABLED === 'true'` (default false everywhere; same parse idiom as RELAY_LIVE_PROVISIONING but no driver-based default).
- `RelayProvisioningDisabledError` unchanged (kill-switch still guards NEW purchases only).

- [ ] **Step 1: Write the failing tests** (fake repo + fake adapter, following the existing service-test idioms in the located test file):

```ts
describe('poolNumbersService.provisionForGroup - burn ladder', () => {
  it('reuses the FIRST active number with zero overlap (skips overlapping ones)', async () => {
    // pool: numberA burned {t1}, numberB burned {x1}; roster {t1, l1} -> must land on B
    const result = await service.provisionForGroup(['+1t1', '+1l1']);
    expect(result).toMatchObject({ poolNumber: '+1B', provisioned: false });
    // and B's burn set now contains t1+l1 (via repo fake assertion)
  });
  it('driver source-isolation still applies to reuse candidates', async () => { /* console-tagged only when currentVia=console */ });
  it('buys fresh when every active number overlaps; new record burn-seeded with the roster', async () => {
    const result = await service.provisionForGroup(['+1already-burned-everywhere']);
    expect(result.provisioned).toBe(true);
  });
  it('kill-switch: fresh purchase refused when relayLiveProvisioning=false (reuse still allowed)', async () => { /* RelayProvisioningDisabledError only on the fresh branch */ });
  it('lost race on candidate -> falls through to next candidate, then fresh', async () => { /* burnClaim returns undefined once */ });
  it('empty roster throws (never claim an unburnable group)', async () => {
    await expect(service.provisionForGroup([])).rejects.toThrow();
  });
});

describe('poolNumbersService.retireEligible', () => {
  it('releases a number with zero open groups whose last close is older than 180d', async () => { /* fake conversationsRepo.getAllByPoolNumber returns closed-only; last_group_closed_at = now-181d; expect adapter.releasePhoneNumber called + repo released */ });
  it('vetoes when ANY open group exists on the number', async () => { /* adapter NOT called */ });
  it('vetoes inside the grace window (now-179d)', async () => {});
  it('vetoes a number that never hosted a group (no last_group_closed_at)', async () => {});
  it('no-ops entirely when relayNumberReleaseEnabled=false', async () => {});
  it('adapter failure: number stays active, error logged, sweep continues', async () => {});
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.**
  - `provisionForGroup(rosterPhones, tag)`: throw on empty roster; `await this.retireEligible()` fire-and-forget-with-catch at the top (the lazy sweep seat reclaimExpired vacated; it no-ops when gated off); then `const candidates = (await repo.listActive()).filter(c => c.provisioned_via === currentVia)`; for each candidate compute overlap in code first (cheap pre-filter: skip if any roster phone in its burned_phones) then `const claimed = await repo.burnClaim(candidate.poolNumber, rosterPhones, tag); if (claimed) return {..., provisioned: false}`; after candidates: kill-switch check (unchanged text), then the existing fresh-provision retry loop, but `repo.create({..., burn: rosterPhones, tag})` and NO separate claim call (create seeds the burn = the claim). Keep the voice-capability requirement + webhook pre-wiring verbatim.
  - `retireEligible()`: if (!config.relayNumberReleaseEnabled) return []; needs a ConversationsRepo dep (add `conversationsRepo?` to PoolNumbersServiceDeps, defaulting via createConversationsRepo) - for each `listActive()` record: skip unless `last_group_closed_at` exists and `Date.parse(last_group_closed_at) <= now - RELEASE_GRACE_MS`; `const groups = await conversations.getAllByPoolNumber(n.poolNumber)`; skip if `groups.some(g => g.status === 'open')` OR `groups.length === 0`; then `await adapter.releasePhoneNumber(n.poolNumber)` (try/catch -> log + continue), `await repo.releaseNumber(n.poolNumber)`, audit via log (no auditRepo dep needed - log line + the repo's released_at is the record; keep it simple).
  - DELETE `provisionForPlacement`/`assignConversation`/`release` from the service interface; fix `relayProvisioning.ts`: `const provisioned = await poolNumbersService.provisionForGroup(members.map((m) => m.phone), tag);` and DELETE the assignConversation try/catch block (:92-102) - the back-reference is gone.
  - messaging.ts: add `releasePhoneNumber` to the interface with a doc comment (called only by the retirement sweep; twilio DELETE IncomingPhoneNumber; console logged no-op). RUNBOOK note (Task 8 docs step) covers the messaging-service/A2P implication.
  - config.ts: `relayNumberReleaseEnabled` parse + AppConfig field + return entry; `.env.example` comment line (`RELAY_NUMBER_RELEASE_ENABLED=` with a one-line explanation, template-first per repo rule).
  - Add npm script `pool:retire` in app/package.json -> `tsx scripts/retirePoolNumbers.ts`, a ~20-line script that builds the service and calls retireEligible(), printing the released list (mirrors existing scripts/ patterns).

- [ ] **Step 4: Run** - service tests PASS; `cd /w/tmp/relay-number-lifecycle && npm run typecheck` now must be GREEN except conversationsRepo.getAllByPoolNumber (Task 3 does it - if red, implement Task 3 Step 3a first and note it).

- [ ] **Step 5: Commit** - explicit paths incl. .env.example + scripts file.

---

### Task 3: Conversations repo - multi-match index, close keeps the number, nag field

**Files:**
- Modify: `app/src/repos/conversationsRepo.ts` (getByPoolNumber ~:947-960, setRelayStatus, interface)
- Test: `app/test/` - the conversationsRepo test file (locate: `rg -l getByPoolNumber app/test`)

**Interfaces (produced):**

```ts
/** ALL relay groups ever fronted by this number (open + closed). */
getAllByPoolNumber(poolNumber: string): Promise<ConversationItem[]>;
/** setRelayStatus(conversationId, status, expectedCurrent) - pool_number is NEVER touched (the old poolNumber param is REMOVED from the signature). */
setRelayStatus(conversationId: string, status: 'open'|'closed', expectedCurrent: 'open'|'closed'): Promise<ConversationItem>;
/** Set/clear the 28-day nag timestamp. null clears (REMOVE). */
setCloseNagNextAt(conversationId: string, at: string | null): Promise<void>;
export const CLOSE_NAG_INTERVAL_MS = 28 * 24 * 60 * 60 * 1000; // 4 weeks - same weekday
```

- [ ] **Step 1: Failing tests**: `getAllByPoolNumber` returns open AND closed groups on one number (create two relay groups sharing pool_number, close one via setRelayStatus, expect both returned, statuses intact, pool_number still present on the closed one); `setRelayStatus` no longer removes pool_number and still flips relay_status lockstep + conditional on expectedCurrent; `setCloseNagNextAt` sets and clears.
- [ ] **Step 2: Run -> FAIL.**
- [ ] **Step 3: Implement**: `getAllByPoolNumber` = the existing Query WITHOUT the `.find()` collapse (return the array; keep a paged loop). KEEP a thin `getByPoolNumber` returning `items.find(open) ?? items[0]` ONLY if other callers still exist after Task 4 - check `rg -n getByPoolNumber app/src` and delete it if the webhook was the last caller (echo guard converts too, Task 4). `setRelayStatus`: drop the `poolNumber` param and its REMOVE branch; update relay_status lockstep exactly as today. `setCloseNagNextAt`: UpdateItem SET/REMOVE `close_nag_next_at`. Add `close_nag_next_at?: string` to ConversationItem docs. Fix ALL setRelayStatus callers' arity in the same commit (relayGroups.ts, placementRelayLifecycle.ts until Task 5 deletes it).
- [ ] **Step 4: Run repo tests + typecheck -> PASS.**
- [ ] **Step 5: Commit.**

---

### Task 4: Webhook (To, From) routing + closed->1:1 provenance

**Files:**
- Modify: `app/src/routes/webhooks/twilio.ts` (echo guard :458-462, relay routing :464-475, handleRelayInbound :320-430)
- Test: `app/test/relayFanOut.test.ts` / the webhook inbound test file (locate: `rg -l handleRelayInbound app/test` or the relay-inbound describe in the twilio webhook tests)

**Interfaces:**
- Consumes: `getAllByPoolNumber` (Task 3). Produces: message attribute `via_closed_group: <conversationId>` on 1:1-delivered late texts (dashboard Task 6 renders it).

- [ ] **Step 1: Failing tests** (webhook harness idioms from the existing relay tests):

```ts
describe('relay inbound - (To, From) resolution', () => {
  it('routes to the OPEN group whose roster contains From when two groups share the number', async () => {
    // group1 open {t1,l1}, group2 open {t2,l2}, SAME pool number; From=t2 -> lands on group2, fan-out enqueued for group2 only
  });
  it('closed-roster match delivers into the sender 1:1 with via_closed_group (no group append, no fan-out, empty TwiML)', async () => {
    // group closed {t1,l1}; From=t1 -> message appended to t1's tenant_1to1 conversation with via_closed_group=<groupId>; group transcript unchanged
  });
  it('open match WINS over a closed match for the same sender', async () => {
    // t1 in closed group A and open group B on one number (historic overlap is impossible via assignment, but the router must still prefer open deterministically)
  });
  it('multiple closed matches -> newest group wins for provenance', async () => {});
  it('unknown sender on a pool number keeps the non-member behavior (persisted on newest OPEN group, no fan-out)', async () => {});
  it('echo guard still drops From=<any pool number> (open or closed groups)', async () => {});
});
```

- [ ] **Step 2: Run -> FAIL.**
- [ ] **Step 3: Implement** in the `/sms` handler, replacing the :464-475 block:

```ts
if (To !== undefined && To.length > 0) {
  const groups = await conversations.getAllByPoolNumber(To);
  if (groups.length > 0) {
    const openMatch = groups
      .filter((g) => g.status === 'open' && (g.participants ?? []).some((m) => m.phone === From))
      .sort(byNewestCreated)[0];
    if (openMatch) {
      await handleRelayInbound(openMatch, { MessageSid, From, To, Body, params });
      res.type('text/xml').send(EMPTY_TWIML);
      return;
    }
    const closedMatch = groups
      .filter((g) => g.status !== 'open' && (g.participants ?? []).some((m) => m.phone === From))
      .sort(byNewestCreated)[0];
    if (closedMatch) {
      await handleClosedGroupInbound(closedMatch, { MessageSid, From, Body, params });
      res.type('text/xml').send(EMPTY_TWIML);
      return;
    }
    // Unknown sender texting a pool number: keep today's non-member behavior
    // on the newest OPEN group if any, else newest group (persist, no fan-out).
    const fallback = groups.filter((g) => g.status === 'open').sort(byNewestCreated)[0] ?? groups.sort(byNewestCreated)[0];
    await handleRelayInbound(fallback, { MessageSid, From, To, Body, params });
    res.type('text/xml').send(EMPTY_TWIML);
    return;
  }
}
```

  - `byNewestCreated`: compare `created_at ?? ''` descending (small local helper).
  - Echo guard :458: replace `getByPoolNumber(From)` with `(await conversations.getAllByPoolNumber(From)).length > 0`.
  - NEW `handleClosedGroupInbound(group, {MessageSid, From, Body, params})`: resolve contact by phone (contacts.findByPhone), `createOrGetByParticipantPhone(From, conversationTypeFor(contact))` (the :477-483 idiom), append with the 1:1 inbound shape PLUS `viaClosedGroup: group.conversationId` (thread through messages.append the way relaySenderKey is), mirror media, unread/touch/SSE exactly like the 1:1 path (extract or mirror the minimal subset; do NOT duplicate STOP handling - OptOutType flows through the normal append path unchanged). Log line: 'relay late text on closed group - delivered to 1:1 with provenance'.
  - In `handleRelayInbound`: DELETE the `isClosed` branch + `receivedOnClosedThread` flag (the router never sends a closed-roster match here anymore; a closed fallback for unknown senders keeps the no-fan-out guard by checking status before enqueue - keep `if (relay.status !== 'open') skip fan-out` as a defensive line but drop the flag).
  - messagesRepo: add pass-through for `viaClosedGroup` -> stored attr `via_closed_group` (mirror how relaySenderKey is persisted).
- [ ] **Step 4: Run webhook/relay tests + typecheck -> PASS.**
- [ ] **Step 5: Commit.**

---

### Task 5: Close flow - final message, no release, reopen-same-number, hook removal, nag actions

**Files:**
- Modify: `app/src/routes/relayGroups.ts` (:413-490 close/reopen; new keep-open route)
- Modify: `app/src/messages/catalog.ts` (MessageId union + entry)
- Delete: `app/src/services/placementRelayLifecycle.ts` + its test; unwire from `app/src/lib/statusTransition.ts` (:69-73, :456-462) and the composition root (rg -n closeRelayForLostPlacement app/src)
- Modify: `app/src/services/relayAnnouncements.ts` (:129-144 gate)
- Test: `app/test/relayGroupsApi.test.ts` (locate by rg), `app/test/` statusTransition tests, catalog test

**Interfaces:**
- Catalog: `'relay.group_closed'` with default copy EXACTLY: `This group chat is now closed. You can still text this number and a Housing Choice team member will see your message and follow up.` (no tokens). Wire into the MessageId union next to relay.intro.
- Route additions: `PATCH /api/conversations/:conversationId/close` body `{ closed: boolean }` (existing shape) - close now sends the final announcement FIRST; `POST /api/conversations/:conversationId/close-nag/defer` -> sets close_nag_next_at = now + CLOSE_NAG_INTERVAL_MS, returns { conversation }. (Consumed by dashboard Task 7.)

- [ ] **Step 1: Failing tests**:
  - close: sends relay.group_closed via sendRelayAnnouncement to the still-open group BEFORE status flips (assert announcement persisted on the group + legs queued to both members via the fake world outbox), then status=closed, pool_number STILL PRESENT, poolNumbersService.noteGroupClosed called with the number, close_nag_next_at cleared, NO release call exists anywhere.
  - close idempotency: second close no-ops (no second announcement).
  - announcement send failure -> group still closes (logged).
  - reopen: `{closed:false}` flips status open conditional closed, KEEPS the same pool_number, provisions NOTHING (assert provisionForGroup never called).
  - keep-open route: sets close_nag_next_at ~= now+28d (assert within a minute tolerance).
  - statusTransition: placement -> lost NO LONGER closes the relay (assert group stays open; hook gone).
  - relayAnnouncements: skips when `status !== 'open'` even with pool_number present; still sends on open.
- [ ] **Step 2: Run -> FAIL.**
- [ ] **Step 3: Implement**:
  - Close branch rewrite: capture conversation; if already closed -> idempotent return (existing). FIRST `await sendRelayAnnouncement(deps, { conversationId, body: await resolveWithSettings('relay.group_closed', {}, { settingsRepo }), kind: 'group_closed' })` in try/catch (failure logs + continues). THEN `setRelayStatus(conversationId, 'closed', 'open')` (new arity); on ConditionalCheckFailed -> idempotent path (note: the announcement may have sent once on the winning call only - the loser bails before announcing because the FIRST step re-reads status and returns early when already closed: guard `if (conversation.status !== 'open')` before announcing). THEN `await poolNumbers.noteGroupClosed(conversation.pool_number, new Date().toISOString())` (best-effort try/catch) and `await conversations.setCloseNagNextAt(conversationId, null)`. Audit as today.
  - Reopen branch: DELETE the provisioning block entirely; just `setRelayStatus(conversationId, 'open', 'closed')` + audit. (The number was never removed; roster already burned on it - reopening is pure status. Record this as the plan's intended simplification, spec D3-consistent.)
  - Keep-open route: validate relay_group exists, `setCloseNagNextAt(id, new Date(Date.now() + CLOSE_NAG_INTERVAL_MS).toISOString())`, audit `relay_close_nag_deferred`, return conversation.
  - Delete placementRelayLifecycle.ts + its wiring: statusTransition loses the optional hook param + call site; composition root (app.ts or wherever it is built - rg) drops the construction. Delete its test file.
  - relayAnnouncements gate: replace the pool_number check with `conversation.status !== 'open'` in the unusable condition (keep the pool_number presence check too - a group with no number still cannot send - but the STATUS check is now the authoritative closed-gate).
- [ ] **Step 4: Run app tests + typecheck -> PASS** (full `npm test` in app - the deleted hook ripples through statusTransition tests; fix them to assert the new no-close behavior).
- [ ] **Step 5: Commit.**

---

### Task 6: Today nag (backend) 

**Files:**
- Modify: `app/src/routes/today.ts` (new item source), `app/src/routes/relayGroups.ts` if the defer route landed there (Task 5 did it)
- Test: `app/test/todayApi.test.ts` (locate by rg today.ts test)

**Interfaces (produced for dashboard):** today payload gains `relayCloseNags: Array<{ conversationId: string; poolNumber: string; tag?: string; memberNames: string[]; ownerType: 'tour'|'placement'|null; ownerId?: string; nagDueAt: string }>` - built from `listRelayGroups('open')` filtered to `close_nag_next_at !== undefined && close_nag_next_at <= now`.

- [ ] **Step 1: Failing test**: seed two open relay groups, one with close_nag_next_at in the past, one future -> /api/today returns exactly the past-due one with poolNumber + member names; a closed group with a stale nag never appears.
- [ ] **Step 2: Run -> FAIL.**
- [ ] **Step 3: Implement** in today.ts following its existing sources pattern (:32 comment lists them): query listRelayGroups('open'), filter, map (names from participants; phone exposed as poolNumber is DATA for display - consistent with the opted-out item precedent).
- [ ] **Step 4: Run -> PASS. Typecheck.**
- [ ] **Step 5: Commit.**

---

### Task 7: Dashboard - nag card, inline asks, provenance badge

**Files:**
- Modify: `dashboard/src/routes/today/buildToday.ts` + `Today.tsx` (+ module.css) - nag card group
- Modify: `dashboard/src/routes/tours/TourModals.tsx` / `TourDetail.tsx` (outcome recording: canceled / closed "not a fit") - the ask dialog
- Modify: the placement status UI (rg -n "lost" dashboard/src/routes/placements - the status-change surface) - same ask on lost + completed
- Modify: conversation timeline message renderer (rg -n relaySenderKey dashboard/src/routes/conversation) - via_closed_group badge
- Modify: `dashboard/src/api/endpoints.ts` (close + defer + today types)
- Test: colocated .test.tsx files for each surface

**Interfaces:** consumes Task 5/6 routes verbatim. The ask dialog is ONE shared component `RelayCloseAskDialog` (new file `dashboard/src/routes/conversation/RelayCloseAskDialog.tsx`): props `{ conversationId, memberSummary, onDone }`; renders "Also close the group text with <memberSummary>?" [Close group text] [Keep it open]; Close -> PATCH close {closed:true}; Keep -> POST close-nag/defer; both call onDone. Non-blocking: it opens AFTER the outcome save succeeds and only when the tour/placement carries a linked OPEN relay group (the tour/placement payloads already expose groupThreadId/group_thread; fetch the conversation's status via the existing relay-groups GET before offering - no status, no dialog).

- [ ] **Step 1: Failing tests** per surface:
  - RelayCloseAskDialog.test.tsx: renders both actions; Close PATCHes closed:true; Keep POSTs defer; onDone fires.
  - Tours outcome test: recording "not a fit"/canceled on a tour WITH an open group shows the dialog; without a group, no dialog.
  - Placement test: same for lost and for the completed/terminal-success transition.
  - Today.test.tsx: a relayCloseNags entry renders "Group text with <number> ... still open" + Close/Keep-open wired to the same endpoints.
  - Timeline test: a message with via_closed_group renders the badge "Sent to the closed group chat" (accessible text) linking to /conversations/<id> (match existing badge idioms).
- [ ] **Step 2: Run -> FAIL.**
- [ ] **Step 3: Implement** (accessibility-first: dialog role, labeled buttons; ASCII copy; tenant copy rules do not apply - this is staff dashboard, "group text" language as used above).
- [ ] **Step 4: Run dashboard suite + typecheck -> PASS.**
- [ ] **Step 5: Commit.**

---

### Task 8: Seeds + docs

**Files:**
- Modify: `app/src/lib/seed/*` wherever relay groups / pool numbers are seeded (rg -n "pool_number|relay_group" app/src/lib/seed) - emit burned_phones (roster union), lifecycle_state 'active', last_group_closed_at on any seeded-closed group
- Modify: `RUNBOOK.md` - RELAY_NUMBER_RELEASE_ENABLED operator note + the A2P/messaging-service implication of releasePhoneNumber + `npm run pool:retire`
- Modify: `docs/issues/group-threads-across-multiple-tours.md` -> status: resolved (this design), and `docs/issues/tour-outcome-close-not-backend-enforced.md` -> narrow/update per what Task 5 shipped
- Test: `app/test/seedData.test.ts` - assert seeded pool records carry burned_phones consistent with their groups' rosters (the spec section 6 assertion)

- [ ] Steps: failing seed-shape test -> implement -> pass -> update docs (no test) -> commit.

---

### Task 9: E2E - the multiplexing + close-lifecycle proofs

**Files:**
- Create: `e2e/tests/dashboard-next/relay-number-lifecycle.spec.ts`
- Check/update: existing relay/tour specs that close groups (rg -n "close" e2e/tests | rg -i relay)

**Test list (accessibility-first selectors, unique phones per run, fake-phones UI for participant sends):**
1. MULTIPLEX: create group1 (tenantA+landlordA); create group2 (tenantB+landlordB) -> assert (via authenticated API) both conversations carry the SAME pool_number; send from tenantB's fake phone -> message lands in group2 only; send from tenantA -> group1 only.
2. OVERLAP FORCES SECOND NUMBER: create group3 reusing tenantA -> different pool_number than group1.
3. CLOSE FLOW: record "not a fit" on a tour with a group -> inline dialog -> Close -> dev-outbox shows relay.group_closed copy to both members; composer hard-disabled; conversation still shows pool_number.
4. LATE TEXT: tenantA texts the closed group1's number from fake-phones -> appears in tenantA's 1:1 thread with the provenance badge; group1 transcript unchanged; no new-group pollution (group on same number with other members unaffected).
5. NAG: set a group's close_nag_next_at into the past via dev seam if available, else create + defer and assert the Today card renders after a direct API defer with a past timestamp (use the authenticated defer endpoint with a crafted body ONLY if the route allows arbitrary timestamps - otherwise assert the card via a seeded past-due group from the seed profile; pick whichever the harness supports and note it).
6. Keep the existing tours-group-send spec green (reminder routing unchanged for open groups).

- [ ] Steps: write spec -> `timeout 1500 npm run e2e` from the worktree -> green -> commit.

Final: ONE main sync + all three gates bare + live self-QA per the orchestrator manual.

## Self-review notes (applied)

- Spec coverage: D1/2.2 -> T1+T2; D2/3.1-3.2 -> T4+T7(badge); D3 -> T1/T3/T5(reopen); D4 -> T5+T7(asks); D5 -> T3(constant)+T6+T7; D6 -> T5(catalog); D7 -> T2; section 6 -> T8; hardening -> T5(announcement gate).
- Type consistency: provisionForGroup/getAllByPoolNumber/burnClaim/noteGroupClosed/setCloseNagNextAt/CLOSE_NAG_INTERVAL_MS/RELEASE_GRACE_MS used identically across tasks.
- Known judgment calls recorded for the orchestrator: Tasks 1+2 may share a commit for typecheck-green history; reopen-keeps-number simplification; getByPoolNumber deletion contingent on zero remaining callers.
