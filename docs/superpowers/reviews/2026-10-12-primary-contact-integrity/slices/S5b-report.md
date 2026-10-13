# S5b slice report - e2e, docs and issues (S5.6-S5.11)

Kind: SLICE REPORT (mission record). Branch `feat/primary-contact-integrity`,
worktree `W:\tmp\primary-contact-integrity`, base 359645f1 (S5a report).
Plan: `docs/superpowers/plans/2026-10-13-primary-contact-integrity.md`
Tasks S5.6-S5.11 (plan lines 19850-20729; sections 0-3 and the 3.2 rulings
binding; R20, R23 and R24 applied), plus the "S5 additions" of
`research/worklist-deltas.md` that fall in S5.7-S5.11 (the S5.5 item was
ignored as instructed - it was wrong, the seam answered 404). Task S5.12 (main
sync + completion gates) was NOT started: it is the orchestrator's.
Implementer: Claude Opus 5.5, alone in the worktree. Date: 2026-10-13.

Never run: the full `npm run e2e`, `npm run e2e:session`, `npm run dev`,
`npm test`, the human's live ports, the script against anything. No app or
dashboard source was edited. No background command was left running.

## 1. Commits

| task | commit | subject |
|---|---|---|
| S5.6 | 6190a6ba | test(e2e): primary contact integrity - the property box, the open-group fallback box with Check again, the remove handoff |
| S5.7 | 2cf45826 | test(e2e): property-roster asserts the spec-7.3 remove notice |
| S5.8 | 47a476dd | docs(e2e): selectors for the no-primary box, the general-intro box and the new remove notice; the zero-primary dev seam |
| S5.9 | 16207d51 | docs(glossary): property contact; primary contact - the flag is the truth, the handoff rule, when zero primary is reachable |
| S5.10 | d7685c8e | docs(runbook): primary contacts backfill owed on dev and prod after the deploy - dry run, then --apply |
| S5.11 | 384f9804 | docs(issues): tour-reminder-zero-primary-e2e-gap - the ownerless leg now has an e2e path |
| S5.11 (worklist widening) | 3454a0ee | docs(issues): resolve unit-primary-contact-unchecked and restore-without-landlord-can-leave-nobody-reachable; update auto-routing-changes-not-named, contact-list-rule-duplication-and-fake-drift and the lint backlog (22 errors / 17 files) |

Every commit: gating bare `git status` read first, `MERGE_HEAD` absent
(`test -e "$(git rev-parse --git-path MERGE_HEAD)"` -> no-merge-in-progress),
explicit paths only, the plan's subject where the plan gives one, the
`Co-Authored-By: Claude Opus 5.5` trailer. S5.7, S5.8, S5.9 and S5.10 carry one
extra body line naming the worklist additions or adjustments folded in
(section 5). No commit was made while an e2e run was live.

## 2. Files touched (14 + this report)

- NEW `e2e/fixtures/primaryContact.ts` (S5.6)
- NEW `e2e/tests/dashboard-next/primary-contact-integrity.spec.ts` (S5.6)
- `e2e/tests/dashboard-next/property-roster.spec.ts` (S5.7)
- `e2e/support/selectors.md`, `e2e/README.md`, `e2e/scenarios/steps.ts`
  (comment only) (S5.8)
- `documentation/GLOSSARY.md` (S5.9)
- `RUNBOOK.md` (S5.10)
- `docs/issues/tour-reminder-zero-primary-e2e-gap.md` (S5.11)
- `docs/issues/unit-primary-contact-unchecked.md`,
  `docs/issues/restore-without-landlord-can-leave-nobody-reachable.md`,
  `docs/issues/auto-routing-changes-not-named.md`,
  `docs/issues/contact-list-rule-duplication-and-fake-drift.md`,
  `docs/issues/lint-backlog-repo-wide.md` (S5.11 widening)

`docs/issues/relay-provision-includes-deleted-contacts.md` already existed
and was NOT edited (plan S5.11: it stays open as written - see W1).
`docs/issues/INDEX.md` was regenerated and not committed (gitignored,
`.gitignore:62`). Nothing under `e2e/.artifacts/`, `.playwright-mcp/` or
`.superpowers/` was committed.

Byte-exactness: the S5.6 files were extracted from the plan by line range
(`sed -n 19877,19909p` and `19915,20226p`); the S5.9 blocks, the S5.10
section and caseworker line, and the S5.11 zero-primary blocks were applied
from the plan by a script that refuses unless each anchor occurs exactly once,
and then checked present exactly once. S5.7 and S5.8 used the Edit tool on
the plan's quoted strings. Deliberate departures are listed in section 5.

ASCII: `git diff -U0 ... | LC_ALL=C grep -naP '^\+.*[^\x00-\x7F]'` over every
diff above -> no line (positive control `+cafe` with an e-acute -> matched).
Line endings: `git ls-files --eol` over all 130 files the branch changed ->
130 x `i/lf w/lf`; every file touched here has 0 CR bytes
(`tr -cd '\r' | wc -c`). See W5 on `grep -c $'\r'`.

## 3. The specs

`e2e/tests/dashboard-next/primary-contact-integrity.spec.ts`, describe
"Primary contact integrity - a property with no primary contact" (plan text
verbatim; dashboard-next dialect, no Scenario verbs, no reseed; every
contact, property and tour minted per test; nothing provisioned or texted):

1. "(a) the property box offers Make <Name> primary, and one click fixes it" -
   one landlord-typed contact through `POST /api/contacts`, the seam builds an
   ownerless property with that contact as a NON-primary `pm` row; the API
   agrees it is broken (no landlordId, no scalar, `propertyContact` names
   nobody, reason `none`); the Contacts card shows `No primary contact.` and
   the effect line, exactly ONE `Make <Name> primary` and no `Choose a
   primary`; one click -> the box goes, the row link reads `<Name> (primary)`,
   the API shows the flag, the scalar and the block naming him, still no
   landlord.
2. "(b) a booked tour there previews the general intro and says why; Check
   again after the fix shows the tour intro" - the same shape plus a tenant
   and a BOOKED (+48h) landlord-led tour; the contact is put on the tour by a
   silent plan add (`POST /api/tours/:id/roster/members`); the server preview
   carries `introFallback` `{ reasons: ['no_property_contact'], unitId, street
   }` and the general intro; the open dialog's draft equals it; the box
   (dialog `role="status"` filtered by `Using the general intro, not the tour
   intro.`) reads `<street> has no primary contact, so the intro can't name
   the landlord.` with a `Set a primary contact` link (`href` `/listings/<id>`,
   `target="_blank"`); the link opens a POPUP in the same context, the box's
   `Make <Name> primary` is clicked there, the tab closes; Check again in the
   still-open dialog -> the box goes; the new preview has no `introFallback`,
   starts `Hey <tenant>!`, contains `Putting you in a group text with <first
   name>` and `to tour <street>`, and the UNEDITED draft followed it; Cancel
   closes, nothing provisioned.
3. "(c) removing the primary from a property with no landlord hands it to the
   earliest eligible contact" - rows tenant (`other`, added first), landlord A
   (`pm`), landlord B (`owner`); three eligible rows -> `Choose a primary`
   opens edit mode; B is made primary; Remove B -> the confirm names A (`<A>
   becomes the primary contact - new tours and relay groups for this property
   will use them.`), skipping the earlier tenant; after the remove A is primary
   (no `Make <A> the primary contact`, the tenant still offers one), the view
   row reads `<A> (primary)`, the API shows `[tenant other false, A pm true]`,
   the scalar A, no landlord.

`e2e/fixtures/primaryContact.ts`: `createZeroPrimaryProperty(request, {
street, rows })` -> `request.post('/__dev/fixtures/zero-primary-property')`
(relative; the context `baseURL` and the Vite `/__dev` proxy, as
`orgFixture.ts` does); throws on anything but 201; returns `unitId`.

`property-roster.spec.ts` (S5.7): step 4 asserts `<owner> becomes the primary
contact - new tours and relay groups for this property will use them.`; the
header comment (:4-6, :17-19) and the step-4 heading no longer speak of masked
calls.

## 4. Evidence

Every run: from the worktree root, foreground, one at a time, through the
workspace (`npm run e2e -w @housingchoice/e2e -- <files>`), wrapped in
`timeout 585` inside a Bash call capped at 600000 ms, output redirected to
`.superpowers/sdd/S5b-e2e-<label>.log` with `EXIT:` appended. Each run
cold-booted lane 13 (app 10301, dashboard 10311, fake 10321, publicBase
10331; `hc-local-13-`); before and after every run `netstat -ano` showed no
LISTENING socket on those four ports. 0 `[dynamoAdmin]` lines in any run log.

| run | files | result (Playwright summary) | wall clock | log |
|---|---|---|---|---|
| 1 (S5.6 first run + S5.7 RED) | primary-contact-integrity, property-roster (before S5.7) | `1 failed` / `6 passed (36.3s)`, `EXIT:1` | 16:33:17-16:33:55 | `S5b-e2e-run1-pci-and-roster-pre.log` |
| 2 (GREEN, the deliverable) | primary-contact-integrity, property-roster | `7 passed (19.5s)`, `EXIT:0` | 16:35:08-16:35:28 | `S5b-e2e-run2-pci-and-roster-green.log` |
| 3 (regression A) | tour-roster, roster-quiet-hours, relay-intro-variants, contact-create-relay-group, roster-paging, placements-page, deleted-contact-resurfacing, listing-activity | `28 passed (1.4m)`, `EXIT:0` | 16:36:08-16:37:33 | `S5b-e2e-run3-regression-a.log` |
| 4 (regression B) | relay-number-lifecycle, scenarios/approval-and-move-in, scenarios/participant-names, scenarios/post-tour-application, scenarios/tours | `26 passed (3.7m)`, `EXIT:0` | 16:37:53-16:41:38 | `S5b-e2e-run4-regression-b.log` |
| 5 (final tree, stability) | primary-contact-integrity `--repeat-each=3` | `9 passed (21.8s)`, `EXIT:0` | 16:54:20-16:54:42 | `S5b-e2e-run5-pci-repeat3.log` |

Run 1's one failure is S5.7's predicted RED, exactly: "add a PM, make them
primary, and the tour People card follows - then falls back on removal",
`expect(locator).toBeVisible() failed`, `Timeout: 15000ms`, `element(s) not
found` on `getByRole('dialog', { name: 'Remove the primary contact?'
}).getByText('<owner> becomes the primary contact - calls and new relay groups
for this property will go to them.')`; the other three property-roster tests
and the three new ones passed.

Per-test (run 2): (a) 1.0s, (b) 1.6s, (c) 1.2s; property-roster 2.9s, 1.1s,
1.5s, 1.2s. The server log of run 2 shows walk (b) for real: the seam call,
four `preview-open` requests (spec, dialog, Check again, spec), one
`POST /api/units/:id/contacts` from the popup tab.

Run 3 per file: contact-create-relay-group 3 tests (6.5s, 3.5s, 4.8s),
deleted-contact-resurfacing 1 (3.2s), listing-activity 4, placements-page 12,
roster-paging 1, relay-intro-variants 2 (9.4s, 3.4s), roster-quiet-hours 2
(4.2s, 7.1s), tour-roster 3 (2.1s, 2.4s, 1.3s). Run 4: relay-number-lifecycle
6, approval-and-move-in 5, participant-names 1, post-tour-application 5,
tours 9. These are the files the grep of `e2e/tests` found binding the
surfaces S4 changed: the open-group dialog (direct, or through
`teamOpensTourGroup` in `scenarios/steps.ts`), the property page, the contact
Delete dialog, the property Activity card, the standalone create dialog
(unfiltered `role="status"` at `contact-create-relay-group.spec.ts:397` -
safe, that dialog never renders the box), plus the 60-delete spec.

**roster-paging (plan watch item, ruling R24 context):** the test took
**1.4s** in run 3. Its `finally` deletes 60 contacts in one `Promise.all`;
the server log shows 60 `DELETE /api/contacts/:id`, all `statusCode 200`,
the first received at t and the last completed at t + 183 ms, per-request
`durationMs` 124-163. No `contact delete: primary handoff` WARN or INFO line
(none of the 60 is anyone's primary, so the consistent Scan finds no target
and logs nothing). No slowdown.

Other gates run (logs under `.superpowers/sdd/`):

- `npm run typecheck` (root, all five workspaces) on the final tree:
  `EXIT:0`, 0 `error TS` lines (`S5b-typecheck.log`). The e2e workspace's own
  `npm run typecheck` also after S5.6, S5.7 and S5.8: `EXIT:0` each.
- `npm run test -w @housingchoice/e2e` (the e2e vitest suite; it reads
  `e2e/README.md`'s profiler section): `EXIT:0`, `Test Files 22 passed (22)`,
  `Tests 503 passed (503)` (`S5b-e2e-vitest-S5.8.log`).
- `npx eslint` on the four touched TS files (`primaryContact.ts`, the new
  spec, `property-roster.spec.ts`, `scenarios/steps.ts`): `EXIT:0`, no output
  (`S5b-eslint-touched.log`).
- `npm run issues`: `EXIT:0`, `[issues] 408 open, 207 closed, 615 total`
  (`S5b-issues.log`); INDEX regenerated, not committed.
- `npx eslint .` (read-only, for the backlog count): 22 problems (22 errors,
  0 warnings) in 17 dashboard files, all `react-hooks/*`: 14
  `set-state-in-effect`, 4 `refs`, 2 `purity`, 2 `immutability`
  (`S5b-lint-repo.log`).
- `git merge-tree --write-tree --name-only main HEAD`: `EXIT:0`, only a tree
  id (`ac1eee08`) - the S5.12 main sync (main 16ca96cc: RUNBOOK, one issue,
  the join-housing-authority docs) merges with NO conflict
  (`S5b-merge-tree-main.log`).

## 5. Docs and issues

**GLOSSARY** (`documentation/GLOSSARY.md`): `primary contact` replaced by the
plan's entry (the flag is the truth; the scalar is written only by roster
writes and the one-time script, absent on a landlord-only unit, read by
nothing at runtime; the heir hand-off; auto-primary for an eligible add or
edit; when zero primary is reachable; a deleted contact can stay flagged and
the lookup skips it). NEW `property contact` entry after `landlord of
record` (the one shared lookup in `app/src/lib/propertyContact.ts`, its walk,
its users, distinct from the flag and from the owner). `landlord of record`:
"(who we put on threads and dial)" replaced (worklist S4-F4).

**RUNBOOK** (`RUNBOOK.md`): new section "Primary contacts backfill
(`feat/primary-contact-integrity`): owed on dev AND prod after this branch
deploys - dry run, then `--apply`", before the Caseworkers section, marked
NOT YET RUN. Command lines as written there:

- `npx tsx app/scripts/assign-primary-contacts.ts --env local|dev|prod [--lane <L>] [--apply]`
  (the usage line; DRY RUN unless `--apply`; `--lane` with `--env local` only)
- `npx tsx app/scripts/assign-primary-contacts.ts --env dev` (step 1, dry run)
- `npx tsx app/scripts/assign-primary-contacts.ts --env dev --apply` (step 2)
- step 3 the dry run again; step 4 the `noEligible` list to Sam; step 5 prod,
  the same steps after prod's deploy; agents rehearse only with
  `--env local --lane <L>`.

It names the count fields (`targets`, `targetsOnDeletedUnits`, `assigned`,
`scalarAligned`, `skippedOnCondition`, `writeFailed`, `noHeir`, `noEligible`,
`unknown`, `unchanged`, `auditFailed` via the summary lines), every printed
line of `formatAssignSummary`, exit codes 0 / 1 / 2 and the line each failure
ends on, and the cost (one consistent Scan + one contact batch read per
property, one after another: seconds to a couple of minutes). The Caseworkers
section's "Restore without a landlord" sentence now says the earliest-added
eligible contact takes over and a failed read refuses the restore (plan text).

**Issues:**

- `tour-reminder-zero-primary-e2e-gap` - stays `open`; `updated`, two refs
  added; item 1 gains the plan's Update block (the ownerless leg has an e2e
  path through the seam and the new spec; the landlord-fallback leg is still
  open).
- `unit-primary-contact-unchecked` - `status: resolved`, `resolved:
  2026-10-13`. Resolution: P2b (02ccba0f) - `primary_contact` is no longer a
  writable unit field (400 on create and PATCH); only roster writes (and the
  script) set it, always to a flagged row or by REMOVE; the stale masked-call
  comments are corrected (77aebbdf).
- `restore-without-landlord-can-leave-nobody-reachable` - `status:
  resolved`, `resolved: 2026-10-13`. Resolution: shape 1 by
  `landlordWasPrimary` (no flagged row hands off; 11b05393, d7991940); shape
  2 by the heir function (earliest-added eligible; d7991940) and, when nobody
  is eligible, the page's re-read (9a3242e7) showing the no-primary box
  (a566c3e3) or the empty-state sentence (90af0532).
- `auto-routing-changes-not-named` - stays `open`; `updated`; title no longer
  names the removed "sole-landlord promotion". Update block: both rules
  widened (earliest-added heir; auto-primary on an edit of the own row,
  deleted counts as absent), the Activity card now records every automatic
  change after the fact (9cde6088, ba944a79), the remove confirm reads the
  server heir, the Delete dialog warns without naming; the "Related"
  paragraph is resolved by the shared lookup (857355d6, e7710793, 03b058e9,
  d95feb1e); the vacant-slot claim is still type-only but routes nowhere.
- `contact-list-rule-duplication-and-fake-drift` - stays `open`; `updated`.
  Update block: `landlordWasPrimary` is one shared rule; the fake's primary
  decisions call `decideAutoPrimary` / `chooseHeir` / `applyPrimary`, pinned by
  the parity test (f44a4c3a); `removeContact` reads are consistent (b198e2e0).
  Still open: seat/claim duplication (now joined by the 409
  `primary_contact_deleted` rule, decided in route, repo and fake), the
  routing-pointer test (moved into `isAutoRoutingEligible`, not merged), the
  live-object fake `getById`.
- `lint-backlog-repo-wide` - stays `open`; `updated`; title and a new dated
  status line: 22 errors across 17 files (the `set-state-in-effect` at
  `RosterConfirmDialog.tsx:113` went with 2905b44c). `AGENTS.md`'s dated
  "23 errors across 18 dashboard files" sentence was left alone, as told.

## 6. Divergences from the plan text

- D1 (worklist S5 additions, folded into the named commits with a body
  line): S5.7 rewrites the property-roster comments (:4-6, :17-19, :244);
  S5.8 adds the 503 sentence to the restore-dialog row of `selectors.md` and
  rewrites the `scenarios/steps.ts` import comment (tourContacts now
  value-imports `resolvePropertyContact` from `lib/propertyContact.js`, which
  value-imports `unitContacts` and `isDeleted`); S5.9 rewrites the
  landlord-of-record entry's "(who we put on threads and dial)"; S5.11 adds
  the four issue blocks and the lint backlog update in a SECOND commit
  (3454a0ee) so the plan's own S5.11 commit keeps its literal subject.
- D2 (S5.8 step 1, plan text vs shipped DOM): the plan's last sentence said a
  503 remove makes "the row's error slot" read `Couldn't check the other
  contacts - try again.`. Shipped: the confirm stays open and BOTH the
  dialog's `<p role="alert">` (`ListingDetail.tsx` remove Modal, rendered when
  `rosterError.key === removingContact.contactId`) and the edit row's alert
  behind it (same key, `rowError`) read it, so an unscoped
  `getByRole('alert')` is a strict-mode violation. The row now says so and
  tells the reader to scope to the dialog.
- D3 (S5.8 step 3): one sentence added to the general-intro box row - a
  reason line's text is its sentence plus ` <link label>`, so match by
  substring, never `exact` (the S4a report's e2e matching note).
- D4 (S5.10, the SHIPPED CLI and DOM, per the brief): added the usage line
  `--env local|dev|prod [--lane <L>] [--apply]`; "(throttling)" -> "(throttling,
  for example)"; `from` is "the deleted or missing contact"; the Activity row
  is named ("Primary contact set automatically", "<Name> - set by a one-time
  data repair"); step 1 says the per-property lines come before the summary
  and the `done` line after it, and that only a TARGET's line carries the
  heir's `contactId` (the plan said every line did); the spot-check now
  excepts a target the live landlord of record takes over (P1 already falls
  back to that landlord, so the page shows no box there - only the deleted
  row's "(deleted)"); step 4 covers the caseworker-only property (the box
  offers no button, `NO_ELIGIBLE_LINE`); the cost reads "seconds to a couple
  of minutes" (S5a W5) instead of "seconds"; the closing failure sentence
  names the line each failure path ends on (`FAILED: <error>` after an abort,
  `FAILED before the run started ...` for an unresolved target, the
  `COMPLETED WITH FAILURES` WARN for a run with failures) instead of one line
  for all.
- D5 (titles): `auto-routing-changes-not-named` and `lint-backlog-repo-wide`
  titles were updated (the old ones named a removed rule and a stale count).
- D6 (method): S5.7's RED step ran in the same lane boot as S5.6's first run
  (run 1) instead of a separate run; the plan's `timeout 900` became
  `timeout 585` inside a 600 s tool call (brief). Extra runs beyond the
  brief: regression B and the repeat-each=3 stability run.
- D7 (brief paths): `tour-roster.spec.ts`, `roster-quiet-hours.spec.ts` and
  `relay-intro-variants.spec.ts` live in `e2e/tests/`, not
  `e2e/tests/dashboard-next/`; run with their real paths.

## 7. Product defects

None. Every spec passed on the first run (S5.7's planned RED aside); no
locator needed a change, so S4's DOM matched the plan's selectors.

## 8. Worries for the orchestrator (non-blocking)

- W1. `docs/issues/relay-provision-includes-deleted-contacts.md` (left
  unedited per the plan) still says the `memberFromContact` docblock "says
  such a row is excluded from every send ... FALSE"; S1 (03b058e9) rewrote
  that docblock, so that bullet is now history, and its line refs drift.
- W2. A 503 on removing the primary shows the same alert twice (the dialog
  and the edit row behind it); a screen reader may announce it twice. A UX
  nit, not filed.
- W3. The selectors.md no-primary-box row (plan text, kept) says "The UI
  cannot reach this state". The BOX can be reached through the UI - for
  example "Restore without a landlord" and then "+ Add contact" of a tenant
  (the picker offers tenants; a tenant is never auto-primary). What the UI
  cannot build is the imported shape: an ELIGIBLE contact left non-primary.
- W4. Pre-existing app ERROR lines in run 3 (tests green, files untouched
  by this branch): `relayAnnouncement: v1 aggregation update failed:
  missing` x2 during contact-create-relay-group, and `relay group stuck
  connecting past the max wait` x10 (the lean world's seeded connecting
  group).
- W5. In this Git Bash `grep -c $'\r'` is vacuous: a control string holding a
  CR returned 0. LF was verified with `tr -cd '\r' | wc -c` and `git ls-files
  --eol` (section 2). Earlier slice reports' "zero CR bytes" claims may have
  used either; `git ls-files --eol` now shows all 130 branch files LF.
- W6. Runs 2-4 ran on 2cf45826's tree; later commits change only docs and the
  `scenarios/steps.ts` comment block (typecheck re-run green). Run 5 re-ran
  the new spec on the final tree.
- W7. The GLOSSARY primary-contact entry keeps the plan's one over-long line
  ("live landlord of record the lookup still uses the landlord). A DELETED
  contact can stay flagged when nobody could") - kept literal.
- W8. `e2e/.artifacts/session.pid` is left behind after each Playwright
  teardown (the launcher is killed, pid 17480 gone); harmless - the config
  checks the pid is alive before reusing a lane.
- W9. The new spec's (b) walk books its tour 48 h out, which arms the
  reminder ladder; nothing is due inside a suite run, but a FUTURE-`now`
  unscoped reminder tick in another spec would text its fresh numbers (no
  spec asserts global send counts today).

Next step: Task S5.12 (plan line 20730) - the orchestrator's main sync and
the five completion gates. `git merge-tree` predicts a clean merge with main.
