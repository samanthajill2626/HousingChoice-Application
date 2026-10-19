# S1 - App foundations - build report (feat/matching-blast-rules)

Implementer S1 (Claude Opus 5.5), 2026-10-18. Plan section 5, Tasks 1.1-1.5,
with worklist rulings OR-S1-1..3. Base bf9dbacb. Five task commits, then this
report. Run logs (gitignored): `.superpowers/sdd/S1-*.log`.

## Commits

| Task | Commit | One-liner |
|---|---|---|
| 1.1 | 4f2a017e | pure rules module `app/src/lib/blastAudienceRules.ts`; `AudienceFilter.housing_authorities` |
| 1.2 | d9cae3b3 | `toursRepo.listByStatus(status, { createdAtFrom })` + harness fake + DynamoDB Local twin |
| 1.3 | e0d012e8 | resolver reads searching then onboarding; authorities any-of in memory; route D1 pin |
| 1.4 | dbc80324 | POST create parses and checks the list; legacy body; 201 wire echo; OR-S1-3 table |
| 1.5 | c08c6614 | storedFilterRefusal over every member; results/list wire filter; router header |

f62cc62f (between 1.3 and 1.4) is the planner's AR43 label-copy commit, not
S1's. Checked: label text only (S3/S4); nothing S1 shipped changes.

## RED / GREEN evidence

- 1.1 RED: the file fails to load ("Cannot find module
  '../src/lib/blastAudienceRules.js'" / "Failed to load url"), no test runs.
  GREEN 49/49 (the D4 `it.each` = 25 rows). typecheck 0, eslint 0, ASCII 0/0/0.
- 1.2 RED: 3 failed / 1 passed of 4. Both repo cases received
  `KeyConditionExpression: '#st = :st'` with no `#ca` / `:from` (option
  ignored); the fake returned all three tours; the (PIN) passed. GREEN: 4 files
  109/109; `toursRepo.integration` RAN (80 = 79 + 1), never SKIPPED.
- 1.3 RED: 13 failed / 120 passed (133). audienceResolution 12 of 23: D1 x6
  (all 7 statuses resolved, onboarding before searching), D2 x4 (list ignored;
  the legacy case shows `haQueries ['HA-A']`), the leaky fence
  (`['c-s','c-o','c-placing']` - c-placing, NO duplicates, OR-S1-2), the log
  case (no `authorities`). broadcastApi: only the new D1 pin (estimatedCount 7).
  Green at base (pins of unchanged behavior): soft-delete PIN, empty list, D10
  partner, the 8 older fence cases. GREEN: 6 files 205/205.
- 1.4 RED: 12 failed / 111 passed (123). The two updated legacy tests (echo and
  stored still `housing_authority`); 8 of the plan's 9 new tests (list ignored:
  both-keys, shape and both 422 tests got 201; stores-names and 100-member found
  no `housing_authorities`; legacy body read the string; the estimate counted
  4). OR-S1-3 rows: null-as-absent RED (stored `housing_authorities`
  undefined), both-keys RED (422 at base - 'y' is not on the list); the blank
  and non-string legacy rows are PINs (today's 400). The (PIN) 400/404 and the
  (PIN) empty list passed. GREEN: 4 files 165/165.
- 1.5 RED: 5 failed / 124 passed (129). Both previews answered 200, the send
  200 `sending`, results and list carried `housing_authority`; the (PIN) exact
  list passed. GREEN: 7 files 234/234 (legacy re-check fixtures included);
  `npm run smoke` exit 0 (1707 specifiers, 297 files).
- Slice end (`S1-end.log`): 11 files 343/343 - blastAudienceRules 49,
  toursRepoListByStatusRange 4, toursRepo.integration 80, tourAutoClose 19,
  repoPagingWiring 6, audienceResolution 23, broadcastApi 129,
  contactsBatchReads 10, contactsBatchIncomplete 9, followUpsApi 4,
  seedOrgNames 10. Against the baseline: the 8 baseline files 149 -> 161
  (audienceResolution 12 -> 23 by the rewrite, toursRepo.integration 79 -> 80);
  broadcastApi 109 -> 129 (+1 in 1.3, +13 in 1.4, +6 in 1.5).
- `npm run typecheck` EXIT=0 (`S1-typecheck.log`). eslint over all 11
  `.ts` files in `main...HEAD`: exit 0.

## Deviations from the plan text

- OR-S1-1: preflight `npm ci` skipped; DynamoDB Local answered (curl 400), so
  no `db:start`; no run used `ALLOW_SKIP_DYNAMO_TESTS`.
- OR-S1-2: Task 1.3's RED reason recorded as c-placing only (see above).
- OR-S1-3: ADDED at the END of Task 1.4's describe (the plan block above it is
  verbatim): `it.each(PARSE_EDGES)('AR3 parse edge: %s', ...)`, 4 rows
  (`app/test/broadcastApi.test.ts:2596`, `:2622`). A first draft used `$label`
  titles; vitest truncates `$var` at 40 chars with quotes and a non-ASCII
  ellipsis, so it uses the plan's own Task 1.1 shape (`Array<[string, row]>`
  + `'%s'`, verbatim ASCII titles).
- Commit messages are the plan's, plus one paragraph naming OR-S1-2 (1.3),
  OR-S1-3 (1.4) and AR9 (1.5). The merge check used
  `git rev-parse --git-path MERGE_HEAD` (the brief's form); clean every time.
- Nothing else: every plan code block applied byte-for-byte; every anchor was
  where R1 found it.

## Contract S1 shipped (S2 / S3 consume)

### `app/src/lib/blastAudienceRules.ts` (pure, no I/O) - binding 2.1 exactly

- `TOUR_REQUEST_HOLD_MS = 14 * 24 * 60 * 60 * 1000` (:16)
- `BLAST_TENANT_STATUSES = ['searching', 'onboarding'] as const satisfies readonly TenantStatus[]` (:19)
- `MAX_FILTER_AUTHORITIES = 100` (:22)
- `type TourHoldKind` (:25); `TOUR_HOLD_KIND_ORDER: readonly TourHoldKind[]`
  = needs_placement, upcoming, needs_outcome, not_marked, no_show, requested (:34)
- `interface TourHold { kind: TourHoldKind; tourId: string; at?: string }` (:45)
- `interface TourHoldInput { tourId: string; tenantId: string; status: unknown;
  scheduledAt?: unknown; createdAt?: unknown; outcome?: unknown; convertible?: unknown }`
  (:52) - a stored `TourItem` satisfies it (typechecked by the test file).
- `tourHoldOf(tour: TourHoldInput, nowMs: number): TourHold | undefined` (:91).
  `at` is the STORED string as is (scheduledAt; createdAt for `requested`), so
  tests comparing `at` must store ISO strings. Unreadable scheduledAt -> no
  `at`; unreadable or missing createdAt on a request -> no hold; a request
  exactly 336 h old -> no hold; scheduled at exactly now -> `not_marked`.
- `pickTourHold(holds: readonly TourHold[]): TourHold | undefined` (:136)
- `tourHoldsByTenant(tours: readonly TourHoldInput[], nowMs: number): Map<string, TourHold>`
  (:148) - a tour with an empty or non-string tenantId is skipped.
- `interface DefaultCheckFlags { hasConsent; seeded; alreadySent; declined; held: boolean }`
  (:167); `checkedByDefault(f: DefaultCheckFlags): boolean` (:178)
- `authoritiesOfFilter(filter: Pick<AudienceFilter, 'housing_authorities' | 'housing_authority'> | undefined): string[]`
  (:186) - a present array wins even when empty (trimmed, blanks and
  non-strings dropped, first-wins de-dup); else the trimmed legacy string;
  else `[]`.
- `interface WireAudienceFilter` (:207); `wireAudienceFilter(filter: AudienceFilter): WireAudienceFilter` (:219)

`AudienceRulesUnavailableError` is NOT shipped by S1 (S2 Task 2.1, AR6).

### `AudienceFilter` (`app/src/repos/broadcastsRepo.ts:77-98`) - binding 2.2 exactly

`housing_authorities?: string[]` added; `housing_authority?: string` kept,
`@deprecated`, read only through `authoritiesOfFilter`.

### `toursRepo.listByStatus` - binding 2.3

`listByStatus(status: string, opts?: { createdAtFrom?: string }): Promise<TourItem[]>`
(`app/src/repos/toursRepo.ts:225`, impl `:442`). With the option:
`KeyConditionExpression '#st = :st AND #ca >= :from'`, names
`{ '#st': 'status', '#ca': 'createdAt' }`, values `{ ':st', ':from' }`, every
page walked. Without it: byte-identical to before (PIN). Harness fake
`app/test/helpers/twilioWebhookHarness.ts:3964`: `createdAt >= from`
inclusive, createdAt ascending. No other implementer exists (grep).

### Resolver (`app/src/services/audienceResolution.ts`) - binding 2.4 + AR4

Signature and `ResolvedAudience` unchanged. Reads
`listByType('tenant', { status, limit: pageSize, exclusiveStartKey? })` for
each of `BLAST_TENANT_STATUSES`, searching then onboarding (:153, :163);
`maxPages` counts pages across both; `truncated` = the bound stopped the walk
with a page unread in the current or a later partition (:157-160). Belts: a
non-tenant row is skipped (:174); a row whose status is not the partition's is
skipped (:177, AR4). Authorities: `new Set(authoritiesOfFilter(filter))`
(:147), any-of on the trimmed `housingAuthority`; while non-empty, a missing,
blank or non-member authority is left out (:188-195).
`listByHousingAuthority` is never called (pinned). Log
`broadcast audience resolved` = `{ count, authorities: <list size>, bedroomSizeFilter, truncated }`
(:229-237); the page-cap warn text is now ASCII
(`audience resolution hit the page cap - audience may be truncated`, :225).
Every other fence unchanged.

### Wire and router (`app/src/routes/broadcasts.ts`)

- Import (:90):
  `import { authoritiesOfFilter, MAX_FILTER_AUTHORITIES, wireAudienceFilter } from '../lib/blastAudienceRules.js';`
  - S2's I-Edit 1 merges into this line (OR-S2-3).
- `parseAudienceFilter` (:155), in order: not-an-object 400 and contact_type
  400 (unchanged); BOTH keys non-null -> 400
  `{ error: 'audience_filter: use housing_authorities only' }` (decided before
  either shape); list given and not an array, more than 100 RAW members, or
  any non-string member -> 400
  `{ error: 'audience_filter.housing_authorities must be an array of at most 100 strings' }`;
  legacy given (list absent or null) and non-string or blank -> 400
  `{ error: 'audience_filter.housing_authority must be a non-empty string' }`;
  bedroomSize 400 unchanged. `null` = absent for both keys. Result carries
  `housing_authorities` (normalized by `authoritiesOfFilter`) only when
  non-empty, and never `housing_authority`.
- POST create list check (:677-695): only when the parsed list is non-empty,
  `orgNames.checkList('audience_filter', list, undefined, undefined)` (one list
  read). Not ok -> 422 = checkListWrite's FIRST failing member,
  `{ error: 'org_not_on_list', field: 'audience_filter', text: <trimmed member>, candidates, close, otherKind?, compound? }`,
  no row, no audit. Ok -> stored `housing_authorities = check.value` (entry
  names, de-duplicated). It sits ABOVE the estimate (:697, today's math; S2
  replaces it).
- 201 (:738-750): `audience_filter: wireAudienceFilter(created.audience_filter)`;
  `estimatedCount` and `truncated` unchanged. S2's anchors `status: 'draft',` /
  `estimatedCount: estimatedAudience,` (:740-741) and the audit/log lines
  (:732, :735) are byte-identical to base.
- `storedFilterRefusal` (:586) - signature unchanged
  `(filter: AudienceFilter | undefined) => Promise<OrgNotOnList | undefined>`;
  walks `authoritiesOfFilter(filter)` in order; one `orgNames.read()`, only
  when non-empty; the first non-exact member -> checkScalarWrite's 422, or the
  spelling 422 naming its entry as the one candidate.
- Results (:429) and list (:458) projections:
  `audience_filter: wireAudienceFilter(b.audience_filter)`.
- Wire filter shape (create echo, results, list):
  `{ contact_type: 'tenant', housing_authorities?: string[] (non-empty only), bedroomSize?: number, excludeOptedOut: boolean, excludeUnreachable: boolean }`;
  never `housing_authority`.

### Router header (AR9) - final text, `app/src/routes/broadcasts.ts:14-35`

```
// Audience: a FILTER resolves TENANT 1:1 contacts ONLY (never relay-group
// rosters), and only tenants in Onboarding or Searching (matching-blast-rules
// D1), narrowed by ANY of a list of housing authorities (D2) and/or exact
// bedroom size; hand-picked seeds and an explicit recipient list may also
// name PARTNERS, of any status (spec 2026-10-06 D20).
// Opted-out + unreachable are ALWAYS excluded. The send fans out through the
// SHARED A2P throttle (the broadcast.send job + worker a2pBucket).
//
// Organization names (spec 2026-10-06 D5; matching-blast-rules D2): POST
// answers 422 org_not_on_list (field `audience_filter`, `text` = the FIRST
// failing member) when a member of audience_filter.housing_authorities - or
// the LEGACY one-string housing_authority, read as a one-member list - is not
// a housing authority on the stored org list; a unique spelling is stored as
// the entry's exact name, and the 201 echoes the stored filter in the wire
// shape (wireAudienceFilter: housing_authorities, never housing_authority),
// as do the results and list views. Preview of a DRAFT and the
// filter-resolving send (no recipientContactIds, not seeds_only) re-check
// EVERY member of the STORED list (D7; authoritiesOfFilter, so a legacy row's
// string is its one member): each must be EXACTLY a listed name, else the
// same 422 for the first that is not, where a stored spelling names its entry
// as the one candidate. The curated send, seeds_only drafts and non-draft
// previews are never re-checked; nothing rewrites a broadcast.
```

OR-S2-2's two re-anchor lines are :19-20, each unique in the file. S2 owns
:6-12 and only ADDS its tour-hold / fail-closed sentence.

### Test-file facts for S2

- `app/test/broadcastApi.test.ts` still has exactly one line that is `});`
  (its last, :3078); S1's new blocks close with an indented `  });`.
- The D1 route pin is :250 (before `share-skip-fix D4`); the Task 1.4 describe
  `matching-blast-rules D2: housing_authorities at draft create` is :2427 and
  the Task 1.5 describe `matching-blast-rules D2: stored lists at preview,
  send and the projections` is :2643, both before the caseworkers block.
- The Task 1.4 estimate test and the D1 route pin use consented, hold-free
  tenants, so their count of 2 stays valid under D8.

## Surprises / notes

- N1 (consistent with binding 2.4): when maxPages runs out exactly at the end
  of `searching`, `truncated` is true even if `onboarding` would be empty - an
  unread first page counts as unread. Latent at 50 pages x 200.
- N2: the D1 route pin seeds c-onb BEFORE c-sea, so its `['c-sea','c-onb']`
  preview order proves the partition read order at the route (the harness
  contacts fake returns seed order inside one status).
- N3: per AR3 the legacy key keeps its strict 400 for a blank string, while a
  list of blanks is no filter (201); both pinned. S3 sends
  `housing_authorities`, whose blanks are dropped silently.
- N4: vitest `it.each` `$var` titles truncate at 40 chars and insert a
  non-ASCII ellipsis; use `'%s'` tuples where titles must be ASCII.
- Expected mid-build breakage (plan section 3, AR5): the dashboard's
  `audienceSummary` shows no authority until S3 Task 3.1, and e2e Matching
  specs that rely on tenants outside Searching/Onboarding or without an
  authority fail until S4. Neither was run here (no root `npm test`, no e2e,
  no dashboard tests, per the brief).

## Not done

Nothing in S1 scope.
