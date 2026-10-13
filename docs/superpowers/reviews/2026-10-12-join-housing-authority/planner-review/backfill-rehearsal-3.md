# Backfill rehearsal 3 (planner fix wave 2, spec D10 revision 6) - hermetic lane 4

Run 2026-10-13 by a planner-dispatched agent on this worktree's own `npm run e2e:session`
lane, booted at 0690f26c (the branch tip; the lane app's `GET /__dev/ping` answered
`"lane":4`, `"tablePrefix":"hc-local-4-"`, `"twilioApiBaseUrlSet":true`,
`"appCommit":"0690f26c"`). The session was started in the background and the rehearsal began
only after the ASCII ready-line grep `\[e2e-session\] ready .*app :[0-9]+ ` matched (log line
132). No Playwright spec and no reseed ran between the seed and the last read-back. Every
backfill command read the lane from `e2e/.artifacts/lane.json` in the same Bash call and
refused a lane below 1; no command used `--env dev`, `--env prod` or a bare `--env local`, and
nothing touched :5174 / :8080. The shared DynamoDB Local container was only listed
(`docker ps`), never restarted.

The throwaway seed script (gitignored, `.superpowers/sdd/rehearsal/seed-pre-change-leads-v3.ts`)
is a copy of the v2 script with its four guards unchanged (lane.json + live launcher + lease;
prefix/key derived from L; the lane app's ping; `resolveStageClient('local', {}, { lane })`
re-checked), plus:
- `rehearsal-lead-dismissed`: a staff dismissal tombstone written with
  `extraction.putDismissal(contactId, 'housingAuthority', normalizeSuggestionValue('housingAuthority', 'Atlanta Housing Authority'))`
  (key `atlanta housing authority`; no pending suggestion);
- `rehearsal-lead-resolving`: a pending housingAuthority suggestion ("DeKalb Housing
  Authority") CLAIMED for a dismiss through the app's own `suggestionResolutionRepo.claim`
  (`app/src/repos/suggestionResolutionRepo.ts:702-797`: one transaction that puts the
  `resolve#<contactId>#housingAuthority` row with `state: 'active'`, `phase: 'claimed'`,
  `fence: 1`, the snapshot and the plan, and deletes the `sugg#` row), with the plan exactly as
  `suggestionResolution.ts` `buildPlan` builds a dismiss (`kind: 'dismiss'`, the normalized
  value, audit `ai_suggestion_dismissed`), and never completed - an accept or dismiss in flight;
- a read-back that also prints each lead's resolution record state and whether the Atlanta
  dismissal tombstone exists.

The worker's journal sweep ran once at boot during the rehearsal and visited 0 contacts (its
24-hour age gate, `JOURNAL_SWEEP_MIN_AGE_MS`), so the claimed record stayed active throughout -
every read-back shows `resolution=active` for `rehearsal-lead-resolving`.

## Seeded (lane 4 only)

| contactId | signed up (UTC) | purpose |
|---|---|---|
| rehearsal-lead-target-1 | 2026-06-14 | TARGET; signed up BEFORE the skipped lead, so oldest-first order alone would have written it before Skipme's exclusion (item 1) |
| rehearsal-lead-skipme | 2026-06-21 | named in `--skip` on the first apply; then left out WITHOUT `--skip` (item 4) |
| rehearsal-lead-history | 2026-06-28 | authority history (a `contact_updated` event naming housingAuthority) |
| rehearsal-lead-deleted | 2026-07-02 | deleted: not a candidate; as a `--skip` id reported and ignored |
| rehearsal-lead-suggested | 2026-07-08 | PENDING housingAuthority suggestion "Cobb County Housing Authority" (item 4) |
| rehearsal-lead-dismissed | 2026-07-10 | staff dismissal of "Atlanta Housing Authority" (item 2) |
| rehearsal-lead-resolving | 2026-07-12 | ACTIVE suggestion resolution record for housingAuthority (item 3) |
| rehearsal-lead-target-2 | 2026-07-19 | TARGET, status on_hold (status is not a condition) |
| (curl `/join`, +15550109010) | 2026-10-13 | post-change sign-up "Rehearsal Notsure": holds the `housing_fair_signup_v2` marker, no authority - in neither list |

## Items 1-4 (spec D10 revision 6): PASS / FAIL

| Item | Expected | Observed | Result |
|---|---|---|---|
| 1 exclusions first | on `--apply --skip`, every `exclusion recorded` line precedes every `housing authority set` line, though Targetone (2026-06-14) signed up before Skipme (2026-06-21) | step 6b: Skipme's `exclusion recorded` at time 1791901162153 is the third log line after `candidates read`; the first `housing authority set` (Targetone) follows at 1791901162167 and Targettwo's at 1791901162190. (Rehearsal 2, before FW2-1, logged Targetone's `housing authority set` BEFORE Skipme's exclusion.) | PASS |
| 2 dismissed Atlanta | left out: `staff dismissed an Atlanta Housing Authority suggestion` | steps 5, 6b, 7, 7b: `contactId rehearsal-lead-dismissed  - staff dismissed an Atlanta Housing Authority suggestion` (log reason `dismissed_atlanta`); never written (step 8: no authority, 0 backfill events) | PASS |
| 3 active resolution | left out: `a suggestion accept or dismiss is in progress - re-run after it finishes` | steps 5, 6b, 7, 7b: `contactId rehearsal-lead-resolving  - a suggestion accept or dismiss is in progress - re-run after it finishes` (log reason `resolution_in_progress`); never written | PASS |
| 4a excluded on an earlier run | Skipme left out WITHOUT `--skip` | steps 7 and 7b (no `--skip`): `contactId rehearsal-lead-skipme  - excluded on an earlier run` | PASS |
| 4b pending suggestion | left out | every run: `has a pending housing authority suggestion (Cobb County Housing Authority) - accept or dismiss it first` | PASS |
| 4c typo `--skip` refuses the apply | exit 1, nothing written | step 6a: `REFUSED - these --skip ids name no contact on this environment (a typo?): rehearsal-no-such-lead ... Nothing was written.`, `exit=1`; the read-back right after (6a2) is identical to the pre-run read-back (4b): no authority, 0 backfill and 0 excluded events anywhere | PASS |
| 4d a re-run writes nothing new | Written 0, no second exclusion | step 7b `--apply` without `--skip`: `Written: 0.`, done line `"exclusionsRecorded":0,"written":0`; step 8: each target 1 backfill event, Skipme 1 excluded event | PASS |

Result: no finding. Every report line matched the expected text. Output below is VERBATIM
(JSON info log lines included).

## Expected vs observed, step by step

| Step | Expected | Observed |
|---|---|---|
| 2 `/join` sign-up (curl via the lane dashboard) | `{"ok":true}`, HTTP 200 | as expected |
| 4 seed | 8 leads created, the dismissal key and the claim (`claimed`, state active) printed, org list stored, exit 0 | as expected |
| 4b read-back before any run | nothing backfilled; Suggested pending; Dismissed tombstone yes; Resolving resolution active, no pending suggestion | as expected |
| 5 dry run, no `--skip` | targets Targetone, Skipme, Targettwo; left out Clearedonce, Suggested, Dismissed, Resolving with their reasons; exit 0 | as expected (7 candidates) |
| 6a `--apply` with a typo id | REFUSED, exit 1 | as expected |
| 6a2 read-back | identical to 4b | as expected |
| 6b `--apply --skip` Skipme + the deleted lead | exclusion recorded first; Written 2; five left out; the deleted id "not candidates (ignored)"; exit 0 | as expected (`exclusionsRecorded`: 1) |
| 7 dry run WITHOUT `--skip` | 0 targets; Skipme "excluded on an earlier run"; the other four unchanged | as expected |
| 7b `--apply` WITHOUT `--skip` | Written 0; no new exclusion | as expected (`exclusionsRecorded`: 0) |
| 8 read-back | targets Atlanta with 1 backfill event each; Skipme 1 excluded event; the rest untouched; the marker sign-up onboarding with no authority | as expected |

## lane.json excerpt (ownerToken omitted)

```text
{"lane":4,"launcherPid":34144,"urls":{"app":"http://127.0.0.1:9401","dashboard":"http://127.0.0.1:9411","fake":"http://127.0.0.1:9421","publicBase":"http://127.0.0.1:9431"},"tablePrefix":"hc-local-4-","accessKeyId":"hclane4"}
```

## Session ready line (`.superpowers/sdd/e2e-session-rehearsal-3.log`, captured verbatim)

```text
132:[e2e-session] ready — app :9401 (http://127.0.0.1:9401), web :9411 (http://127.0.0.1:9411), fake-twilio :9421 (http://127.0.0.1:9421), MinIO :9000 (MESSAGING_DRIVER=twilio → fake)
```

## step2-join

```text
$ curl -s -w "\nHTTP %{http_code}\n" -X POST "http://127.0.0.1:9411/public/housing-fair" -H "content-type: application/json" -d '{"firstName":"Rehearsal","lastName":"Notsure","phone":"+15550109010","smsConsent":true}'
{"ok":true}
HTTP 200
exit=0
```

## step4-seed

```text
$ npx tsx .superpowers/sdd/rehearsal/seed-pre-change-leads-v3.ts
lane 4: DynamoDB Local http://localhost:8000 database hclane4 (e2e lane 4); app http://127.0.0.1:9401
created  rehearsal-lead-target-1 - expect TARGET
created  rehearsal-lead-skipme - expect TARGET in the first dry run; named in --skip in the apply; excluded on an earlier run afterwards, WITHOUT --skip
created  rehearsal-lead-history - expect LEFT OUT (its housing authority was set or removed before)
created  rehearsal-lead-target-2 - expect TARGET (status is not a condition; it stays on_hold)
created  rehearsal-lead-deleted - expect NOT A CANDIDATE (deleted): in neither list; as a --skip id: reported, ignored
created  rehearsal-lead-suggested - expect LEFT OUT (has a pending housing authority suggestion (Cobb County Housing Authority))
         rehearsal-lead-dismissed: dismissal tombstone housingAuthority key "atlanta housing authority"
created  rehearsal-lead-dismissed - expect LEFT OUT (staff dismissed an Atlanta Housing Authority suggestion)
         rehearsal-lead-resolving: claim claimed - resolve# row state=active action=dismiss phase=claimed (never completed)
created  rehearsal-lead-resolving - expect LEFT OUT (a suggestion accept or dismiss is in progress - re-run after it finishes)
org-list item: stored
exit=0
```

## step4b-verify-seeded

```text
$ npx tsx .superpowers/sdd/rehearsal/seed-pre-change-leads-v3.ts --verify
lane 4: DynamoDB Local http://localhost:8000 database hclane4 (e2e lane 4); app http://127.0.0.1:9401
rehearsal-lead-target-1  housingAuthority=(none)  status=needs_review  backfillEvents=0  excludedEvents=0  pendingSuggestion=(none)  resolution=(none)  atlantaDismissal=no
rehearsal-lead-skipme  housingAuthority=(none)  status=needs_review  backfillEvents=0  excludedEvents=0  pendingSuggestion=(none)  resolution=(none)  atlantaDismissal=no
rehearsal-lead-history  housingAuthority=(none)  status=needs_review  backfillEvents=0  excludedEvents=0  pendingSuggestion=(none)  resolution=(none)  atlantaDismissal=no
rehearsal-lead-target-2  housingAuthority=(none)  status=on_hold  backfillEvents=0  excludedEvents=0  pendingSuggestion=(none)  resolution=(none)  atlantaDismissal=no
rehearsal-lead-deleted  housingAuthority=(none)  status=needs_review  backfillEvents=0  excludedEvents=0  pendingSuggestion=(none)  resolution=(none)  atlantaDismissal=no
rehearsal-lead-suggested  housingAuthority=(none)  status=needs_review  backfillEvents=0  excludedEvents=0  pendingSuggestion=Cobb County Housing Authority  resolution=(none)  atlantaDismissal=no
rehearsal-lead-dismissed  housingAuthority=(none)  status=needs_review  backfillEvents=0  excludedEvents=0  pendingSuggestion=(none)  resolution=(none)  atlantaDismissal=yes
rehearsal-lead-resolving  housingAuthority=(none)  status=needs_review  backfillEvents=0  excludedEvents=0  pendingSuggestion=(none)  resolution=active  atlantaDismissal=no
/join sign-up +15550109010  housing_fair_signup_v2=true  housingAuthority=(none)  status=onboarding  capture_source=housing_fair
exit=0
```

## step5-dryrun

```text
$ L=$(node -p "require('./e2e/.artifacts/lane.json').lane") && [ "$L" -ge 1 ] && npx tsx app/scripts/backfill-join-housing-authority.ts --env local --lane "$L"
{"level":30,"time":1791901145633,"pid":61468,"hostname":"ABT-DESKTOP","target":"local","endpoint":"DynamoDB Local http://localhost:8000 database hclane4 (e2e lane 4)","prefix":"hc-local-4-","apply":false,"skip":0,"msg":"backfill-join-housing-authority - starting"}
{"level":30,"time":1791901145662,"pid":61468,"hostname":"ABT-DESKTOP","contactsScanned":13,"pointerRows":0,"candidates":7,"apply":false,"msg":"backfill-join-housing-authority - candidates read"}
{"level":30,"time":1791901145664,"pid":61468,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-target-1","count":0,"msg":"audit history read"}
{"level":30,"time":1791901145673,"pid":61468,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-target-1","msg":"backfill-join-housing-authority - DRY RUN: would set the housing authority"}
{"level":30,"time":1791901145674,"pid":61468,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-skipme","count":0,"msg":"audit history read"}
{"level":30,"time":1791901145681,"pid":61468,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-skipme","msg":"backfill-join-housing-authority - DRY RUN: would set the housing authority"}
{"level":30,"time":1791901145682,"pid":61468,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-history","count":1,"msg":"audit history read"}
{"level":30,"time":1791901145684,"pid":61468,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-history","count":0,"msg":"audit history read"}
{"level":30,"time":1791901145684,"pid":61468,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-history","reason":"authority_history","msg":"backfill-join-housing-authority - left out"}
{"level":30,"time":1791901145685,"pid":61468,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-suggested","count":0,"msg":"audit history read"}
{"level":30,"time":1791901145686,"pid":61468,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-suggested","reason":"pending_suggestion","msg":"backfill-join-housing-authority - left out"}
{"level":30,"time":1791901145688,"pid":61468,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-dismissed","count":0,"msg":"audit history read"}
{"level":30,"time":1791901145691,"pid":61468,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-dismissed","reason":"dismissed_atlanta","msg":"backfill-join-housing-authority - left out"}
{"level":30,"time":1791901145692,"pid":61468,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-resolving","count":0,"msg":"audit history read"}
{"level":30,"time":1791901145693,"pid":61468,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-resolving","reason":"resolution_in_progress","msg":"backfill-join-housing-authority - left out"}
{"level":30,"time":1791901145694,"pid":61468,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-target-2","count":0,"msg":"audit history read"}
{"level":30,"time":1791901145701,"pid":61468,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-target-2","msg":"backfill-join-housing-authority - DRY RUN: would set the housing authority"}
DRY RUN - nothing written. Leads that WOULD get "Atlanta Housing Authority" (oldest sign-up first; dates are UTC):
  Rehearsal Targetone  signed up 2026-06-14  status needs_review  contactId rehearsal-lead-target-1
  Rehearsal Skipme  signed up 2026-06-21  status needs_review  contactId rehearsal-lead-skipme
  Rehearsal Targettwo  signed up 2026-07-19  status on_hold  contactId rehearsal-lead-target-2
Would update: 3 lead(s). Failed: 0.
Left out (4 lead(s), oldest sign-up first):
  Rehearsal Clearedonce  signed up 2026-06-28  status needs_review  contactId rehearsal-lead-history  - its housing authority was set or removed before - left empty on purpose
  Rehearsal Suggested  signed up 2026-07-08  status needs_review  contactId rehearsal-lead-suggested  - has a pending housing authority suggestion (Cobb County Housing Authority) - accept or dismiss it first
  Rehearsal Dismissed  signed up 2026-07-10  status needs_review  contactId rehearsal-lead-dismissed  - staff dismissed an Atlanta Housing Authority suggestion
  Rehearsal Resolving  signed up 2026-07-12  status needs_review  contactId rehearsal-lead-resolving  - a suggestion accept or dismiss is in progress - re-run after it finishes
{"level":30,"time":1791901145701,"pid":61468,"hostname":"ABT-DESKTOP","candidates":7,"targets":3,"leftOut":4,"unknownSkips":0,"missingSkips":0,"exclusionsRecorded":0,"written":0,"skipped":0,"failed":0,"warnings":0,"apply":false,"msg":"backfill-join-housing-authority - done (DRY RUN - nothing written)"}
exit=0
```

## step6a-apply-typo

```text
$ L=$(node -p "require('./e2e/.artifacts/lane.json').lane") && [ "$L" -ge 1 ] && npx tsx app/scripts/backfill-join-housing-authority.ts --env local --lane "$L" --apply --skip "rehearsal-lead-skipme,rehearsal-no-such-lead"
{"level":30,"time":1791901151663,"pid":18840,"hostname":"ABT-DESKTOP","target":"local","endpoint":"DynamoDB Local http://localhost:8000 database hclane4 (e2e lane 4)","prefix":"hc-local-4-","apply":true,"skip":2,"msg":"backfill-join-housing-authority - starting"}
{"level":30,"time":1791901151691,"pid":18840,"hostname":"ABT-DESKTOP","contactsScanned":13,"pointerRows":0,"candidates":7,"apply":true,"msg":"backfill-join-housing-authority - candidates read"}
backfill-join-housing-authority: REFUSED - these --skip ids name no contact on this environment (a typo?): rehearsal-no-such-lead. Correct or remove each one (a lead's contactId is the last item on its dry-run line), then re-run. Nothing was written.
exit=1
```

## step6a2-verify-after-refusal

```text
$ npx tsx .superpowers/sdd/rehearsal/seed-pre-change-leads-v3.ts --verify
lane 4: DynamoDB Local http://localhost:8000 database hclane4 (e2e lane 4); app http://127.0.0.1:9401
rehearsal-lead-target-1  housingAuthority=(none)  status=needs_review  backfillEvents=0  excludedEvents=0  pendingSuggestion=(none)  resolution=(none)  atlantaDismissal=no
rehearsal-lead-skipme  housingAuthority=(none)  status=needs_review  backfillEvents=0  excludedEvents=0  pendingSuggestion=(none)  resolution=(none)  atlantaDismissal=no
rehearsal-lead-history  housingAuthority=(none)  status=needs_review  backfillEvents=0  excludedEvents=0  pendingSuggestion=(none)  resolution=(none)  atlantaDismissal=no
rehearsal-lead-target-2  housingAuthority=(none)  status=on_hold  backfillEvents=0  excludedEvents=0  pendingSuggestion=(none)  resolution=(none)  atlantaDismissal=no
rehearsal-lead-deleted  housingAuthority=(none)  status=needs_review  backfillEvents=0  excludedEvents=0  pendingSuggestion=(none)  resolution=(none)  atlantaDismissal=no
rehearsal-lead-suggested  housingAuthority=(none)  status=needs_review  backfillEvents=0  excludedEvents=0  pendingSuggestion=Cobb County Housing Authority  resolution=(none)  atlantaDismissal=no
rehearsal-lead-dismissed  housingAuthority=(none)  status=needs_review  backfillEvents=0  excludedEvents=0  pendingSuggestion=(none)  resolution=(none)  atlantaDismissal=yes
rehearsal-lead-resolving  housingAuthority=(none)  status=needs_review  backfillEvents=0  excludedEvents=0  pendingSuggestion=(none)  resolution=active  atlantaDismissal=no
/join sign-up +15550109010  housing_fair_signup_v2=true  housingAuthority=(none)  status=onboarding  capture_source=housing_fair
exit=0
```

## step6b-apply

```text
$ L=$(node -p "require('./e2e/.artifacts/lane.json').lane") && [ "$L" -ge 1 ] && npx tsx app/scripts/backfill-join-housing-authority.ts --env local --lane "$L" --apply --skip "rehearsal-lead-skipme,rehearsal-lead-deleted"
{"level":30,"time":1791901162121,"pid":72748,"hostname":"ABT-DESKTOP","target":"local","endpoint":"DynamoDB Local http://localhost:8000 database hclane4 (e2e lane 4)","prefix":"hc-local-4-","apply":true,"skip":2,"msg":"backfill-join-housing-authority - starting"}
{"level":30,"time":1791901162149,"pid":72748,"hostname":"ABT-DESKTOP","contactsScanned":13,"pointerRows":0,"candidates":7,"apply":true,"msg":"backfill-join-housing-authority - candidates read"}
{"level":30,"time":1791901162151,"pid":72748,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-skipme","count":0,"msg":"audit history read"}
{"level":30,"time":1791901162153,"pid":72748,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-skipme","eventType":"housing_authority_backfill_excluded","msg":"audit event appended"}
{"level":30,"time":1791901162153,"pid":72748,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-skipme","msg":"backfill-join-housing-authority - exclusion recorded (named in --skip): later runs leave it out"}
{"level":30,"time":1791901162155,"pid":72748,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-target-1","count":0,"msg":"audit history read"}
{"level":30,"time":1791901162166,"pid":72748,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-target-1","setFields":1,"removedFields":0,"msg":"contact updated"}
{"level":30,"time":1791901162167,"pid":72748,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-target-1","eventType":"housing_authority_backfill","msg":"audit event appended"}
{"level":30,"time":1791901162167,"pid":72748,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-target-1","msg":"backfill-join-housing-authority - housing authority set"}
{"level":30,"time":1791901162167,"pid":72748,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-skipme","reason":"skipped","msg":"backfill-join-housing-authority - left out"}
{"level":30,"time":1791901162169,"pid":72748,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-history","count":1,"msg":"audit history read"}
{"level":30,"time":1791901162170,"pid":72748,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-history","count":0,"msg":"audit history read"}
{"level":30,"time":1791901162170,"pid":72748,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-history","reason":"authority_history","msg":"backfill-join-housing-authority - left out"}
{"level":30,"time":1791901162171,"pid":72748,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-suggested","count":0,"msg":"audit history read"}
{"level":30,"time":1791901162174,"pid":72748,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-suggested","reason":"pending_suggestion","msg":"backfill-join-housing-authority - left out"}
{"level":30,"time":1791901162175,"pid":72748,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-dismissed","count":0,"msg":"audit history read"}
{"level":30,"time":1791901162178,"pid":72748,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-dismissed","reason":"dismissed_atlanta","msg":"backfill-join-housing-authority - left out"}
{"level":30,"time":1791901162179,"pid":72748,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-resolving","count":0,"msg":"audit history read"}
{"level":30,"time":1791901162180,"pid":72748,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-resolving","reason":"resolution_in_progress","msg":"backfill-join-housing-authority - left out"}
{"level":30,"time":1791901162181,"pid":72748,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-target-2","count":0,"msg":"audit history read"}
{"level":30,"time":1791901162189,"pid":72748,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-target-2","setFields":1,"removedFields":0,"msg":"contact updated"}
{"level":30,"time":1791901162190,"pid":72748,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-target-2","eventType":"housing_authority_backfill","msg":"audit event appended"}
{"level":30,"time":1791901162190,"pid":72748,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-target-2","msg":"backfill-join-housing-authority - housing authority set"}
{"level":30,"time":1791901162192,"pid":72748,"hostname":"ABT-DESKTOP","candidates":7,"targets":2,"leftOut":5,"unknownSkips":1,"missingSkips":0,"exclusionsRecorded":1,"written":2,"skipped":0,"failed":0,"warnings":0,"apply":true,"msg":"backfill-join-housing-authority - done"}
Leads given "Atlanta Housing Authority" (oldest sign-up first; dates are UTC):
  Rehearsal Targetone  signed up 2026-06-14  status needs_review  contactId rehearsal-lead-target-1
  Rehearsal Targettwo  signed up 2026-07-19  status on_hold  contactId rehearsal-lead-target-2
Written: 2. Skipped (changed after the read): 0. Failed: 0.
Left out (5 lead(s), oldest sign-up first):
  Rehearsal Skipme  signed up 2026-06-21  status needs_review  contactId rehearsal-lead-skipme  - named in --skip
  Rehearsal Clearedonce  signed up 2026-06-28  status needs_review  contactId rehearsal-lead-history  - its housing authority was set or removed before - left empty on purpose
  Rehearsal Suggested  signed up 2026-07-08  status needs_review  contactId rehearsal-lead-suggested  - has a pending housing authority suggestion (Cobb County Housing Authority) - accept or dismiss it first
  Rehearsal Dismissed  signed up 2026-07-10  status needs_review  contactId rehearsal-lead-dismissed  - staff dismissed an Atlanta Housing Authority suggestion
  Rehearsal Resolving  signed up 2026-07-12  status needs_review  contactId rehearsal-lead-resolving  - a suggestion accept or dismiss is in progress - re-run after it finishes
--skip ids that are not candidates (ignored): rehearsal-lead-deleted
exit=0
```

## step7-dryrun-noskip

```text
$ L=$(node -p "require('./e2e/.artifacts/lane.json').lane") && [ "$L" -ge 1 ] && npx tsx app/scripts/backfill-join-housing-authority.ts --env local --lane "$L"
{"level":30,"time":1791901167894,"pid":16364,"hostname":"ABT-DESKTOP","target":"local","endpoint":"DynamoDB Local http://localhost:8000 database hclane4 (e2e lane 4)","prefix":"hc-local-4-","apply":false,"skip":0,"msg":"backfill-join-housing-authority - starting"}
{"level":30,"time":1791901167924,"pid":16364,"hostname":"ABT-DESKTOP","contactsScanned":13,"pointerRows":0,"candidates":5,"apply":false,"msg":"backfill-join-housing-authority - candidates read"}
{"level":30,"time":1791901167926,"pid":16364,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-skipme","count":1,"msg":"audit history read"}
{"level":30,"time":1791901167927,"pid":16364,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-skipme","count":0,"msg":"audit history read"}
{"level":30,"time":1791901167927,"pid":16364,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-skipme","reason":"excluded_earlier","msg":"backfill-join-housing-authority - left out"}
{"level":30,"time":1791901167929,"pid":16364,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-history","count":1,"msg":"audit history read"}
{"level":30,"time":1791901167930,"pid":16364,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-history","count":0,"msg":"audit history read"}
{"level":30,"time":1791901167930,"pid":16364,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-history","reason":"authority_history","msg":"backfill-join-housing-authority - left out"}
{"level":30,"time":1791901167931,"pid":16364,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-suggested","count":0,"msg":"audit history read"}
{"level":30,"time":1791901167934,"pid":16364,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-suggested","reason":"pending_suggestion","msg":"backfill-join-housing-authority - left out"}
{"level":30,"time":1791901167935,"pid":16364,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-dismissed","count":0,"msg":"audit history read"}
{"level":30,"time":1791901167939,"pid":16364,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-dismissed","reason":"dismissed_atlanta","msg":"backfill-join-housing-authority - left out"}
{"level":30,"time":1791901167940,"pid":16364,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-resolving","count":0,"msg":"audit history read"}
{"level":30,"time":1791901167941,"pid":16364,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-resolving","reason":"resolution_in_progress","msg":"backfill-join-housing-authority - left out"}
DRY RUN - nothing written. Leads that WOULD get "Atlanta Housing Authority" (oldest sign-up first; dates are UTC):
  (none)
Would update: 0 lead(s). Failed: 0.
Left out (5 lead(s), oldest sign-up first):
  Rehearsal Skipme  signed up 2026-06-21  status needs_review  contactId rehearsal-lead-skipme  - excluded on an earlier run
  Rehearsal Clearedonce  signed up 2026-06-28  status needs_review  contactId rehearsal-lead-history  - its housing authority was set or removed before - left empty on purpose
  Rehearsal Suggested  signed up 2026-07-08  status needs_review  contactId rehearsal-lead-suggested  - has a pending housing authority suggestion (Cobb County Housing Authority) - accept or dismiss it first
  Rehearsal Dismissed  signed up 2026-07-10  status needs_review  contactId rehearsal-lead-dismissed  - staff dismissed an Atlanta Housing Authority suggestion
  Rehearsal Resolving  signed up 2026-07-12  status needs_review  contactId rehearsal-lead-resolving  - a suggestion accept or dismiss is in progress - re-run after it finishes
{"level":30,"time":1791901167941,"pid":16364,"hostname":"ABT-DESKTOP","candidates":5,"targets":0,"leftOut":5,"unknownSkips":0,"missingSkips":0,"exclusionsRecorded":0,"written":0,"skipped":0,"failed":0,"warnings":0,"apply":false,"msg":"backfill-join-housing-authority - done (DRY RUN - nothing written)"}
exit=0
```

## step7b-apply-noskip

```text
$ L=$(node -p "require('./e2e/.artifacts/lane.json').lane") && [ "$L" -ge 1 ] && npx tsx app/scripts/backfill-join-housing-authority.ts --env local --lane "$L" --apply
{"level":30,"time":1791901172927,"pid":61588,"hostname":"ABT-DESKTOP","target":"local","endpoint":"DynamoDB Local http://localhost:8000 database hclane4 (e2e lane 4)","prefix":"hc-local-4-","apply":true,"skip":0,"msg":"backfill-join-housing-authority - starting"}
{"level":30,"time":1791901172954,"pid":61588,"hostname":"ABT-DESKTOP","contactsScanned":13,"pointerRows":0,"candidates":5,"apply":true,"msg":"backfill-join-housing-authority - candidates read"}
{"level":30,"time":1791901172956,"pid":61588,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-skipme","count":1,"msg":"audit history read"}
{"level":30,"time":1791901172958,"pid":61588,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-skipme","count":0,"msg":"audit history read"}
{"level":30,"time":1791901172958,"pid":61588,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-skipme","reason":"excluded_earlier","msg":"backfill-join-housing-authority - left out"}
{"level":30,"time":1791901172960,"pid":61588,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-history","count":1,"msg":"audit history read"}
{"level":30,"time":1791901172961,"pid":61588,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-history","count":0,"msg":"audit history read"}
{"level":30,"time":1791901172961,"pid":61588,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-history","reason":"authority_history","msg":"backfill-join-housing-authority - left out"}
{"level":30,"time":1791901172962,"pid":61588,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-suggested","count":0,"msg":"audit history read"}
{"level":30,"time":1791901172965,"pid":61588,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-suggested","reason":"pending_suggestion","msg":"backfill-join-housing-authority - left out"}
{"level":30,"time":1791901172966,"pid":61588,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-dismissed","count":0,"msg":"audit history read"}
{"level":30,"time":1791901172970,"pid":61588,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-dismissed","reason":"dismissed_atlanta","msg":"backfill-join-housing-authority - left out"}
{"level":30,"time":1791901172971,"pid":61588,"hostname":"ABT-DESKTOP","entityKey":"contacts#rehearsal-lead-resolving","count":0,"msg":"audit history read"}
{"level":30,"time":1791901172972,"pid":61588,"hostname":"ABT-DESKTOP","contactId":"rehearsal-lead-resolving","reason":"resolution_in_progress","msg":"backfill-join-housing-authority - left out"}
Leads given "Atlanta Housing Authority" (oldest sign-up first; dates are UTC):
  (none)
Written: 0. Skipped (changed after the read): 0. Failed: 0.
Left out (5 lead(s), oldest sign-up first):
  Rehearsal Skipme  signed up 2026-06-21  status needs_review  contactId rehearsal-lead-skipme  - excluded on an earlier run
  Rehearsal Clearedonce  signed up 2026-06-28  status needs_review  contactId rehearsal-lead-history  - its housing authority was set or removed before - left empty on purpose
  Rehearsal Suggested  signed up 2026-07-08  status needs_review  contactId rehearsal-lead-suggested  - has a pending housing authority suggestion (Cobb County Housing Authority) - accept or dismiss it first
  Rehearsal Dismissed  signed up 2026-07-10  status needs_review  contactId rehearsal-lead-dismissed  - staff dismissed an Atlanta Housing Authority suggestion
  Rehearsal Resolving  signed up 2026-07-12  status needs_review  contactId rehearsal-lead-resolving  - a suggestion accept or dismiss is in progress - re-run after it finishes
{"level":30,"time":1791901172972,"pid":61588,"hostname":"ABT-DESKTOP","candidates":5,"targets":0,"leftOut":5,"unknownSkips":0,"missingSkips":0,"exclusionsRecorded":0,"written":0,"skipped":0,"failed":0,"warnings":0,"apply":true,"msg":"backfill-join-housing-authority - done"}
exit=0
```

## step8-verify

```text
$ npx tsx .superpowers/sdd/rehearsal/seed-pre-change-leads-v3.ts --verify
lane 4: DynamoDB Local http://localhost:8000 database hclane4 (e2e lane 4); app http://127.0.0.1:9401
rehearsal-lead-target-1  housingAuthority=Atlanta Housing Authority  status=needs_review  backfillEvents=1  excludedEvents=0  pendingSuggestion=(none)  resolution=(none)  atlantaDismissal=no
rehearsal-lead-skipme  housingAuthority=(none)  status=needs_review  backfillEvents=0  excludedEvents=1  pendingSuggestion=(none)  resolution=(none)  atlantaDismissal=no
rehearsal-lead-history  housingAuthority=(none)  status=needs_review  backfillEvents=0  excludedEvents=0  pendingSuggestion=(none)  resolution=(none)  atlantaDismissal=no
rehearsal-lead-target-2  housingAuthority=Atlanta Housing Authority  status=on_hold  backfillEvents=1  excludedEvents=0  pendingSuggestion=(none)  resolution=(none)  atlantaDismissal=no
rehearsal-lead-deleted  housingAuthority=(none)  status=needs_review  backfillEvents=0  excludedEvents=0  pendingSuggestion=(none)  resolution=(none)  atlantaDismissal=no
rehearsal-lead-suggested  housingAuthority=(none)  status=needs_review  backfillEvents=0  excludedEvents=0  pendingSuggestion=Cobb County Housing Authority  resolution=(none)  atlantaDismissal=no
rehearsal-lead-dismissed  housingAuthority=(none)  status=needs_review  backfillEvents=0  excludedEvents=0  pendingSuggestion=(none)  resolution=(none)  atlantaDismissal=yes
rehearsal-lead-resolving  housingAuthority=(none)  status=needs_review  backfillEvents=0  excludedEvents=0  pendingSuggestion=(none)  resolution=active  atlantaDismissal=no
/join sign-up +15550109010  housing_fair_signup_v2=true  housingAuthority=(none)  status=onboarding  capture_source=housing_fair
exit=0
```

## Teardown

```text
$ npm run e2e:stop

> housingchoice@0.1.0 e2e:stop
> node scripts/e2e-stop.mjs

[e2e-stop] stopped session launcher 34144 (+ children)
[e2e-stop] dropped lane 4 tables (hc-local-4-*)
[e2e-stop] released lane 4 lease
[e2e-stop] stale owned session state cleanup complete
exit=0
```

After the stop: no listener on ports 9400-9439 (`netstat -ano` showed 0 LISTEN lines), no
`lane.json` or `session.pid` left under `e2e/.artifacts/`, and both shared containers
(`hc-dynamodb-local`, `hc-s3-local`) still up and untouched. The background `npm run
e2e:session` task ended with exit 1 when `e2e:stop` killed its tree - the expected end of a
stopped session, not a failure. The rehearsal rows went with the dropped lane 4 tables.
`git status --short` showed nothing from the rehearsal (the seed script and the captures in
`.superpowers/sdd/rehearsal/v3/` are gitignored).
