# Slice S8 report - Settings > Voice greeting block (plan Task 8)

2026-09-27, `feat/voicemail-greeting`, implementer Claude Opus 5.5 (1M context). Commit `cfb2dd1b`:
`useVoicemailGreeting` + `VoicemailGreetingBlock` (admin upload/replace/remove + Remove dialog, player,
VA read-only), mounted LAST in VoiceSection's `<section>` outside the useMe ternary. 6 named files only.

## Gates (run from the worktree)

- RED 1 (tests + F4 mock, no code): `Test Files  1 failed | 1 passed (2)` / `Tests  9 passed (9)`, the
  new file `Failed to resolve import "./VoicemailGreetingBlock.js"`. RED 2 (mount test, pre-mount):
  `Tests  1 failed | 9 passed (10)` - `Unable to find an element with the text: No greeting uploaded...`
- GREEN two files: `Test Files  2 passed (2)` / `Tests  26 passed (26)` (block 16, VoiceSection 10);
  `src/routes/settings`: `Test Files  18 passed (18)` / `Tests  188 passed (188)` (the act() warnings
  there are NumbersSection.test's, pre-existing).
- `npm run typecheck` exit 0. eslint (5 TS/TSX files): exit 0, empty output - nothing new, nothing
  pre-existing. ASCII: 0 non-ASCII bytes in the 3 new files and 138 added diff lines; LF. N15: scripted
  check - every `styles.X` used is defined in the CSS and vice versa.
- Mutation check: F8 reverted to `isAdmin`, `disabled` dropped -> exactly the two F8 tests fail
  (`expected <input ...> to be null`; `Received element is not disabled`). Restored.

## Worklist items

- F4: `beforeEach` block body (`vi.clearAllMocks();` + the getSettings mock); the old arrow is the only
  deleted line, every existing assertion byte-identical.
- F8: input only when `isAdmin && state.status === 'ready'`, `disabled={state.busy}`. Pinned: no input
  while the first GET is pending; mid-upload "Uploading..." is disabled and so is the input.
- F9: new `.greetingActions` (flex, wrap, gap --sp-3) on Replace/Remove. F10: bare tokens only.

## Deviations from plan Task 8 (otherwise the plan's code)

1. Dropped `useId` / `id={headingId}` on the h3: nothing references it (no aria-labelledby by design).
2. Added a VoiceSection test: a /users/me failure still shows the block with exactly ONE alert - the
   unit pin of the mount placement (the plan pinned the mount only in the e2e).
3. Added assertions: helper text verbatim (exact textContent) and the VA suffix at its end. Comments:
   the dialog comment says the block alert is "above" (DOM order), not "below".

## Surprising / worth knowing (S9, orchestrator)

4. Out of my scope, `e2e/performance/routes.ts:705,759`: `VoiceSection.tsx:93-127,176` is now +1 off
   (-> 94-128,177); `useVoicemailGreeting.ts:1-40` is header/constants, the GET is at :92-112.
5. The block's loading Spinner is `role="status"`, so VOICE_TERMINAL's `[text 'Your cell', status
   role_only]` alternative can fire before /api/settings resolves.
6. With the dialog open its h2 "Remove voicemail greeting?" matches Playwright's
   `getByRole('heading', { name: 'Voicemail greeting' })` unless `level: 3` or `exact: true`.
7. Plan behavior kept: a file choice clears the missing-file status up front (a refused Replace hides it).
