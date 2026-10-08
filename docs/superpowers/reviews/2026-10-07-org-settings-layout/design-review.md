<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-10-07).** This document describes how
> this work was *designed at the time of writing*. The work shipped to `main` (fast-forward to
> 1861e154) and its branch `fix/org-settings-layout` and worktree were deleted during cleanup.
> **This file is NOT current documentation and the live code may have drifted from it - do not
> treat it as authoritative guidance on how the system should be built or behaves today.** For
> current truth read the code (`dashboard/src/routes/settings/`) and the project's living docs
> (`RUNBOOK.md`, `e2e/README.md`, `documentation/GLOSSARY.md`). Kept only as a point-in-time
> record of intent; what was actually built is in `handback.md` beside it.

# Settings > "Housing authorities & agencies" - layout design review

Date: 2026-10-07. Branch: `fix/org-settings-layout` (cut from `main` @ 20ccdb12).
Kind: ASSESSMENT ONLY - no source changed. **Cameron's rulings (2026-10-07) are
in section 7 and override the recommendation in section 3.** Mockups: [`mockups.html`](mockups.html)
(open in a browser; desktop and phone side by side for each option).

Code under review:
`dashboard/src/routes/settings/OrgListSection.tsx` + `OrgListSection.module.css`,
`NotOnListSection.tsx`, `OrgEntryDialogs.tsx`, and the shell `SettingsPage.tsx` +
`SettingsPage.module.css`. Design intent: spec
`docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md`
D10-D13; branch B deltas from the same spec at revision 10 on `feat/caseworkers`
(4884aa91).

## 1. How the page was looked at

- Hermetic `npm run e2e:session` in this worktree (lane 5: web :9511, app :9501).
  The live :5174/:8080 stack was not touched. The session was stopped afterward
  with `npm run e2e:stop`, and the lane's four ports were confirmed free.
- Data: the `full` reseed profile (`POST /__dev/reseed?profile=full`), which
  carries the 19-entry starting list with real usage counts. Neither seed
  profile has any "Not on the list" values (by design: seeds write exact
  names). So eight realistic messy values were planted through the hermetic-only
  `POST /__dev/org-fixture`:
  `AHA`, `atlanta housing authority`, `DCA / Step Up`, `Partners for Home`,
  `Fulton Cnty Housing Authority` (housing authority field), `HUD-VASH`,
  `Atlanta Housing` (agency field), and `MHA` (a property's accepted
  authorities). Together they hit every D4 resolution: match, name variant,
  ambiguous, compound, close, unknown and other kind.
- Roles: dev-login as the seeded founder (ADMIN) and as the seeded VA
  (non-admin).
- Widths: 1280x900, 1920x1080 and 390x844 (phone).
- To answer question 4, every Settings tab was also captured at 1920 with the
  880px cap removed. A CSS rule was injected into the page for this; it was not
  a source change.

Screenshots are under `.playwright-mcp/` in this worktree (gitignored, so they
are NOT part of this commit; the main checkout's `.playwright-mcp/` holds the
same files). Below they are cited by short name `[S:<name>]` =
`.playwright-mcp/org-layout-<name>.png`.

## 2. Problems found

Measurements are from the live DOM (`getBoundingClientRect`), admin, full
profile, unless a role is named.

### P1. The page uses about half the screen on a wide monitor (confirmed)

`SettingsPage.module.css` `.page { max-width: 880px }` caps every Settings tab.
Main content width vs used width:

| Viewport | Main column | Used | Share |
|---|---|---|---|
| 1280 | 1040px | 880px | 85% |
| 1920 | 1680px | 880px | 52% |

At 1920 about 800px of blank space sits to the right while every row wraps into
three or more lines [S:admin-1920-viewport]. Your "half the screen" reading is
accurate at 1920; at 1280 the cap costs little. The cap is not the main problem
at 1280 - P2 is.

### P2. The admin action column is a 2x3 block of unlabeled text (confirmed; the main defect)

- Each list row renders six `variant="ghost"` buttons (Edit notes, Spellings,
  Rename, Merge, Change kind, Delete) in a `flex-wrap` cell
  (`OrgListSection.tsx:113-125`, `:197-253`).
- A ghost button has a transparent background and border at rest
  (`ui/Button.module.css` `.ghost`). So the six render as loose bold words in a
  ragged grid, with nothing marking them as controls or showing which ones
  belong together. This is the "column that does not display properly"
  [S:admin-1280-viewport].
- At 1280 the auto-sized actions column is 219px. The six buttons wrap to three
  lines, so EVERY admin row is 117px tall, whatever its content. With 19
  entries the two list tables total about 2,600px.
- Removing the cap does not fix it. At 1920 uncapped the buttons still wrap to
  4 + 2 and rows stay about 85px [S:uncapped-1920-organizations]. The problem
  is six buttons per row, not width.
- The column header is screen-reader-only (`.srOnly` "Actions"), so sighted
  users see an unlabeled column.
- Labels are inconsistent: "Spellings" is a noun among verbs; its aria-label
  says "Edit spellings for X".
- Delete sits beside Rename and Merge with the same weight and no separation.

### P3. "Not on the list": the action buttons take over the table (confirmed)

- Each row offers "Show records" plus every `settleChoices()` label as its own
  ghost button (`NotOnListSection.tsx:473-499`). Labels are long and dynamic -
  "Move to Housing authority as Atlanta Housing Authority", "Split into Georgia
  Department of Community Affairs + Step Up" - and a row can carry five or
  six [S:admin-1280-not-on-list-viewport].
- The actions column takes 488 of the table's 880px (55%). That squeezes Value
  to 77px and "What it is" to 139px, so the resolution text wraps to 5 lines
  and rows are 103-123px tall [S:admin-1920-not-on-list-viewport].
- The choices are really ONE decision ("what should this value become?")
  presented as a wall of peer buttons. Clear (destructive) sits inline with
  Use.

### P4. The work queue is buried under the reference lists (confirmed)

For an admin, "Not on the list" is the actionable part of the page (the
cleanup). It starts about 2,960px down at 1280. A keyboard user needs about
124 Tab presses from the start of the main content (more from the sidebar) to
reach its first control. The status strip
says nothing about how many values are waiting.

### P5. The two list tables don't line up (confirmed)

Both tables use automatic layout, so column widths follow content per table.
At 1280 the Housing authorities table puts Name at 116px and Notes at 142px;
the Agencies table directly below puts them at 160px and 173px. Stacked tables
whose columns shift between sections read as "wonky" even before the buttons
[S:admin-1280-agencies vs S:admin-1280-viewport].

### P6. Names break mid-word (confirmed)

`.nameCell { overflow-wrap: anywhere }` in a narrow auto column breaks words
anywhere: "atlanta housing authorit / y" and "Fulton Cnty Housing Authorit / y"
at 1280 and 1920 [S:admin-1920-not-on-list-viewport], and "Atlant / a Housi /
ng Autho / rity" on a phone [S:admin-390-rows]. `break-word` (wrap at spaces
first) plus a sensible minimum column width would avoid it.

### P7. Comma-joined spellings are ambiguous (confirmed; a correctness issue in presentation)

Spellings render as `entry.spellings.join(', ')`, but spellings contain commas
themselves. The seeded Atlanta entry has FIVE spellings, the last being
`Atlanta, aha, Atlanta housing` (`app/src/lib/orgStartingList.ts:18`). On screen
that reads as seven: "AHA, Atlanta Housing, Housing Authority of the City of
Atlanta, Atlanta (AHA), Atlanta, aha, Atlanta housing". The same happens for
DCA ("DCA, Department of Community Affairs") and Fulton ("Fulton, Fulton
County"). Staff cannot tell what will match. Chips fix this; the chip style
already exists in the same stylesheet (`.spelling`, used by the Spellings
dialog).

### P8. "Used by" is noisy, and branch B makes it longer (confirmed)

Every row spells out all three counts, zeros included: "0 tenants, 0 other
contacts, 0 properties" wraps to three lines in a 124px column. An unused entry
(the only kind Delete accepts) is not visible at a glance. Branch B adds an
organization (partners) count to the same string (spec rev 10, D10 plus the
branch B Settings delta; `usageText()` in `routes/orgs/orgCopy.ts:578`).

### P9. Long notes make tall rows (confirmed, minor)

Notes run up to 500 characters (D13). The 24rem `max-width` doesn't hold
inside an auto table, and the DCA note wraps to five or six lines at 1920
uncapped. Empty cells show "-" in Spellings and Notes for most rows, which
adds visual noise.

### P10. Phone: actions are off-screen, and scrolling right detaches them from the name (confirmed)

- Each table sits in `.tableWrap { overflow-x: auto }`. At 390 the housing
  authority table is 429px wide inside a 327px box, so the actions column is
  entirely off-screen with no scroll hint [S:admin-390-rows]. "Not on the list"
  is 740px inside 327px [S:admin-390-not-on-list].
- Scrolling right brings the buttons in but takes the row header (the name)
  off-screen, so a column of Edit notes / Delete floats with no visible owner
  [S:admin-390-rows-scrolled-right, S:admin-390-not-on-list-scrolled-right].
  (Screen readers are fine: every aria-label includes the name.)
- Rows are 181-240px tall; names break per P6.

### P11. Keyboard and screen reader cost (confirmed)

- 158 focusable controls on the page for an admin (19 entries x 6, plus about
  35 in "Not on the list", plus headers). Six Tab stops per entry.
- While a rewrite runs, Rename / Merge / Change kind / Delete are `disabled`
  with the reason only in `title`. A disabled button is not focusable and a
  title is not reliably announced, so keyboard and screen-reader users get no
  reason at all. The reason should be visible text.
- Good, and worth keeping: each list is a labeled region (`aria-labelledby`),
  the row header is a `th scope="row"`, and every action's accessible name
  includes the entry name.

### P12. Non-admin view: fewer buttons, same layout faults (confirmed)

A VA gets one "Edit notes" per row and "Show records" in "Not on the list", so
rows drop to 64-84px [S:va-1280-viewport, S:va-1280-not-on-list]. P1, P5, P6,
P7, P8, P9 and P10 still apply [S:va-390-rows]. The fix should be the same
layout for both roles, with the admin menu simply absent (D10 / S14 S8: absent,
never disabled, for a VA).

## 3. Options

All three keep D10's contract: everyone views, adds and edits notes; admin
actions are absent for a VA; the server still enforces `requireRole('admin')`.
Mockups for each: [`mockups.html`](mockups.html).

### Option A - Row menu, wide tab, tidy cells (RECOMMENDED)

What changes:

1. **Width per tab** (see section 4): the organizations panel gets about 1280px.
2. **Fixed, shared column widths**: `table-layout: fixed` plus one `colgroup`
   used by both list tables (Name about 21%, Spellings 31%, Notes 22%, Used by
   15%, Actions 11%), so the two tables line up (fixes P5). Names wrap with
   `overflow-wrap: break-word` (fixes P6).
3. **Actions**: one visible `Edit notes` button (everyone), plus, for admins
   only, a `...` icon button named "More actions for <name>". Its menu holds
   Edit spellings, Rename, Merge into..., Change kind, a divider, then Delete
   in danger color. Row height is set by content again (about 40-60px), and an
   admin row costs 2 Tab stops instead of 6. While a rewrite runs, the four
   blocked items stay in the menu, disabled, under a visible line "Another
   update is still running" (fixes the P11 title-only reason).
4. **Spellings as chips** using the existing `.spelling` style (fixes P7).
   Show at most about 5 chips, then "+N more", which expands in place.
5. **Notes** clamped to two lines with a "More" toggle (`aria-expanded`).
   Empty notes and spellings render empty or as a quiet dash only.
6. **Used by** as stacked short lines with zeros left out ("11 tenants /
   16 properties / 1 other contact"), or "Not used" in muted italics when all
   counts are zero. Branch B adds a partners line without widening the
   column. (`usageBreakdown()` stays as is for the confirm dialogs, which want
   every count.)
7. **"Not on the list"**: the row keeps `Show records` visible and puts the
   admin choices into one `Settle` menu button, headed `Settle "<value>"`. The
   items keep `settleChoices()` order unchanged, Clear sits below a divider,
   and every item still opens the existing `SettleDialog` confirm. This shrinks
   the actions column from 488px to about 200px.
8. **Findability**: the status strip gains "N values not on the list - Review
   them", a link to the section's heading (fixes P4 for mouse and keyboard
   alike).

Phone (< 768px, `NAV_BREAKPOINT_PX` / `useIsMobile`): the same `<table>`
renders each row as a stacked block (CSS `display: block` on rows and cells,
with each cell's column label shown via a `data-label`/`::before` label, or a
visually-hidden-header pattern). The name stays at the top with the `...` menu
beside it. No horizontal scroll and no detached buttons (fixes P10). If the
CSS-table restyle proves fragile for screen readers (some browsers drop table
semantics once rows get `display: block`), render a `<ul>` of rows below the
breakpoint from the same data instead; the plan should pick one and test it.

Keyboard and screen reader:

- The menu button has `aria-haspopup="menu"` and `aria-expanded`, and its
  accessible name includes the entry ("More actions for Atlanta Housing
  Authority"; "Settle AHA").
- The menu follows the APG menu-button pattern: Enter/Space/ArrowDown opens on
  the first item, ArrowUp/ArrowDown move, Home/End jump, Escape closes, and
  choosing an item or pressing Escape returns focus to the trigger. When a
  dialog closes, focus returns to the row's trigger, not to the top of the
  page.
- The table semantics are unchanged (region, `th scope=row`, column headers).
  The actions header can become a visible "Actions" label right-aligned over
  the column.

Components to reuse (there is no generic row menu yet):

- **`routes/placements/StageMenu.tsx`** is the right base for POSITIONING. It
  is a row kebab that renders through a React portal with `position: fixed`,
  precisely because a row's ancestors clip (`overflow: hidden` there). The org
  tables have the same trap: `.tableWrap { overflow-x: auto }` forces
  `overflow-y` to auto, so an absolutely positioned popover inside a row would
  be clipped or would add a scrollbar. StageMenu also closes on scroll and
  resize and checks both refs on outside-click.
- **`ui/StatusMenu.tsx`** is the right base for KEYBOARD behavior: it is the
  only menu that implements the APG arrow, Home and End keys plus focus
  restore. (It is a status pill with radio items, so it is not reusable as-is.)
- Do NOT copy `ContactActionsMenu` / `ListingActionsMenu` / `TourActionsMenu`.
  They have the right look (`.menu`, `.item`, `.divider`, `.danger` - reuse
  those styles) but no arrow-key handling, and they are absolutely positioned
  (clipped inside a table).
- Recommendation: extract a small `ui/RowActionsMenu` (portal positioning from
  StageMenu, keys from StatusMenu, styles from ListingActionsMenu) and use it
  for both the entry menu and the Settle menu. The other kebabs can migrate
  later as a separate change.
- `Button` (`ghost` for Edit notes and Show records, `secondary` for Settle).
  Tokens only, as now.

Cost: small to medium, all front end. No API or spec contract change; D10's
"each row shows the name, its spellings, its notes, and how many records use
it" still holds. The existing unit tests that find these buttons by role and
name (`OrgListSection.test.tsx`, `NotOnListSection.test.tsx`) and the e2e spec
`e2e/tests/dashboard-next/org-lists.spec.ts` must open the menu first. The
item names can keep today's accessible names, so selectors change by one step.

### Option B - List and detail panel

A compact list (name and total records) on the left; selecting an entry opens a
detail panel on the right with chips, full notes, the usage breakdown and
labeled admin buttons. "Not on the list" works the same way, with the settle
choices as a radio group and one confirm. Built on the existing two-pane shell
(`ui/twoPaneShell.ts`, breakpoint 860px; the AI run log already uses a list
and detail layout).

- Phone: one pane at a time with a Back link (the shell's existing behavior).
- Keyboard and screen reader: one Tab stop per entry in the list. Selection
  needs `aria-current` (or a listbox), and focus must move into the panel on
  select and return to the row on Back. That focus work is easy to get subtly
  wrong.
- Pros: the best use of a 1920 screen, the most room for branch B (an
  organization breakdown, span-both-kinds rows), and it scales to the
  300-entry D13 limit.
- Cons: spellings and notes hide behind a click, which works against the
  page's main reading job ("which name do we use, what does it cover"). It is
  the largest build, and D10's "each row shows..." needs a spec note.

### Option C - Three views and cards

A segmented control at the top - Housing authorities (12) | Agencies (7) |
Not on the list (8) - with a search box, and entries as cards (name, chips,
notes line, usage, `...` menu).

- Phone: single-column cards; the segmented control fits as three equal
  segments.
- Keyboard and screen reader: the segmented control is a tablist nested inside
  the Settings tablist. That is acceptable but adds a second tab level to
  explain, and each card is a list item headed by the name. 2 Tab stops per
  card.
- Pros: "Not on the list" gets its own view and count (P4 solved strongly),
  and search helps as the list grows.
- Cons: cards are less scannable than aligned columns for comparing names and
  spellings, and take more height per entry (about 110px) than Option A's
  rows.

### Recommendation

**Option A.** It fixes every finding (P1-P12) with the least change to the
spec, the tests and the user's mental model. The actions problem (P2/P3) is the
real defect, and A removes it at any width. Two parts of C are worth taking
into A if wanted: a search box above the lists (once the list grows past about
40 entries), and putting "Not on the list" first for admins. Keep B in reserve
if the list grows toward hundreds of entries.

## 4. Does changing the 880px shell cap affect other Settings tabs?

Yes. The cap is on the shell (`SettingsPage.module.css` `.page`), so it applies
to all eight tabs. Captured at 1920 with the cap removed
[S:uncapped-1920-<tab>]:

| Tab | Has its own cap? | Effect of removing the shell cap |
|---|---|---|
| Team | No | The table spreads acceptably, but the invite form stretches: the email input and the Role select each become about 770px wide. Worse. |
| Templates | No | Textareas and the quick-reply input go to about 1,630px; text lines are far past readable length. Worse. |
| Notifications | Yes (560px) | No change. |
| Voice | Partly (lede 42rem, input 24rem) | The voicemail-greeting paragraph becomes one 1,600px line. Worse. |
| System status | Partly (status block 720px) | The quiet-hours block above it is uncapped and stretches. Slightly worse. |
| AI run log | No (two-pane) | The list and detail panes both gain room. Better. |
| Phone numbers | No | The pool table spreads out; neutral to slightly better. |
| Housing authorities & agencies | No | Wider, but the action buttons still wrap (P2). Better only with Option A. |

So do NOT raise or remove the cap globally. Make it per tab instead:

- Add an optional `wide?: boolean` to `SettingsTab` in `settingsTabs.ts` (the
  file is already the single source of truth for tabs) and set it on
  `organizations`. Phone numbers and AI run log are reasonable later
  candidates.
- In `SettingsPage`, move the cap from `.page` to `.panel`: the default panel
  stays at 880px, and a wide tab's panel gets about 1280px. The H1 and tab row
  can then span the main column (the tab row's bottom border runs the full
  width, but the tabs themselves stay left-aligned). Otherwise the tab row
  would change width as you switch tabs. This choice is the one visible effect
  on the other tabs; if you'd rather the tab row never changes, keep the
  header at 880px and let only the wide panel extend past it.
- Inside a wide tab, keep prose (the lede, section ledes) at a reading width
  of about 70ch.
- Phone is unaffected: below 768px the main column is narrower than either
  cap.

## 5. Branch B (spec rev 10) - room left by Option A

- "Used by" gains an organization (partners) count: Option A's stacked,
  zero-omitting lines take a fourth line only where that count is non-zero;
  the column width does not change.
- An `organization` row in "Not on the list" offers Use (a name of EITHER
  kind), Add as new (staff pick the kind) and Clear - never Move or Split. The
  Settle menu takes those items unchanged; show the kind beside each Use
  target ("Use Step Up (agency)") because the candidates span both lists. The
  Field column must fit "Organization" and the longest label, "Property
  housing authorities" (fixed at about 16%).
- Kind change is not blocked by organization holders, and Delete counts
  distinct records - both are dialog copy only, no layout impact.
- Sequencing: branch B also edits this page. If Option A lands first, branch B
  rebases its Settings delta onto the new row-menu structure. If B lands
  first, Option A carries B's organization rows. Either way, the conflict
  check should read the other branch's plan (per the orchestration
  playbook).

## 6. Open questions for Cameron

1. Option A as recommended, or pull C's "Not on the list first, with a count"
   ordering in as well?
2. Per-tab width: should the H1 and tab row span the full main column (the
   tabs never move), or stay at 880px with only the org panel extending past
   them?
3. Should the screenshots be committed alongside this review? There is no repo
   precedent for images under `docs/superpowers/reviews/`. The set is about
   1.7 MB in total.
4. Lane: this is a fix to a merged feature's UI. It is not trivial (a new
   shared menu primitive, plus test and e2e selector updates), so it fits the
   small-feature pipeline (spec note, plan, build, review) rather than the
   small-fix lane.

## 7. Cameron's rulings (2026-10-07)

1. **Option B (list and detail panel)**, not the recommended Option A. The
   build follows the full feature pipeline (spec, plan, isolated build,
   independent review). The Option A findings P1-P12 remain the defect list
   the build must close.
2. **Full width, responsive.** No page-level width cap: the page fills the
   main column at any screen size and shrinks with it. "Limiting screen sizes
   and having a bunch of blank space doesn't serve a purpose." This supersedes
   section 4's per-tab `wide` flag. What section 4 found still applies at the
   CONTROL level: inside a full-width page, a form field, textarea or prose
   paragraph keeps its own sensible width (sized to its content), so Templates'
   text boxes and Team's invite form do not stretch to about 1,600px. The scope
   (this tab only, all Settings tabs, or every dashboard page) is an open
   question for the spec.
3. **Screenshots are not committed.** They stay in `.playwright-mcp/`
   (gitignored).
4. **`mockups.html` stays** in this folder until the feature is built, as the
   reference to compare the built page against. Remove or stamp it after that
   comparison.
5. **Scope: every Settings tab goes full width** (Cameron, later the same
   day). The 880px cap leaves the Settings shell; Templates, Team, Voice and
   the quiet-hours block get control-level widths so their fields and prose do
   not stretch.
6. **Lane: a polish fix, not a feature.** The small-fix lane applies (no
   brainstorm/spec/plan mission), on this branch and worktree, not on main.
   It is **secondary to branch B (feat/caseworkers)**: B keeps priority and
   merges first, and this branch absorbs any file overlap at its main sync.
   The two share some files (`OrgListSection.tsx`, `NotOnListSection.tsx`,
   `orgCopy.ts`) but no behavior.
7. **Option B details** (proposed 2026-10-07, not objected to): three
   segments with counts (Housing authorities, Agencies, Not on the list); a
   search over names and spellings; the selected entry in the URL
   (`/settings/organizations/<id>`); one pane at a time on a phone with a Back
   link; "Not on the list" settles through one pick-and-confirm step in the
   panel instead of a row of buttons.
