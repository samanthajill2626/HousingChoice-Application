# unknown-inactive - design review adjudications

Planner adjudications. A finding is a claim: ACCEPT (spec edited) / REJECT
(reason given) / DEFER (filed). Load-bearing claims about existing behavior
were checked in the code before acceptance.

## Spec round 1 (rev 1 @752b9234) - two opus reviewers, independent

Reports: `spec-r1-a.md` (A, 15 findings), `spec-r1-b.md` (B, 15 findings).
Merged: 21 distinct findings. 19 ACCEPT, 1 ACCEPT-as-wording (the rest of
its proposal rejected), 1 DEFER-as-watch-item.

| # | Finding (reviewer refs) | Ruling | Decision changed? |
|---|---|---|---|
| M1 | D5 check sits after the 100-row unread cap; Inactive threads that stay unread starve Needs you now and Unreplied (A1, B1). Verified today.ts:704-752: the deleted-contact check was moved ahead of the cap for exactly this (A9). | ACCEPT - D5 check runs in the collect loop, beside the deleted check, reusing the memoized contact read. | YES (mechanism) |
| M2 | D3 would route landlord edits through the transition route, whose plan writes park_reason = reason ?? null on every move to parked (verified services/statusTransition.ts:164); the form PATCHes the reason first, so it is wiped (B2). | ACCEPT - D3's save-path change applies to partner, team_member and unknown only; tenant and landlord save paths unchanged. | YES |
| M3 | "Treated exactly as an Inactive tenant" is false: the Tenants view hides Inactive by default; tenant unread shows in Unreplied (A15, B3). | ACCEPT - D4 now lists exactly what is shared and names the two differences and why (filed issue; Cameron's Today direction). | no (precision) |
| M4 | team_member threads are unknown_1to1 (verified contacts.ts:537-543) and role falls through to 'unknown' (verified inbox.ts:602-609): a "Needs review only" rule would drop Active team members from Today and change their chip (A10, B4). | ACCEPT - both rules become "skip when the contact is Inactive"; everything else, team members included, keeps today's behavior. | YES |
| M5 | Parked is called the landlord's inactive status but every rule keys on the literal `inactive` (A7, B5). | ACCEPT - D1 says Parked is the landlord's own status and behaves exactly as today; the Inactive rules key on `inactive` only. | no (precision) |
| M6 | Goal 4 claims same-name-same-meaning for every status; only delivered for Inactive (B6). | ACCEPT - Goal 4 narrowed to Inactive, which is what Cameron's words address. | no |
| M7 | D9's Unknown-tab sort overturns the recorded 2026-08-26 "LEAVE IT" ruling (inbox.ts:2282-2309) without naming it (B7). Verified. | ACCEPT - D9 names the ruling, supersedes it with Cameron's 2026-10-23 words, and lists the comments to update. | no (record) |
| M8 | The zero count is a snapshot; staff can still make (unknown, active) from the edit form until deploy, and such a row would vanish from the Unknown tab (B8). | ACCEPT - rollout re-counts just before deploy; any found are moved to Needs review only on Cameron's go. | YES (rollout step) |
| M9 | An inbound still triggers AI extraction for unknown contacts at any status (jobs/extraction.ts:457), and its suggestions land in Today's AI suggestions group, so "does not put it back on Today" fails (A6, B9). | ACCEPT the wording; REJECT suppressing extraction. A type suggestion from a returning contact ("I'm a tenant") is useful, it is not Needs review, and #31 owns where AI suggestions sit. The promise becomes "does not put it back in Needs review / Needs you now". | no |
| M10 | "Today's Needs review list" does not exist; both sources render under Needs you now as "New unknown contact" (A5, B10). | ACCEPT - spec names the real surface. | no |
| M11 | On a retype-plus-status save, which type's label map labels the timeline entry is undefined; the PATCH uses the stored type, the conversion the new one (A8, B11). | ACCEPT - the NEW type's label map wins, everywhere. | no (precision) |
| M12 | D3 misdescribes the form defect: an untouched off-list status is never sent, so it does not flip on save; the form DISPLAYS Needs review. The planned test passes on old code (A12, B12). | ACCEPT - defect restated as a display bug; test 7 asserts the displayed value and that changing another field and saving keeps Inactive. | no |
| M13 | D7's team_member/unknown arms are API-only (KindPicker offers neither); a tenant-target retype save is PATCH then setTenantStatus, not "the plain PATCH" (A3, A11, B13). | ACCEPT - descriptions corrected; the arm stays (API callers exist) and gains a newType !== stored.type guard so a same-type PATCH never resets status. | no (precision) |
| M14 | The transition route emits no SSE event (verified services/statusTransition.ts:605-637 appends audit only); the PATCH emits conversation.updated for linked threads (contacts.ts:2081-2094). Moving status changes to the route leaves open Today/Inbox stale (A4, B14). | ACCEPT - a status change through the transition route notifies open Today and Inbox pages the same way a PATCH does; the plan picks the event. | YES (new surface) |
| M15 | The form's Status selection on a type change is unspecified: retyping from Inactive leaves Inactive selected while the server writes Onboarding/Active, or shows Needs review while the server writes Interested (A2). | ACCEPT - on a type change the Status field moves to the new type's first step, and whatever is shown is what is saved; staff may change it before saving. | YES |
| M16 | D6 claims a 400 on writers that do not return one: a status-suggestion accept on a non-tenant is a 409 before the allowlist; the import falls back with a warning (A9). | ACCEPT - D6 says "refused" per path with each path's real response. | no |
| M17 | Missing surfaces: unmatchedEmail.ts:455-466 duplicate create default; dashboard buildToday.ts:287 fallback; contactsPartitionFake.ts:53-60; which list the statusAllowlistFor fallthrough returns (A13, B14). | ACCEPT - added to section 4; fallthrough returns the partner/team_member list for any other type (unknown handled explicitly). | no |
| M18 | D2 widens a check-then-write race in the transition route (statusTransition.ts:268-278, then an unconditional write): a concurrent retype can store an illegal pair such as (landlord, inactive) (B15). | ACCEPT - the transition write is conditioned on the stored type being unchanged; a mismatch is a 409 and writes nothing. | YES (small) |
| M19 | Inactive unknowns pile up in the unknown partition and needs_review -> inactive becomes the common mid-walk flip, edging toward the reopen trigger of unknown-queue-status-flip-duplicates-across-pages (A14). | DEFER as a watch item: the dashboard drops already-loaded rows by rowKey on Load more (inboxListMerge.ts:145-159), so a flip duplicates nothing on screen; a flip can still skip a row across pages. Plan re-reads the issue's reopen trigger; spec notes it. | no |
| M20 | No SSE on a header change keeps a stale tag/chip in another open tab (B14 second half). | Folded into M14. | - |
| M21 | Retype same-type guard (A11 second half). | Folded into M13. | - |

Round 1 changed decisions (M1, M2, M4, M8, M14, M15, M18), so round 2 runs.
Continued reviewer: B (more accepted unique findings: M2, M4, M7, M8, M18),
handed A's report.

Planner's own calls to put to Cameron at the spec gate (not reviewer
findings): D7 team_member -> Active / unknown -> Needs review from Inactive;
D8 card title "Type unknown"; D9 Inactive tag on every type's inbox row.

## Spec round 2 (rev 2 @2c8a125c) - continued reviewer B

Report: `spec-r2-b.md` (11 findings; B also read A's round-1 report).

| # | Finding | Ruling | Decision changed? |
|---|---|---|---|
| R2-1 | D3's type-change default has no reference point: a role-only preset switch or a change-and-back would write a status where today nothing is written. | ACCEPT - a type change is measured against the STORED type at save time; role-only and change-and-back write no status. | no (precision) |
| R2-2 | For a tenant target the PATCH never carries a status (`!isTenant`, ContactEditForm.tsx:345); the server auto-advances, then setTenantStatus writes again (two milestones). | ACCEPT - setTenantStatus follows only when the shown status is not Onboarding. | no (precision) |
| R2-3 | "Notify the same way a PATCH does" is wrong: the PATCH emits only for linked threads that flipped or carry a name (contacts.ts:2077-2094); unnamed and threadless unknowns get nothing. | ACCEPT - the notify fires for every status change; the plan picks the event. Observable rule unchanged. | no (mechanism note) |
| R2-4 | The collect loop also feeds Unreplied, so an unscoped skip hides Inactive tenants/caseworkers from Unreplied, breaking D4's stated difference. | ACCEPT - skip limited to unknown_1to1; test 4 extended. | no (precision) |
| R2-5 | "A same-type PATCH never resets a status" is false: the auto-advance branch has no guard (contacts.ts:1723-1729). | ACCEPT - both branches gated on newType !== stored.type; test 3 names the cases. Note: this also fixes a latent reset of a Searching tenant by a stale `{type:'tenant'}`. | no (makes the stated rule true) |
| R2-6 | The dashboard Today fallback cannot apply D5: ConversationSummary has no contact status (types.ts:561-580). | ACCEPT - fallback unchanged; watch item. | no |
| R2-7 | Wrong citation for team_member threads being unknown_1to1. | ACCEPT - cites twilio.ts:221-232 and lib/voiceMasking.ts:28-39. | no |
| R2-8 | history.ts ladder is shared; a linear inactive gives an unknown a seeded Active step. | ACCEPT - Inactive is a branch from Needs review. | no |
| R2-9 | Goal 3 holds for four of five types: landlord form and header write differently. | ACCEPT - landlord named as the one exception, with the park_reason reason; the CHOICES are identical. | no |
| R2-10 | Concedes M9; asks that "do not suppress AI for Inactive" go to Cameron as the planner's call. | ACCEPT - added to the gate calls. | no |
| R2-11 | Concedes M19; notes the issue's reopen trigger is now a matter of time. | NOTED - watch item stands. | no |

Round 2 changed no decision: TERMINAL. Precision edits folded into rev 3.

Gate calls for Cameron (planner's, not his): D7 team_member -> Active /
unknown -> Needs review from Inactive; D8 card title "Type unknown"; D9
Inactive tag on every type's inbox row; M9 AI extraction/suggestions keep
running for Inactive contacts; R2-5 same-type PATCH no longer resets a status.

## Plan round 1 (plan v1 @3d6e9ec9) - two opus reviewers, independent

Reports: `plan-r1-a.md` (A, 10 findings), `plan-r1-b.md` (B, 8 findings).
Merged: 15 distinct findings. 14 ACCEPT, 1 ACCEPT-and-put-to-Cameron.
Load-bearing claims checked in the code: ContactEditForm.tsx:204
(`liveType = kind.type ?? contact.type`) with KindPicker.tsx:150-160 (Other
sets type null); dashboard/src/api/endpoints.ts:1474-1484 (`getContact`
takes `{ consistent: true }`, planner ruling PR-3); routes/statusTransition.ts:268
(the route's type read is not consistent).

| # | Finding (reviewer refs) | Ruling | Decision changed? |
|---|---|---|---|
| P1 | Edit form: a change-and-back through KindPicker "Other" (type null, liveType falls back to the stored type) leaves a status derived for another type, so the save demotes a Searching tenant or un-parks a Parked landlord (A1, B1). | ACCEPT - the form tracks the type its Status was last derived for (`statusType`); a non-null kind change re-derives only when it differs from `statusType`; back to the stored type restores the stored status. New tests: tenant -> landlord -> Other -> tenant writes no status; Parked landlord the same. | YES (mechanism + tests) |
| P2 | The `contact.updated` re-read (S2.9) and the 409 re-read (S4.3) are eventually consistent and can overwrite fresh state right after the operator's own write (A2). | ACCEPT - both call `getContact(id, signal, { consistent: true })`; tests assert the option. | YES (mechanism) |
| P3 | AR17 not carried into the slice text: S1.1 commits a red tree (no inbox.integration flip), S3.4 Step 1 says STOP, S3 contradiction 2 says the opposite (A3, B2). | ACCEPT - restructured: S1.1 applies S3.4 Steps 2-5 verbatim IN PLACE OF its own step 1f, and its files/commands/commit include all four test files; S1.1 step 3f keeps only the import, type and order-object edits (the two docblock lines it also rewrote belong to S3.4 Step 6); S3.4 drops Steps 1-5 and is a comment-only task (exempt from the RED rule, verified by the GREEN run). AR17 rewritten. | YES (ordering) |
| P4 | S3.4 Step 6 Edits C/D and Step 3 Edit F anchor on text S1.1 already rewrote; the pre-deploy cursor pins lose their anchor (A4). | Folded into P3 (Edit F now runs inside S1.1 on the original text). | - |
| P5 | S2.4 writes the `\u2192` escape in test code; Edit decodes it (A5, B3 - B reproduced the decode). | ACCEPT - S2.4 uses `String.fromCharCode(0x2192)` as S1 does. | no |
| P6 | Three "prints nothing" greps in S4.3/S4.4 also match `setTenantStatus` and can never pass (A6). | ACCEPT - patterns fixed. | no |
| P7 | S1.3 labels a case PIN that is red before S1.3 (A7). | ACCEPT - relabelled RED. | no |
| P8 | S5.1 says four cases fail, lists three (A8). | ACCEPT - "three". | no |
| P9 | AR21 narrows D4.4: on the Contacts list an Inactive tenant gets a muted badge, an Inactive caseworker or unknown plain text (A9). | ACCEPT the record; AR21 stands as the plan's default (no new badges on those lists; they show plain text today) and goes to Cameron at the launch gate as a planner call. | no (pending Cameron) |
| P10 | W4 omits services/inboundEmail.ts and routes/unmatchedEmail.ts (A10; A verified neither writes status). | ACCEPT - listed in W4 as checked. | no |
| P11 | S1.3 lists "tenant re-typed to landlord" label as RED, but the fake repo returns the live object so it already passes (B4). | ACCEPT - relabelled PIN with the reason; the label-by-new-type RED is carried by P7's case. | no |
| P12 | The tenant-target follow-up `setTenantStatus` reads the type eventually consistently; a stale read 400s or 409s after the PATCH committed (B5). | ACCEPT - the transition route reads the contact with `{ consistentRead: true }`; test asserts it. | YES (small) |
| P13 | Comments still describing (unknown, active) as live have no owner: inboxFilters.ts:78-80, measure-unread-contact-coverage.ts ~661-664 (B6). | ACCEPT - inboxFilters.ts to S3.4 Step 7, the measure script to S1.2. | no |
| P14 | The spec file still says DRAFT though the plan says APPROVED (B7). | ACCEPT - planner stamps the spec status line (records fix). | no |
| P15 | AR19's S1 report entry has no step and is missing from the S1.6 checklist (B8). | ACCEPT - step added to S1.2, item added to S1.6. | no |

Round 1 changed decisions (P1, P2, P3, P12), so round 2 runs. Continued
reviewer: A (more accepted unique findings), handed B's report.
Note: commit bce89000's message names AR15-AR24, but those rulings landed
in 3d6e9ec9 (an Edit had failed); the plan text is what counts.

## Plan round 2 (plan v2 @43e971f5) - continued reviewer A

Report: `plan-r2-a.md` (5 items; A also read B's round-1 report). Checked in
the code: ContactEditForm.tsx:334-339 diffs the draft against the LIVE
`contact` prop; ContactDetail.tsx:1341-1349 passes the live contact;
useContact.ts:60-68 already re-reads on `suggestion.updated`, so the hazard
exists today and S2.9 widens it to every status change;
services/statusTransition.ts:611 reads the contact eventually consistently.

| # | Finding | Ruling | Decision changed? |
|---|---|---|---|
| R2P-1 | An open edit form diffs against the live prop; a `contact.updated` re-read swaps it, so saving an unrelated field writes back another operator's concurrent status/type/field change. | ACCEPT - ContactEditForm diffs against a BASE snapshot taken when the form opens (`const [base] = useState(contact)`); every comparison in buildPatch/onSubmit, `typeChanged`, `initialStatus` and the statusType seed reads `base`, never the live prop. Test: rerender with a changed contact prop mid-edit, save an unrelated field -> the PATCH carries only that field and no setTenantStatus runs. | YES (mechanism) |
| R2P-2 | P12 half-applied: setTenantStatus re-reads eventually consistently and takes audit `from`, the milestone decision and the label map from it. | ACCEPT - `contactsRepo.getById(contactId, { consistentRead: true })` in setTenantStatus; test asserts the option. | YES (small) |
| R2P-3 | Status options still built from `liveType`; during the Other step the select shows another type's list. | ACCEPT - options from `statusOptionsFor(statusType)`. | no |
| R2P-4 | Today/Inbox drop-without-reload rests on one debounced refetch over eventually consistent reads; DynamoDB Local hides it. | ACCEPT as watch item W8 (same pattern as conversation.updated); S2 report records it. No mechanism change. | no |
| R2P-5 | Concedes P9; no adjudication contested; the round-1 fixes check out. | NOTED. | - |

Round 2 changed decisions (R2P-1, R2P-2), so round 3 runs with A.
