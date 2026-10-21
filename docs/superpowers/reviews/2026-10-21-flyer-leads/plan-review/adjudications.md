# Plan review adjudications - flyer-leads

Plan: `docs/superpowers/plans/2026-10-21-flyer-leads-plan.md`. Spec rev 6.
Reviewers: two opus reviewers in round 1 (A, B), blind to the planner's
reasoning; later rounds continue reviewer B with the RE-REVIEW CHARGE.

## Round 1 (plan v1 @d5684bbe)

Reports: `R1-reviewer-a.md` (9 findings, all LOW), `R1-reviewer-b.md` (2
MEDIUM, 7 LOW). No BLOCKING or HIGH. Both reviewers walked every spec
decision, section 4 surface and section 5 test to a task, and found no
unnamed writer or reader of the touched state.

Merged: 18 findings -> 15 distinct. 14 ACCEPTED, 1 REJECTED (B5), 1
ACCEPTED only as a watch item (A3).

| # | Finding (reviewer) | Ruling | Where it lands |
|---|---|---|---|
| 1 | An unnamed contact's flyer row on the property "Sent to" card is labelled by its raw contactId (B1, MEDIUM). Verified: `ListingDetail.tsx:1343` `row.tenantName ?? row.contactId`; `routes/units.ts:183-197` `displayNameOfContact` is undefined without a first/last name. D7 newly puts EXISTING `unknown` contacts (auto-captured, often nameless, never renamed by a sign-up - D4) on that card. | ACCEPT (AR13) - decision change (adds a surface). The recipients projection labels a resolved contact that has no name by its formatted phone, the `groupTitle.ts:56` precedent (`formatPhoneForDisplay(phone) ?? phone`). | S3 new task |
| 2 | Slice reports have no tracked, committed home (A6, B2). | ACCEPT (ground rule) | plan section 0 |
| 3 | Build-order text left over from before AR4 in S1's and S6's openings, and S2 exit check 6's expected commit stack (A9, B3). | ACCEPT | S1, S2, S6 drafts |
| 4 | AR5 is PENDING in a binding section with no task for either answer (A5, B9). | ACCEPT - both outcomes are drafted as CONDITIONAL steps; Cameron's answer at the launch gate drops one. | S1 Task 1.3 (fix), S6 Task 6.4 (issue file) |
| 5 | `hasEventSince` is an eventually consistent Query, so two quick sign-ups can both pin and bump (A1). | ACCEPT (AR12) - decision change (mechanism). `ConsistentRead: true` (base table, allowed); a test asserts the command carries it. | plan 2.5, S4 |
| 6 | No test covers an existing contact whose 1:1 thread is CLOSED; the harness fake only reuses open threads while the real repo adopts a closed one (A2). | ACCEPT - a spy test pins touch-before-increment call order and the touched image's `status: 'open'`; the fake divergence is noted in the test. | S4 |
| 7 | S4's test code was neither run nor typechecked (A3). | ACCEPT AS WATCH ITEM ONLY - no re-draft. Every task runs its test RED before GREEN, so a compile error surfaces at Step 2 and is fixed there; S3 (which S4 builds on) WAS typechecked. Named in the mission block's watch items. | mission block |
| 8 | `docs/issues/deleted-contact-web-signup-silent.md` describes a welcome-refused WARN the new deleted path never writes (A4). | ACCEPT | S6 Task 6.4 |
| 9 | The full app suite first runs at Task 6.5 although S3 and S4 edit shared test helpers (A7). | ACCEPT - the S3 and S4 exit checks run the full app suite. | S3, S4 exit checks |
| 10 | AR2's `refused` is a deviation the spec does not record (A8). | ACCEPT - the spec gains a "Plan-time amendments" note (AR1, AR2, AR11, AR13), each a precision amendment within an approved decision. | spec |
| 11 | The deleted path writes `sentRecorded: false` with no `sentSkipped`, breaking the spec's own rule that `sentSkipped` is absent only when an entry was written (B4). | ACCEPT (AR11) - decision change (audit value). The deleted path records `sentSkipped: 'deleted'`. | S4 |
| 12 | `consentVersion` records the server constant, not "the version the form showed" (B5). | REJECT. The form sends no version (`parseHousingFairBody`, `public.ts:116-195`, reads none) and every created contact's `consent_version` is already this same server constant (`public.ts` create body). The dashboard bundle and the server ship in one release, so they agree; a tab left open across a disclosure-copy change is the residual the contact record already carries. Adding a client-sent version is new public surface (an untrusted field) for no gain. | - |
| 13 | Code blocks nested under list bullets carry the bullet's indent, so a literal copy fails as an Edit anchor (B6). | ACCEPT (ground rule) | plan section 0 |
| 14 | Task 1.1 Step 3e says 16 lines for a 17-line range (B7). | ACCEPT | S1 |
| 15 | `git commit -F <file>` with no location for the file (S3, S5) - inside the worktree it pollutes `git status` (B8). | ACCEPT (ground rule) - message files live outside the worktree, or use repeated `-m`. | plan section 0, S3, S5 |

Correction while applying round 1 (AR16): finding #4's premise - the
drafters' AR5 report that plain-string unit fields save untrimmed - is
FALSE. `app.ts:146` mounts `trimJsonBody()` (`middleware/trimStrings.ts:43-50`),
which deep-trims every string in every JSON body before any route, so the
conditional work for AR5 is removed and nothing is put to Cameron. Caught by
S1's drafter while writing the conditional task; verified by the planner.

Decision changes this round: #1 (a new surface), #5 (mechanism), #11 (audit
value). So round 2 runs. Reviewer B continues (it found the round's only
mediums); it receives reviewer A's report.

## Round 2 (plan v2 @444e0f86) - TERMINAL

Report: `R2-reviewer-b.md` (reviewer B continued with the RE-REVIEW CHARGE;
it also held reviewer A's round-1 report). 6 findings, all LOW. No BLOCKING,
HIGH or MEDIUM. The reviewer checked every round-1 fix against the code
(AR11, AR12, AR13 / Task 3.5, AR16, the closed-thread test, the commit
quoting) and found them correct. It conceded its R1 #9 (AR5) and did not
contest A3 staying a watch item.

| # | Finding | Ruling | Where it lands |
|---|---|---|---|
| 1 | The S3 and S4 full-app-suite exit steps run a 3-8 minute suite in the foreground; S4 sets no timeout (the tool's 120 s default kills it), S3 caps at 600 s and skips the AWS-key check. | ACCEPT - run in the background with a log file, a hard outer `timeout`, and the AWS-key check, like Task 6.5. | S3, S4 exit checks |
| 2 | S5 leaves the full dashboard suite optional although it edits shared modules (the `types.ts` unions, the `Card.tsx` gate, `groupSendRows`). | ACCEPT - mandatory, by AR15's own reasoning. | S5 exit check |
| 3 | Task 6.4 Step 1f calls the audit row the "ONLY trace" of a deleted-contact sign-up; the INFO `housing-fair signup captured` line with `deletedContact: true` is a second. | ACCEPT - wording. | S6 |
| 4 | Spec section 7 records AR13 for "an existing unknown contact with no name", but Task 3.5 labels EVERY resolved nameless contact (any type) and re-pins two nameless-tenant rows. | ACCEPT - the plan (AR13) is right; the spec note is widened to match. | spec section 7 |
| 5 | CONTESTED R1 #12: the rejection stands for a client-sent version, but the WORDING "the disclosure version the form showed" is still inaccurate - it is the server's `CONSENT_VERSION` (`smsCompliance.ts:91`). | ACCEPT the wording fix only (the round-1 REJECT of a client-sent version stands): the audit field is "the consent disclosure version in force, `CONSENT_VERSION`, which ships with the form". | spec section 7, S4 Task 4.5 comment |
| 6 | Slice-report rules conflict: S2 and S5 must list pre-existing lint errors; S6 Step 11 says those belong only in `S6-gates.md`; section 0 says "findings only". | ACCEPT - section 0 rules it: a slice report MAY name pre-existing lint errors in files the slice touched (a finding for the next reader); `S6-gates.md` remains the authority for gate 5's baseline attribution. | plan section 0, S6 |

Decision changes this round: NONE - every accepted finding is a precision
edit (execution steps, wording, a verification step made mandatory). Per the
stop rule this is the TERMINAL round; the edits are folded in and the plan
review is CLOSED after 2 rounds: 21 distinct findings, 20 accepted (one only
as a watch item), 1 rejected (R1 #12's client-sent version; its wording half
accepted in round 2).
