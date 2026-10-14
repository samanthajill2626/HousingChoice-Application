# D12 - S8 Tasks 8.1, 8.2, 8.3, 8.4, 8.6: decisions record

Dispatch D12 of the feat/last-heard-from build (implementer, 2026-10-13).
Scope: the end-to-end specs of spec section 8 (1), (2), (3), (4) and (6),
plus the two knowing rewrites (listing-activity's `/No reply/i` assertions
and the `already sent` selector sweep). Task 8.5 (the full-suite C6
re-proof) is the orchestrator's. Plan:
`docs/superpowers/plans/2026-10-12-last-heard-from.md` (S8 preamble and
shared helpers, Tasks 8.1-8.4 and 8.6, sections 3.4 #10 and 11). Binding
corrections applied: F7 / tenants-F3 (8.3), tenants-F4 (8.2), and the
D9 / D10 / D11 shipped-markup notes. Only e2e files changed.

## Commits

- 52c77c90 Task 8.1 - new `e2e/tests/dashboard-next/last-heard-from.spec.ts`
  (four tests: 1:1 text + staff-reply control :96, missed call :128,
  email :145, relay group text :176 in a reseeding nested describe);
  `e2e/support/selectors.md` "Contact page / Last heard from" row.
- f514fe5d Task 8.2 - `contacts-list-facets.spec.ts` gains the Status-facet
  test (:147), the `heardAt` / `createTenantApi` / `setTenantStatus`
  helpers and a header paragraph; two selectors.md rows.
- d169675b Task 8.3 - new `review-recipients-heard-from.spec.ts` (:119);
  the sweep result is in the commit body; one selectors.md row.
- 79b10211 Task 8.4 - new `send-outcome-cards.spec.ts` (:151, :195, :235,
  :293) and the knowing `listing-activity.spec.ts` rewrite (:162 title,
  :227 listitem row, :237-240 and :269-273 assertions); one selectors.md row.
- a25f1673 Task 8.6 - new `follow-up-tab.spec.ts` (:135, :228); two
  selectors.md rows.

`npm run typecheck` (all workspaces, e2e included) exited 0 after each
commit; `npx eslint` on the six touched spec files exited 0. Every new file
and every added line is ASCII.

## Evidence

- One hermetic lane (lane 10). Each new or changed spec ran green twice;
  a combined run of all six touched files in suite order passed 17/17.
- The one real RED (8.4 Step 1): `listing-activity.spec.ts` as it stood
  failed 1 of 4 at the old `:231` - `getByText(/No reply/i)` count 0
  received 2 (the live "No reply yet" chips). The old div-filter row
  locator did NOT fail first. After the rewrite: 4/4, twice.
- No app or dashboard defect surfaced: every spec passed against the
  shipped S1-S7 markup.
- `npm run e2e:stop` exited 0 and no listener survived on the lane's four
  ports (10001, 10011, 10021, 10031).

## Decisions and divergences (all contract-preserving)

1. Session restart. The preflight's commit-staleness guard
   (`e2e/support/preflight.ts:87`) refuses a session booted at an older
   commit than HEAD. After the 8.1 commit the lane was stopped and started
   once more; 8.2, 8.3, 8.4 and 8.6 then ran (twice each, plus the combined
   run) BEFORE being committed in task order, because a commit would have
   staled the session again. The commits add only the e2e files that ran.
   Every `npm run e2e` invocation also reseeds the lane in globalSetup
   (`preflight.ts:131`), so cross-run residue is reset; the combined run is
   the cross-file check.
2. 8.3 columns (D9: the header cells are a `div[aria-hidden="true"]` beside
   the list). The plan's page-wide `getByText(label).first()` became a
   lookup scoped to the list's parent frame
   (`review-recipients-heard-from.spec.ts:165`), still by TEXT, still with
   `list.getByText(label)` count 0 - it proves the header sits beside the
   list and cannot land on an unrelated page "Name" or "Status".
3. 8.3 `Select all` / `Deselect all` use `exact: true` (:194, :199):
   Playwright's default name match is a case-insensitive substring, so
   "Select all" also matches "Deselect all".
4. 8.3 sweep (F7 / tenants-F3): `git grep -i "already sent\|consent not
   recorded"` over `e2e/` (tests and scenarios) finds only visible-tag reads
   and comments; the only review checkbox read by accessible name,
   `e2e/scenarios/steps.ts:1082`, is a first-name PREFIX regex and survives
   the ASCII " - " change. No e2e selector reads a checkbox name SUFFIX; no
   edit.
5. 8.2 (tenants-F4): rows are asserted by the run-unique first name only;
   `freshTenant(...).name` appears only as the fake carrier's persona label.
6. 8.4: `send-outcome-cards.spec.ts:148` names one regex for "both Mark
   buttons"; the Undo test's return to waiting asserts both buttons back
   (count 2, :229); the Schedule-from-Tours test reads the tour id from the
   URL path (:270); the form-mode test re-checks zero tours after Cancel.
7. 8.6 (D11): a group is selected by a region name STARTING with the street
   line (the heading's name is `<unitLabel><n> waiting`, no separator); the
   tab by `/^Follow up\b/` (bare name while no count). The in-place check
   waits for the Undo button first (adjudication F10); after the reload the
   empty state is asserted before the group's zero count, and the
   Properties row gets a positive visibility check (`follow-up-tab.spec.ts:260`)
   before its "no waiting" negative. No assertion reads `via` (D10).
8. selectors.md rows follow the plan's texts, adapted to the shipped
   markup: the review header is aria-hidden (find by text in the list's
   frame; Select all needs exact); property-card rows live in up to four
   named group lists and a waiting row's `Not interested` button shares the
   declined chip's visible text; the Follow up heading has no separator and
   rows leave only on the next load; the dev-seam row adds `409
   send_exists` and the `via` warning.

## For the orchestrator

- Residue-sensitive assertions in the full run: 8.2's "the replied tenant
  leads the last-heard sort" assumes no spec plants a FUTURE
  `last_heard_from_at` and `workers: 1`; 8.3's order check compares only its
  own three tenants' positions.
- Any later e2e-only commit in this worktree needs an `e2e:stop` and a new
  `e2e:session` before the next filtered run (the staleness guard).
