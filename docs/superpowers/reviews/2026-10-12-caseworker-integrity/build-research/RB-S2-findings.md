# RB - S2 (D2 type change) live-tree drift check - findings

Reader: RB (read-only research reader), caseworker-integrity build mission,
2026-10-12. Tree: `W:\tmp\caseworker-integrity` @670fb701 (no app/, dashboard/
or e2e/ change since base 19607658). Scope: plan lines 1-262 (binding) and
3295-5589 (S2, Tasks 2.1-2.8 + slice gate), spec sections 1, 3 and 8, the
assembly rulings (S2-1..S2-5) and the plan-review adjudications.

Method. Every S2 operation was applied IN ORDER, in memory, to scratch copies
of the live files: 36 anchor edits (each counted: all 36 match verbatim and
exactly once), 7 creates and 7 appends. The resulting tree was then:
linted with the repo config (ESLint API `lintText`, nothing written);
type-checked with the TypeScript API over `app/tsconfig.test.json` and
`dashboard/tsconfig.json` through an in-memory overlay host (a negative control
proves the overlay files were in the program); and EXECUTED - the overlay was
served to vitest by a Vite `load` hook from a scratch config (cache in scratch;
for the app no globalSetup/setupFiles and DynamoDB pointed at a dead local
port, FakeWorld suites only), one file per run, new test files riding an
existing test path in the same directory so their relative imports resolve
identically. Each RED was produced by serving a task's test edits with that
task's implementation excluded. The worktree was verified unchanged afterwards.
Evidence tables, commands and importer lists:
`.superpowers/sdd/research/RB-S2-reference.md` (gitignored).

Headline: 0 BLOCKER, 1 CORRECTION, 4 NOTE. S2 is executable as written.

- Lint: all 18 S2 `.ts`/`.tsx` files 0 errors, 0 warnings (react-hooks and
  React Compiler rules included); the 12 pre-existing ones are 0/0 at base.
- Typecheck: app (783 roots) 0 diagnostics; dashboard (502 roots) 0.
- ASCII: 0 non-ASCII bytes in the 7 new files and in every added line.
- Every GREEN passes as written, and every RED fails for the stated reason
  with the stated counts (2.1: 8 TypeError; 2.3: 7 TypeError, 9 pass;
  2.4: 23 fail / 15 PIN pass; 2.6: 3; 2.7: 2 of 14; 2.8: 3).
- W2 holds (N2); W6 holds (its PIN passes on base and D2 code).
- Spec section 3 is met exactly (refuse only on a real type change; every
  target incl. `team_member` and `unknown`; live units only; seats never
  refuse; after the 409 `caseworker_use_conversion`, inside the
  classification block, before the org-name 422 and every write; role-only
  unchecked; body and order; edit form keeps the draft with sentences + View
  links beside the kind picker; the Unknown card stops swallowing errors).

---

## C1 - Tasks 2.2, 2.4, 2.5, 2.6, 2.7, 2.8 - CORRECTION: the ASCII checks can pass having checked nothing

- Plan: Task 2.2 Step 5 (plan 3900-3901) "`tr -d '\11\12\15\40-\176' <
  app/src/services/contactHoldings.ts | wc -c` and the same for
  `app/test/contactHoldings.test.ts` print 0"; Task 2.4 Step 5 (4471-4473) the
  same for `app/test/contactTypeChangeRefusals.test.ts`, plus "added lines of
  `git diff -- app/src/routes/contacts.ts app/test/contactTriage.test.ts` are
  ASCII"; Tasks 2.5 (4814-4815), 2.6 (5125-5126), 2.7 (5327) and 2.8
  (5539-5540) state the check with no command. None carries `cd
  "W:/tmp/caseworker-integrity"` or `git -C` (the eslint lines beside them do).
- Trap: an agent shell's cwd resets to the MAIN checkout (`.claude/CLAUDE.md`
  "Claude worktree shell behavior"), where the new files do not exist and
  `git diff` is empty. `tr ... < missing-file | wc -c` prints `0` and exits 0
  (verified; the only sign is one stderr line), and the empty diff reads as
  "added lines are ASCII". Both report clean having read nothing - the same
  shape as AGENTS.md's empty-list gate-5 trap. (Today's content is clean - see
  the headline - so this is about the check's validity, not the code.)
- Fix: run every ASCII check from the worktree, failing loudly on a missing
  file; one pair at the slice gate covers all of S2:
  ```
  cd "W:/tmp/caseworker-integrity"; for f in app/src/services/contactHoldings.ts app/test/contactHoldings.test.ts app/test/contactTypeChangeRefusals.test.ts dashboard/src/lib/holdingRefusals.ts dashboard/src/lib/holdingRefusals.test.ts dashboard/src/routes/contact/TypeChangeRefusalList.tsx dashboard/src/routes/contact/TypeChangeRefusalList.module.css; do test -f "$f" || echo "MISSING $f"; printf '%s ' "$f"; tr -d '\11\12\15\40-\176' < "$f" | wc -c; done
  cd "W:/tmp/caseworker-integrity"; git diff -U0 19607658 -- app/src/lib/caseworkers.ts app/test/caseworkers.test.ts app/src/services/caseworkerConversion.ts app/src/routes/contacts.ts app/test/contactTriage.test.ts dashboard/src/routes/contact/CaseworkerDialog.tsx dashboard/src/routes/contact/ContactEditForm.tsx dashboard/src/routes/contact/ContactEditForm.test.tsx dashboard/src/routes/contact/UnknownFile.tsx dashboard/src/routes/contact/UnknownFile.test.tsx dashboard/src/routes/contact/UnknownFile.module.css dashboard/src/routes/contact/ContactDetail.tsx dashboard/src/routes/contact/ContactDetail.test.tsx | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c
  ```
  Expected: each new file prints `0` and no `MISSING` line; the diff prints
  `0`. (The diff from 19607658 also carries S1's added lines in the two
  ContactDetail files; S1 owes ASCII there too, so a 0 covers both.) The same
  absolute-path rule applies to section 0's generic `tr ... < FILE` example.

## N1 - Task 2.4 / ruling S2-3 - NOTE: the contactTriage fixture swap is necessary and sufficient

- Necessary (executed): with the base fixture (open placement `p-cw-race`,
  `app/test/contactTriage.test.ts:748-752`) and the D2 route, all four
  "concurrent partial edits cannot bypass conversion" cases time out (type /
  role first x revision absent / 0): the type PATCH is refused before
  `contacts.update`, so `arrived.type` never resolves.
- Sufficient (executed): with the swapped seat fixture the file is 62/62 on
  the base route (Step 1's claim) and 62/62 on the D2 route; the conversion
  answers `caseworker_on_roster`.
- No other test re-types a contact that holds an open tour, an open placement
  or a live unit's `landlordId`. app/test: every suite that PATCHes `type`
  (`aiRunVerdicts.test.ts:1928-2255` via `patch()` :179,
  `contactEmailReaders.test.ts:186`, `suggestions.test.ts:453`,
  `contactStaffNotes.test.ts`, `contactTriage.test.ts`) seeds no holding;
  contactIntakeFields, landlordContactFields and trimStrings PATCH other
  fields after a POST. All pass on the full S2 overlay. dashboard: tests mock
  `updateContact`. e2e: every re-type is of a fresh contact with no holdings
  (`ai-run-log.spec.ts:338,492`, `caseworkers.spec.ts:252` (409 caseworker
  first), `scenarios/steps.ts:764,1412` and
  `flows/conversation-fact-extraction.spec.ts:307-385` triage a captured
  inbound unknown). Consistent with ruling S2-4.
- W1: no other server path writes an existing contact's `type`
  (`routes/dev.ts:1237` org fields, webhook consent stamps
  `webhooks/twilio.ts:1181,1222`, `webhooks/voice.ts:725`, extraction
  `services/extraction/apply.ts:500` only suggests `type`); the conversion and
  the out-of-scope importer are the rest, as spec section 5 says.

## N2 - Task 2.2 - NOTE: W2 proven by execution, not only by reading

- The conversion's own tests: `app/test/caseworkerConversion.test.ts` (79) and
  `app/test/caseworkerReviewApi.test.ts` (26) pass UNEDITED on the extracted
  conversion. A negative control (one `caseworker_*` code altered in the
  overlay conversion) fails 6, so the extracted code is what ran.
- Other suites that exercise it: `app/test/contactTriage.test.ts` (route,
  caseworker describe), `dashboard/src/routes/contact/CaseworkerDialog.test.tsx`
  (27, unedited, passes), `dashboard/src/routes/contacts/CaseworkersList.test.tsx`
  (19, passes), the conversion cases in `ContactDetail.test.tsx` (passes),
  `dashboard/src/api/endpoints.test.ts` (endpoint shape only), e2e
  `tests/dashboard-next/caseworkers.spec.ts`.
- Line by line against `caseworkerConversion.ts:217-266`: same four reads in
  the same order (placements pages, tours, landlord pages, Scan pages), same
  paging options and cursors (the cursor test at
  `caseworkerConversion.test.ts:196-214` still sees `[undefined, { unitId:
  'u-ll-a' }]`), `deleted: 'any'` on both unit reads, the Scan skips the
  landlord set, the same `byId` comparator, the same four codes in the same
  order, no new try/catch. `holdings` holds the same repo objects, so the tests
  that swap or spy a repo method after setup (:202-205, :290-291, :858-860)
  still reach it.

## N3 - Slice gate - NOTE (optional): one more dashboard suite loads an S2 change

`dashboard/src/routes/contacts/CaseworkersList.test.tsx` renders
`CaseworkerDialog` (`CaseworkersList.tsx:343`), whose `refusalCopy` now
delegates to `lib/holdingRefusals.ts`. It is not in the slice gate's dashboard
run (plan 5555). It passes 19/19 on the S2 overlay and the CK checkpoint's
`npm test` runs it anyway; add it to the gate line only if the slice should
prove every dialog host itself.

## N4 - S2 / cross-slice - NOTE: still-compiles checklist (all handled)

- `OPEN_TOUR_STATUSES`: no importer today (private
  `caseworkerConversion.ts:120`, only use :229); S3 imports it from
  `contactHoldings.ts` into `routes/tours.ts` (plan 6708) - no name collision
  anywhere in app/src.
- Imports the conversion drops: `TERMINAL_STAGES` (:17, only use :224),
  `unitContacts` (:39, only use :254). No other file is affected.
- `refusalCopy`: used only at `CaseworkerDialog.tsx:352`, plus the new
  `holdingRefusals.test.ts`.
- `contactKind(c: { type?: unknown; role?: unknown }): string` matches S3's
  `import { contactKind as kindOf }` and `kindOf(contact)` (plan 5868, 5915).
- Contacts PATCH consumers that can send `type`: only `ContactEditForm.tsx:495`
  and `ContactDetail.tsx:670` (Tasks 2.6, 2.8). `ConsentCaptureModal.tsx:52`,
  `StaffNotesCard.tsx:124` and `ContactDetail.tsx:805` never send `type`.
  `ApiError` exposes the parsed body as `body` (`dashboard/src/api/client.ts:13-33`),
  the mechanism `CaseworkerDialog.tsx:116-121` already uses.
- No dashboard endpoint changes, so `e2e/performance/mutationCatalog.ts` is
  untouched (`updateContact` already at :90).
- Slice order: S1 edits only the suggestion refetch block of
  `ContactDetail.tsx` (:708-725) and the refetch table / one suggestions case
  in `ContactDetail.test.tsx` - no S2 anchor overlaps them. No later slice
  edits a region S2 changes (S3 Task 3.18 edits `TenantFile.tsx` only).
