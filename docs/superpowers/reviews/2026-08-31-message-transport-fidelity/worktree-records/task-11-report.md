# Task 11 report: Timeline transport presentation

## Outcome

Committed Task 11 as `edc9865c` (`feat: show requested and actual message transports`).

## Test-first evidence

- Initial focused test invocation could not start Vite because the sandbox denied its `.vite-temp` write with `EPERM`. This was recorded as an environment failure, not behavioral red proof.
- Re-running the exact focused command with the assigned worktree writable reached Vitest and failed as expected: exit 1, 3 test files failed, 11 tests failed, and 224 tests passed. The failures showed the legacy inline SMS label, missing recipient transport, and missing inbound relay disclosure.
- The first implementation run had 234 tests pass and one test fail because a broad `/^RCS -/` locator also matched `RCS -> Mixed`. Tightening that assertion to the exact requested-only metadata line fixed the test contract; production behavior did not change for this locator correction.
- Final focused run: exit 0, 3 test files passed, 235 tests passed.
- The first dashboard typecheck found one real implementation error: nullable `leg` was read while choosing the row tone. The row now applies a tone only when delivery presentation exists.
- Final dashboard typecheck: exit 0.
- Final `git diff --check`: exit 0.

Commands:

```text
npm run test -w @housingchoice/dashboard -- src/routes/contact/Timeline.test.tsx src/routes/conversation/ConversationDetail.test.tsx src/routes/conversation/GroupTextView.test.tsx
npm run typecheck -w @housingchoice/dashboard
git diff --check
```

## Files

- `dashboard/src/routes/contact/Timeline.tsx`
- `dashboard/src/routes/contact/Timeline.test.tsx`
- `dashboard/src/routes/conversation/ConversationDetail.test.tsx`
- `dashboard/src/routes/conversation/GroupTextView.test.tsx`
- `e2e/support/selectors.md`

No CSS change was needed.

## Implementation and accessibility contract

- Timeline makes exactly one `presentMessageTransport` call using the mapped transport fields and optimistic marker. Its nullable result is consumed directly by the metadata fragments with no local fallback.
- `includedRecipientEntries` supplies the one filtered recipient set used for ticking, opted-out counts, rollup input, row order, disclosure, and accessible summary.
- Inbound multi-party sources may disclose outbound recipient slots while queued-pending, no-included-map, direct inbound, and email guards remain intact. Their main chip remains inbound actual-only.
- Recipient delivery text and identity remain visible. Recipient transport is appended with stable ASCII ` - ` separators, and every list item receives the composed accessible name.
- Complete and incomplete aggregation, optimistic suppression before and after POST success, pending/agreement/fallback/Unknown/legacy/native-MMS labels, inbound relay disclosure, excluded filtering, opted-out copy, state-absent rows, and unchanged delivery behavior are covered through direct, relay, and native-group component hosts.
- The selector guide was updated because named recipient list items are now the supported accessibility-first row contract.

## Browser QA deferral

No e2e suite, interactive browser session, or background command was started. The orchestrator explicitly retained the hermetic browser eyeball and Task 12 e2e coverage.

## Divergences

- No production-contract divergence.
- `e2e/support/selectors.md` changed because the accessible row contract genuinely changed.
- Vite `EPERM` before Vitest startup was an environment-only failure and was separated from the behavioral red run.
