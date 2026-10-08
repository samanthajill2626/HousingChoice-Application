# Org settings layout - code review round 1

Date: 2026-10-07. Scope: `0a2c7d2d..9715c677` (the cloud agent's six commits:
the Option B rebuild, full width, the e2e spec and the handback). Reviewer: an
independent read-only opus sub-agent. It ran no suites; a full e2e run was in
progress in the worktree. The orchestrator re-checked findings 1 and 2 in the
code. Verdict: no high-severity regressions; two defects to fix before merge.

## Verified equivalent to the pre-change code (0a2c7d2d)

- `settleChoices`, including the name-variant "Use <entry>"-only rule.
- `rewriteKey`, and `recordsText` with its sibling counting. The panel gets the
  unfiltered `admin.notOnList`, as before.
- The remember-spelling rules, all six resolve request bodies, the confirm
  labels and sentences, and `HolderList`.
- The rename and settle notices.
- Rewrite gating: Rename, Merge, Change kind and Delete wait; Edit spellings
  and Edit notes never wait. Settling waits via `fieldset disabled`, which is
  slightly stricter than before.
- No navigation happens inside an effect, so there are no history loops.
- Values containing `/ % + & #`, spaces or unicode round-trip through
  `URLSearchParams` and are matched exactly.
- The Modal's synchronous focus restore does not beat the list-heading focus
  after Delete or Merge.

## Findings

### F1 (MEDIUM, confirmed) - an in-flight settle is not locked

`NotOnListSection.tsx` `NotOnListPanel`: the radios carry no `disabled` while a
`resolveNotOnList` request is pending, and `SettleConfirm` is keyed by the
picked label. The old `SettleDialog` was a modal that ignored Escape and Cancel
while busy. Now, during the request:

- (a) Picking another radio remounts the confirm with `busy=false`, so a second
  POST for the same value can go out. Only the server's rewrite lock stops it.
- (b) Clicking another row, or Close, changes the selection. When the first
  request resolves, its captured `onSettled` calls `leaveForList()`
  (`OrgListSection.tsx` `onSettled`). That throws away the new selection, moves
  focus to the list heading and pushes an extra history entry. On a same-URL
  navigation `focusListNext` stays true and misdirects the next Close.
- (c) A failure that arrives after the panel unmounted is lost: `setError` runs
  on a dead component, so the admin never sees the settle failed.

Fix: lift `busy` into `NotOnListPanel` and disable the radios (and Close/Back,
or the whole fieldset) while it is set; ignore `onDone` when the selection has
changed since the request started.

### F2 (LOW-MEDIUM, confirmed) - the `justAdded` fallback is never cleared

`OrgListSection.tsx` `justAdded` and `selectedEntry`. Add "Foo", Delete it
(unused, so allowed), then press browser Back to `/settings/organizations/<fooId>`:
`list.entries` no longer holds Foo, but `justAdded.orgId` matches, so a live
entry panel (Edit notes, Rename, Delete) renders for a deleted entry instead of
"Name not found". Merge does the same. Fix: clear `justAdded` once the list
contains it, and on Delete and Merge.

### F3 (LOW) - focus is lost when the row is not rendered

`OrgListSection.tsx` focus effect. After a search hides the selected row, or
after a segment switch, Close or browser Back finds no row ref, so focus drops
to `document.body`. A related steal: with an entry selected, clicking the
already-pressed segment button moves focus from the button to the row. Fix:
fall back to the list heading when the row ref is missing; do not move focus
when the selection change came from the segment bar.

### Plausible / minor (fix if cheap)

- M1. Close/Back (`PanelBack` `Link`) and `leaveForList` push history rather
  than replacing it. After Delete, Merge or a settle, browser Back returns to a
  dead URL ("Name not found", or the F2 ghost). Use `replace` for the
  post-action exit at least.
- M2. Narrow width plus a value deep link: if the "Not on the list" read fails,
  the panel says "Couldn't load..." but Retry lives in the hidden list pane.
- M3. A stale AGENCY entry link falls back to the URL's view (default Housing
  authorities): "Back to Housing authorities" and the wrong segment pressed.
- M4. `?view=not-on-list&field=agency&value=` (empty value) gives a message
  panel with an empty `h2`. `readOrgLocation` should treat an empty value as no
  selection.
- M5. A picked settle radio cannot be unpicked (no Cancel). This is a UX change
  from the modal, not a correctness issue.
- M6. The status line, the notice and new rows are not live regions. This
  predates the branch, so it is not a regression.

### e2e spec (d71be9ba)

- No strict-mode ambiguities: radio vs confirm button, panel vs list region
  names, and the Close link vs holder-name regexes are all distinct.
- Only the 1280 Desktop Chrome project runs it, so the narrow one-pane layout
  is never exercised.
- Benign race: after a settle confirm, `waitForRewrite` polls the API and then
  `page.reload()` may run before the browser has handled the 202 navigation.
  The reload can land on the settled value's URL ("No record holds this value
  any more"); the next `openValue` still works at desktop width.
- The spec does not cover focus return, the narrow width, or the in-flight
  settle cases.

## For branch B (merge note, not a defect here)

`orgSelection.ts` `RECORD_FIELDS` lists only `housingAuthority`, `agency` and
`accepted_authorities`. Branch B's `organization` field must be added there, or
an organization value's URL falls back to no selection. The handback's merge
notes do not mention this.
