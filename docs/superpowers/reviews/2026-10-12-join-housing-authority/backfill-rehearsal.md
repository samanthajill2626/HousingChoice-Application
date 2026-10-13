# Backfill rehearsal (plan Task 6.3a) - hermetic lane 4

Run 2026-10-12 by the build orchestrator on this worktree's own `npm run e2e:session` lane,
booted at 72473aec (code identical to the gated 15c1676f), after the live self-QA on the
same session. No Playwright spec and no reseed ran between Step 4 and Step 8. Every
backfill command read the lane from `e2e/.artifacts/lane.json` in the same Bash call and
refused an empty or non-positive lane. The throwaway seed script is the plan's text
verbatim (extracted from plan lines 8247-8456 into the gitignored
`.superpowers/sdd/rehearsal/seed-pre-change-leads.ts`). Output below is VERBATIM.

Result: every step matched the plan's expected text (Step 5 and 6 report lines
byte-identical; Step 8 exactly as expected). No finding. The only cosmetic difference: the
final two JSON log lines of a run can print after the report lines (stdout ordering).

## Step 1 - lane.json excerpt (ownerToken omitted)

```text
{"lane":4,"launcherPid":65732,"urls":{"app":"http://127.0.0.1:9401","dashboard":"http://127.0.0.1:9411","fake":"http://127.0.0.1:9421","publicBase":"http://127.0.0.1:9431"},"tablePrefix":"hc-local-4-","accessKeyId":"hclane4"}
```

## Step 2 - a post-change /join sign-up with "Not sure" (Playwright MCP)

Rehearsal Notsure, 555-010-9010, "Not sure", consent checked, "Sign me up": the POST body
was `{"firstName":"Rehearsal","lastName":"Notsure","phone":"+15550109010","smsConsent":true}`
(no housingAuthority key) and the thank-you showed. Screenshot (gitignored):
`W:/tmp/join-housing-authority/.playwright-mcp/6.3a-join-not-sure.png`.

## step4-seed

```text
$ npx tsx .superpowers/sdd/rehearsal/seed-pre-change-leads.ts
lane 4: DynamoDB Local http://localhost:8000 database hclane4 (e2e lane 4); app http://127.0.0.1:9401
created  rehearsal-lead-target-1 - expect TARGET
created  rehearsal-lead-skipme - expect TARGET in the plain dry run; LEFT OUT (named in --skip) in the apply
created  rehearsal-lead-history - expect LEFT OUT (its housing authority was set or removed before)
created  rehearsal-lead-target-2 - expect TARGET (status is not a condition; it stays on_hold)
created  rehearsal-lead-deleted - expect NOT A CANDIDATE (deleted): in neither list
org-list item: stored
exit=0
```

## step5-dryrun

```text
$ L=$(node -p "require('./e2e/.artifacts/lane.json').lane") && [ "$L" -ge 1 ] && npx tsx app/scripts/backfill-join-housing-authority.ts --env local --lane "$L"
{"level":30,"time":1791844872508,"pid":76596,"hostname":"ABT-DESKTOP","target":"local","endpoint":"DynamoDB Local http://localhost:8000 database hclane4 (e2e lane 4)","prefix":"hc-local-4-","apply":false,"skip":0,"msg":"backfill-join-housing-authority - starting"}
{"level":30,"time":1791844872536,"pid":76596,"hostname":"ABT-DESKTOP","contactsScanned":15,"pointerRows":0,"candidates":4,"apply":false,"msg":"backfill-join-housing-authority - candidates read"}
{"level":30,"time":1791844872538,"pid":76596,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-target-1","count":0,"msg":"audit history read"}
{"level":30,"time":1791844872538,"pid":76596,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-target-1","msg":"backfill-join-housing-authority - DRY RUN: would set the housing authority"}
{"level":30,"time":1791844872539,"pid":76596,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-skipme","count":0,"msg":"audit history read"}
{"level":30,"time":1791844872539,"pid":76596,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-skipme","msg":"backfill-join-housing-authority - DRY RUN: would set the housing authority"}
{"level":30,"time":1791844872541,"pid":76596,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-history","count":1,"msg":"audit history read"}
{"level":30,"time":1791844872543,"pid":76596,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-history","count":0,"msg":"audit history read"}
{"level":30,"time":1791844872543,"pid":76596,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-history","reason":"authority_history","msg":"backfill-join-housing-authority - left out"}
{"level":30,"time":1791844872544,"pid":76596,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-target-2","count":0,"msg":"audit history read"}
DRY RUN - nothing written. Leads that WOULD get "Atlanta Housing Authority" (oldest sign-up first; dates are UTC):
  Rehearsal Targetone  signed up 2026-06-14  status needs_review  contactId rehearsal-lead-target-1
  Rehearsal Skipme  signed up 2026-06-21  status needs_review  contactId rehearsal-lead-skipme
  Rehearsal Targettwo  signed up 2026-07-19  status on_hold  contactId rehearsal-lead-target-2
Would update: 3 lead(s). Failed: 0.
Left out (1 lead(s), oldest sign-up first):
  Rehearsal Clearedonce  signed up 2026-06-28  status needs_review  contactId rehearsal-lead-history  - its housing authority was set or removed before - left empty on purpose
{"level":30,"time":1791844872544,"pid":76596,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-target-2","msg":"backfill-join-housing-authority - DRY RUN: would set the housing authority"}
{"level":30,"time":1791844872544,"pid":76596,"hostname":"ABT-DESKTOP","candidates":4,"targets":3,"leftOut":1,"unknownSkips":0,"written":0,"skipped":0,"failed":0,"warnings":0,"apply":false,"msg":"backfill-join-housing-authority - done (DRY RUN - nothing written)"}
exit=0
```

## step6-apply

```text
$ L=$(node -p "require('./e2e/.artifacts/lane.json').lane") && [ "$L" -ge 1 ] && npx tsx app/scripts/backfill-join-housing-authority.ts --env local --lane "$L" --apply --skip "rehearsal-lead-skipme,rehearsal-no-such-lead"
{"level":30,"time":1791844880303,"pid":66520,"hostname":"ABT-DESKTOP","target":"local","endpoint":"DynamoDB Local http://localhost:8000 database hclane4 (e2e lane 4)","prefix":"hc-local-4-","apply":true,"skip":2,"msg":"backfill-join-housing-authority - starting"}
{"level":30,"time":1791844880331,"pid":66520,"hostname":"ABT-DESKTOP","contactsScanned":15,"pointerRows":0,"candidates":4,"apply":true,"msg":"backfill-join-housing-authority - candidates read"}
{"level":30,"time":1791844880333,"pid":66520,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-target-1","count":0,"msg":"audit history read"}
{"level":30,"time":1791844880335,"pid":66520,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-target-1","setFields":1,"removedFields":0,"msg":"contact updated"}
{"level":30,"time":1791844880337,"pid":66520,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-target-1","eventType":"housing_authority_backfill","msg":"audit event appended"}
{"level":30,"time":1791844880337,"pid":66520,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-target-1","msg":"backfill-join-housing-authority - housing authority set"}
{"level":30,"time":1791844880337,"pid":66520,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-skipme","reason":"skipped","msg":"backfill-join-housing-authority - left out"}
{"level":30,"time":1791844880339,"pid":66520,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-history","count":1,"msg":"audit history read"}
{"level":30,"time":1791844880340,"pid":66520,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-history","count":0,"msg":"audit history read"}
{"level":30,"time":1791844880340,"pid":66520,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-history","reason":"authority_history","msg":"backfill-join-housing-authority - left out"}
{"level":30,"time":1791844880342,"pid":66520,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-target-2","count":0,"msg":"audit history read"}
{"level":30,"time":1791844880343,"pid":66520,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-target-2","setFields":1,"removedFields":0,"msg":"contact updated"}
{"level":30,"time":1791844880345,"pid":66520,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-target-2","eventType":"housing_authority_backfill","msg":"audit event appended"}
{"level":30,"time":1791844880345,"pid":66520,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-target-2","msg":"backfill-join-housing-authority - housing authority set"}
{"level":30,"time":1791844880347,"pid":66520,"hostname":"ABT-DESKTOP","candidates":4,"targets":2,"leftOut":2,"unknownSkips":1,"written":2,"skipped":0,"failed":0,"warnings":0,"apply":true,"msg":"backfill-join-housing-authority - done"}
Leads given "Atlanta Housing Authority" (oldest sign-up first; dates are UTC):
  Rehearsal Targetone  signed up 2026-06-14  status needs_review  contactId rehearsal-lead-target-1
  Rehearsal Targettwo  signed up 2026-07-19  status on_hold  contactId rehearsal-lead-target-2
Written: 2. Skipped (changed after the read): 0. Failed: 0.
Left out (2 lead(s), oldest sign-up first):
  Rehearsal Skipme  signed up 2026-06-21  status needs_review  contactId rehearsal-lead-skipme  - named in --skip
  Rehearsal Clearedonce  signed up 2026-06-28  status needs_review  contactId rehearsal-lead-history  - its housing authority was set or removed before - left empty on purpose
--skip ids that are not candidates (ignored): rehearsal-no-such-lead
exit=0
```

## step7-rerun

```text
$ L=$(node -p "require('./e2e/.artifacts/lane.json').lane") && [ "$L" -ge 1 ] && npx tsx app/scripts/backfill-join-housing-authority.ts --env local --lane "$L" --skip "rehearsal-lead-skipme,rehearsal-no-such-lead"
{"level":30,"time":1791844887862,"pid":16876,"hostname":"ABT-DESKTOP","target":"local","endpoint":"DynamoDB Local http://localhost:8000 database hclane4 (e2e lane 4)","prefix":"hc-local-4-","apply":false,"skip":2,"msg":"backfill-join-housing-authority - starting"}
{"level":30,"time":1791844887890,"pid":16876,"hostname":"ABT-DESKTOP","contactsScanned":15,"pointerRows":0,"candidates":2,"apply":false,"msg":"backfill-join-housing-authority - candidates read"}
{"level":30,"time":1791844887890,"pid":16876,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-skipme","reason":"skipped","msg":"backfill-join-housing-authority - left out"}
{"level":30,"time":1791844887892,"pid":16876,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-history","count":1,"msg":"audit history read"}
{"level":30,"time":1791844887894,"pid":16876,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-history","count":0,"msg":"audit history read"}
DRY RUN - nothing written. Leads that WOULD get "Atlanta Housing Authority" (oldest sign-up first; dates are UTC):
  (none)
Would update: 0 lead(s). Failed: 0.
Left out (2 lead(s), oldest sign-up first):
  Rehearsal Skipme  signed up 2026-06-21  status needs_review  contactId rehearsal-lead-skipme  - named in --skip
  Rehearsal Clearedonce  signed up 2026-06-28  status needs_review  contactId rehearsal-lead-history  - its housing authority was set or removed before - left empty on purpose
--skip ids that are not candidates (ignored): rehearsal-no-such-lead
{"level":30,"time":1791844887894,"pid":16876,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-history","reason":"authority_history","msg":"backfill-join-housing-authority - left out"}
{"level":30,"time":1791844887894,"pid":16876,"hostname":"ABT-DESKTOP","candidates":2,"targets":0,"leftOut":2,"unknownSkips":1,"written":0,"skipped":0,"failed":0,"warnings":0,"apply":false,"msg":"backfill-join-housing-authority - done (DRY RUN - nothing written)"}
exit=0
```

## step7-usage

```text
$ npx tsx app/scripts/backfill-join-housing-authority.ts --env local --lane 0
Usage: npx tsx app/scripts/backfill-join-housing-authority.ts --env local|dev|prod [--lane <L>] [--apply] [--skip "<contactId>[,<contactId>...]"]
  DRY RUN by default; --apply writes. --skip leaves the named leads out (ONE comma-separated value - quote it).
  Unknown or repeated arguments and an empty --skip id are refused. --lane selects a hermetic e2e lane (local only).
exit=2
```

## step8-verify

```text
$ npx tsx .superpowers/sdd/rehearsal/seed-pre-change-leads.ts --verify
lane 4: DynamoDB Local http://localhost:8000 database hclane4 (e2e lane 4); app http://127.0.0.1:9401
rehearsal-lead-target-1  housingAuthority=Atlanta Housing Authority  status=needs_review  backfillEvents=1
rehearsal-lead-skipme  housingAuthority=(none)  status=needs_review  backfillEvents=0
rehearsal-lead-history  housingAuthority=(none)  status=needs_review  backfillEvents=0
rehearsal-lead-target-2  housingAuthority=Atlanta Housing Authority  status=on_hold  backfillEvents=1
rehearsal-lead-deleted  housingAuthority=(none)  status=needs_review  backfillEvents=0
/join sign-up +15550109010  contactId=contact-ec63d10f-5fb5-4805-b4af-161eb47703ad  housing_fair_signup_v2=true  housingAuthority=(none)  status=onboarding  capture_source=housing_fair
exit=0
```

## Step 9

`git status --short` printed nothing from this task. `npm run e2e:stop` (exit 0) then
printed `[e2e-stop] dropped lane 4 tables (hc-local-4-*)` - the rehearsal rows are gone
with the lane (build-research S5S6-F3).
