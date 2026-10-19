# Self-QA fix report - QA-L1 (review tags clipped in the wide layout)

Branch `feat/matching-blast-rules`, worktree `W:/tmp/matching-blast-rules`.
Fix commit: `c3e8118b` fix(dashboard): the review's tags wrap inside the wide
layout's tags column (self-QA QA-L1). CSS and spec in one commit, as briefed.

## Defect (orchestrator's live measurement, hermetic lane)

On the Matching composer's "Review recipients" step, in the WIDE layout (a
768px+ review pane), the tag spans `.alreadyTag`, `.addedTag`, `.noConsentTag`
and `.declinedTag` (the tour-hold label reuses `.declinedTag`) were
`flex: 0 0 auto`. A tag wider than the tags column (`minmax(0, 1.2fr)` of
`--recipient-cols`) could not shrink or wrap: it ran past its row, the list
(`.rows`) scrolled sideways and the label was cut off. Measured past the list's
visible right edge: at 1280 wide, "Tour requested Oct 19, no date yet" 34px,
"Toured Oct 16, needs outcome" 12px, the consent-not-recorded tag 81px; at
1440, 5px and 52px. The narrow (stacked) layout and the page itself were fine.

## Change (diff summary)

- `dashboard/src/routes/broadcasts/RecipientPreview.module.css:141-185` - on
  the four tag classes `flex: 0 0 auto` became `flex: 0 1 auto` plus
  `min-width: 0`; every other declaration kept. One 4-line ASCII comment above
  `.alreadyTag` (`:141-144`) says why. Grid columns, the container queries and
  the stacked layout are untouched. 12 insertions, 4 deletions (four `flex`
  lines changed; four `min-width` lines and the comment added).
- `e2e/tests/dashboard-next/matching-blast-rules.spec.ts:289-307` - 20 lines
  ADDED after the held-rows block (both labels visible, both boxes unchecked and
  enabled), before "The reach line equals the rows that start checked". No
  other line changed (diff: 20 insertions, 0 deletions; imports untouched).
  The pin: `page.setViewportSize({ width: 1280, height: 900 })` (the test had
  no explicit viewport; the project default is Desktop Chrome 1280x720);
  the tag via `list.getByText(requestedLabel, { exact: true })` where `list` is
  the spec's existing `getByRole('list', { name: 'Candidate recipients' })`;
  `tagRight` = the tag's `getBoundingClientRect().right`; the list's
  `getBoundingClientRect().left + clientWidth`, `scrollWidth`, `clientWidth`;
  `expect(tagRight).toBeLessThanOrEqual(visibleRight + 1)` and
  `expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1)`.

## RED (spec change only, CSS untouched) - label `selfqa-red`

`.superpowers/gates/selfqa-red/exit.txt`: `EXIT:1`; log: `1 failed`. It failed
AT the new geometry assertion (`matching-blast-rules.spec.ts:302`), after every
earlier step of the test had passed:

```
Error: the tour-request tag stays inside the visible list
expect(received).toBeLessThanOrEqual(expected)
Expected: <= 1240
Received:    1272.890625
```

The list's visible right edge is 1239, so the tag ran 33.9px past it - the
orchestrator's 34px. The scrollWidth assertion was not reached (the first
assertion stops the test).

## GREEN (spec + CSS) - label `selfqa-green`

`.superpowers/gates/selfqa-green/exit.txt`: `EXIT:0`; log: `1 passed (16.1s)`.
The whole spec passed, including both new assertions and the send that follows.

Both runs log one `[WebServer] Error: connect ECONNREFUSED 127.0.0.1:10001`
at boot (log line 109 RED, 110 GREEN): Vite's `/__dev/ping` proxy firing before
the app listened. Boot noise, identical in both runs.

## Other checks (after GREEN)

- Dashboard broadcasts folder (`npx vitest run src/routes/broadcasts`):
  EXIT=0, 16 files / 312 tests passed.
- `npm run typecheck -w @housingchoice/e2e`: EXIT=0.
- `npx eslint e2e/tests/dashboard-next/matching-blast-rules.spec.ts`: EXIT=0,
  no output (no new error; the CSS file is not linted).
- ASCII: no non-ASCII on any added line (the CSS file's pre-existing em dash on
  line 1 is untouched).

## Notes and deviations

- Placement: the pin sits after the WHOLE held-rows block (labels, then the two
  boxes' unchecked/enabled assertions) instead of between the label and box
  assertions, so that block stays contiguous.
- The viewport literal equals `WIDE_RESTORE` in `e2e/support/viewport.ts`; it
  is written inline so the import block stays byte-identical. The test's later
  steps now run at 1280x900 instead of 1280x720 - same width, so the container
  query state is unchanged, and the full spec passed GREEN.
- The pin covers the tour-request tag only. This spec's run-unique audience has
  no consent-not-recorded row, so the 81px `.noConsentTag` clip is fixed by the
  same CSS but not pinned here. The narrow layout was already fine and is not
  pinned.
- Observation: after the RED run, `e2e/.artifacts/lane.json` and `session.pid`
  stayed behind although the launcher (PID 62372) was gone and lane 10's ports
  had no listener. The config ignores such a file (it needs a live launcher
  holding the lease), and the GREEN run booted normally.
- Raw logs (gitignored): `.superpowers/gates/selfqa-red/e2e.log`,
  `.superpowers/gates/selfqa-green/e2e.log`,
  `.superpowers/sdd/selfqa-fix-{folder,e2e-typecheck,eslint}.log`.
