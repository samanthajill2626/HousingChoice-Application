# Slice 7 - Timeline host coverage

## Result

- Shipped commit `2002d90cba8cacc7518d1ff51e4294de792f38e2` (`test: cover image viewer across timeline hosts`).
- Updated only the six assigned host test files.
- Every production-like host harness now mounts `ImageViewerProvider` inside its existing `MemoryRouter`, matching the application boundary without adding host-local viewer state.
- Each host test uses `inbound/MMHOST1/0`, `2026-08-27T12:00:00.000Z#MMHOST1`, filename `Host proof.png`, and the exact `View Host proof.png` / labelled-dialog contract.
- Each host installs and restores `installImageViewerResizeObserver({ width: 1000, height: 600 })`, calls `await loadViewerImage(dialog, 'Host proof.png')`, closes, proves trigger focus restoration, and proves its surrounding route/tab/filter state is unchanged.

## Host matrix

| Host | Data seam | Context preserved after Close |
| --- | --- | --- |
| ContactDetail | `getContactTimeline({ items: [HOST_TIMELINE_MESSAGE], nextCursor: null })` with the existing tenant | `Tasha Williams` route label and selected `Comms` pane |
| ContactCommsPane | `getContactTimeline(timelinePage([HOST_TIMELINE_MESSAGE]))` | `Communications and activity` region and inactive `Comms only` filter |
| ConversationDetail relay | `getConversationMessages([wireImageMessage('conv-g1')])` with `relayHeader()` | `Relay group` route label and selected `Conversation` pane |
| GroupTextView native group | `getConversationMessages([wireImageMessage('gt-1')])` with `groupHeader()` | `Group text` route label and selected `Conversation` pane |
| TourConversation | tenant person tab plus contact timeline page containing the host image | selected `Ann Tenant` tab and inactive `Comms only` filter |
| PlacementConversation | tenant person tab plus contact timeline page containing the host image | selected `Ann Tenant` tab and inactive `Comms only` filter |

## TDD and verification evidence

- RED: the six-file focused command exited 1 with 6 new failures, 259 passes, and 6 matching unhandled errors. Every new host case failed at the intended boundary: `useImageViewer must be used within ImageViewerProvider`.
- GREEN: `npm test -w @housingchoice/dashboard -- src/routes/contact/ContactDetail.test.tsx src/routes/contact/ContactCommsPane.test.tsx src/routes/conversation/ConversationDetail.test.tsx src/routes/conversation/GroupTextView.test.tsx src/routes/tours/TourConversation.test.tsx src/routes/placements/PlacementConversation.test.tsx --reporter=dot`
  - Exit 0; 6 files and 265 tests passed.
- Dashboard workspace: `npm test -w @housingchoice/dashboard -- --reporter=dot`
  - Exit 0; 182 files and 2,823 tests passed.
  - Existing React `act(...)` and duplicate-key warnings remain; no test failed.
- Dashboard typecheck: `npm run typecheck -w @housingchoice/dashboard`
  - Exit 0.
- Targeted lint: `npx eslint` on all six owned test files
  - Exit 1 only for the two pre-existing unused type imports `PlacementsPage` and `UnitsPage` in `ContactDetail.test.tsx`.
  - Baseline proof against `HEAD` before this commit reported the identical two rules on the identical symbols. The other five files and all new Slice 7 lines had no lint finding.
- `git diff --cached --check`
  - Exit 0 before commit.

## Defects and deviations

- Live-type correction: Task 7's sample wire `Message` omitted the now-required `created_at` field. The two wire factories add `created_at: '2026-08-27T12:00:00.000Z'`; all plan-locked IDs, snake-case `provider_sid` / `provider_ts`, and media fields remain exact.
- No production defect was found. No production component, provider, viewer primitive, package, gallery, Timeline, or E2E file was changed.
- Full root tests, smoke, and E2E were intentionally not run in this slice.
