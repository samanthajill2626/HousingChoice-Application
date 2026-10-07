# Org settings layout - handback

Date: 2026-10-07. Branch: `fix/org-settings-layout` (pushed). Lane: small fix
(review section 7, ruling 6). Built against
[`design-review.md`](design-review.md) section 7 and Option B in
[`mockups.html`](mockups.html). `mockups.html` is not edited.

## 1. What was built

### Settings > Housing authorities & agencies (Option B)

- **Segments with counts.** Housing authorities / Agencies / Not on the
  list. This is a group of toggle buttons (`role="group"`, name `Lists`,
  `aria-pressed`). Each button is named `<list> <count>`, for example
  `Agencies 7`. The counts follow the search, so they show where the matches
  are.
- **Search** (`Search names and spellings`). It matches names and spellings
  the way the lists compare them (`normalizeOrgText`: case, punctuation and
  spacing ignored). A query made only of punctuation (`-`) is matched as
  typed. For "Not on the list" it matches the stored value.
- **List and detail panel**:
  - Each list row is one link: one Tab stop, named by the exact name or value.
  - The row's use count ("29 records" / "Not used", or for a value
    "Housing authority - 3 records") is the link's accessible description.
  - The selected row is `aria-current="page"`.
  - The list sits in a region named by its heading. The panel is a region
    named by the entry or value.
- **Two-pane shell.** It uses the shell's JS half (`useTwoPaneNarrow`, 860px)
  and its `paneActive` / `paneHidden` classes, as the AI run log does. At or
  below 860px one pane shows at a time. The panel then has `Back to <list>`,
  and nothing above it except the update status. Above 860px the panel has
  `Close` at its top right and stays in view (sticky) while a long list
  scrolls.
- **Entry panel**:
  - Kind.
  - Spellings as chips (`list` named `Spellings of <name>`). A spelling that
    holds a comma is one chip; nothing is comma-joined.
  - Full notes, keeping their line breaks, at reading width.
  - Used by: `usageText`, or "Not used".
  - Labeled actions: Edit notes (everyone); Edit spellings, Rename, Merge and
    Change kind; then Delete, set apart in the danger color.
- **"Not on the list" panel**:
  - Field, records and what it is, plus `Show records` / `Hide records`.
  - Admins get one fieldset, `Settle this value`, with the `settleChoices()`
    options as a single radio group. Clear comes last, set apart. The confirm
    for the picked choice shows under it: the former `SettleDialog`, now
    inline as `SettleConfirm`, with the same logic, sentences, pickers,
    remember-spelling rule and button names.
- **D10 contract kept.**
  - Everyone views all three lists, adds names and edits notes.
  - For a VA, the admin actions and the whole settle group are absent, not
    disabled.
  - The server still enforces `requireRole('admin')`; no API change.
- **Visible wait reason (P11).** While a rewrite runs:
  - Entry panel: Rename, Merge, Change kind and Delete are disabled under an
    amber line, "Another update is still running. Rename, Merge, Change kind
    and Delete wait until it finishes." The buttons point to it with
    `aria-describedby`; no `title`.
  - "Not on the list": the settle fieldset is disabled under "Another update
    is still running. Settling waits until it finishes."
- **Focus**:
  - Picking a row moves focus to the panel's heading (`tabIndex=-1`).
  - Back, Close or the browser's Back returns focus to that row.
  - After Delete, Merge or a settle, the panel closes and focus goes to the
    list's heading, because the row is about to disappear.
  - A deep link or page load takes no focus.
- **Add** opens the new entry in the panel straight away. It shows from the
  POST answer until the re-read lists it.

### Full width (rulings 2 and 5)

The 880px cap is gone from `SettingsPage.module.css`; there is no page-level
cap anywhere. Controls and prose that would stretch got their own widths
(review section 4):

- Templates: textareas 48rem, quick-reply input 32rem, hints 70ch. The
  read-only note sizes to its text.
- Team: invite fields up to 24rem; the Role select sizes to its options
  (`roleField`).
- Voice: greeting paragraph 42rem; the current-cell box sizes to its content.
- System: quiet-hours lede 70ch.
- Org tab: lede and notes 70ch, settle box 48rem, search 20rem.

### URL scheme (addition 1)

| URL | Shows |
|---|---|
| `/settings/organizations` | Housing authorities, nothing selected |
| `/settings/organizations?view=agencies` (or `not-on-list`) | that list, nothing selected |
| `/settings/organizations/<orgId>` | the entry; its kind picks the list |
| `/settings/organizations?view=not-on-list&field=<field>&value=<value>` | one "Not on the list" value |

"Not on the list" values ARE URL-addressable. A value has no id: it is its
field plus its exact stored text, so both travel as query parameters. A query
string carries any text, including `/`, `%`, `,` and spaces. A path segment
would have had to carry `/` and `%`. `field` must be a record field and
`value` is matched exactly, so a value held in two fields stays two rows.

Other behavior:
- A stale link (merged or deleted entry, settled value) shows a "Name not
  found" or "No record holds this value any more" panel with Back/Close.
- The search lives in component state, not the URL.
- The route is now `organizations/:orgId?` (`App.tsx`).
- The scheme is pinned in `orgSelection.ts`, and `orgSelection.test.ts` tests
  it.

## 2. Findings P1-P12

| # | Status |
|---|---|
| P1 width | Closed: no cap. Controls carry their own widths (above). |
| P2 action column | Closed: no row actions. Labeled `secondary` buttons in the panel; Delete set apart. |
| P3 settle wall of buttons | Closed: one radio group plus one confirm in the panel. |
| P4 queue buried | Closed: its own segment, with its count visible from the start. |
| P5 tables misaligned | Gone: no tables. |
| P6 mid-word breaks | Closed: `overflow-wrap: break-word` on names and values; rows give the name the room left by the count. |
| P7 comma-joined spellings | Closed: chips. |
| P8 noisy "Used by" | Closed for the list: one total, or "Not used" in muted italics. The panel keeps `usageText` with its zeros (see deviation 3). |
| P9 tall rows / dashes | Closed: notes only in the panel, at reading width; empty spellings and notes say so in words. |
| P10 phone | Closed: one pane at a time, Back link, no horizontal scroll (390px scrollWidth = clientWidth, measured). |
| P11 keyboard / screen reader | Closed: one Tab stop per row, a visible described-by reason, focus moves. |
| P12 VA | Closed: same layout for both roles; admin controls absent. |

## 3. Gates

Run in this cloud checkout at the branch head, with no main sync (as
instructed):

- `npm run typecheck`: exit 0. Covers every workspace, including e2e.
- `npm test -w @housingchoice/dashboard`: exit 0 - 229 files, 4179 passed, 1 skipped (baseline before
  this branch: 227 files, 4147 passed, 1 skipped; the two new files are
  `orgSelection.test.ts` and `OrgListPane.test.tsx`).
- Gate 5: `npx eslint $(git diff --name-only --diff-filter=d origin/main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')`.
  There is no local `main`, so it diffs against `origin/main` (20ccdb12).
  Result: exit 0, no errors, over the 12 `.ts`/`.tsx` files the branch changes
  (`App.tsx`, `InviteForm.tsx`, the org settings files and their tests, and
  the e2e spec).
- Baseline before any change: typecheck exit 0; dashboard suite 227 files and
  4147 tests passed.
- Browser check. There is no backend here, so I ran the dashboard Vite dev
  server with every API call mocked inside Playwright's Chromium, using the
  seeded starting list and the review's 8 messy values. Not committed.
  - Captured as admin and as VA at 1920, 1280, 860 and 390, plus a live
    rewrite.
  - Also captured Templates, Team, Voice and System at 1920.
  - The keyboard path matched (Enter on a row focuses the panel heading;
    Shift+Tab reaches Close; Close and the browser's Back return focus to the
    row).
  - Two fixes came out of it: the phone segments now share one full-width
    row with the count under each label, and the Team Role select no longer
    stretches.

### Not run here

**Docker is not available in this environment** (`docker info` fails), so
none of these ran:
- `npm test` (the app workspace needs DynamoDB Local)
- `npm run e2e`, including the updated `e2e/tests/dashboard-next/org-lists.spec.ts`
- any live check against the real stack

The e2e spec typechecks and lints clean, but it has never been run. You said
you will run e2e and the live check locally.

`npm run smoke` needs no Docker and did run: exit 0 ("1612 import specifier(s)
across 281 emitted file(s) resolve under plain Node"). This branch does not
touch the app workspace.

## 4. Deviations from the review and mockups

1. **Merge button text.** It reads `Merge`, not the mockup's `Merge into...`.
   The accessible name stays `Merge <name>` (S14 contract), and visible text
   must be contained in the accessible name (WCAG 2.5.3). The other buttons
   keep their existing accessible names too (`Rename <name>`,
   `Edit notes for <name>`, ...).
2. **Nothing is selected on load.** The mockup shows the first entry selected
   at desktop. The page shows a prompt in the panel instead: auto-selecting
   would rewrite the URL on every visit and fight the phone's list-first
   view.
3. **Panel "Used by" keeps `usageText`**, zeros included (the mockup reads
   the same way). This keeps branch B's added organization count flowing
   through with no edit here. The list rows use `usageTotal`, which B should
   extend the same way.
4. **Segments are toggle buttons** (`aria-pressed`), not a nested tablist
   (the cost the review noted for Option C).
5. **Layout uses only parts of the shell.** It takes the JS half and the
   pane-hide classes, but not `.body/.left/.right`. Those are built for the
   comms-plus-details pages: `.left` takes the larger share, `.right` bleeds
   into the AppFrame padding, and both need a height-bounded page. The grid
   here mirrors the shell's 860px breakpoint, and a comment says so.
6. **The settle confirm is inline, not a modal.** This is "one
   pick-and-confirm step in the panel": its Cancel button is gone (pick
   another choice, or Close). The `Settle <value>` dialog title is gone with
   it; the panel heading carries the value.
7. **After Delete, Merge or a settle the panel closes** and focus goes to the
   list heading (addition to the brief).
8. **`InviteForm.tsx` gained one class** (`roleField`) for the Team width
   fix. It is the only `.tsx` outside the org files that changed.

## 5. Merge notes for branch B (feat/caseworkers)

- `orgCopy.ts` is **unchanged**.
- **`NotOnListSection.tsx`.**
  - Unchanged: `settleChoices`, `recordsText`, `rewriteKey`, `HolderList` and
    the `SettleDialog` logic.
  - Its JSX body keeps its original indentation (only the `Modal` wrapper and
    footer were replaced).
  - Removed: `rowKey`, `NotOnListTableRow` and the table-rendering
    `NotOnListSection`, replaced by `NotOnListPanel` (and `NotOnListList` in
    `OrgListPane.tsx`).
  - If B edited the table row (an organization field, a kind beside a Use
    target), re-apply it in the panel and list.
  - If B edited only `settleChoices` labels, they flow through unchanged.
- **`OrgListSection.tsx`.**
  - The tables and `adminActions` are gone; the panel actions are in
    `OrgDetailPanel.tsx`.
  - The dialog block at the bottom is unchanged except `onMerged`,
    `onDeleted` and `onAdded`.
  - If B added a `FIELD_LABEL` entry (`Organization`), it shows in the value
    row's description and the panel's Field fact with no change here.
  - The segments do not cover an organization list. If B adds one, it needs
    a fourth segment, or the organization values go under "Not on the list"
    as now.

## 6. Noticed, not changed

- On the System tab, the quiet-hours Save button sits tight against the
  "System status" heading below it. The two sections render side by side in
  one fragment with no gap. This predates this branch and is unrelated to
  width.
- Repo-wide lint is not clean in files this branch did not change: 3 errors
  in `QuietHoursSection.tsx`, `TemplatesSection.tsx` and `useSystemStatus.ts`
  (`react-hooks/*`, part of the known backlog). Only their `.module.css`
  changed here, so gate 5 does not lint them.

## 7. Commits

- `a4ea3f2` fix(settings): org lists as list + detail panel (design review Option B)
- `151d2fd` fix(settings): full width for every Settings tab; controls keep their own widths
- `c25566f` fix(settings): org panel polish from a browser check at 1920/1280/390
- `fe3fb93` fix(settings): Team's invite Role picker keeps its own width
- `d71be9b` test(e2e): org-lists Settings specs drive the list + detail panel
- this handback
