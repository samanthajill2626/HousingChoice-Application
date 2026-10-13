# Build research (Phase 1) - orchestrator adjudications

Date: 2026-10-13. Orchestrator (manual mode) on `feat/last-heard-from` @25adc1ef.
Four read-only readers checked plan v3 against the live tree (code byte-identical
to f6aba402; branch 0 behind main @16ca96cc). Findings files in this folder:
`inbound-findings.md`, `outcome-findings.md`, `matching-findings.md`,
`tenants-e2e-findings.md`. The orchestrator re-read the cited lines for every
HIGH finding before ruling (listingSendsApi.test.ts:9, unmatchedEmail.ts:81-84,
groupTextWebhook.test.ts:137-155, importOrgNames.test.ts:77-86,
mutationCatalog.test.ts:380) - all confirmed.

No finding is a product decision; all are code-level corrections to plan text.
Each ruling below is a binding correction for the named slice's builder. Where a
ruling and the plan disagree, the ruling wins.

## Inbound (S1, S2)

- IB1 ACCEPTED (Task 1.10). Widen the `contactsRepo` Pick at
  `app/src/routes/unmatchedEmail.ts:81-84` with `'findByPhone' |
  'touchLastHeardFrom'`; add both members (stubs) to the `MemoryContacts` fake
  in `app/test/unmatchedEmailRoutes.test.ts:129-173`. Same commit as 1.10.
- IB2 ACCEPTED (Task 1.3). Knowing rewrite of the exact repo-call list in
  `app/test/groupTextWebhook.test.ts:137-155`: insert
  `'contacts.touchLastHeardFrom'` after `'contacts.touchPhoneLastSeen'` with a
  comment that the touch is 1:1-path work. Same commit as 1.3.
- IB3 ACCEPTED (Task 1.12). Narrow `contactUpdate()` in
  `app/test/importOrgNames.test.ts:77-86` to the upsert (skip the stamp's
  `SET #lhf = :at` UpdateCommand, matched on its UpdateExpression). Same commit
  as 1.12; the builder must match the stamp's ACTUAL UpdateExpression text.
- IB4 ACCEPTED (Task 1.13A). `GetCommand` is already imported in
  `app/test/seedProfile.integration.test.ts:13`; do not add it again.
- IB5 ACCEPTED (Task 1.8). Cases 2, 3, 4 and 7 call `seedRelay(world)` first.
- IB6 ACCEPTED (Task 2.1 Half 1 case 6). Expect FOUR distinct contacts
  (`latest.size === 4`), 2 unattributed.
- IB7 NOTED. Anchor on text, not line numbers.
- IB8 ACCEPTED as a record. The S1 I1 audit (1.13B) and the final
  `i1-audit-final.md` name the seed/live-seed/performance-seed Puts, the bulk
  deletes and the fresh-id-only creators. The seed runner's full Put
  (`app/src/lib/seed/index.ts:153`) moving a live-touched value backward on a
  NON-resetting re-seed is the ACCEPTED dev-only exception (spec I1 already names
  the seed derivation as a direct writer; `/__dev/reseed` and `--seeded` reset
  first).

## Outcome (S3, S5)

- F1 ACCEPTED (Task 3.6). `app/test/listingSendsApi.test.ts:9` becomes a VALUE
  import carrying `IncompleteBatchReadError` and `type ContactItem` (the
  `contactsBatchIncomplete.test.ts:33-37` shape).
- F2 ACCEPTED (Task 5.1). The partner case's negative assertion anchors on
  `Mark Cora Reyes interested in` (not the unanchored `/interested in/`).
- F3 ACCEPTED (Tasks 5.1, 6.5, 7.3 - with tenants-e2e F1). Contract N1 holds on
  every surface: spread `title` only when non-empty (S4's conditional form). Plan
  sites: SendRosterRow date spans, RecipientPreview `cellHeard`, FollowUpView
  date spans.
- F4 ACCEPTED (Task 3.3). Import only `DeclineRecord` in 3.3; `InterestedMode`
  and `ListingSendOutcome` arrive in 3.6 when first used.
- F5 ACCEPTED as a record. The seed runner's full Put of the five seeded
  `listing_sends` rows drops `declined` on a NON-wiping re-seed; dev-only. The
  3.3 repo header's NO-RESET note names it as the accepted exception.
- F6 NO CHANGE. The route's `listByUnit` filtered to the tenant reads the same
  pair set as spec 5.4's `listByTenant` filtered to the unit.
- F7 NO CHANGE (the fourth throwing fake is assignment-compatible).
- F8 NOTED. Anchor on quoted text; earlier slices shift lines.

## Matching (S6, S7) and cross-area

- F1 ACCEPTED, BLOCKING (Task 3.8). `setListingSendOutcome` is a dashboard POST,
  so `e2e/performance/mutationCatalog.ts` gains its entry (interception =
  `isCatalogPathIntercepted(pathCategory)`) and
  `e2e/performance/mutationCatalog.test.ts:380` moves 120 -> 121 with a comment.
  Verify with the e2e workspace's vitest on that file.
- F2 ACCEPTED (new Task 7.5, after 7.4). Keep `npm run perf:pages` honest: add a
  template for `/api/broadcasts/follow-ups` that wins over
  `/api/broadcasts/:broadcastId`, declare the GET on the `/broadcasts` and
  `/listings` surfaces (not `/listings/deleted`; `UNIT_LIVE_WALK` stays shared
  and untouched), and update the pins in `e2e/performance/routes.test.ts`.
  Verify with the e2e workspace's vitest on the performance tests. Rationale:
  the plan already keeps perf honest in S4.6; a known `unexpected_endpoint` is
  cheaper to fix now than to rediscover.
- F3 ACCEPTED (Task 6.3). Two of the three new C6 cases go RED; `keeps a short
  list below the input when it fits there` is a PIN (already green).
- F4 ACCEPTED (Task 7.1). Do NOT create `app/src/lib/contactDisplay.ts` and do
  not touch `displayNameOfContact` in `units.ts`. `services/followUps.ts`
  imports `contactDisplayName` from `../lib/contactName.js` (identical logic,
  verified side by side: part-wise trim, join, undefined when empty).
- F5 ACCEPTED (Task 6.5). Both `RecipientPreview.tsx:146` (`return rows`) and
  `:147` use `orderedRows`.
- F6 ACCEPTED (Task 6.2). Anchor the api.ts edit inside
  `createBroadcastsRouter({` on the comment at api.ts:1101, not on `events,`.
- F7 ACCEPTED (Task 8.3, with tenants-e2e F3). The sweep greps `e2e/scenarios/`
  too; the commit body says "no e2e selector reads a checkbox name SUFFIX"
  (`steps.ts:1079-1083` selects by a first-name PREFIX and survives).
- F8 NOTED (line drift).
- F9 ACCEPTED (7.3, 7.4 tests). `beforeEach` uses a block body.
- F10 ACCEPTED (7.3 tests). The in-place assertion after Not interested waits for
  the `Undo not interested for <name>` button, not `findByText('Not interested')`.

## Tenants and e2e (S4, S8)

- F1 see outcome F3.
- F2 ACCEPTED (Task 4.6, small). `contactListTerminal('Tenants')` in
  `e2e/performance/routes.ts` also accepts "No tenants match the selected
  filters." so an all-hidden world reads as ready, not a timeout.
- F3 see matching F7.
- F4 ACCEPTED (Task 8.2). Never assert a row, link or option by
  `freshTenant(...).name`; use first name + "Tester" or the `createTenant`
  helper's full name.
- F5 NOTED (citation drift; spec 14.4 overrides section 8 (3), and plan 8.3
  already follows 14.4).

## Build shape (orchestrator)

Slices stay in the plan's order, one implementer at a time. The larger slices
are split into sequential dispatches at task boundaries so each child starts
with fresh context: S1 (1.1-1.6 | 1.7-1.14), S3 (3.1-3.5 | 3.6-3.8), S5
(5.1-5.2 | 5.3-5.5), S7 (7.1-7.2 | 7.3-7.5).
