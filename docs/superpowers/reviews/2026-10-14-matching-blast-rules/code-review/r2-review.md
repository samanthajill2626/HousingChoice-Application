# Code review round 2 - fresh reviewer - feat/matching-blast-rules

- Branch HEAD: 0be33fef (merge base a2b3d80d = main; 0 behind). Worktree
  `W:/tmp/matching-blast-rules`, tree clean before and after this review.
- Inputs read in full: `.superpowers/review/r1-package.diff` (feature diff at
  53a13055, cross-checked against the live tree), `.superpowers/review/fw1-package.diff`,
  `r1-adversarial.md`, `r1-conformance.md`, `r1-adjudications.md`,
  `fix-wave-1-report.md`, AGENTS.md. Main-side code read with `git show main:<path>`.
  Spec read ONLY at D3 and D8, to check the ADV-2, ADV-6 and ADV-8 adjudications
  that cite them. No other design document opened.
- Baseline (this review, before any throwaway file): app
  `audienceResolution`, `blastAudienceRules`, `toursRepoListByStatusRange`,
  `broadcastApi` - 4 files, 233 passed, exit 0; dashboard
  `src/routes/broadcasts/` - 16 files, 312 passed, exit 0.
- Method for mutants: a COPY of the module beside the original (so its
  relative imports resolve), wired in by a throwaway vitest config with ONE
  `resolve.alias` (the app config also drops `globalSetup`, the files are
  in-memory); identity copy green first, then the mutant; the anchor must
  occur exactly once. No tracked file was edited.

## Counts

| Severity | New (section 1) | Fix-diff (section 2) |
|---|---|---|
| BLOCKING | 0 | 0 |
| HIGH | 0 | 0 |
| MEDIUM | 0 | 0 |
| LOW | 1 (R2-1, pre-existing) | 0 |
| INFO | 1 (R2-2) | 2 (FW-1, FW-2) |

Adjudication challenges: 2 (ADV-2 scope, ADV-1 mitigation scope), both
narrow; no ruling reversed. Fix verification: 6 of 6 fixes REAL (4 proven by
mutation here, 2 doc/comment-only read).

## 1. NEW findings (what round 1 missed)

### R2-1 - LOW - CONFIRMED (pre-existing, carried into the rewritten preview) - Above the 1000-row preview bound a hand-picked seed is silently cut from Review recipients and is never texted; nothing says the list is short, and the send of what is shown is accepted

- Where: `app/src/routes/broadcasts.ts:780` builds the rows as audience rows
  FIRST, seeds LAST; `:1054` slices them to `MAX_BROADCAST_RECIPIENTS`
  (1000); `:1098`/`:1110` report only the resolver's `truncated`, which is
  false when the read completed; `:945` counts every default-checked row for
  "Reaches N". Path (a) accepts any explicit list of at most 1000 ids
  (`:245`).
- Trigger: a filter blast whose resolved Searching/Onboarding audience in the
  selected authorities and size exceeds 1000 rows, with a hand pick - the
  `?contactId=` tenant after "Add more tenants by filters", or any draft seed.
- Effect: "Reaches 1002 recipients", Review recipients lists exactly 1000
  rows with NO notice (truncated false), the staff member's own hand pick is
  not among them, and "Send to 1000 recipients" succeeds - the hand pick is
  never texted and nobody is told. The spec's D8 line "above 1000 the send is
  refused anyway (the recipient cap)" is contradicted: only the no-body path
  (c) refuses; the dashboard's path (a) does not.
- Proof: throwaway `app/test/zz-review-r2-5.test.ts` (1001 consented
  Searching tenants plus one consented Placing seed `c-seed`): create 201 with
  `estimatedCount` 1002; preview `count` 1002, `candidates` length 1000,
  `truncated` false; `POST /send` with the 1000 shown ids 200 and the stored
  recipients map holds 1000 keys; the final assertion (the expected behavior)
  FAILS: `expected [ 'c-big-0000', 'c-big-0001', ...(998) ] to include 'c-seed'`.
  The same file run against MAIN's `broadcasts.ts` (a byte copy aliased in for
  `./broadcasts.js`) fails at the same assertion with the same message, so this
  is NOT a regression of this branch; round 1 missed it in the rewritten lines.
- Why it matters more now: D8 makes "Reaches N" the promise "the rows that
  start checked", and above the bound that promise silently breaks with no
  on-screen sign.
- Fix (recommend FILE; not a merge blocker - Phase-1 volume is far below 1000
  matching Searching/Onboarding tenants per authority): put the resolved seeds
  FIRST in the union at `:780` (the dashboard re-sorts by last heard from, so
  only the bound sees the order), and when `review.rows.length >
  MAX_BROADCAST_RECIPIENTS` flag the preview (reuse `truncated: true`, so
  RecipientPreview's existing "Too many tenants to read - some matches may be
  missing from this list." shows) and the create (`truncated`, so the reach
  line reads " - the list is incomplete"). Correct the D8 sentence.
- Regression test that must fail without the fix: the probe above - the seed
  is among `candidates` and `truncated` is true when `count >
  MAX_BROADCAST_RECIPIENTS` (today: seed absent, truncated false).

### R2-2 - INFO - PLAUSIBLE - The new prefill gate makes Preview wait on two reads that have no client timeout

- Where: `dashboard/src/routes/broadcasts/BroadcastComposer.tsx:228-229`
  (`prefillPending` waits for `getUnit` and the org list),
  `:561-568` (`canPreview` requires `!prefillPending`), `useComposerDraft.ts:176`
  (no draft while held); `dashboard/src/api/client.ts` `requestWithStatus` has
  no timeout. On main neither read gated compose.
- Trigger: `GET /api/units/:id` or `GET /api/organizations` that neither
  answers nor errors.
- Effect: "Sizing the audience..." with Preview disabled and no notice until
  the request fails; in prod a CloudFront origin timeout turns it into a 5xx,
  which settles the gate with its failure notice (D3). Bounded, so INFO.
- What would confirm: a stalled-response test (a `getUnit` mock returning a
  never-settling promise) shows the gate never lifts; no change recommended
  beyond knowing the dependency exists. No fix proposed.

## 2. Fix-wave diff findings (new code reviewed cold)

All six fixes were read line by line; the two code fixes introduce no changed
order and no lost case on the CURRENT server, and every new test can fail
(section 4). Two small items:

### FW-1 - INFO - CONFIRMED (by reading) - The filed ADV-4 issue's second suggested fix cannot work for the issue's own trigger

- Where: `docs/issues/matching-composer-422-unmatched-member-clears-filter.md`
  "Suggested fix", second bullet ("use the 422's `candidates` to map the
  stored name back to the on-screen member it came from").
- Why: `storedFilterRefusal` (`app/src/routes/broadcasts.ts:658-681`) puts in
  `candidates` the entry the STORED text resolves to - it maps forward, never
  back to the on-screen name. In the issue's trigger step 4, a DELETED Y gives
  `candidates: []`; a Y renamed to Z gives `[Z]`. Neither names the on-screen
  X, so that option cannot "remove only that one".
- Fix: drop the bullet, or replace it with the safe-but-stuck alternative:
  on a refusal whose text is not on screen, keep the on-screen list (never
  widen) and show the notice; staff remove a chip by hand.

### FW-2 - INFO - CONFIRMED (by reading) - ADV-3's fail-safe leaves a resolved 1:1 send blocked behind a misleading note in the rollback window

- Where: `dashboard/src/routes/broadcasts/RecipientPreview.tsx:142-143` (a
  missing flag checks nothing - seeds included) and `:210-212`, `:674-677`
  (`resolvedMismatch`).
- Trigger: rollback window only - an older server's preview of a `?contactId=`
  1:1 draft.
- Effect: the one seeded row starts unchecked, so Send is disabled under "This
  message was written for <name>. Head back to edit the audience or message."
  - the real remedy is to tick the row, which works. Safe (nothing is sent
  unchecked), only the copy misleads, only after a rollback. No change
  recommended; noted so the fail-safe's reach is on record.

Read and found sound: the ADV-5 `seen` set sits after every fence (first
RESOLVED row wins, as the fix-wave report itself says - the comment's "the
searching one" is the overwhelmingly common case); the CONF-6 comment matches
`broadcasts.ts:780` exactly at both sites; the CONF-2 tests' `enqueue` spy is
live (`configureOutboundQueue(queueAdapter)` makes `jobs.enqueue` call that
instance's method, so the assertion can fail); ADV-9 is one historical line;
the three issue files' refs resolve to the cited code at HEAD (checked line by
line). All added fix-wave lines are ASCII.

## 3. Adjudication challenges

### ADV-2 (FILE, Cameron's call) - agree with the venue; the filed issue is too narrow for the decision it asks for

- The same D3 "counts as settled" fail-open has a sibling the issue omits: a
  FAILED PROPERTY LOAD (`BroadcastComposer.tsx:231`, `:363-379`). There the
  draft carries neither housing authorities NOR a voucher size - wider than
  the org-list case - and a `?unitId=` entry has no retry: `pickProperty`'s
  reset (`:490`) serves picker entries only, and the Change control renders
  only when `unitId === undefined` (`:752`), so the remedy is a page reload
  that is not offered. (The pickers stay usable here, and the notice shows, so
  staff CAN rebuild the filter by hand - the difference from ADV-2.)
- A stale-list variant feeds the same decision: the composer reads the org
  list ONCE per mount (`BroadcastComposer.tsx:155`; `useOrgList.ts:107`, the
  composer never calls `reload`), so an authority added after the composer
  mounted maps to "Not used (not on the organization list)" and, when it is
  the property's only one, the blast is "not limited by housing authority".
  Option 2 of the issue (prefill verbatim, the create's `checkList` decides)
  closes this variant too; option 1 (hold + Try again) does not.
- Concrete harm and ask: under this mission's own scale the outcome is the
  BLOCKING class ("wrong people texted by default") once a staff member reads
  past a visible notice. FILE is the right venue (spec D3 decides it
  explicitly - verified), but the handback should put it to Cameron BEFORE the
  merge, with the property-load sibling and the stale-list variant in the same
  issue, since one decision (hold vs verbatim prefill) settles all three.

### ADV-1 (FILE + post-merge note) - agree; widen the mitigation's wording

- The dashboard is also an installed PWA (`dashboard/src/main.tsx:34`
  registers `/sw.js`; `dashboard/index.html:11` links the manifest). An
  installed app window is rarely reloaded and can run the old bundle for
  days, so "reload open dashboard tabs" should say "and relaunch installed
  dashboard apps (phones and desktop)". Also verified for the note: the old
  tab against the new server is never WORSE than pre-deploy - it sees the
  narrower D1/D2 audience, a 503 surfaces as the raw error code in its
  existing error line (main's composer prints `err.message`), and its legacy
  `housing_authority` body is accepted (`broadcasts.ts:200-206`).

### No challenge (verified)

- ADV-3, ADV-5, CONF-2, CONF-3, CONF-6, ADV-9 FIX: real (section 4).
- ADV-4 FILE: the trigger really needs two organization-list changes while
  one composer stays open (a single rename maps X to Y at create and Preview
  then passes; a deletion of X 422s with text X, which matches the screen) -
  rare; FILE stands (see FW-1 for the issue text).
- ADV-6 REJECT: the caption is Cameron's verbatim D8 copy (verified at spec D8).
- ADV-7, ADV-8, CONF-5 NOTE; CONF-1 ORCH: agree. ADV-8's per-create reads are
  bounded at today's volume (verified the reads: two partition walks, four
  tour Queries, the byUnit decline read, the byUnit share walk with record
  reads only for queued slots of finished shares).

## 4. Fix verification table

| Finding | Fix commit | Real or plausible | Evidence |
|---|---|---|---|
| ADV-3 | 2b503eed | REAL - both halves load-bearing | Identity copy 56/56. Mutant A (`(preview.tourHolds ?? [])` reverted): the new test fails `TypeError: Cannot read properties of undefined (reading 'map')`. Mutant B (`=== true` reverted on both lines): fails `expect(element).not.toBeChecked() - Received element is checked` at `RecipientPreview.test.tsx:1208` (after Select all). 55 others pass in each. |
| ADV-5 | 5bc9cfa8 | REAL | Identity copy 24/24. Mutant (the two `seen` lines removed): fails `expected [ 'c-mover', 'c-mover', 'c-o1' ] to deeply equal [ 'c-mover', 'c-o1' ]`. |
| CONF-2 | b58e5daf | REAL | Identity copy 155/155. M8 (empty and truncated refusals inserted right after path (c)'s `resolveAudience`): both new AR12 tests fail `expected 400 to be 503` (one older test also fails on the mutant's placeholder message). |
| CONF-3 | b58e5daf | REAL | Identity copy 5/5. M9 (`while (lastKey !== undefined && from !== undefined)`): the new PIN fails `expected [ 't1' ] to deeply equal [ 't1', 't2' ]`. |
| CONF-6 | af46ff63 | REAL (comment) | Both comment sites now state the order the code builds at `broadcasts.ts:780`. |
| ADV-9 | 763c7d24 | REAL (doc line) | One added line in `unknown-queue-cap-starves-needs-review.md`. |
| ADV-1, ADV-2, ADV-4 filed | 763c7d24 | Filed; refs accurate | Every cited `file:line` resolves at HEAD; content notes in FW-1 and section 3. |

## Swept and clean

- Server reads of the changed routes: create rethrows anything but
  `AudienceRulesUnavailableError` exactly as main did (seed, resolver, unit,
  org-list failures 500 as before); the rules failure omits only the estimate;
  `priorRecipientKeys` never throws; preview and path (c) fail closed on the
  rules reads, path (c) after the stored-filter re-check, before the empty and
  cap refusals (AR12, now pinned).
- `toursRepo.listByStatus`: the byStatus GSI range key IS `createdAt`
  (`app/src/lib/tables.ts:546-550`, terraform generated from it); `createdAt`
  is set by the repo at create (`toursRepo.ts:374`, an ISO instant) and no
  route can write it (the POST and PATCH allowlists, `routes/tours.ts:156`,
  `:159`), so the key-condition bound and `tourHoldOf`'s instant check agree; callers
  (`jobs/tourAutoClose.ts`, `routes/tours.ts`) pass one argument; a fake that
  ignored the bound would still be correct (the 14-day check is repeated in
  memory).
- Legacy and old data: every server reader of a stored filter goes through
  `authoritiesOfFilter`; results, list and the 201 echo answer the wire shape;
  the performance seed's seeds_only rows carry a filter; no script, job or org
  rewrite touches a broadcast's filter; resolved issues citing the GSI are
  historical.
- Old clients: the pre-deploy bundle's legacy body, missing
  `estimatedCount` ("Reach estimate unavailable"), absent
  `declineLabelsUnavailable` and the new 503 all degrade safely (ADV-1 is the
  one real window). After a rollback, a list-shaped draft read by the old
  server is "no authority filter", but the new bundle checks no row (ADV-3's
  fail-safe) and the old composer cannot preview a resumed draft without
  recreating it from its own filters - so not reachable as a default send.
- Composer races: create results gen-checked; a create 422 can only arrive
  while no material input changed, so `rejectAuthority` reads the same list
  the create sent; Preview results and 503 refusals keyed by draft and key;
  the hold drops pending debounces and in-flight creates; no unfiltered draft
  is made on the property step (the body is emptied on Change).
- Consumers swept repo-wide (app, dashboard, e2e, scripts, fake-twilio): the
  preview's new and removed fields, `estimatedCount?`, the wire filter,
  `stats.audience`, the replaced copy strings (none left), the
  `AudienceFilter` / `PreviewResponse` / `TourHold` types, and the
  `createAudienceResolutionService` callers (broadcasts only). e2e specs
  outside the diff that review recipients use seeds (checked whatever their
  holds) or create and publish their own properties.
- Security and PII: no new route; `tourHolds` is staff-only tour data already
  readable through the tours API; new log lines carry ids, counts and flags.
- ASCII: no non-ASCII character on any added fix-wave line.
- Pre-existing, unchanged, out of scope: concurrent Add-a-tenant PATCHes can
  land out of order (last write wins on the seed list); a message edit after
  hand picks recreates the draft without them.

## Throwaway files (all named zz-review-r2-*, deleted by exact name before the reply)

`app/zz-review-r2-vitest.config.ts`, `dashboard/zz-review-r2-vitest.config.ts`,
`dashboard/src/routes/broadcasts/zz-review-r2-1-RecipientPreview.tsx`,
`app/src/services/zz-review-r2-2-audienceResolution.ts`,
`app/src/repos/zz-review-r2-3-toursRepo.ts`,
`app/src/routes/zz-review-r2-4-broadcasts.ts`,
`app/test/zz-review-r2-5.test.ts`,
`app/src/routes/zz-review-r2-6-main-broadcasts.ts`, and under
`.superpowers/review/`: `zz-review-r2-main-broadcasts.ts`,
`zz-review-r2-main-composer.tsx` and the run logs `zz-review-r2-*.log`.
Mutation anchors and the copy helper live in the session scratchpad, outside
the worktree.
