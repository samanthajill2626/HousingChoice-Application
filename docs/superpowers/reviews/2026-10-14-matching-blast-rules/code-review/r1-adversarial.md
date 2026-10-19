# Adversarial code review - round 1 - feat/matching-blast-rules

- Branch HEAD: 53a13055 (merge base a2b3d80d, main). Package:
  `.superpowers/review/r1-package.diff` read in full; main-side code read with
  `git show main:<path>` (read-only). Design documents not opened (blind review).
- Baseline: `dashboard` `npx vitest run src/routes/broadcasts/` was green
  (21 files, 311 tests) in this worktree before any throwaway file was added.
- Throwaway files (all named `zz-review-adv-*`, all deleted before handback):
  `dashboard/src/routes/broadcasts/zz-review-adv-{1,2,3,4}.test.tsx`,
  `dashboard/src/routes/broadcasts/zz-review-adv-main-RecipientPreview.tsx`
  (main's RecipientPreview, byte-for-byte, so a test could render the
  pre-deploy bundle), `app/test/zz-review-adv-5.test.ts`, and their output
  captures under `.superpowers/review/`.

## Counts

| Severity | Count |
|---|---|
| BLOCKING | 0 |
| HIGH | 0 |
| MEDIUM | 2 |
| LOW | 4 |
| INFO | 3 |

## Findings (most severe first)

### ADV-1 - MEDIUM - CONFIRMED - A dashboard tab open across the deploy ignores the server's default-check rule, so tour-held tenants start checked and are texted

- Evidence: this branch moves the default-check rule to the server
  (`app/src/routes/broadcasts.ts:812`, sent as `checkedByDefault` and `tourHold`
  on every candidate at `:1084-1087`) and the new bundle reads it
  (`dashboard/src/routes/broadcasts/RecipientPreview.tsx:140-141`). The bundle
  already running in an open tab is main's, which recomputes the rule locally
  with no tour input (main `RecipientPreview.tsx:99` `defaultChecked`, applied at
  `:132` and by Select all at `:244`). Routes are imported statically
  (`dashboard/src/App.tsx`), the SPA never reloads itself, and there is no
  build-version check anywhere in `dashboard/src` (searched `version`, `buildId`,
  `location.reload`).
- Trigger (interleaving): (1) staff have the dashboard open on main's bundle;
  (2) `npm run deploy:prod` rolls the image (API and dashboard ship together);
  (3) staff open Send a property in the SAME tab, Preview: the new server
  answers a candidate with `tourHold` and `checkedByDefault: false`; (4) main's
  `initialRows` computes `hasConsent && (seeded || (!alreadySent && !declined))`
  = true; (5) Send posts the checked ids through path (a), which by design never
  re-applies holds (pinned by `broadcastApi.test.ts` "(PIN) path (a) ... a
  checked held or declined tenant is sent").
- Proof: throwaway `zz-review-adv-1.test.tsx` "ADV-skew-1: a pre-deploy tab
  (main bundle) against the NEW server pre-checks a tour-held tenant and sends
  to them" renders main's RecipientPreview with the exact payload this branch's
  server returns. It FAILS:
  `expect(element).not.toBeChecked()` - `Received element is checked: <input aria-label="Held Tenant" checked="" ...>`.
- User-visible effect: until each tab is reloaded, the feature's central rule
  (held tenants listed unchecked) does not apply; the old tab also shows the
  new server's "Reaches N" (checked-by-default count) beside a review list that
  checks more than N. Not a regression versus pre-deploy behavior, but the
  wrong people are checked by default for the length of the skew window, on
  every deploy that changes a client-computed rule.
- Suggested fix (targeted): the new dashboard sends a marker on
  `POST /api/broadcasts/:id/preview` (body `{ clientRules: 1 }` or a header);
  the server answers 409 `reload_required` when it is absent, so a stale bundle
  shows an error (main's composer prints `err.message`) instead of a list built
  on the old rule. Broader: a build-id handshake (server stamps the image tag on
  responses, the dashboard compares with its own and asks for a reload).
  Minimal/operational: a RUNBOOK release step to reload open dashboards.
- Regression test that must FAIL with the fix reverted: app
  `broadcastApi.test.ts` "a preview request without the client-rules marker is
  409 reload_required and serves no candidates; with it, 200" (reverting the
  guard makes the first request 200).

### ADV-2 - MEDIUM - CONFIRMED - A failed organization-list read fails the authority prefill OPEN: the blast reaches every housing authority and staff cannot put the filter back

- Evidence: the gate settles on a failed read (`BroadcastComposer.tsx:229`,
  `orgLoading` is false once the read fails), `prefillAuthorities` returns no
  names while the list is unknown (`authorityPrefill.ts:18`), the composer only
  adds a notice (`BroadcastComposer.tsx:232`), and the picker is disabled for a
  failed read with nothing in hand (`AudienceFilters.tsx:199`). `useOrgList`
  reads once per mount and the composer never calls its `reload`. Contrast
  D5/D6: a failed tours or decline read fails CLOSED (503 + Try again,
  `broadcasts.ts:790`, `BroadcastComposer.tsx:539-543`) for the stated reason
  that a list without the rules "would check people the rules leave out" - a
  missing authority filter does exactly that. The same pinned behavior applies
  when every accepted authority is off the list ("This blast is not limited by
  housing authority.") - that case is at least surfaced in the reach caption.
- Trigger: `?unitId=` (or a picked property) whose `accepted_authorities` =
  ["Atlanta Housing Authority"]; `GET /api/organizations` answers 500 once (a
  throttled read, a deploy blip).
- Proof: throwaway `zz-review-adv-2.test.tsx`:
  - "ADV-failopen: a property that accepts ONE authority, a failed list read -
    the draft is unfiltered by authority and staff cannot add the filter back"
    FAILS: `expected { contact_type: 'tenant', ...(1) } to have property "housing_authorities"`
    (the draft is `{ contact_type: 'tenant', bedroomSize: 2 }` and Preview is enabled);
  - "ADV-failopen-picker: with the list failed, the Housing authorities picker
    is disabled" FAILS: `expect(element).toBeEnabled()` - `Received element is not enabled: <input ... disabled="" placeholder="Any housing authority" role="combobox">`.
- User-visible effect: one amber line under a disabled picker; "Reaches N"
  counts every Searching/Onboarding tenant of that size in every authority, all
  checked on Review recipients; the only remedy (a page reload) is not offered.
- Suggested fix: when a property is attached, lists authorities, and the list
  read failed with nothing in hand, either (1) keep the hold and show "Couldn't
  load the organization list" with Try again wired to `orgList.reload()`, or
  (2) prefill the property's own `accepted_authorities` verbatim (they are
  list-checked on write; the create's `checkList` 422s an off-list one and D3b
  removes only that member). Either way rewrite the pinned test
  `BroadcastComposer.test.tsx:976` ("a failed organization list read settles
  the prefill with its notice; the voucher size still fills in") - it pins the
  fail-open.
- Regression test that must FAIL with the fix reverted: the ADV-failopen shape -
  getOrgList rejects 500, unit accepts ["Atlanta Housing Authority"]; assert
  (option 1) no draft is created and Preview stays disabled until Try again
  re-reads the list, or (option 2) the last `createBroadcast` body carries
  `housing_authorities: ['Atlanta Housing Authority']`.

### ADV-3 - LOW - CONFIRMED - After a rollback, a tab running this branch's bundle crashes the review step against the old server

- Evidence: `RecipientPreview.tsx:164-167` maps `preview.tourHolds` with no
  guard, and `:140-141` sets `checked: c.checkedByDefault` (undefined on an old
  server, so every row would start unchecked and Select all would check none).
  Rollback is a supported path (`scripts/deploy.mjs` `--tag <previous>`), and
  the tab keeps the newer bundle until reloaded.
- Proof: `zz-review-adv-1.test.tsx` "ADV-skew-2: a post-rollback tab (branch
  bundle) against the OLD server renders the review" FAILS:
  `TypeError: Cannot read properties of undefined (reading 'map')` at
  `src/routes/broadcasts/RecipientPreview.tsx:167:27`.
- Effect: Preview of any blast crashes the route (error boundary) until reload.
- Suggested fix: `preview.tourHolds ?? []`; type `checkedByDefault?` on the
  wire type and fall back to the legacy rule when absent
  (`has_consent && (seeded || (!alreadySentThisProperty && !declinedThisProperty))`).
- Regression test: ADV-skew-2 as written (old-server payload renders; the plain
  consented row starts checked) - fails today with the TypeError.

### ADV-4 - LOW - CONFIRMED (behavior; trigger rare) - A 422 naming a member the screen does not hold empties the WHOLE authority filter

- Evidence: `BroadcastComposer.tsx:262-266` - when the refused `text` matches
  nothing on screen, `next = []`, which is "no housing authority filter"
  (`BroadcastComposer.tsx:213-219`), i.e. the broadest audience; the notice
  names only the refused text (`authorityLeftTheList`).
- Trigger (interleaving): (1) the composer reads the org list with entry X;
  (2) an admin renames X to Y (X becomes a spelling of Y); (3) the create sends
  X, the server stores Y (`checkListWrite` resolves the spelling); the screen
  still says X; (4) an admin renames or deletes Y; (5) Preview's
  `storedFilterRefusal` answers 422 `text: 'Y'`; (6) X never matches Y, so every
  member on screen is dropped and the next draft reaches every authority.
- Proof: `zz-review-adv-4.test.tsx` "ADV-422-fallback: a Preview 422 for a
  stored name the screen does not hold keeps the members on screen" FAILS:
  `expected undefined to deeply equal [ 'Atlanta Housing Authority', 'DeKalb County Housing Authority' ]`
  (the recreated draft carries no `housing_authorities`).
- Suggested fix: on a refusal whose text is not on screen, keep the on-screen
  list and force a recreate from it (the server re-resolves each on-screen name
  at create), or use the 422's `candidates` to map the stored name back; never
  widen the audience as a fallback. The comment "never expected" should go.
- Regression test: ADV-422-fallback as written.

### ADV-5 - LOW - CONFIRMED - The two-partition read is not a snapshot: a tenant moved between the reads is listed twice (or missed), and the code comment says otherwise

- Evidence: `app/src/services/audienceResolution.ts:153-177` reads (tenant,
  searching) then (tenant, onboarding); the status belt at `:177` is commented
  "it also keeps a row from resolving twice across partitions" (`:176`), which
  holds only for a row that does not move. There is no de-duplication by
  contactId.
- Trigger (interleaving): (1) the searching walk returns tenant T; (2) a staff
  PATCH moves T to onboarding; (3) the onboarding walk returns T again, its
  status now equal to the partition, so T resolves twice. The opposite move
  (onboarding -> searching, the normal lifecycle direction) during the window
  drops T from both reads.
- Proof: `zz-review-adv-5.test.ts` "ADV-dup: a tenant moved searching ->
  onboarding between the two partition reads resolves ONCE" FAILS:
  `expected [ 'c-mover', 'c-mover' ] to deeply equal [ 'c-mover' ]`.
- Effect: a duplicated Review recipients row (duplicate React key; toggling one
  toggles both), "Send to N+1", the create estimate +1. No double text: path
  (a) de-duplicates (`broadcasts.ts:250-259`) and path (c) keys the map
  (`buildRecipientsFrom`).
- Suggested fix: a `seen` Set in the resolver (first row wins - the searching
  one); reword the comment to state the non-snapshot read (a mover can be
  missed).
- Regression test: ADV-dup as written.

### ADV-6 - LOW - PLAUSIBLE - The D8 caption names the wrong list

- Evidence: `AudienceFilters.tsx:38-39` "While a housing authority is selected,
  tenants whose housing authority is missing or not on the organization list
  are left out." The rule (`audienceResolution.ts` any-of on the FILTER's
  names) and the canonical glossary (`documentation/GLOSSARY.md:129` "missing
  or not one of them is left out") say: not one of the SELECTED names. A tenant
  of another listed authority is left out too, which the caption implies is
  not the case. Pinned by `matching-blast-rules.spec.ts:39` and selectors.md.
- What would confirm: a product read of the D8 copy. Suggested copy: "...whose
  housing authority is missing or not one of the selected housing authorities
  are left out." Regression test: an AudienceFilters test asserting the new
  caption (fails on the old string); update the e2e CAPTION and selectors.md.

### ADV-7 - INFO - CONFIRMED - `truncated` is reported when Searching ends exactly on the page bound and Onboarding is empty

- Evidence: `audienceResolution.ts:157-160` flags truncation before reading
  the next partition's first page. Documented as intended ("a page still
  unread ... in a later one"), so a complete read is refused by path (c) and
  labeled "the list is incomplete".
- Proof: `zz-review-adv-5.test.ts` "ADV-bound: searching read to its end on
  the last allowed page, NO onboarding tenants - not truncated" FAILS:
  `expected true to be false`. Only reachable at maxPages x pageSize (10,000)
  searching tenants; no action needed now.

### ADV-8 - INFO - The rules reads now ride every draft create, sequentially

- Evidence: `buildReviewRows` awaits seeds -> audience -> tours+declines ->
  already-sent in series (`broadcasts.ts:746, 776, 782, 795`) and create calls
  it for every filter draft (`:933-947`); the composer recreates on every
  debounced message edit (600 ms) and twice per open (the flyer re-prefill).
  Each create adds at least 4 tour Queries + 1-3 decline reads + the byUnit
  share walk with record reads to the old 2-partition walk. Fine at Phase-1
  volume (the tour partitions stay small thanks to auto-close); worth a
  `Promise.all` of audience / rules / already-sent (keeping the rules failure
  mapped to `AudienceRulesUnavailableError`).
- Related display drift: an omitted estimate stores `stats.audience` 0
  (`broadcastsRepo.ts:730`), so that draft's Matching-list row reads
  "0/0 delivered" (`BroadcastsList.tsx:221`); a seeds-only draft to a seed
  without recorded consent now reads "To 0 recipients" (`:47`).

### ADV-9 - INFO - Stale cross-reference to the issue this branch resolves

- `docs/issues/unknown-queue-cap-starves-needs-review.md:27` still says
  `broadcast-audience-truncation-drops-searching-tenants` "is untouched and
  still open"; this branch resolves it. One-line historical note.

## Swept and clean

- React StrictMode (main.tsx wraps the app): throwaway `zz-review-adv-3.test.tsx`
  PASSED both cases - `?unitId=` settles the prefill with one live draft
  carrying it and every other draft deleted; pick, Change, pick another under
  StrictMode leaves no stuck hold and the second property's prefill wins.
- Late/out-of-order composer results: create results are generation-checked
  (`useComposerDraft.ts:221, 242`); Preview results and 503 refusals are kept
  with draftId+key (`BroadcastComposer.tsx:578-597`); 422 removals and notices
  are keyed to the owning property (AR39); the property load is kept with its
  id; an aborted load is ignored, including the body-read abort that
  `api/client.ts parseBody` swallows (getUnit then throws on `res.unit` and the
  `.catch` sees `signal.aborted`).
- `hold` cannot stick: `orgLoading` only goes true once (first read), the
  property load re-runs on every pick (pickProperty resets a failed load and
  `effectiveUnitId` passes through undefined on Change).
- Authz: no new route; all changed routes stay under /api requireAuth + CSRF.
- PII: new log lines carry ids/counts/flags only; the preview's `tourHolds`
  (system-wide contactId/tourId/date) is staff-only data already visible via
  the tours API.
- Injection/unbounded input: authority members are compared in memory only;
  `createdAtFrom` is server-computed and bound as an expression value; the list
  is capped at 100, `checkListWrite` stops at the first failing member, and
  `closeNames` ignores text over 120 chars.
- `toursRepo.listByStatus` signature: every caller passes one argument
  (`jobs/tourAutoClose.ts:77`, `routes/tours.ts:452`); the harness fake models
  the bound; real `createdAt` is always `toISOString()`, so the string range
  bound equals the instant comparison in `tourHoldOf`.
- Tour lifecycle vs D4: conversion finalize sets `closed`
  (`routes/placements.ts` from-tour), so no stale needs_placement after a
  conversion; auto-close statuses equal the read partitions.
- `effectiveDeclines` with `requireComplete`: throws only on unread keys, never
  for a deleted contact, so one old decline cannot 503 every preview.
- Legacy rows: every server reader goes through `authoritiesOfFilter`
  (resolver, stored re-check, wire); results and list rows answer the wire
  shape; the byCreated GSI projects ALL; the only broadcast writer is the
  create route (plus seeds); `seedOrgNames.test.ts` checks both shapes.
- No runtime reader of `listByHousingAuthority` remains; no other "who matches"
  rule exists to drift (`isEligibleRecipient` is the follow-up chase rule).
- Send paths: (a) de-duplicates ids and re-fences; (c) applies D6 then the cap
  on the FINAL set and keys by contactKey; markSending stays conditional.
- e2e specs not in the diff that create filter drafts send explicit lists
  (landlord-activity, listing-activity, send-outcome-*, share-*), so D1 does not
  reach them; `scenarios/steps.ts teamSendsListing` uses a Searching AHA 2-BR
  tenant that the seeded unit's AHA prefill keeps.
- ASCII: no non-ASCII character on any added line of the package.
- Pre-existing, unchanged by this branch (out of scope): resuming a draft
  (`?draftId=`, no unitId in the link) shows default filters and an empty
  message; the first edit recreates a property-less, unfiltered draft and
  deletes the resumed one. The new prefill gate deliberately skips resumes, as
  main did.
