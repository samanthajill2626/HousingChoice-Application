# Planner rulings on the plan-research findings

Branch `feat/clean-org-names`, plan `docs/superpowers/plans/2026-10-06-clean-org-names.md`.
Each ruling is binding on the plan sections. Spec corrections marked
SPEC are folded into the spec as revision 6 (precision only - no design
change; Cameron is told at the launch gate).

## R1 - contacts and units

- R1-F1 ACCEPT (SPEC D5): the legacy `jurisdiction` pass applies ONLY while
  the unit has no stored `accepted_authorities` (the list the form shows was
  synthesized by `authoritiesOf`). Callers pass `legacyJurisdiction` to
  `checkListWrite` only in that case. Pin: unit `{ accepted_authorities: [],
  jurisdiction: 'Fulton' }` + PATCH `['Fulton']` -> 422.
- R1-F2 ACCEPT (SPEC D11): audit payload key is `actor` (hoisted to `actorId`
  by `auditRepo`), never `by`. Cleanup rows carry no actor.
- R1-F3 ACCEPT (SPEC section 9): the property Activity tab is a reader; S11
  adds labels for `org_name_rewrite` / `org_name_cleanup` with a `from -> to`
  detail (plan 3.8).
- R1-F4 ACCEPT (SPEC D15): the D15 task ADDS an assertion to
  `TemplatesSection.test.tsx` that fails first (the agency wording), updates
  the job's prose/comments and the test comment, and updates
  `docs/issues/missed-call-autotext-partial-intake.md`.
- R1-F5/F6 noted: the version precedent is `conversationsRepo.ts` ~1183-1247;
  the tombstone drop applies on unit POST too.
- Placement rules (from the R1 summary): contacts PATCH runs D5 after the 404
  pre-read and before the provenance clear; the parser's 400s stay first.
  Units PATCH gains a `getById` pre-read for D5 (POST has no stored unit, so
  every member must resolve). Contacts POST keeps ignoring both fields - pin
  it with a test.
- Trap: the harness `units.list` fake ignores the cursor and caps at 50 -
  tests that page all units must use fewer than 50 units or fix the fake.

## R2 - blasts

- Open decision 1: the 422 `field` for a broadcast filter is `audience_filter`.
- Open decision 2: a stored filter that resolves uniquely but is not the
  exact name (a pre-deploy slug) is refused at preview/send with
  `candidates: [that entry]` so the composer can offer it.
- Open decision 3 / F4 ACCEPT (SPEC D7): the preview re-check applies only to
  `status === 'draft'` broadcasts.
- Open decision 4 / F3 ACCEPT (SPEC D7): POST checks after every existing 400
  shape check; the send re-check sits inside the filter re-resolve branch (c)
  only - never before the branch split.
- Open decision 5: the 201 echoes the stored (resolved) filter.
- Open decision 6: `AudienceFilters` gets the list through `useOrgList()`; if
  the list fails to load, the picker shows inline "Couldn't load housing
  authorities" and the filter cannot be set (other filters still work).
- F1 ACCEPT (SPEC section 7): the composer does not resume drafts; the 422s it
  can meet come from the debounced create (`useComposerDraft` catch) and from
  Preview (`onPreview`). Both show "That housing authority is no longer on
  the list - pick it again" and clear the filter pick. No draft rehydration.
- F2 ACCEPT: the picker commits ONLY on a pick or a clear (typed text is local
  state). Keep the accessible name "Housing authority".
- F5 (branch B) recorded for B's plan.

## R3 - AI and the accept path

- F1 ACCEPT (SPEC D8): the completed journal row gains `valueKey` (sha256 hex
  of the accepted value; absent when no value was sent); BOTH completed
  branches compare it (absent equals absent); the four exact-shape pins are
  updated.
- F2 ACCEPT: a drop-reason label map with a parity test; the Reason cell shows
  the label plus the model's reason when both exist; `e2e/support/selectors.md`
  notes the exception to "every enum is humanized".
- F3 ACCEPT: the harness gets an org-list fake wired into
  `createSuggestionsRouter`; `aiRunVerdicts.test.ts`'s 'Metro HA' case uses a
  name on the harness list; `SERVER_CODES` gains the new codes.
- F4 ACCEPT (SPEC D13): the block sits BEFORE the TRANSCRIPT header and never
  contains that word; names and spellings with a newline or control character
  are refused (`org_name_invalid`, spelling problem `invalid`).
- F5 ACCEPT (SPEC section 9): System Status is unchanged; the per-run
  `orgListFingerprint` shows in the run detail header.
- F6 ACCEPT (SPEC D8 wording): the model's op still decides write vs suggest
  exactly as today; D4 only replaces the known-authority gate.
- Placement rules: the job reads the store after the skip gates and before
  `driver.extract`; renders and hashes the block in the job; carries it in
  `ExtractionInput`; passes the entries to apply through ctx; the agency drop
  calls `decide()` before the `equal_to_current` check and
  `putSuggestionSafe`; the accept check runs in `buildPlan` before the claim;
  the suggestions route's error serializer is extended to pass extras;
  `journalSweep.ts` builds the resolution service too.

## R5 - dashboard

- F1 ACCEPT (plan 3.4/3.5): name and spelling refusals have codes and bodies;
  `/check` returns `nameProblem` and, with `spellingFor`, `spellingProblem`,
  so dialogs can disable buttons and explain BEFORE submit.
- F2 ACCEPT (SPEC D5): the per-member "already held" comparison trims both
  sides (a padded stored member counts as held).
- F3 ACCEPT: see R3-F5.
- Build rules: the picker generalizes the `ContactSearchField` pattern
  (portaled listbox, Escape kept from closing the Modal, Enter acts only on a
  highlighted option); "Is this really new?" renders OUTSIDE the `<form>` and
  every button in it has an explicit `type`; the tenant form never sends an
  unchanged `housingAuthority` (it supersedes a pending AI suggestion) and
  sends `''` when the chip is removed; every form reads `err.body` and maps
  codes to copy (never renders `err.message`); the Settings tab is
  `adminOnly: false` with an unguarded route, admin actions gated with
  `useAuth().isAdmin`; while `lastRewrite.status === 'running'` the Settings
  section polls `GET /api/organizations` every 2 s (the `useBroadcastResults`
  precedent); "Show records" uses per-record links (`/contacts/:id`,
  `/listings/:unitId`), never the facet URLs; every test file that mocks the
  API module by spreading it mocks the new endpoints and hook.

## R4 - platform, seeds, importer, script

- Fact: D1's read-and-bump follows `aiRunsRepo.putRun` (consistent read,
  `#version` condition); D2's create-only write follows
  `claimGroupIdentityFingerprint`. Never copy the existing settings getters
  (not consistent reads).
- F1 ACCEPT: S11 updates the two e2e-workspace unit tests that run inside
  `npm test` - the dashboard mutation catalog (one row per new mutating
  endpoint; the pinned count) and the page-profiler route registry (the new
  Settings route).
- F2 ACCEPT: the job task adds `org.rewrite` to the pinned job-name list in
  `registerHandlers.test.ts`.
- F3 ACCEPT (SPEC D11): the rewrite id is minted by the service
  (`randomUUID()`) BEFORE the list write, stored in `lastRewrite.jobId` and
  carried in the job payload; it is never the jobs envelope id.
- F4 ACCEPT (SPEC D11): the handler catches its own errors, records `failed`
  with the counts so far, and never rethrows (no redelivery storm); every
  heartbeat and finish is a read-and-bump that first checks
  `lastRewrite.jobId` is still its own and does nothing otherwise; per-record
  writes stay conditional. A test drives two concurrent runs of one
  definition.
- F5 ACCEPT (SPEC D9): the importer gets the list as an `ApplyOptions` input;
  the CLI does a NON-creating consistent read (`orgListRepo.peek()`) with the
  starting-list fallback (the cleanup script's rule); the per-value
  "not written" counts are computed in BOTH dry-run and real modes.
- F6 ACCEPT (SPEC D9): an unknown or ambiguous unit value is not written and
  is counted in the report, like the contact side.
- F7 ACCEPT: the seed-only `authorities_served` values become list names too.
- F8 ACCEPT: RUNBOOK's "add the spelling to CANONICAL_AUTHORITY" paragraph is
  rewritten (admins add spellings on Settings; an unknown name stays a
  suggestion until staff add it).
