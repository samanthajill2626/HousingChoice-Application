# RE2 - build research findings (S11 Tasks 11.11-11.18)

- Reader: RE2 (read-only; no repo writes besides this file and the reference).
- Plan range: `docs/superpowers/plans/2026-10-06-clean-org-names.md` lines
  21693-26011 (Tasks 11.11-11.18), plus sections 0-3 and 12; Tasks 11.1-11.7
  read for the shapes they hand on (API client + types, the accept `value`,
  orgCopy, useOrgList, OrgPicker, NewOrgDialog, the ContactDetail.test mocks).
- Tree: `W:/tmp/clean-org-names` @ bef84c54 (docs-only on main @d839494a), so
  the live source equals the plan's base.
- Checked: (1) every anchor in the range, including the 8 MISSING (dependent)
  rows of Tasks 11.16/11.17, by replaying Tasks 11.15 -> 11.16 -> 11.17 on the
  plan's own new text; (2) every symbol the range imports from existing code;
  (3) contract fit with plan 3.8/3.10/3.11 and with Tasks 11.1-11.7 as coded;
  (4) whole-repo fallout (dashboard, e2e specs, e2e/performance, app tests,
  docs/issues tooling); (5) each RED/GREEN step traced test-by-test against
  the given implementation; (6) spec D8, D10-D13, section 7.
- Counts: BLOCKER 0, MAJOR 0, MINOR 5.

## Per-check result

1. ANCHORS - clean. All 27 quoted anchors in the range exist exactly once in
   the named file (anchor-check rows OK; the two SEVERAL-FILES rows of Task
   11.11 `:66` and Task 11.12 `types.test.ts:2-3` / `types.ts:323` name their
   file, and the text is unique there). The README anchor (plan:25970) is OK.
   The 8 MISSING rows are all legitimate: replaying Task 11.15's created
   `OrgListSection.tsx` / `OrgEntryDialogs.tsx`, then Task 11.16's edits, then
   Task 11.17's, every `Current` block (plan:23859, 24330, 24350, 24367, 24452,
   24469, 25614, 25629) matches the earlier task's new text byte-for-byte,
   indentation included, and occurs exactly once at the moment it is applied.
   The assembled final files use exactly the CSS-module classes Task 11.15
   defines (no class used-but-undefined, none defined-but-unused).
2. SYMBOLS - clean. Verified: `ApiError(status, code, message, body?)` with
   `.code`/`.body` (`dashboard/src/api/client.ts:13-32`); the api barrel
   re-exports `types.js` and `endpoints.js` (`dashboard/src/api/index.ts:3-5`);
   `failSuggestion` maps ApiError codes through
   `suggestionResolutionErrorMessage`, generic fallback
   `'Something went wrong - please try again.'` (`ContactDetail.tsx:657-693`,
   `types.ts:1597-1599`); `suggestionFor`, `SUGGESTION_NOT_PENDING`,
   `updateContact(contactId, ContactPatch)` with `housingAuthority?: string`
   (`ContactDetail.tsx:72,74`, `endpoints.ts:1445`, `types.ts:2162-2179`);
   `contact` is narrowed non-null before the handlers (`ContactDetail.tsx:538`);
   chip group name `AI suggestion for housing authority` and in-chip
   `role="alert"` (`SuggestionChip.tsx:42,58`, `suggestionTargets.ts:13`,
   `TenantFile.tsx:189`); `Modal` (role dialog named by its title, does not
   portal, header Close button `aria-label="Close"`, `Modal.tsx:166-192`);
   `Button` variants `primary|secondary|ghost|danger`, sizes incl. `sm`, all
   button HTML attributes (`ui/Button.tsx:9-31`); `Spinner size="sm"`
   (`ui/Spinner.tsx:5-12`); `useAuth().isAdmin` (`app/AuthContext.tsx:16,57`);
   `CONTACT_TYPE_LABEL.tenant === 'Tenant'` (`contact/contactProfile.ts:50-56`);
   `humanizeEnum` stays used after Task 11.12 (`AiRunDetail.tsx:62,76`), so no
   unused import; `AiRunRecordView.promptFingerprint` at `types.ts:323` and
   `AiRunDecision` at `types.ts:278-290`; the unit Activity projection passes
   any string `from`/`to` for every audit type (`app/src/routes/units.ts:191-221`)
   and `UnitActivityEvent` has `from?`/`to?` (`types.ts:2955-2956`); every
   CSS token Task 11.15 uses exists in `dashboard/src/ui/tokens.css`. JSX
   conditional spread (`{...(isAdmin && {...})}`) has precedent
   (`app/NavContents.tsx:56`), and tsconfig has no
   `exactOptionalPropertyTypes` (so `title={undefined}` is fine).
3. CONTRACTS - clean. The range uses Task 11.1's endpoint signatures
   (`getOrgUsage(signal?)`, `getNotOnList(signal?)`,
   `getNotOnListRecords(field, value, signal?)`, `checkOrgText(body, signal?)`,
   `mergeOrg` -> `OrgRewriteState`, `runOrgRewriteAgain` -> `OrgRewriteState`,
   `resolveNotOnList` -> `OrgRewriteStarted` whose `skippedSpellings` the
   server always sends - plan:6705/7674/8420), Task 11.2's
   `suggestions.accept(target, value?)`, Task 11.3's orgCopy exports (all 20
   names imported in the range exist there), Task 11.4's `useOrgList` (reload
   keeps `loading` false - no spinner flash on a poll), Task 11.5's
   `OrgPicker` single-mode props and `Remove <value>` chip buttons, and Task
   11.6's `NewOrgDialogProps` (`mode`, `initialCheck`, `onUse(ref, via)`,
   `onDismissSuggestion`, `onAdded(entry)`; `onUse` optional for settings
   mode). Plan 3.8 labels, 3.10 drop-reason map + header line, 3.11 names all
   match. The 13 hand-mirrored drop reasons equal base `DROP_REASONS`
   (`app/src/services/extraction/runTypes.ts:25-38`) plus S7's
   `agency_not_authority` (plan:11925).
4. FALLOUT - clean (the plan names every affected test). Settings tab:
   only `settingsTabs.test.ts` and `SettingsPage.test.tsx` pin the tab list
   (no e2e spec enumerates tabs; `App.test.tsx` never visits settings); the
   App route breaks only `routes.test.ts:348-391`, which Task 11.18 updates;
   `APP_ROUTE_EXCLUSIONS` and the 31-surface pins are untouched, correctly;
   no perf code but `routes.test.ts` parses `App.tsx`. Reason cell: the only
   pins are `AiRunsSection.test.tsx:122-131` (stays green - no model reason)
   and `ai-run-log.spec.ts` (substring `toContainText` checks plus
   `/Prompt fingerprint: [0-9a-f]{12}/`, still matched). Activity labels: no
   existing test uses either type; contact timelines read a different table
   and the landlord feed allowlists types, so neither surfaces the new
   audits. HA accept: no existing unit or e2e test accepts a housingAuthority
   suggestion through the UI. Citations in `e2e/performance/routes.ts` are
   format-checked only (`routes.test.ts:422-430`), so line drift there fails
   nothing.
5. TDD VALIDITY - clean. Every RED is red for the stated reason (11.11: no
   check call; 11.12: missing exports / old Reason text / no header line, the
   PIN passes; 11.13: humanize fallback; 11.14-11.15: module missing; 11.16:
   no admin row buttons; 11.17: module missing + no region; 11.18: no tab),
   and every GREEN passes as written: I traced each test case against the
   assembled code (button sets per row, exact copy strings, call arguments,
   call counts, dialog names). Run commands use valid paths and cwds
   (`e2e/vitest.config.ts` includes `performance/**/*.test.ts`).
6. SPEC - conforms to D8 (exact name -> plain accept; resolution/candidate ->
   accept WITH value; close name -> normal PATCH, server supersedes,
   `app/src/routes/contacts.ts:1652`; agency -> says so + Dismiss), D10
   (three regions, counts with `+N deleted`, Show records per-record links,
   name-variant rows offer only Use, admin actions absent for a VA), D11
   (one rewrite at a time; Run again never for `cleanup`), D12 (Save anyway;
   skipped spellings named), D13 (120/500 caps on inputs).

## StrictMode verdict (useOrgAdmin, Task 11.14)

The final hook (plan:22653-22701) is StrictMode-safe: the mount effect's
cleanup aborts AND releases the in-flight slot and drops a queued request, and
a read releases the slot only while it still holds it
(`inFlightRef.current === controller`), so under mount-cleanup-mount the
second mount's read starts at once and the aborted first read returns at its
`aborted` check without touching the second read's slot. A real unmount, a
`reload()` during a read, and the rewrite-stopped read all behave as the
comments say. The new test (plan:22509-22522) renders under `<StrictMode>`
(React 19, double effects in dev) and asserts the rows and counts load and the
last `getNotOnList` signal is live; against the P13 body it times out (the
queued request is dropped), so it is a real RED for that regression. Full trace
in the reference file.

## Findings

### RE2-1 | Task 11.18 GREEN (e), plan:25951-25952 | MINOR

Evidence: the new issue doc says "the section re-reads all three endpoints
every 2 s while a rewrite runs". Task 11.14 (plan:22421-22431, 22709-22717)
polls ONLY `GET /api/organizations`; the two full scans are read on mount,
after an action and once when the rewrite stops. The same task's `routes.ts`
TODO (plan:25911-25919) states it correctly.
Correction: replace that sentence with "and while a rewrite runs the section
re-reads `GET /api/organizations` every 2 s, then reads the two scans once
more when it stops." (keeps a future registrar from writing a wrong GET
contract).

### RE2-2 | Task 11.12 GREEN (b), plan:22319 | MINOR

Evidence: the header now prints a 64-character unbroken hex string
(`Organization list fingerprint: <sha256>`), but `.detailHeader p` has no
wrapping rule (`dashboard/src/routes/settings/aiRuns/AiRunsSection.module.css:18`:
margin, color, font-size only). At phone width (the run log has a narrow,
detail-only pane) the line overflows the 375 px pane horizontally; the
existing prompt fingerprint is only 12 chars, so this is new.
Correction: in the same commit, add `overflow-wrap: anywhere;` to the
`.detailHeader p` rule in `AiRunsSection.module.css`. Line 18 is one long
ASCII line holding many rules, so edit the unique substring
`.detailHeader p { margin: var(--sp-1) 0 0; color: var(--c-text-muted); font-size: var(--fs-sm); }`
into
`.detailHeader p { margin: var(--sp-1) 0 0; color: var(--c-text-muted); font-size: var(--fs-sm); overflow-wrap: anywhere; }`
(no test changes; the plan's tests still match the full text).

### RE2-3 | Task 11.16 GREEN (b), plan:24488-24493 (and Task 11.15 plan:23544-23646) | MINOR

Evidence: `notice` is cleared only by `runAgain()` (start) and set/cleared by
`onSettled` (Task 11.17, plan:25650, which sets `null` when nothing was
skipped). `onRenamed` sets it only when a spelling was skipped and never
clears it, and notes/spellings/merge/kind/delete/add never touch it. So a
stale "Not kept as a spelling: X (...)" or a stale Run-again refusal stays on
screen after a later, clean rename or settle-free action.
Correction: in `onRenamed` use
`setNotice(result.skippedSpellings !== undefined && result.skippedSpellings.length > 0 ? skippedSpellingsNotice(result.skippedSpellings) : null);`
and call `setNotice(null)` in `closeAndReload` before the reload (no existing
test asserts a lingering notice; the two skipped-spelling tests still pass
because they set it after the reload is requested).

### RE2-4 | Task 11.18 RED (a)/(b), plan:25679-25804 | MINOR

Evidence: after the edit the assertions include the new tab but the prose
still says otherwise: `settingsTabs.test.ts:3-4` header comment ("Team +
System status are the ONLY admin-only tabs; Templates, Notifications, Voice
and Phone numbers are visible to everyone"), the test name at
`settingsTabs.test.ts:42` ("visibleTabs(false) returns Templates +
Notifications + Voice + Phone numbers ...") and `SettingsPage.test.tsx:71`
("a VA sees Templates + Notifications + Voice + Phone numbers ...").
Correction (optional, cosmetic): append "+ Housing authorities & agencies" to
the two test names and add the tab to the header comment's everyone-visible
list. Lines 3-4, 42 and 71 are ASCII; leave line 1 of `settingsTabs.test.ts`
and lines 1-3/8 of `SettingsPage.test.tsx` (non-ASCII glyphs) byte-identical.

### RE2-5 | Task 11.14 GREEN, plan:22713-22717 with Task 11.4 plan:17957-17960 | MINOR

Evidence: each poll tick calls `list.reload`, and `useOrgList.load()` aborts
the previous in-flight `GET /api/organizations` before starting the next
(`abortRef.current?.abort()`, plan:17958). If one GetItem round trip ever
takes longer than `pollMs` (2 s - e.g. a contended DynamoDB Local lane), every
tick aborts the read before it lands and the status line (and the
rewrite-stopped details read) never advances until latency drops. This is the
same shape as the cited precedent (`useBroadcastResults.ts:124-128` also
aborts on each poll), so it is accepted behavior, but S14's rewrite-status
waits inherit it.
Correction (optional): skip a tick while a list read is still in flight (e.g.
`useOrgList` exposes an in-flight flag or the interval checks a ref set around
the read), or chain the next poll with `setTimeout` after each read lands. No
test change is needed for the current cases.

## Not findings (checked, noted for the implementer)

- `e2e/performance/routes.ts:126,803` cite `dashboard/src/App.tsx:117-249`;
  Task 11.18 adds 6 lines inside that range. The citation test is format-only,
  and the ledger already drifts elsewhere (e.g. `ContactDetail.tsx:111-140`
  now points at comments), so nothing fails; refreshing is optional.
- Task 11.11's "eslint ... zero at the base commit" and Task 11.17's eslint
  step were not executed (read-only brief). The new ref reads sit in handlers
  reached only from clicks, the same shape as `onRunExtraction`
  (`ContactDetail.tsx:406-407`, passed down at `:867`), which lints clean at
  base; the `react-hooks/set-state-in-effect` disables follow the existing
  precedent and are at worst unused-directive WARNINGS, not errors.
