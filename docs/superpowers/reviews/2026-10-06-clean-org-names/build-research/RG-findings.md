# RG findings - invariant sweep (spec I1: writers, readers, settings-table readers, index visibility)

- Reader: RG (build research, feat/clean-org-names), 2026-10-06.
- Plan range: plan-independent sweep of the LIVE tree (W:/tmp/clean-org-names;
  source == main @d839494a, `git diff d839494a HEAD -- app dashboard e2e
  fake-twilio scripts` empty), then every surface mapped to its covering plan
  task. Read: spec D3, D5, D7, D8, D11, sections 5, 8, 9, 13; plan sections 0-3
  and 12, plus the covering tasks 3.4, 6.1-6.5, 7.2, 7.5, 7.7, 12.1-12.5, 13.1,
  15.2.
- What I checked: (A) every code path that writes contact.housingAuthority,
  contact.agency, unit.accepted_authorities (+ legacy jurisdiction /
  accepted_programs) and broadcast audience_filter.housing_authority - routes,
  generic repo helpers and their callers, raw table writes, jobs, AI apply,
  suggestion accept AND its replay paths, importer + scripts, seeds, dev reset,
  every /__dev seam, public intake, fake-twilio, e2e, record copies; (B) every
  reader/renderer/comparer of those values; (C) every generic reader of the
  settings table; (D) which contact rows the byTypeStatus index cannot see.
- The complete writer/reader inventory (file:line, role, coverage) is in
  `.superpowers/sdd/build-research/RG-reference.md` (not committed).
- Counts: BLOCKER 0, MAJOR 2, MINOR 4.

Clean results (one line each):
- (A) Every writer is covered by a plan task or a spec-stated exception EXCEPT
  the suggestion-accept replay path (RG-1). Contacts POST, restore and delete
  never write the fields; no merge/clone/bulk endpoint or req.body spread exists;
  public intake (/public/housing-fair only), fake-twilio, jobs (other than via
  extraction apply / journal sweep) and app/scripts (other than import-apply)
  write neither field.
- (B) Readers keep working with full names and off-list values (exact GSI match,
  case-folding facets that prune stale keys, flyer/similar-units joins, header
  facts, activity projection of `from`/`to` strings) EXCEPT the AI dismissal
  fence (RG-2).
- (C) Clean: no generic reader lists, validates, exports, streams or copies
  settings items; settingsRepo / contactVocabularyRepo / routes/settings.ts are
  keyed on fixed ids; devReset.ts:35-64 and scripts/wipe-dev-data.mjs:166-204
  delete shape-agnostically; the settings table has no stream (tables.ts:309-312).
- (D) Pointer rows (contactsRepo.ts:926-933, :999-1006) carry no type/status and
  no org field; unknown and deleted contacts ARE on byTypeStatus and the plan's
  five-type x {active, deleted} walk (plan 3852-3870) reaches them; no current
  writer can store either field on a contact lacking type or status (reference
  section D). Residue: RG-4, RG-5.

---

## RG-1 | Task 7.7 (plan 12856-12938; journal sweep note plan 13071-13073; recovery literal plan 13112-13113) | MAJOR | an abandoned suggestion accept is REPLAYED after the deploy and writes its stored housingAuthority text with no D5 check

Evidence:
- The accept persists its built plan in the journal row at claim
  (app/src/repos/suggestionResolutionRepo.ts:623-637, `plan: input.plan` :632)
  and deletes the `sugg#` row in the same transaction (:656-664).
- Three paths later COMMIT that stored `plan.patch` without rebuilding it:
  `recoverAbandoned` (app/src/services/suggestionResolution.ts:585-625) called on
  EVERY `GET /api/contacts/:id/suggestions` (app/src/routes/suggestions.ts:101 -
  i.e. any contact page load) and by the daily sweep
  (app/src/jobs/journalSweep.ts:241); and `resolve()` helping an expired journal
  before its own claim (suggestionResolution.ts:635-656). All go through
  `applyJournal` -> `commitContactEffect` (suggestionResolution.ts:385-402;
  suggestionResolutionRepo.ts:745-792 SETs `journal.plan.patch` verbatim).
  The lease is 30 s (suggestionResolutionRepo.ts:236).
- The plan checks the list ONLY inside `buildPlan` (Task 7.7 GREEN 1d-1f, plan
  12857-12938) and says so: the sweep "never reads [the list]: it only replays
  stored plans" (plan 13071-13073); the recovery test literal is
  `{} as OrgNamesService` "Never reached" (plan 13112-13113). Spec D8 / section 9
  name no exception for replays.

Failure scenario:
1. Pre-deploy plan, post-deploy write: an accept in flight when the deploy
   restarts the container (or any abandoned journal already sitting in prod -
   the sweep drains at most 25 contacts/day behind a 24 h age gate) holds
   `{ housingAuthority: '<suggested text>' }`. Pre-deploy housingAuthority
   SUGGESTIONS are by construction mostly OFF-list text: known authorities were
   written directly and only unrecognised text was suggested
   (app/src/services/extraction/apply.ts:250-258). After the deploy, the next
   page load of that contact commits the old text - an off-list value written
   after the deploy (I1 violated; it then sits in "Not on the list").
2. Post-deploy plan replayed late: a plan built with "Atlanta Housing Authority"
   is abandoned; before the sweep replays it, an admin renames or deletes that
   entry and the rewrite job runs; the replay then writes the old name, which is
   no longer on the list.

Correction (pick one; the first closes the gap):
- STRICT (recommended): in `applyJournal`, at the `journal.phase === 'claimed'`
  arm and only when `plan.kind === 'contact'` and `typeof
  plan.patch['housingAuthority'] === 'string'`, read the list LAZILY
  (`(await deps.orgNamesService.read()).entries` - the dep Task 7.7 makes
  required) and, when `!isOnListFor(entries, value,
  KINDS_FOR_FIELD.housingAuthority)`, do NOT commit: call
  `deps.resolutionRepo.release({ token, expectedPhase: 'claimed' })` (the
  existing restore-the-snapshot path the phone_conflict arm uses,
  suggestionResolution.ts:403-480) so the suggestion returns to pending and
  staff re-accept it through "Is this really new?"; reuse that arm's
  helping/own-claim handling (a helper returns; an own claim answers 409, e.g.
  `suggestion_value_off_list`, plus copy in the dashboard error map). Because the
  read is lazy, `suggestionResolutionRecovery.test.ts` (its journals only patch
  `pets`, :34-60) keeps its `{}` literal; replace the comments at plan
  13071-13073 / 13112 ("recovery replays stored plans and never reads the
  list") with the new rule. Add a test: a claimed housingAuthority journal
  holding an off-list text is released, not committed, on GET suggestions.
- CHEAP: accept it as a stated exception - add to spec section 9 (writers) and
  plan section 12's accepted residual races: "a suggestion accept claimed before
  the deploy, or replayed after a rename/merge/delete, writes its stored text;
  it appears in Not on the list"; and add to the RUNBOOK pre-deploy checklist a
  look for active `resolve#<contact>#housingAuthority` journals in prod.

## RG-2 | Task 7.5 (plan 12074-12160: `value = resolved.entry.name` :12087, `suggestedValue = String(value)` :12158) | MAJOR | the AI dismissal fence compares suggestion TEXT, so every pre-deploy housingAuthority dismissal stops suppressing the same authority once it is suggested under its full list name

Evidence:
- The fence (apply.ts:784-813) checks `hasDismissal(contact, target,
  normalizeSuggestionValue(target, suggestedValue))` - a lowercase/whitespace
  fold of the TEXT (app/src/services/extraction/schema.ts:330-333); the dismiss
  path keys the tombstone the same way (suggestionResolution.ts:193-196; repo
  fence extractionRepo.ts:604-653). Contract (apply.ts:789-791): "a value a human
  already rejected for this target is never re-suggested (permanent by ruling
  2026-07-21)".
- Pre-deploy the suggested text was `housingAuthorityFor(raw)`
  (apply.ts:132): an alias canonical spelling ("Atlanta (AHA)", "DCA",
  "Fulton County", ...) or verbatim unknown text. After Task 7.5 a match is
  suggested as the entry NAME (plan 12087), a different key. Neither spec nor
  plan mentions dismissals (`grep -i dismissal` on the plan: no hits).

Failure scenario: staff dismissed the AI's "Atlanta (AHA)" (or "Fulton County",
which Sam's answers made a spelling of Fulton County Housing Authority) for a
tenant before the deploy. The first post-deploy extraction suggests "Atlanta
Housing Authority" / "Fulton County Housing Authority" and the chip comes back.
Worse for op 'write': writes never consult dismissals (apply.ts:258), and text
that was UNKNOWN pre-deploy (so could only be suggested, then dismissed) now
resolves and can be WRITTEN straight over the human's rejection.

Correction: in Task 7.5's housingAuthority branch, when `resolved.status ===
'match'`, test the dismissal of the entry NAME and of every one of its SPELLINGS
(each through `normalizeSuggestionValue('housingAuthority', s)`; every alias
canonical output - Atlanta (AHA), Jonesboro (JHA), Dekalb County Housing,
Georgia Housing Voucher (GHV), DCA, Fulton County, Clayton County, East Point,
McDonough - is a name or spelling in Appendix A, see reference section E) and
drop with `dismissed_before` when any is dismissed - for the suggest path, and
also for op 'write' (a resolved write over a dismissed spelling becomes a drop).
Add a test: a dismissal of 'Atlanta (AHA)' suppresses a later suggestion and a
later write of 'Atlanta Housing Authority'. If the orchestrator rules this
UX-only, state it instead in spec D8 ("dismissals made before the deploy are
keyed on the old text and do not suppress the full name").

## RG-3 | plan section 12 accepted races (plan 30402-30409); spec D8 / D9 / D11 | MINOR | two stale-list writers are not among the stated races

Evidence: the extraction job reads the list once per run (D8; Task 7.2) and
applies after the model call; the importer CLI peeks the list once per run
(D9; Task 8.3) and does NOT take the rewrite lock (only the cleanup does, spec
section 8). A rename/merge/delete committed between the read and the write
makes them write the old name - off the list after the deploy (self-heals in
"Not on the list").
Correction: add both to the accepted-race bullet in plan section 12 (and the
race sentence in spec D11); no code change.

## RG-4 | Task 3.4 everyContact (plan 3852-3870); plan section 12 (30397-30401); spec D11 | MINOR | the byTypeStatus walk can miss more than "a record written in the moment before"

Evidence: `everyContact()` walks type partitions in the order tenant, landlord,
partner, team_member, unknown, each ascending by status. A contact whose `type`
(e.g. unknown -> tenant triage, contacts.ts:1495-1499) or `status` changes while
the walk is running moves to an already-walked partition/range and is never
visited by that rewrite, however long after the rewrite started.
Correction: widen the stated race in spec D11 and the plan 12 watch item ("a
record whose type or status changes while the job walks the index can be
missed; it shows in Not on the list"). No code change.

## RG-5 | spec D11 ("invisible app-wide"); Task 15.2 (plan 29349-29356) | MINOR | legacy contacts missing `type` or `status` are seen by the cleanup but not by the job, usage or "Not on the list" - and a status-less TENANT is still reached by blasts

Evidence: current writers cannot create such a row (reference section D), but
pre-guard legacy rows cannot be ruled out from code. The cleanup scans the base
table (plan 29349) and would rewrite them once; the rewrite job, usage counts
(delete/kind-change checks) and "Not on the list" walk byTypeStatus and never see
them. A tenant with `type` but no `status` is still returned by byHousingAuthority
and passes audienceResolution's only type check (audienceResolution.ts:147), so
"invisible app-wide" is not exact.
Correction (optional, cheap insurance): have the cleanup dry run count contacts
that hold housingAuthority/agency but lack `type` or `status` and print the
count beside the leftovers (expected 0); if non-zero, Cameron decides before the
apply.

## RG-6 | spec section 13 launch-gate ruling (bare Clayton -> DCA); Task 15.1 planners | MINOR (spec conformance in passing) | the ruling cannot reach existing records: every stored bare "Clayton" was canonicalized to "Clayton County" before storage

Evidence: the retired alias map stored `clayton` as 'Clayton County'
(app/src/lib/housingAuthority.ts:48) for both the importer (apply.ts:914, :1356)
and the AI (apply.ts:132). The cleanup sees only the stored text and maps every
"Clayton County" value - including those whose source was a bare "Clayton" - to
Jonesboro Housing Authority (Appendix A). The ruling therefore only affects
future text (importer, AI, Settings). Plan-review P35 noted the canonicalization
but the records do not say the ruling leaves stored values on Jonesboro.
Correction: no code change; add one sentence to the RUNBOOK cleanup section (or
spec section 13): "stored 'Clayton County' values include pre-deploy bare
'Clayton' text; the cleanup maps all of them to Jonesboro Housing Authority -
review the Airtable export's bare 'Clayton' rows with Sam if any tenant should
be DCA's".
