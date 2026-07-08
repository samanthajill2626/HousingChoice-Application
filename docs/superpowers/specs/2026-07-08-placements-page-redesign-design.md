# Placements page redesign: phase filter + ledger (2026-07-08)

Status: approved (brainstormed with Cameron via visual companion, 2026-07-08)
Branch: feat/placements-page (worktree w:/tmp/placements-page)

## Problem

The placements page (/placements) is a 7-column kanban board with drag-and-drop.
It does not work on mobile (7 columns behind a horizontal scroll) and is unwieldy
even on desktop. Triage ("what needs action now") is already served by the Today
page, so this page does not need to be an action queue.

The page's two jobs, confirmed with Cameron:

1. Pipeline overview - see how many placements sit in each phase, where things
   are bunching up.
2. Lookup - find a specific placement fast and open its detail page.

## Design overview

Replace the kanban board with ONE model rendered responsively: a phase FILTER
plus a single ledger LIST. Desktop shows the filter as a vertical left rail;
mobile shows it as a horizontally scrollable chip strip under the search box.
Drag-and-drop is removed entirely. No backend, API, or schema changes: the page
keeps using usePlacements() for data and transitionPlacement() for moves.

The design was converged through mockups: option A (phase-grouped ledger) and
option C (inbox-style phase browser) merged, per Cameron's observation that they
are the same model with the filter in a different place.

## Filter

Entries, in order, each with a live count:

- All active (default) - every non-terminal placement
- The 7 phases in canonical PLACEMENT_PHASES order (Application, RTA,
  Inspection, Rent Determination, Contract, Administrative, Closure)
- a divider
- Closed - terminal placements (moved_in / lost), plus any unknown/legacy-stage
  rows (same fallback the old board's Closed area had)

Behavior:

- Desktop (>= 768px, matching AppFrame's existing 767.98px breakpoint): a
  vertical rail on the left of the content area. Selected entry highlighted.
- Mobile (< 768px): the same entries as a horizontally scrollable chip strip
  rendered below the search input. Same selection behavior.
- Selection lives in the URL so views are shareable and back-button friendly:
  - /placements                     -> All active
  - /placements?phase=rta           -> a phase slice (slug = kebab-case of the
    phase name: application, rta, inspection, rent-determination, contract,
    administrative, closure)
  - /placements?view=closed         -> Closed
  - Unknown phase slug falls back to All active (no crash, no redirect loop).
- Counts are computed from the loaded placement list (active count per phase,
  total active for All, terminal count for Closed). Counts do NOT change while
  typing in search (they reflect the unsearched totals).

## List

- All active: every non-terminal placement grouped under phase section headers
  (phase name + count), phases in canonical order, sticky headers while
  scrolling. Empty phases are OMITTED from the list body (the rail/chip counts
  already show the zero).
- Phase selected: a flat list of that phase's placements (no group headers).
- Closed: flat list of terminal placements; rows show their stage label
  (Moved in / Lost) via STAGE_LABELS with the raw-stage fallback for legacy
  rows.
- Within a group, preserve the order the API returns (same as the old board).

Row anatomy (one placement):

- Tenant name (bold) - via tenantName(contacts, tenantId)
- Property address (muted, truncates) - via listingAddress(units, unitId)
- Stage label (STAGE_LABELS)
- DeadlineChip (unchanged component)
- "Porting" chip when isPorting (unchanged behavior)
- Tenant status badge (StatusBadge kind="tenant") when the contact has one
  (same eventual-consistency stance as the old board)
- The WHOLE ROW opens /placements/:placementId. Implement without nesting the
  action-menu button inside the link (no interactive-inside-interactive): the
  row is a container, the primary link covers/stretches over the content, and
  the menu button is a sibling layered above it.

Needs attention:

- EXACTLY the Today-page treatment: a 4px stripe in var(--c-warning) down the
  row's full left edge (::before on a flagged class, overflow hidden clips it
  to the row radius), plus visually-hidden "Needs attention" text for screen
  readers. The little red dot is retired on this page.

Empty states:

- All active empty: friendly "No active placements." message with the New
  placement button still available.
- Phase slice empty (deep link): "No placements in <phase>."
- Closed empty: "No closed placements."
- Search with no matches: "No matches for '<query>'."

## Row action menu (desktop only)

- A trailing kebab button per row (aria-haspopup="menu", aria-label
  "Actions for <tenant>"), following the existing ContactActionsMenu /
  ListingActionsMenu pattern (roving focus, Escape closes, click-outside
  closes).
- Menu content: the FULL 18-stage ladder grouped under phase headers - the
  same ladder the detail page shows. The current stage is marked as current
  and disabled. Terminal entries at the bottom: "Moved in" and a
  danger-styled "Mark lost...".
- Cameron's call: full ladder now, prune later if it proves noisy. Rationale:
  the old phase-level move was lossy (always landed on the phase's first
  stage); desktop has the space.
- Selecting a stage runs the EXISTING pipeline unchanged:
  1. isNoOpMove same-stage guard (the within-phase half of the old guard no
     longer applies - stage-level moves within a phase are now legitimate).
  2. gateFor(from, to): 'lost' -> LostReasonModal; 'finalRent' /
     'inspectionOutcome' -> MovePromptModal; 'none' -> fire immediately.
  3. Optimistic update (row dims; in All view it moves to the target phase
     group immediately), transitionPlacement(), applyPlacement() on success,
     rollback + inline error banner on failure. Same UX as the old board.
- The kebab is hidden below the 768px breakpoint (same one that swaps the rail
  for chips). On mobile, all stage moves happen on the placement detail page.

## Search

- One text input ("Search tenant or property..."), client-side, case
  insensitive substring match over tenant name and property address (both
  already loaded in the contacts/units maps).
- Search filters WITHIN the current filter selection. Default selection is All
  active, which covers the "find a placement fast" case; finding a closed
  placement means selecting Closed first. (Explicit decision - search does not
  override the phase filter.)
- In All view, groups whose rows are all filtered out disappear; group counts
  in headers show matched counts while searching.

## Removed / kept

Removed (this page only):

- @dnd-kit usage: DndContext, sensors, useDraggable/useDroppable, the grip
  handle on cards. dnd-kit is used NOWHERE else in the dashboard, so drop the
  @dnd-kit/* dependencies from dashboard/package.json (verify with a grep at
  build time; run npm install after the dep change).
- Per-card "Move to..." select and standalone "Mark lost" button (Column.tsx).
- The ClosedArea accordion (Closed becomes a filter entry).
- board.ts column model (buildBoard, firstStageOfPhase, FIRST_STAGE_OF_PHASE)
  where no longer referenced; keep isTerminal (still needed for the
  active/closed split) wherever it naturally lives after the refactor.

Kept / reused unchanged:

- usePlacements() (data + applyPlacement)
- transitionGate.ts (gateFor)
- LostReasonModal, MovePromptModal
- DeadlineChip, placementsFormat helpers (tenantName, listingAddress,
  isPorting, shortDate)
- PlacementCreateForm + the "New placement" button (available on both form
  factors)
- PlacementDetail and everything under it (untouched)

## Component structure

All under dashboard/src/routes/placements/:

- PlacementsPage.tsx (replaces PlacementsBoard.tsx as the /placements route;
  update App.tsx) - owns filter/search state (via useSearchParams for the
  filter), the pending-move/gate-modal state machine (ported from
  PlacementsBoard), and composition.
- pageModel.ts - PURE helpers (no React): parse/serialize the filter from
  search params, phase slug mapping, buildLedger(placements, filter, query,
  contacts, units) -> groups/rows model, counts. Unit-tested in isolation
  (replaces board.ts's role).
- PhaseFilter.tsx + module CSS - renders the rail AND the chip strip from the
  same data (two layouts via the 768px media query; one component).
- PlacementRow.tsx + module CSS - row anatomy above, attention stripe,
  stretched link, kebab slot.
- StageMenu.tsx - the desktop kebab menu (full ladder, grouped, current
  disabled, Mark lost).
- PlacementsPage.module.css - page shell (rail + main column layout).

Deleted: PlacementsBoard.tsx/.module.css/.test.tsx, Column.tsx/.module.css,
PlacementCard.tsx/.module.css, ClosedArea.tsx (+ its css/tests), board.ts/
board.test.ts (contents that survive move into pageModel.ts).

Follow the repo's conventions: tokens.css variables only (no hard-coded
colors), CSS Modules, accessibility-first markup.

## Accessibility

- Filter rail/chips: a nav landmark with aria-label "Placement phases"; the
  selected entry uses aria-current="true".
- Sticky group headers are real headings (h2) so the page outlines correctly.
- Rows: the primary link's accessible name is "<tenant> - <stage label>"
  (matches the old card's aria-label pattern so e2e/AT lookups stay natural).
- Attention stripe is decorative CSS + sr-only text (Today pattern).
- Kebab: real button, aria-haspopup="menu", menu keyboard support per the
  existing ActionsMenu pattern. Tab order: row link, then its kebab.
- The whole page is keyboard operable with drag gone - this is strictly better
  than the board (drag was never fully keyboard-safe).

## Testing

- Unit: pageModel.ts (slug parsing round-trip, grouping incl. legacy-stage
  fallback to Closed, counts, search filtering, empty-group omission).
- Component (vitest + RTL): PlacementsPage renders groups with counts; filter
  selection changes the URL and the list; search narrows rows and group
  counts; kebab menu opens, current stage disabled, gated move opens the right
  modal, ungated move fires transitionPlacement optimistically and rolls back
  on error; attention stripe class + sr-only text present when
  placement.attention.
- E2E (Playwright, accessibility-first selectors): update the specs that drive
  the board UI - placement-board.spec.ts (rewrite for the new page:
  rail filtering, search, menu move incl. one gated move), lost-modal.spec.ts
  (Mark lost now lives in the kebab menu), and any scenario specs that step
  through the board (approval-and-move-in.spec.ts, tours.spec.ts,
  placement-create.spec.ts, placement-history.spec.ts - check
  e2e/support/steps vocabulary for board verbs and update them). Add one
  mobile-viewport spec: chip strip filters, rows navigate, no kebab.
- Self-QA through the e2e:session harness (drive the real UI, both viewport
  widths) before claiming done, per repo rules.

## Non-goals

- No backend/API/schema changes.
- No changes to PlacementDetail, Today, Tours, or the placement status model.
- No new triage features (Today owns triage).
- No drag-and-drop replacement gestures (no swipe actions on mobile).
- No saved views / multi-select filters (one phase or All or Closed).
