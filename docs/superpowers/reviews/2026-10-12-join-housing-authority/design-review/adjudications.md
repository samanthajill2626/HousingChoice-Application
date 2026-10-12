# Spec review round 1 - adjudications

Spec: `docs/superpowers/specs/2026-10-12-join-housing-authority-design.md`
Round 1 reviewed revision 1 (@d33dc1e6). Two independent opus reviewers:
`R1-reviewer-a.md` (14 findings) and `R1-reviewer-b.md` (17 findings).
The two lists overlap heavily; they are merged below as J1-J21. Every
load-bearing claim about existing code was re-read by the planner before
ruling (trimJsonBody at app.ts:138-142; Today's triage read at
today.ts:870-874; the edge guard at cloudfrontBehaviors.test.ts:136-148;
AudienceFilter at broadcastsRepo.ts:84-90 has no status; FlyerPage.tsx:211-219
links "See other homes" to /join).

Result: 17 accepted, 3 partial, 1 deferred, 0 rejected outright (two
sub-proposals rejected, below). Decisions changed: yes (J1, J2, J7, J9, J10,
J12, J15, J17, J18), so revision 2 goes to round 2 (Cameron 2026-10-12:
the normal review loop applies - continue until a round changes no
decision, cap 4).

| # | Finding (sources) | Ruling | Effect on rev 2 |
|---|---|---|---|
| J1 | Backfill has no time bound; stamps post-deploy "Not sure" leads; "idempotent" overclaims (A-F4, B-F1) | ACCEPT | New D5 marker `housing_fair_authority_asked: true` on every new no-unitId contact; the backfill skips any contact holding it. Either run order (before or after deploy) is now safe. |
| J2 | Absence also means a deliberate clear (contact PATCH, Settings clear, cleanup agency move) (A-F4, B-F8) | ACCEPT | Backfill leaves out a target whose audit trail shows housingAuthority was ever written; the dry run lists them separately. |
| J3 | "No trimming" contradicts the global trimJsonBody (A-F2, B-F2) | ACCEPT | D3: the body is trimmed by the existing middleware, then matched exactly; "padded text" removed from the 400 list. |
| J4 | Goal misdescribes blasts: no status filter exists, #6 unbuilt (A-F3, B-F4) | ACCEPT | Section 1 rewritten; section 4 notes the authority helps authority-filtered blasts now, the status matters once #6 ships, and backfilled Needs review leads then need moving. |
| J5 | /join is also the public self-serve fallback from the flyer; default + Onboarding apply to unattended public sign-ups; no provenance (A-F5, B-F3) | PARTIAL | Facts accepted and written into sections 2 and 4 (incl. extraction suggesting rather than writing over a held value). The decided default and status stand pending Cameron, who is asked at the spec gate. Provenance stamp on the value: REJECTED - no reader would consume it; the J1 marker already records that the form asked. |
| J6 | Today consequence is false: triage reads type unknown only (A-F6, B-F5) | ACCEPT | Removed; the real triage change (leaving the Needs review status filter) kept. |
| J7 | Stale list after a rename/merge/delete -> permanent generic 400 (A-F1.1, B-F6) | ACCEPT | D3: an unlisted name gets the distinct `400 { error: 'housing_authority_not_listed' }`; D8: the form re-reads the list, keeps the typed fields, re-applies the default rule, and asks to check the choice. Spelling resolution on the public route: REJECTED - Cameron's exact-name rule (2026-10-12). |
| J8 | POST-time list read failure unspecified (A-F1.2) | ACCEPT | D3: the POST reads the list only when an authority is sent; a read failure is the generic 500 like any storage failure. D8's promise narrowed to the page-load read. |
| J9 | Loading state has no timeout (A-F1.3) | ACCEPT | D8: a 10 s timeout puts the select in the failed state. |
| J10 | Failed list never recovers across Sign up another person (A-F13) | ACCEPT | D9: "Sign up another person" re-reads the list when the last read failed. |
| J11 | "Spot the flyer leads and --skip them" cannot be done from data (A-F7, B-F9) | PARTIAL | Fact accepted and stated in D10/D11. Names + sign-up dates in the dry run stay (Cameron's decision 2026-10-12, a recognition aid; a deliberate departure from the cleanup script's no-names rule, terminal only). `--skip` stays as the general way to leave a lead out. |
| J12 | Lock check ignores staleness; never takes the lock (A-F8, B-F10) | PARTIAL | ACCEPT staleness: refuse via `isOrgRewriteRunning`. REJECT taking the lock: the apply runs for seconds at today's volume; taking the `cleanup` lock would label it "the one-time cleanup" on Settings with the hint "Re-run the cleanup script" on a failure; the post-apply re-read catches any rename/delete/merge/re-kind, and the records then surface under "Not on the list". Window accepted explicitly in D10. |
| J13 | Staff-entered consent recorded as web_form (A-F9, B-F11) | DEFER, then CLOSED | Existing behavior, unchanged by this branch. Briefly filed as `docs/issues/join-staff-entered-consent-method.md`; Cameron ruled it a non-issue at the spec gate (2026-10-12) and the issue was deleted. D9 slogan replaced with the mechanism (the box starts unchecked for each person). |
| J14 | Mount unspecified; the obvious mount trips the edge guard (A-F10, B-F7) | ACCEPT | D2 names it: a router mounted at the already-classified `/public` prefix ahead of the existing mount, its limiter applied to its own route only. XFF spoofability: out of scope (the existing limiter's property). |
| J15 | Anonymous GET uses the creating read (A-F11, B-F16) | ACCEPT | D1/D3: `peek()`, falling back to the starting list in memory; the public surface never writes the list item. |
| J16 | Existing-phone path misstated (A-F12, B-F14) | ACCEPT | Section 2 corrected (a never-welcomed existing contact IS welcomed and flagged). |
| J17 | Reusing org_name_cleanup misnames a guessed default (A-F14, B-F13) | ACCEPT | Distinct audit event `housing_authority_backfill`. |
| J18 | Backfill write does not re-check type/deleted (B-F12) | ACCEPT | D10: the write is conditional on still no authority, still tenant, still not deleted. |
| J19 | 429 copy undefined in the rapid-entry flow (B-F17) | ACCEPT | D8: a 429 shows a wait-a-minute message. |
| J20 | Wrong stage client path (A-F14, B-F15) | ACCEPT | Fixed to `app/scripts/lib/stageClient.ts`. |
| J21 | Unenumerated surfaces: publicApi.ts body builder, stale needs_review statements (public.ts comments, e2e steps.ts, tenant-onboarding spec, STATUS-MODEL.md, publicIntake.test.ts), perf endpoint templates (A-F14) | ACCEPT | New section 7 lists them. |
