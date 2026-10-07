# Final review - adversarial, BACKEND half (feat/clean-org-names)

Reviewer: plan-blind adversarial reviewer (Opus 5.5). Read-only; no tests, suites or
servers were run. Inputs: `.superpowers/review/final-backend.diff`, `final-other.diff`
(RUNBOOK + docs/issues only), `final-log.txt`, plus the real files in the worktree and
their UNCHANGED neighbours (contacts/units/broadcasts routes, audienceResolution,
contactsRepo/unitsRepo, sqsJobConsumer/jobs, devRoutes, trimJsonBody, unitFields,
infra IAM, main's retired authority helpers). Nothing under docs/superpowers was read.
Already-filed residuals (org-list-write-retry-reads-as-lost-race,
org-rewrite-pass-start-pacing-gap, org-rewrite-single-message-pass,
org-spellings-patch-blind-replace, perf-pages-settings-organizations-surface,
unit-accepted-authorities-edge-cases) are not re-reported except where noted as a
refinement.

Counts: BLOCKING 0, HIGH 0, MEDIUM 1, LOW 7, INFO 8.

---

## MEDIUM-1 - The cleanup apply has no guard against an environment that is not (or no longer) running the new code

- Where: `app/scripts/clean-org-names.ts:28-33` (header: "taking it creates the item,
  create-only, when absent"), `:575-593` (acquire), `:669-672` (peek after the lock);
  `app/src/services/orgRewrite.ts:577-593` (acquireForCleanup -> `list.mutate` ->
  `get()`); `app/src/repos/orgListRepo.ts:166-192` (get creates the starting list);
  RUNBOOK "Organization names cleanup" steps 1-4. `app/test/cleanOrgNames.test.ts:511`
  pins apply-without-item as intended.
- Scenario A (premature apply): the RUNBOOK commands differ only by `--env` and
  `--apply`. The operator finishes `--env dev --apply` and runs `--env prod --apply`
  before prod's deploy. Nothing objects: the lock creates `org-list` in prod and every
  resolvable value is rewritten ("Atlanta (AHA)" -> "Atlanta Housing Authority",
  "Hope Atlanta" moved out of housingAuthority, unit lists rewritten) while main's code
  is live. main speaks only the retired spellings: the blast composer's authority
  filter is free text that staff fill with what the tenant list shows ("Atlanta (AHA)"),
  so `listByHousingAuthority` now returns only contacts written after the apply (the
  only signal is a low draft estimate); main's extractor (HOUSING_AUTHORITY_VOCAB +
  `housingAuthorityFor`) and edit-form datalist (`AUTHORITY_SUGGESTIONS`) keep writing
  the old spellings, so data is re-dirtied and needs a second apply that the RUNBOOK
  never calls for.
- Scenario B (rollback): the deploy is rolled back after the apply for an unrelated
  reason. Same mismatch; the RUNBOOK section has no rollback note.
- Fix: refuse `--apply` when `peek()` returns null - the deployed app creates the item
  on its first page load or AI run, so its absence means the new code has not run
  there ("open Settings > Housing authorities & agencies once, then re-run");
  optionally `--allow-create` for a lane. Add a RUNBOOK line: after a rollback, the old
  composer must be given list names, and re-run the apply after the re-deploy.

---

## LOW-1 - Typographic punctuation and invisible format characters are neither folded nor refused, so visually identical duplicate entries can be added

- Where: `app/src/lib/orgNames.ts:42-49` (normalizeOrgText folds only `. , ( ) - / ' " _`
  and `&`; JS `\s` does not cover U+200B..U+200D, U+2060, U+00AD or bidi marks),
  `app/src/services/orgNames.ts:64-72` (hasOrgControlChar covers C0/C1/U+2028/U+2029
  only), `:330-347` checkNewName; mirror in `dashboard/src/routes/orgs/orgCopy.ts:75-82`.
- Scenario: an admin on a desktop adds agency "St. Jude's Recovery Center" (ASCII
  apostrophe). A VA on an iPhone (Smart Punctuation is on by default) types
  "St. Jude<U+2019>s Recovery Center" (a right single quote where the apostrophe goes):
  it normalizes to `st jude<U+2019>s recovery center`, not `st jude s recovery center`,
  so the write is refused and "Is this really new?"
  opens; if the VA presses Add (D10 lets every user add), checkNewName finds no taken
  name and stores a second, visually identical entry. Same with a pasted soft hyphen or
  zero-width space ("Atlan<U+00AD>ta Housing Authority"), or an en dash ("Macon<U+2013>Bibb").
  Records then split across two names and blasts miss one half - the drift the feature
  exists to stop. Mitigated only by the dialog's close-name offer; recoverable by Merge.
- Fix: in normalizeOrgText (and the dashboard mirror, and both test suites) map
  U+2018/U+2019/U+201A/U+201B/U+2032 to `'`, U+201C/U+201D/U+201E to `"`,
  U+2010-U+2015/U+2212 to `-`, and strip Unicode Cf (U+00AD, U+200B-U+200F, U+202A-U+202E,
  U+2060-U+2064, U+2066-U+206F); consider NFKC first. Refuse Cf characters in names and
  spellings alongside the control-character rule.

## LOW-2 - A generic one-word entry is accepted and then poisons compound detection

- Where: `app/src/lib/orgNames.ts:330-347` (checkNewName: no generic-word rule),
  `:368-390` (checkSpelling: same), `:119-148` (compoundSpans indexes every name and
  spelling), `:150-153` (GENERIC_WORDS is used only by closeNames).
- Scenario: a VA types "Housing" into a picker and presses Add (it normalizes to a
  non-empty, untaken, non-compound text, so it is stored). From then on
  checkNewName("Clayton County Housing Authority") scans `clayton county` -> Jonesboro,
  `housing` -> the junk entry: two spans, no common entry -> 409 org_name_compound, so a
  legitimate new authority cannot be added (and the same for spellings), and the CLI and
  "Not on the list" report such values as compound instead of unknown. Same with
  "County", "Authority", "The", "&" (normalizes to "and").
- Fix: refuse a name or spelling whose normalized words are all in GENERIC_WORDS (plus
  "and"/"&"), or exclude all-generic keys from phraseIndex.

## LOW-3 - Spelling edits are allowed while the cleanup holds the lock, and the cleanup resolves against its lock-time snapshot

- Where: `app/src/services/orgNames.ts:303-341` (updateSpellings has no lock check) vs
  `:349-385` (changeKind/remove call refuseWhileRewriteRuns); `app/scripts/clean-org-names.ts:669-671`
  (one `peek()` after the lock); `app/src/lib/orgStartingList.ts:47`.
- Scenario: the RUNBOOK invites admins to edit spellings "right after the deploy and
  BEFORE step 4". If the apply is already running, an admin moves "Clayton County" from
  Jonesboro to DCA (the launch-gate Clayton question); the PATCH succeeds, Settings shows
  the new mapping, yet the running apply rewrites every remaining "Clayton County" holder
  to "Jonesboro Housing Authority" from its snapshot. Kind change and delete are refused
  during the same window; spellings - which change exactly what the cleanup decides - are
  not.
- Fix: refuse PATCH `{ spellings }` with 409 org_rewrite_running while
  `lastRewrite.action === 'cleanup'` is live (or while any rewrite is live), or have the
  CLI compare the list version at each heartbeat and stop on a spelling change.

## LOW-4 - POST /not-on-list/resolve accepts an unbounded `value` and persists it on the shared item

- Where: `app/src/routes/organizations.ts:336-339` (only non-empty), 
  `app/src/services/orgRewrite.ts:444`, `:478-481` (`fromTexts: [value]`),
  `app/src/repos/orgListRepo.ts:78`, `:161-164`; GET `/` returns `lastRewrite`
  (`organizations.ts:131-135`).
- Scenario: an admin pastes a long blob (up to the ~100 KB body limit) into a settle (or
  a client sends one). It is stored in `lastRewrite.fromTexts` and stays until the next
  rewrite: every strongly consistent list read (each contacts/units/broadcast org check,
  every extraction run, every suggestion accept) and the Settings page's 2-second poll
  during a rewrite carry it (about 25 RCU per read at 100 KB), every heartbeat re-Puts
  it, and the D5/closeNames paths re-normalize it. Admin-only, self-healing, but every
  other org text has a cap (names/spellings 120, notes 500, /check 200).
- Fix: refuse a `value` longer than a fixed cap (for example 500, or the longest stored
  value the "Not on the list" scan can return) with 400; the same cap for the
  `/not-on-list/records?value=` query.

## LOW-5 - Duplicate org.rewrite deliveries do more than split the counts (refines org-rewrite-single-message-pass)

- Where: `app/src/services/orgRewrite.ts:265-296` (a second delivery of a fresh,
  running id is `claimed`, so both run), `:298-319` (finish checks only id + running),
  `app/src/jobs/orgRewrite.ts:161`, `:164-181`; `app/src/services/orgRecords.ts:505-526`
  (beat at most every 20 s); `infra/modules/jobs/main.tf:36` (120 s visibility).
- Scenario 1: a pass outlives 120 s; SQS hands the message to a second poll. If the
  duplicate's claim or pass throws (a throttle, a timeout), its catch calls
  `finish(jobId, failed)` on the shared id while the healthy delivery is mid-pass; the
  healthy one's next beat sees `failed`, stops with lock_lost and never finishes. The
  rewrite is recorded failed with the duplicate's partial counts.
- Scenario 2: the first delivery to finish records `done` and releases the lock while
  the other still writes for up to one beat interval (20 s plus a write). An admin who
  reads "done" and starts the next rewrite (rename back, a settle of the same value)
  interleaves with the straggler, which can rewrite records the new pass already
  scanned. Conditional writes keep both data-safe; leftovers reappear in "Not on the
  list" and Run again repairs scenario 1.
- Fix: give each delivery its own claim token (store `claimId` on `lastRewrite`, check
  it in heartbeat/finish), so only the claim-holder can finish or fail the run; or
  extend SQS visibility from the handler while it heartbeats. At least correct the
  issue's "only splits the counts" wording.

## LOW-6 - A blast resolved while a rename or merge is running, failed or stalled silently omits tenants not yet rewritten

- Where: `app/src/routes/broadcasts.ts:467-491`, `:648`, `:879-885`;
  `app/src/services/audienceResolution.ts:118-128` (exact byHousingAuthority hash).
- Scenario: rename "X" -> "Y" (or merge S into T) fails part-way (a DynamoDB error ->
  `failed`, message deleted, Run again needed) or is still running. A VA creates a draft
  on "Y" (the only name the picker offers) and sends: storedFilterRefusal passes, and the
  audience is only the contacts already rewritten - holders of "X" are dropped with no
  refusal or warning; the composer user never sees the Settings page's failed state.
- Fix: in preview and the filter send branch, when `lastRewrite` is not `done` and its
  `toName` equals the filter (or its fields include housingAuthority), answer 409
  org_rewrite_running / org_rewrite_incomplete (or include a warning in the preview
  body); alternatively query the GSI for the filter name AND the pending rewrite's
  from-texts.

## LOW-7 - The two "move to agency" implementations disagree (CLI vs org.rewrite pass)

- Where: `app/scripts/clean-org-names.ts:197-206`, `:217` vs
  `app/src/services/orgRecords.ts:293-312` (move_to_agency) and `:333-352` (split).
- Scenario: (a) a contact with agency " " (whitespace-only, pre-trim data) and
  housingAuthority "Hope Atlanta": the CLI treats the agency as free and moves; the
  Settings "Move to agency" action counts it a conflict and leaves both. (b) agency
  "Travelers Aid" (a spelling of HOPE Atlanta) and housingAuthority "Hope Atlanta": the
  CLI rewrites the agency to its name first and then moves; the job compares the raw
  agency to toName and counts a conflict. Same intent, two answers, two code paths that
  will keep drifting.
- Fix: one shared pure planner (lib) used by both, resolving the agency field before the
  free/conflict decision and treating whitespace-only consistently.

---

## INFO

- I1. Contacts whose `type` is not one of the five ContactType values are on no
  byTypeStatus partition the pass, usage counts or "Not on the list" query
  (`app/src/services/orgRecords.ts:130-137`, `:367-385`). The CLI's base-table scan plans
  them, but `contactsMissingTypeOrStatus` (`clean-org-names.ts:737-739`) counts only a
  missing/empty key, so a leftover on such a contact is printed by the CLI yet never
  appears on Settings. Count unrecognized types too.
- I2. A cleanup apply (`orgRewrite.ts:577-593`) or any new Settings rewrite started over
  a STALLED one overwrites `lastRewrite` without saying so; the stalled definition (a
  `use`/`clear` decision) is lost and its untouched holders reappear in "Not on the
  list". A one-line warning (log/response) naming the displaced rewrite would help.
- I3. The CLI prints leftover values verbatim (`clean-org-names.ts:879-899`) and a settle
  stores the raw value in `lastRewrite.fromTexts`, served to every signed-in user by
  GET `/api/organizations`. These are free text from the HA/agency fields - where
  caseworker names and phone numbers get typed - so the RUNBOOK's "never a person's
  name" is not guaranteed.
- I4. A suggestion journal claimed before the deploy carries its stored plan (the raw
  pre-deploy text) and is replayed as-is by recovery/journalSweep after it, writing an
  off-list value (it then shows in "Not on the list").
- I5. A pre-deploy dashboard bundle still cached in a browser sends free-text
  housingAuthority/agency/accepted_authorities and gets 422 org_not_on_list bodies it
  cannot render until a reload; an old worker during a staggered app/worker deploy drops
  an `org.rewrite` message as poison (unknown jobName), so that rewrite stalls 15 minutes
  and needs Run again. Deploy app and worker together.
- I6. Merge excludes from its from-texts any source spelling the TARGET already carries
  (`orgRewrite.ts:408-412`, `others` includes the target), so records holding e.g. "AHA"
  when merging Augusta into Atlanta are not rewritten although "AHA" becomes unique to
  the target; they surface as `match` leftovers.
- I7. Duplicated logic that will drift: the lease/heartbeat pacing exists twice (CLI
  `beat`, `clean-org-names.ts:691-708`; job `leasedHeartbeat` + orgRecords `beat`), so
  the filed pacing-gap fix must land in both; normalizeOrgText is hand-mirrored in the
  dashboard (LOW-1 must change both).
- I8. Entry names and spellings (any signed-in user can add, 120 chars, no control
  characters) are rendered into the extraction user content
  (`services/extraction/orgListBlock.ts`); a staff-authored prompt-injection surface with
  schema-constrained output and apply-layer validation behind it. Notes are not rendered.

---

## Checked and holding

- Authorization: DELETE, merge, resolve and run-again use `requireRole('admin')`; the
  mixed PATCH checks the role inline for spellings/name/kind; the router sits behind the
  /api csrfOrigin -> session -> requireAuth mount; Express 5 forwards async rejections.
- `/__dev/org-fixture` lives only in routes/dev.ts, which lib/devRoutes.ts imports only
  when devAuthEnabled && nodeEnv !== production && a DynamoDB endpoint is set.
- Every writer of contact.housingAuthority/agency was enumerated: contacts PATCH (only
  writer of the two in the API; create, public intake, Twilio/voice webhooks and
  statusTransition never touch them), extraction apply, suggestion accept, importer
  (fill-only), rewrite pass, CLI, dev fixture, seeds. Unit lists: units POST/PATCH,
  importer, pass, CLI (PlacementDetail patches final_rent only). Broadcast filter: set
  only at draft create (PATCH sets seeds only), re-checked at draft preview and filter
  send. `authorities_served` exists only in seeds (no reader).
- REMOVE vs '' on the byHousingAuthority key is consistent (PATCH parser, rewriteOrgFields
  EmptyIndexKeyError guard, clear/move/split, CLI, importer, extraction); a machine REMOVE
  takes `housingAuthority_source` with it; the stamp holds no value text.
- Conditional writes guard exactly the fields they write (both fields for move/split,
  whole-list equality for units); units writes never stamp updated_at; the test fakes
  (twilioWebhookHarness rewriteOrgFields/rewriteAcceptedAuthorities, orgListFake.mutate)
  mirror the real conditions.
- Lock: one lastRewrite; claim/heartbeat/finish keyed on the minted id; lapsed-lock
  revalidation shared by claim and Run again; adds of a live from-text refused; kind
  change and delete refused while live; the cleanup lock is never re-runnable or claimed
  by a job; enqueue failure records failed; stale/duplicate ids answer not_current; lease
  margin (14 vs 15 min) holds for failing heartbeats.
- Invariants that keep the pass's normalized matching safe: no name equals (normalized)
  another entry's name or spelling of either kind, spellings are shared only within a
  kind; add, rename, merge, changeKind, updateSpellings and remember-spelling all keep
  them, and value actions refuse name variants except "Use <that entry>".
- Matching rules terminate on any input (compoundSpans always advances; closeNames and
  Levenshtein bounded at 120 chars; regexes linear); D5 means new writes store only list
  names (or an unchanged/held value), which bounds stored length.
- Item cap 300 KB JSON under DynamoDB's 400 KB; the EC2 instance role has full CRUD on
  all stack tables, so the worker can create, claim and heartbeat the settings item.
- CLI: stage resolution with account guard and pinned endpoint; every repo built on the
  stage doc/env; dry run writes nothing (peek, no lock); per-record exact resolution (no
  normalized sweep); idempotent re-run; abort releases `failed`, lost lock releases
  nothing; exit codes match the RUNBOOK; pointer rows skipped, deleted records included.
  The "Clayton County" -> Jonesboro consequence of the retired alias map is documented
  in the RUNBOOK.
- Importer: fill-only contact HA/agency, only resolved names on units, peek never creates.
- Extraction: one list snapshot per run for both the prompt block and resolution;
  control characters become spaces; the TRANSCRIPT word is excluded; agency proposals are
  dropped; dismissals honored through own (unshared) spellings only.
- Suggestion accept: `value` limited to the text's resolution or candidates, list read
  before the claim, valueKey makes a different-value re-accept a 409.
- Seeds and dev reset write list names; the seeded item overwrites one created mid-reseed.
- No remaining reference to the retired housingAuthority helpers or orgVocabulary;
  all new backend files are ASCII.
