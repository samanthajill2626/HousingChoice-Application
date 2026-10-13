# Adversarial review - feat/join-housing-authority (diff main...15c1676f)

Reviewer: plan-blind adversarial reviewer (diff + repo only; no spec, plan or
review notes read). Read-only: no suite, script, database or network touched.
Every claim cites a file:line that was read. Paths are relative to
W:\tmp\join-housing-authority.

Verdict: nothing found that must block the merge on correctness or security
grounds. Five MEDIUM findings concern data quality on the public surface and
the operator backfill, and seven are LOW. Things checked and found sound are
listed at the end, so the next reader does not re-check them.

---

## 1. [MEDIUM] A /join answer from any EXISTING phone is thrown away, and the backfill then skips exactly those leads

What is wrong. When the phone already belongs to a contact, the sign-up writes
nothing to it except the welcome flag. The housing authority the person just
chose goes only into the audit payload, and no staff screen reads contact audit
events. The backfill then puts every pre-change lead with such an event in "Left
out" (`signed_up_again`). So the people who answered the new question are the
only pre-change leads who end up with NO authority, while leads who never came
back get Atlanta Housing Authority.

Evidence.
- app/src/routes/public.ts:327-330: the existing-contact branch only reads
  contactId and the welcome flag. Line 350 writes `housingAuthority` on the
  create branch only.
- app/src/routes/public.ts:420-427: the answer is recorded as
  `housingAuthority: housingAuthority ?? null` in the `housing_fair_signup`
  audit payload.
- app/src/routes/contactTimeline.ts:1435, units.ts:1320, tours.ts:603,
  statusTransition.ts:232 are the only `audit.listByEntity` readers in app/src.
  None reads `contacts#...`, so the answer is unreachable from the dashboard.
- app/scripts/backfill-join-housing-authority.ts:154-160: any
  `housing_fair_signup` event with `signupVersion === 2` leaves the lead out,
  whatever authority it carried.

Failure scenario. An imported tenant, or someone who texted the business number
before a fair, signs up at the fair and picks "DeKalb County Housing Authority".
Nothing is stored on the contact, and the operator's backfill report lists them
as "signed up again after the change". They stay without an authority, so every
authority-filtered property blast misses them. Before the fair, the same people
were at least as reachable as any other lead. Fairs are where returning people
are most likely, so this is not a corner case.

Suggested fix. Do not let an anonymous request write an existing record. Turn
the answer into a pending staff suggestion instead: extractionRepo.putSuggestion
with target `housingAuthority` (app/src/repos/extractionRepo.ts:568). The
existing accept path then checks it against the list
(app/src/services/suggestionResolution.ts:328-350). In the backfill, print the
v2 event's `housingAuthority` on the left-out line, so the operator can set it
by hand.

## 2. [MEDIUM] The preselected default is stored as if the person chose it, with no provenance, and carries over to the next person

What is wrong. The select starts on Atlanta Housing Authority whenever that name
is listed. "Sign up another person" keeps the previous person's choice. The
server stores whatever was sent, exactly like a deliberate choice: no `_source`
stamp and no "defaulted" bit. Downstream, an untouched default cannot be told
apart from a real answer. It also changes how the AI treats the field: the AI
WRITES an authority only into an EMPTY field, and only SUGGESTS when the field
holds a conflicting value. So a defaulted AHA turns a later "I have a DCA
voucher" from an automatic correction into a suggestion that waits in the staff
queue.

Evidence.
- dashboard/src/routes/public/HousingAuthoritySelect.tsx:29 and :46-48 set the
  default to Atlanta Housing Authority when it is listed.
- dashboard/src/routes/public/HousingFairIntake.tsx:106 applies the default on
  load. :148-153 keeps the choice for the next person.
- app/src/routes/public.ts:350 stores `housingAuthority` with no provenance
  field.
- app/src/services/extraction/prompt.ts:35-39: "write" is for an empty field or
  the same fact in a better form, "suggest" when it CONFLICTS with the current
  value. app/src/services/extraction/apply.ts:299-345: a suggestion is never
  written until staff accept it.

Failure scenario. A DCA voucher holder at a fair skips the select. They are
stored as Atlanta Housing Authority and receive AHA-filtered blasts for homes
their voucher cannot be used on. When they text their real authority, it only
becomes a suggestion, and AHA blasts keep reaching them until someone accepts
it. With "Sign up another person", a staffer's DeKalb pick for one family is
silently recorded for the next family too.

Suggested fix. Record whether the value was the untouched default. For example,
have the client send `housingAuthorityDefaulted: true` and the server store a
`housingAuthority_source` saying so; the AI prompt can then treat a defaulted
value as overwritable. Or start the select on "Choose one" and require a pick
(the code already handles a blocked send, HousingFairIntake.tsx:172). Resetting
the select on "Sign up another person" is the same one-line choice.

## 3. [MEDIUM] Unauthenticated sign-ups now skip the Needs review front door and default into the AHA-filtered blast audience

What is wrong. A /join sign-up (no unitId) is now created at `onboarding` and,
because of finding 2, normally holds Atlanta Housing Authority. Nothing
separates a vetted, staff-entered onboarding tenant from an anonymous web form
submission whose consent is only claimed by the client. The AHA-filtered blast
audience is read from the byHousingAuthority index with no status condition, so
every default-left public sign-up is in it straight away. Before this change,
public sign-ups held no authority and were reached by unfiltered blasts only.
The volume is attacker-controlled: the per-IP sign-up limit keys on the first
X-Forwarded-For entry, which the client chooses (rateLimit.ts:67-74, already
filed as public-rate-limit-key-spoofable-xff).

Evidence.
- app/src/routes/public.ts:342: `status: unitId === undefined ? 'onboarding' : 'needs_review'`.
- app/src/services/audienceResolution.ts:118-150: the authority branch queries
  listByHousingAuthority and filters only type, opt-out, unreachable, phone and
  bedroom size; status is never checked.
- app/src/services/extraction/apply.ts:535: the AI status-advance suggestion now
  fires for these contacts (onboarding tenants only).
- documentation/STATUS-MODEL.md (this diff) records the front-door change.

Failure scenario. A script submits a few hundred real phone numbers through
/join, spoofing XFF. Each number gets the welcome text (as before) and now also
lands in the main AHA blast audience as an onboarding tenant. The next property
blast texts all of them from the business number, which is a carrier/A2P
complaint risk and a direct cost. Staff can no longer find "sign-ups nobody has
looked at" by status.

Suggested fix. Either keep public sign-ups at `needs_review` (staff vet them,
and the AI status advance stays off until then), or make the authority-filtered
audience skip `needs_review`. In both cases, land the XFF key fix before or with
this change, because it is what bounds the volume.

## 4. [MEDIUM] Backfill: the operator's --skip decision is not persisted, and a typo in it is ignored on --apply

What is wrong. A lead the operator excluded stays a candidate forever. The
exclusion lives only in the command line, so any later run without the exact
same --skip value gives that lead Atlanta Housing Authority. The RUNBOOK
expects later runs: step 4 says to apply again for SKIPPED or FAILED leads. A
--skip id that names no candidate (a typo included) is listed as "ignored", and
the apply goes ahead and writes the lead the operator meant to protect.

Evidence.
- app/scripts/backfill-join-housing-authority.ts:104-112: isCandidate consults
  only the stored contact.
- :493-501: --skip is the only exclusion, read from the CLI.
- :604: unknown skip ids are collected for the report.
- :296-298: they are printed "(ignored)" and nothing refuses.
- RUNBOOK.md (this diff), step 2: "Keep that --skip value for every later run
  on that environment: a skipped lead stays a candidate, so a run without it
  gives that lead Atlanta Housing Authority". Step 4: "apply again
  (idempotent)".

Failure scenario. Weeks after the prod run, the operator re-runs --apply from a
fresh shell to retry one FAILED lead, without the --skip value. Every DeKalb and
DCA holder they deliberately excluded now holds Atlanta Housing Authority, and
the run reports it as normal "Written". Or a single mistyped character in the
prod --skip value does the same to one person.

Suggested fix. On --apply, record each skipped candidate durably, for example
with a `housing_authority_backfill_excluded` audit event that
leftOutReasonFromAudit treats as a reason (the same mechanism as
BACKFILL_AUDIT_TYPE at :140-141). Refuse --apply when a --skip id names no
contact at all. Keep reporting, without refusing, an id that exists but is no
longer a candidate.

## 5. [MEDIUM] Backfill overrides a known better answer: a pending housingAuthority suggestion

What is wrong. A lead with no stored authority can still have a pending AI
suggestion for one. Extraction turns a not-on-the-list authority into a
suggestion even when the field is empty, and an inferred-role write becomes a
suggestion too. The backfill reads only the contact and its audit history,
never the suggestions. It writes Atlanta Housing Authority over a lead whose
real authority is waiting in the staff queue, and the dry-run report gives the
operator no hint.

Evidence.
- app/src/services/extraction/apply.ts:286-296 marks `notOnList`, and :299 / :316-345
  route the value to a suggestion on an empty field.
- app/scripts/backfill-join-housing-authority.ts:493-501 decides only from
  --skip and the audit history.
- app/src/repos/extractionRepo.ts:698 (getSuggestion(contactId, target)) and
  :710 (listSuggestionsByContact) are the cheap reads it does not make.

Failure scenario. A lead texted "my voucher is with Cobb County". The AI could
not match that to a list entry, so it queued a suggestion. The backfill stamps
AHA. Until staff resolve the suggestion, the lead is in AHA blasts and out of
the blasts it should be in.

Suggested fix. Read getSuggestion(contactId, 'housingAuthority') next to the
history. When one is pending, leave the lead out with a new reason
(`pending_suggestion`) and show the suggested text on the report line.

## 6. [LOW] The /join default is the hard-coded string "Atlanta Housing Authority"; a routine Settings rename silently turns it off

What is wrong. The default and the backfill both match the literal name.
Renaming an entry is a first-class Settings action (orgRewrite rename). Renaming
Atlanta Housing Authority, for example to its legal name "Housing Authority of
the City of Atlanta" (already one of its spellings,
app/src/lib/orgStartingList.ts), makes every later /join sign-up default to "Not
sure", which records no authority. Nothing on the Settings page warns about it.

Evidence.
- dashboard/src/routes/public/HousingAuthoritySelect.tsx:29 and :46-48.
- app/scripts/backfill-join-housing-authority.ts:79 and :376-382: the backfill
  refuses on the same rename, which at least is loud.

Failure scenario. Staff tidy the name. From then on the public form quietly
stops collecting the default, and no one notices until blasts under-reach.

Suggested fix. Have GET /public/housing-authorities return the default (chosen
by orgId or a flag on the entry) instead of the client hard-coding the name. At
minimum, have the rename confirmation in Settings mention /join.

## 7. [LOW] Each anonymous list read is an uncached, strongly consistent read of the whole org-list item; the per-IP key is spoofable

What is wrong. Every GET /public/housing-authorities does one ConsistentRead
GetItem of the whole org-list item; the item may grow to 300 KB
(ORG_LIST_MAX_BYTES). The 60/min limit keys on the first X-Forwarded-For entry,
which the client controls. One client can therefore drive unbounded strongly
consistent reads at a single hot item in the settings table, the table that
also serves org settings and the welcome text. The flyer GET already gives
anonymous callers a per-request read, so this is not a new class of exposure,
but this read is on a single hot key and is consistent (twice the cost).

Evidence.
- app/src/services/publicOrgList.ts:24-31 (peek per call).
- app/src/repos/orgListRepo.ts:161-162 (`ConsistentRead: true`).
- app/src/routes/public.ts:495-502 (one read per request, no cache).
- app/src/middleware/rateLimit.ts:67-74 (first XFF entry).

Failure scenario. A flood of spoofed-XFF list reads saturates the item's
partition, and org-list and settings reads start throttling, including the
POST list check (a 500 on every sign-up that sends an authority).

Suggested fix. Serve the GET from a short in-process cache (10-30 s) and/or an
eventually consistent read. A slightly stale dropdown is already handled by the
housing_authority_not_listed recovery. Keep the POST check fresh. Land the XFF
fix.

## 8. [LOW] A sign-up racing a rename or merge can store the old name after the rewrite pass has gone by

What is wrong. The list check runs before the unit read, the dedupe read and the
create. A rename commits the list change first and the record pass second. A
sign-up checked against the old list whose create lands after the pass has
scanned the contacts keeps the old name, which then shows under "Not on the
list". Staff writes have the same window, so this is a narrow, known class, not
a new mechanism.

Evidence. app/src/routes/public.ts:296-302 (the check) vs :340-371 (the create);
app/src/services/orgRewrite.ts:5-12 (the order).

Suggested fix. Accept and document it, or re-check the list after the create and
log a warning when the name has left it.

## 9. [LOW] Backfill: the write and its audit event are separate, and "FAILED - nothing written" can be false

What is wrong. writeOne updates the contact, then appends the audit event in a
second call. The repo already has an atomic path for exactly this (auditRepo
transactPut, documented "for a caller that must land its own change and the
audit event ATOMICALLY"). If the process is killed between the two calls, the
lead holds the authority with no backfill event and no warning, and a re-run no
longer sees it as a candidate. A non-conditional error such as a timeout after
the write landed is reported as "FAILED: nothing written".

Evidence.
- app/scripts/backfill-join-housing-authority.ts:522-556.
- app/src/repos/auditRepo.ts:64-78.
- :222 and :541-543 (the "nothing written" text).

Suggested fix. Use one TransactWriteItems: the conditional contact Update plus
auditRepo.transactPut. On a non-conditional error, say "outcome unknown -
re-run the dry run".

## 10. [LOW] Every staff-added housing authority name is now published to anonymous viewers

What is wrong. The public list returns every housing_authority entry's name.
Entries can be added from record text in Settings ("Not on the list" > Add,
orgRewrite resolveNotOnList action 'add'), and that text can come from tenant
conversations or imports. Nothing tells staff that adding a housing authority
puts it on the public /join page.

Evidence. app/src/services/publicOrgList.ts:40-50; app/src/routes/public.ts:495-502;
app/src/services/orgRewrite.ts:106-109 and :452.

Suggested fix. A one-line note on the Settings add and rename forms ("housing
authority names appear on the public sign-up form"), or a per-entry public flag.

## 11. [LOW] The new "Sign up another person" batch flow runs into the shared 5-per-minute per-IP sign-up limit at a venue

What is wrong. /join is now built for staff signing people up back to back at a
fair. The shared /public limit defaults to 5 requests per minute per IP, and
every device behind the venue's single NAT address shares it. A
housing_authority_not_listed retry costs another request.

Evidence. app/src/lib/config.ts:1008 (default 5);
dashboard/src/routes/public/HousingFairIntake.tsx:148-153 and :54-55 (the new
429 copy shows the case was expected).

Failure scenario. Three tablets at one fair: the sixth sign-up in a minute gets
"Too many sign-ups from this network". The typed fields are kept, so this is
friction, not data loss.

Suggested fix. Size PUBLIC_RATE_LIMIT_MAX for fairs, or add an operator note to
the RUNBOOK.

## 12. [LOW] touchesHousingAuthority hard-codes every writer's audit payload shape

What is wrong. The audit-history rule knows the exact shape of five event types.
A future writer that sets or removes housingAuthority under any other event
type, or an existing writer that changes its payload, is silently invisible.
The empty authority it left would then look like "never set", and the lead
would be backfilled. For a one-time script this is acceptable, but the
caseworker-integrity follow-up is in flight and touches the same field.

Evidence. app/scripts/backfill-join-housing-authority.ts:127-145.

Suggested fix. Before each prod run, re-check `git log` for new
`audit.append(\`contacts#` writers (app/src) since 15c1676f. Or make the rule
refuse on an unknown event type whose payload mentions housingAuthority.

---

## Checked and found sound (no finding)

- The housing_authority_not_listed refusal comes before the unit read, the
  phone lookup and any write (public.ts:296-302), so it reveals nothing about
  existence. The D4 unitId+authority refusal is generic and comes before the
  unit is read (public.ts:183-189).
- The list check and the dropdown use the same source and the same kinds
  (publicOrgList.ts:24-31 and :40-50; orgNames.ts KINDS_FOR_FIELD /
  isOnListFor). The body trim (trimStrings.ts) matches stored names, which are
  always trimmed (orgNames.ts:348-355).
- Mount order: the list router sits behind the origin-secret validator and the
  body parsers, ahead of the shared limiter (app.ts:133-201). Express 5
  forwards async rejections to the generic 500 (app/package.json express ^5.2.1).
- The backfill's conditional write: attribute_not_exists(housingAuthority),
  type = tenant, and not deleted are all in one ConditionExpression
  (contactsRepo.ts:1546-1564). Its environment targeting goes through the
  shared guarded resolver (scripts/lib/stageClient.ts:112-177, 186-211). The
  audit history paging is exact because ts carries a uuid suffix and `before`
  is exclusive (auditRepo.ts:82, 126). Names are escaped in the report
  (backfill :230-261). Log lines carry contactIds only.
- The candidate rule: no seed or other writer stamps capture_source
  `housing_fair` (grep of app/src and app/scripts), and the PATCH audit lists
  housingAuthority only when the form changed it
  (ContactEditForm.tsx:391-392, contacts.ts:653-657).
