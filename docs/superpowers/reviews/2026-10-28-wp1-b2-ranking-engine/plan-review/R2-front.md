# Plan review R2 - front half (head + S1-S4, plan sections 0-8)

Reviewer: adversarial plan reviewer, read-only. Plan v3 at b71f2b18 (round-1
diff f3df4379..b71f2b18 read hunk by hunk); spec rev 6; repo at main
@404e039d. Inputs also read: plan-adjudications.md (PR29-PR39), R1-front-A.md.
Head (sections 0-4, 13) read by me; S1/S2, S3 and S4 each swept again by a
dedicated pass of this reviewer; every finding below re-checked by me in the
plan text and the tree. Nothing was run.

Verdict: no BLOCKING, no HIGH. Two MEDIUM DECISION findings are both in the
PR29 cap fix (one of them is a defect I invited in round 1 and now retract);
one MEDIUM precision gap in PR32. The rest is LOW.

Each finding says [DECISION] (accepting it changes what gets built, a
surface, or an invariant) or [PRECISION].

---

## 1. [MEDIUM] [DECISION] PR29's unlawful half lifts a LAWFUL checkbox's cap for every pair at the property

What is wrong. v3's `capOf` (plan 16664-16676) builds `unlawfulItems =
itemsOf(openUnlawfulFields)` and skips any failed cap-eligible key whose
requirement ITEM is in it. The tests pin it: "an open unlawful flag on pets
covers a failed no_pets", "on pet_fee covers a failed pets", "on
landlord:pet_fee covers a failed no_pets", "on evictions_notes covers a
failed no_evictions_on_program" (plan 16517-16521). Items group
`no_pets`/`pets`/`pet_fee` and `no_evictions_on_program`/`evictions_notes`
(app/src/lib/requirements.ts:71-73, 87-93).

Why it is wrong. Spec D5: an unlawful flag names only FREE TEXT; checkboxes
"can never carry one". The rubric itself says `no_pets` and
`no_evictions_on_program` are lawful on their face (plan ~17930). Spec D10:
while a flag is open "that FIELD caps no pair" - the field, not its item.
Unlawful flags persist with no TTL until the text is edited (D10).

What it implies. One open flag on, say, `pet_fee` text that charges
assistance animals a fee silently removes the No pets cap for every
ordinary pet owner at that property, indefinitely; likewise an unlawful
clause in `evictions_notes` removes the `no_evictions_on_program` cap. The
assistance-animal case FB1 was about is already covered by the ACCOMMODATION
half, which is correct as item-level. Departure from D9/D10 is not listed for
Cameron (plan 459 lists only PR30 and PR37).

Retraction. My round-1 FB1 text ("Same shape for the unlawful
suppression...") asked for this widening. It was wrong; I withdraw that
sentence.

Fix. Keep item grouping for accommodation flags only. Unlawful suppression
stays keyed on the base field (a failed key is skipped only when that same
key, or its `landlord:` twin, carries an open unlawful flag). Turn the four
unlawful cross-key cases into "still capped" cases; keep one same-key case.

## 2. [MEDIUM] [DECISION] PR29 does not reach a pets or evictions rule the model reports under `qualifications`

What is wrong. `qualifications` is its own requirement item
(requirements.ts:79-81) and is cap-eligible (spec D9). Qualifications text
commonly bundles rules ("No pets. No evictions."); the rubric's own example
puts an evictions clause inside qualifications (plan ~17917). A model that
returns `accommodation: no_pets` with `failedRequirements: ['qualifications']`
(or accommodation on `qualifications` with a failed `no_pets`) still caps the
pair: the items differ. PR29's matrix (plan 16512-16531) has no qualifications
cross case, and the counterfactual control (a No pets checkbox property, no
qualifications text) cannot exercise it.

What it implies. The same split-report shape FB1 closed for the Pets item
still caps an assistance-animal tenant when the rule lives in free-text
qualifications - the cap is the backstop for a model that does not follow
the rubric, and this is exactly where it fails.

Fix. When matching an ACCOMMODATION, treat `qualifications` as belonging to
every cap-eligible item (both directions). Erring here favors the tenant
(an accommodation may also lift an unrelated qualifications failure), which
is the direction charter 7.2 allows for disability. Add two cases; list the
rule for Cameron with PR29.

## 3. [MEDIUM] [PRECISION] PR32's pins do not cover the bytes the model actually sees

What is wrong.
- The examples pin hashes `stableJson(RANKING_EXAMPLES)` (plan ~21076), which
  sorts keys. The system prompt renders examples with plain `JSON.stringify`
  in insertion order (`renderExample`, plan 19587-19590). Reordering a card's
  keys changes the prompt and passes the pin.
- The framing text is pinned by nothing: the system framing ("WORKED
  EXAMPLES ...", "EXAMPLE n:", "OUTPUT:", plan 19593-19601) and the user
  framing (`DIRECTION_LINES`, `INSTRUCTION_LINE`, plan 19572-19585) - which
  also appears inside every example in the system text.

What it implies. An edit to any of these changes every call while
`RUBRIC_VERSION` / `EXAMPLES_VERSION` stay put, so D9's `version` reason never
fires - the exact hole FB6 was accepted to close.

Fix. Pin `sha256(buildRankingSystemPrompt())` beside the
(`RUBRIC_VERSION`, `EXAMPLES_VERSION`) pair, and `renderUserContent` over one
fixed wire fixture beside `RUBRIC_VERSION`; or pin `rankingPromptFingerprint`
for both switch states (it already hashes the system bytes plus the schema).
Keep the per-part pins for their clearer failure messages.

---

## LOW

4. [LOW] [PRECISION] `failedBatches` is still documented as "failed CALLS
   only" (plan 369 PR13, 3728, 7651 docstring "every candidate of that batch
   got no new match", 7686, 21328, 29501, 30687), but PR36 (`putRun` throws)
   and PR37 (partial write) now write `failure: 'repo'` entries, a PR37 one
   listing only the UNWRITTEN subset of a batch whose call scored. The read is
   right (it uses the listed ids); the job message and the page's "failed
   batches" count are not - they would report a batch as failed when most of
   it landed. Reword the docstring and PR13; S6/S7 count a `repo` subset entry
   as "N candidates not saved".

5. [LOW] [PRECISION] PR37 reports every row of a BatchWrite that THREW as
   unwritten, but a timeout or socket error after the commit may already have
   applied it. Those pairs then hold fresh matches (read current) while the
   job lists them failed, and `matchesWritten.count` reads low. Scores are
   real, so no charter breach. Say "not confirmed written" in the interface
   doc and C11, and add the case to PR37's line for Cameron.

6. [LOW] [PRECISION] PR30 adds another definition of "local DynamoDB"
   (`isLocalDynamoTarget`, host list) beside the dev router's gate, which
   treats ANY non-empty endpoint as local
   (app/src/lib/devRoutes.ts:16-19; same rule in logger.ts:78-85), and
   performanceSeed.ts:123-129 (whose `'::1'` never matches WHATWG
   `URL.hostname`'s `'[::1]'`, a pre-existing bug). With
   `DEV_AUTH_ENABLED` and a non-local endpoint the dev router mounts S5's
   `/__dev/ranking/tick`, whose lazily built deps use PR30's anthropic default
   - a real-model run against real tables from a laptop, the hazard PR30
   exists to close. Have the ranking tick also require
   `isLocalDynamoTarget`; name the other predicates in S2.1's doc.

7. [LOW] [PRECISION] PR30 makes operator scripts on real tables refuse to
   start when the shell still carries `RANKING_DRIVER=fake|console`
   (`loadConfig()` with NODE_ENV not production and no local endpoint:
   import-apply.ts:334, backfill-media-content-types.ts:758,
   retirePoolNumbers.ts:16, rail-verify.ts:152, import-convert-groups.ts:148).
   Loud, not silent; one sentence in S8's dev-modes caveat ("unset
   RANKING_DRIVER before an operator script on real tables").

8. [LOW] [PRECISION] PR30 also moves `npm test`'s default to
   `rankingDriver: 'anthropic'`, `rankingWorkerPoll: false` (vitest.config.ts
   and the `makeWebhookHarness` default env set no `DYNAMODB_ENDPOINT`),
   against spec D16's "every test uses the fake driver" framing. It is safe
   today only through three incidental guards: dev routes need an endpoint,
   the worker builds the driver only with poll on, and `createRankingDriver`
   throws without a key (so the SDK never falls back to an exported
   `ANTHROPIC_API_KEY`). Keep PR30 in config (it also covers `--mock`,
   `.env` overrides and operator scripts, which a dev.mjs-only default would
   not), but write the three guards into C10 as load-bearing for WI7 so a
   later slice does not remove one.

9. [LOW] [DECISION] PR38 covers only a tenant anchor. A property anchor whose
   own read fails at job time (landlord switch on: the landlord read returns
   `anchor_unreadable` with no `candidateIds`, pinned at plan ~15396-15400)
   finishes `failed` (~24834) and its rows read "not ranked yet", not "not
   scored - retry" - BB6's mismatch on the other side. Carry the pool's
   tenant ids on that failure and record them `notScored: unreadable`, or
   record the asymmetry as accepted. Switch defaults off, hence LOW.

10. [LOW] [PRECISION] The FB3 fix stops at the card: `tenantMissing` still
    loops over every completeness-marked input and reads `contact[input.key]`
    with no `source` check (plan ~14357-14372). Latent today (all four are
    `field`, tenantMatchingInputs.ts:44 on); once one moves to Notes the
    missing flag is judged from an attribute the card no longer shows. Skip
    non-`field` inputs there too; one case with a `notes`-sourced entry.

11. [LOW] [DECISION] Contest of FA5. Spec D5's "An `accommodation` flag may
    name any requirement key" follows the rule that checkboxes never carry an
    unlawful flag; it reads as permission, not restriction, and D10 says only
    "accommodation flags stay on the pair's match only". v3 drops and counts
    an accommodation on `accessibility`, `lease_terms` or `notes` (plan
    ~17621-17629), losing a correct signal (a modification need against
    `accessibility`; a No pets rule written in `lease_terms`) that B3/B4
    would show staff. No cap risk either way (`requirementItemOfField` is
    undefined for them). Keep accommodation flags on any field in the flag
    enum. If the ruling stands, concede.

12. [LOW] [PRECISION] Contest of FB27's form. Resolving the fake labels at
    MODULE LOAD in `adapters/rankingFake.ts`, which `adapters/ranking.ts`
    imports statically, means a `TENANT_MATCHING_INPUTS` shape change crashes
    the PRODUCTION worker at import (it loads the module through `jobWiring`)
    to guard a driver production refuses. Resolve in the
    `FakeRankingDriver` / `ConsoleRankingDriver` constructors: still loud,
    still never thrown from `rankBatch`.

13. [LOW] [PRECISION] PR31 says the examples are "built and checked by the
    production code", but the examples test hand-copies D3 as
    `propertyFlags` / `tenantFlags` (plan ~18146-18169) instead of calling
    S3's `propertyMissing` / `tenantMissing` (~14338-14374). Equal today; a
    later S3 rule change (PR23's landlord pets default, the size normalizer)
    does not reach it, and nothing asserts example card keys are keys the
    card builders can emit. Call S3's functions, or say "mirrors D3" in the
    header and add the key assertion.

14. [LOW] [PRECISION] The FB25 rubric fix still overstates eligibility:
    "Every pair already passed eligibility: the voucher size and the housing
    authority match, the tenant is searching and reachable by text, and the
    property is available" (plan 17901). The ANCHOR is never filtered (spec
    D1), and "recorded but none mapped" is unlimited, so an authority may not
    match. Scope the sentence to candidates and say an unmapped authority is
    uncertainty. Fix before the r1 pin.

15. [LOW] [PRECISION] S5's cross-slice note still names "`poolRecencyAt` (S6
    only)" (plan 21476); after FB19 S6 sorts with `sortRecencyAt` and
    `poolRecencyAt` is the pool window's rule only. Correct the line.

16. [LOW] [PRECISION] Two stale texts: app/scripts/db-seed.ts:5-8 says the
    seed exercises "the matches TTL attribute", false once S2.7 removes the
    row (add the comment edit to S2.7); S2.11's new check expects "only S1
    commits (their subjects name S1)", but S1's subjects name D14.x, not S1
    (plan ~1593, ~1797) - expect the S1.4 commit by its D14.2 subject.

---

## Adjudications: contested and conceded

- PR29: contested in part (findings 1 and 2). The accommodation half stands.
- PR30: conceded as placed (config, endpoint signal); finding 8 is a
  precision note on its test-default consequence. `isLocalDynamoTarget`'s
  `'[::1]'` handling is correct for WHATWG URL.
- PR31, PR32, PR33: conceded; findings 3 and 13 are gaps in how they were
  written.
- PR37: conceded; finding 5 is wording plus one more case for Cameron.
- PR38: conceded for tenant anchors; finding 9 is the property-anchor twin.
- PR39: conceded. Checked against scripts/secrets.mjs: `.env.dev` is BOTH the
  laptop's live-mode env and what push hydrates into deployed dev, so leaving
  `RANKING_WORKER_POLL` commented there (deployed dev defaults on under
  production, the laptop defaults off) and `RANKING_DRIVER` set to
  `anthropic` is the only layout correct for both; empty values are refused
  by push and check (secrets.mjs:161-168).
- FA5, FB27: contested (findings 11, 12). Every other round-1 ruling
  conceded.

## Fixes checked and holding (not findings)

- FB8 (S1.10): the Notes baseline re-bases only when `notes` was in the PATCH,
  from the PATCH answer (contacts.ts ReturnValues ALL_NEW); `buildPatch`
  diffs against the re-based baseline, so no resend, no false conflict, no
  adopted unseen stamp.
- PR37 `putMatches`: unconfirmed items are exactly those still pending when a
  retry throws; duplicates de-duplicated before counting; runBatch maps
  `unwritten` to candidate ids; no caller still expects a throw.
- PR34 repo half: projection aliased, `runId` projected, TTL-expired told
  apart from unread.
- Residue: all four suites now use `hc-test-<uuid>-`.
- poolTooLargeMissing: tenant -> `tenantMissing`; property ->
  `propertyMissing` with the pool's org list and (switch on) the landlord,
  throwing `IncompleteBatchReadError` on an incomplete landlord read (S6 503).
- sortRecencyAt is D9's rule; S6 parses to ms and sorts a missing instant
  last. recordedVoucherSizes goes through `bedroomSizesOfFilter`
  (blastAudienceRules.ts:218-231), so pool, card and completeness agree
  ([2.5] -> [], beds 5 -> [4] inferred). candidateIds are unitIds, matching
  the tenant-anchor `candidateId` and S5's notScored write.
- FB21: unmoved Notes text passes as stored (trimmed); the fingerprint still
  hashes the raw box (WI11 unaffected).
- PR33: S4's schema, parse and cap import S3's constants; the WI22 tie test
  is sound. The schema still has five object nodes.
- UNVERIFIED still: whether @anthropic-ai/sdk 0.129.0 types adaptive
  thinking, `output_config.effort` with 'xhigh'/'max', and
  `APIConnectionTimeoutError` (no node_modules); C7/FB24's STOP wording covers
  it.
