# R1 adversarial code review - feat/join-housing-authority

Reviewer: adversarial, plan-blind (charter `.superpowers/review/adversarial-charter.md`).
Scope: feature commits vs merge base main @5c0d3f6a (docs/superpowers excluded), plus every
other reader/writer of the state the diff touches. Nothing under docs/superpowers/ was read.

Environment note: the run1 e2e suite was still running in this worktree for the whole review
(`.superpowers/sdd/gates/run1-e2e.exit` never appeared), so NO existing file was edited and no
mutation check was run. Every reproduction below is a throwaway `app/test/zz-review-*.test.ts`
file, run alone with `npx vitest run test/<file>`, and deleted afterwards.

## Findings (most severe first)

### R1-ADV-1 - HIGH - CONFIRMED (pre-existing defect the new D2 limit is built on)

**Where:** `app/src/middleware/rateLimit.ts:67-74` (`clientIpOf`), used as the default key by
the new list limiter `app/src/routes/public.ts:494` and by the shared /public limiter
`app/src/app.ts:185-190`. Header comment `rateLimit.ts:29-33` and `app.ts:172` ("per-IP").

**What is wrong:** the limiter key is the FIRST `X-Forwarded-For` entry. CloudFront APPENDS the
viewer IP to any `X-Forwarded-For` the viewer sent (the origin request policy here is
`all_viewer_except_host`, `infra/modules/cloudfront/main.tf:158-168`, and there is no
CloudFront Function or WAF in front), so at the origin the header reads
`<anything the client sent>, <real viewer IP>`. The first entry is chosen by the client. The
comment even says "CloudFront appends the viewer IP" and then takes the other end. The app's
own request logger already labels the header `xffTrust: 'untrusted-until-validated'`
(`app/src/middleware/requestLogger.ts:41`).

Consequences:
- The new "60 reads per minute per IP" on `GET /public/housing-authorities` (D2) is not a
  limit: each request with a fresh fake first hop gets a fresh bucket, and each costs one
  strongly consistent GetItem of the whole org-list item (`publicOrgList.ts:27-31`).
- Much worse and pre-existing: the shared /public limiter (`PUBLIC_RATE_LIMIT_MAX`, default 5
  per minute) is the documented SMS-spend fence on `POST /public/housing-fair`
  (`public.ts` header "Money note"). One client can sign up unlimited arbitrary phones, each
  getting a welcome SMS from the business number (spend, and carrier/A2P complaint risk on
  the campaign).

**Evidence** (`app/test/zz-review-xff.test.ts`, default key resolver, no test seam):

```
stdout | ... one real viewer (CloudFront appends 9.9.9.9) rotating its own XFF prefix is never limited
200 reads from ONE true viewer (9.9.9.9): 0 refused with 429
stdout | ... PUBLIC_RATE_LIMIT_MAX=5: one true viewer sends 20 sign-ups (20 phones) with a rotating XFF prefix -> 20 welcome texts
20 sign-ups from ONE true viewer: 0 refused; welcome texts sent: 20
 Test Files  2 passed (2)   Tests  6 passed (6)
```
(control in the same file: the same viewer with no spoofed prefix is refused at read 61.)

**Fix:** key on the LAST `X-Forwarded-For` entry (the hop CloudFront appended; the origin is
reachable only through CloudFront because of the origin-secret check), or on
`CloudFront-Viewer-Address` added to the origin request policy. Add a `clientIpOf` test with a
multi-entry header. This touches a shared file, so it is arguably its own change: at minimum
file it in `docs/issues/` and correct the "per-IP" claims in the new comments/RUNBOOK until
it lands.

### R1-ADV-2 - MEDIUM - PLAUSIBLE (consequence in files the diff never touched)

**Where:** backfill write `app/scripts/backfill-join-housing-authority.ts:491-501`; extraction
prompt `app/src/services/extraction/prompt.ts:33-39` with the CURRENT PROFILE built from the
stored value `app/src/jobs/extraction.ts:154-155`; importer fill-only write
`app/src/lib/import/apply.ts:1150-1152`.

**What is wrong:** the backfill writes a GUESS ("Atlanta Housing Authority" for every pre-change
lead with none) that is stored exactly like an asserted value: no `housingAuthority_source`
(the only provenance the UI shows is the AI AutoBadge), and the only trace is a
`housing_authority_backfill` audit event that no route or UI reads. Two other writers then
treat the guess as the truth:
- AI extraction is told to WRITE only when the field is empty and to SUGGEST when the
  conversation "genuinely CONFLICTS with the current value". A lead who later texts "I have a
  DeKalb voucher" no longer gets the authority filled in; it becomes a pending suggestion that
  a staff member must accept - for exactly the leads whose authority was unknown.
- A re-run of `import:apply` writes `housingAuthority = if_not_exists(...)`, so a real
  authority from the reviewed workbook can never replace the backfilled guess (and the
  importer reports nothing about it).
The /join default (Atlanta preselected, D8) has the same shape for new leads who leave the
select alone, but that is at least a visible answer on the form.

**Evidence:** reasoned from the cited lines (LLM op choice not reproducible offline). The
prompt text: op "write" = "the field is empty, OR ... the SAME fact in a better form"; op
"suggest" = "the information genuinely CONFLICTS with the current value".

**Fix:** stamp provenance on the backfill write (for example
`housingAuthority_source: { source: 'backfill', at }`) and treat a `backfill` source as empty
for the extraction write rule and the importer's fill rule; or, at minimum, say in the
RUNBOOK section that a backfilled lead's later-stated authority arrives as a suggestion, so
the operator weighs that before `--apply`.

### R1-ADV-3 - MEDIUM - CONFIRMED (no reader exists)

**Where:** `app/src/routes/public.ts:325-327` (existing contact: D6 writes nothing),
`public.ts:417-424` (the answer goes only into the `housing_fair_signup` audit payload);
backfill report `app/scripts/backfill-join-housing-authority.ts:214, 261`.

**What is wrong:** when an existing phone signs up on /join and picks an authority, the answer
is recorded ONLY in `audit_events` (`payload.housingAuthority`). Nothing reads a `contacts#`
audit partition except this backfill: `listByEntity` callers are `units#`, `placements#`,
`tours#` and aiRuns only (`routes/units.ts:1320`, `routes/statusTransition.ts:232`,
`routes/tours.ts:603`, `routes/contactTimeline.ts:1435`), and `housing_fair_signup` is
rendered nowhere (grep of app/src and dashboard/src). So:
- a pre-change lead who answers "DeKalb" after the deploy is left out by the backfill
  (`signed_up_again`) and keeps NO authority - and the backfill report, which has just read
  that history, prints only the reason, not the answer;
- a lead backfilled to Atlanta who later answers "DeKalb" on /join keeps Atlanta, silently.
The RUNBOOK's "its answer to the new question is kept in its audit history and is not
overridden" is true but unreachable by any staff screen.

**Fix:** cheapest - in the backfill report, append the latest v2 `housingAuthority` to each
`signed_up_again` line (the events are already in hand in `leftOutReasonFor`), so the
operator can set it by hand. Better - surface `housing_fair_signup` (with its authority) in
the contact's activity/timeline, or record a pending AI-style suggestion for an existing
contact instead of discarding the answer.

### R1-ADV-4 - LOW - CONFIRMED

**Where:** `app/scripts/backfill-join-housing-authority.ts:230-236` (`leadLine`), printed at
`:250` and `:261`; names come from the unauthenticated sign-up, which only trims and
length-checks them (`app/src/routes/public.ts:133-140`).

**What is wrong:** first/last names are printed raw into the operator report that the RUNBOOK
makes the decision aid for `--skip` ("copy their contactId (the last item on the line)").
A name containing a newline forges report lines (including a `contactId` the run never
read); an ESC sequence reaches the operator's terminal raw (line erase / cursor moves can
hide or rewrite lines). Only pre-change leads are candidates, so the attacker had to sign up
before the deploy - hence LOW.

**Evidence** (`app/test/zz-review-report.test.ts`):
```
"  Mallory"
"  Real Person  signed up 2026-06-01  status needs_review  contactId contact-FORGED X  signed up 2026-06-02  status needs_review  contactId contact-real"
"  \u001b[2K\rEve Y  signed up 2026-06-03  status needs_review  contactId contact-esc"
...
{"firstName":"Mallory\n  forged line","lastName":"\u001b[2KX"}   <- POST /public/housing-fair stored it as-is (200)
```

**Fix:** render names with control characters escaped (for example `JSON.stringify(name)` or
strip `[\u0000-\u001f\u007f-\u009f]`) in `leadLine`. Separately (pre-existing) consider
refusing control characters in `parseHousingFairBody` names.

### R1-ADV-5 - LOW - CONFIRMED (interleaving reproduced with fakes)

**Where:** `app/scripts/backfill-join-housing-authority.ts:466` (history read) then `:491-501`
(the conditional write); `app/src/repos/auditRepo.ts:122-139` (the Query is eventually
consistent - no `ConsistentRead`).

**What is wrong:** the "signed up again after the change" exclusion is decided on a history
read, but the write's condition (no authority, tenant, not deleted) cannot see a re-sign-up,
because D6 writes nothing to an existing contact. Interleaving:
1. backfill `leftOutReasonFor` reads `contacts#c` history: no v2 event (`:466`);
2. the same phone posts /join choosing DeKalb: `public.ts:325-327` takes the existing-contact
   path (no contact write), `public.ts:417` appends `housing_fair_signup {signupVersion: 2,
   housingAuthority: 'DeKalb ...'}`;
3. backfill `contacts.update(... expect housingAuthority absent, type tenant, notDeleted)`
   (`:491`) - every guard holds - writes Atlanta.
The eventually consistent Query widens step 1's window slightly.

**Evidence** (`app/test/zz-review-race.test.ts`):
```
{"written":1,"leadAuthority":"Atlanta Housing Authority","events":["housing_fair_signup","housing_authority_backfill"]}
```

**Fix:** after an apply, re-read each written lead's history (ConsistentRead) and print a
WARNING naming any lead that gained a v2 sign-up during the run; or accept and document the
window in the RUNBOOK (seconds at today's volume).

### R1-ADV-6 - LOW - INFO (new public exposure, no staff-facing notice)

**Where:** `app/src/services/publicOrgList.ts:41-50`, served unauthenticated by
`app/src/routes/public.ts:489-500`.

**What is wrong:** every `housing_authority` entry is now published on the public /join page
the moment it is added. Entries can be added by any staff user from free text (Settings
"Add", the edit form's "Add as new", an accepted AI suggestion of an unknown authority taken
from a call transcript). No Settings or dialog copy says the list is public
(`dashboard/src/routes/orgs/*` has no such text), so a typo, a test entry or a misheard name
goes live on the public form instantly and becomes a selectable "answer".

**Fix:** a one-line note on the housing authority side of Settings / NewOrgDialog ("shown on
the public /join form"), or a per-entry "offer on /join" flag defaulting off for entries
added from free text.

### R1-ADV-7 - INFO

- A list read that fails or times out and an explicit "Not sure" are recorded identically
  (no authority, `housing_fair_signup_v2`, audit `housingAuthority: null`), and the backfill
  never touches either. Only the first sign-up after a failure is affected ("Sign up another
  person" re-reads after a failure), and the code comment owns the marker meaning; noted so
  the RUNBOOK line "a lead who answered 'Not sure' ... is never touched" is not read as
  "every such lead chose Not sure".
- A pre-change lead who re-signs up via a FLYER (no select shown) is also `signed_up_again`
  and never gets an authority although it never answered (erring safe, documented in the
  code; the RUNBOOK wording "its answer to the new question" does not fit that case).
- At a housing fair on venue Wi-Fi (one NAT IP), the pre-existing shared limit of 5
  sign-ups per minute per IP will bite long before the new 60 list reads; the new 429 copy
  helps, but staff-run fairs on one network are the D5 use case (and see ADV-1: the "IP" is
  currently whatever the client says).

## Checked and found sound

- Mount order (`app.ts:178-190`): the list router only matches `GET|HEAD
  /public/housing-authorities`; every other /public request (including `POST` on the list
  path) falls through to the shared limiter unchanged (an `OPTIONS` on the list path is
  answered by Express's automatic Allow response, with no list read); the route stays behind
  the origin-secret validator and body parsers (locked middleware order intact); Express 5
  forwards the async handler's rejection to the generic 500. CloudFront `/public/*` already
  allows the method with CachingDisabled; `EDGE_MUTATING_PREFIXES` unchanged.
- `loadPublicOrgEntries` never writes (peek, else starting list in memory); GET and POST
  share one source and one exact-name rule (`isOnListFor` with
  `KINDS_FOR_FIELD.housingAuthority`), so every served name is accepted; agencies, ids,
  spellings, notes, lastRewrite never leave.
- `parseHousingFairBody`: housingAuthority shape (string 1..120 after the app-wide trim),
  absent/null = none, unitId + authority refused before any unit read (no existence
  oracle), consent gate still first; list check before any contact/unit read or write;
  authority stored only on a create with no unitId; marker on every create; the existing
  contact path writes nothing new (D6).
- Status change to `onboarding`: swept every reader of `onboarding`/`needs_review`
  (statusModel, unknownQueue, contacts create/PATCH, extraction statusAdvance,
  audienceResolution - no status filter, missedCallAutoText - names suppress it, import
  status, dashboard ContactEditForm/ContactsList/StatusBadge); nothing keyed on fair leads
  being `needs_review`; no `status_source` stamped, matching the manual create.
- `housing_fair_signup_v2` and the new audit payload keys: no other reader or copier
  (grep across app/src, app/scripts, dashboard/src, e2e, scripts).
- Backfill: candidate rule matches the only writer of `capture_source: 'housing_fair'`;
  pointer rows skipped; the conditional write uses the real repo's `expect` semantics
  (`value: null` -> `attribute_not_exists`, `contactsRepo.ts:1550-1564`) plus `notDeleted`;
  audit paging is exclusive on a unique `ts#suffix` SK so no event is skipped at a page
  edge, and a non-advancing page throws; `touchesHousingAuthority` matches every current
  writer's payload (staff PATCH `fields` only when changed - verified in ContactEditForm
  `:391`; caseworker conversion; extraction `fields[].field`; suggestion journal `target`;
  orgRecords/clean-org-names `field`); the importer's fill-only write produces no candidate;
  refusals happen before any contact read; dry run writes nothing; exit codes; stage client
  refuses `--lane` off local, ambient endpoints and the wrong account; the stage client is
  destroyed in `finally`.
- Concurrency walked: org-list rename between the sign-up's list check and its create (a
  record can land with the old name; recoverable under "Not on the list", same window as
  the staff PATCH path); backfill vs staff edit (edit form sends the field only when
  changed, so no clobber); backfill vs extraction (unconditional AI write wins, both
  audited); backfill vs rename (caught by the post-apply WARNING).
- Dashboard: effect/StrictMode/abort/timeout interleavings in `HousingFairIntake.tsx`
  (each run owns its controller and timer; a cleaned-up or timed-out read is ignored on both
  callbacks; an abort during body parse turns into an `invalid_response` rejection, still
  ignored); the not-listed recovery keeps typed fields and blocks send until a choice;
  "Sign up another person" re-reads only after a failure; `authorityToSend` never sends a
  placeholder; option values cannot collide with stored (trimmed, non-empty) names; the
  flyer's IntakeForm renders and behaves as before with none of the new props.
- Tests: the backfill suite runs on real DynamoDB Local repos (no fake divergence); the
  list fake mirrors peek/get; full-app tests pin the mount order and both limits. No
  test-quality gap found that justified a mutation run (none possible while e2e ran).
- Added lines are ASCII-only.
