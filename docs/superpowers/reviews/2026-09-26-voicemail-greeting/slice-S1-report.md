# Slice S1 report - greeting library (plan Task 1)

2026-09-27, `feat/voicemail-greeting`, implementer Claude Opus 5.5 (1M context).
Scope held to the three named files; nothing else staged.

## Commits

- `b8673294` feat(voicemail-greeting): greeting library - type normalization,
  header sniff, upload gate, name sanitizer, lookup timeout
- `e16a3838` test(voicemail-greeting): pin withTimeout clearing its timer (spec 5)

## Gates (run bare from the worktree)

- RED: `Cannot find module '../src/lib/voicemailGreeting.js' imported from
  '.../app/test/voicemailGreeting.test.ts'`, as the plan predicts.
- GREEN: `Tests  20 passed (20)` at b8673294; `Tests  21 passed (21)` at e16a3838.
- `npm run typecheck` exit 0 before each commit. `npx eslint` on the three
  files: exit 0, no findings (N1: no directive added).
- ASCII: 0 non-ASCII bytes per file; the `\u0000` / `\u{1F600}` escapes survive.

## Divergences (else identical by diff to plan 75-97, 103-275, 286-467)

1. Test added pinning N2: the gate exposes no numeric `byteLength`, `length`,
   `size` or `start`+`end` and no string `path`, before and after bytes flow.
   A temporary `size = 0` field failed exactly that case.
2. `voicemailGreeting.ts:150-152`: the plan's conditional eslint-disable note
   to the implementer is replaced by the settled N1 fact. Code unchanged.
3. e16a3838: the plan's withTimeout case relied on "vitest's own leak
   detection", which does not exist - with `clearTimeout` disabled all 20 cases
   passed, so spec 5's "clears its timer" was unpinned. A fake-timer case now
   asserts `vi.getTimerCount()` is 0 after a win (resolve and reject); RED on
   that mutation with `expected 1 to be +0`. The old case is renamed to what it
   checks, its comment corrected.

## Worth an eye (not blocking)

1. A 3-byte `ID3` or 4-byte frame-header body passes the gate as MP3 (probed;
   an 11-byte RIFF is refused): `_flush` sniffs what it holds and the MP3 sniff
   needs 3 bytes. Spec 4.1 "fewer bytes than the sniff needs" can also read as
   12; plan code kept - a one-line `_flush` change if 12 is meant.
2. lib-storage 3.1070.0 checks `path` only via `instanceof fs.ReadStream`
   (`dist-cjs/runtimeConfig.js:7-9`): N2's `path` rule is conservative.
3. `VOICEMAIL_GREETING_MIME_TYPES` has no consumer after Task 1;
   `normalizeGreetingContentType` hard-codes the same three types.
