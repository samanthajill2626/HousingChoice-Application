# Planner review - plan-blind adversarial (feat/matching-blast-rules)

Reviewer: independent adversarial, plan-blind (did NOT read docs/superpowers/**;
read docs/issues/** only to avoid re-filing known items). Branch tip reviewed:
code commit 994be540 (diff main...HEAD excluding docs/superpowers). Read-only;
no suite, typecheck, lint or e2e was run (the planner's gate run owns the
worktree). Byte-exact quotations for PA-1 and PA-5 are in
`.superpowers/sdd/planner-adversarial-reference.md`.

## Summary

| Severity | Count | IDs |
|----------|-------|-----|
| blocking | 0 | - |
| high     | 0 | - |
| medium   | 0 | - |
| low      | 3 | PA-1, PA-2, PA-3 |
| info     | 6 | PA-4, PA-5, PA-6, PA-7, PA-8, PA-9 |

Independently re-derived and ALREADY FILED (not re-counted above; listed in
"Known items confirmed" at the end): the prefill fail-open, the 422 that
empties the whole filter, the stale-bundle default-check window, the
1000-row preview slice, the renamed-entry 422, the resume rehydration gap.

## Findings

### PA-1 (low) - The D4 tour-state rule is a second copy of the Tours/Today classifier, and the two already disagree

- Where: `app/src/lib/blastAudienceRules.ts:100-103` (toured branch of
  `tourHoldOf`) vs `dashboard/src/api/types.ts:937-945` (`tourStatusLabel`),
  `dashboard/src/routes/tours/useTours.ts:189-191` (`needsPlacement`) and
  `:264-268` (`pastState`); API path `app/src/routes/tours.ts:1296`,
  `:1323-1327`.
- Scenario A (precedence): a toured tour whose exit gate was recorded through
  the API with `moveForward: true` and no `outcome` (accepted:
  `tours.ts:1296` only requires status toured; `:1323-1327` sets
  `convertible: true` without an outcome). The Tours page and Today say
  "Toured - needs outcome" / "Needs outcome" (they test `outcome ===
  undefined` FIRST); the Review recipients tag for the same tenant says
  "Toured Oct 5, needs placement" (the server tests `convertible === true`
  FIRST). The auto-close sweep skips convertible tours, so this tenant is held
  under the disagreeing label indefinitely. The dashboard's own exit gate
  (`TourDetail.tsx:597-601`) always sends both fields, so this is API-reachable
  only today.
- Scenario B (conversion claim): a toured, convertible tour carrying a
  `convertedPlacementId` sentinel (`pending:<uuid>` during a claim, or a claim
  stranded until its release) - `needsPlacement` returns false on the Tours
  page ("Toured"), while `tourHoldOf` ignores `convertedPlacementId` and
  labels "needs placement".
- Effect: label-only (the tenant is held either way), but it is exactly the
  "duplicated rule that can drift" shape: a third classifier
  (`toursModel.autoCloseDueAtMs`) also reads these fields with its own
  precedence.
- Direction: align `tourHoldOf`'s toured branch with the dashboard's order
  (no outcome -> needs_outcome, then convertible without
  `convertedPlacementId` -> needs_placement), or lift one shared server
  classifier the dashboard mirrors; pin the moveForward-only case in
  `blastAudienceRules.test.ts`.

### PA-2 (low) - Every message-only edit re-runs the whole rules build on draft create, though the estimate does not depend on the message

- Where: `dashboard/src/routes/broadcasts/useComposerDraft.ts:98-111` (the
  material key includes the trimmed body), `:28` (600 ms debounce);
  `app/src/routes/broadcasts.ts:933-950` (create calls `buildReviewRows(...,
  'estimate')`), `:694-703` (three unbounded byStatus partitions plus the
  bounded requested one), `:796-799` and
  `app/src/services/shareRecipientState.ts:249-269` (every share of the unit,
  sequentially, with send-attempt record reads).
- Scenario: staff type a message with a few pauses on a property that has
  several earlier shares. Each pause recreates the draft, and each create now
  runs resolveSeeds + the audience walk (up to 50 pages) + the
  scheduled/toured/no_show/requested reads + the decline reads + the full
  prior-recipient walk with record reads. On main a create did only the
  audience walk. None of these inputs changed - only the body did. While each
  create is in flight `reachPending` is true, which keeps Preview disabled
  (`BroadcastComposer.tsx:561-568`), so the slower create is felt directly; a
  superseded create still runs to completion server-side (no abort is passed
  to `createBroadcast`). The comment at `broadcasts.ts:925-929` acknowledges
  the repetition but frames it as "a few small Query pages", which holds only
  while the unit's share history and the open-tour partitions are small; the
  `toured` partition keeps every move-forward tour that was never converted.
- Direction: do not recompute the reach for a body-only change (keep the last
  reach for an unchanged audience sub-key and send an opt-out such as
  `estimate: false`, or have the server reuse a short-lived estimate keyed by
  unit + filter + seeds); at minimum, consider metering POST /broadcasts like
  the send.

### PA-3 (low) - Already-sent still fails OPEN silently, while holds and declines - the other D5 inputs - now fail CLOSED

- Where: `app/src/routes/broadcasts.ts:784-799` (rules reads throw ->
  503/no estimate; `priorRecipientKeys` never throws),
  `app/src/services/shareRecipientState.ts:264-266` (a failed byUnit page
  logs WARN and returns what it resolved), `broadcasts.ts:1029-1033` (the
  stated reason for failing closed: a list "would check people the rules
  leave out").
- Scenario: one throttled `broadcasts.listByUnit` page while previewing a
  property with an earlier share. Tenants who already received this property
  come back `alreadySentThisProperty: false`, so `checkedByDefault` is true,
  they count in "Reaches N", start checked, and Send re-texts them - with no
  notice anywhere (the preview response has no flag for it). The same partial
  read for tours or declines would have produced a 503 with Try again.
- This is pre-existing behaviour and documented as "a soft hint by design"
  (`broadcasts.ts:739-741`), but this branch made already-sent one of the
  three inputs of the one default-check rule and of the D8 count, so the
  asymmetry is now inside a single rule the branch says fails closed.
- Direction: have `priorRecipientKeys` report completeness (for example
  `{ keys, complete }`) and either treat an incomplete read like the other
  two (503 / no estimate) or carry a preview flag the review shows ("Already
  sent labels could not be fully loaded").

### PA-4 (info) - The API's no-body filter send (path c) and "Reaches N" count different people

- Where: `app/src/routes/broadcasts.ts:1294-1296` (path c subtracts holds and
  declines only) vs `:815-821` / `:945` (D5 and the D8 count also leave out
  already-sent and no-consent rows, and count a filter draft's seeds).
- Scenario: an API client creates a filter draft (estimatedCount = N, which
  excludes already-sent tenants and includes the draft's seeds), then POSTs
  /send with no body: already-sent tenants ARE texted again and the seeds are
  NOT texted, so the send count differs from N in both directions. The
  dashboard never takes this path (it always posts an explicit list), and the
  comment at `:1261-1271` says this is deliberate (D6); recorded so nobody
  reads `estimatedCount` as "what a no-body send will reach".
- Direction: none required; if path (c) is kept, a one-line note on the
  create route's `estimatedCount` would prevent the misreading.

### PA-5 (info) - `wireAudienceFilter` turns one malformed broadcast row into a 500 for the whole Matching list

- Where: `app/src/lib/blastAudienceRules.ts:219-227`;
  `app/src/routes/broadcasts.ts:449` (results), `:478` (every list row,
  `:1479-1482`).
- Scenario: any broadcast item stored without `audience_filter` (a hand
  repair, a future writer, an old row). `authoritiesOfFilter(undefined)` is
  guarded, but `filter.bedroomSize` / `filter.excludeOptedOut` then throw a
  TypeError, and because the list maps every row of the page, GET
  /api/broadcasts answers 500 and the Matching list is blank. On main the
  projections passed `b.audience_filter` through untouched. Every current
  writer (the create route, the full and performance seeds) sets the field,
  so this is latent.
- Direction: accept `AudienceFilter | undefined` and return the default
  tenant shape for undefined.

### PA-6 (info) - A false "truncated" when the searching partition ends exactly on the page bound

- Where: `app/src/services/audienceResolution.ts:155-164`.
- Scenario: the searching partition is read to its end on exactly the
  `maxPages`-th page (no LastEvaluatedKey). The onboarding loop starts, sees
  `pages >= maxPages` and sets `truncated` without reading, even when the
  onboarding partition is empty. Path (c) then refuses the send as
  `audience_too_large` (truncated) and the composer says "the list is
  incomplete". Needs about 10,000 searching tenants (50 x 200), so latent.
- Direction: none needed at Phase-1 volumes; if touched, probe the next
  partition with a `Limit: 1` read before declaring truncation.

### PA-7 (info) - `heldContacts` in the preview log counts every held contact in the organization, not this audience's

- Where: `app/src/routes/broadcasts.ts:1100` (`review.tourHolds.size`; the map
  is org-wide by design, `:534`).
- Effect: an ops reader comparing `heldContacts` with `count` /
  `checkedByDefault` on the same line will misread it.
- Direction: log the held rows in this review (`rows.filter(r =>
  r.tourHold).length`) and, if wanted, the org-wide size under its own name.

### PA-8 (info) - `ResolvedAudience.contactIds` and `.count` no longer have a runtime reader

- Where: `app/src/services/audienceResolution.ts:82-84`, `:251-256`.
- Effect: main read `audience.contactIds` (the create union) and
  `audience.count` (path c); this branch reads only `contacts` and
  `truncated`. Two result fields now exist for tests alone - small dead API
  surface that invites a future caller to trust a pre-de-duplication notion of
  the count.
- Direction: drop them or note they are derived conveniences.

### PA-9 (info) - The prefill hold has no client-side bound or Try again

- Where: `dashboard/src/routes/broadcasts/BroadcastComposer.tsx:228-229`
  (hold while the property load or the org-list read is unsettled),
  `dashboard/src/api/client.ts:116-123` (no request timeout),
  `useOrgList.ts` (read once per mount; the composer never polls or reloads).
- Scenario: a GET /api/organizations or GET /api/units/:id that stalls keeps
  the composer at "Estimating reach..." / "Sizing the audience..." with
  Preview disabled and no notice until the edge or browser gives up; on main a
  stalled property load only meant no voucher prefill. It ends in the
  already-filed fail-open path once the read errors.
- Direction: fold into the decision on
  `matching-prefill-org-list-failure-fails-open` (a Try again wired to
  `orgList.reload()` / a re-fetch would cover the stall too).

## Known items confirmed (already filed - not re-counted)

- `docs/issues/matching-prefill-org-list-failure-fails-open.md` - re-derived
  independently: a failed org-list read or property load (and a stale list)
  leaves a property blast unfiltered by housing authority. Agree it must be
  decided before merge; PA-9 is the stall variant of the same gate.
- `docs/issues/matching-composer-422-unmatched-member-clears-filter.md` -
  re-derived (`BroadcastComposer.tsx:262-265`).
- `docs/issues/composer-org-422-offer-renamed-entry.md` - note an extra angle
  for its fix: after a rename, simply recreating the draft would succeed
  (create's `checkList` maps the old name, now a spelling, to the new name),
  so removing the member at Preview drops tenants the next create would have
  kept.
- `docs/issues/matching-default-check-stale-bundle-window.md` - re-derived.
- `docs/issues/matching-preview-cap-drops-hand-picked-seed.md` - its text
  already covers the general case: above 1000 rows the ONBOARDING tail is cut
  silently too (resolver order is searching first), not only seeds.
- `docs/issues/matching-draft-resume-seed-rehydration.md` - resume still
  opens an empty composer that cannot preview; unchanged by this branch.

## Checked and found sound (silence is informative)

- Server filter path cannot be widened by a crafted body: `contact_type` is
  pinned, statuses are fixed server-side (`BLAST_TENANT_STATUSES`), the type
  and status belts survive a leaky index, opt-out/unreachable are forced true
  at parse, list + legacy together is a 400, members are list-checked and
  stored as exact names. Caseworkers never resolve from the filter. Path (a)
  and seeds may name any tenant/partner of any status by design (hand picks);
  the fan-out still fences no-consent and deleted contacts.
- Resolver: two partition reads under one page bound, searching first; the
  searching-to-onboarding mid-read duplicate is de-duplicated (first row
  wins); `byTypeStatus` excludes soft-deleted rows; housing authority match is
  any-of on the trimmed value; `truncated` is otherwise exact.
- Tours read: `createdAt >= from` key condition is valid on the byStatus GSI
  (projection ALL, so convertible/outcome/scheduledAt are present); tour
  `createdAt` is always canonical `toISOString()` so the lexical bound is
  exact; the read is a superset of the 336 h rule at the boundary and the
  rule decides. The harness fake models the range condition the same way.
- Fail-closed wiring: a thrown tours or decline read gives 503 for a filter
  preview and path (c), no estimate at create, labels-off for seeds_only;
  `effectiveDeclines` uses `requireComplete`.
- Composer races: the draft hook's generation counter discards superseded
  creates (and deletes their drafts); `hold` re-runs the effect and is
  derived, so `reachPending` cannot stick; preview results and 503 refusals
  are keyed to (draftId, key) so a late answer is never reviewed or sent under
  other inputs; the filters are frozen while a Preview is in flight; aborted
  loads (StrictMode, property change) settle nothing; property edits are
  owned per property and reset on a different pick.
- Review: rows start from the server's `checkedByDefault` only (missing flag
  = unchecked); Select all re-applies it; hand picks (added or promoted) are
  seeds with default = consent; the add-a-tenant cues use the org-wide
  `tourHolds` list.
- App-wide consumers: results and list projections normalize legacy rows
  through `wireAudienceFilter`; the dashboard summary joins the list; no job,
  importer, org rewrite or fan-out reads `audience_filter`; `listByStatus`'s
  only other callers (`routes/tours.ts`, the auto-close sweep) are unchanged;
  `listByHousingAuthority` has no runtime caller (kept on purpose); the
  property picker filter lives only in the composer (`UnitSearchField` is
  client-side over the candidates it is given; its other two users are
  untouched); the lean e2e world seeds no tours, so no hold can time-bomb a
  lean spec.
- Item size: up to 100 x 120-char authority names (~12 KB) still fits beside
  the 1000-slot recipients map and 1000 seed ids under the 400 KB item cap.

## Round 2

Re-review of fix wave 2 and micro-wave 3: `git diff b1bb9dc9..dc073cc7`
excluding docs/superpowers (code commits f0b33c94, da45d910, 088a12f8,
44a0263a, c0a3bc9c, 6636816c, 104d4083). Line numbers below are at
dc073cc7. Read-only as before; no suite, typecheck, lint or e2e was run (the
planner's e2e:session lane owns the worktree). Beyond this file, the only
docs/superpowers file read is `planner-review/adjudications.md`.

### Summary

| Severity | Count | IDs |
|----------|-------|-----|
| blocking | 0 | - |
| high     | 0 | - |
| medium   | 0 | - |
| low      | 1 | R2-1 |
| info     | 5 | R2-2, R2-3, R2-4, R2-5, R2-6 |

Contested round-1 adjudications: none (PA-1, PA-2, PA-3 and the PA-9 fold
are conceded, one line each below).

The hold is sound on the questions asked. It does not stick after a
successful retry, it does not leak an unfiltered draft or send, and it does
not block what it must not (details under "Hold - checked and sound"). The
findings are about how the hold READS while it lasts.

### Findings

#### R2-1 (low) - "Try again" gives no in-flight state and no failed-again signal, and a second click restarts the read

- Where: `dashboard/src/routes/broadcasts/AudienceFilters.tsx:239-245` (the
  notice and its button: never disabled, no busy text);
  `dashboard/src/routes/broadcasts/BroadcastComposer.tsx:248-251` (the
  property retry bumps `unitRetry`; the list retry is `orgList.reload`),
  `:403-404` (the load effect's cleanup aborts the read in flight when
  `unitRetry` changes); `dashboard/src/routes/orgs/useOrgList.ts:77-78`
  (`load()` aborts the read in flight first).
- Scenario 1 (failed again): staff click Try again and the read fails again.
  For the list, `setError(true)` / `setLoading(false)` set values that are
  already set, so React bails out and nothing re-renders. For the property,
  a new `{status: 'failed'}` object re-renders the same `<p key={text}>`.
  Either way the alert node and its text are unchanged. Nothing moves on
  screen, and a screen reader does not re-announce an unchanged alert.
  "Clicked, it failed again" cannot be told from "the click did nothing".
- Scenario 2 (slow network): a retry takes 8 s. Nothing shows it is in
  flight, so staff click again at 4 s. That click aborts the first read and
  starts afresh, and so does every click after it. A read slower than the
  user's patience never lands. That is the R1-ADV-FE-5 failure `useOrgList`
  documents (its `poll()` exists to avoid it), now reached through clicks.
- Contrast: the compose step's own 503 Try again
  (`BroadcastComposer.tsx:520-552`, `:817`, `:837`) is disabled with
  "Loading..." while busy. It also clears and re-sets its refusal, so a
  repeat failure remounts the alert. The new hold follows neither pattern,
  and the unit tests pin only that the notice "stays"
  (BroadcastComposer.test.tsx, the two "fails again" cases).
- Direction: keep a per-notice `retrying` flag (button disabled and reading
  "Trying again..." while the read runs), and give a repeat failure a new
  identity (for example a failure counter in the key, or clear-then-set) so
  the alert re-announces. A list retry could skip `reload()` while a read
  is already in flight.

#### R2-2 (info) - During a failure hold the reach line still says "Estimating reach..."

- Where: `dashboard/src/routes/broadcasts/AudienceFilters.tsx:273-274`;
  `dashboard/src/routes/broadcasts/useComposerDraft.ts` (`reachPending:
  input.hold === true || reachPending`).
- The FW2-1 change removed the spinner and the "Sizing the audience" hint
  beside Preview, because only Try again ends a failure hold. The same
  reasoning applies to the reach line, which keeps reading as progress
  ("Estimating reach...") for as long as the hold lasts, directly above the
  alert that says nothing will happen until Try again. The composer comment
  above the Preview hint (`BroadcastComposer.tsx:840-847`) records it as
  intended ("the reach line stays pending"). This entry records that it
  contradicts FW2-1's own rationale.
- Direction: while `heldOnFailedRead`, have the reach line read "Reach
  estimate unavailable" (the existing copy) or nothing.

#### R2-3 (info) - A stale draft error from an earlier property stays on screen beside the hold

- Where: `dashboard/src/routes/broadcasts/useComposerDraft.ts:177` (the hold
  returns before any reset), `:179-189` (the no-message reset clears reach,
  truncated, stale and draftKey, but not `error`);
  `BroadcastComposer.tsx:801-804` (the error alert).
- Scenario: pick property A; its draft create fails on the network and shows
  "Couldn't estimate the audience - try again.". Click Change and pick B,
  whose load fails. Compose now shows two alerts with different remedies:
  the hold notice ("Couldn't load the property ... Try again") and A's stale
  estimate error. The error survives because the no-message branch never
  clears it, and the hold then keeps the effect from reaching
  `setError(null)`.
- This needs two consecutive failures. The leftover error is pre-existing;
  the hold only extends how long it shows.
- Direction: clear `error` in the no-message branch, or hide the draft error
  while `heldOnFailedRead`.

#### R2-4 (info) - "Add more tenants by filters" during an outage turns a working direct send into a hold with no way back

- Where: `BroadcastComposer.tsx:489-499` (`onEnableFilters`, a one-way flip),
  `:246` (the hold).
- Scenario: staff open "Send a property" from a tenant's or caseworker's
  page (`?contactId=`) while GET /api/organizations is failing. The 1:1 send
  works, since seeds-only is never held. They click "Add more tenants by
  filters". The composer holds until the list loads, and the flip cannot be
  undone, so the 1:1 send they came for is unreachable until a page reload.
  Not a leak (it fails closed as decided), just a dead end staff can walk
  into.
- Direction: none required. If revisited, a "Back to sending to <name> only"
  control while a hold shows would cover it.

#### R2-5 (info) - A `?unitId=` that does not exist now holds with a Try again that can never succeed

- Where: `BroadcastComposer.tsx:393-401` (any non-abort error is "failed"),
  `:70-71` ("... can't be filled in yet."); `app/src/routes/units.ts:845-847`
  (404 `unit_not_found` for a hard-missing id; soft-deleted units still load).
- Scenario: a stale link or a hand-edited URL with an id that does not exist.
  The notice says the property could not be loaded "yet" and offers Try
  again, which answers 404 every time. Before AR44 this reached a dead end
  too (the create's 404 became "Couldn't estimate the audience - try
  again."), so this is no regression. The new copy just promises a retry
  that cannot help.
- Direction: on an `ApiError` 404, say "This property was not found." with
  no Try again.

#### R2-6 (info) - The PA-5 guard covers the list and results only

- Where: `app/src/lib/blastAudienceRules.ts:222-225` (overloads; the
  `AudienceFilter`-typed overload claims a defined result for a value that is
  undefined at runtime); `app/src/routes/broadcasts.ts` preview and path (c)
  still pass `broadcast.audience_filter` into `resolveAudience`, which reads
  `filter.excludeOptedOut` (`audienceResolution.ts:183`).
- Effect: a stored draft with no filter still 500s on its own Preview or
  no-body Send. Main threw there too, and only that one row is affected, so
  the page-wide failure PA-5 named is fixed. Recorded so nobody reads the
  overload as "every reader tolerates a missing filter".
- Direction: none required.

### Contested adjudications

- PA-1 (FILE, low): conceded. Label-only, and the filed issue carries the
  shared-helper direction.
- PA-2 (NOTE): conceded. It is a spec-gate cost decision Cameron approved,
  and nothing in this wave changes its inputs.
- PA-3 (FILE, low): conceded. The severity rule (a double text is high at
  most, fix only if small) fits, and the fix touches the prior-recipient
  walk.
- PA-9 (folded into AR44): conceded. A stalled read now ends in the same
  hold once the edge times out. R2-1 covers what is still missing (no
  in-flight state once Try again runs).
- PA-4, PA-6, PA-7, PA-8 (NOTE): no contest.

### Hold - checked and sound

- Sticking. A successful property retry writes `{unitId: id, loaded}` for
  the id the effect ran with, so `unit` is non-null and `prefillPending`
  drops. A successful list retry sets `error: false`, so `orgListHold` drops.
  The draft hook re-runs on `input.hold` and makes exactly one draft (the
  key differs from `lastKeyRef`). Preview re-enables once that draft lands.
  The message prefill effect needs only `unit`, so a property retry also
  fills the body.
- Retry racing a property change. Change and a new pick abort the retried
  read in the effect cleanup, and its catch returns on `signal.aborted`. A
  different pick derives `loaded` as null (id mismatch), so the hold waits
  with no stale notice. Picking the same failed property again resets it
  (`pickProperty`) and re-fetches.
- StrictMode and AbortError. Aborted reads settle nothing (both effects and
  `useOrgList` check `signal.aborted` / AbortError). The `setUnitRetry`
  updater is pure. A list reload in flight at unmount is aborted by the
  mount effect's cleanup, which reads `abortRef` at cleanup time.
- No leak. While held the hook makes no draft, and its previous run's
  cleanup bumped the generation, so an in-flight create is discarded and
  deleted. An older draft for another property cannot be previewed: Preview
  needs both `!prefillPending` and `draftKey === key`, and a late preview
  result fails `currentPreview`. The review step and Send are reachable
  only through a preview. Seeds-only drafts carry no filter and are never
  held, which is correct.
- Not over-blocking. `?contactId=` seeds-only, `?draftId=` resume and the
  property step are outside `prefillGated`. A property with no accepted
  authority is held only by its own failed load, never by a failed list
  read. The two holds show in sequence (the list hold needs a loaded unit),
  each with its own notice.
- Reachable on `?unitId=`: `prefillGated` is true there (effectiveUnitId is
  the param), and the new e2e drives exactly that entry with a routed 500.
- PA-5 consumers. `audienceSummary(undefined)` is the only dashboard reader
  of the now-optional `audience_filter` (BroadcastsList row label and delete
  aria-label, BroadcastResults header). The create echo always has a filter.
- "Not used" period: `endsWith('.')` avoids a doubled period, and
  `NOT_LIMITED` keeps its leading space.
