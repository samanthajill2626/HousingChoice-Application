# Slice S5 report - the voice webhook offers the greeting with a time bound (plan Task 5)

2026-09-27, `feat/voicemail-greeting`, implementer Claude Opus 5.5 (1M context). Commit `f3cc91ef`:
a missed inbound founder-bridge `/status` emits `<Play presigned>` in place of the spoken prompt
when a greeting is set and its object exists, inside a 2.5 s budget that falls back to `<Say>`.
Only the three named files changed (voice.ts, the harness, founderTriage.test.ts).

## Gates (run bare from the worktree)

- Baseline before any edit: founderTriage `Tests  46 passed (46)`; eslint on the 3 files exit 0.
- RED (`-t "voicemail greeting"`): `Tests  6 failed | 2 passed | 46 skipped (54)`. (a) `expected
  -1 to be greater than -1` (no `<Play>`); (c) (e) (e2) `expected [] to have a length of 1 but
  got +0` (no greeting WARN); (d) (f) `expected false to be true` (the named WARN absent). (b)
  and (g) passed as planned and stay as guards ((g) = the masked privacy guard).
- GREEN, same filter: `Tests  8 passed | 46 skipped (54)`; whole file `Tests  54 passed (54)`.
- Bound is load-bearing: with `withTimeout` removed (lookup awaited directly) the group ran
  `Tests  1 failed | 7 passed`; (e2) failed `Error: Test timed out in 8000ms.` (`--testTimeout=8000`
  to shorten the wait; suite default 60 s). (e) stayed GREEN: the abort signal alone ends a hung
  HEAD. Restored; sha256 byte-identical to the pre-probe file.
- founderTriage + all 13 `voice*.test.ts` files: `Test Files  14 passed (14)` / `Tests  322
  passed (322)`; no `[dynamoAdmin]` line.
- `npm run typecheck` exit 0. `npx eslint` on voice.ts, founderTriage.test.ts and the harness:
  exit 0, no findings (nothing new vs main, nothing pre-existing to name). ASCII: 0 non-ASCII
  characters in the 264 added lines.

## TwiML now emitted (literal output of a throwaway harness probe, deleted after the run)

- Greeting plays: `<Response><Play>https://fake-s3.local/settings/voicemail-greeting?X-Amz-`
  `Signature=fakesig1&amp;X-Amz-Expires=600</Play><Record maxLength="120" timeout="10"
  playBeep="true" .../><Say>{thanks}</Say><Hangup/></Response>` - `<Play>` (no attributes)
  immediately precedes `<Record>`, whose attributes are unchanged.
- No greeting, or any fallback (no store, object missing, error, timeout): byte-identical to
  before; `<Say>{voice.voicemail_prompt}</Say>` immediately precedes the same `<Record>`.
- Masked or outbound miss: unchanged `<Say>{goodbye}</Say><Hangup/>`, no `<Record>`, no HEAD.

## Deviations from plan Task 5 (otherwise identical)

1. `seedRingingBridgeWith` sits AFTER `seedRingingBridge` so the existing JSDoc stays attached;
   its own JSDoc says it returns the whole harness (it does). `founderHarness` JSDoc notes `opts`.
2. N8: the Step 4 eslint run includes `app/test/helpers/twilioWebhookHarness.ts`.
3. Spec 5 webhook item (h) has no own case: (a) and (e) pin `mediaHeads` `signal: true`, as planned.

## Surprising / worth knowing

4. The predicted RED cause "`voicemailGreetingLookupBudgetMs` unknown to the harness" never shows
   at runtime (vitest does not typecheck; the option was ignored); every RED was behavioral.
5. (e2) is the ONLY pin on `withTimeout`; (e) pins the abort path. At a 50 ms budget both timers
   are armed together; (e) asserts only the WARN count, so it does not care which fires first.
