# Plan review R3 - front half (head + S1-S4, plan sections 0-8)

Reviewer: adversarial plan reviewer, read-only. Plan v4 at 59183a22; the
round-2 -> v4 diff (b71f2b18..59183a22) read hunk by hunk for sections 0-8;
round-2 adjudications (PR40-PR44) read. Every claim below checked in the plan
text or the tree. Nothing was run.

Verdict: no BLOCKING, no HIGH. ONE finding would change a decision (finding
1, a contest of how PR41 was built). If it is rejected, nothing else in this
front changes a decision and the front half can close on the precision edit
below.

---

## 1. [MEDIUM] [DECISION] Contest of PR41's form: the qualifications split is fixed in the rubric only, and the rubric now gives two instructions for the commonest shape

What is wrong. R2F2 was accepted, but PR41 fixed it in TEXT, not in the cap:
- The cap test pins the gap: "an accommodation on a pets key does not cover
  a failed qualifications (another item)" -> still capped (plan diff, S4.1
  "still capped" table; `capOf` at plan ~16856-16869 matches accommodations
  by item only, and `qualifications` is its own item, app/src/lib/requirements.ts:79-81).
- The rubric now says two things. Line ~18124 (unchanged): "accommodation:
  ... Name the requirement key (for example no_pets)." Line ~18125 (new,
  PR41): "raise the accommodation on the field that states it ... an
  accommodation on qualifications, and qualifications is not reported
  failed for that rule."
- For the likeliest real shape - a property with the No pets CHECKBOX
  checked AND a qualifications text that repeats "No pets" - 18124 tells the
  model to name `no_pets`, and 18110 ("qualifications ... can fail only on
  its evictions part") plus 18108 invite it to report `qualifications`
  failed for whatever else it holds. A model that names `no_pets` and also
  lists `qualifications` failed caps an assistance-animal tenant; the code
  has no backstop.
- PR41's third control puts the pets rule ONLY in qualifications (no
  checkbox), so the merge gate never exercises the both-places shape.

Why code, not text. Charter 7.4 puts the cap in code precisely so a model
slip cannot decide it, and disability may only work in the tenant's favor.
The code backstop is also nearly free now: PR41 as built ALREADY lets an
accommodation on `qualifications` lift every failed `qualifications`
(finding 2), so extending that to "an accommodation on any key of a
cap-eligible item also covers a failed `qualifications`, and an
accommodation on `qualifications` covers a failed key of any cap-eligible
item" adds little over-suppression beyond what PR41 accepted.

Fix (pick one, Cameron's call).
(a) Code: the cross-item rule above in `capOf`; flip the pinned "still
    capped" case and add the reverse; keep PR41's rubric line.
(b) Text only, as PR41 chose: reconcile 18124 with 18125 ("name the
    requirement key, and when a rule is also or only stated in another
    field, name that field too") and add the both-places shape (checkbox
    plus qualifications text) to PR41's third control in S8. Then list the
    residual for Cameron: a model that names only `no_pets` and reports
    `qualifications` failed still caps.

## 2. [LOW] [PRECISION] PR41 as built lifts an unrelated qualifications failure; list it for Cameron

What is wrong. Qualifications text often holds several rules (the rubric's
own example, ~18110: "650 credit score, income 3x rent, no evictions in 5
years"). For "No pets. No evictions in 5 years." against a tenant with an
assistance animal AND a recent eviction, the rubric tells the model to raise
an accommodation on `qualifications` for the pets rule (18125) and to report
`qualifications` failed for the eviction (18108, 18110). `capOf` then sees
an accommodation and a failure on the same item and does not cap (the
"accommodation on qualifications covers a failed qualifications" case). The
eviction failure goes uncapped; the model was still told to score Weak, so
only the code enforcement is lost.

Fix. No code change (field granularity cannot tell which rule an
accommodation covers). Add one line to the PR40/PR41 entry for Cameron:
"an accommodation raised on a multi-rule free-text field lifts the cap for
every rule in that field".

---

## Adjudications

- PR40: conceded; the v4 `capOf` (unlawful by base field, accommodation by
  item) and its two tables match spec D9/D10 and trace correctly, including
  `landlord:<key>` -> `<key>`.
- PR41: contested in form only (finding 1); the rubric line itself is right.
- PR42, PR43, PR44: conceded. PR44's parse change keeps any enum-field
  accommodation and drops out-of-enum fields uncounted; `requirementItemOfField`
  is undefined for `notes` / `lease_terms` / `accessibility`, so the cap is
  unaffected.
- All other round-2 rulings conceded.

## Fixes checked and correct (not findings)

- R2F3 / PR32: `PROMPT_FRAMING` holds every framing string, frozen;
  `renderUserContent`, `renderExample` and `buildRankingSystemPrompt` read
  only it; the six pins hash bytes as sent (`JSON.stringify` insertion
  order for the schemas, the rendered examples text, the whole system text
  keyed `r1/e1`). An edit to the rubric, framing, schema, examples or their
  rendering now fails a pin. The test's equality
  `system === RUBRIC_TEXT + "\n\n" + heading + "\n\n" + renderExamplesText()`
  matches the implementation's join.
- R2F12: `fakeInputLabels()` runs in the fake and console constructors only;
  no module-level construction of either driver exists in the plan, and
  `createRankingDriver` builds them only for those kinds, so the production
  worker's import cannot throw and `rankBatch` never throws.
- R2F13: the examples test now calls S3's `propertyMissing` /
  `tenantMissing` on a record rebuilt from each card, and asserts every card
  key is an emitted `cardKey` (or a derived key). `buildStartingEntries(now,
  newId)` exists (app/src/lib/orgStartingList.ts:85); `includedFields`,
  `LANDLORD_DEFAULTS_KEY`, `LAST_HEARD_FROM_KEY`, `PROPERTIES_SEEN_KEY` and
  `requirementItemOfField` are exported by S3 (plan ~10089-10119, 11425-11432,
  13674, 14144-14145).
- R2F10: `tenantMissing(contact, inputs = TENANT_MATCHING_INPUTS)` skips
  non-`field` inputs; the default keeps every existing caller unchanged; the
  new case's `as const` list fits `CompletenessInput`.
- PR43: `assembleRanking` returns the pool's contactIds in pool order on a
  property anchor's failed landlord read; the test asserts the exact object.
- R2F14: the eligibility sentence is scoped to candidates, says the anchor
  is never filtered and an all-unmapped authority is uncertainty; pinned by
  three `toContain` cases.
- S2: `RankingFailedBatch` / `RankingNotScored` docs and the C-notes match
  PR42 (a partial-write batch in BOTH `batchesDone` and `failedBatches`,
  `failure: 'repo'`); the progress test asserts both entries; `failure` is
  typed `string`, so `'repo'` needs no type change. S7 already de-duplicates
  a batch in both lists (plan ~31314-31318). C10 names the three WI7 guards.
  C11 and PR5 say "not confirmed written".
- R2F16: the db-seed.ts:5-8 header is replaced and S2.7 stages the file;
  the only `matches` hit left is the new sentence (db-seed.ts:7 is today's
  sole hit). S2.11 expects exactly the S1.4 commit, whose subject (plan
  ~2408) names D14.2.
- UNVERIFIED still: @anthropic-ai/sdk 0.129.0 typing of adaptive thinking,
  `output_config.effort` with 'xhigh'/'max' and `APIConnectionTimeoutError`
  (no node_modules); C7's STOP rule covers it.
