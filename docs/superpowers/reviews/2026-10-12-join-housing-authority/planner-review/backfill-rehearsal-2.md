# Backfill rehearsal 2 (planner fix wave 1) - hermetic lane 4

Run 2026-10-12 by the orchestrator on this worktree's own `npm run e2e:session` lane, booted
at 1c4252b2 (code identical to the fix-wave tip; later commits are records and one RUNBOOK
line). No Playwright spec and no reseed ran between Step 4 and Step 8. Every backfill command
read the lane from `e2e/.artifacts/lane.json` in the same Bash call. The throwaway seed
script (gitignored, `.superpowers/sdd/rehearsal/seed-pre-change-leads-v2.ts`) is plan Task
6.3a's script with its guards unchanged, plus one lead holding a PENDING housing authority
suggestion (`extractionRepo.putSuggestion`, value "Cobb County Housing Authority") and a
read-back of exclusion events and pending suggestions. This record supersedes plan Task 6.3a's
expected text, which describes the behavior before the fix wave (fw1-review F3).

## Expected (from the fix-wave rules) vs observed

| Step | Expected | Observed |
|---|---|---|
| 5 dry run, no --skip | targets Targetone, Skipme, Targettwo; left out Clearedonce (history) and Suggested (pending suggestion, value shown); exit 0 | as expected |
| 6a --apply with a typo id | REFUSED naming rehearsal-no-such-lead, nothing written, exit 1 | as expected; 6b then recorded the ONLY exclusion event (`exclusionsRecorded`: 1), so 6a recorded none |
| 6b --apply --skip skipme + the deleted lead | Written 2; Skipme "named in --skip" (exclusion recorded); the deleted id "not candidates (ignored)"; exit 0 | as expected |
| 7 dry run WITHOUT --skip | 0 targets; Skipme "excluded on an earlier run" | as expected |
| 7b --apply WITHOUT --skip | Written 0; Skipme still left out; no second exclusion | as expected (`exclusionsRecorded`: 0) |
| 7c --lane 0 | usage, exit 2 | as expected (the usage now names the remembered exclusions) |
| 7d dry run with only a typo id | reported on its own line, exit 0 | as expected |
| 8 read-back | targets hold Atlanta with 1 backfill event; Skipme no authority, 1 exclusion event; Suggested no authority, suggestion still pending; the post-change "Not sure" sign-up holds the marker, no authority, onboarding | as expected |

Result: no finding. Output below is VERBATIM (JSON info log lines included).

## lane.json excerpt (ownerToken omitted)

```text
{"lane":4,"launcherPid":64804,"urls":{"app":"http://127.0.0.1:9401","dashboard":"http://127.0.0.1:9411","fake":"http://127.0.0.1:9421","publicBase":"http://127.0.0.1:9431"},"tablePrefix":"hc-local-4-","accessKeyId":"hclane4"}
```

## step2-join

```text
$ curl -s -w "\nHTTP %{http_code}\n" -X POST "http://127.0.0.1:9411/public/housing-fair" -H "content-type: application/json" -d '{"firstName":"Rehearsal","lastName":"Notsure","phone":"+15550109010","smsConsent":true}'
{"ok":true}
HTTP 200
```

## step4-seed

```text
$ npx tsx .superpowers/sdd/rehearsal/seed-pre-change-leads-v2.ts
lane 4: DynamoDB Local http://localhost:8000 database hclane4 (e2e lane 4); app http://127.0.0.1:9401
created  rehearsal-lead-target-1 - expect TARGET
created  rehearsal-lead-skipme - expect TARGET in the first dry run; named in --skip in the apply; excluded on an earlier run afterwards, WITHOUT --skip
created  rehearsal-lead-history - expect LEFT OUT (its housing authority was set or removed before)
created  rehearsal-lead-target-2 - expect TARGET (status is not a condition; it stays on_hold)
created  rehearsal-lead-deleted - expect NOT A CANDIDATE (deleted): in neither list; as a --skip id: reported, ignored
created  rehearsal-lead-suggested - expect LEFT OUT (has a pending housing authority suggestion (Cobb County Housing Authority))
org-list item: stored
exit=0
```

## step5-dryrun

```text
$ L=$(node -p "require('./e2e/.artifacts/lane.json').lane") && [ "$L" -ge 1 ] && npx tsx app/scripts/backfill-join-housing-authority.ts --env local --lane "$L" 
{"level":30,"time":1791851785230,"pid":72396,"hostname":"ABT-DESKTOP","target":"local","endpoint":"DynamoDB Local http://localhost:8000 database hclane4 (e2e lane 4)","prefix":"hc-local-4-","apply":false,"skip":0,"msg":"backfill-join-housing-authority - starting"}
{"level":30,"time":1791851785257,"pid":72396,"hostname":"ABT-DESKTOP","contactsScanned":11,"pointerRows":0,"candidates":5,"apply":false,"msg":"backfill-join-housing-authority - candidates read"}
{"level":30,"time":1791851785259,"pid":72396,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-target-1","count":0,"msg":"audit history read"}
{"level":30,"time":1791851785260,"pid":72396,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-target-1","msg":"backfill-join-housing-authority - DRY RUN: would set the housing authority"}
{"level":30,"time":1791851785261,"pid":72396,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-skipme","count":0,"msg":"audit history read"}
{"level":30,"time":1791851785263,"pid":72396,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-skipme","msg":"backfill-join-housing-authority - DRY RUN: would set the housing authority"}
{"level":30,"time":1791851785264,"pid":72396,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-history","count":1,"msg":"audit history read"}
{"level":30,"time":1791851785265,"pid":72396,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-history","count":0,"msg":"audit history read"}
{"level":30,"time":1791851785265,"pid":72396,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-history","reason":"authority_history","msg":"backfill-join-housing-authority - left out"}
{"level":30,"time":1791851785267,"pid":72396,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-suggested","count":0,"msg":"audit history read"}
{"level":30,"time":1791851785268,"pid":72396,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-suggested","reason":"pending_suggestion","msg":"backfill-join-housing-authority - left out"}
{"level":30,"time":1791851785270,"pid":72396,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-target-2","count":0,"msg":"audit history read"}
{"level":30,"time":1791851785271,"pid":72396,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-target-2","msg":"backfill-join-housing-authority - DRY RUN: would set the housing authority"}
DRY RUN - nothing written. Leads that WOULD get "Atlanta Housing Authority" (oldest sign-up first; dates are UTC):
  Rehearsal Targetone  signed up 2026-06-14  status needs_review  contactId rehearsal-lead-target-1
  Rehearsal Skipme  signed up 2026-06-21  status needs_review  contactId rehearsal-lead-skipme
  Rehearsal Targettwo  signed up 2026-07-19  status on_hold  contactId rehearsal-lead-target-2
Would update: 3 lead(s). Failed: 0.
Left out (2 lead(s), oldest sign-up first):
  Rehearsal Clearedonce  signed up 2026-06-28  status needs_review  contactId rehearsal-lead-history  - its housing authority was set or removed before - left empty on purpose
  Rehearsal Suggested  signed up 2026-07-08  status needs_review  contactId rehearsal-lead-suggested  - has a pending housing authority suggestion (Cobb County Housing Authority) - accept or dismiss it first
{"level":30,"time":1791851785271,"pid":72396,"hostname":"ABT-DESKTOP","candidates":5,"targets":3,"leftOut":2,"unknownSkips":0,"missingSkips":0,"exclusionsRecorded":0,"written":0,"skipped":0,"failed":0,"warnings":0,"apply":false,"msg":"backfill-join-housing-authority - done (DRY RUN - nothing written)"}
exit=0
```

## step6a-apply-typo

```text
$ L=$(node -p "require('./e2e/.artifacts/lane.json').lane") && [ "$L" -ge 1 ] && npx tsx app/scripts/backfill-join-housing-authority.ts --env local --lane "$L" --apply --skip "rehearsal-lead-skipme,rehearsal-no-such-lead"
{"level":30,"time":1791851786388,"pid":25276,"hostname":"ABT-DESKTOP","target":"local","endpoint":"DynamoDB Local http://localhost:8000 database hclane4 (e2e lane 4)","prefix":"hc-local-4-","apply":true,"skip":2,"msg":"backfill-join-housing-authority - starting"}
{"level":30,"time":1791851786415,"pid":25276,"hostname":"ABT-DESKTOP","contactsScanned":11,"pointerRows":0,"candidates":5,"apply":true,"msg":"backfill-join-housing-authority - candidates read"}
backfill-join-housing-authority: REFUSED - these --skip ids name no contact on this environment (a typo?): rehearsal-no-such-lead. Correct or remove each one (a lead's contactId is the last item on its dry-run line), then re-run. Nothing was written.
exit=1
```

## step6b-apply

```text
$ L=$(node -p "require('./e2e/.artifacts/lane.json').lane") && [ "$L" -ge 1 ] && npx tsx app/scripts/backfill-join-housing-authority.ts --env local --lane "$L" --apply --skip "rehearsal-lead-skipme,rehearsal-lead-deleted"
{"level":30,"time":1791851795574,"pid":63668,"hostname":"ABT-DESKTOP","target":"local","endpoint":"DynamoDB Local http://localhost:8000 database hclane4 (e2e lane 4)","prefix":"hc-local-4-","apply":true,"skip":2,"msg":"backfill-join-housing-authority - starting"}
{"level":30,"time":1791851795601,"pid":63668,"hostname":"ABT-DESKTOP","contactsScanned":11,"pointerRows":0,"candidates":5,"apply":true,"msg":"backfill-join-housing-authority - candidates read"}
{"level":30,"time":1791851795603,"pid":63668,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-target-1","count":0,"msg":"audit history read"}
{"level":30,"time":1791851795607,"pid":63668,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-target-1","setFields":1,"removedFields":0,"msg":"contact updated"}
{"level":30,"time":1791851795609,"pid":63668,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-target-1","eventType":"housing_authority_backfill","msg":"audit event appended"}
{"level":30,"time":1791851795609,"pid":63668,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-target-1","msg":"backfill-join-housing-authority - housing authority set"}
{"level":30,"time":1791851795610,"pid":63668,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-skipme","count":0,"msg":"audit history read"}
{"level":30,"time":1791851795612,"pid":63668,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-skipme","eventType":"housing_authority_backfill_excluded","msg":"audit event appended"}
{"level":30,"time":1791851795612,"pid":63668,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-skipme","msg":"backfill-join-housing-authority - exclusion recorded (named in --skip): later runs leave it out"}
{"level":30,"time":1791851795612,"pid":63668,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-skipme","reason":"skipped","msg":"backfill-join-housing-authority - left out"}
{"level":30,"time":1791851795613,"pid":63668,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-history","count":1,"msg":"audit history read"}
{"level":30,"time":1791851795615,"pid":63668,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-history","count":0,"msg":"audit history read"}
{"level":30,"time":1791851795615,"pid":63668,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-history","reason":"authority_history","msg":"backfill-join-housing-authority - left out"}
{"level":30,"time":1791851795616,"pid":63668,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-suggested","count":0,"msg":"audit history read"}
{"level":30,"time":1791851795617,"pid":63668,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-suggested","reason":"pending_suggestion","msg":"backfill-join-housing-authority - left out"}
{"level":30,"time":1791851795618,"pid":63668,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-target-2","count":0,"msg":"audit history read"}
{"level":30,"time":1791851795621,"pid":63668,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-target-2","setFields":1,"removedFields":0,"msg":"contact updated"}
{"level":30,"time":1791851795622,"pid":63668,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-target-2","eventType":"housing_authority_backfill","msg":"audit event appended"}
{"level":30,"time":1791851795622,"pid":63668,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-target-2","msg":"backfill-join-housing-authority - housing authority set"}
{"level":30,"time":1791851795624,"pid":63668,"hostname":"ABT-DESKTOP","candidates":5,"targets":2,"leftOut":3,"unknownSkips":1,"missingSkips":0,"exclusionsRecorded":1,"written":2,"skipped":0,"failed":0,"warnings":0,"apply":true,"msg":"backfill-join-housing-authority - done"}
Leads given "Atlanta Housing Authority" (oldest sign-up first; dates are UTC):
  Rehearsal Targetone  signed up 2026-06-14  status needs_review  contactId rehearsal-lead-target-1
  Rehearsal Targettwo  signed up 2026-07-19  status on_hold  contactId rehearsal-lead-target-2
Written: 2. Skipped (changed after the read): 0. Failed: 0.
Left out (3 lead(s), oldest sign-up first):
  Rehearsal Skipme  signed up 2026-06-21  status needs_review  contactId rehearsal-lead-skipme  - named in --skip
  Rehearsal Clearedonce  signed up 2026-06-28  status needs_review  contactId rehearsal-lead-history  - its housing authority was set or removed before - left empty on purpose
  Rehearsal Suggested  signed up 2026-07-08  status needs_review  contactId rehearsal-lead-suggested  - has a pending housing authority suggestion (Cobb County Housing Authority) - accept or dismiss it first
--skip ids that are not candidates (ignored): rehearsal-lead-deleted
exit=0
```

## step7-dryrun-noskip

```text
$ L=$(node -p "require('./e2e/.artifacts/lane.json').lane") && [ "$L" -ge 1 ] && npx tsx app/scripts/backfill-join-housing-authority.ts --env local --lane "$L" 
{"level":30,"time":1791851796754,"pid":74436,"hostname":"ABT-DESKTOP","target":"local","endpoint":"DynamoDB Local http://localhost:8000 database hclane4 (e2e lane 4)","prefix":"hc-local-4-","apply":false,"skip":0,"msg":"backfill-join-housing-authority - starting"}
{"level":30,"time":1791851796781,"pid":74436,"hostname":"ABT-DESKTOP","contactsScanned":11,"pointerRows":0,"candidates":3,"apply":false,"msg":"backfill-join-housing-authority - candidates read"}
{"level":30,"time":1791851796784,"pid":74436,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-skipme","count":1,"msg":"audit history read"}
{"level":30,"time":1791851796786,"pid":74436,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-skipme","count":0,"msg":"audit history read"}
{"level":30,"time":1791851796786,"pid":74436,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-skipme","reason":"excluded_earlier","msg":"backfill-join-housing-authority - left out"}
{"level":30,"time":1791851796787,"pid":74436,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-history","count":1,"msg":"audit history read"}
{"level":30,"time":1791851796788,"pid":74436,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-history","count":0,"msg":"audit history read"}
{"level":30,"time":1791851796788,"pid":74436,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-history","reason":"authority_history","msg":"backfill-join-housing-authority - left out"}
{"level":30,"time":1791851796790,"pid":74436,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-suggested","count":0,"msg":"audit history read"}
{"level":30,"time":1791851796791,"pid":74436,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-suggested","reason":"pending_suggestion","msg":"backfill-join-housing-authority - left out"}
DRY RUN - nothing written. Leads that WOULD get "Atlanta Housing Authority" (oldest sign-up first; dates are UTC):
  (none)
Would update: 0 lead(s). Failed: 0.
Left out (3 lead(s), oldest sign-up first):
  Rehearsal Skipme  signed up 2026-06-21  status needs_review  contactId rehearsal-lead-skipme  - excluded on an earlier run
  Rehearsal Clearedonce  signed up 2026-06-28  status needs_review  contactId rehearsal-lead-history  - its housing authority was set or removed before - left empty on purpose
  Rehearsal Suggested  signed up 2026-07-08  status needs_review  contactId rehearsal-lead-suggested  - has a pending housing authority suggestion (Cobb County Housing Authority) - accept or dismiss it first
{"level":30,"time":1791851796791,"pid":74436,"hostname":"ABT-DESKTOP","candidates":3,"targets":0,"leftOut":3,"unknownSkips":0,"missingSkips":0,"exclusionsRecorded":0,"written":0,"skipped":0,"failed":0,"warnings":0,"apply":false,"msg":"backfill-join-housing-authority - done (DRY RUN - nothing written)"}
exit=0
```

## step7b-apply-noskip

```text
$ L=$(node -p "require('./e2e/.artifacts/lane.json').lane") && [ "$L" -ge 1 ] && npx tsx app/scripts/backfill-join-housing-authority.ts --env local --lane "$L" --apply
{"level":30,"time":1791851797939,"pid":63300,"hostname":"ABT-DESKTOP","target":"local","endpoint":"DynamoDB Local http://localhost:8000 database hclane4 (e2e lane 4)","prefix":"hc-local-4-","apply":true,"skip":0,"msg":"backfill-join-housing-authority - starting"}
{"level":30,"time":1791851797967,"pid":63300,"hostname":"ABT-DESKTOP","contactsScanned":11,"pointerRows":0,"candidates":3,"apply":true,"msg":"backfill-join-housing-authority - candidates read"}
{"level":30,"time":1791851797969,"pid":63300,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-skipme","count":1,"msg":"audit history read"}
{"level":30,"time":1791851797970,"pid":63300,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-skipme","count":0,"msg":"audit history read"}
{"level":30,"time":1791851797970,"pid":63300,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-skipme","reason":"excluded_earlier","msg":"backfill-join-housing-authority - left out"}
{"level":30,"time":1791851797972,"pid":63300,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-history","count":1,"msg":"audit history read"}
{"level":30,"time":1791851797973,"pid":63300,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-history","count":0,"msg":"audit history read"}
{"level":30,"time":1791851797973,"pid":63300,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-history","reason":"authority_history","msg":"backfill-join-housing-authority - left out"}
{"level":30,"time":1791851797974,"pid":63300,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-suggested","count":0,"msg":"audit history read"}
{"level":30,"time":1791851797976,"pid":63300,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-suggested","reason":"pending_suggestion","msg":"backfill-join-housing-authority - left out"}
Leads given "Atlanta Housing Authority" (oldest sign-up first; dates are UTC):
  (none)
Written: 0. Skipped (changed after the read): 0. Failed: 0.
Left out (3 lead(s), oldest sign-up first):
  Rehearsal Skipme  signed up 2026-06-21  status needs_review  contactId rehearsal-lead-skipme  - excluded on an earlier run
  Rehearsal Clearedonce  signed up 2026-06-28  status needs_review  contactId rehearsal-lead-history  - its housing authority was set or removed before - left empty on purpose
  Rehearsal Suggested  signed up 2026-07-08  status needs_review  contactId rehearsal-lead-suggested  - has a pending housing authority suggestion (Cobb County Housing Authority) - accept or dismiss it first
{"level":30,"time":1791851797976,"pid":63300,"hostname":"ABT-DESKTOP","candidates":3,"targets":0,"leftOut":3,"unknownSkips":0,"missingSkips":0,"exclusionsRecorded":0,"written":0,"skipped":0,"failed":0,"warnings":0,"apply":true,"msg":"backfill-join-housing-authority - done"}
exit=0
```

## step7c-usage

```text
$ npx tsx app/scripts/backfill-join-housing-authority.ts --env local --lane 0
Usage: npx tsx app/scripts/backfill-join-housing-authority.ts --env local|dev|prod [--lane <L>] [--apply] [--skip "<contactId>[,<contactId>...]"]
  DRY RUN by default; --apply writes. --skip leaves the named leads out (ONE comma-separated value - quote it);
  an --apply records each exclusion, so later runs leave those leads out too.
  Unknown or repeated arguments and an empty --skip id are refused. --lane selects a hermetic e2e lane (local only).
exit=2
```

## step7d-dryrun-typo

```text
$ L=$(node -p "require('./e2e/.artifacts/lane.json').lane") && [ "$L" -ge 1 ] && npx tsx app/scripts/backfill-join-housing-authority.ts --env local --lane "$L" --skip "rehearsal-no-such-lead"
{"level":30,"time":1791851809881,"pid":29108,"hostname":"ABT-DESKTOP","target":"local","endpoint":"DynamoDB Local http://localhost:8000 database hclane4 (e2e lane 4)","prefix":"hc-local-4-","apply":false,"skip":1,"msg":"backfill-join-housing-authority - starting"}
{"level":30,"time":1791851809909,"pid":29108,"hostname":"ABT-DESKTOP","contactsScanned":11,"pointerRows":0,"candidates":3,"apply":false,"msg":"backfill-join-housing-authority - candidates read"}
{"level":30,"time":1791851809911,"pid":29108,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-skipme","count":1,"msg":"audit history read"}
{"level":30,"time":1791851809912,"pid":29108,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-skipme","count":0,"msg":"audit history read"}
{"level":30,"time":1791851809912,"pid":29108,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-skipme","reason":"excluded_earlier","msg":"backfill-join-housing-authority - left out"}
{"level":30,"time":1791851809914,"pid":29108,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-history","count":1,"msg":"audit history read"}
{"level":30,"time":1791851809915,"pid":29108,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-history","count":0,"msg":"audit history read"}
{"level":30,"time":1791851809916,"pid":29108,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-history","reason":"authority_history","msg":"backfill-join-housing-authority - left out"}
{"level":30,"time":1791851809917,"pid":29108,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-suggested","count":0,"msg":"audit history read"}
{"level":30,"time":1791851809919,"pid":29108,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-suggested","reason":"pending_suggestion","msg":"backfill-join-housing-authority - left out"}
DRY RUN - nothing written. Leads that WOULD get "Atlanta Housing Authority" (oldest sign-up first; dates are UTC):
  (none)
Would update: 0 lead(s). Failed: 0.
Left out (3 lead(s), oldest sign-up first):
  Rehearsal Skipme  signed up 2026-06-21  status needs_review  contactId rehearsal-lead-skipme  - excluded on an earlier run
  Rehearsal Clearedonce  signed up 2026-06-28  status needs_review  contactId rehearsal-lead-history  - its housing authority was set or removed before - left empty on purpose
  Rehearsal Suggested  signed up 2026-07-08  status needs_review  contactId rehearsal-lead-suggested  - has a pending housing authority suggestion (Cobb County Housing Authority) - accept or dismiss it first
--skip id that names no contact (a typo?) - an --apply refuses to run with it: rehearsal-no-such-lead
{"level":30,"time":1791851809919,"pid":29108,"hostname":"ABT-DESKTOP","candidates":3,"targets":0,"leftOut":3,"unknownSkips":0,"missingSkips":1,"exclusionsRecorded":0,"written":0,"skipped":0,"failed":0,"warnings":0,"apply":false,"msg":"backfill-join-housing-authority - done (DRY RUN - nothing written)"}
exit=0
```

## step8-verify

```text
$ npx tsx .superpowers/sdd/rehearsal/seed-pre-change-leads-v2.ts --verify
lane 4: DynamoDB Local http://localhost:8000 database hclane4 (e2e lane 4); app http://127.0.0.1:9401
rehearsal-lead-target-1  housingAuthority=Atlanta Housing Authority  status=needs_review  backfillEvents=1  excludedEvents=0  pendingSuggestion=(none)
rehearsal-lead-skipme  housingAuthority=(none)  status=needs_review  backfillEvents=0  excludedEvents=1  pendingSuggestion=(none)
rehearsal-lead-history  housingAuthority=(none)  status=needs_review  backfillEvents=0  excludedEvents=0  pendingSuggestion=(none)
rehearsal-lead-target-2  housingAuthority=Atlanta Housing Authority  status=on_hold  backfillEvents=1  excludedEvents=0  pendingSuggestion=(none)
rehearsal-lead-deleted  housingAuthority=(none)  status=needs_review  backfillEvents=0  excludedEvents=0  pendingSuggestion=(none)
rehearsal-lead-suggested  housingAuthority=(none)  status=needs_review  backfillEvents=0  excludedEvents=0  pendingSuggestion=Cobb County Housing Authority
/join sign-up +15550109010  housing_fair_signup_v2=true  housingAuthority=(none)  status=onboarding  capture_source=housing_fair
exit=0
```

## Live Settings check of the D12 note (same lane, founder, Playwright MCP)

Settings > Housing authorities & agencies: "Add housing authority" opens "Is this really
new?" with the line "Housing authority names appear on the public sign-up form." once, and
the Name field's aria-describedby resolves to exactly that text; "Add agency" shows no line;
"Rename Atlanta Housing Authority" shows the line once, describing the New name field.
Screenshots (gitignored): `.playwright-mcp/fw1-d12-add-ha.png`, `fw1-d12-rename-ha.png`.

## Teardown

`npm run e2e:stop` exit 0: `[e2e-stop] dropped lane 4 tables (hc-local-4-*)`; no listener left
on the lane's ports; `git status --short` showed nothing from the rehearsal.
