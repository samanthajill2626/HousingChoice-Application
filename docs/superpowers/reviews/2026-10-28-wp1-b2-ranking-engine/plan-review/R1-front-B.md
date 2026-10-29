# Plan review R1 - front B (plan sections 5-8: S1 Notes box, S2 foundations, S3 pool and cards, S4 model call)

Reviewer: adversarial plan reviewer, read-only. Plan:
`docs/superpowers/plans/2026-10-28-wp1-b2a-ranking-engine.md` (lines 450-19956);
spec rev 6. Repo at main @404e039d. Plan sections 0-4 and 13 and the spec read
in full; each slice read in full (S1-S4 each by a dedicated pass of this
reviewer) with every claim about today's code checked in the tree. Nothing was
run.

Verdict for this front: no BLOCKING finding. One HIGH (a fair-housing cap
defect in S4), seven MEDIUM, and a set of LOW precision items. Anchors quoted
by S1-S4 were checked and resolve as quoted except where a finding says
otherwise.

---

## 1. [HIGH] `capOf` suppresses the cap by exact KEY, so an accommodated assistance animal can still be capped to Weak

What is wrong. S4.1's `capOf` (plan 15670-15683) builds `accommodated` and
`unlawful` as sets of base field names and skips a failed key only when THAT
SAME key is in the set. But `no_pets`, `pets` and `pet_fee` are one
requirement ITEM: `defineItem('pets', ...)` with three fields
(app/src/lib/requirements.ts:87-93; the file's own comment says a checkbox
and the free text detailing it are one item). A model that writes
`fairHousingFlags: [{ kind: 'accommodation', field: 'no_pets' }]` and
`failedRequirements: ['pets']` (a property that records both the No pets box
and pet details) yields `capped: true`: the assistance-animal tenant lands in
Weak with "requirement not met".

Evidence. plan 15670-15683; requirements.ts:87-93; spec D9 ("is not in the
pair's accommodation flags"); spec D17 control (assistance animal vs a No
pets property).

What it implies. The cap is code, and code is exactly where charter 7.2 says
a disability must never lower a pair. The merge-gate control does not catch
it: the control property records only No pets, so `pets` is not recorded and
the split never arises. Same shape for the unlawful suppression (an open
unlawful flag on `pets` text does not suppress a failed `no_pets`).

Fix. In `capOf`, compare by requirement item: skip a failed key when any
accommodation field or open unlawful field resolves (after `baseField`) to
the same item (`itemOfUnitKey` or equivalent from requirements.ts). Add cases:
accommodation `no_pets` + failed `pets` -> not capped; unlawful `pets` +
failed `no_pets` -> not capped. The spec text reads key-wise, so list the
item-level reading for Cameron as a ruling.

## 2. [MEDIUM] The fake/console refusal keys on `NODE_ENV=production` only; `npm run dev` live mode runs `development` against hosted dev's real tables

What is wrong. S2.2 refuses `RANKING_DRIVER=fake|console` and
`RANKING_WORKER_POLL=off` only under `NODE_ENV=production`. The default
`npm run dev` is LIVE mode: app and worker on the local machine against the
real `hc-dev-*` tables (scripts/dev.mjs:3-8, liveMode at :113-116, `.env.dev`
loaded at :122-133) with `NODE_ENV` forced to `development` (:190).

What it implies. With the non-production default `console`, a local live run
starts the ranking poll (always on), claims jobs pressed on deployed hosted
dev (same `ai_runs` table), and writes console scores into hosted dev's
matches store - the exact harm spec D6 cites for refusing these drivers on
hosted dev ("would write made-up scores into a real matches store"). If
`.env.dev` instead carries `RANKING_DRIVER=anthropic`, a local run spends on
dev's key. Either way S8's RUNBOOK line that plain `npm run dev` "uses the
console driver ... offline" (plan ~36002) is false. WI6 lists only tests and
the AWS stacks.

Fix. Refuse `fake` / `console` (and `RANKING_WORKER_POLL=off` is harmless,
leave it) whenever the config targets AWS (no `DYNAMODB_ENDPOINT`) and
`NODE_ENV` is not `test`; or have dev.mjs live mode default
`RANKING_WORKER_POLL=off` and `RANKING_DRIVER=anthropic` explicitly. Correct
the RUNBOOK paragraph and add the surface to WI6.

## 3. [MEDIUM] The tenant card maps EVERY matching input regardless of `source`, contrary to spec D2.1

What is wrong. D2.1 includes "every key named in B1's TENANT_MATCHING_INPUTS
whose source is `field`", precisely so a source moving to Notes changes one
list. `TENANT_MATCHING_INPUT_FIELDS` (plan 10449-10454) maps all entries to
`include` and never reads `input.source`; the S3.1 tests (plan ~9892,
9896-9901) pin all four as included, i.e. they prove the wrong rule.

Evidence. `TenantMatchingInputSource = 'field' | 'notes'`
(app/src/lib/tenantMatchingInputs.ts:20-21); `source` on every entry (:31).

What it implies. Inert today (all four are `field`), but the first move of
an input to Notes (issue `extraction-fields-to-notes`) leaves the card
copying a stale attribute and every test green.

Fix. Include only `source === 'field'` entries; any other becomes
`exclude('kept in Notes (spec D2.1)')`. Make the test assert the filter by
source (e.g. a list fixture with one `notes` entry).

## 4. [MEDIUM] PR16's anchor `missing` on an over-ceiling pool cannot be delivered from S3's result; S6 hard-codes `[]`

What is wrong. PR16 says a pool over the ceiling answers 200 with the anchor
block "(display, anchorNotes, missing)". S3's `PoolFailure` for
`pool_too_large` carries only `size`, `anchorRecord`, `anchorNotes` (plan
12212-12220, 12323-12325) - no anchor missing flags and no `orgEntries`,
which `propertyMissing` needs for `authorities_unmapped`. S6 therefore writes
`missing: []` (plan 25729-25740) and pins it in a test (~25613-25630).

What it implies. The read contradicts PR16 and spec D9 on exactly the case
the page is told to check first; the builder is pinned into the wrong answer.

Fix. On `pool_too_large`, have `computePool` (or assemble) also return the
anchor's missing flags (`propertyMissing(unit, { orgEntries, landlordCard,
landlord })` / `tenantMissing(contact)`), publish the field in S3's shapes,
and have S6 use it; change S6's test to assert the real flags.

## 5. [MEDIUM] The worked examples' `missing` lists and seen-entry shape disagree with what production sends

What is wrong. examples.ts claims "the exact wire shape of a real call", but:
- Labels differ from S3's: example 8 uses 'Accepted voucher sizes' and
  'Housing authority not on the list'; S3's `PROPERTY_MISSING_LABELS` are
  'Voucher sizes' and 'Housing authority not on the organization list' (plan
  9393-9394).
- Coverage differs from D3: by D3's `pets` and `accessibility` rules most
  example property cards (2, 3, 4, 6, 7, 8, 9, 10) would carry 'Pets' and/or
  'Accessibility' yet show `missing: []`; example 5's candidate and example
  9's anchor lack a maximum tenant portion (PR6 completeness input) with no
  flag.
- Seen entries in the examples (e.g. example 7) carry no `label`; S3's
  `PropertiesSeenEntry` keeps `label` (plan 9332-9336) and the prompt's
  rewrite keeps every key but `home`.

Evidence. plan 17190-17845 vs 9393-9395, 13485-13530; spec D3, D4.

What it implies. The few-shot set teaches the model that cards without pet
or accessibility data carry no flag, while almost every real call carries
those flags - the examples miscalibrate the `missing` / `unknowns` behavior
the rubric asks for, and Cameron's handback read is unlikely to spot label
drift.

Fix. Import S3's label constants into examples.ts; correct every list; add a
test that recomputes each example card's flags with S3's completeness
functions and asserts equality; settle one entry shape (add `label`, or drop
it in the prompt since `homesSeen` already carries it).

## 6. [MEDIUM] Nothing ties the shipped prompt bytes to `RUBRIC_VERSION` / `EXAMPLES_VERSION`

What is wrong. "Any edit is a new version" is a comment. The schema enums
(`RANKING_REQUIREMENT_KEYS`, flag fields) are derived from
`REQUIREMENT_UNIT_KEYS`, and the schema test derives its expectations the
same way, so only `toHaveLength(13/18/32)` notices a change; a renamed key,
or a rubric or example edit without a bump, changes what the model sees and
passes every test (plan 15961-15988, 16061-16063, 16832, 17154; S4.10 RUNBOOK
text 19840-19844 only asks for a bump).

What it implies. D9's `version` out-of-date reason never fires for such an
edit, so matches scored under an older prompt read as current. PR18 makes the
fingerprint cover the schema, but nothing compares the fingerprint to a
pinned value per version.

Fix. In the prompt test, pin the `promptFingerprint` for both landlord
switch settings as literals (taken from S4.11's print step) with a failure
message "bump RUBRIC_VERSION/EXAMPLES_VERSION and update this pin"; pin the
enum lists as literals rather than deriving them.

## 7. [MEDIUM] S3 and S4 each define the free-text, requirement-key and landlord-prefix constants, with no test tying them

What is wrong. S3's `cardFields.ts` exports `PROPERTY_FREE_TEXT_FIELDS`,
`RANKED_REQUIREMENT_KEYS`, `EXCLUDED_REQUIREMENT_KEYS`,
`LANDLORD_FIELD_PREFIX` (plan 9358-9361, 12817-12826); S4's `schema.ts` and
`cap.ts` define `FREE_TEXT_FLAG_FIELDS`, `RANKING_REQUIREMENT_KEYS`,
`NEVER_REPORTED_REQUIREMENT_KEYS`, `LANDLORD_PREFIX` (plan 15314-15318,
16055-16103).

What it implies. parse.ts looks up an unlawful flag's text in S3's
`freeTextByField`, and the cap's recorded keys come from S3, while the schema
enum comes from S4. Drift silently drops (and counts) every unlawful flag on
the divergent field, or lets the schema offer a field the card never carries.
It also contradicts PR7's one-definition intent.

Fix. `schema.ts` and `cap.ts` import S3's constants (S3 lands first); or add
an equality test across the two sets.

## 8. [MEDIUM] Edit form: a PATCH that succeeds before a failed status write leaves a stale Notes baseline, so the next Save shows a false "notes changed" conflict

What is wrong. ContactEditForm saves fields with `updateContact` first, then
`setTenantStatus` (dashboard/src/routes/contact/ContactEditForm.tsx:605-628).
If the status write fails generically, the form stays open, `base` never
moves (`useState(contact)`, :188), and S1.10's Notes baseline still holds
the opened stamp. The next Save resends `notes` with that stamp; the first
PATCH already moved it; the server answers 409 `notes_stale`.

What it implies. The panel says the notes "were changed since you opened this
form ... Nothing was saved" about the user's own save - false on both
counts. A third Save works; nothing is lost.

Fix. In S1.10, once `updateContact` resolves, re-base the Notes baseline
(text and `notes_updated_at`) to the returned contact; add a unit test:
PATCH ok, status write fails, second Save sends the new stamp.

---

## LOW

9. [LOW] S1.11 Step 4's lint path list (plan ~3349) omits
   `app/src/lib/propertyLabel.ts` and `app/test/propertyLabel.test.ts`,
   which S1 edits (comment-only). Add them.

10. [LOW] S1.3's "collapses BEFORE the clamp" case (plan 1213-1218) is
    already green on today's code (apply.ts:334 yields the same 199 x's),
    contradicting Step 2's "every D14.1 case fails first". Mark it (PIN) or
    use 198 x's plus `\nzz`, expecting 198 x's then " /".

11. [LOW] By S1's C7 ruling (plan 583-588) a re-import with unchanged notes
    re-stamps `notes_updated_at`, so a form open across an import hits
    `notes_stale` over identical text. Consistent with D14.3; record it in
    the S1 report and in S8's `import-overwrites-notes-box` update.

12. [LOW] Four new S2 integration suites use table prefixes `hc-rjob-`
    (plan 6761), `hc-rrun-` (7863), `hc-rexcl-` (8071), `hc-uflag-` (8711)
    that `RESIDUE_PREFIXES` (app/test/globalTeardown.ts:80-84: `hc-test-`,
    `hc-hist-`, `hc-local-<n>-`) never sweeps; an interrupted run leaves them
    forever (AGENTS.md documents residue taking the suite from 65 s to 607 s).
    Use `hc-test-<uuid>-` as S2.4-S2.6 do.

13. [LOW] S2.11 Step 1 (plan 8997-9002) expects NO diff for
    `app/src/repos/aiRunsRepo.ts`, but S1.4 adds `notesDuplicate` there (plan
    1063, 1227, 1257). Drop it from the list or expect S1.4's change.

14. [LOW] S2.11 Step 6's WI1 grep (plan 9102-9107) expects two `app/src` hits
    for `'matches'`; the planned matchesRepo adds a third
    (`new IncompleteBatchReadError(..., 'matches')`, plan 6526). Expect three
    and name it.

15. [LOW] S2.3 Step 2 says the dashboard mirror test still passes after Step
    1b; its "carries nothing else" case compares each entry's keys with
    `MIRRORED` (dashboard tenantMatchingInputsMirror.test.ts:27-31), so it
    goes red at 1b and green at 3b. Say so.

16. [LOW] S2.11 Step 5's `\\uffff` grep (plan 9093-9095) matches the literal
    six characters, never a raw U+FFFF; the `tr` sweep already covers it.
    Drop the step.

17. [LOW] The type-level pins `_tenantDeclaredCovered` /
    `_propertyDeclaredCovered` (plan 9782-9787) can never fail: the registry
    key types are supersets of `KnownKeys<T>`, so the Exclude is always
    `never`. The real guard is the `satisfies Record<...>` in cardFields.ts
    (plan 10446, 10520). Delete the pins or replace with a real negative
    check, and correct the S3.12 Step 2 claim that they "stop compiling".

18. [LOW] The D2.4 writer scans (plan 9965-10045) see only a few code shapes
    (`'x' in b`, `for (const key of [...])`, SET strings, `#alias`); a key
    read as `b.newKey` or by an unscanned writer slips past "listed for
    Cameron". No leak (runtime allowlist). Say in the S3 report the scans are
    evidence, not proof.

19. [LOW] The property-anchor tie order uses `poolRecencyAt` (IR8, plan
    11765-11771), which returns null for an imported never-heard contact;
    spec D9's sort is "last heard from (falling back to `created_at`)" with
    no import exception (that exception is D1's window rule). Use a sort
    helper without it, or list the departure for Cameron.

20. [LOW] The property card's `voucherSizes` is
    `[...new Set(acceptedVoucherSizes(unit))]` (plan 12804-12807): not
    clamped to 0-4 or filtered to integers as the pool's
    `bedroomSizesOfFilter` is (app/src/lib/blastAudienceRules.ts:218-231). A
    beds-5 unit shows `[5]`; a stored `[2.5]` shows, is ignored by the pool,
    yet closes the `voucher_sizes` gap (plan 13504). Derive both through the
    pool's normalization.

21. [LOW] `arrangePropertiesSeen` always rejoins notes lines with `\n` (plan
    13233-13235): CRLF to LF, blank lines dropped, lines trimmed, even with
    nothing attached (pinned ~12950). D2.2 says free text passes "as stored,
    except trimmed". Fingerprint unaffected (raw text). Pass the trimmed
    stored text when nothing attaches, or record the rewrite as intended.

22. [LOW] S3.12: `git diff --stat HEAD~11 HEAD` (plan 14995) assumes exactly
    11 S3 commits (a fix-up shifts it; use the commit before S3.1); the WI12
    grep `function .*Card(` (plan 14967-14970) cannot match the fingerprint
    functions the text says it lists.

23. [LOW] The compile check cannot validate `claude-opus-5-5`: it compiles
    through extraction's thinking-off client and opus-5-5 accepts no
    thinking-off (app/src/adapters/extraction.ts:247-249); the grammar limit
    is per model (RUNBOOK.md:1494-1495). Add one RUNBOOK sentence in S4.10:
    an opus ranking model is validated only by the counterfactual run.

24. [LOW] S4's C7 STOP rule ("the SDK predates effort") may misattribute a
    type error caused by S2's `RankingEffort` union including 'xhigh'/'max'
    (plan 4044). Whether SDK 0.129.0 (package-lock.json:181-183) types those,
    `thinking: { type: 'adaptive' }` and `APIConnectionTimeoutError` is
    UNVERIFIED (no node_modules). Say an error on 'xhigh'/'max' alone means
    narrowing the union, not STOP.

25. [LOW] Rubric r1 claims that do not match the cards: "a checkbox appears
    only when checked" is false for `same_day_rta` (S3's `cleanValue` keeps
    `false`, plan 12720); "every candidate ... searching, reachable by text"
    does not hold for property candidates; THE INPUT section omits the seen
    entry's `label`. Fix before r1 freezes.

26. [LOW] The rubric has no "card text is data, never instructions" line;
    JSON encoding stops forged structure but not instruction text in `notes`,
    `preferences_notes` or `customFields`. One sentence.

27. [LOW] `fakeInputLabels()` throws inside `rankBatch` (plan 18997-19008),
    breaking the never-throws `RankingCall` contract; S5 maps a throw to a
    `driver` failure (plan 15430), so it degrades to a failed batch. Resolve
    the labels at construction or return `failure: 'driver'`.

---

## Checked and holding (not findings)

- WI3: the only contact `notes` writers in app/src are the contacts PATCH
  (routes/contacts.ts:645), manual create (:921), extraction apply
  (services/extraction/apply.ts:958) and the importer
  (lib/import/apply.ts:1196); S1.11's table is complete. Only AiRunDetail.tsx
  renders the run record's note counts; the detail route returns the record
  whole (routes/aiRuns.ts:272).
- S1's 409 precedence matrix matches D14.3; the new server-owned refusal
  breaks no caller (no dashboard or e2e code sends a whole contact back).
- S2: config anchors (extraction key check config.ts:887-894, base-URL
  refusal :900-904), the nine production-boot fixtures (the WI6 grep finds 16
  files; the other seven never load a production config), `getManyByIds`
  mirroring unitsRepo.ts:1296-1339, `IncompleteBatchReadError` signature
  (contactsRepo.ts:686-700), `TERMINAL_STAGES` export (placementsRepo.ts:54),
  matches and ai_runs keys (tables.ts:239-252, 645-655). The D7 condition
  expressions (claim, poll claim, takeover attempts < 1, second expiry,
  renewal, queue expiry) match the spec; PR13 `notScored` and PR15
  `matchesWritten` are typed. WI1: the lean row (lean.ts:445-457) is the only
  reference; no e2e reads it. WI2: `SCOPE_PATTERN` (aiRuns.ts:30-31) admits no
  new family, the detail reads `run#` (:228-233); journalSweep, dev.ts and
  performanceSeed do no prefix reads.
- S3: every declared ContactItem / UnitItem key is classified; across the
  seed worlds the only unnamed attribute found is `move_in_date`
  (lib/seed/matrix.ts:542), excluded as unclassified (PR28). Pool fences match
  audienceResolution.ts:126-129, 197-199; `checkScalarWrite` and the prefill
  parity cases match; `isListed` (listingSendsRepo.ts:235-237), `labelMatches`
  / `propertyLabel` (propertyLabel.ts:60-88), `unitItemValue`
  (requirements.ts:188-197) behave as the tests assume. WI11 cases trace
  correctly by hand. Published shapes are a superset of PR3.
- S4: 15 `REQUIREMENT_UNIT_KEYS` (requirements.ts:69-118) give 13 reportable
  keys, 18 flag fields off and 32 on; the schema has exactly five object nodes
  (root, candidate, reason x2, flag), meeting WI21; the eleven WI22 type lines
  match UnitItem (unitsRepo.ts:449-535, including `pets?: string | boolean`);
  the compile-check `VARIANTS` export and anchors and the RUNBOOK anchor
  (RUNBOOK.md:1545-1551) match; S5's calls use S4's names.
