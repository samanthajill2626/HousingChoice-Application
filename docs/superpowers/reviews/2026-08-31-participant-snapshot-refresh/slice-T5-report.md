# T5 slice report - relay members panel + calls passthrough

Commit: `871ebefd` (feat) on `feat/participant-snapshot-refresh`, parent `98d6cf47`.

Files: `app/src/routes/relayGroups.ts`, `app/src/routes/api.ts`,
`app/test/relayApi.test.ts`, `app/test/voiceWebhook.test.ts`.

## Reversed ruling - the two retitled pins

Both pinned the 2026-07 behavior Cameron overrode on 2026-08-31 (spec decision 2:
the stored name is the MIDDLE rung, not something a blip erases).

| old title (`relayApi.test.ts`) | new title |
|---|---|
| `GET roster drops the creation-time name when the current contact is unnamed` (:427) | `GET roster keeps the creation-time name when the current contact is unnamed (M1 ruling 2026-08-31)` |
| `GET roster falls back to the roster phone, not a stale name, when contact lookup fails` (:450) | `GET roster keeps the stored name when the contact read fails (M1 ruling 2026-08-31)` |

Expectation in both moved from `[{ contactId: 'c-alice', phone: ALICE }]` to
`[{ contactId: 'c-alice', phone: ALICE, name: 'Old roster name' }]`. The second
test's injected failure moved from `contactsRepo.getById` to
`contactsRepo.getDisplaysByIds` because `getById` is no longer called on this
path. The reversal is named in the commit body.

## Red evidence

`cd app && npx vitest run test/relayApi.test.ts -t "GET roster"` (exit 1):

```
 Test Files  1 failed (1)
      Tests  3 failed | 2 passed | 47 skipped (52)
```

- pin 1: `expected [ { contactId: 'c-alice', ... } ] to deeply equal ...`,
  received row missing `"name": "Old roster name"`.
- pin 2: same shape - `- "name": "Old roster name"` absent from the received row.
- new batch test: received roster missing `"name": "Stored Bob"` on `c-missing`.

`cd app && npx vitest run test/voiceWebhook.test.ts -t "resolved names"` (exit 1):

```
 FAIL  test/voiceWebhook.test.ts > GET /api/calls/:callId (M1.9a, authed) >
       RED: GET /api/calls/:callId hands back a roster with resolved names
 AssertionError: expected 'Bob' to be 'Robert Renamed'
 Test Files  1 failed (1)
      Tests  1 failed | 40 skipped (41)
```

The plan's predicted red value (`'Bob'`) was exact.

## Green evidence

`cd app && npx vitest run test/relayApi.test.ts test/voiceWebhook.test.ts
test/relayGroupPreview.test.ts test/voiceRecording.test.ts`:

```
 Test Files  4 passed (4)
      Tests  141 passed (141)
EXIT=0
```

`npm run typecheck` (bare, from the worktree root): `TYPECHECK_EXIT=0`.

Neighbour sweep: `grep -rn "}/members\`" app/test` shows `relayApi.test.ts` is the
ONLY suite that calls `GET /api/conversations/:id/members`.
`placementsApi.test.ts` / `toursApi.test.ts` hit `/api/{tours,placements}/:id/roster/members`
- a different, untouched, owner-scoped route. `contactTimeline.test.ts` and
`seedMatrix.test.ts` mention `/api/calls/` in comments only.
`voiceRecording.test.ts` hits `/api/calls/:callId/recording` (untouched, same
router file) and was run anyway - green, 35 tests.

## Divergences from the plan

1. Added `test/voiceRecording.test.ts` to the Step 5 green run (not in the plan).
   It is the other consumer of the `/api/calls/` prefix in the touched router;
   cheap insurance. Green.
2. Kept the literal `RED: ` prefix on both NEW test titles, matching the plan's
   quoted code and the convention already committed by T2/T3/T4
   (`contactRelayGroups.test.ts:290`, `todayApi.test.ts:1798`). The two rewritten
   PINS carry no prefix, as the plan gives them.
3. Nothing else. Worklist anchors all matched exactly: replace region
   `relayGroups.ts:481-506`, `nameFromContact` used only at `:491` (removed from
   the `:39` import; `resolveMemberName` at `:422` untouched), `api.ts:2201`,
   pins at `:427-448` / `:450-470`, `vi` absent from the vitest import (added).

## Open worries

- The removed catch block also removed its `log.warn` ("relay roster contact
  lookup failed..."). The warn still happens, once per request instead of once
  per member, inside `resolveRosterNames` with the string "participant names:
  batch read failed - stored names stand". No test asserted the old string.
- `withLiveNames` returns `{ ...p }` copies, so the response is a new array; the
  stored conversation is untouched. Confirmed by the passing pins.
- `GET /api/calls/:callId` now awaits one extra batch read before responding.
  Cost is one `getDisplaysByIds` over a single relay roster (2-3 ids typical);
  the never-rejects posture of `resolveRosterNames` means a repo failure
  degrades to stored names, not a 500.
- Untested by this slice: the dashboard QuickReply seam's own rendering of
  `conversation.participants`. No client change was in scope.
