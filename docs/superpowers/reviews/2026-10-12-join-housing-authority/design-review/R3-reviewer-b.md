# Design review R3 - reviewer B (adversarial)

Spec: `docs/superpowers/specs/2026-10-12-join-housing-authority-design.md`, revision 3
(@0174f240; diffed against rev 2 @842c6edf). Read alongside the round-2 section of
`adjudications.md`. Read-only: nothing was run. Every claim cites the file:line I read.

**Bottom line.** Nothing this round is BLOCKING, HIGH or MEDIUM. The round-2 fixes are
correct. There are three LOW findings: one needs a sentence in the spec, one is a
safe-direction over-exclusion, and one is a test-realism gap for the plan. None
requires reversing a decision. If the coordinator's rule is "a round that changes no
decision ends the loop", this round qualifies, unless R3-2's optional one-field
addition is taken.

---

## Part 1 - New findings

### R3-1 [LOW] Both D10 audit exclusions need a COMPLETE per-contact audit read, and the repo's read is one unpaged Query

**What is wrong.** D10 now leaves out a candidate based on its audit trail twice: any
`housing_fair_signup` event with `signupVersion: 2`, and any event that SET or
REMOVED `housingAuthority`. `auditRepo.listByEntity` issues ONE Query, never follows
`LastEvaluatedKey`, and returns no cursor (`app/src/repos/auditRepo.ts:122-141`; opts
are only `limit` and `before`, `:29-34`). The read is newest-first
(`ScanIndexForward: false`, `:134`). If a contact's partition exceeds one 1 MB page,
the events dropped are the OLDEST ones, which is exactly where a pre-change
housingAuthority write or clear lives. Nothing tells the caller the read was cut.

**Implies.** The practical risk is tiny (a contact needs about 1 MB of audit rows), but
the exclusion is a never-overwrite guarantee. One sentence fixes it: "the history read
pages backward with `before` (and a `limit`) until a page comes back short". Otherwise
a builder calls `listByEntity(key)` once, and the test fake, which returns
everything, cannot catch it.

### R3-2 [LOW] The re-sign-up exclusion also catches flyer re-sign-ups, which were never asked

**What is wrong.** D7 puts `signupVersion: 2` on EVERY post-change
`housing_fair_signup` event, flyer requests included. A flyer request can never carry
an authority (D4), so its event says `housingAuthority: null`. A pre-change /join lead
who later uses a flyer's sign-up form is therefore left out of the backfill with the
stated reason "whose answer (D7) must not be overridden". There was no answer. The
audit cannot tell this case from a real "Not sure": `viaFlyer` is false for an
unavailable unit (`app/src/routes/public.ts:231-240`, `:322-327`), and the request's
`unitId` is not recorded.

This is the safe direction (the lead is left empty, not stamped wrong), and it is
rare. Blast links use the text variant, which shows no form
(`app/src/lib/mergeFields.ts:30` appends `?cta=text`; `FlyerPage.tsx:128` and
`:363`). Only publicly shared bare links show the form.

**Implies.** Either have D7 record whether the request carried a `unitId` (for example
`asked: !unitId`) and exclude only asked events, or keep the rule and correct the
reason text the dry run prints ("signed up again after the change", not "answered").
Either is one line.

### R3-3 [LOW] The local-lane rehearsal cannot produce a single candidate through the app

**What is wrong.** After this change every contact the endpoint creates carries
`housing_fair_signup_v2` (D5), and no seed writes `capture_source: 'housing_fair'`.
The only writer is `app/src/routes/public.ts:268`; the seeds stamp only
`'inbound_sms'`, at `app/src/lib/seed/cast.ts:159`. A rehearsal on a hermetic lane
that signs leads up through `/join`, as an agent naturally would, finds zero targets,
writes nothing, and exits 0. It looks like a pass but exercises no apply path against
real DynamoDB conditions.

**Implies.** Say in D10 (or leave to the plan, explicitly) that the rehearsal and the
script test put pre-change-shaped leads directly: no marker, `capture_source:
'housing_fair'`, `type: 'tenant'`. The script test can, since
`app/test/cleanOrgNames.test.ts:8-12` already drives DynamoDB Local with direct puts.
A live lane rehearsal needs the same, or it should not be counted as evidence.

---

## Part 2 - K6 (no status condition): CONCEDE

I cannot defend a status condition with code. Blasts read no status
(`app/src/services/audienceResolution.ts:116-176`), and
`app/src/repos/broadcastsRepo.ts:84-90` has none. Nothing else gates on Inactive or On
hold for messaging, so a backfilled inactive lead is in the same position as any
parked tenant who already holds an authority. The ruling is Cameron's and section 4
now states the consequence.

---

## Part 3 - Are the round-2 fixes correct?

- **K1, D8 "Choose one" recovery: correct.** It picks no value, blocks send, and a
  failed re-read falls into the D8 failed state. D9 then keeps whatever the person
  actually chose. No interaction problem with the load-time "submit disabled" rule.
- **K2, D7 `signupVersion: 2` plus the requested name: correct.** It is an
  organization name, so no PII. The over-reach is R3-2.
- **K3, the marker on every new contact, flyer included: correct, and nothing breaks.**
  No reader enumerates contact attributes: no `Object.entries(contact` /
  `Object.keys(contact` in `app/src` or `dashboard/src`. No test snapshots a created
  contact: `app/test/publicIntake.test.ts:41` uses `toMatchObject`; its `toEqual`s are
  response bodies only (`:35`, `:75`, `:95`). The e2e asserts single fields
  (`e2e/tests/dashboard-next/public-pages.spec.ts:247-263`). The tenant-onboarding
  scenario starts from the POST and moves status through the status dialog
  (`e2e/scenarios/steps.ts:955-967`), which works from Onboarding as it did from Needs
  review.
- **K4, the marker renamed and redefined: correct.** Section 4 now states the
  never-backfilled consequence.
- **K5, the named event list: verified against the payloads.**
  - `contact_updated` carries `fields`: `app/src/routes/contacts.ts:1950-1951`, and the
    caseworker conversion at `app/src/services/caseworkerConversion.ts:426-427`. The
    conversion's `fields` is `Object.keys(patch)` (`:592`), which always includes
    `housingAuthority` (`:562`) even when none was held. That over-excludes a
    converted-then-retyped lead, in the safe direction.
  - `ai_extraction_applied` carries `fields[].field`:
    `app/src/services/extraction/apply.ts:301-307`, `:505-508`.
  - `ai_suggestion_accepted` carries `target`:
    `app/src/services/suggestionResolution.ts:318-322`.
  - `org_name_rewrite` and `org_name_cleanup` carry `field`:
    `app/src/services/orgRecords.ts:618-624`.
  - The importer writes `housingAuthority` with no audit event
    (`app/src/lib/import/apply.ts:1150-1152`, no append in that file). That is harmless
    here: a value it set is either still present (not a candidate) or was removed by
    an audited path. The audit table has no TTL (`infra/envs/prod/tables.auto.tfvars.json`,
    `audit_events` carries no `ttl_attribute`), so history does not age out.
- **K7: correct.** `documentation/sequence-diagram-to-test.md:108-110` is the
  self-serve portal note.
- **K8, `contactsRepo.update` with guards: correct, with no hidden side effects.**
  - The update SETs only the patch keys, plus `classification_revision` ONLY when the
    patch contains `type` or `role` (`app/src/repos/contactsRepo.ts:1467-1469`,
    `:1500-1507`).
  - It stamps no `updated_at` and writes no pointer or `phones[]`
    (`:1458-1579`).
  - `ExpectClause.attr` is a free string, so `type` is allowed (`:668-671`).
  - `notDeleted` is `attribute_not_exists(deleted_at)` (`:1560-1563`), which matches
    restore's REMOVE (`:781`).
  - A lost guard throws `ConditionalCheckFailedException`, which the script maps to
    skipped (`:1564-1576`).
  - No DynamoDB stream is enabled on `contacts` (`infra/envs/*/tables.auto.tfvars.json`:
    two stream tables, neither is contacts), so nothing downstream reacts to the write.

---

## Round-2 status (mine)

R2-1 through R2-7 are closed by rev 3. R2-6 was accepted as a documented decision,
and I concede it above.
