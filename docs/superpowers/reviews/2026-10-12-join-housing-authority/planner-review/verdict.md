# Planner verdict - feat/join-housing-authority (tracker #14)

**MERGE-READY. UNMERGED (human gate).** Code tip 0690f26c (main merged in,
0 behind main @ac798080); every later commit is a mission record. Spec
revision 6. Owed after merge: the RUNBOOK backfill, dev then prod, after
each deploy (no Terraform, secrets, env var, schema or index change).

## Gates on 0690f26c (the planner's own run, bare, real exit codes)

| Gate | Exit | Result |
|---|---|---|
| npm run typecheck | 0 | - |
| npm test | 0 | 463 + 242 + 22 + 34 + 13 test files, all passed; no [dynamoAdmin] line |
| npm run smoke | 0 | 1666 import specifiers across 289 emitted files resolve |
| timeout 2700 npm run e2e | 0 | 347 passed (28.4m) |
| npx eslint <32 branch files> | 0 | clean |

Earlier planner e2e runs: 340/340 on 7d5e36c6; 339/1 on f563e68d (the
eighth blank-document sighting, the file 5/5 alone). The blank-document
failures across this mission (ERR_NO_BUFFER_SPACE under concurrent suites)
are environmental and recorded on the open issue.

## Spec decisions

| Decision | Delivered | Proven by |
|---|---|---|
| D1 public list read (names only, sorted, never writes) | S1 | publicOrgList.test.ts, publicHousingAuthoritiesRouter.test.ts, publicIntake.test.ts |
| D2 own 60/min limit, mounted ahead of /public | S1 | publicIntake.test.ts (independence both ways), cloudfrontBehaviors.test.ts |
| D3 exact-name check, housing_authority_not_listed | S2 | publicIntake.test.ts |
| D4 flyer + authority refused | S2 | publicIntake.test.ts |
| D5 Onboarding start, marker on every new contact | S2 | publicIntake.test.ts, public-pages.spec.ts |
| D6 existing contacts untouched | S2 | publicIntake.test.ts |
| D7 audit signupVersion 2 + requested name, withAuthority log | S2 | publicIntake.test.ts |
| D8 /join select, loading/timeout/failed, recovery, 429 copy | S3 | HousingFairIntake*.test.tsx, HousingAuthoritySelect.test.tsx, public-pages.spec.ts |
| D9 Sign up another person | S3 | HousingFairIntake.another.test.tsx, public-pages.spec.ts |
| D10 backfill (rev 4-6: guards, refusals, all leave-outs, exclusions first) | S4 + fix waves 1-2 | backfillJoinHousingAuthority.test.ts; lane rehearsals 1-3 |
| D11 RUNBOOK | S4 + fix waves | RUNBOOK "/join leads: the housing authority backfill" |
| D12 Settings note | fix wave 1 | org Settings tests, org-lists.spec.ts |

## Reviews

- Orchestrator: research + three code-review rounds, then its own fresh
  reviews of each fix wave (all terminal at 0 MEDIUM or higher).
- Planner: conformance (62/1/0, then revision 5: 18/2/0) and a plan-blind
  adversarial reviewer kept alive for three rounds (5 MED + 7 LOW; then 1
  MED + 2 LOW; then EMPTY). Adjudications: `adjudications.md` in this folder.
- Accepted edges (in spec D10): best-effort audit appends; a re-sign-up in
  the milliseconds between a lead's reads and its write; `deleted_at: ''`;
  the fw2 L1 read-order window.

## Merge command (Cameron)

From the main checkout, after `git status` is clean there:
`git -C "W:\AI Projects\Housing Choice\HC Application" merge --ff-only feat/join-housing-authority`
