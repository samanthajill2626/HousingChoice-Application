# SLICE S4 REPORT - Task 5 "Failure is not absence"

Worktree: `W:\tmp\tour-reminder-ladder`, branch `feat/tour-reminder-ladder`.
Base at slice start: `6c495d3a` (S3's Task-4 commit), tree clean.

**COMMIT: `f720c9a9`** - "feat(tours): scoped name-read failure - sends refuse,
entry-forks withhold, panel degrades". 17 files changed, 1194 insertions(+),
49 deletions(-). ONE commit, as the brief requires.

`npm run typecheck`: **EXIT 0**.
App suite: 6015 passed / 1 environmental failure, clean alone (section 5).
Dashboard suite: 2725 passed, EXIT 0.
`npm run e2e`, `npm test`, `npm run smoke` NOT run - a later phase owns them.

---

## 1. THE FIVE CONSUMERS - explicit checklist

Every one gates on the SHARED `assessNamesReadFailure`; none reads a bare flag.

| # | consumer | gate | file:line |
| --- | --- | --- | --- |
| 1 | `composeBodyForRow` (ALL send paths: `processReminderRow`, `sendGroupReminder`, `forceSendReminder`) | `impact.blocksSend` -> `throw new ReminderNamesUnavailableError` | `app/src/jobs/tourReminders.ts:613` (assessor call `:606`; error class `:91`) |
| 2 | `routes/tourReminders.ts` `bodyFor` (preview) | `.withholdPreview` -> `return ''` | `app/src/routes/tourReminders.ts:300` (rule comment `:286`) |
| 3 | `routes/contactTimeline.ts` `tourReminderBodyOrEmpty` (preview) | `.withholdPreview` -> `return ''` | `app/src/routes/contactTimeline.ts:758` (rule comment `:746`) |
| 4 | `routes/relayGroups.ts` scheduled bucket (preview) | `.withholdPreview` -> `return ''` | `app/src/routes/relayGroups.ts:310` (rule comment `:298`) |
| 5 | the no-show DRAFT handler (SEND posture, 409) | `impact.blocksSend` -> `res.status(409).json({ error: 'names_unavailable' })` | `app/src/routes/tourReminders.ts:683` / `:688` (assessor call `:676`) |

The TWO bare-read containments:

| containment | file:line |
| --- | --- |
| `resolveTenantSuppression` at its CALL SITE (try/catch, `suppressionOf` left UNASSIGNED so the no-IO `paused` fallback still fires) | `app/src/routes/tourReminders.ts:558-571` (warn `:567-570`) |
| force-send's TARGET RESOLUTION (BLANKET catch kept, inlined return because `refuse` is declared below) | `app/src/jobs/tourReminders.ts:1290-1299` (warn `:1296`) |

Plus `forceSendReminder`'s compose catch (`:1368-1369`, `refuse('names_unavailable')`),
`ForceSendRefusal`'s new `'names_unavailable'` member (`:1212-1218`), and the
`ReminderNamesUnavailableError` class (`:81-96`, docblock from `:81`).

The dashboard half:

| piece | file:line |
| --- | --- |
| `SEND_NOW_ERROR_COPY['names_unavailable']` | `dashboard/src/api/types.ts:1304-1313` (key `:1312`) |
| `TourDetail.tsx` draft catch, `err.code` (NEVER `err.message`) | `dashboard/src/routes/tours/TourDetail.tsx:346-357` (the code test `:354`) |
| `RemindersPanel.tsx` blank-preview note | `dashboard/src/routes/tours/RemindersPanel.tsx:365-385` (the note `:378`) |
| `ScheduledCard.tsx` blank-preview note | `dashboard/src/routes/contact/ScheduledCard.tsx:98-110` (the note `:105`) |

---

## 2. Per numbered case - observed RED, quoted

RED was captured by running the four app test files and the three dashboard
test files against the tree AS S3 LEFT IT (implementation untouched, new tests
in place). Full logs are in the session scratchpad.

App suite RED run: `Test Files 3 failed | 1 passed (4)`, `Tests 8 failed | 196 passed (204)`.
Dashboard RED run: `Test Files 3 failed (3)`, `Tests 4 failed | 127 passed (131)`.

### Case 1 - POLL defers en_route on a throwing property read: **RED**

```
FAIL test/tourReminders.test.ts > ... > case 1: the POLL DEFERS an en_route rung
     whose property-contact read threw - unclaimed, not sent
AssertionError: expected [ { ...(4) } ] to have a length of +0 but got 1
```

Exactly the predicted shape: the resolver swallowed the throw and the poll SENT
the degraded self-guided body.

### Case 2 - FORCE-SEND refuses representably: **RED**

```
FAIL test/tourReminders.test.ts > ... > case 2: FORCE-SEND refuses representably
     with names_unavailable and leaves the row pending
AssertionError: expected { outcome: 'sent' } to deeply equal { outcome: 'refused', ...(1) }
```

### Case 3 - end-to-end degrade JOIN: **GREEN on first run, MUTATION-CHECKED**

Green as the plan allows ("this is red only if Task 4 mis-wired the join").
Verified by mutation per the plan's instruction - temporarily gave `c-ll` a
`firstName: 'MUTATION'` and re-ran:

```
AssertionError: expected 'Hey Tam, MUTATION will be headed that...' to be
                         'Hey Tam, can you please text me when ...'
Expected: "Hey Tam, can you please text me when you're on the way?"
Received: "Hey Tam, MUTATION will be headed that way shortly. Can you please
           text here when you're on the way?"
```

The body really does flip on the landlord's name, so the self-guided assertion
is load-bearing. The mutation was RESTORED and the test kept.

### Case 4 - send-now ROUTE surfaces the refusal: **RED**

```
FAIL test/tourRemindersApi.test.ts > ... > case 4: send-now answers 409
     names_unavailable and leaves the rung upcoming
AssertionError: expected 200 to be 409 // Object.is equality
```

### Case 5 - PREVIEW WITHHOLDING on the reminders API: **RED**

```
FAIL test/tourRemindersApi.test.ts > ... > case 5: the GET ladder WITHHOLDS only
     the en_route body - day_before composes normally
AssertionError: expected 'Hey there, can you please text me whe...' to be ''
```

### Case 6 - PREVIEW WITHHOLDING on the group bucket: **RED**

```
FAIL test/relayApi.test.ts > relay-group API (M1.7) >
     GET /api/conversations/:conversationId/scheduled >
     WITHHOLDS the en_route card body when the property-contact read throws, and only that one
AssertionError: expected 'Hey there, can you please text me whe...' to be ''
```

### Case 7 - property names memoized PER UNIT: **GREEN on first run, as declared**

Ran alone before implementation: `Test Files 1 passed (1)`, `Tests 1 passed |
46 skipped (47)`, EXIT 0. It is a pin; kept.

### Case 8 - per-tour correctness on the reminders API: **GREEN on first run, as declared**

Passed inside the RED run (`pin 8: two landlord-led tours on DIFFERENT units
each render their OWN landlord in en_route`). Pin; kept.

### Case 9 - the DRAFT refuses (the FIFTH consumer): **RED**

```
FAIL test/tourRemindersApi.test.ts > ... > case 9: the no-show DRAFT refuses with
     409 names_unavailable when the tenant read throws
AssertionError: expected 200 to be 409 // Object.is equality
```

### Case 10 - the PANEL survives a tenant-read failure: **RED (a 500)**

```
FAIL test/tourRemindersApi.test.ts > ... > case 10: the PANEL survives a
     tenant-read failure - 200, degraded bodies, every rung still `paused`
AssertionError: expected 500 to be 200 // Object.is equality
```

Exactly the predicted cause: `resolveTenantSuppression`'s bare `contacts.getById`
rejects and Express 5 turns it into a 500 for the whole ladder.

### Case 11 - draft 409 renders OPERATOR copy: **RED**

```
FAIL src/routes/tours/TourDetail.test.tsx > ... > a 409 names_unavailable shows
     OPERATOR copy and prefills nothing
Expected element to have text content:
  Could not look up everything this message needs, so nothing was sent - please try again.
Received:
  names_unavailable
```

### Case 12 - draft 404 gets the LOAD-shaped fallback: **RED (the raw code, as the brief warned)**

```
FAIL src/routes/tours/TourDetail.test.tsx > ... > a 404 keeps the LOAD-shaped
     fallback, never the send map and never the raw code
Expected element to have text content:
  Could not load the check-in message
Received:
  tour_not_found
```

Confirmed RED for the stated reason and **NOT re-baselined**: today's catch takes
its `err instanceof ApiError` branch and renders `err.message` raw, so the
load-shaped fallback string really is unreachable.

### Case 13 - FORCE-SEND refuses on a throwing TENANT read: **RED (a rejection, as predicted)**

```
FAIL test/tourReminders.test.ts > ... > case 13: FORCE-SEND refuses when TARGET
     RESOLUTION throws - the dominant failure cell
Error: contacts unavailable
 -> resolveReminderTarget src/jobs/tourReminders.ts:673:43
 -> forceSendReminder src/jobs/tourReminders.ts:1198:18
```

The throw escaped `resolveReminderTarget` unwrapped, exactly as stated.

### Case 14 - the blank preview carries a sentence: **RED on BOTH surfaces**

```
FAIL src/routes/tours/RemindersPanel.test.tsx > ... > an empty body renders the
     "Preview unavailable" note, not bare emptiness
TestingLibraryElementError: Unable to find an element with the text:
  Preview unavailable - this message cannot be composed right now.

FAIL src/routes/contact/ScheduledCard.test.tsx > ScheduledCard > a withheld
     tour-reminder body renders the "Preview unavailable" note
TestingLibraryElementError: Unable to find an element with the text:
  Preview unavailable - this message cannot be composed right now.
```

C5 honoured: `dashboard/src/routes/contact/ScheduledCard.test.tsx` exists (165
lines), so the plan's conditional was dead and the pin was added THERE as well
as in `RemindersPanel.test.tsx`. A second ScheduledCard case pins the negative
(an empty NUDGE body gets no note) - the branch is source-scoped.

### Guards g1, g2, g3 (+ g3b) - **GREEN on first run, as declared**

All four passed inside the RED run:

```
 v ... guard g1: a landlord-row outage does NOT block a day_before - the poll still sends it
 v ... guard g2: a throwing UNIT read still sends a day_before, without an address
 v ... guard g3: a confirmation force-send SENDS with the unit read throwing
 v ... guard g3b: a confirmation force-send SENDS with only the property-contact read throwing
```

g3b is the plan's optional "SECOND case with the unit read SUCCEEDING and only
`getById('c-boom')` throwing" - written, because g3 alone cannot cover the
property read (the fixture fact the plan warns not to "fix").

**No case that the plan listed as red was green before implementation, and no
red case was re-baselined.**

---

## 3. Worklist corrections - how each was honoured

- **C1** - the carve-out sentence was located BY TEXT ("a reminder must never be
  lost over a missing street"), not by line, and the whole clause is intact. The
  carve-out paragraph was APPENDED below it rather than rewriting it.
- **C2** - the D7 gate was verified in the live tree at `jobs/tourReminders.ts:797`
  (`deps.pendingRosterActionsRepo !== undefined`), and `createGroupTestRig` omits
  that dep, so the shared fixture cannot be held by the wait. Written into the
  fixture's docblock as precondition (a).
- **C3** - `RemindersPanel.tsx`'s body `<p>` was found at `:365-367` with the
  template className; the edit branches AROUND it rather than patching the
  plan's quoted string (which does not exist).
- **C4** - `ScheduledCard.tsx`'s `styles` resolves to `./Timeline.module.css`,
  which has no `.muted`. A NEW class `.scheduledBodyUnavailable` was added there,
  matching the sheet's conventions (`margin-top: var(--sp-1)`, `--c-text-subtle`,
  `--fs-sm`), with a comment stating why `.scheduledSkipMuted` was NOT reused.
  No inline styles.
- **C5** - see case 14 above.

## 4. Worklist additions - all four landed

- **A5-1** - `suppressionEstimateFailed` added as a local
  (`routes/tourReminders.ts:500-505`) and emitted on the `tour reminders read`
  log line (`:626`), with a comment saying a false `suppressed` means "unknown"
  rather than "nothing held back" whenever the flag is true.
- **A5-2** - all three DUPLICATED SHAPE comments now say the copies differ in
  branch ORDER, and say WHY relayGroups cannot be aligned (no sentBody to read).
  See `routes/tourReminders.ts:253-271`, `routes/contactTimeline.ts:716-730`,
  `routes/relayGroups.ts:282-296`.
- **A5-3** - the comment already landed a task early (S3's deviation 6.5) at
  `contactTimeline.ts:904-909`. Verified it says exactly what A5-3 asks
  (keyed by unitId, assessor takes tourType, safe only because the RESOLVER does
  not branch on tour type, and the assessor is called per TOUR). The one edit
  was dropping the now-stale "(Task 5)" forward reference.
- **A5-4** - the draft handler's route comment now enumerates the THREE terminal
  shapes (`routes/tourReminders.ts:651-656`) and says the 409 is the SEND
  posture.

---

## 5. Verification, quoted

### `npm run typecheck` (from the worktree root) - **EXIT 0**

Covers app src + app scripts + app tests, dashboard, e2e, fake-twilio,
fake-twilio-web. The S2/S3 trap did NOT fire this slice, but the gate was run
because a green vitest is not proof a signature threaded.

### App suite - `cd app && npx vitest run` - EXIT 1, ONE failure

```
 FAIL  test/messaging.integration.test.ts > messaging repos against DynamoDB Local
       (throwaway prefix) > messagesRepo > getManyByTsMsgIds chunks past the
       100-key BatchGetItem limit
Error: Test timed out in 60000ms.

 Test Files  1 failed | 336 passed | 1 skipped (338)
      Tests  1 failed | 6015 passed | 9 skipped (6025)
```

AGENTS.md's ENVIRONMENTAL signature exactly: a DynamoDB Local suite, a plain
timeout, **zero assertion failures**, in a file this branch does not touch -
and the SAME file and SAME test S3 hit. Re-run per the documented protocol:

```
cd app && AWS_ACCESS_KEY_ID=hccleanrun001 npx vitest run test/messaging.integration.test.ts
 Test Files  1 passed (1)
      Tests  18 passed (18)
```

EXIT 0. Attributed to `npm-test-dynamodb-local-contention`, not to Task 5.

**NO DynamoDB SUITE SELF-SKIPPED.** The only `SKIPPED` strings in the whole run
are the three benign ones - `SKIPPED - no MEDIA_BUCKET configured`,
`SKIPPED - no built dashboard`, and one false positive from a TEST NAME
(`claim-SKIPPED as tenant_not_on_roster`). `tourReminders.test.ts` ran its
integration describe and passed (all nine new cases inside it executed); the
one `1 skipped` FILE is the staticSmoke suite.

### Dashboard suite - `cd dashboard && npx vitest run` - **EXIT 0**

```
 Test Files  175 passed (175)
      Tests  2725 passed (2725)
```

(2720 at S3 + the 5 cases this slice adds: 2 TourDetail, 1 RemindersPanel,
2 ScheduledCard.)

### Lint (not a brief requirement; run as hygiene) - EXIT 1, THREE findings, ALL pre-existing

Verified by BASELINE COMPARISON, not by line number: the same command was run
on the same paths with the whole change stashed, and produced byte-identical
findings (only a line number shifted, by the one import line this change adds).

```
app/src/routes/relayGroups.ts
  60:10  error  'resolveMessage' is defined but never used.
dashboard/src/routes/contact/ScheduledCard.tsx
  63:9   error  Cannot call impure function during render  (`now = Date.now()`)
dashboard/src/routes/tours/TourDetail.tsx
  269:85 error  Cannot call impure function during render  (`... <= Date.now()`)
      (268:85 at the baseline - shifted by the sendNowErrorMessage import)
```

ZERO new errors attributable to this slice. Left unfixed per AGENTS.md; named
here so nobody re-diagnoses them.

### ASCII

Every ADDED line across the whole diff scanned for `[^\x00-\x7F]` - **0 hits**.

### Commit hygiene

Bare `git status` read first (17 modified files, nothing else); `.git/MERGE_HEAD`
confirmed **ABSENT**; 17 EXPLICIT paths staged; no `git add -A`. The first
commit attempt used a PowerShell here-string inside the Bash tool and produced a
subject prefixed with a literal `@ `; it was `--amend`ed immediately (local,
unpushed) to the plan's exact Step-5 message. Final hash `f720c9a9`, tree clean.

---

## 6. Deviations, with reasoning

### 6.1 `bodyFor` / `tourReminderBodyOrEmpty` take ONE `flags` OBJECT, not three booleans

The plan's snippet reads `flags.tenantReadFailed` etc. but never states the
parameter's shape. Both functions take a single
`flags: { tenantReadFailed; propertyReadFailed; unitReadFailed }` and the call
sites pass it by rest-destructuring the producer:
`const { address, names, ...readFlags } = await composeInputsOf(tour)` and
`const { names, ...nameFlags } = await namesOnce(tour.unitId)`.

Three separate positional booleans on a function that already has six parameters
is a wrong-order bug waiting to happen (all three are `boolean`, so the compiler
would not catch a swap), and the rest-destructure means a future fourth flag
threads itself. On the timeline this also settles the plan's `read.failed` note
in the memo's favour by construction: `nameFlags.unitReadFailed` comes from
`namesOnce`, so the assessor sees exactly one source.

### 6.2 `RemindersPanel.module.css` gains a NEW `.bodyUnavailable` class

The plan says "reuse the panel's existing muted-note styling - `.muted`". `.muted`
exists, but it is the PANEL-level empty state (`margin: 0`) and is defined at
`:16`, BEFORE `.body` at `:151`. Composing `${styles.body} ${styles.muted}` loses
to `.body` on every property they share (equal specificity, later rule wins), so
the reuse would have been a no-op; using `.muted` alone would drop the row's top
margin and make the note collide with the row head.

`.bodyUnavailable` is added directly after `.body`, with `.body`'s exact metrics
plus italic and `--c-text-subtle`, and a comment recording why `.muted` was not
reused so nobody "consolidates" it back. This is C4's ruling applied to the
sibling sheet; the plan only corrected ScheduledCard's.

### 6.3 The commit adds THREE paths beyond the plan's Step-5 `git add` list

`dashboard/src/routes/tours/RemindersPanel.module.css` and
`dashboard/src/routes/contact/Timeline.module.css` (the two new muted classes -
C4 forbids inline styles) and
`dashboard/src/routes/contact/ScheduledCard.test.tsx` (C5: the file exists, so
case 14's pin belongs there too). All three are required by corrections the
worklist makes and the plan's file list predates.

### 6.4 The deferral warn is asserted at its FULL Step-3 wording

The plan's Step 1 quotes `'tour reminder: name resolution read failed - leaving
the rung unclaimed'`; its Step 3 snippet emits `'... unclaimed for the next
tick'`. The tests assert the SHIPPED (Step 3) string exactly, with a comment
saying Step 1 quotes a prefix. Same for case 13's warn: Step 1 quotes
`'tour reminder force-send: target resolution read failed'`, the snippet emits
`'... - row left pending'`, and the test asserts the full string.

### 6.5 Case 3's fixture uses `seedForceTenant` + `Object.assign`

The named tenant is seeded through the file's existing `seedForceTenant` helper
(which also creates the 1:1 conversation the poll needs) and given its
`firstName` with `Object.assign`, the idiom the rest of the suite uses for
post-seed contact tweaks. `world.contacts.push` alone would not have supplied
the conversation.

### 6.6 Case 6 shims `world.contactsRepo.getById` rather than injecting a repo

A4-3 warns that `api.ts` prefers `deps.contactsRepoForRelay` over
`deps.contactsRepo`, so an INJECTED throwing repo can silently exercise the
wrong one, and the S3 report notes `makeWebhookHarness` has no option for
`contactsRepoForRelay` today. Mutating the method on the shared `world.contactsRepo`
OBJECT sidesteps the question entirely - it is the same object either binding
resolves to - so no harness option had to be added. The reasoning is written
into the test.

### 6.7 The rest-destructure in `bodyFor`'s four call sites

Confirmed FOUR, not five, exactly as the plan says: the PATCH 409 echo, the
PATCH success echo, the send-now echo, and the GET list map. Typecheck
enumerated the set; no fifth exists.

---

## 7. Noticed, not fixed

- **`ScheduledCard.tsx:63` and `TourDetail.tsx:269` are `react-hooks/purity`
  errors on `Date.now()` defaults.** Both PRE-EXISTING (byte-identical at the
  baseline), both on lines this change never touched, and both are real: a
  component reading the wall clock during render. Out of scope; naming them
  because they are now two of the three findings on this branch's touched-file
  lint and the next person will see them.
- **`relayGroups.ts:60` still imports `resolveMessage` unused.** S3 flagged it;
  still a one-token cleanup nobody has taken.
- **The GET ladder still pays TWO tenant reads per request.** This slice DID
  contain `resolveTenantSuppression`, but deliberately did NOT merge the two
  reads - the plan rules the doubling accepted (per-request, not per-rung) and
  the containment's comment says so in terms, precisely so a future reader does
  not "optimize" the estimate's failure into the body's. S3's handback listed
  the merge as "the fix"; the plan overrode that, and the plan won.
- **A PERMANENTLY failing read re-lists every tick with no bound.** Accepted for
  Phase A (the poll sits behind the manual-only filter, and spec 8.2 grants no
  reason token for a bounded escalation). The acceptance is written at the
  `sendGroupReminder` catch and is owed as item (7) of the Phase B ledger issue
  Task 10 creates. **Task 10 must not drop it** - the code comment points at a
  ledger that does not exist yet.
- **A5-5 stands, untouched:** `forceSendReminder`'s `reason: 'tour_missing'` when
  the ROW is missing is still misleading and still pre-existing.
- **A9-8 is still nobody's.** `e2e/performance/collect.ts` fingerprints the SOURCE
  of `/api/tours/:tourId/reminders`, and that source changed AGAIN here. The e2e
  workspace suite is not in this slice's run.
- **The withhold is invisible to any test of the SENT-snapshot branch.** On
  `bodyFor` and `tourReminderBodyOrEmpty` the snapshot renders ABOVE the withhold,
  so a sent rung is untouched by construction; relayGroups has no such branch and
  needs none (pending-only filter). Nothing tests the sent-rung-plus-failed-read
  cell, because it cannot arise on the group surface and is trivially covered by
  the existing snapshot pins elsewhere. Recording it so a reviewer does not read
  the branch-order asymmetry as an untested hole.
- **`SEND_NOW_ERROR_COPY` has no coverage test for the new key.** A10-11 (Task 10)
  adds the enumerate-literally guard for SKIP REASONS; the send-now map has an
  older `SERVER_CODES`-style pin in `types.test.ts` that this key is not in.
  Deliberately left to its owner rather than half-extended here.
