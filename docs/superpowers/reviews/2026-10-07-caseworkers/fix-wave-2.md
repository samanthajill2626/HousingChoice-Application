# Caseworkers fix wave 2 - planner review findings

Date: 2026-10-11. Implementer: the planner (Claude Code, cloud session).
Requested by Cameron after the planner spec-conformance review: fix P3-1 to
P3-8, close test gaps T-1 and T-2, fix docs D-1 and D-2; leave P3-9 (the
Possible-row accessible name, a plan decision) alone; then an independent
review, then the full re-verification.

| Item | Value |
| --- | --- |
| Start | `e6447786` (clean, = origin) |
| Commits | `70cbfe8e` code + tests; `10de23e7` docs; `2f875cea` review response (FW2-1..FW2-6) |
| Gated HEAD | `2f875cea` (this record is committed after it; records only) |
| Base / main | `d874915873a61864f6d051a0a9af3f0bb8e7e6e2`, unchanged, so no sync was needed |
| Findings answered | `planner-spec-conformance-review.md` P3-1..P3-8, T-1, T-2, D-1, D-2 |
| Review | `fix-wave-2-review.md` (one independent opus reviewer, read-only) |

## The fixes

Every code fix was written test-first: the new or extended test was run and
seen failing for the stated reason, then the fix made it pass.

| Finding | Fix (at `2f875cea`) | RED evidence | GREEN |
| --- | --- | --- | --- |
| P3-1 "Other" clipped in the desktop New contact dialog | Six-choice bar (Caseworker offered) is a 3x2 grid above the phone breakpoint: `KindPicker.module.css:57-67`, class applied at `KindPicker.tsx:178`; the phone 2-column grid still wins below 600px. The 5-choice bar is unchanged. | `contact-create.spec.ts` now measures segment clipping at 1280, 600 and 375px; at 1280 it failed with "Other" outside the group | spec passes; live probe at 1280/768/600: no segment clipped (3x2 at 446px) |
| P3-2 Caseworker -> Other kept the role | `KindPicker.tsx:151` clears the role when leaving the Caseworker preset | unit test: last onChange `{type:null, role:'Caseworker'}` | unit test passes; live: Role empty, Tenant base resolves to plain Tenant `{tenant, ''}` |
| P3-3 repair audit dropped the record | `caseworkerConversion.ts:528` passes the stored `caseworker_conversion` to `followOn` on the repair path; a hand-typed caseworker sends none | `caseworker_conversion` missing from the repair audit payload | passes; a second assertion pins "no record invented" |
| P3-4 type override audit omitted `type_source` | `contacts.ts:1647` pushes it onto `changedFields` | audit `fields` `['type','status']` (3 cases) | passes |
| P3-5 Move/Split could answer 409 | Field-pair checks hoisted beside the kind checks, before `start()` (lock) and the name-variant check: `orgRewrite.ts:464-475`; removed from the switch | new test got 409 `org_rewrite_running` | passes; organization-row Move/Split still 400 |
| P3-6 final errors offered "please try again" | `CaseworkerDialog.tsx:54` `finalCaseworkerError` (404 `contact_not_found` -> "This contact was deleted."; 400 `caseworker_team_member` -> "A team member can't be made a caseworker."), no Try again, Confirm off, optional `onStale` read through a ref (`:192-194`, `:238`); `CaseworkersList.tsx:55` `finalDismissError` (404, 400 `caseworker_dismiss_not_allowed` / `caseworker_team_member` -> "This contact is no longer a possible caseworker."), Hide off, both lists re-read (`:351` passes `onStale`) | 6 unit tests: alerts carried the retry copy | all pass; live: Make on a contact deleted after the list loaded shows the final line, Confirm disabled, and the re-read drops the stale rows |
| P3-7 long organization crushed the name | Organization rows opt into the list's documented `.factsRow` sacrifice order (`CaseworkersList.tsx:259`); `.org` is the one shrinking, ellipsized chip with a `title` (`CaseworkersList.module.css:13-21`); stacked (<=560px container) it wraps in full (`:25-31`, FW2-3) | new e2e row test: row scrolled sideways at 1024px (5px); at 375px the organization was cut by 313px | passes at 1024, 900 and 375; live widths 1280..800: name 133-227px, no row overflow |
| P3-8 PATCH accepted a pointer-row id | `contacts.ts:1531` 404s `phone_ref`/`email_ref` after body parsing, before every other 404/409/422; `possibleCaseworkers.ts:36` skips pointer rows | PATCH answered 200 (phone and email pointer); a typed pointer was listed | passes |
| T-1 landlord paging untested | FakeWorld `listByLandlord` (`twilioWebhookHarness.ts:2879`) pages like `listByStatus` and the real `queryIndex` (cursor, no hidden 50 cap); new page-two test `caseworkerConversion.test.ts:196` | - | passes; MUTATION (loop cut after page one) fails it |
| T-2 tenant fence untested on the HA path | `audienceResolution.test.ts:153`: a partner and a landlord holding the filtered authority stay out | - | passes; MUTATION (fence at `audienceResolution.ts:149` deleted) fails it |
| D-1 RUNBOOK status | "Putting a mistaken conversion back" step 4 (RUNBOOK.md, Caseworkers section): find the earlier status on the timeline, then check Status after step 3 because the form sends a status only when it differs from the new kind's default (rewritten after FW2-1); step 1 notes a repair's audit carries the record | - | - |
| D-2 stale refs | `docs/issues/imported-unknown-threads-surface-as-unknown-on-today.md` cites `contacts.ts:1543`/`:1916` | - | - |

Both mutation checks were run on the real source and the source restored
byte-for-byte (no diff afterwards). The reviewer independently reverted each
code fix (P3-2, -3, -4, -5, -6, -8) and the T-2 fence in a copy and saw every
new test fail.

## Independent review and adjudication

One opus reviewer, read-only, on `e6447786..10de23e7`
(`fix-wave-2-review.md`). Its verdict: every code fix correct against its
finding; nothing blocking. Each finding re-checked by the planner before
acting:

| Id | Reviewer severity | Planner check | Outcome |
| --- | --- | --- | --- |
| FW2-1 | P2 (docs) | Confirmed by reading `ContactEditForm.tsx:60-68`, `:312-319`, `:480-483` and the auto-advance at `contacts.ts:1578-1582`: a tenant who was Needs review comes back Onboarding, a landlord who was Active comes back Interested | Fixed: step 4 rewritten (check Status after step 3, set it in a second edit; milestones best-effort, a re-import changes status without one) |
| FW2-2 | P3 | Confirmed: `readSubject` answers 400 `caseworker_team_member` before dismiss's own check | Fixed + third list test case (RED first) |
| FW2-3 | P3 | Confirmed live: organization truncated by 313px at 375px | Fixed (container-query wrap) + 375px e2e assertion (RED first) |
| FW2-4 | note | Confirmed by test: two alerts after a contact_changed re-read that came back final | Fixed (`setError(null)` on a final read) + test (RED first) |
| FW2-5 | note | Confirmed by reading `contacts.ts:1204` and the other phone-only guards | Comments corrected; pre-existing gap filed as `docs/issues/contact-routes-email-pointer-guard.md` (voice-opt-out writes) |
| FW2-6 | note | Agreed: a soft-deleted contact can be restored | Copy now "This contact was deleted." |
| FW2-7 | note | Agreed: same 55cqw tradeoff already documented for tenant rows | No change |
| FW2-8 | note | Confirmed: `ContactDetail.tsx` passes no `onStale`; `useContact` has no refetch, so wiring one widens the wave | No change; the final copy is correct there, the page shows the deleted contact until reloaded |

## Verification (executed in this session)

Environment as recorded in `planner-final-review.md` and `e2e/README.md`
"Claude Code cloud container (Linux)": Node 24 at `/opt/node24`, a manually
started dockerd with DynamoDB Local and MinIO, `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY` unset for `npm test` (the container exports a
proxy-injected key), Playwright on the Chromium 141 shim because the pinned
149 download is blocked (cdn.playwright.dev 403).

Inner loop: every changed unit test file and the two changed e2e spec files
(12/12 on a session lane restarted at `10de23e7`, and the row test again at
the review fixes) passed before the gates.

| Gate | Command | Result on `2f875cea` |
| --- | --- | --- |
| 1 | `npm run typecheck` | exit 0 |
| 2 | `env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY npm test` | exit 0; 740 files (app 437 / 9136 tests + 2 skipped, dashboard 234 / 4379 + 1 skipped, 22, 34, 13); no `[dynamoAdmin]` line |
| 3 | `npm run smoke` | exit 0; 1649 specifiers across 286 files |
| 4 | `CI=1 npm run e2e` (Chromium 141 shim, 2700s outer timeout) | PENDING - filled in below when the run completes |
| 5 | `npx eslint $(git diff --name-only --diff-filter=d origin/main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')` | 152 files; exactly the 5 known base errors (`BroadcastComposer.tsx:204,229,248,263`, `ContactsList.tsx:184`, both untouched by this wave); no new error - ratchet PASS |

Gate 5 note: this clone has no local `main`, so the literal `main...HEAD`
fails, the list comes back empty, and eslint goes repo-wide (23 errors). The
first attempt hit exactly that trap; it was discarded and the gate re-run
against `origin/main` (= the base commit).

## Standing qualifications (unchanged by this wave)

The qualifications in `planner-final-review.md` and
`planner-spec-conformance-review.md` stand: Task 10.4 baseline-red and C6
unapplied; R2-ADV-1 reproduced and parent-deferred; the unexplained first
FINAL2 blank-document failure; e2e on Chromium 141, not the pinned 149. P3-9
is open by decision. No merge, deploy, infrastructure change or cleanup was
done.
