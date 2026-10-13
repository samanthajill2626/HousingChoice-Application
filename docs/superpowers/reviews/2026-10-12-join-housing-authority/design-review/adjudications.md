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

---

# Spec review round 2 - adjudications

Round 2 reviewed revision 2 (@842c6edf, consent issue dropped @138bc8ac).
Reviewer B continued (`R2-reviewer-b.md`, 7 findings). It conceded all three
contested rejections (J5 provenance stamp - the AutoBadge reads only
`source === 'ai'`; J7 spelling resolution - Cameron's rule; J12 taking the
lock - `acquireForCleanup` would also overwrite Settings' record of the last
real rename) and judged the rev-2 fixes for D1, D2, D3 and the J12 staleness
rule correct. It added that rev 2 no longer named the write method, and that
`contactsRepo.update` with `expect` clauses plus `notDeleted` carries all
three guards (verified: `UpdateContactOptions`, contactsRepo.ts:661-690).

Result: 7 accepted. Decisions changed: yes (K1, K2, K3) - round 3 follows.

| # | Finding | Ruling | Effect on rev 3 |
|---|---|---|---|
| K1 | R2-1 [MED] The not_listed recovery re-applies the default, silently swapping a renamed choice to Atlanta (or Atlanta to Not sure), and D9 carries the swap forward | ACCEPT | D8: the recovery picks no value - a "Choose one" placeholder blocks send until the person chooses. |
| K2 | R2-2 [MED] A pre-change lead who signs up again after the deploy has its answer dropped (D6) and the backfill stamps Atlanta over it | ACCEPT | D7: every post-change `housing_fair_signup` event carries `signupVersion: 2` and the name the request carried (existing contacts included). D10 leaves out any candidate with such an event. |
| K3 | R2-3 [LOW] Post-change flyer sign-ups for an unavailable unit get no marker, so every re-run stamps them | ACCEPT | D5: the marker (renamed `housing_fair_signup_v2`) goes on EVERY new contact this endpoint creates after the change, flyer included. |
| K4 | R2-4 [LOW] The "asked" marker is set whether or not the select was shown | ACCEPT | Marker renamed and redefined as "created after the question shipped"; section 4 states that such no-authority sign-ups are never backfilled. |
| K5 | R2-5 [LOW] The audit-history event list was delegated and incomplete; appends are best-effort | ACCEPT | D10 names the event types (contact_updated by fields, ai_extraction_applied, ai_suggestion_accepted, org_name_rewrite/org_name_cleanup, housing_authority_backfill), SET OR REMOVE, plan verifies; best-effort gap accepted in one sentence. |
| K6 | R2-6 [LOW] No status condition: On hold / Inactive leads get Atlanta and join Atlanta blasts | ACCEPT (document) | Section 4 states it. No status condition added: Cameron set the target rule (authority only, status left alone), and it matches every parked tenant holding an authority while blasts have no status filter. |
| K7 | R2-7 [LOW] sequence-diagram-to-test.md:110 still says needs_review | ACCEPT | Added to section 7. |
| K8 | (Part 3) The write method was unnamed; rewriteOrgFields cannot carry the type/deleted guards | ACCEPT | D10 names `contactsRepo.update` with the two `expect` clauses plus `notDeleted`. |

---

# Spec review round 3 - adjudications (TERMINAL)

Round 3 reviewed revision 3 (@0174f240). Reviewer B continued
(`R3-reviewer-b.md`, 3 findings, all LOW). It conceded K6 (blasts read no
status anywhere, so a status condition has no code to defend it) and judged
every round-2 fix correct, including that the broadened marker breaks no
reader, test or snapshot, and that `contactsRepo.update` with the guards has
no hidden side effect (no `updated_at`, no revision bump without a type/role
patch, `notDeleted` matches how restore removes `deleted_at`).

Result: 3 accepted as precision edits. Decisions changed: NONE - the review
is CLOSED at round 3 (revision 4).

| # | Finding | Ruling | Effect on rev 4 |
|---|---|---|---|
| L1 | R3-1 [LOW] `auditRepo.listByEntity` is one newest-first Query with no cursor; a long history drops the OLDEST events, where pre-change writes live | ACCEPT | D10: page backward with `before` until a page comes back empty (verified auditRepo.ts:122-141). |
| L2 | R3-2 [LOW] The re-sign-up exclusion also catches a pre-change lead's post-change FLYER sign-up | ACCEPT (no new field) | Errs safe and is rare; D10 says so and the printed reason is "signed up again after the change". The optional D7 `unitId`-sent field was not taken. |
| L3 | R3-3 [LOW] No app path creates a backfill candidate after the change, so a rehearsal through /join finds none | ACCEPT | D10: the rehearsal and the script test write pre-change-shaped leads directly. |

Spec review totals: 3 rounds, 41 findings (31 in round 1, merged to 21;
7; 3), 0 rejected outright, 2 proposed fixes rejected and conceded, 1
deferral closed by Cameron (consent method: non-issue).
