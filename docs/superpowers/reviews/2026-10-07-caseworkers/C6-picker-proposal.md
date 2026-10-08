# C6 proposal - keep contact search options within the viewport

Date: 2026-10-08. Proposed shared-control correction; NOT included in the
Caseworkers source commits. The original source and tests are restored byte
for byte after verification. Parent is requesting a scope decision because
this defect also reproduces at the merge base. The operating manual directs
out-of-scope findings to the issue registry rather than silently expanding a
feature. The remaining S10 work can proceed independently.

## Concrete change

The draft changes only dashboard/src/routes/contact/ContactSearchField.tsx
and its test file (73 added lines, 7 removed lines across both). The fixed
portal opens above the input when its contents do not fit below and more
space exists above. Its height is bounded by available viewport space; the
old 9rem floor no longer places a list entirely offscreen. Normal below-input
placement, portal ownership, keyboard selection, committed values, disabled
state and moved-anchor scroll dismissal remain covered by the existing tests.

The exact apply-ready patch is .superpowers/sdd/C6/proposed-fix.patch.
It passes git apply --check against the clean source at 5985552b. Raw patches
and byte backups are ignored references, not duplicated in this record.
The baseline diagnosis is S10-recipient-picker-baseline.md; the open issue is
docs/issues/contact-search-popover-below-viewport.md.

## Verification of the proposal

- Genuine RED: dashboard npx vitest run
  src/routes/contact/ContactSearchField.test.tsx: exit 1, 2 failed / 19 passed.
  The two new placement failures are the low-input and short-viewport cases;
  the ordinary below-input placement pin passes on the original source.
  The earlier draft run contained one extra CSS-string-format assertion and
  is excluded; C6-red-geometry.* is the substantive RED evidence.
- Same command with the draft correction: exit 0, 21 passed / 1 file.
- Root bare npm run typecheck: exit 0, all five workspaces, 30.189 seconds.
- Root npx eslint dashboard/src/routes/contact/ContactSearchField.tsx
  dashboard/src/routes/contact/ContactSearchField.test.tsx: exit 0.
- Original Task 10.4 sharing batch, unchanged tests and viewport, with
  --trace on: exit 0, 13 passed / 0 failed / 0 skipped, 77.692 seconds.
  The previously unreachable option was selected by the ordinary pointer
  click and the send/outbox/recipient-card assertions then passed. No force
  click, viewport enlargement or assertion change was used.

The exact browser command is recorded in
.superpowers/sdd/checkpoints/C6-browser.command.json. Other raw metadata,
logs and real exit codes are checkpoint C6-red-geometry.*, C6-green.*,
C6-typecheck.* and C6-lint.*. Browser failure evidence was copied before the
rerun; the passing report and retained traces are under
.superpowers/sdd/C6/artifacts/proposal-green/.

All commands completed, lane 13 ports 10301/10311/10321/10331 are free,
and source restoration left the tree clean before writing this record.
Applying the proposal requires the separate scope decision. If accepted,
commit the exact patch, update the issue, and carry it through the mission's
final full gates and independent review. Until then Task 10.4 remains
baseline-red on the committed branch; the proposal's green run is not a claim
that the unchanged branch is green.
