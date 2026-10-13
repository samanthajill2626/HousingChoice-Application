# R2 code review - feat/join-housing-authority (fresh re-review)

Reviewer: round-2, fresh (Claude Opus 5.5), 2026-10-12. Tree: d7cbbab3 (fix wave 1 at
348bf3c7 plus a docs-only issue commit). Charge: `.superpowers/review/r2-brief.md`, method and
environment rules from `.superpowers/review/adversarial-charter.md`. Order followed: (1) a
full-state hunt over `r2-full-diff.txt` and every other reader/writer of the touched state,
(2) the fix diff cold, (3) only then the R1 records and the spec, (4) fix verification.

Environment: run2 e2e was live until `.superpowers/sdd/gates/run2-e2e.exit` appeared
(`exit=0 dur=1466s`, `340 passed (24.4m)` at run2-e2e.log:101775). Nothing was created or run
in the worktree before that marker. Afterwards only throwaway `zz-review-*` files were
created, run singly, and deleted; `git status --short` is empty at the end and the two
mutated-by-alias files hash as before (IntakeForm.tsx 38d4a8a5...461a, backfill script
6ced658f...17d9). No full suite, no e2e session, no backfill run, no git/docker action.

Mutation method note: the in-place mutation the charter describes (back up, edit, restore)
was REFUSED by the session's permission classifier (an Edit on IntakeForm.tsx and the
restoring copy were both denied; nothing was changed - hashes confirmed). I did not retry
it. Instead each mutant is a NEW copy of the module and a throwaway vitest config aliases
the REAL test file's import to that copy (`resolve.alias`), so the real, unmodified test
file runs against the mutant and no tracked file is ever touched. Each mutant run has a
control run of the same test on the real module.

Severity scale CRITICAL/HIGH/MEDIUM/LOW/INFO; CONFIRMED (reproduced) / PLAUSIBLE (reasoned).

**Bottom line: no new or fix-wave defect at MEDIUM or above - nothing reopens.** Three LOW
(one a candidate one-line fix), three INFO, two partial disagreements with adjudications,
all six fixes real.

---

## 1. New findings (missed by round 1)

### R2-N1 - LOW - CONFIRMED - the not-listed recovery's error sticks to the wrong fields

Where: `dashboard/src/routes/public/IntakeForm.tsx:58` (`error` state), `:69-76` (only the
person fields' handlers clear it), `:133` (`setError(errorMessage?.(err) ...)`), `:170` and
`:189-190, :208-209, :231` (every person field gets `aria-invalid={error !== null}` and
`aria-describedby="intake-error"`), `:256` (the select is rendered as an opaque
`extraField`); `dashboard/src/routes/public/HousingAuthoritySelect.tsx:108-110` (the
select's onChange goes only to the parent; its `aria-describedby` is the help text only);
`HousingFairIntake.tsx:135-142`.

What is wrong: on `housing_authority_not_listed` the form says "Choose the housing authority
again", but (a) the message is attached to First name, Last name and Phone (all marked
`aria-invalid="true"`), not to the select that needs the action - the select has no
`aria-invalid` and is not described by the alert; (b) after the person makes the choice
the message asks for, the alert stays up and the three valid person fields stay
`aria-invalid="true"` until the next send, because a select change never reaches
IntakeForm's error. A screen-reader user tabbing the fields hears three valid fields
announced invalid with a message about a different field. The "every field invalid" pattern
predates this branch for generic failures, but this message is field-specific and new.

Evidence (`dashboard/src/routes/public/zz-review-r2-recovery.test.tsx`, deleted): DeKalb
chosen, send, refusal, re-read shows "Choose one", then "Cobb County Housing Authority"
chosen:
```
{"before":{"alert":"The housing authority list was updated. Choose the housing authority again.","firstNameInvalid":"true","selectInvalid":null,"selectDescribedBy":"intake-authority-help"},
 "after":{"alert":"The housing authority list was updated. Choose the housing authority again.","firstNameInvalid":"true","lastNameInvalid":"true","phoneInvalid":"true","firstNameDescribedBy":"intake-error"}}
AssertionError: expected 'The housing authority list was update...' to be null
```
Fix: in IntakeForm wrap the slot so a change inside it clears the error like any field -
`<div onChange={() => { if (error !== null) setError(null); }}>{extraField}</div>` (React
change events bubble) - and, while the value is "Choose one", give the select
`aria-invalid="true"` and add the alert id to its `aria-describedby` (HousingFairIntake can
pass an `invalid` prop to HousingAuthoritySelect). Not required by spec D8 (it never says
when the message clears), so LOW / file it if not fixed.

### R2-N2 - LOW - PLAUSIBLE (design gap the spec does not list) - the backfill ignores a pending housing authority suggestion

Where: `app/scripts/backfill-join-housing-authority.ts:307-324` (`BackfillDeps` has no
suggestion reader), `:477-485` (`leftOutReasonFor`: `--skip`, then audit history only);
`app/src/services/extraction/apply.ts:256-282` and `:290-327` (an authority the AI hears on
an EMPTY field is SUGGESTED, not written, when it is not an exact/unique list match -
including the ambiguous "AHA" - or when an op:'write' is demoted for inferred-role call
content); `app/src/repos/extractionRepo.ts:234-240` (`getSuggestion(contactId, target)`).

What is wrong: a pre-change lead whose own text or call already named an authority that the
AI could only SUGGEST (for example "my voucher is DeKalb" heard on a call) is still a
candidate; a dry run lists it as a plain target and `--apply` writes Atlanta beside the
pending DeKalb suggestion. The operator's `--skip` review is the only place a wrong Atlanta
is meant to be caught (RUNBOOK step 2), and the report gives no hint. Not data loss: the
suggestion survives and an accept overwrites Atlanta (`suggestionResolution.ts:336-349`
guards on the contact as read at accept time, not on the suggestion's stored
`currentValue`). Spec D10's left-out list (spec lines 198-217) does not mention pending
suggestions, so this is a spec gap, not a conformance defect.

Evidence: by construction (no dependency in BackfillDeps can read a suggestion); not
reproduced against DynamoDB Local.

Fix: in `leftOutReasonFor`, read `getSuggestion(contactId, 'housingAuthority')`; when one is
pending and its value is not exactly "Atlanta Housing Authority", either leave the lead out
("has a pending housing authority suggestion: <value>") or append that value to its target
line so the operator decides. One extra GetItem per candidate.

### R2-N3 - INFO - the new "per-IP" claims outlived R1-ADV-1

`app/src/app.ts:172`, `app/src/routes/public.ts:31` and `:480`,
`app/src/services/publicOrgList.ts:17`, `scripts/e2e-session.mjs:145` all call the new list
limit "per-IP". R1-ADV-1 (CONFIRMED) showed the key is the client-chosen first
X-Forwarded-For entry. The adversarial report's minimum ask ("correct the per-IP claims in
the new comments/RUNBOOK until it lands") got no disposition in R1-adjudications.md. The
filed issue's suggested fix does say "correct the per-IP comments", so this is tracked; noted
so the new comments are not read as a verified property.

### R2-N4 - INFO - severity mismatch on a filed issue

`docs/issues/join-repeat-signup-answer-unreachable.md:5` says `severity: low`;
R1-adjudications.md lists R1-ADV-3 as `MED`. Pick one (see section 3, R1-ADV-3).

### R2-N5 - INFO - "never an overwrite" is a prompt rule, not a code guarantee

RUNBOOK.md (the fix-wave sentence at the /join backfill section) says a later-stated
authority "arrives as an AI suggestion for staff to accept, never an overwrite". The code
writes whenever the model returns op "write" (`extraction/apply.ts:290-305`, no check that
the field is empty); the suggest-over-held-value behavior is the prompt's rule
(`extraction/prompt.ts:35-39`), which also allows a "write" over a held value for "the SAME
fact in a better form". The spec makes the same claim (spec lines 76-78, 288-290). Harmless
for a DeKalb-vs-Atlanta conflict; noted so "never" is not relied on as an invariant.

---

## 2. Fix-diff findings (59999afc..348bf3c7)

### R2-F1 - LOW - CONFIRMED - `visibleName` leaves Unicode format and line-separator characters raw

Where: `app/scripts/backfill-join-housing-authority.ts:238-245` (escapes code points 0-31 and
127-159 only); doc comment `:230-237` ("a name can never start a new report line ... or move
the terminal cursor").

What is wrong: U+202E (right-to-left override), U+2066-2069 (isolates), U+200B-200F
(zero-width, LRM/RLM) and U+2028/2029 (line/paragraph separators) pass through raw. In a
bidi-aware terminal an RLO in a name visually reverses the rest of the line - the
`contactId` the RUNBOOK tells the operator to copy included; some viewers (an editor or a
pasted log) break the line at U+2028. Exposure is pre-change data only (candidates are
pre-deploy leads), hence LOW. The implementer flagged this as remark 3 of the fix-wave
report; it was not adjudicated.

Evidence (`app/test/zz-review-r2-report.test.ts`, deleted; names built with
`String.fromCharCode(0x202e / 0x2028 / 0x200b)`):
```
{"rawFormatChars":["202e","2028","200b"]}
AssertionError: expected [ '202e', '2028', '200b' ] to deeply equal []
```
Fix (about two lines): test `/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u` instead of the two ranges, and
print code points above 0xFF as `\u` plus four hex digits so the escape stays unambiguous.
Qualifies as a one-line correctness fix under the closing rule if the orchestrator wants it.

### Other fix-diff observations (no finding)

- R1-C1 (33848c33): the child-process test now spawns `['--import', 'tsx', SCRIPT_PATH,
  '--bogus']` (test:1418) - no `--env`, so `parseStageArgs` refuses it twice over
  (`app/scripts/lib/stageClient.ts:203` unknown flag, `:205-206` no target). Correct.
- R1-ADV-4 (ce79d0fa): escapes before `.trim()`, so an edge control shows; the expected
  strings are built from `String.fromCharCode` with no backslash-u typed (ASCII rule kept).
  A literal name text `\x0a` prints like an escaped newline (fix-wave remark 2) - visual
  ambiguity only. See R2-F1 for the range.
- R1-C3 (955b01f8): `fireEvent.submit(form)` reaches the handler even with the button
  disabled, and the positive control after `submitBlocked={false}` proves the negative is
  not vacuous. Correct.
- R1-C4 (3993c693): the new comment matches app.ts:178-184 (the list router gets
  `deps.public.orgListRepo` only when one is injected) and app.ts:191-201 (`...deps.public`
  to createPublicRouter). Correct.
- RUNBOOK (6c7b018a): (b) and (c) are accurate against `public.ts:364` (marker on every
  create) and `backfill:154-158` (any v2 sign-up, /join or flyer); (a) see R2-N5.
- STATUS-MODEL (514538d2): accurate - flyer sign-ups still start `needs_review`
  (`public.ts:342`), /join sign-ups `onboarding`.

---

## 3. Adjudication challenges (R1-adjudications.md)

| Id | Disposition | My call | Evidence |
|---|---|---|---|
| R1-C1 | FIX | AGREE | See section 2; spec D10 last bullet (spec:255) forbids an agent running it against dev. |
| R1-ADV-4 | FIX | AGREE, scope too narrow | Real for C0/DEL/C1 (section 4); format/line-separator characters still raw - R2-F1. |
| R1-C3 | FIX | AGREE | Section 4: the new test is the ONLY one that kills the guard-removal mutant. |
| R1-C4 | FIX | AGREE | app.ts:178-184 vs :191-201. |
| R1-ADV-2 doc + R1-ADV-7 | FIX (RUNBOOK) | AGREE | Wording accurate except the absolute "never" (R2-N5, INFO). |
| R1-C6 | FIX | AGREE | public.ts:342. |
| R1-ADV-1 | FILED (pre-existing HIGH) | AGREE with the filing, PARTIAL on completeness | The defect is in shared middleware (`rateLimit.ts:67-74`) and predates the branch; the issue file is thorough. But the adversarial's minimum in-branch ask (correct the new "per-IP" comments) got no disposition - R2-N3. |
| R1-ADV-3 | FILED | PARTIALLY DISAGREE | The stated reason is TRUE for the contact write: spec D6 (spec:136-137) "Its answer is kept only in the audit (D7)." and section 5 (spec:307) puts "Changing an existing contact from a repeat sign-up" out of scope. It does NOT cover the cheap half the adversarial proposed: printing the latest v2 `housingAuthority` on each `signed up again` report line changes no contact, lives inside D10's own report (spec:225-228, which this branch writes), and costs a few lines because `leftOutReasonFor` already holds the events (`backfill:483-484`). It is exactly the lead the feature is for (an engaged lead who answered and still ends with NO authority). Not a reopen (spec-compliant as built); recommend doing the cheap half here or recording it as the issue's first step, and align the severity (R2-N4). |
| R1-ADV-2 code | REJECT | AGREE with the conclusion; one reason is stretched | "Cameron: authority only" (spec:196-197) is about STATUS ("status left alone"), not provenance. The real ground is D10's write definition (spec:241-242) "Status and every other field are left alone" plus section 4 (spec:288-290), which accepts suggest-over-held-value for the default. The importer half is moot as claimed: imports key on `uuidv5(contact:<phone>)` (`lib/import/ids.ts:55-56`, upsert by that key at `lib/import/apply.ts:1059`) while /join creates `contact-<uuid>`; a /join lead is never the importer's item. |
| R1-ADV-5 | ACCEPT | AGREE | Spec D10 (spec:215-217) names this exact edge as accepted; the Query is eventually consistent (`auditRepo.ts:122-139`, no ConsistentRead), widening it to about a second. |
| R1-ADV-6 | ACCEPT | AGREE | Public by decision: spec D1 (spec:82-89) serves every housing authority name, and D3 (spec:113) "the list is public, so the code reveals nothing". The Settings note is rightly routed to Cameron. |
| R1-C2 | ACCEPT | AGREE | Spec D10 (spec:243) "After an apply, the run reads the list again"; with nothing written there is no record to strand, so the narrowing (`backfill:618`) loses nothing. |
| R1-C5 | ACCEPT | AGREE | Each item is additive; the one arguable case (a failed `housing_authority_backfill` append is a WARNING with exit 0, `backfill:530-537`) cannot cause a re-write because the lead then holds an authority. Spec exit codes (spec:253-254) do not name it. |
| INV-F1 | Handback line | AGREE | Matches spec section 4 (spec:281-283): /join leads lose the Needs review filter. |

### Gate-4 red (run1) - "not this branch": AGREE, now with stronger evidence

- run2 (the post-fix full gate) is green: `exit=0 dur=1466s`, `340 passed (24.4m)`
  (run2-e2e.log:101775). The blank-document failure did not recur.
- The failing step drives `/contacts/unknown` for an inbound text from an unknown number. The
  branch's dashboard diff is confined to `dashboard/src/routes/public/*` (the full-diff file
  list); the app changes touch `/public` and contacts created by `/public` only.
- In run1's log for the failing window (17:06:37-17:06:55 EDT, run1-e2e.log:68440-68520) every
  app request completed 200/304/401 in at most 29 ms - the server was not stalled, which fits
  the issue's client-side "blank document after contact navigation" signature, not a slow
  backend.
- Same signature on two other branches before this one (2026-10-08, 2026-10-11; issue
  `e2e-blank-document-after-contact-navigation`); the file passed alone right after (7/7).
- Not assessed (outside the brief): gate 2's run2 red (`run2-test.exit` exit=1, then run3
  exit=0, attributed in d7cbbab3 to the tour-reminders tie-break race).

---

## 4. Fix verification

| Fix | Commit | Verdict | Evidence |
|---|---|---|---|
| R1-C1 child-process test names no --env | 33848c33 | REAL (test hardening) | test:1418 argv is `--bogus` only; ran it: 1 passed (exit 2 + usage text asserted). By design it cannot fail "with the fix reverted" (reverting re-adds `--env dev`, which also exits 2); the usage-path mutations M-a/M-b in fix-wave-1-report.md stand. Not re-mutated: the child runs the on-disk script and in-place edits were refused. |
| R1-ADV-4 report names escaped | ce79d0fa | REAL (C0/DEL/C1); range gap = R2-F1 | Mutant copy with escaping removed (line 242 -> `out += c;`), real test file via alias: `1 failed / 74 skipped`, the R1-ADV-4 test failing `expected [ ...(6) ] to deeply equal [ ...(6) ]`. Control (real script): exit 0. |
| R1-C3 direct submit while submitBlocked | 955b01f8 | REAL | Mutant copy of IntakeForm.tsx without line 100, real IntakeForm.props.test.tsx via alias: `1 failed / 7 passed` - only the new test fails ("expected spy to not be called at all, but actually been called 1 times"); the old Enter-key test still passes, confirming R1-C3. Control: 8/8, exit 0. |
| R1-C4 orgListRepo comment | 3993c693 | REAL (comment) | Matches app.ts:178-184 and :191-201. |
| R1-ADV-2 doc + R1-ADV-7 RUNBOOK | 6c7b018a | REAL, one overstatement | (b), (c) accurate; (a) "never an overwrite" - R2-N5. |
| R1-C6 STATUS-MODEL landlord bullet | 514538d2 | REAL | public.ts:342 (flyer -> needs_review, /join -> onboarding). |

---

## Checked and found sound (fresh sweep, before reading R1)

- Public read/write paths: list router mounted before the shared limiter
  (`app.ts:178-201`), GET-only, Express 5 forwards async rejections (`app/package.json`
  express ^5.2.1); `keyOf: undefined` falls back to `clientIpOf` (`rateLimit.ts:84`);
  CloudFront `/public/*` is CachingDisabled (`infra/modules/cloudfront/main.tf:160-166`).
- `parseHousingFairBody`: consent gate first; authority shape after `deepTrimStrings`
  (`middleware/trimStrings.ts`, String.trim only, same as stored names); D4 refusal before
  any unit read; list check before unit/contact reads and any write; exact-name
  `isOnListFor` with the same kinds the GET serves.
- New-contact create: `onboarding` only without a unitId, authority only then, marker on
  every create, no `status_source` (matches the manual create, `routes/contacts.ts:938-957`);
  existing contacts untouched.
- Every `onboarding` / `needs_review` reader: `today.ts:167` (untriaged = unknown
  needs_review only), `extraction/apply.ts:535` (Onboarding -> Searching suggestion, spec
  section 4), `audienceResolution.ts` (no status filter), `missedCallAutoText.ts:84-127`
  (names suppress it), dashboard StatusBadge/ContactEditForm/ContactsList; no consumer of
  `capture_source: 'housing_fair'` beyond consent mapping (`smsCompliance.ts:106`).
- Backfill: candidate rule; pointer rows skipped; the guarded update maps `value: null` to
  `attribute_not_exists` and adds `notDeleted` (`contactsRepo.ts:1546-1564`); audit paging is
  exclusive on the unique `ts#suffix` SK (`auditRepo.ts:6-8, 81, 126`) so no page-edge gap;
  `touchesHousingAuthority` matches every writer's payload (`routes/contacts.ts:1950`,
  `caseworkerConversion.ts:426`, `extraction/apply.ts:505`, the accept journal's
  `target` (`suggestionResolutionRepo.ts:457`, `suggestionResolution.ts:343-349`),
  `orgRecords.ts:618-624`, `clean-org-names.ts:734`); a re-type never silently removes
  `housingAuthority` (`routes/contacts.ts:1579-1612`); importer cannot reach a /join item.
- Dashboard races walked: StrictMode double effect (own controller and timer per run,
  callbacks ignore an aborted signal), timeout vs resolution (microtask ordering, clearTimeout
  in both callbacks), abort during body parse (becomes `invalid_response`, still ignored),
  not-listed -> re-read -> "Choose one" -> failed re-read, "Sign up another person" re-read
  only after a failure; option values cannot collide with stored names; no service-worker
  fetch handler (`dashboard/public/sw.js`); `/join` is excluded from perf measurement
  (`e2e/performance/routes.ts:118`), so no template is owed.
