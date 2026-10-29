# Plan review R1 - front A (plan sections 5-8: S1 Notes box, S2 foundations, S3 pool and cards, S4 model call)

Reviewer brief: `.superpowers/sdd/BRIEF-plan-reviewer.md`. Read in full: the spec (rev 6),
plan sections 0-4 and 13, and plan sections 5-8 (lines 455-19961). Code claims below were
checked against the worktree at main @404e039d; anything not checkable is marked UNVERIFIED.

Overall: the four slices are unusually concrete and, where I could check them, their
anchors and claims match the tree (apply.ts filterNoteLines and the append at :958;
contacts.ts SERVER_OWNED_CONTACT_FIELDS :317, the staff-notes guard and conflict re-read
:2007-2048; ContactEditForm.tsx :233/:399/:1190; unitFields.ts acceptedVoucherSizes :478 and
authoritiesOf :448; blastAudienceRules.ts bedroomSizesOfFilter / voucherSizeMatches;
orgNames.ts checkScalarWrite :275 with KINDS_FOR_FIELD.audience_filter = housing_authority
only; requirements.ts unitItemValue / landlordItemValue; placementsRepo queryIndex and the
re-exported TERMINAL_STAGES; listingSendsRepo.listByContact filtering isListed; toursRepo
queryGsi paging to the end; the compile-check script's exported VARIANTS and its
invokedDirectly guard; aiRuns.ts SCOPE_PATTERN). I re-ran the plan's writer-key scan
patterns for the contacts parsers and the importer by hand (grep) and every key they find is
in the S3.1 registry or in NOT_ATTRIBUTES. The type-level registry (the `satisfies` clauses)
covers every declared ContactItem / UnitItem key I listed from the tree. I found nothing
BLOCKING. Findings follow, highest consequence first.

---

## F1. MEDIUM - Four new DynamoDB Local suites mint table prefixes the residue sweep never removes

What is wrong. S2.8, S2.9 and S2.10 create their throwaway tables under prefixes
`hc-rjob-<uuid>-` (plan line 6761), `hc-rrun-<uuid>-` (7863), `hc-rexcl-<uuid>-` (8071) and
`hc-uflag-<uuid>-` (8711). The suite-level residue sweep only deletes tables matching
`^hc-test-`, `^hc-hist-` and `^hc-local-\d+-` (app/test/globalTeardown.ts:80-84,
RESIDUE_PREFIXES). Every other new S2 integration suite uses `hc-test-` (5329, 5650, 6181).

Evidence. globalTeardown.ts:60-79 documents why this matters: an interrupted run leaks its
tables forever, and on 2026-08-23 a key carrying 116 leaked tables ran the app suite in 607 s
with 9 failures against 65 s / 0 on a clean key - a required gate red for pure residue. The
dynamoAccessKeyGuard test text (app/test/setup/dynamoAccessKeyGuard.test.ts:349) tells suite
authors to "give the suite its own hc-test-<uuid>- prefix".

Implication. Any killed or crashed `npm test` (common during S5-S9 fix waves) leaves up to
four ai_runs tables per run in the per-file database, unswept, and they accumulate across
runs. This is exactly the slow-suite / write-lock failure shape the AGENTS.md re-run
discipline then has to adjudicate.

Fix. Use `hc-test-${randomUUID().slice(0, 8)}-` in all four files (no other change). Do not
widen RESIDUE_PREFIXES (outside PR2 ownership, and the hc-test- convention already exists).

---

## F2. MEDIUM - The worked examples (e1) are not the wire shape a real call produces

What is wrong. Spec D4 and the plan say the examples are written "in the exact wire shape of
a real call" (plan 17143-17146) and the rubric tells the model "The 'missing' labels already
list the gaps code found" (16897). The examples disagree with what S3's code actually sends:

1. Missing labels that the completeness pass never emits. Example 8's anchor lists
   `'Accepted voucher sizes'` and `'Housing authority not on the list'` (plan 17695); the
   code's labels are `'Voucher sizes'` and `'Housing authority not on the organization list'`
   (PROPERTY_MISSING_LABELS, plan 13465-13472).
2. Property cards with gaps shown as `missing: []`. Example 7's anchor (17607-17621) has no
   pets item and no accessibility, so propertyMissing (13496-13511) would send
   `['Pets', 'Accessibility']`; example 2's candidates (17287-17320) likewise lack pets and
   accessibility yet carry `missing: []`. In production nearly every property will carry a
   Pets / Accessibility flag; the examples teach that such cards carry none.
3. Example 7's propertiesSeen entry (17641-17648) has no `label`; every real entry carries
   one (PropertiesSeenEntry, 13154-13164, built at 13236-13244).
4. No example has a non-empty `homesSeen` or an `h` handle (every example sets
   `homesSeen: []`; the one seen entry is `home: 'anchor'`). The mechanism Cameron chose at
   Q2 - a disliked home's full card written once and referenced by handle - is described in
   the rubric but never demonstrated.

rankingExamples.test.ts (16943-17125) checks parse round-trips, bands, cap, synthetic names
and label keys, but nothing ties an example's `missing` or entry shape to the production
builders, so all four pass.

Implication. The system prompt teaches a vocabulary and shape the real user content does not
use, contradicting its own rubric line. Every match records EXAMPLES_VERSION and a different
version marks it out of date (spec D9), so correcting the examples after deploy costs a full
re-rank; correcting them now costs nothing. Cameron is asked to read them at the handback
(PR28) and would be reading examples that do not match what the model actually sees.

Fix. In S4.6: (a) use PROPERTY_MISSING_LABELS / TENANT_MISSING_LABELS / the list labels
verbatim; (b) add a test helper that derives each example card's code flags from the card's
own keys (rent keys, payment_standard, voucherSizesInferredFromBeds / empty voucherSizes,
authorities.unmapped, the three pets keys, accessibility; voucherSize, housingAuthority and
the completeness-marked inputs for a tenant) and assert each example's `missing` equals it;
(c) give seen entries their `label`; (d) make at least one example (for instance the maybe
pair, or a new tenant-anchor example) reference a home through `homesSeen` / `h1`, with
feedback that only makes sense beside that home's card.

---

## F3. LOW - Three S4.11 watch-item greps cannot pass as written

What is wrong. S4.11 step 5 expects:
- WI7 `git grep -n "ANTHROPIC_API_KEY\|process.env" -- app/test/rankingDriver.test.ts ...`
  "prints nothing" - but the file S4.9 writes says in its own header "no test here reaches the
  network or reads ANTHROPIC_API_KEY" (plan 19196-19197).
- WI7 `git grep -n "@anthropic-ai/sdk" -- app/src` "lists only extraction.ts and
  ranking.ts" - but S4.8's driverTypes.ts comment reads "only adapters/ranking.ts imports
  @anthropic-ai/sdk" (18904-18905), so services/ranking/driverTypes.ts is listed too.
- WI13 `git grep -n "requirement not met" -- app/src` "lists only cap.ts" - but S2.9 already
  typed `cappedAtRun?: { capped: boolean; capReason: 'requirement not met' | null }` in
  rankingRunsRepo.ts (8321), and S5/S6 add more.

Implication. A literal builder either reports three false watch-item failures or edits the
files to satisfy the grep (deleting useful comments, or a type literal). Either wastes a fix
cycle; neither proves anything.

Fix. Grep for the import form (`from '@anthropic-ai/sdk'`), grep for `process.env` and the
key outside comments (or assert in the test that it never touches process.env), and for WI13
grep for the cap rule's implementation (`CAP_ELIGIBLE` / a second `capOf`-like function), or
list the expected files.

---

## F4. LOW - The tenant registry maps every matching input, not only those whose source is `field`

What is wrong. Spec D2.1 includes "every key named in B1's TENANT_MATCHING_INPUTS whose source
is `field`... so a source moving to Notes changes one list". TENANT_MATCHING_INPUT_FIELDS
(plan 10449-10454) maps all four entries with no `source` filter, and the test (9873-9901)
pins all four as included.

Implication. Today all four are `source: 'field'` (app/src/lib/tenantMatchingInputs.ts:44,
:54 and the two others), so nothing changes now. If an input moves to `source: 'notes'`, its
stored attribute (legacy values remain on records) keeps reaching the card, which the spec's
one-list rule says it should not.

Fix. Map `include` only for `source === 'field'`; map a non-field entry's key to
`exclude(...)` with a reason; adjust the S3.1 test to derive its expectation from the list's
`source`.

---

## F5. LOW - An accommodation flag is kept on a non-requirement free-text field

What is wrong. Spec D5: "An `accommodation` flag may name any requirement key." readFlags
(plan 16608-16609) accepts an accommodation flag on any `flagFieldsFor(landlordCard)` field,
which includes `notes`, `lease_terms`, `application_process`, `utilities`, `accessibility`
(and `landlord:notes` when on) - fields that are not requirement keys.

Implication. Harmless to the cap (capOf only consults cap-eligible keys), but such flags are
stored on the match's `fairHousingFlags` and the run's `results[]`, shown on the Rankings page
and inherited by B3/B4 as if they were a valid accommodation on a requirement.

Fix. Accept `accommodation` only when `baseField(field)` is in RANKING_REQUIREMENT_KEYS (and
the `landlord:` twin only when on); add one parse case.

---

## F6. LOW - The two type-level classification pins are tautological

What is wrong. rankingCardFields.test.ts pins `_tenantDeclaredCovered` /
`_propertyDeclaredCovered` as `Exclude<KnownKeys<ContactItem>, keyof typeof TENANT_CARD_FIELDS>`
extends never (plan 9782-9787). TENANT_CARD_FIELDS is annotated
`Readonly<Record<TenantCardKey, ...>>` and TenantCardKey contains every KnownKeys<ContactItem>
by construction (10331-10332; likewise PropertyCardKey, 10336), so the Exclude is always
never and the pins can never fail. S3.12 step 2 and the test header claim they fail
typecheck the same way as the `satisfies`.

Implication. Source 1 of spec D2.4 rests entirely on the two `satisfies` clauses
(10446, 10520), which do work. The pins add no protection, and the report text misleads a
later editor into thinking a second guard exists.

Fix. Either drop the pins and the claim, or export the base object (`TENANT_BASE_FIELDS`) and
pin against `keyof typeof` that literal's type.

---

## F7. LOW - A partially written match batch leaves some candidates with new matches although the batch is recorded failed

What is wrong. Spec D8: "a write that still fails is recorded as the batch's failure (its
candidates get no new match and read as out of date)". putMatches writes 25 rows per
BatchWrite (plan 6483-6500) and documents "earlier chunks may already be written" (6372-6373).
With the default batch of 40, a failure on the second chunk leaves 25 candidates with fresh
matches (computedAt after the job's startedAt), so the failedBatch out-of-date rule (D9,
PR13) does not flag them, while the job lists the whole batch as failed.

Implication. Minor: those scores are genuine model output, so charter 7.4 is not breached;
but the read and the job disagree about those 25 pairs, and the spec text is not met. No
ruling lists it for Cameron.

Fix. Record it as an accepted deviation in section 4 (the cheapest), or have S5 record only
the unwritten candidates as failed when putMatches throws IncompleteBatchWriteError after a
partial write.

---

## Checked and found sound (no finding)

- S1: the collapse order (prefix strip, collapse, cut, guard) matches D14.1 and C3; the
  rewritten extractionNoteLines suite keeps every pre-existing case or replaces it with the
  D14.1 side-effect case; the classification and both-boxes conflict matrices reuse the
  contactStaffNotes.test.ts idiom (world.contactsRepo.update wrap) that exists today; the
  importer stamp lands in the one upsert UpdateCommand; the edit form's PATCH runs before the
  status transition, so "Nothing was saved" is true; the GET route returns the raw item, so
  the form really receives `notes_updated_at`. WI3's writer table matches my grep (no other
  contact `notes` writer in app/src).
- S2: the production key rule runs last, and the 16 test files naming a production NODE_ENV
  are the 16 the plan lists; the dev e2e lane is NODE_ENV=development; deployed app and worker
  share one hydrated .env. The job-family conditions match D7 word for word; TransactWrite,
  list_append races and the sparse byEntity keys are exercised against DynamoDB Local.
- S3: no import cycle (pairHistory -> seenSet is type-only); pool, card, fingerprint and
  assemble tests are internally consistent with the implementations (I walked the WI11
  invariant fixtures, the properties-seen ordering cases and the exact-card expectations).
- S4: the schema has exactly five object nodes in both switch states; the parse, fake and
  driver test expectations match the implementations; importing the compile-check script from
  a test is side-effect free. UNVERIFIED: whether @anthropic-ai/sdk 0.129.0 (package-lock.json
  :181-182) types `thinking: { type: 'adaptive' }`, `output_config.effort` and the static
  `Anthropic.APIConnectionTimeoutError`; the plan's C7 STOP-and-report rule covers the first
  two at typecheck.
