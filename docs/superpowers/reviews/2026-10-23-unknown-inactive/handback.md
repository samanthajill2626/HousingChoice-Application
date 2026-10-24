# Handback - feat/unknown-inactive (tracker #30 "Inactive for every contact type")

**MERGE-READY @798de475 (the gated code commit) on feat/unknown-inactive
(W:\tmp\unknown-inactive), 0 behind main @916258ae, UNMERGED (human gate).**
Every commit after 798de475 is docs/superpowers records only
(`git diff --stat 798de475..HEAD -- . ':!docs/superpowers'` prints nothing).

**NO infra, NO migration, NO dependency, NO post-merge build ops.** Rollout
owed (W7, planner + Cameron, NOT the builder): just before deploy, re-count
(unknown, active) on dev and prod (0 / 0 on 2026-10-23). Until the deploy
lands staff can still create one from the edit form; after it, such a row is
read by no inbox Unknown-tab block and no Today pass (it shows only on
Contacts > Unknown). Any found move only on Cameron's go. After deploy an
open Unknown tab's "Load more" may 400 once (cursor in the removed Active
block; reload recovers - spec D9).

Builder: abt-build-orchestrator, AUTO, 2026-10-23 13:54-20:55 EDT. 21 child
agents (6 research readers, 7 slice implementers S1/S2/S3/S4a/S4b/S5/S6,
3 fix waves, 5 reviewers), 0 misfires, 0 recoveries (agent-failure 0,
infra 0).

## 1. Work map

| Item | Result |
|---|---|
| Setup | `npm ci` exit 0. DynamoDB Local and MinIO already running; `db:start` NOT run (it prunes 7-day-old per-key DBs). |
| Research | 6 parallel readers (S1, S2, S3, S4, S5+S6, whole-app invariant sweep): 0 BLOCKER, 2 MAJOR, 32 MINOR -> `build-research/WORKLIST.md` (OR-1..OR-22, binding). |
| S1 backend lists + writers | SHIPPED e7724e4e..d95f4934 (+ OR-2, OR-8..OR-11). AR17 fixture flips done inside S1.1. |
| S2 409 + contact.updated | SHIPPED e93c49ab..a64e05d1, plus S2.5b (OR-3: status-only PATCH consistent read + type fence), OR-4 (timeline refetch), OR-5 (latest-wins re-read). |
| S3 backend readers | SHIPPED c6ec169b..b5425f9c (+ OR-6, OR-12..OR-14). W4: no inbound writer moves an existing contact's status (proved by tests). |
| S4 contact page | SHIPPED, split S4a 4138acf0..d4ba5fd6 / S4b 66322757..dd3ef56c (+ OR-1, OR-15, OR-21). AR21 default kept (non-tenant Contacts rows plain text). |
| S5 inbox | SHIPPED f06257d6..4fbc711a (+ OR-7: a resurfaced deleted Inactive row shows Deleted AND Inactive, OR-19). |
| S6 e2e + docs | SHIPPED 5809b2ad..8738fcfd: `e2e/tests/dashboard-next/unknown-inactive.spec.ts` (green1 1 passed; red1 fails at step 9 with the Today skip removed; red2 fails at step 7 with the Unknown sort removed; red3 fails at step 6 with `inactiveLast` removed; green2 36 passed incl. the 5 pinned neighbor specs), STATUS-MODEL 5b, GLOSSARY. W3: the dashboard Today fallback runs only on a 404 and is unchanged. |
| S7 | W1: no #31 branch/worktree (checked 13:55, 15:39, 20:47). main already contained, no merge commit. Gates below. |

DEVIATIONS from spec/plan (each recorded; the first is the one Cameron should look at):
1. **OR-1 (orchestrator, beyond the spec):** Contacts > Unknown lists Inactive
   contacts AFTER Needs review ones (stable partition, server order within each
   group). Without it, the byTypeStatus GSI (ascending by status) would have
   listed every Inactive unknown ABOVE every Needs review one. Revert set if
   Cameron prefers otherwise: `inactiveLast` in ContactsList.tsx + its test, the
   STATUS-MODEL/GLOSSARY sentences, the contacts-status-filter-tenants-only.md
   sentence, e2e step 6's order assertion.
2. **FW1-1 (extends AR4):** `/tenant-status` accepts an optional client
   `expectedType` (the type the client's status list was built from); a mismatch
   is 409 `contact_type_changed` decided before the allowlist check. The header
   sends `contact.type`, the edit form `statusType`. Without it a form open on an
   unknown contact would write Inactive onto a contact a colleague had just made a
   tenant (200, (tenant, inactive)) - CONFIRMED by R1.
3. **FW2-1 (narrows spec D5's literal rule):** the Today skip applies only when
   the Inactive owner is typed unknown or team_member; any other owner keeps
   main's behavior (a tenant's second-number or imported unknown_1to1 thread is
   not hidden).
4. Plan clarification 3 (a re-type to tenant with Porting changed also calls
   setTenantStatus) differs from D3's "ONLY if the shown status is not
   Onboarding"; pinned by FW1-5.
5. Added emitters/fences beyond the plan: OR-3 (status-only PATCH fenced on
   type), FW1-3 (a re-type that keeps the stored status is fenced on it; API-only
   reach), FW1-4 (the caseworker conversion emits contact.updated), OR-4/OR-5,
   FW2-2 + FW3-1 (edit form: Save off after its 409, and the page re-reads).
6. services/statusTransition.ts imports `ConditionalCheckFailedException` from
   `@aws-sdk/client-dynamodb` (plan S2 C1 said to reuse that idiom; precedent
   caseworkerConversion.ts:12; against the letter of AGENTS.md's vendor-import rule).

## 2. Gates on the final code commit 798de475 (battery 4, bare, real exit codes)

- start 2026-10-23 19:51:14, head 798de475, main 916258ae, node v24.21.0;
  exported AWS_* names: none.
- `npm run typecheck` -> exit 0 (0 `error TS`).
- `env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY npm test` -> exit 0:
  app `Test Files 527 passed (527)` / `Tests 11174 passed | 1 skipped (11175)`;
  dashboard `266 passed (266)` / `5492 passed (5492)`; e2e `22 passed (22)` /
  `508 passed (508)`; fake-twilio `34 passed (34)` / `275 passed (275)`;
  fake-twilio-web `13 passed (13)` / `111 passed (111)`. No `[dynamoAdmin]` line.
- `npm run smoke` -> exit 0: `smoke-dist: OK - 1733 import specifier(s) across
  301 emitted file(s) resolve under plain Node.`
- `timeout 2700 npm run e2e` -> exit 0: `372 passed (15.8m)`.
- Gate 5 `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')`
  -> exit 1, 82 files, `1 problem (1 error, 0 warnings)`:
  dashboard/src/routes/contacts/ContactsList.tsx:219 react-hooks/set-state-in-effect
  - PRE-EXISTING: the merge-base content of that file reports the identical error
  at :208 (lines added above it). No lint error is this branch's. No .js/.mjs in
  the list.
- Earlier batteries, all four gates green first time, no re-runs, no flakes:
  battery 1 @8738fcfd (build end), 2 @ba39fe2b (FW1), 3 @ed2363b3 (FW2),
  4 @798de475 (FW3) - each e2e `372 passed (15.8m)`.

## 3. Size

89 non-record files: code (app/dashboard/e2e) 84 files +4452 / -490 (app/src
19 files +526/-159; dashboard/src non-test +551/-241; tests app/test + e2e
+2063/-49, dashboard tests +1306/-37); docs (documentation/, docs/issues/)
5 files +192/-7. Records (docs/superpowers: spec, plan, reviews) 41 files
+16432. 51 code/docs commits; the rest are records.

Code/docs commits, in order: 0957ed39 (planner: issue filed), e7724e4e
81ca584a a2878e2c fa07bb2b 2bea6c66 275c2911 66a850cf (S1); e93c49ab b780bc40
ee62140e b3d4560f 74d11b88 4390f193 d6f41875 836992eb e39b88d5 cf9972d2
940c1313 (S2); c6ec169b bc0df182 bd732fba 9cd80cae c3044ed1 (S3); 4138acf0
a8cdb9a6 132bc331 031a9512 cc563411 66322757 f6c1c495 (S4); f06257d6 9cab2e8f
55d115a5 aedbc481 (S5); 5809b2ad 8152f3bf 6e0b23d9 (S6); 9c6cb8fc f995b87b
099d12ce 19a5e0f8 923f3df2 55605ea2 57896482 (FW1); 8efaf752 568402b4 f98f09b7
(FW2); 0345be47 0f1b973f d7abe437 (FW3). Subjects: `git log --oneline
916258ae..798de475 -- app dashboard e2e documentation docs/issues`.

## 4. Reviews and resolutions (records in code-review/)

- R1 (8738fcfd): spec-conformance 97 CONFORMS / 1 PARTIAL / 0 MISSING, 1 MEDIUM
  (the service's conditional write unpinned in its own window - mutant passed
  103/103); plan-blind adversarial 1 MEDIUM CONFIRMED (the fence guarded the
  route's window, not the client's), 4 LOW, 5 INFO -> FW1-1..FW1-6.
- R2 (ba39fe2b, fresh): 0 C/H/M, 2 LOW, 4 INFO; every FW1 fix REAL by revert ->
  FW2-1..FW2-3; R2-2 (W8) to the planner.
- R3 (ed2363b3, fresh): 0 C/H/M, 1 LOW (challenged my R2-6 ruling: the form's
  Save-off guard lasted one opening), 3 INFO -> FW3-1, FW3-2.
- R4 (798de475, fresh, scoped): INFO only; FW3 REAL by revert -> loop CLOSED.
- Fix waves: FW1 (6 items, 30 min), FW2 (3 items, 19 min), FW3 (2 items,
  17 min); every behavior item RED-first; test-only items proven by mutant.

## 5. Decisions and calls for the planner / Cameron

1. OR-1 Contacts > Unknown order (deviation 1) - confirm or reverse.
2. R2-2 / W8: the live Today drop and inbox tag rest on ONE refetch 300 ms after
   contact.updated over eventually consistent reads (today.ts:362 GetItem,
   :892-899 GSI; inbox byPhone GSI); a stale answer is never corrected. R2
   proposes a second refetch ~2 s later on contact.updated (dashboard-only). The
   plan's W8 ruled no mechanism change, so not built.
3. SPEC-F3 / ADV-7: a status write that commits but whose required audit then
   throws sends no contact.updated (AR3's "every successful call", pinned);
   spec D2 says "EVERY status change". Emit after the write, or note the
   exception.
4. SPEC-F4: append the importer's preserved-status re-type pair shape
   ((landlord, inactive), (unknown, active) via lib/import/apply.ts
   preserveStatus) to docs/issues/import-bypasses-contact-type-rules.md?
   STATUS-MODEL and statusModel.ts now name it as the one exception.
5. SPEC-F2: amend D3's wording for the porting case, or reverse it.
6. R3-2 + R4-1 (pre-existing class): the contacts PATCH re-type is not fenced on
   the edit form's base type/revision, so a retry after the PATCH's own
   409 contact_changed, or a form reopened while the page's re-read is still in
   flight, can re-type over a colleague's re-type. The server-side fence is the
   real fix (same family as docs/issues/ha-review-close-name-patch-unfenced.md).
   R4-3: ContactEditForm.test.tsx ~:2051 pins the current R3-2 behavior.
7. W2: docs/issues/unknown-queue-status-flip-duplicates-across-pages.md -
   trigger not met on the recorded counts; Inactive is now the one-click
   set-aside that never drains the partition; re-measure beside W7.
8. The resolved docs/issues/unknown-queue-cap-starves-needs-review.md reopen
   trigger counts (unknown, active), now structurally 0 (S1 report).

## 6. Live self-QA (self-qa.md; screenshots .playwright-mcp/qa-01..15, gitignored)

Hermetic lane 4 (`/__dev/ping` dev:true), 12 checks, no defects: header
dropdown options exact per type (unknown [Needs review, Inactive]; partner and
team member [Needs review, Active, Inactive]); request bodies at the boundary
(`{"toStatus":"inactive","source":"manual","expectedType":"unknown"}`); "Needs
triage" -> "Type unknown"; muted pill; an already-open Today page dropped the
row +416 ms after the click with no reload; inbox Unknown tab Needs review
first then Inactive newest first, tag present, chip absent; no horizontal
overflow at 360/768/1024/1280/1440 with a worst-case long name; Contacts >
Unknown order; edit form displays Inactive and an unrelated save sends only
that field; form status saves go through /tenant-status; a new inbound to an
Inactive contact is unread on All/Unread/Unknown, stays off Needs you now and
keeps Inactive; with /api/events blocked, the header's and the form's stale
picks both 409 and nothing illegal is stored; Mark as Tenant from Inactive ->
Onboarding (D7); console clean.

## 7. Issues

None filed (AR14). Existing issue bodies updated where this branch changed
the behavior they describe: contacts-status-filter-tenants-only.md (OR-1
sentence), unknown-queue-status-flip-duplicates-across-pages.md (S3.6 W2
paragraph), ha-review-close-name-patch-unfenced.md (FW2-3 dated update).
The planner filed contacts-status-filter-tenants-only.md at 0957ed39.

## 8. Not blocking - your eye

- Partner/team member/unknown form status saves are two non-atomic writes
  (field PATCH, then /tenant-status); only the 409 contact_type_changed has its
  own copy.
- useContact's latest-wins sequence does not cover the initial load,
  setContact, or the 409 re-read helper (ADV-6, R4-2): a brief display-only
  staleness in narrow races.
- A tenant's or caseworker's second-number (or imported) unknown_1to1 thread
  still shows as "New unknown contact" whatever its status - pre-existing,
  filed as imported-unknown-threads-surface-as-unknown-on-today.
- At 360-768 px the "Type unknown" card sits behind the existing "Profile"
  toggle, exactly where "Needs triage" sits today.
