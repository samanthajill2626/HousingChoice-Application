# Planner verdict - feat/unknown-inactive (tracker #30)

Date: 2026-10-23. Verdict: **MERGE-READY, UNMERGED (human gate).**
Gated code commit 798de475; branch HEAD after this record is docs-only on
top of it (records, GLOSSARY.md wording, one issue note). main = 916258ae,
0 commits ahead of the branch's base (fast-forward).

## Planner's own gates (bare, from the worktree, HEAD 12db6876 = 798de475 code)

Run 2026-10-23 20:37-21:01 EDT, node v24.21.0, no exported AWS_* names.

| Gate | Exit | Evidence |
|---|---|---|
| npm run typecheck | 0 | |
| npm test (AWS keys unset) | 0 | Test Files 527 / 266 / 22 / 34 / 13 passed; no `[dynamoAdmin]` warn line (the two log matches are the dynamoAdminRetry suite's own test names) |
| npm run smoke | 0 | smoke-dist: OK - 1733 import specifier(s) across 301 emitted file(s) |
| timeout 2700 npm run e2e | 0 | 372 passed (19.7m) |
| npx eslint (branch files) | 1 | 1 error, ContactsList.tsx:219 react-hooks/set-state-in-effect - PRE-EXISTING: the merge-base file linted via --stdin reports the same error at :208 |

Matches the builder's battery 4 exactly. The planner's later commits touch
only Markdown (no gate input).

## Independent reviews

See `code-review/planner-adjudications.md`. Spec-conformance: 79 / 82
CONFORMS, 2 DEVIATES (accepted builder deviations), 1 PARTIAL (importer),
0 MISSING. Plan-blind adversarial: 0 blocking, 0 high, 1 medium (rejected:
Cameron's 2026-10-23 decision on automatic texts), 7 low. No code fix wave.

## Planner live QA (hermetic lane 4, ad5c2407)

1. Unknown contact header dropdown lists exactly Needs review, Inactive.
2. Picking Inactive: header reads "Contact status: Inactive", card title
   "Type unknown", stored (unknown, inactive), timeline "Status -> Inactive".
3. A new inbound from the Inactive contact: an already-open Today page (no
   reload) shows only the Needs review contact's "New unknown contact" row;
   the status stays inactive.
4. Inbox Unknown tab: the older Needs review row sits above the newer
   Inactive row; Inactive row carries the "Inactive" tag and no "Needs
   triage" chip. (Its text showed read because the contact's page was open
   in another tab - the existing mark-read-on-open behavior.)
5. Caseworker header dropdown: Needs review, Active, Inactive.
6. Edit contact details Status on the Inactive unknown: Needs review,
   Inactive, showing Inactive.
7. Console: only the two pre-login /auth/me 401s.
Lane stopped; no lane-4 port listening.

## Conversation checklist (Cameron's requests, 2026-10-23)

| Request | Result |
|---|---|
| Move an unknown contact off Needs review without choosing a type, keep it as a contact | Delivered (QA 2) |
| Inactive for every type; landlord keeps Parked | Delivered |
| Delete Active for unknown contacts | Delivered (QA 1); stored rows: 0 dev / 0 prod, re-count owed before deploy |
| Header dropdown for caseworker and team member, one consistent way | Delivered (QA 5) |
| Inactive treated the same whatever the type | Delivered (not chased, muted color, tag, timeline); automatic texts left as they are per his 15:54 decision |
| Edit form shows the same choices as the header | Delivered (QA 6) |
| Unknown tab: Needs review first, then newest message, browser-side | Delivered (QA 4) |
| Needs you now: only Needs review unknown contacts | Delivered (QA 3) |
| Re-type from Inactive goes to the new type's first step | Delivered (builder QA: Mark as Tenant -> Onboarding) |
| Oct 18: a new text or call never moves Inactive back | Delivered (QA 3; W4 tests) |
| Small Inactive tag on Unknown tab rows | Delivered (QA 4), on every tab per approved call 3 |
| Status filters for other lists: file an issue, do not build | Delivered (issue at 0957ed39) |
| Read-only Active count; update tracker | Done 2026-10-23 |
| Five spec calls approved 16:20 | All delivered |
| Contacts list badges (AR21) | Default kept: plain text |

## For Cameron

1. Contacts > Unknown now lists Needs review contacts above Inactive ones
   (builder OR-1, beyond the spec). Planner recommends keep.
2. Rejected, can be reversed: the missed-call auto-text still goes to an
   Inactive contact (his automatic-texts decision). A set-aside wrong number
   or spam caller who calls again gets the intake text.

## Owed after merge (not the builder's)

- Just before deploy: re-count (unknown, active) on dev and prod (profile
  housingchoice); any found move only on Cameron's go. Re-measure the
  unknown partition (W2) alongside.
- After deploy an open Unknown tab's "Load more" may fail once; reload fixes.
- Recorded, not fixed (low): one refetch over eventually consistent reads
  (W8), audit-failure path sends no live update, PATCH re-type not fenced on
  the form's base type (pre-existing), /tenant-status on a phone-pointer id
  returns 500 (API-only).

## After the verdict (2026-10-23)

- Cameron on OR-1 (Contacts > Unknown lists Needs review above Inactive):
  "Keep it". The build stands as is.
- Pre-deploy re-count (W7, read-only, profile housingchoice, account
  938565869261), byTypeStatus GSI, type unknown:

  | Env | active | needs_review | inactive |
  |---|---|---|---|
  | dev | 0 | 19 (0 deleted) | 0 |
  | prod | 0 | 22 (10 deleted) | 0 |

  No (unknown, active) rows: nothing to move. W2 trigger (100 live rows) not
  met; recorded in unknown-queue-status-flip-duplicates-across-pages.md.
  Re-run the active count only if a deploy is delayed: until it lands, the
  old edit form can still create one.
