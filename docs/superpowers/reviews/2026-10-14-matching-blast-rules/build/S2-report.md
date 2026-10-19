# S2 - App rules in the routes - build report (feat/matching-blast-rules)

Implementer S2 (Claude Opus 5.5), 2026-10-18. Plan section 6, Tasks 2.1-2.5,
with worklist rulings OR-S2-1..4 and binding rulings AR6-AR12, AR21, AR30,
AR32. Base 133553a2 (S1 tip 28b600a3 + the worklist hand-down). Five task
commits, then this report. Run logs (gitignored): `.superpowers/sdd/S2-*.log`.

## Commits

| Task | Commit | One-liner |
|---|---|---|
| 2.1 | 4172121c | buildReviewRows / readOpenTourHolds / readAudienceRules; preview carries tourHold, checkedByDefault, tourHolds; filter preview 503; seeds_only degrade |
| 2.2 | c18aea28 | POST create's estimatedCount = the checkedByDefault rows; omitted on a thrown rules read |
| 2.3 | df5270d1 | send path (c) = resolved minus held minus declined; 503; cap on the final set; AR32/AR8 messages |
| 2.4 | 7b1139a1 | full-profile seeds: sent share keeps the legacy string, the draft holds a list |
| 2.5 | cdb6b7e4 | comments: byHousingAuthority kept but not read by blasts; router header; dep docs |

## RED / GREEN evidence

- Baseline before 2.1: `broadcastApi.test.ts` 129/129 (`S2-baseline.log`),
  DynamoDB Local answering (globalSetup created 22 tables).
- 2.1 RED: 15 failed / 123 passed (138). The candidate toEqual lacked
  `checkedByDefault`; two last-heard-from tests still carried
  `declineLabelsUnavailable`; the three converted degrade tests and two new
  503 tests got 200; the D4 kinds test (`expected undefined to deeply equal
  { kind: 'upcoming', ... }`), the flags test (`{ 'c-plain': undefined, ... }`),
  the ONE-read test (`listByStatus` called 0 times), the several-tours test,
  the legacy test (`[['c-aha', undefined]]`) and both seeds_only tests
  (toMatchObject on the missing `checkedByDefault` / `tourHold`). GREEN
  138/138; app typecheck 0; eslint 0.
- 2.2 RED: 6 failed / 139 passed (145): `expected 6 to be 2`, `expected 2 to
  be 1`, three `to not have property "estimatedCount"`, and the record read
  (`expected "get" to be called at least once`). The (PIN) past-1000 case
  passed. GREEN 145/145; `contactsBatchIncomplete` + `contactsBatchReads`
  19/19; app typecheck 0; eslint 0.
- 2.3 RED: 7 failed / 146 passed (153): the existing over-cap test (message
  still the old one), `expected 5 to be 3`, both 503s `expected 200 to be
  503`, empty `expected 200 to be 400`, cap `expected 400 to be 409`, and the
  1001 case (count 1002 and the U+2014 message). Both (PIN) cases (paths a,
  b) passed. GREEN 153/153; app typecheck 0; eslint 0.
- 2.4 RED: `seedOrgNames` 1 failed / 9 passed (10): the draft still read
  'Georgia Department of Community Affairs' where `undefined` was expected.
  GREEN `seedOrgNames` 10/10 + `seedMatrix` 51/51; app typecheck 0; eslint 0.
- 2.5 (AR11 grep gate): RED printed exactly the 7 predicted lines
  (`S2-t25-red.log`); GREEN printed nothing (exit 1). `git grep
  listByHousingAuthority -- app/src` shows the interface
  (`contactsRepo.ts:780`), the implementation (`:1392`) and S1's "KEPT"
  comment (`audienceResolution.ts:27`, not a call). eslint over the 9 files
  Task 2.5 Step 4 names: exit 0. The GSI (`app/src/lib/tables.ts:98`) and
  `listByHousingAuthority` code are untouched.
- Slice end (`S2-end.log`), the plan's slice-end set + `seedMatrix` + the S1
  set, one run: 12 files 418/418 - broadcastApi 153, toursRepo.integration
  80, seedMatrix 51, blastAudienceRules 49, audienceResolution 23,
  tourAutoClose 19, seedOrgNames 10, contactsBatchReads 10,
  contactsBatchIncomplete 9, repoPagingWiring 6, toursRepoListByStatusRange 4,
  followUpsApi 4 (= S1's 343 + 24 new broadcastApi + 51 seedMatrix).
  Extra: `rateLimit.test.ts` (touches the send route) 16/16.
- `npm run typecheck` (root) EXIT=0 (`S2-typecheck.log`); `npm run smoke`
  EXIT=0, 1707 specifiers across 297 emitted files (`S2-smoke.log`).
- ASCII: every task's added lines checked with
  `git diff -U0 ... | grep -P '^\+(?!\+\+).*[^\x00-\x7F]'` -> no output.

## Deviations from the plan text

- OR-S2-1 (AR32): Task 2.3's test and route use exactly
  `audience resolution was truncated - the audience could not be read completely`
  (a plain string; route `broadcasts.ts:1318`, test `broadcastApi.test.ts:731`).
  The test's comment adds "(plan AR32: no count)". The over-cap text is AR8's.
- OR-S2-2 (AR9): C-Edit 8 re-anchored on S1's last two "Audience:" lines and
  replaced them with R2-2's six-line text INCLUDING the fail-closed clause
  (`broadcasts.ts:19-24`). S1's D1/D2 lines are untouched.
- OR-S2-3: I-Edit 1 merged into S1's import (`broadcasts.ts:94-102`, one
  multi-line statement: authoritiesOfFilter, checkedByDefault as
  isCheckedByDefault, MAX_FILTER_AUTHORITIES, TOUR_REQUEST_HOLD_MS,
  tourHoldsByTenant, type TourHold, wireAudienceFilter). T-Edit 1 is the
  plain insert (S1 added no such import to the test file).
- OR-S2-4: one clause each on the `listingSendsRepo` and `toursRepo` dep docs
  (`broadcasts.ts:146-158`); the toursRepo one-line doc became a block. The
  grep gate re-run stays empty.
- AR30: the PowerShell blocks ran as Git Bash equivalents with absolute
  paths; the merge check used `git rev-parse --git-path MERGE_HEAD` (clean
  before every commit). Commit messages are the plan's, plus one paragraph
  naming the OR-id where a ruling changed the task (2.1, 2.3, 2.5).
- Nothing else: every other plan block applied as written; every anchor was
  where R2 found it.

## Contract S2 shipped (S3 / S4 consume)

### POST /api/broadcasts/:id/preview - 200

```
{
  count: number,                 // all review rows (post-union, pre-slice)
  truncated: boolean,
  candidates: Array<{            // at most MAX_BROADCAST_RECIPIENTS (1000)
    contactId: string, firstName?: string, lastName?: string, phone: string,
    voucherSize?: number, housingAuthority?: string, status?: string,
    lastHeardFromAt?: string,
    has_consent: boolean,
    alreadySentThisProperty: boolean,
    seeded: boolean,
    declinedThisProperty: boolean,
    tourHold?: { kind: TourHoldKind, tourId: string, at?: string },  // NEW
    checkedByDefault: boolean,                                       // NEW, always
  }>,
  priorRecipientContactIds: string[],
  seedContactIds: string[],
  unresolvedSeedIds: string[],
  declinedContactIds: string[],
  tourHolds: Array<{ contactId: string, kind: TourHoldKind, tourId: string, at?: string }>,  // NEW, always (maybe [])
  audienceRulesUnavailable?: true,                                   // NEW, only when true
}
```

- `checkedByDefault = has_consent && (seeded || (!alreadySent && !declined && !held))`,
  computed by `buildReviewRows` (`broadcasts.ts:743`). A seed is checked
  whatever its flags (and keeps its labels); a no-consent row never is.
- `tourHold` is the ONE picked hold (D4 kind order, then date, then tourId)
  for the contact's unresolved tours on ANY property; absent when none.
  `TourHoldKind` = needs_placement | upcoming | needs_outcome | not_marked |
  no_show | requested. `at` is the tour's STORED ISO string (scheduledAt;
  createdAt for `requested`), absent when the tour has no readable date.
- `tourHolds` lists EVERY held contact org-wide, keyed by the tour's
  `tenantId` (any contact type) - not only the candidates (the analog of
  `declinedContactIds` for Add a tenant). Order is not a contract.
- `audienceRulesUnavailable: true` only for a `seeds_only` draft whose
  open-tours or decline read threw; that body then has `tourHolds: []`,
  `declinedContactIds: []`, no `tourHold` on any row, every row
  `declinedThisProperty: false` and `checkedByDefault = has_consent`
  (`alreadySentThisProperty` is still read). Absent on every other 200.
- REMOVED: `declineLabelsUnavailable` (never sent any more).

### 503 `{ error: 'audience_rules_unavailable' }` (exactly that body)

- Preview: any broadcast whose `audience_mode` is not `seeds_only` (absent =
  filter), whatever its status (AR12), when the open-tours read (four
  `listByStatus` calls) or - with a `unitId` - the #27 decline read
  (listing sends, then the unit's tours and the contacts batch) throws. No
  list is served. Order: the D7 stored-filter 422 (drafts only) runs FIRST,
  so a 422 outranks the 503. A filter draft with no property still reads
  tours and can 503.
- Send: path (c) only (no `recipientContactIds`, not `seeds_only`). Order:
  422 re-check, resolve, rules read (503), empty 400, cap/truncation 400 - a
  failed rules read outranks the empty and truncation refusals. The draft
  stays a draft; `markSending` is not called; nothing is enqueued. Paths (a)
  and (b) never read the rules and never 503.
- Create: NEVER 503 (see below).

### POST /api/broadcasts - 201

`{ broadcastId, status: 'draft', estimatedCount?: number, audience_filter: WireAudienceFilter, truncated: boolean, flyerUrl?: string }`

- `estimatedCount` = the number of `checkedByDefault` review rows (the same
  function the preview serves, all rows - not capped at 1000); stored as
  `stats.audience`.
- `seeds_only` (seeds and no `audience_filter` in the body): no rules or
  already-sent reads; always present = seeds with recorded consent (may be 0).
- Filter draft: present unless the open-tours read or (with a `unitId`) the
  decline read threw; then OMITTED, the draft is still created,
  `stats.audience` is 0, the audit payload has no `estimatedCount`, and
  `truncated` still carries the resolution's flag. Any other thrown read
  (resolver, a seed's getById) is a 500 as before.

### 422 for a stored list (S1's, unchanged by S2)

Preview of a draft (not seeds_only) and send path (c):
`{ error: 'org_not_on_list', field: 'audience_filter', text, candidates, close, otherKind?... }`
where `text` is the FIRST member of the stored list in
`authoritiesOfFilter` order (trimmed; a legacy row's string is its one
member) that is not EXACTLY a listed housing authority name. A stored
spelling that resolves names that one entry as the only candidate
(`close: []`). At create the 422 is `orgNames.checkList`'s first failing
member (`text` = that trimmed member) - AR20: the dashboard removes the
member whose trimmed value equals `text`.

### Send path (c) messages and counts

- 400 `audience_too_large`, truncated: message
  `audience resolution was truncated - the audience could not be read completely`.
- 400 `audience_too_large`, over the cap: message
  `audience of ${n} exceeds the 1000 recipient cap - narrow the housing authority and/or bedroom-size filter`.
- `count` in both is now the FINAL set size (after the held/declined
  exclusions), no longer the resolver's count. Empty final set: 400
  `{ error: 'empty_audience' }`. Path (a)'s own over-cap text is unchanged.

### Seeds (full profile)

`broadcast-mx-sent-01` keeps `housing_authority: 'Atlanta Housing Authority'`
(legacy, `matrix.ts:1229`); `broadcast-mx-draft-01` stores
`housing_authorities: ['Georgia Department of Community Affairs', 'DeKalb County Housing Authority']`
(`matrix.ts:1264`). The wire shows both as `housing_authorities`.

### Router internals (private)

`AudienceRulesUnavailableError(truncated, options?)` with `readonly truncated`
(`broadcasts.ts:497`, AR6); `readOpenTourHolds(nowMs)` (`:692`);
`readAudienceRules(unitId, nowMs)` (`:710`, AR7); `buildReviewRows(input,
'preview' | 'estimate')` (`:743`); `ReviewInput` / `ReviewRow` /
`ReviewRowsResult` (`:507-536`). `priorRecipientKeys` stays the never-throwing
soft hint.

## Surprises / notes

- N1: on this host the brief's `grep -n '\\u' <file>` loses its backslash in
  Git Bash and matches every line holding a `u`; `grep -cF '\u' <file>`
  works. Every S2-touched file has 0 literal backslash-u before and after.
- N2: the GREEN `listByHousingAuthority` grep prints three lines, not two:
  S1's "KEPT" header comment at `audienceResolution.ts:27` is the third.
- N3: create on a filter draft now runs the open-tours read (4 Query walks),
  the decline read (with a `unitId`) and `priorRecipientKeys` (with a
  `unitId`) on every create, as D8 says; tests that spy before a create see
  those calls (the existing ones spy after, or assert on unaffected reads).
- N4: a non-draft filter share's preview (API only) reads the rules too and
  can 503 (AR12); the 422 re-check still applies to drafts only.

## Not done

Nothing in S2 scope. No dashboard or e2e file touched; no root `npm test`,
no e2e run (per the brief).
