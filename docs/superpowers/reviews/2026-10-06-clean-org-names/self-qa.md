# Live self-QA - feat/clean-org-names (branch A)

- Orchestrator-driven, 2026-10-07, on the FINAL gated commit 4b777d26 (after
  the one main sync; no source change since). Hermetic lane 13 started with
  `npm run e2e:session` from the worktree (dashboard http://127.0.0.1:10311,
  app :10301, fake-twilio :10321) - never Cameron's live ports. Driven with
  the project Playwright MCP (bundled Chromium) through
  `browser_run_code_unsafe`, measuring the DOM (accessible names, request
  bodies, geometry) rather than eyeballing. Signed in with
  `POST /auth/dev-login` as founder@example.com (admin). Stopped with
  `npm run e2e:stop`; the lane's four ports were confirmed free afterwards.
- Screenshots (gitignored): `W:/tmp/clean-org-names/.playwright-mcp/clean-org-names-01..20-*.png`.
- Browser console: React DevTools info lines only - no error or warning.

## Results

| # | What was walked | Result | Evidence (measured) |
|---|---|---|---|
| 1 | Settings > Housing authorities & agencies as an admin: both lists, counts, notes, admin actions | PASS | tab selected; 12 housing authorities + 7 agencies (13/8 rows with headers); Atlanta row "AHA, Atlanta Housing, ... - 2 tenants, 1 other contact, 1 property" with Edit notes / Spellings / Rename / Merge / Change kind / Delete; DCA row carries its research notes; "Not on the list" says every stored value is on the lists (lean world); no page overflow at 1280 px (01) |
| 1b | Add a run-unique agency through "Is this really new?" | PASS | typing "Mercy Car" lists "Close names already on the list: Mercy Care, CaringWorks" (02); "QA Helpers 562322" -> "Yes, add it" -> new row with 0 uses |
| 1c | Rename it: counts before the confirm, status line to done without a reload | PASS | the dialog states "0 tenants, 0 other contacts, 0 properties, 0 deleted" and that the old name is kept as a spelling (03); status "Updating records: renaming ..." -> "Last update finished: renaming ..." in about 2 s by polling; the row shows the new name with the old one as its spelling (04) |
| 2 | Tenant edit form: type `AHA` | PASS | options "Atlanta Housing Authority (AHA)" and "Augusta Housing Authority (AHA)" (05); help text "The organization that runs the voucher." in the field's description |
| 2b | Pick Atlanta when Atlanta is already stored | PASS | Save sends NO PATCH (an unchanged housingAuthority is never sent) |
| 2c | Unresolvable typed text, not picked (code review R1-ADV-FE-1 fix) | PASS | blur note "Not saved - pick a name from the list, add it as new, or clear the text."; Save refused with that alert, focus back on the field, no PATCH (06) |
| 2d | A unique spelling typed, not picked (`DCA`) | PASS | blur note "Save will use Georgia Department of Community Affairs."; Save PATCHes `{"housingAuthority":"Georgia Department of Community Affairs"}`; header shows the full name (07) |
| 2e | Remove the chip and save | PASS | PATCH `{"housingAuthority":""}`; details show "Housing authority -" |
| 2f | `AHA` -> pick Atlanta -> save | PASS | PATCH `{"housingAuthority":"Atlanta Housing Authority"}`; header "Voucher 1BR - Atlanta Housing Authority" (08) |
| 3 | Property edit form: add a second housing authority | PASS | "Housing authorities" multi-picker, typed "Decatur", picked; PATCH `{"accepted_authorities":["Atlanta Housing Authority","Decatur Housing Authority"]}` (09); the Properties page's housing authority facet lists "Decatur Housing Authority" under its full name (10). The "BY HOUSING AUTHORITY" summary counts only Available / Coming soon properties and the lean world has none, so it reads 0 for every authority - expected |
| 4 | Blast composer: the filter picks from the list; typing never changes the estimate | PASS | typing the full name: 0 draft creates, "Reaches 1 tenant" unchanged, "Preview recipients" DISABLED with "Pick the housing authority from the list, or clear the text." (code review R2-FE-3 fix), no "Add ... as new" option (11); the pick: exactly one create with `audience_filter.housing_authority: "Atlanta Housing Authority"`, Preview enabled (12) |
| 5 | "Not on the list": a run-unique off-list value via `POST /__dev/org-fixture` on a tenant created for the walk | PASS | row "Atlanta HA QA698814 - Housing authority - 1 - Unknown" with Show records / Use another name / Add as new / Clear; Show records lists "Qa698814 Selfqa - Tenant" (13) |
| 5b | Settle it with Use (Remember this spelling on by default) | PASS | the dialog states the value and "(1 record)"; checkbox checked (14); rewrite `use` done with `housingAuthority: 1`; the row is gone; Atlanta's spellings now include the value; the tenant holds "Atlanta Housing Authority"; status "Last update finished: changing ... Housing authority fields: 1." (15) |
| 6 | Mobile width 360 px | PASS (one known residual) | Settings: no page overflow (345/345); the lists' tables scroll inside their own `overflow-x: auto` wrapper; the section is reached through the "Settings section" select, which lists "Housing authorities & agencies" (16). Tenant form: the picker's listbox stays inside the viewport (33-312 of 360), both AHA options shown (17); no dialog or page overflow. RESIDUAL (filed `org-picker-note-wrap-reflow`, code review R3-FE-7): the refused-text note wraps to two lines at this width, so the Agency field moves down 18 px on blur (18) |
| 7 | Cleanup script rehearsal on the lane (`--env local --lane 13`), never dev or prod | PASS | planted "Atlanta (AHA)" and "HUD VASH" on two new tenants and "Fulton County" on unit-0002 via the dev seam (all three listed in "Not on the list": match / other_kind / match); DRY RUN exit 0: "would" rewrite 1 housing authority spelling, move 1 agency, rewrite 1 property member, writes nothing; APPLY exit 0: the tenants hold "Atlanta Housing Authority" and (housing authority removed) agency "HUD-Veterans Affairs Supportive Housing (HUD-VASH)", the unit holds "Fulton County Housing Authority"; the lock released `done`; RG-5 / blank-value / audit-failed lines all 0; "Not on the list" empty |
| 7b | Settings after the cleanup apply | PASS (note) | status "Last update finished: the one-time cleanup. Housing authority rewritten: 1, Unit members rewritten: 1, Records planned: 3, Records written: 3, Contacts scanned: 7, Units scanned: 2, Moved to agency: 1." (19) - accurate; on prod it will carry the scan totals too (a long but truthful line) |
| 7c | Property Activity label | PASS | "Housing authority cleaned up" with "Georgia Department of Community Affairs, Fulton County -> Georgia Department of Community Affairs, Fulton County Housing Authority" (20) |

## Not walked live

- The AI housing-authority suggestion accept through "Is this really new?" and
  the `agency_not_authority` drop label: covered by unit tests and by
  `org-lists.spec.ts` part 4 (the gate's e2e run, 324 passed).
- Merge, delete, kind change, admin spelling edits and Run again: unit and API
  tests only (not in any e2e spec - named in the handback).
