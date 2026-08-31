# Task 4 final fixture re-review

## Result

FAIL - the prior A -> B -> C fixture-fidelity finding is closed, but the
correction introduced one Important proof regression in two neighboring
`pendingTypeRun` call sites. The exact-casing production-route proof remains
intact.

## Finding

### Important 1 - The shared helper correction silently removes proposed type metadata from the empty-snapshot and finalization-handoff fixtures

Evidence:

- `pendingTypeRun` now requires a third `proposedValue` argument and writes it
  directly into `decisions.type.proposedValue`
  (`app/test/aiRunVerdicts.test.ts:98-118`).
- The empty-prewrite-snapshot test still calls
  `pendingTypeRun('run-empty-snapshot', createdAt)` with only two arguments
  (`app/test/aiRunVerdicts.test.ts:2040-2045`). Its terminal assertion checks
  only outcome, verdict, and actor (`app/test/aiRunVerdicts.test.ts:2072-2077`).
- The in-flight marker handoff test likewise calls
  `pendingTypeRun('run-finalizing', createdAt)` with only two arguments
  (`app/test/aiRunVerdicts.test.ts:2172-2177`). Its merged-record assertion
  checks outcome and terminal metadata but not the proposed value.
- The faithful fake copies the input record and marker-merges only terminal
  verdict fields (`app/test/helpers/twilioWebhookHarness.ts:3340-3367`). It does
  not reject or repair an undefined proposed value. Therefore both tests store
  `decisions.type.proposedValue: undefined` and still pass.

Concrete interleaving: the finalization test banks the real PATCH verdict on the
marker; `putRun` then receives the two-argument helper result, merges the banked
verdict into that pending decision, and persists a terminal type decision with no
model-proposed kind. The assertion accepts it. The same omission is already
present on the stored pending run when the empty-snapshot route stamps it. Thus
the correction makes two previously closed proofs green with incomplete run
identity/metadata.

Minimum fix/proof:

1. Pass `'tenant'` at both remaining helper call sites.
2. Assert `proposedValue: 'tenant'` in both stored decision assertions, alongside
   their existing exact terminal metadata.

## Prior finding disposition

- **A/B/C run identity: CLOSED.** A, B, and C are seeded as tenant, landlord,
  and partner respectively (`app/test/aiRunVerdicts.test.ts:2086-2090`).
- **Displaced-run causal ownership: CLOSED.** Each B/C replacement first uses
  fake repository replacement semantics and receives the exact displaced row;
  the test-local extraction-owner counterpart then stamps that displaced run
  `superseded` with its exact `createdAt` and a pending fence
  (`app/test/aiRunVerdicts.test.ts:80-95,2100-2111`). This mirrors production's
  apply-to-job handoff (`app/src/services/extraction/apply.ts:189-190,539-553`;
  `app/src/jobs/extraction.ts:641-655,764`). A and B are asserted terminal with
  their own proposed values (`app/test/aiRunVerdicts.test.ts:2129-2143`).
- **C route ownership: CLOSED.** The hook replaces only at the first two delete
  boundaries, so the actual third guarded delete removes C. The real PATCH route
  is the only path that stamps C `superseded_by_human_edit`; the test pins
  partner/suggested, actor, C's exact freshness timestamp, expected pending
  verdict, and persisted verdict time (`app/test/aiRunVerdicts.test.ts:2097-2149`;
  route `app/src/routes/contacts.ts:1614-1649`).
- **Empty snapshot and finalization marker: REGRESSED only in proposed-value
  fixture metadata** as described above. Their route/repository/verdict ordering
  assertions still pass.
- **Exact Property Manager casing: CLOSED.** The correction did not touch the
  casing table or route cases; lowercase remains unsupported and superseded
  (`app/test/contactKinds.test.ts:22-35`;
  `app/test/aiRunVerdicts.test.ts:1928-1958`).

## Focused verification

- First sandboxed attempt did not reach Vitest: exit 1, `EPERM` writing
  `app/node_modules/.vite-temp/...`; attributed to worktree sandbox permissions.
- `npm run test -w @housingchoice/app -- test/contactKinds.test.ts test/aiRunVerdicts.test.ts -t "drains an older row injected|re-reads and exact-deletes|banks the real PATCH|does not compare unsupported"`
  - exit 0; 2 files passed; 13 tests passed; 75 skipped.
- `npm run test -w @housingchoice/app -- test/aiRunVerdicts.test.ts -t "property_manager.*produces"`
  - exit 0; 1 file passed; 3 tests passed; 69 skipped.
- No slow or full gate was run. No source file was edited.

## Attacks that held

- Fake `putSuggestion` returns the exact prior stored row after atomically
  replacing it in the fake map.
- The route performs four consistent reads and three exact guarded-delete
  attempts in A/B/C order, ending with no repository, contact-list, or Today row.
- The A/B displaced stamps and C route stamp all preserve pending fences and the
  suggestion freshness timestamp used to identify their causal row.
- The finalization fake continues to model marker banking, pending-only merge,
  actor/time retention, and marker consumption; the finding is specifically that
  its caller now supplies an incomplete proposed decision.
