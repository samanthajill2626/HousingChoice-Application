# Build research - merged dispositions (build orchestrator)

Phase 1 of the build, 2026-10-12 14:10-14:45 EDT, on
`fix/caseworker-integrity` @670fb701 (code identical to main @19607658).
Seven read-only opus readers ran in parallel:

| Reader | Scope | Result | File |
|---|---|---|---|
| RA | S1 (D1 accept fence), 47 plan operations replayed on scratch copies | 0 BLOCKER, 0 CORRECTION, 8 NOTE | `RA-S1-findings.md` |
| RB | S2 (D2 type change), 50 operations replayed, linted, typechecked and executed from an in-memory overlay | 0 / 1 / 4 | `RB-S2-findings.md` |
| RC | S3 (D3 tours/placements), 52 anchors scripted | 0 / 1 / 3 | `RC-S3-findings.md` |
| RD | S4 (properties), 42 anchors scripted, restoreWithLandlord read against the roster writes | 0 / 0 / 4 observations | none (nothing to correct) |
| RE | S5 (seeds, e2e, docs); seed checker run in memory; e2e specs typechecked and linted on scratch copies | 1 / 2 / 5 | `RE-S5-findings.md` |
| RF1 | plan-independent invariant sweep, I1 + I2 (writers, readers, code consumers) | 0 / 1 / 3 | `RF1-invariants-I1-I2-findings.md` |
| RF2 | plan-independent invariant sweep, I3 + I4 + the newly routine ownerless property | 0 / 0 / 3 | `RF2-invariants-I3-I4-findings.md` |

The readers' byte-exact quotations and full inventories are run state in the
worktree's ignored `.superpowers/sdd/research/` (one file, one kind).

## Main moved during research

main is now @5c0d3f6a, three commits past the base: e27868bc (flyer voucher
size), 794de277 (RUNBOOK: caseworkers DEPLOYED dev + prod 2026-10-12, release
1.5.1, "the follow-up fix/caseworker-integrity ... ships separately", with the
hand-clear for an authority written onto a converted caseworker), 5c0d3f6a
(Matching voucher prefill). They touch `app/src/repos/unitsRepo.ts`,
`app/src/lib/unitFields.ts`, `app/test/unitsApi.test.ts`, `RUNBOOK.md`,
`documentation/GLOSSARY.md` and dashboard listing/broadcast files; the one
main sync at handback will meet S4's `unitsRepo.ts` / `unitsApi.test.ts` and
S5's RUNBOOK edit.

Consequence for the spec: its premises "#19 is merged but NOT deployed" (header)
and "#19 is not live anywhere" (section 2 item 7, no repair step) no longer
hold. Cameron deployed #19 knowingly and documented the manual remedy in the
RUNBOOK, so nothing in this build changes; the D1 legacy fallback (an active
journal claimed by the old code) is now load-bearing for production rather
than theoretical. Recorded for the handback.

## Dispositions

| # | Finding | Severity | Ruling | Lands in |
|---|---|---|---|---|
| RA-N1 | `ContactDetail.test.tsx:700-706` comment still says "these three" after Task 1.10 | NOTE | ACCEPT - comment fix in Task 1.10 | U1 |
| RA-N2 | `aiRunVerdicts.test.ts:645-651,657-658` comments call the plan read eventually consistent; false after Task 1.1 | NOTE | ACCEPT - reword in Task 1.1's commit; the file joins the S1 lint list | U1 |
| RA-N3..N8 | recovery-path answers, mid-slice intermediate state, RF1-F1 placement, repo-level tie on DynamoDB Local, extra export, CRLF | NOTE | no action | - |
| RB-C1 | the slice ASCII checks use repo-relative paths; from a reset cwd they read nothing and print 0 | CORRECTION | ACCEPT for EVERY unit: ASCII checks run from the worktree with an explicit `cd`, a `test -f || echo MISSING` per new file, and `git diff -U0 19607658 -- <files> \| grep '^+'` for edited files | all units |
| RB-N3 | `CaseworkersList.test.tsx` renders the dialog whose copy S2 delegates | NOTE | ACCEPT - added to the S2 gate's dashboard run | U2 |
| RB-N1,N2,N4 | fixture swap proven; W2 proven by execution; still-compiles list | NOTE | no action | - |
| RC-F1 | `toursApi.test.ts:2545-2548` comment becomes false once Task 3.2's fixture seeds a nameless tenant | CORRECTION | ACCEPT - step 3g of Task 3.2 (exact text in RC-F1) | U3 |
| RC-F2 | sweep record inaccuracies | NOTE | record only | - |
| RC-F3 | main moved; #19 deployed | NOTE | see "Main moved" above | handback |
| RC-F4 | the two baseline lint errors shift to `TourDetail.tsx:342`, `ScheduleTourForm.tsx:242` | NOTE | expected at the S3 gate | U4 |
| RD-1 | no test pins `restoreWithLandlord`'s 3-attempt retry limit | NOTE | ACCEPT - one case mirroring `unitsRepoRoster.integration.test.ts:217-233` | U5 |
| RD-2..4 | unit vanishing on the 3rd attempt answers 409; `landlordName` is first + last only (the app's display-name convention, `app/src/lib/contactName.ts:74`); nested audit fields render as a plain restore row | NOTE | no action | - |
| RE-1 | Task 5.5: the API move to Lost carries no `lostReason` and answers 400 at setup | BLOCKER | ACCEPT - `data: { toStage: 'lost', source: 'manual', lostReason: { category: 'tenant_withdrew' } }` | U7 |
| RE-2 | Task 5.9 `unit-primary-contact-unchecked` line refs shift once S4 lands | CORRECTION | ACCEPT - re-derive by grep at S5 time | U7 |
| RE-3 | Task 5.8 Resolution gives the contact-list add 404 `landlord_not_found`; it keeps 404 `contact_not_found` | CORRECTION | ACCEPT - RE-3 wording | U7 |
| RE-4 | `stale-suggestions-survive-contact-retype` (open, low) is partly resolved by D1 | NOTE | ACCEPT - a "Partly addressed" paragraph + `updated`, status stays open (a docs correction, not a mutation surface) | U7 |
| RE-5 | `landlord-of-record-no-reassign-ui` calls UnitCreateForm "the only dashboard writer of landlordId" | NOTE | ACCEPT - RE-5 wording | U7 |
| RE-6 | stale "title is S4's choice" comment | NOTE | ACCEPT - comment fix; the selectors row names `getByRole('dialog', { name: 'Restore property' })` | U7 |
| RE-7 | refresh the `deriveTenantStatus` ref; cross-link `reimport-reverts-unknown-triage` | NOTE | ACCEPT | U7 |
| RF1-F1 | the housing-authority "Is this really new?" dialog lets Accept on a TEAM MEMBER's chip write the authority by contacts PATCH (`ContactDetail.tsx:766-823`), never reaching D1's 409 | CORRECTION - plan-unlisted surface | QUESTION Q1 (mission rule: unlisted surface -> STOP for a ruling) | pending |
| RF1-F2 | non-accept writers of tenant-only fields (Settings move, direct PATCH/POST edits, tenant-status `porting`, importer) | NOTE | I1 is scoped to accepts - record; ACCEPT F2d as one bullet in `import-bypasses-contact-type-rules` (the importer writes voucherSize and notes on converted caseworkers) | U7 |
| RF1-F3 | `transitionPlacement` decides "leaving a terminal stage" from an eventually consistent placement read | NOTE | L1 class - ACCEPT one clause in the RUNBOOK L1 paragraph | U7 |
| RF1-F4 | inventory completeness | NOTE | record only | - |
| RF2-N1 | the ownerless "Remove the primary contact?" notice says "tours fall back to the landlord of record" - false whenever it renders (no landlord of record exists); Task 4.13's new test pins it for a state this branch makes routine | NOTE - reader disagrees | QUESTION Q2 (copy) | pending |
| RF2-N2 | an API-only PATCH of `landlordId` leaves the contact list's landlord row behind | NOTE | ACCEPT - one sentence in `landlord-of-record-no-reassign-ui` (reuse restoreWithLandlord's row swap) | U7 |
| RF2-N3 | spec section 5 names one seat writer; restore-with-landlord adds a second (landlord-typed) | NOTE | record only (I4 holds) | - |

## Open questions sent to the planner (2026-10-12)

- Q1 (RF1-F1): fix in this branch - in `onAcceptSuggestion`, a
  `housingAuthority` chip on a contact not typed `tenant` skips the "Is this
  really new?" review and sends the plain accept, so the server answers 409
  `suggestion_contact_not_tenant` and the chip shows the D1 sentence (about 5
  lines + one ContactDetail test, beside Task 1.10)? Or file it as a low issue?
- Q2 (RF2-N1): change the ownerless notice copy in Task 4.13 (string, its two
  test pins and the selectors row) to a true sentence, or keep it and file a
  low copy issue?
