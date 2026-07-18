# Group Text Numbers Admin Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin-only Settings section "Group text numbers" showing every
pool number (active/releasing/released), its usage history, burn count,
last activity, and a retirement countdown that mirrors the sweep exactly.

**Architecture:** One additive repo method (listByState on the existing
byLifecycleState GSI) + one read-only admin router (GET /api/pool-numbers)
that joins pool records to their groups via the existing byPoolNumber
lookup and computes the retire mirror from the service's own
RELEASE_GRACE_MS. Dashboard adds an AdminRoute-guarded Settings section
with a filterable, expandable table. No writes anywhere.

**Tech Stack:** Express + DynamoDB (lib-dynamodb) + vitest/supertest (app),
React + testing-library (dashboard), Playwright (e2e).

## Global Constraints

- Spec: docs/superpowers/specs/2026-07-18-pool-numbers-admin-design.md -
  APPROVED (incl. the section-6 schema-allowance posture); deviations
  stop-and-report.
- ASCII only in every added line (`tr -d '\11\12\15\40-\176' < FILE | wc -c` -> 0).
- Phone numbers are PII in LOGS (counts/states only); they are display
  DATA in the admin response. burned_phones contents NEVER leave the API -
  only the count.
- One grace constant: import RELEASE_GRACE_MS (exported via
  repos/poolNumbersRepo.ts, already imported by services/poolNumbers.ts) -
  a second 180-day literal anywhere is a defect.
- Staff copy says "group text numbers"; code stays pool_number. Update
  documentation/GLOSSARY.md in the dashboard task.
- Gates after each task: `npm run typecheck` + the touched workspace's
  tests, bare, from /w/tmp/pool-numbers-admin. e2e deferred to Task 4.
- Commit per task, explicit paths, gating `git status` read first,
  Co-Authored-By trailer naming the authoring model.

## Research notes for the builder (verified at plan time)

- Admin gate idiom: routes/adminUsers.ts line ~74 `router.use(requireRole('admin'))`
  (middleware/auth.js); mount the new router in routes/api.ts beside it.
- Dashboard guard: routes/settings/AdminRoute.tsx wraps admin sections in
  App.tsx (~165/178); mirror for /settings/numbers + the Settings nav
  entry (research the Settings nav component for the entry idiom).
- Group label precedence: dashboard/src/routes/contact/GroupTextsCard.tsx
  `groupLabel` (member names > tag > pool number > "Group text") - the
  API computes `label` server-side with the SAME precedence (members'
  `name` fields from participants; confirm the tag field name on the
  conversation, it is whatever GroupTextsCard's RelayGroupRow carries).
- Group timestamps: ConversationItem has `created_at` and
  `last_activity_at`. A per-group CLOSED timestamp: research whether the
  close path stamps one (`close_announced_at` is set at close-announce
  and cleared on reopen - acceptable proxy ONLY if nothing better
  exists; if no honest field exists, omit closedAt for that group - the
  spec forbids fabricated dates).
- listActive (repos/poolNumbersRepo.ts ~218) is the paged-Query template
  for listByState; PoolNumberItem fields at ~82 (lifecycle_state,
  burned_phones Set|array, last_group_closed_at, released_at).

## File structure (decomposition)

- `app/src/repos/poolNumbersRepo.ts` - ADD `listByState(state)`;
  `listActive()` delegates to it.
- `app/src/routes/poolNumbersAdmin.ts` - NEW read-only admin router:
  assembly + retire mirror + wire shapes.
- `app/src/routes/api.ts` - mount it.
- `dashboard/src/api/types.ts` + `endpoints.ts` - wire types + fetcher.
- `dashboard/src/routes/settings/NumbersSection.tsx` (+ module.css if the
  Settings sections use one) - table, filters, expansion.
- `dashboard/src/App.tsx` + the Settings nav component - route + entry.
- `documentation/GLOSSARY.md` - "group text numbers" noun.
- Tests: `app/test/poolNumbersRepo.test.ts` (extend),
  `app/test/poolNumbersAdmin.test.ts` (new),
  `dashboard/src/routes/settings/NumbersSection.test.tsx` (new),
  `e2e/tests/dashboard-next/pool-numbers-admin.spec.ts` (new).

---

### Task 1: repo listByState

**Files:**
- Modify: `app/src/repos/poolNumbersRepo.ts`
- Test: `app/test/poolNumbersRepo.test.ts` (extend)

**Interfaces:**
- Produces (consumed by Task 2):

```ts
/** All numbers in one lifecycle state (paged Query on byLifecycleState). */
listByState(state: PoolNumberLifecycleState): Promise<PoolNumberItem[]>;
```

- [ ] **Step 1: Write the failing tests** (follow the file's existing
  DynamoDB-Local arrange idiom):

```ts
describe('listByState', () => {
  it('returns numbers in the requested state only', async () => {
    // seed one active, one releasing, one released record
    // listByState('releasing') -> exactly the releasing number
  });
  it('returns RELEASED rows (sparse-GSI proof)', async () => {
    // create -> markReleasing -> finalizeRelease (the real path), then
    // listByState('released') -> the row, with released_at present
  });
  it('listActive still returns exactly the active rows', async () => {});
});
```

- [ ] **Step 2: Run to verify failure**
  `npm test --workspace app -- poolNumbersRepo` -> FAIL (no method).

- [ ] **Step 3: Implement** - generalize the existing listActive body:

```ts
async function listByState(state: PoolNumberLifecycleState): Promise<PoolNumberItem[]> {
  const items: PoolNumberItem[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(new QueryCommand({
      TableName: table,
      IndexName: 'byLifecycleState',
      KeyConditionExpression: 'lifecycle_state = :s',
      ExpressionAttributeValues: { ':s': state },
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    items.push(...((page.Items ?? []) as PoolNumberItem[]));
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);
  return items;
}
// listActive() becomes: () => listByState('active')
```

  (Match the file's actual pagination/style; expose listByState on the
  returned repo object and its interface.)

- [ ] **Step 4: Run** `npm run typecheck` + `npm test --workspace app -- poolNumbersRepo` -> green.
- [ ] **Step 5: Commit** "feat(pool): listByState - per-state pool-number query (listActive delegates)".

---

### Task 2: GET /api/pool-numbers (admin router)

**Files:**
- Create: `app/src/routes/poolNumbersAdmin.ts`
- Modify: `app/src/routes/api.ts` (mount)
- Test: `app/test/poolNumbersAdmin.test.ts`

**Interfaces:**
- Consumes: `listByState` (Task 1), `conversations.getAllByPoolNumber`,
  `RELEASE_GRACE_MS`.
- Produces (consumed by Task 3 - copy these shapes into dashboard types
  VERBATIM):

```ts
export interface PoolNumberGroupRow {
  conversationId: string;
  label: string;
  memberCount: number;
  status: 'open' | 'closed';
  createdAt?: string;
  closedAt?: string;
  lastActivityAt?: string;
}
export interface PoolNumberRow {
  number: string;
  state: 'active' | 'releasing' | 'released';
  openGroups: number;
  totalGroups: number;
  burnedCount: number;
  lastActivityAt?: string;
  lastGroupClosedAt?: string;
  releasedAt?: string;
  retire: { eligible: boolean; daysRemaining?: number };
  groups: PoolNumberGroupRow[];
}
// GET /api/pool-numbers -> { numbers: PoolNumberRow[] }
```

- [ ] **Step 1: Write the failing tests** (supertest against the app the
  way adminUsers tests arrange auth/roles):

```ts
describe('GET /api/pool-numbers', () => {
  it('403s a va-role user (same shape as other admin routes)', async () => {});
  it('joins pool records to groups: one open + one closed group -> openGroups 1, totalGroups 2, groups newest-first', async () => {});
  it('burnedCount is the set size; 0 when the attribute is absent', async () => {});
  it('retire mirror: eligible only when active + zero open + hosted>=1 + past grace', async () => {
    // boundaries: exactly at grace -> eligible; one day short ->
    // eligible false + daysRemaining 1; open group -> no countdown
    // (retire.daysRemaining absent); never-hosted -> not eligible
  });
  it('released row: state released, releasedAt present, eligible false', async () => {});
  it('label precedence: member names > tag > "Group text"', async () => {});
  it('response never includes burned_phones contents', async () => {});
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** the router (shape; match repo/service style):

```ts
router.use(requireRole('admin'));
router.get('/pool-numbers', async (_req, res) => {
  const states = ['active', 'releasing', 'released'] as const;
  const records = (await Promise.all(states.map((s) => poolNumbers.listByState(s)))).flat();
  const numbers = await Promise.all(records.map(async (rec) => {
    const groups = (await conversations.getAllByPoolNumber(rec.number))
      .sort(byNewestCreated);
    const openGroups = groups.filter((g) => g.status === 'open').length;
    const burned = rec.burned_phones;
    const burnedCount = burned instanceof Set ? burned.size : Array.isArray(burned) ? burned.length : 0;
    return {
      number: rec.number,
      state: rec.lifecycle_state,
      openGroups,
      totalGroups: groups.length,
      burnedCount,
      lastActivityAt: maxIso(groups.map((g) => g.last_activity_at)),
      lastGroupClosedAt: rec.last_group_closed_at,
      releasedAt: rec.released_at,
      retire: retireMirror(rec, openGroups, groups.length),
      groups: groups.map(toGroupRow),
    };
  }));
  res.json({ numbers });
});

function retireMirror(rec: PoolNumberItem, openGroups: number, totalGroups: number) {
  if (rec.lifecycle_state !== 'active' || openGroups > 0 || totalGroups < 1
      || rec.last_group_closed_at === undefined) return { eligible: false };
  const eligibleAt = Date.parse(rec.last_group_closed_at) + RELEASE_GRACE_MS;
  const remainingMs = eligibleAt - Date.now();
  return remainingMs <= 0
    ? { eligible: true }
    : { eligible: false, daysRemaining: Math.ceil(remainingMs / 86_400_000) };
}
```

  `toGroupRow` computes label with the groupLabel precedence and maps
  created_at/last_activity_at (+ the researched closed field or omit).
  LOGS: state/counts only - never rec.number. Mount in api.ts beside the
  adminUsers router. NOTE the mirror-vs-sweep nuance: retireEligible
  additionally requires hosted-at-least-one and uses the service clock -
  keep the predicate logic aligned with services/poolNumbers.ts
  retireEligible and add a comment pointing at it.

- [ ] **Step 4: Run** full app suite + typecheck -> green.
- [ ] **Step 5: Commit** "feat(pool): GET /api/pool-numbers - admin read-only inventory with retire mirror".

---

### Task 3: dashboard Settings section

**Files:**
- Create: `dashboard/src/routes/settings/NumbersSection.tsx` + test
- Modify: `dashboard/src/api/types.ts`, `dashboard/src/api/endpoints.ts`,
  `dashboard/src/App.tsx`, the Settings nav component
- Modify: `documentation/GLOSSARY.md` (add the staff noun row)

- [ ] **Step 1: Failing component tests** (testing-library, mock the
  fetcher like sibling Settings tests):
  - admin: table renders rows (number, state, counts, last activity,
    retirement cell variants: "Eligible", "12d remaining", "-",
    "Released <date>");
  - filter chips: default shows active+releasing; Released reveals
    released rows; All shows everything;
  - expansion: group rows with label/member count/status/dates, link href
    to the conversation route;
  - empty states (no numbers; filter no-match);
  - VA: no nav entry, route bounces (AdminRoute idiom test).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** - accessibility-first markup (real table
  semantics, `getByRole('table')`/`row`/`button` for chips + expanders),
  match sibling Settings sections' styling idioms. Copy uses "group text
  numbers" everywhere; the empty state: "No group text numbers yet - a
  number is provisioned with the first group text."
- [ ] **Step 4: GLOSSARY.md** - add the noun ("group text number" =
  staff-facing name for a relay pool number; code: pool_number).
- [ ] **Step 5: Run** dashboard tests + typecheck -> green.
- [ ] **Step 6: Commit** "feat(dashboard): Settings > Group text numbers - admin pool-number inventory".

---

### Task 4: e2e

**Files:**
- Create: `e2e/tests/dashboard-next/pool-numbers-admin.spec.ts`
- Reference: the relay specs' group-creation flow idioms; settings.spec.ts
  for how e2e reaches Settings and how sessions/roles are arranged
  (research which seeded user is admin vs va in the hermetic world; use
  whatever settings.spec.ts does for the admin path).

- [ ] **Step 1: Write the spec:** admin session -> create a relay group
  via the existing flow -> open /settings/numbers -> the pool number row
  exists (state active, open groups >= 1) -> expand -> the group row
  links to its thread (click through, assert the group view). Then the
  non-admin path: nav entry absent + direct navigation does not render
  the table (mirror the settings spec's existing role assertions).
- [ ] **Step 2: Run** `npm run e2e` from the worktree - new spec green, no
  regressions (honor the filed flakes: full-suite re-run before blaming).
- [ ] **Step 3: Commit** "test(e2e): pool-numbers admin page".

---

### Task 5: full gates + sweeps on the final tree

- [ ] `npm run typecheck` -> 0; `npm test` -> green;
  `timeout 1500 npm run e2e` -> green (bare, from the worktree).
- [ ] ASCII sweep of added lines -> 0.
- [ ] PII log sweep of the new route (no phone in any log call).
- [ ] Grace-constant grep: no new `180` / day-ms literal outside the
  RELEASE_GRACE_MS import (the daysRemaining divisor 86_400_000 is a
  day-length, not a grace literal - allowed once, named or commented).
- [ ] Handback per the operating manual (schema allowance unexercised ->
  state "no infra owed"; if exercised, record the owed tf op).

## Self-review (done at plan-writing time)

- Spec coverage: sec 3 API -> T1+T2; sec 4 page -> T3; sec 5 security ->
  T2/T3 tests + T5 sweep; sec 7 tests -> T1-T4; glossary -> T3;
  released-behind-filter + all three decisions -> T2 response + T3 chips.
- Type consistency: PoolNumberRow/PoolNumberGroupRow identical in T2 and
  T3 (copied verbatim); listByState signature consistent T1->T2.
- No placeholders; research items are explicitly scoped (closed-timestamp
  field, Settings nav idiom, e2e role arrangement) with fallbacks stated.
