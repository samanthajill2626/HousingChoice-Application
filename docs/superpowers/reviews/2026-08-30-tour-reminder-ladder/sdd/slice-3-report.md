# SLICE S3 REPORT - Task 4 Steps 6-16 (every call site, harness, tests, commit)

Worktree: `W:\tmp\tour-reminder-ladder`, branch `feat/tour-reminder-ladder`.
Base at slice start: `e8e20c92` (S1's last) + S2's four uncommitted files.

**COMMIT: `6c495d3a`** - "feat(tours): founder reminder copy with resolved names
on every compose path", 19 files changed, 1116 insertions(+), 258 deletions(-).
This is the ONE commit covering the whole of Task 4 (S2's four files + S3's
fifteen).

`npm run typecheck` (Step 14): **EXIT 0**.
App suite: 6000 passed / 1 environmental failure, re-run clean alone (section 5).
Dashboard suite: 2720 passed, EXIT 0.
`npm run e2e` was NOT run - the orchestrator owns it, per the slice brief.

---

## 1. Per step: what changed and where

### Step 6 - the SEND paths (`app/src/jobs/tourReminders.ts`)

- `composeBodyForRow` rewritten to the plan's body verbatim: deps widened to
  `Pick<RunDueTourRemindersDeps, 'unitsRepo' | 'contactsRepo'>`, trailing
  optional `tenantContact?: ContactItem`, the unit kept as an OBJECT (not
  reduced to `address`), `resolveTourContactNames` called between the unit read
  and the compose, `tourType: tour.tourType` and `names: resolved.names` passed
  through.
- Imports: ADDED `resolveTourContactNames` from `../lib/tourContacts.js` and
  `type UnitItem` onto the existing `../repos/unitsRepo.js` import.
  **DELETED `import type { Address } from '../lib/address.js'`** - the rewrite
  removed its only use (`let address: Address | string | undefined`), and a
  dangling type import is precisely the gate-5 `no-unused-vars` trap AGENTS.md
  names. Not in the plan; found by lint.
- Docblock above `composeBodyForRow` gained the INTERIM paragraph stating
  plainly that a throwing CONTACT read is currently swallowed into absence and
  that Task 5 closes it.
- Callers:
  - `processReminderRow` (1:1): `..., log, target.contact)`.
  - `sendGroupReminder`: unchanged arg list, as planned.
  - `forceSendReminder`: `target.route === 'one_to_one' ? target.contact : undefined`,
    formatted multi-line.
- **A4-13 (jobs-side twin)**: `RunDueTourRemindersDeps.unitsRepo`'s docblock now
  says THREE consumers and names the property contact as the third, with the
  Task-5 consequence.

### Step 7 - the tour-reminders ROUTE previews (`app/src/routes/tourReminders.ts`)

- `addressOf` REPLACED by `composeInputsOf`, the plan's snippet verbatim.
- **A4-1 honoured**: `type UnitItem` added to the existing
  `../repos/unitsRepo.js` import (the file genuinely did not import it).
  `type TourContactNames` added to the `messages/tourCopy.js` import;
  `resolveTourContactNames` imported from `../lib/tourContacts.js`.
- `bodyFor` gained a REQUIRED `names: TourContactNames` after `address` (so
  `address` lost its `?` and became `Address | string | undefined`), and passes
  `tourType: tour.tourType, names`. The DUPLICATED SHAPE comment is kept and
  now states that name resolution is HOISTED to the caller on all three copies.
- All three handlers converted: PATCH (`const { address, names } = await
  composeInputsOf(tour)`, both `viewOf(...)` echoes), send-now (`afterBody`),
  GET list (the `bodyFor(row, tour, window.timezone, address, names, tally)`
  call). The GET's "read ONCE per request" comment now says "the one unit
  address AND the one pair of names".
- **A4-12**: `viewOf`'s docblock now says the body needs async unit/settings
  AND CONTACT reads, pointing at `composeInputsOf`.
- **A4-13 (route side)**: `TourRemindersRouterDeps.unitsRepo`'s docblock now
  says THREE consumers, names `{propertyContactFirstName}` as the third, and
  states the Task-5 escalation (withhold the preview, block the send-now).

### Step 8 - the no-show draft

- Handler body replaced with the plan's snippet verbatim
  (`readQuietHoursWindow` -> `resolveTourContactNames({ unit: undefined })` ->
  `composeTourReminderBody({ kind: 'no_show_checkin', ... })`).
- Route docblock (`:532-537`) rewritten: the copy is no longer
  "tour-independent and var-less". **C15 honoured** - the `resolveMessage`
  mention in that PROSE went with the import. The only surviving occurrence of
  the identifier in the file is inside the new inline comment explaining why a
  bare `resolveMessage` would now throw, which is deliberate.
- The `resolveMessage` import at `:43` is DELETED.
- The 404-on-unknown-tour comment was reworded: its old justification ("the copy
  itself is tour-independent") is now false.
- `app/test/tourCopyCallSites.test.ts`: `ALLOWED_DIRECT` and its
  `if (id === ALLOWED_DIRECT) continue;` are GONE, replaced by a dated comment
  recording that the whitelist's "token-free by design (spec D2)"
  justification was reversed. There are now NO exceptions.
- `app/test/toursApi.test.ts` draft pin RE-DERIVED. Its fixture is
  `BASE_CREATE_BODY.tenantId = 'contact-tenant-1'`, which is **never pushed onto
  `world.contacts`** (grepped) - so the tenant read finds nothing and the
  expectation is `'Hi there! Do you need to reschedule?'`, not
  `'Hi <name>! ...'`. The `it` title and its comment now say so and point at the
  named-tenant pin in `tourRemindersApi.test.ts`.

### Step 9 - the contact-timeline preview (`app/src/routes/contactTimeline.ts`)

- `unitOnce` now memoizes `Promise<UnitRead>` (`{ unit, failed }`), the plan's
  snippet verbatim, with a comment naming the absence/failure collapse it fixes.
- `namesOnce` added, keyed by `unitId`, the plan's snippet verbatim, PLUS
  **A5-3's comment written a task early** (it costs nothing and the hazard is
  created by THIS change): the map is keyed on `unitId` while the assessor takes
  a `tourType` and the walk admits tours of different types at one unit - safe
  only because the RESOLVER does not branch on tour type.
- `gatherUpcoming`'s params gained `contactsRepo: Pick<ContactsRepo, 'getById'>`
  (documented as "threaded like conversationsRepo, not one of the five gather
  repos; the TENANT costs no read - it IS `contact`"), destructured alongside
  `conversationsRepo`, and the route call site passes its existing `contacts`
  instance.
- Tour walk: `const read = await unitOnce(...); const address = read.unit?.address;
  const { names } = await namesOnce(...)`.
- `tourReminderBodyOrEmpty` gained `names: TourContactNames` before `tally`,
  passes `tourType: tour.tourType, names`, keeps its containment and its
  DUPLICATED SHAPE comment (extended with the hoist note).
- `ResolvedTourNames` imported as a type from `../lib/tourContacts.js` for the
  `UnitNames` alias.

### Step 10 - the relay-groups scheduled bucket (`app/src/routes/relayGroups.ts`)

- Unit read restructured to keep the object; `unitReadFailed` tracked in the
  catch (**A4-2**); `resolveTourContactNames` hoisted ABOVE the `.map()`; the
  IIFE's compose gained `tourType: tour.tourType` and the names.
- Imports: `type UnitItem` added, `resolveTourContactNames` added,
  **`import type { Address }` DELETED** (its only use was the local the rewrite
  removed - same gate-5 trap as the job).
- **DEVIATION, see section 6.1**: the five values are bundled into one
  `composeInputs` object rather than left as loose locals, because a bare
  `let unitReadFailed` that nothing reads is an ESLint error and would have
  failed gate 5 on a file this slice touches.

### Step 11 - the e2e harness (`e2e/scenarios/steps.ts` + two specs)

- Type-only imports added for `TourContactNames` (from the COMPOSER, never
  `lib/tourContacts.js`) and `TourType` (from `lib/toursModel.js`), with the
  AWS-bundle warning inline.
- `TourReminderContext` gained `tourType: TourType` and `names: TourContactNames`.
- `tourReminderContext(unit, times, extra)` - third parameter, plan's shape.
- `tourReminderBody` threads both.
- `REMINDER_BODY_MARKERS` re-picked to the plan's values, including the
  `en_route` marker `"when you're on the way"` and its full rationale comment.
- `TOUR_TYPE_BY_LABEL` added at module level beside `REMINDER_KIND_LABELS`
  (`as const satisfies Record<string, TourType>`).
- `ActiveTour` gained required `tourType: TourType` and optional
  `tenantFirstName?: string`, with the docblock explaining why there is
  deliberately no `propertyContactFirstName`.
- The ONE constructor site (`teamCreatesTourFromInterest`) sets both.
  **A4-9 honoured**: a 9-line comment at the `tenantFirstName` line names the
  hazard - `teamCreatesLandlord` also writes `this.activeTenant` with the
  LANDLORD's name, and today's correctness is spec ORDERING, not a contract.
- `requireTourReminderContext` returns the new fields and its docblock carries
  the "exact-equality on the landlord-led `en_route` body is NOT supported
  through the step helpers" paragraph, pointing at
  `app/test/relayApi.test.ts` and the Task-10 issue.
- `scheduled-visibility.spec.ts`: Part A's `:101` destructure widened to
  `{ tenant, unit, times }`; all three `tourReminderContext(...)` calls now pass
  `{ tourType: 'self_guided', names: { tenantFirstName: tenant.firstName } }`.
- `tour-comms-pane.spec.ts`: the inline context object gained `tourType` +
  `names`. **DEVIATION on the stale comment, see 6.2.**

### Step 12 - the app test call sites

All eight TS2345s from S2's handover, threaded per the Step 12 rule (pass
exactly the names the fixture's seeded contact carries; NEVER weaken `toBe` to
`toContain`). No assertion was weakened.

| file:line | value passed | why |
| --- | --- | --- |
| `tourReminders.test.ts` `rungBody` | defaults `tourType='self_guided'`, `names={}` | grep confirms NO fixture in the file carries a `firstName`; with no property name `en_route` degrades to the self-guided entry for every type, so the default is value-safe. Both facts written into the docblock. |
| `contactTimeline.test.ts:1108,1113` | `tourType:'self_guided', names:{}` | no `firstName` anywhere in the file; `confirmation`/`day_before` do not fork on tourType, so the landlord_led fixtures further down cannot disagree. Stated in the comment. |
| `devGating.test.ts:459,464` | `tourType:'self_guided', names:{}` | `armTourViaRoute` pushes `contact-tick-tenant` with phone only. |
| `tourRemindersApi.test.ts:244` | `tourType:'landlord_led', names:{}` | that fixture really is landlord_led; `contact-states-1` is never pushed onto `world.contacts`. |
| `tourRemindersApi.test.ts:844` | `tourType:'self_guided', names:{}` | `seedSendNowTour`'s tenant has phone + consent, no name. |
| `tourRemindersApi.test.ts:1088` | `tourType:'self_guided', names:{}` | `seedQuietTour`'s tenant is nameless AND `seedComposedTour`'s unit points at a `landlordId` never pushed onto `world.contacts`, so BOTH names are absent. |

`tourReminders.test.ts` also gained `type TourContactNames` (from the composer)
and `type TourType` (from `lib/toursModel.js`) imports.

### Step 13 - the four new route tests

Three appended to `app/test/tourRemindersApi.test.ts` in a new
`describe('resolved names on the tour-reminder compose paths')`; the fourth
appended inside `relayApi.test.ts`'s existing
`describe('GET /api/conversations/:conversationId/scheduled')`
(**C8 honoured** - that block is `:1425`-`:1592`, not the plan's `:1445-1502`;
I appended after its last test rather than at a line number).

`seedTourGroup` in `relayApi.test.ts` gained an optional third parameter
`unitId = 'unit-1'` so the new case can point at a unit that actually has a
landlord. Every existing caller is unchanged.

### Step 14 - `npm run typecheck`

**EXIT 0** from the worktree root, over app src + app scripts + app tests +
dashboard + e2e + fake-twilio + fake-twilio-web.

**THE S2 TRAP FIRED ONCE, EXACTLY AS WARNED.** The new poll test asserted
`spy.sent[0]!.body.startsWith('Hey there, ')`. Vitest ran it GREEN;
`tsc` rejected it - `test/tourRemindersApi.test.ts(1331,12): error TS2532:
Object is possibly 'undefined'` (`SendMessageInput.body` is optional). Rewritten
to `expect(spy.sent[0]!.body).toMatch(/^Hey there, /)` with a comment saying
why the member form is unsafe. Recording it because it is direct evidence for
S2's warning: a green app suite is not proof of anything type-shaped.

### Step 15 (app half)

See section 5.

### Step 16 - commit

`6c495d3a`. Bare `git status` read first; `.git/MERGE_HEAD` confirmed ABSENT;
19 explicit paths staged (no `git add -A`). Two paths beyond the plan's list:
`app/src/routes/api.ts` (see 6.3) and `app/test/messages/resolve.test.ts`
(S2's A4-14 fix, which had to travel with Task 4's single commit).

---

## 2. Step 13's RED state, quoted

RED was captured by `git stash push` of ONLY the five S3-modified `app/src`
files, leaving S2's new composer/catalog and all the new tests in place, then
`git stash pop`. Both operations exited 0 and `git status` matched before and
after.

### Case 1 - the no-show draft resolves the tenant's first name: **RED**

```
 FAIL  test/tourRemindersApi.test.ts > resolved names on the tour-reminder compose paths > the no-show draft greets the tenant by first name
AssertionError: expected 500 to be 200 // Object.is equality

- Expected
+ Received

- 200
+ 500
```

Exactly the predicted failure mode: the pre-Step-8 route resolves
`tour.no_show_checkin` directly and the entry now carries `{tenantFirstName}`,
so strict mode throws and the route 500s.

### Case 2 - the throwing-property-read regression pin: **RED, and the plan predicted GREEN. Read this one.**

```
 FAIL  test/tourRemindersApi.test.ts > resolved names on the tour-reminder compose paths > REGRESSION PIN: a throwing property-contact read still answers the ladder 200
AssertionError: expected 500 to be 200 // Object.is equality

- Expected
+ Received

- 200
+ 500
```

**This red does NOT mean the pin is a real TDD driver.** The plan's "expected
green on first run" reasoning is about `resolveTourContactNames` never throwing,
and that reasoning is correct. The 500 here is an artefact of the INTERMEDIATE
tree I measured against: with S2's composer in place and Step 7 stashed, the
route's compose call passes no `names` at all, the composer dereferences
`names.tenantFirstName`, and every GET of a ladder 500s - throwing repo or not.
The pin was never RED for the reason it exists. Treat it as a pin, as the plan
says, not as evidence the withhold behaviour was test-driven.

### Case 3 - the poll's absence semantics: **RED**

```
 FAIL  test/tourRemindersApi.test.ts > resolved names on the tour-reminder compose paths > the poll SENDS to a tenant contact that exists but carries no name
AssertionError: expected [] to have a length of 1 but got +0

- Expected
+ Received

- 1
+ 0
```

Same underlying cause on the send side: the un-wired `composeBodyForRow` throws
a bare `TypeError` inside the per-row try, which is not
`UncomposableReminderError`, so it escapes to the poll's per-row catch and
nothing is sent.

### Case 4 - the group bucket names the property contact: **RED**

```
 FAIL  test/relayApi.test.ts > relay-group API (M1.7) > GET /api/conversations/:conversationId/scheduled > the en_route card NAMES the property contact on a landlord-led tour
Error: expected 200 "OK", got 500 "Internal Server Error"
```

GREEN run of all four after `git stash pop`:

```
 ✓ test/tourCopyCallSites.test.ts (1 test) 2ms
 ✓ test/tourRemindersApi.test.ts (32 tests) 471ms
 ✓ test/relayApi.test.ts (49 tests) 814ms
 ✓ test/toursApi.test.ts (183 tests) 2401ms

 Test Files  4 passed (4)
      Tests  265 passed (265)
```

---

## 3. A4-3 - how case 4 addresses the right repo

The worklist warns that `api.ts:966-971` prefers `deps.contactsRepoForRelay`
over `deps.contactsRepo`, so a relay test that INJECTS a contacts repo can
silently exercise a different one. Verified: **`makeWebhookHarness` never sets
`contactsRepoForRelay`** (grep returns hits only in `src/routes/api.ts`), so the
relay router receives `world.contactsRepo`.

Case 4 therefore does not inject a repo at all - it seeds
`c-landlord-dana` onto `world.contacts` and points the tour's unit at it, which
cannot address the wrong repo by construction. The reasoning is written into the
test as a comment so a future author who converts it to an injected throwing
repo (Task 5's case 6 will want exactly that) reads the hazard first. **Task 5:
if you inject, you must inject through `contactsRepoForRelay`, and
`makeWebhookHarness` has no option for it today - you will need to add one.**

## 4. A4-11 - the no-show draft's settings repo, VERIFIED

Step 8 adds `readQuietHoursWindow(settings, log)` to the draft handler, so the
question is whether `toursApi.test.ts`'s `makeWebhookHarness()` reaches that
mount with a fake.

It does, and nothing needed wiring:
`twilioWebhookHarness.ts:3892` passes `settingsRepo: world.settingsRepo` into
the `/api` router, and `api.ts:943` forwards the resolved `settings` local into
`createTourRemindersRouter`. No real DynamoDB `SettingsRepo` is constructed in
these unit tests. (Independently corroborated at runtime: the whole
`toursApi.test.ts` file - 183 tests - passes with no endpoint configured.)

---

## 5. Suite results, quoted

`cd app && npx vitest run` - **EXIT 1**, one failure:

```
 FAIL  test/messaging.integration.test.ts > messaging repos against DynamoDB Local (throwaway prefix) > messagesRepo > getManyByTsMsgIds chunks past the 100-key BatchGetItem limit
Error: Test timed out in 60000ms.

 Test Files  1 failed | 336 passed | 1 skipped (338)
      Tests  1 failed | 6000 passed | 9 skipped (6010)
```

This is AGENTS.md's ENVIRONMENTAL signature exactly: a DynamoDB Local suite,
a plain timeout, **zero assertion failures**, in a file this branch does not
touch (`messagesRepo.getManyByTsMsgIds` has no relationship to tour reminders).
Re-run of the failing FILE alone, per the documented discipline:

```
cd app && npx vitest run test/messaging.integration.test.ts
 Test Files  1 passed (1)
      Tests  18 passed (18)
```

EXIT 0. Attributed to `npm-test-dynamodb-local-contention`, not to Task 4.

**NO DynamoDB SUITE SELF-SKIPPED.** The only `SKIPPED` strings in the whole run
are three benign non-DynamoDB ones (`media seed SKIPPED - no MEDIA_BUCKET`,
`[staticSmoke] SKIPPED - no built dashboard`) plus one false positive from a
TEST NAME containing the word (`claim-SKIPPED as tenant_not_on_roster`).
`tourReminders.test.ts` ran its integration describe and passed; `seedLive.test.ts`
likewise. The one `1 skipped` test file is the staticSmoke suite.

Dashboard: `cd dashboard && npx vitest run` - **EXIT 0**

```
 Test Files  175 passed (175)
      Tests  2720 passed (2720)
```

Lint (gate 5, on all 19 touched files) - EXIT 1 with FOUR findings, **all four
byte-identical at the merge base** (verified by stashing the whole change and
re-running the same command):

```
app/src/routes/api.ts
  23:54  error  'normalizeStoredMediaType' is defined but never used.
app/src/routes/relayGroups.ts
  60:10  error  'resolveMessage' is defined but never used.
e2e/tests/scenarios/scheduled-visibility.spec.ts
  52:5  warning  Unused eslint-disable directive
  56:5  warning  Unused eslint-disable directive
```

ZERO new errors are attributable to this branch. Left unfixed per AGENTS.md
("fixing unrelated errors in a shared repo is its own change"); named here so
the next person does not re-diagnose them. Note the second one is a real
one-token cleanup someone could take: `relayGroups.ts` imports `resolveMessage`
and never calls it.

ASCII: every ADDED line across the whole diff scanned for `[^\x00-\x7F]` -
**0 hits**.

---

## 6. Deviations, with reasoning

### 6.1 `relayGroups.ts` bundles the five values into one `composeInputs` object

The plan's Step 10 snippet ends `const address = unit?.address; ... const names
= resolved.names;`, and A4-2 requires a `let unitReadFailed = false` that Task 4
does not read. Written literally, ESLint reports
`'unitReadFailed' is assigned a value but never used` - a NEW gate-5 error in a
file this slice touches. (Confirmed empirically, not assumed:
`@typescript-eslint/no-unused-vars` fires on the assigned-never-read form;
`noUnusedLocals` is NOT set in `tsconfig.base.json`, so `tsc` would have let it
through and only lint catches it.)

Resolution: keep every value A4-2 asks for, but bundle them -

```ts
const composeInputs = {
  ...(unit?.address !== undefined && { address: unit.address }),
  names: resolved.names,
  tenantReadFailed: resolved.tenantReadFailed,
  propertyReadFailed: resolved.propertyReadFailed,
  unitReadFailed,
};
```

The object-literal shorthand IS a read, so the flag is legal; the shape now
mirrors `composeInputsOf`'s return on the sibling route, which is a readability
win rather than a workaround; and Task 5 gets everything it needs.
`resolved` also stays in scope for Task 5. The comment above it says all of
this, including the lint reason, so nobody "tidies" it back into loose locals.

### 6.2 `tour-comms-pane.spec.ts`'s stale `scheduled - 24h` comment

Step 11 says to update it "to name the NEW anchor". The new anchor (19:30
org-local) does not exist until Task 6, so writing it now would make the comment
false for two tasks. I removed the offset claim instead and said explicitly that
`computeDueAt` owns the number, naming 19:30 as where it is going. The plan's
purpose (kill the stale duplicate) is served without asserting something the
tree does not yet do.

### 6.3 `app/src/routes/api.ts` is in the commit (one comment)

`api.ts:935-939` carries a THIRD copy of the "ONE unit read, TWO consumers"
claim that A4-13 corrects in the other two places, three lines from the
`unitsRepo:` line whose truth this change alters. Updated to THREE consumers.
Comment-only; adds no lint error (its one pre-existing error is on line 23 and
predates this branch). Flagging it because it is a file outside the plan's list.

### 6.4 Two `Address` type imports deleted

`jobs/tourReminders.ts` and `routes/relayGroups.ts` each imported
`type { Address }` solely for a local the Step 6/Step 10 rewrites remove. Left
in place they are gate-5 `no-unused-vars` errors on lines the diff never
touches - the exact trap AGENTS.md documents. `routes/tourReminders.ts` and
`routes/contactTimeline.ts` still use `Address`, so their imports stay.

### 6.5 A5-3's comment landed a task early

The `namesOnce` memo is keyed by `unitId` while `assessNamesReadFailure` takes a
`tourType`. That hazard is CREATED by Step 9, so its explanation is written at
the memo now rather than in Task 5. No behaviour.

### 6.6 `seedTourGroup` gained an optional parameter

`relayApi.test.ts`'s helper hardcoded `unitId: 'unit-1'`, which is never seeded,
so the new case could not attach a landlord contact. Added
`unitId = 'unit-1'` as a defaulted third parameter; every existing caller is
untouched.

---

## 7. THE CONTRACT TASK 5 INHERITS - byte-exact

### 7.1 `routes/tourReminders.ts` - `composeInputsOf`

```ts
const composeInputsOf = async (
  tour: TourItem,
): Promise<{
  address?: Address | string;
  names: TourContactNames;
  tenantReadFailed: boolean;
  propertyReadFailed: boolean;
  unitReadFailed: boolean;
}> => { ... };
```

Called in THREE handlers, each currently destructuring only two fields:

- PATCH: `const { address, names } = await composeInputsOf(tour);` (before the
  `if (!won)` branch)
- send-now: `const { address, names } = await composeInputsOf(tour);` then
  `const afterBody = bodyFor(after, tour, window.timezone, address, names);`
- GET list: `const { address, names } = await composeInputsOf(tour);` (above the
  suppression guard)

Task 5 widens those destructures to take the three flags.

`bodyFor`'s signature is now:

```ts
const bodyFor = (
  row: TourReminderItem,
  tour: TourItem,
  tz: string,
  address: Address | string | undefined,
  names: TourContactNames,
  tally?: ComposeFailTally,
): string => { ... }
```

Note `address` is now REQUIRED-positional (it lost its `?`), because `names`
follows it. Call sites pass `address` explicitly, `undefined` included.

### 7.2 `routes/contactTimeline.ts` - `UnitRead`, `UnitNames`, the two memos

```ts
interface UnitRead {
  unit: UnitItem | undefined;
  failed: boolean;
}
const unitReads = new Map<string, Promise<UnitRead>>();
const unitOnce = (unitId: string): Promise<UnitRead> => { ... };

type UnitNames = ResolvedTourNames & { unitReadFailed: boolean };
const nameReads = new Map<string, Promise<UnitNames>>();
const namesOnce = (unitId: string): Promise<UnitNames> => { ... };
```

`ResolvedTourNames` (imported as a type from `../lib/tourContacts.js`) is
`{ names: TourContactNames; tenantReadFailed: boolean; propertyReadFailed: boolean }`,
so a `UnitNames` value carries exactly the FOUR fields
`names`, `tenantReadFailed`, `propertyReadFailed`, `unitReadFailed`.

The tour walk currently reads:

```ts
const read = await unitOnce(tour.unitId);
const address = read.unit?.address;
const { names } = await namesOnce(tour.unitId);
```

Task 5 widens that destructure. `read.failed` is ALSO available directly, and is
the same boolean as `unitReadFailed` on the memo result - prefer the memo's, so
the assessor sees one source.

`tourReminderBodyOrEmpty`'s signature is now:

```ts
function tourReminderBodyOrEmpty(
  row: TourReminderItem,
  tour: TourItem,
  timezone: string,
  address: Address | string | undefined,
  names: TourContactNames,
  tally: ComposeFailTally,
): string
```

`gatherUpcoming`'s params interface gained
`contactsRepo: Pick<ContactsRepo, 'getById'>;` (destructured as `contactsRepo`,
passed from the route as `contactsRepo: contacts`).

### 7.3 `routes/relayGroups.ts` - the hoisted locals

In scope for the whole handler, ABOVE the `.map()`:

```ts
let unit: UnitItem | undefined;
let unitReadFailed = false;      // set true in the units.getById catch
// ... resolveTourContactNames -> `resolved` (a ResolvedTourNames)
const composeInputs = {
  ...(unit?.address !== undefined && { address: unit.address }),
  names: resolved.names,
  tenantReadFailed: resolved.tenantReadFailed,
  propertyReadFailed: resolved.propertyReadFailed,
  unitReadFailed,
};
```

Inside the IIFE the compose reads `composeInputs.names` and
`composeInputs.address`. **Task 5's withhold branch should consume
`composeInputs.*`, not the loose locals** - `resolved` and `unitReadFailed` are
still in scope, but routing everything through one object is what keeps the flag
read (see 6.1). Per A5-2, this surface has NO `sentBody` branch, so its
withhold check is unconditionally FIRST and the DUPLICATED SHAPE comments must
say the three copies differ in branch ORDER.

### 7.4 `jobs/tourReminders.ts` - `composeBodyForRow`

```ts
async function composeBodyForRow(
  row: TourReminderItem,
  tour: TourItem,
  window: QuietHoursWindow,
  deps: Pick<RunDueTourRemindersDeps, 'unitsRepo' | 'contactsRepo'>,
  log: Logger,
  tenantContact?: ContactItem,
): Promise<string>
```

It currently DISCARDS `resolved.tenantReadFailed` / `resolved.propertyReadFailed`
and its own unit-catch failure. Task 5 must surface them to the three callers -
the function returns a bare `string` today, so this is a return-shape change (or
an out-parameter), and all three call sites (`processReminderRow`,
`sendGroupReminder`, `forceSendReminder`) are affected.

### 7.5 The harness

`TourReminderContext` is `{ scheduledAt, timezone, tourType, names, address? }`.
`tourReminderContext(unit, times, { tourType, names })`.
`ActiveTour` carries `tourType: TourType` (required) and
`tenantFirstName?: string`; there is deliberately no property-contact field, so
no step helper can compose the landlord-led `en_route` body.

---

## 8. Noticed, not fixed

- **`relayGroups.ts:60` imports `resolveMessage` and never uses it.**
  Pre-existing (identical at the merge base), a one-token fix, and squarely the
  kind of unused-import gate 5 exists to catch. Left alone per the
  pre-existing-errors rule; someone should take it.
- **`api.ts:23` imports `normalizeStoredMediaType` unused.** Same class,
  pre-existing.
- **`scheduled-visibility.spec.ts:52,56` carry unused `eslint-disable` directives.**
  Warnings only, pre-existing, `--fix`-able.
- **A4-15 stands, untouched:** `services/rosterProvision.ts:525` is a third copy
  of the primary-contact rule WITHOUT the empty-string guard. Out of scope by
  the worklist's own ruling.
- **A9-8 is still nobody's.** `e2e/performance/collect.ts` fingerprints the
  SOURCE of `/api/tours/:tourId/reminders`
  (`CONTRACT_SOURCE_LEDGER.background.tourReminders`) and that source changed
  here. `e2e/performance/collect.test.ts` is NOT in the app workspace, so my
  `cd app && npx vitest run` did not cover it, and the e2e workspace suite is
  the orchestrator's run. **If the fingerprint is pinned, the orchestrator's
  `npm run e2e` is where it will surface.** Nobody has confirmed either way.
- **The GET ladder now pays TWO tenant reads per request.** `composeInputsOf`
  reads the tenant, and `resolveTenantSuppression` reads the same contact again
  a few lines later (A9's accepted per-request cost, but the DOUBLE read is
  new and specific). Task 5's brief already says `composeInputsOf` should
  "contain the OTHER tenant read on this route" - that is the fix, and it is a
  real per-request saving, not just tidiness.
- **`toursApi.test.ts`'s draft pin now proves the ABSENCE branch only.** The
  named-tenant half lives in `tourRemindersApi.test.ts`. Both are needed; a
  future consolidation that deletes one loses a real case.
- **The composer's `.trim()`** (A4-10, S2's note) still applies to
  `confirmation` and `no_show_checkin`; nothing in this slice changed that and
  no rendered output moved.
