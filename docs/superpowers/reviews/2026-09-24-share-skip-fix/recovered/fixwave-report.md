> Recovered during cleanup on 2026-09-28 from `.superpowers/sdd/fixwave-report.md`. This is the original mission report; its run-state labels and findings describe that stage of the build. See the [closeout record](../README.md) for current status and source provenance. Only ellipsis and checkmark glyphs, where present, were converted to ASCII; the original bytes remain in the preserved artifact archive.

# Fix-wave report - share-skip-fix (Branch A), whole-branch review fix wave

Run state (NOT committed). Date 2026-09-25. Worktree W:\tmp\share-skip-fix,
branch feat/share-skip-fix, started at bd16dcd0, now at 7f80905b.

## RUN STATE: STOPPED AT THE ITEM-4 GATE (STOP-AND-REPORT)

The brief lists "a kill-switch seam does not exist in broadcastFanOut.test.ts
(report how the file toggles config)" as a STOP-AND-REPORT trigger ("commit what
is green, then stop"). It fired. Item 1 (the behavior fix) is committed and
gated. Items 2, 3, 5, 6, 7, 8 and 9 are NOT built. They do not depend on item 4
and each has a ready plan below, so a resume can start at once. No seam was
invented.

## Item 1 - BEHAVIOR: "Add a tenant" on an already-listed row (C1 / A8b) - DONE

Commit 7f80905b `fix(dashboard): picking an already-listed tenant promotes the
row to a checked seed (share-skip-fix D5)`.

- Seed persistence is the simple append the reviewer assumed:
  `seedsRef.current = [...seedsRef.current, id]; void updateBroadcastSeeds(draftId,
  seedsRef.current).catch(() => {})` (RecipientPreview.tsx, the new-add block). It is
  mirrored exactly, with no other path. Server `seeded` means the contact is in the
  stored seed_contact_ids (app/src/routes/broadcasts.ts:509, :553), so a seeded row
  is always already in seedsRef. The PATCH also dedupes server-side
  (parseRecipientContactIds, broadcasts.ts:143-150).
- The change is in `addTenant` only. When the contact is already a row, the
  updater maps it to `{ ...r, seeded: true, checked: r.hasConsent }` instead of
  returning `prev`. The seed is persisted when `listed === undefined ||
  !listed.seeded`: a brand-new add (unchanged) or the promotion of a row that was
  not a seed. A repeat pick of a seed persists nothing. The brand-new-row branch
  and the resolved-1:1 path are untouched. Two doc comments were brought in line:
  the `Row.seeded` doc ("added or picked in this session"), and the `addTenant`
  doc, which no longer says "ignore duplicates".
- RED (before the fix): 1 failed | 36 passed (37), at the checked assertion:
  "Error: expect(element).toBeChecked() / Received element is not checked:
  <input aria-label="Bo Flag - already sent" ... type="checkbox"/>"
  at RecipientPreview.test.tsx:341 (the "already sent" separator in the output
  was the file's pre-existing em dash).
- GREEN: RecipientPreview.test.tsx 37/37 (exit 0). Whole `src/routes/broadcasts`
  folder: 11 files, 159/159 (exit 0). The `resolvedFor` tests and the Select-all
  tests stayed green.
- The new test (in the "add a tenant" describe) covers an unseeded flagged
  candidate "Bo Flag" picked via the "Add a tenant" combobox. It asserts: one row
  only (no duplicate); checked; "Already sent" still shown; "Send to 2 tenants";
  `updateBroadcastSeeds('bcast_1', ['c1','c2'])`; unchecked after Deselect all
  and checked after Select all; a repeat pick keeps it checked and
  `updateBroadcastSeeds` is still called once.
- Mutation proofs for the persistence half, each a temporary in-place edit that
  was restored at once and never committed:
  (a) condition `listed === undefined` (promote but never persist) -> FAIL
  "expected "spy" to be called with arguments: [ 'bcast_1', [ 'c1', 'c2' ] ]"
  at :346.
  (b) condition `true` (always persist) -> FAIL "expected "spy" to be called 1
  times, but got 2 times" at :358.
  Restored diff re-verified: 37/37 and folder 159/159.

## Item 4 - kill-switch case for a dashboard share (C4) - BLOCKED, NOT BUILT

How broadcastFanOut.test.ts builds config (no seam):
- `testConfig()` (app/test/broadcastFanOut.test.ts:44-51) calls `loadConfig` with a
  FIXED literal env: NODE_ENV test, MESSAGING_DRIVER console, PUBLIC_BASE_URL,
  SESSION_SECRET. It takes no parameter.
- `loadConfig(env)` reads ONLY the object passed in (app/src/lib/config.ts:516), so
  `process.env` / `vi.stubEnv` cannot reach it. MESSAGING_DRIVER console defaults
  `smsSendingEnabled` to true (config.ts:787).
- `wireHandler(world, logger?, tokenBucket?)` (:117-144) calls `testConfig()` itself.
  It takes no config or env and passes that one config to both
  `createSendMessageService` and `registerBroadcastSendJobHandler`.
- No test in the file sets SMS_SENDING_ENABLED or smsSendingEnabled (grep). The
  fan-out itself never reads the kill switch; only the wrapper does
  (sendMessage.ts:296). In app/test, only sendMessage.test.ts (makeFakes `env`),
  groupSend.test.ts and messagingApiBaseUrl.test.ts toggle it. The harness's
  `makeWebhookHarness({ env })` override feeds the webhook app, not this file's
  fan-out wiring.

Options for your call:
- (a) RECOMMENDED: an optional env override. `testConfig(env: Record<string,string> = {})`
  spreads it into the literal, and `wireHandler` gains an optional 4th parameter
  `env` passed to `testConfig(env)`. About 3 lines; every existing call is
  unaffected. This is the conformance reviewer's own suggestion ("take an env
  override").
- (b) No change to the shared helper: one test wires its own handler inline with
  `loadConfig({ ...same literal, SMS_SENDING_ENABLED: 'false' })` through the same
  two factories. This duplicates about 25 lines of wireHandler.
- (c) Drop the fan-out-level pin. The wrapper kill switch is pinned at
  sendMessage.test.ts:425. The "refusal code -> skipped_other" routing is pinned
  by the manual_mode refusal test (broadcastFanOut.test.ts:321).
With (a), the test would be: created_via 'dashboard', one recipient, SMS off ->
slot `{status:'skipped', errorCode:'sms_sending_disabled'}`, persisted
`stats.skipped_other` 1, `world.sent` empty, broadcast status `sent`.

## Items 2, 3, 5, 6, 7, 8, 9 - NOT BUILT (stopped at the gate); ready plans

- 2 (C2, sendMessage.test.ts, after the I8 `it` at :662): two new `it`s.
  (a) makeFakes with the phone contact `{contactId:'c-dnc', consent_method:
  'inbound_text', sms_opt_out: true}` + `recipient: <clean real>` -> rejects
  ContactOptedOutError, nothing sent.
  (b) the phone contact carries `deleted_at` + `recipient: <live real>` -> resolves.
  Revert-proofs: (a) change sendMessage.ts:322 `phoneContact?.sms_opt_out` to
  `contact?.sms_opt_out`; (b) make the deleted gate also judge phoneContact.
- 3 (C3, broadcastFanOut.test.ts I1 test :368): add `c-ud` (sms_unreachable +
  deleted_at) expected `{skipped, unreachable}`, and `c-dnc2` (deleted_at +
  consent_method undefined) expected `{skipped, contact_deleted}`. Stats become
  skipped_opted_out 2, skipped_no_consent 1, skipped_other 3.
  Revert-proof: swap the fence order in the fan-out.
- 5 (C5, :405): create the phone#-keyed recipient's conversation, setMode
  'manual', and assert its message_sent audit payload has `automated: false`
  (same pattern as the D4 test :345-366). Reword the D4 title from "never
  breaker-metered" to what it proves. The wrapper already asserts that a person's
  send never counts: sendMessage.test.ts:794-800 (counterValue 0 in manual
  mode).
- 6 (A6, :321-343): seed stale persisted counters via the seedBroadcast `stats`
  override (e.g. skipped_opted_out 5, plus a stale skipped_other). Assert the
  "broadcast send finalized" line logs the DERIVED 0 / 1, and adjust the persisted
  assertions to the stale-plus-bump values. Revert-proof: switch the log to
  `finalItem.stats.*` (broadcastFanOut.ts:756-768).
- 7 (A8c, broadcastApi.test.ts:386-388): sum
  `queued + (sending ?? 0) + sent + delivered + failed + skipped_opted_out +
  skipped_no_consent + (skipped_other ?? 0)`, matching broadcastFanOut.test.ts:1035-1046.
- 8 (C7/A7): dashboard/src/api/types.ts:2955 "Twilio error class on a failure"
  becomes: the failure class OR the skip reason (opted_out, unreachable,
  contact_deleted, no_consent, the wrapper refusal codes). Add a matching doc to
  the undocumented app twin at app/src/repos/broadcastsRepo.ts:139.
- 9 (A7): one ASCII line in the sendMessage.ts I8 `recipient` comment (:243-249):
  the deleted and consent gates judge the caller's already-resolved snapshot
  (redundant with the fan-out's own fence); opt-out stays fresh.

## VERIFY (on HEAD 7f80905b; exit codes verbatim)

- `npx vitest run src/routes/broadcasts/RecipientPreview.test.tsx` -> EXIT=0
  (37 passed). `npx vitest run src/routes/broadcasts` -> FOLDER_EXIT=0
  (11 files, 159 passed).
- The app suites (sendMessage / broadcastFanOut / broadcastApi) were NOT run:
  no app file was touched.
- `npm run typecheck` -> TYPECHECK_EXIT=0.
- `npm run smoke` -> SMOKE_EXIT=0 ("smoke-dist: OK - 1413 import specifier(s)
  across 248 emitted file(s) resolve under plain Node.").
- `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- ...)`
  (50 files) -> ESLINT_EXIT=1, "14 problems (14 errors, 0 warnings)". These are
  exactly the declared pre-existing set:
  - cast.ts 79:7, 109:7, 110:7, 434:7 (4)
  - matrix.ts 134:7 (1)
  - importApply.integration.test.ts 745:59, 824:59 (2)
  - BroadcastComposer.test.tsx 11:24, 11:69, 37:10 (3)
  - BroadcastComposer.tsx 167:7, 192:5, 211:5, 226:5 (4)
  None is on a file this wave touched. `npx eslint` on RecipientPreview.tsx and
  its test alone -> exit 0.
- ASCII (added lines, bd16dcd0..HEAD): RecipientPreview.tsx 0,
  RecipientPreview.test.tsx 0.

## Deviations from the adjudication

- The item-1 test goes beyond the minimum: it also pins persistence (the PATCH
  with the appended list) and the repeat-pick no-op. Both are halves of the
  reviewer's own fix; both were proven by mutation.
- The promoted row does NOT get `added: true`, so there is no "Added" badge. This
  matches the reviewer's exact mapping, and a re-preview never sets `added` either.
- Stopped at the item-4 gate instead of finishing items 2-9 (see RUN STATE).

## Noticed, not changed

- As before, the persistence decision reads the render-time `rows` while the
  updater reads `prev` (the prior `alreadyListed` did the same). A double pick in
  one tick could diverge. That is not reachable through the UI, because the
  field clears between picks.
