---
id: ai-run-log-ui-polish-batch
title: AI run log admin pane polish batch - missing run time, unrendered failure fields, stale deep links
type: improvement
severity: low
status: open
area: dashboard/ai-run-log
created: 2026-08-09
refs: dashboard/src/routes/settings/aiRuns/AiRunDetail.tsx:31, dashboard/src/routes/settings/aiRuns/AiRunsSection.tsx:12, dashboard/src/routes/settings/aiRuns/AiRunsSection.tsx:21, dashboard/src/api/types.ts:176, e2e/tests/dashboard-next/ai-run-log.spec.ts:345
---

**Problem.** Nine independent nits in `/settings/ai-runs`, none of them a
correctness bug, batched into one issue so they can be fixed in a single pass.
All re-verified against HEAD after the fix wave.

- [x] **Detail pane never shows when the run happened.** (Fixed by the
      follow-up wave's U3: the detail header now renders the run time.)
      `AiRunDetail.tsx:31`
- [ ] **A suggestion resolution error message cannot outlive its chip.** The
      alert renders INSIDE `SuggestionChip` (`SuggestionChip.tsx`, the
      `role="alert"` span), and the ApiError branch's refetch removes the dead
      suggestion row, unmounting chip and explanation together - the operator
      sees the chip vanish but the WHY flashes for one refetch round-trip.
      Pre-existing with the `SUGGESTION_NOT_PENDING` precedent (observed live
      2026-08-09, wave self-QA); the follow-up wave's H5 refetch now routes
      three more codes (`suggestion_field_edited`,
      `suggestion_resolution_lost` retry advice, `suggestion_replaced`) into
      the same pattern. The `suggestionError` STATE already survives in
      `ContactDetail`; only its render anchor dies. Persist the message
      outside the chip (e.g. a card-level alert region) so refetch cannot eat
      it. The unit tests cannot see this - their mocked refetch still returns
      the row, so the alert survives in jsdom.
      renders runId, trigger, outcome, driver/model, contact or conversation id,
      durationMs, fingerprint and tokens - but not `startedAt` or `finishedAt`,
      both of which are on the payload (`dashboard/src/api/types.ts:276-277`)
      and both of which design section 9 puts in the header. The LIST does show
      it (`AiRunList.tsx:48`), so opening a run loses the timestamp.
- [ ] **A stale deep link becomes a permanent error loop.**
      `AiRunsSection.tsx:12` - `scopeFrom` casts the raw `?scope=` URL param to
      `AiRunScope` with no validation, so any unrecognized value is sent to the
      API, which answers `400 invalid_scope` (`app/src/routes/aiRuns.ts:47-50`).
      The pane shows its error block and every Retry repeats the same bad
      request. Validate against the known scope set (including the
      `contacts#` / `conversations#` prefixes) and fall back to `global`.
- [ ] **A failed run shows only the word "failed".** `run.error`, `skipReason`,
      `errorKind`, `notedLines` and each window message's `direction` are all
      typed (`types.ts:227-232`, `:283`, `:301`) and all still unrendered at
      HEAD. The W4 e2e records this in a comment - "The pane does not render the
      error block today" (`e2e/tests/dashboard-next/ai-run-log.spec.ts:345`) -
      and asserts the error kind, message, attempts and parked flag through the
      API instead of the UI. The forensic pane should show the error block, the
      skip reason and the noted-line count.
- [ ] **`window` shadows the DOM global.** `AiRunDetail.tsx:24` destructures
      `const { run, window } = detail;` and reads it at `:32`. Rename to
      `windowView` (or similar) so nothing inside the component can reach for
      the global by accident.
- [ ] **Raw enums in the detail header.** `AiRunDetail.tsx:31` prints
      `{run.trigger} - {run.outcome}` verbatim (`no_op`), while both the list
      (`AiRunList.tsx:49`) and the decision ledger (`AiRunDetail.tsx:37`) route
      the same values through `humanizeEnum`.
- [ ] **Config strip duplicates FlagPills, and vanishes on error.**
      `AiRunsSection.tsx:31-37` re-implements the four extraction pills already
      rendered by `dashboard/src/routes/settings/FlagPills.tsx:96-103`, and
      because `flagItems` is `flags.flags ? [...] : []`, a failed
      `useSystemFlags()` renders an empty strip with no explanation rather than
      an error or a placeholder.
- [ ] **Narrow-viewport pane state never reconciles with the URL.**
      `AiRunsSection.tsx:21` seeds `pane` from `runId` once via `useState`, so
      after a browser Back that drops `?run=`, a narrow viewport can stay on the
      detail pane showing nothing.
- [ ] **The four new `SystemFlags` fields are required, not optional.**
      `dashboard/src/api/types.ts:176-182` declares `aiExtractionEnabled`,
      `aiExtractionDriver`, `aiExtractionModel` and
      `aiExtractionPromptFingerprint` as required, so a dashboard deployed ahead
      of the API renders `undefined` in the config strip instead of degrading.
- [ ] **`value()` shadows its own parameter.** `AiRunDetail.tsx:5` -
      `function value(value: unknown): string`.

**Suggested fix.** One dashboard-only pass, no API change needed for any item
except deciding how much of the error block to surface. Existing unit tests in
`dashboard/src/routes/settings/aiRuns/AiRunsSection.test.tsx` already build a
full detail fixture, so each rendering item is a cheap assertion to add.
