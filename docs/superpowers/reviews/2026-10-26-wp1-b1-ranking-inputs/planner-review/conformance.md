# WP1 B1 - planner spec-conformance review

Reviewer: independent spec-conformance reviewer (read-only, static reading only; no test suite,
no model call). Branch `feat/wp1-b1-ranking-inputs` @ c70a56c4, base main @ d0e2c2d8.
Contract: `docs/superpowers/specs/2026-10-26-wp1-b1-ranking-inputs-design.md` rev 10, plus charter
`2026-10-24-wp1-matching-charter-design.md` section 6.3/6.4 (AMENDED passages) and section 20
items 1-11. Judged against `git diff main...HEAD` (docs/superpowers/** skipped) and the files it
touches. The plan and the build's review records were NOT read.

**Summary: 95 spec items checked - 90 CONFORMS, 3 PARTIAL, 1 MISSING (expected pending), 1 DEVIATES.
Findings: 1 blocking (the merge gate run, expected pending - Cameron's), 1 high, 1 medium, 5 low.**

The one substantive deviation is the Notes retry guard (PC-1): the spec and the charter keep
today's guard "as is" (moved before the cap); the branch replaces it with a different, narrower
guard. Everything else the brief singled out conforms: the never-written list in the prompt
(sex including sexual orientation and gender identity), the no-address bullet removed while the
address-output rule and postal filter stay, demoted runs appending no line, the 0.7 floor, no
listing_sends write, a failed or partial sent-homes read failing the run, and the probe gate's
3-runs / one-grader-call / ungraded-section / --baseline rules, with no test able to reach the
network.

## Conformance table

| # | Spec item | Verdict | Evidence (file:line) |
|---|---|---|---|
| 1 | D1 leaf module `app/src/lib/tenantMatchingInputs.ts`, imports nothing | CONFORMS | app/src/lib/tenantMatchingInputs.ts:1-152 (no import) |
| 2 | D1 the four entries, key/label/chipLabel/kind/control/source exactly as the table | CONFORMS | app/src/lib/tenantMatchingInputs.ts:37-78 |
| 3 | D1 each entry carries `promptGuidance`; source admits `notes`, no code path | CONFORMS | tenantMatchingInputs.ts:21, :33, :45-76 |
| 4 | D1 `EXTRACTABLE_FIELDS` / `PROVENANCE_FIELDS` iterate the list | CONFORMS | app/src/services/extraction/schema.ts:30-49 |
| 5 | D1 runTypes.ts may import only the leaf; header says so | CONFORMS | app/src/services/extraction/runTypes.ts:1-5 |
| 6 | D1 `DECISION_TARGETS` / `TENANT_ONLY_TARGETS` from the list | CONFORMS | runTypes.ts:13-18, :37-41 |
| 7 | D1 dashboard mirror + drift test importing the app module | CONFORMS | dashboard/src/routes/contact/tenantMatchingInputs.ts:27-68; tenantMatchingInputsMirror.test.ts (new) |
| 8 | D1 edit form, record rows, `SUGGESTION_TARGET_LABEL` iterate the mirror | CONFORMS | ContactEditForm.tsx:937 (map); EligibilityIntakeCard.tsx:86-98; suggestionTargets.ts:24 |
| 9 | D2 storage: four optional attributes, text string, portion whole dollars | CONFORMS | contactsRepo.ts ContactItem extends TenantMatchingInputValues (diff hunk at :114-122); tenantMatchingInputs.ts:90-92 |
| 10 | D2 text: string, trimmed, <=500 after trim, 400 "<Label> must be 500 characters or fewer." | CONFORMS | tenantMatchingInputs.ts:98-100, :144-149 |
| 11 | D2 '' after trim or null CLEARS (REMOVE), not stored '' | CONFORMS | tenantMatchingInputs.ts:124-127, :149; routes/contacts.ts:790-795 |
| 12 | D2 dollars integer 0..20000, null/'' clear, else 400 with the spec copy | CONFORMS | tenantMatchingInputs.ts:102-104, :128-142 |
| 13 | D2 not type-gated server side | CONFORMS | routes/contacts.ts:786-795; test contactTenantMatchingInputs.test.ts ("is not type-gated") |
| 14 | D2 provenance: staff PATCH clears `<key>_source` | CONFORMS | routes/contacts.ts:1963-1969 via PROVENANCE_FIELDS (schema.ts:49) |
| 15 | D2 audit `contact_updated` with field names | CONFORMS | routes/contacts.ts:794 (changedFields.push) |
| 16 | D2 create parser accepts them; create form gains no inputs | CONFORMS | routes/contacts.ts:995-1001; ContactCreateForm.tsx unchanged in source |
| 17 | D2 edit form: one control per entry in list order by `control`, `$` beside the portion, trimmed diff, cleared sends null, client copy matches server | CONFORMS | ContactEditForm.tsx:937-984, :490-500; dashboard tenantMatchingInputs.ts:114-144 |
| 18 | D2 edit form controls sit in the "Eligibility intake" fieldset | CONFORMS | ContactEditForm.tsx:888 (fieldset label), :927-984 |
| 19 | D2 record: four always-render rows, BLANK when unset, AutoBadge + chip | CONFORMS | EligibilityIntakeCard.tsx:86-98, :129, :150-155 |
| 20 | D2 portion `$1,200 / month` in row AND chip | CONFORMS | dashboard tenantMatchingInputs.ts:73-87; EligibilityIntakeCard.tsx:96, :139; SuggestionChip.tsx:47 |
| 21 | D2 labels exact and distinct (no existing intake label as substring) | CONFORMS | tenantMatchingInputs.ts:40-71 vs existing intake labels |
| 22 | D2 card "Preferences & notes" keeps its title | CONFORMS | not touched by the diff |
| 23 | D2 API types `Contact`, `ContactPatch`, `CreateContactInput` gain the keys and `_source` keys | CONFORMS | dashboard/src/api/types.ts (ContactCreate, Contact, ContactPatch extends; TenantMatchingInputSources) |
| 24 | D3 the four join EXTRACTABLE_FIELDS (8 -> 12) | CONFORMS | schema.ts:30-40 |
| 25 | D3 same write/suggest/demotion/provenance/accept/dismiss rule as pets | CONFORMS | apply.ts:427-560 (shared field loop); suggestionResolution.ts:169-175 |
| 26 | D3 a `write` on a NON-EMPTY text field is DROPPED, reason `text_field_filled`, not a suggestion, not in demotedFields | CONFORMS | apply.ts:443-459; runTypes.ts:65-68 |
| 27 | D3 `max_tenant_portion` keeps the pets rule incl. same-fact write | CONFORMS | apply.ts:449 (text kind only) |
| 28 | D3 schema: four required fieldOp entries, zero optional parameters | CONFORMS | schema.ts:79-87 |
| 29 | D3 coercion by kind in BOTH coerceField and coerceAccept (text trim, >500 dropped, empty dropped; dollars strip `$`/commas/spaces, int 0..20000, 1200.50 dropped) | CONFORMS | apply.ts:145-164; suggestionResolution.ts:169-175 (delegates to coerceField) |
| 30 | D3 TENANT_ONLY_TARGETS / DECISION_TARGETS 12 -> 16 | CONFORMS | runTypes.ts:13-18, :37-41 |
| 31 | D3 every hard-coded count updated (prompt "eight", schema comment, twelve/eleven comments, SWEEP_MAX_ATTEMPTS_PER_CALL, DECISION_TARGET_ORDER) | CONFORMS | prompt.ts:57; schema.ts:25-29; journalSweep.ts:85-88; AiRunDetail.tsx:43-48; adapters/extraction.ts:214 |
| 32 | D3 CURRENT PROFILE carries the four | CONFORMS | jobs/extraction.ts:185-197 |
| 33 | D3 prompt guidance from `promptGuidance`, plus the accumulate rule | CONFORMS | prompt.ts:90-103 |
| 34 | D3 noteLines examples "stairs are OK or a problem" and "their rent portion" removed | CONFORMS | prompt.ts:134-138 (main had them at :107-109) |
| 35 | D3 never-written list does not govern the four fields | CONFORMS | probe reports field verdicts only (extraction-prompt-probe.ts:1121-1125) |
| 36 | D4 noteLines widened to matching facts, incl. a fact adding to a filled text field | CONFORMS | prompt.ts:134-140 |
| 37 | D4 reconcile, append-only and short-line rules verbatim | CONFORMS | prompt.ts:153-166 identical to main |
| 38 | D4 never-written list in the prompt, incl. "sex (including sexual orientation and gender identity)", familial list, disability/medical except the need and an assistance animal; need as home feature; household size, portion, animal allowed | CONFORMS | prompt.ts:144-152 |
| 39 | D4 noteLines items `{ text, confidence }`, both required | CONFORMS | schema.ts:118-131 |
| 40 | D4 `EXTRACTION_FACT_MIN_CONFIDENCE` default 0.7, fail-fast 0 < x <= 1 | CONFORMS | config.ts:525-544, :938-939 |
| 41 | D4 parser keeps up to 20 structurally valid items, no value filtering | CONFORMS | schema.ts:173, :272-284 |
| 42 | D4 every value rule in pure exported `filterNoteLines`, called by apply AND the probe | CONFORMS | apply.ts:335-370, :964-972; extraction-prompt-probe.ts:300-316 |
| 43 | D4 clamp text 200, confidence 0..1, non-number reads 0 | CONFORMS | apply.ts:104, :273-276, :354 |
| 44 | D4 floor FIRST and counted, then guard, then system lines, then the five-line cap (model before system) | CONFORMS (order) | apply.ts:350-367 |
| 45 | D4 floor reaches apply as an `ApplyDeps` value; probe passes the same config value | CONFORMS | apply.ts:51-57, :968; worker.ts:501-502; routes/dev.ts:776-777; extraction-prompt-probe.ts:322-324 |
| 46 | D4 `coerceField` exported pure for the probe | CONFORMS | apply.ts:145 |
| 47 | D4 system lines carry no confidence, not floored | CONFORMS | apply.ts:362-366 |
| 48 | D4 demoted run (hasInferredRoleContent) appends NO line, model and system alike | CONFORMS | apply.ts:368, :971; jobs/extraction.ts:592, :701 |
| 49 | D4 kept as is: `[Auto - <date>]` prefix, read-modify-write of notes | CONFORMS | apply.ts:963-987 |
| 50 | D4 kept as is: the VERBATIM retry guard (apply.ts:731-740 on main) | DEVIATES | apply.ts:337-347, :358 - see PC-1 |
| 51 | D4 run record `notedLines` + `notesBelowFloor` + `notesDemoted` | CONFORMS | jobs/extraction.ts:715-717, :769-770; aiRunsRepo.ts:71-78 |
| 52 | D5.1 `propertyLabel` in a leaf: `<line1>[ <line2>], <city>`, one line, undefined on empty line 1 or city | CONFORMS | app/src/lib/propertyLabel.ts:48-68 |
| 53 | D5.1 `labelMatches`: fold lowercase, remove `.` `,` `#`, collapse whitespace, trim; boundary match; no abbreviation folding | CONFORMS | propertyLabel.ts:71-88 |
| 54 | D5.1 read `listByContact`, LISTED rows only, for tenant and unknown | CONFORMS | jobs/extraction.ts:637-645; listingSendsRepo.ts:235-237, :497 (unchanged); ineligible types gated at jobs/extraction.ts:502 |
| 55 | D5.1 newest 20 by sentAt | CONFORMS | sentPropertiesBlock.ts:42, :81-95 |
| 56 | D5.1 `getDisplaysByIds` gains `requireComplete`: failed chunk or unread key throws `IncompleteBatchReadError`; not-found skipped; existing callers unchanged | CONFORMS | unitsRepo.ts:678, :1317, :1323-1325; contactsRepo.ts IncompleteBatchReadError table param (default 'contacts') |
| 57 | D5.1 extraction passes `requireComplete` | CONFORMS | jobs/extraction.ts:642 |
| 58 | D5.1 block built once per run, before TRANSCRIPT, fingerprinted as `sentPropertiesFingerprint` | CONFORMS | jobs/extraction.ts:663-664; prompt.ts:255-260; aiRunsRepo.ts:59-63 |
| 59 | D5.1 line shape `- <label> - sent <date>` / `- signed up <date>` (latest counted share is flyer) | CONFORMS | sentPropertiesBlock.ts:88-92, :114 |
| 60 | D5.1 identical labels once; TRANSCRIPT line dropped with warn; 4,000-char budget oldest first with warn; "PROPERTIES SENT: none" | CONFORMS | sentPropertiesBlock.ts:104-145; jobs/extraction.ts:650-661 |
| 61 | D5.1 a failed `listByContact` or incomplete units read FAILS THE RUN | CONFORMS | jobs/extraction.ts:637-649 (`failed('repo', err)`) |
| 62 | D5.1 system prompt names the block; no change to `renderUtteranceLine` or the per-message hash | CONFORMS | prompt.ts:29-35, :232-234 (unchanged) |
| 63 | D5.1 `listingSends` and `units` REQUIRED deps at every construction site | CONFORMS | jobs/extraction.ts:118-130; worker.ts:471-473; routes/dev.ts:746-749 |
| 64 | D5.2 feedback noteLine names the property by copying its label; free wording; example | CONFORMS | prompt.ts:167-175 |
| 65 | D5.2 say plainly when unsure; never a maybe into a no | CONFORMS | prompt.ts:176-177 |
| 66 | D5.2 place feedback names a home only when tied | CONFORMS | prompt.ts:178-180 |
| 67 | D5.2 reconcile: recorded feedback not repeated; change of mind is a new line | CONFORMS (elaborated) | prompt.ts:181-185 (adds "The label is the one wording ... a noteLine may repeat") |
| 68 | D5.2 no-address bullet REMOVED, nothing in its place; address-output bullet and postal filter KEPT | CONFORMS | prompt.ts:188-193 (bullet gone; main :132-133); apply.ts:336, :360, :364 |
| 69 | D5.2 never-written list governs feedback | CONFORMS | prompt.ts:186-187 |
| 70 | D5.3 no new filter; feedback goes through D4 exactly | CONFORMS | apply.ts:964-972 |
| 71 | D5.3 `feedbackLines` / `unlabeledAddressLines` counts over appended lines; street-suffix list | CONFORMS | sentPropertiesBlock.ts:155-166; propertyLabel.ts:91-105; jobs/extraction.ts:720-724; AiRunDetail.tsx:71-86 |
| 72 | D5.3 / D5.4 never a status; no reactions attribute, writer, `shares_op` change; no listing_sends write | CONFORMS | listingSendsRepo.ts untouched; dep typed `Pick<ListingSendsRepo,'listByContact'>` (jobs/extraction.ts:129); test WI10 in extractionJob.test.ts |
| 73 | D6 `priority` boolean validator; unitsRepo and dashboard types boolean; `=== true` only on test | CONFORMS | unitFields.ts:106-111; unitsRepo.ts:464-466; types.ts UnitItem priority |
| 74 | D6 checkbox on New and Edit, own row after Same-day RTA, TaggedCheckbox Staff only; PROPERTY_FORM_FIELDS row in app + dashboard mirror; never on the flyer | CONFORMS | ListingEditForm.tsx:614-622; UnitCreateForm.tsx:747-755; requirements.ts:552-554; dashboard requirements.ts:276-277; unitFields.ts:364 |
| 75 | D6 ListingDetail row Yes/No and header pill when on | CONFORMS | ListingDetail.tsx:890, :1006 |
| 76 | D7 probe refactor: exported `main`, `invokedDirectly` guard; `--suite never-written` via production block renderer, driver, prompt, schema, `filterNoteLines`, `coerceField`; touches no data | CONFORMS | extraction-prompt-probe.ts:268-277, :300-316, :926-970, :1903-1931 |
| 77 | D7 default suite on branch and main, 3 runs, fail on case drop >=2 or total drop >2, one re-run, both in the record | PARTIAL | extraction-prompt-probe.ts:697-716, :1816-1900 - extra fail rules and `--baseline` instead of `--repo`, see PC-5 |
| 78a | D7 cases: one per excluded kind x {free, feedback}, sex feedback case plants orientation; controls (household size, portion field, need field, animal, plain fact, unsure/no/yes feedback, untied place, no-address-op) | CONFORMS | extractionProbeNeverWritten.ts:255-421 |
| 78b | D7 feedback control by meaning: labelMatches for tied, "line written and none names a sent property" for untied | CONFORMS | extraction-prompt-probe.ts:892-924 |
| 78c | D7 grader: one call per run with items, same model/key, structured output, gets list descriptions + planted fact + items, never the conversation; no items -> no call | CONFORMS | extraction-prompt-probe.ts:977-980, :1763-1768; extractionProbeNeverWritten.ts:154-157 |
| 78d | D7 grader gets "the never-written list as plain descriptions of each excluded kind" | PARTIAL | extractionProbeNeverWritten.ts:63-109 - extra NOT-EXCLUDED allowances, see PC-2 |
| 78e | D7 excluded LINE fails its case (any case); excluded FIELD value reported only | CONFORMS | extraction-prompt-probe.ts:1121-1125 |
| 78f | D7 grader failure or unparseable output -> UNGRADED; case fails unless 2 of 3 runs scored AND graded | CONFORMS | extraction-prompt-probe.ts:1075-1099, :1126-1134 |
| 78g | D7 grader prompt in the data module, pinned by a test; vendor call via app/src/adapters, injected | CONFORMS | extractionProbeNeverWritten.ts:81-109; adapters/extraction.ts:444-542; extraction-prompt-probe.ts:1588-1590 |
| 78h | D7 record per case: planted fact, every written line, every field value, each with verdict, kind, reason; an "ungraded lines" section | CONFORMS | extraction-prompt-probe.ts:1332-1461 (incl. "Lines the grader did not judge" :1385-1402) |
| 78i | D7 record carries commit, model, extraction + grader prompt fingerprints, per-case user-content hash | CONFORMS | extraction-prompt-probe.ts:1346-1355, :1252-1255, :1101-1107 |
| 78j | D7 token usage (extraction and grader), truncations, cost from a dated price table | PARTIAL | extraction-prompt-probe.ts:1358-1360; price table in extractionProbeNeverWritten.ts:439-447 - grader truncations not counted, see PC-4 |
| 78k | D7 `--model` REQUIRED; key from env, last four only | CONFORMS | extraction-prompt-probe.ts:1550-1556, :548-552 |
| 78l | D7 pass: zero excluded lines, every case graded 2/3, every control 2/3, zero truncations, exit 0; plus Cameron's sign-off section | CONFORMS (automatic part) | extraction-prompt-probe.ts:1114-1159, :1452-1459, :1812 |
| 78m | D7 unit tests with stub driver and stub grader, no network | CONFORMS | app/test/extractionPromptProbe.test.ts:120-160, :876-893; structuredOutputClient.test.ts:17 (vi.mock SDK) |
| 78n | D7 GATE: a never-written gate run passes on the final prompt with Cameron's sign-off before merge-ready | MISSING (expected pending) | no `never-written-test.md` in the review folder - see PC-3 |
| 79 | Section 4: public intake, importer, Today untouched; lean seed byte-stable, full seed tenant gains the four | CONFORMS | not in the diff; seed/cast.ts:454-460; seedTenantMatchingInputs.test.ts |
| 80 | Section 4 docs: RUNBOOK demotion sentence, `claude-sonnet-5-5`, extraction section; env examples gain the floor uncommented; GLOSSARY nouns + "Preferences & notes" vs "Preferences and constraints" | CONFORMS | RUNBOOK.md:1443-1490, :1516-1540; .env.example, .env.dev.example, .env.prod.example; GLOSSARY.md (new entries) |
| 81 | Section 5 tests: D2/D3/D4/D5/D6 behavior tests named in the spec | CONFORMS | contactTenantMatchingInputs.test.ts, extractionApply.test.ts, extractionNoteLines.test.ts, configAiExtraction.test.ts:112-131, unitsRepoDisplays.test.ts:169-219, extractionSentPropertiesBlock.test.ts, propertyLabel.test.ts, extractionJob.test.ts (D5.1 describe), unitFields.test.ts |
| 82 | Section 5 e2e: four fields, extraction write/suggest/floor, feedback line in the card, Priority, string noteLines moved to objects | CONFORMS | e2e/tests/dashboard-next/tenant-matching-inputs.spec.ts, property-priority.spec.ts, flows/conversation-fact-extraction.spec.ts, caseworkers.spec.ts, ai-run-log.spec.ts |

Tally (rows 1-82 with 78a-78n as fourteen D7 sub-items = 95 rows): CONFORMS 90, PARTIAL 3 (77,
78d, 78j), MISSING 1 (78n, expected pending), DEVIATES 1 (50). PC-6 to PC-8 are additions beyond
the spec with no row of their own.

## FINDINGS

### PC-1 - high - CONFIRMED - the Notes retry guard is replaced, not kept

Spec sentence (D4): "Kept as is: the `[Auto - <date>]` prefix, the verbatim retry guard
(apply.ts:731-740), and the read-modify-write of `notes`." and (D4 Order) "drop lines the retry
guard finds already present (today's guard, apply.ts:738-740, moved BEFORE the cap)". Charter
6.4: "its retry guard (apply.ts:731-740, which drops a line already present so a re-applied
window appends nothing) are kept as they are." Charter section 20 records no change to it.

Code: main's guard dropped a candidate when the notes CONTAINED, anywhere and under any date,
either `<prefix> <line>` or the bare `<line>` (main apply.ts:738-740). The branch's guard
(apply.ts:337-347, :358) drops a MODEL line only when `<this run's prefix> <line>` equals a run of
WHOLE lines already in the notes - i.e. only a same-day, whole-line repeat; a SYSTEM line is
dropped when it equals a whole line of any date with prefixes removed. It also strips any
`[Auto - ...]` prefix the model copied (apply.ts:224-235, :353). The header comment (apply.ts:
293-325) says this was decided in the build's code review (R2/R3/R4) and lists its accepted
costs. So: the guard is moved before the cap as the spec asks (conforms), AND its matching rule
is changed (deviates). Plainly: yes, it differs from what the spec keeps.

What now gets appended that main's guard dropped:
- a model line repeating, word for word, a line from an EARLIER date;
- a model line equal to, or contained in, a staff-typed line;
- a model line contained in a longer earlier line;
- a re-applied window whose retry crosses UTC midnight (the prefix date changes);
- a retry of a capped run appends the lines the cap kept out of run 1 (up to five more).

Failure scenario: Oct 20 the tenant texts "I work nights downtown"; the run appends
`[Auto - Oct 20] Works nights downtown`. Oct 23 she texts about a tour; the window still holds
the Oct 20 message (seen messages stay in the window up to the age floor) and the model, despite
the RECONCILE instruction, emits "Works nights downtown" again. On main the bare-line check drops
it; on the branch it is appended as `[Auto - Oct 23] Works nights downtown`. Repeated across
runs, the Notes box (which CURRENT PROFILE sends in full and B2's card reads) accumulates
duplicates. The change also fixed real problems (feedback on "12 Oak St" swallowed by an earlier
"112 Oak St" line; a change of mind back to earlier words dropped), so the issue is not that the
new rule is wrong but that a binding spec and charter decision was changed without Cameron's
recorded go. Needed: Cameron rules on it and, if kept, the spec D4 and charter 6.4 text and a
charter section 20 entry are amended; otherwise restore today's matching rule.

### PC-2 - medium - PLAUSIBLE - the grader is told several facts on the list are allowed

Spec sentence (D7): the grader call "gets: the never-written list as plain descriptions of each
excluded kind, the case's planted fact (or "none"), and every item to judge". D4 list: never a
line stating "sex (including sexual orientation and gender identity) ... or disability or medical
facts other than the stated accessibility need ... The need is the home's feature ("needs a
ground floor"), never a diagnosis."

Code: GRADER_SYSTEM_PROMPT adds a NOT EXCLUDED list (extractionProbeNeverWritten.ts:88-97). The
home-features bullet (:93) carries Cameron's 2026-10-27 ruling and is fine. Three others are not
in the spec or charter: "A pronoun (she, he, they) used for the tenant" (:94), "Who lives in the
household named by relationship ("lives with her mom", "the tenant and her two sons")" (:95), and
"A mobility aid the tenant uses ... ("uses a wheelchair", "uses a walker")" (:96). The first two
contradict the grader's own sex description (:67: "the sex ... of the tenant or a household
member"); the third admits a disability fact beyond the home-feature need. The extraction prompt
itself grants none of these allowances (prompt.ts:144-152).

Failure scenario: the model writes the Notes line "Uses a wheelchair; lives with her two sons".
The grader, following :94-96, judges it clean; the never-written run exits 0. The line states a
disability and the sex of the tenant and children, which the spec's list forbids. Mitigation:
the record prints every clean verdict with its reason under its case (extraction-prompt-probe.ts:
1430-1435), so Cameron can overrule in the sign-off - but only if he reads every clean line.
Needed: Cameron confirms these allowances at sign-off (they may well be what he wants), and the
spec D7 text names them; or they are removed from the grader prompt.

### PC-3 - blocking (merge gate) - CONFIRMED - the never-written gate run has not been made

Spec sentence (D7 Gate): "B1 is not handed back merge-ready until a gate run passes on the final
prompt, or Cameron decides." Section 6: "Merge gate: the never-written record with Cameron's
sign-off (D7) plus the five repo gates."

Evidence: no `never-written-test.md` exists under
`docs/superpowers/reviews/2026-10-26-wp1-b1-ranking-inputs/`. The tip commit's subject
(c70a56c4) says the handback is "merge-ready PENDING the never-written gate run". This is the
expected state (Q2: Cameron runs it himself on `claude-sonnet-5-5`), not a code defect; it is
listed so the counts are honest. Failure scenario: merging before the run ships an uncertified
widened prompt to production with no switch (charter section 20 item 1). Needed: Cameron runs
BOTH commands (`--suite never-written` and the `--baseline` comparison) on the final prompt and
signs the record; note that resolving PC-1 or PC-2 by changing the prompt or the grader prompt
changes a fingerprint and requires that run to happen after the change.

### PC-4 - low - CONFIRMED - a grader truncation is not counted as a truncation

Spec sentence (D7): the record carries "Token usage (extraction and grader calls), truncations";
Pass requires "zero truncations"; "If the output cap truncates, it is raised ... and the run
repeated."

Code: `judgeCase` counts only extraction-call truncations (`r.failure === 'truncated'`,
extraction-prompt-probe.ts:1123). A grader call that stops at max_tokens returns
`failure: 'truncated'` (adapters/extraction.ts:509-514) and `applyGrade` turns it into an
UNGRADED run (extraction-prompt-probe.ts:1077-1079); the record's "truncated" count
(:1359) excludes it. Failure scenario: a case whose second run writes many lines gets a grader
answer cut off by the 4096-token cap; that run is ungraded, the other two runs are graded, the
case passes 2 of 3 and the suite exits 0 with "truncated: 0". Nothing is hidden (the run's items
appear under "Lines the grader did not judge"), but the spec's "zero truncations, raise the cap
and repeat" rule does not fire for the grader. Needed: count grader truncations in the
truncation total, or state in the spec that the rule covers extraction calls only.

### PC-5 - low - CONFIRMED - the default-suite comparison adds fail rules and renames `--repo`

Spec sentence (D7): "the default suite runs on the branch and on main (`--repo`) ... The branch
FAILS when any case's ok count is 2 or more below main's, or the suite's total ok count is more
than 2 below main's; a result within those bounds passes."

Code: `compareDefaultSuites` also fails when any case has fewer than 2 of 3 measured calls on
either side, and when the branch truncates at all (extraction-prompt-probe.ts:697-716); the main
checkout is named with `--baseline`, `--repo` keeping its old meaning (:1496-1500, :1819). The
extra rules are stricter and well reasoned (an expired key can never pass), and RUNBOOK.md
documents them, so the risk is only a record that fails where the spec says it passes. Failure
scenario: main's side refuses one case twice (a transient), the branch scores identically; the
spec says pass, the probe says FAIL and re-runs. Needed: fold the stricter rules into spec D7 at
the next spec touch; no code change needed.

### PC-6 - low - CONFIRMED - `.env.example` uncomments four pre-existing extraction variables

Spec sentence (Section 4 / 6): "env example files gain `EXTRACTION_FACT_MIN_CONFIDENCE=0.7`".

Code: the `.env.example` hunk also uncomments `AI_EXTRACTION_ENABLED=true`,
`EXTRACTION_DRIVER=console`, `AI_EXTRACTION_MODEL=claude-opus-4-8` and
`AI_EXTRACTION_DEBOUNCE_MS=30000`. Each value equals the non-production code default, so local
behavior does not change, and it matches the repo's "every var uncommented with its default"
habit. Out of B1's scope, though. Failure scenario: someone builds an env file from
`.env.example` for a non-development context and now gets `AI_EXTRACTION_ENABLED=true` explicitly
rather than by default. Needed: none beyond noting it in the handback.

### PC-7 - low - CONFIRMED - the assistance-animal control plants an excluded fact

Spec sentence (D7): "Control cases plant none." Control: "an assistance animal (a line)".

Code: `control-assistance-animal` says "my therapist wrote the letter for him" and carries a
`plantedFact` about the therapist (extractionProbeNeverWritten.ts:343-357); the record marks it
"stated in this control by design" (extraction-prompt-probe.ts:1414-1418). This makes the control
double as a medical-fact test, which is arguably stronger. Failure scenario: the model writes
"Has an ESA letter from her therapist"; the grader judges it excluded and the control FAILS even
though the animal was recorded - correct under "a line judged excluded fails its case, in any
case", but the spec's control was a plain animal statement. Needed: confirm the case wording at
sign-off, or record the change in spec D7.

### PC-8 - low - CONFIRMED - copied `[Auto - <date>]` prefixes are stripped from model lines

Spec sentence (D4): the pure filter clamps "text to 200 characters"; the prefix is "kept as is".

Code: `filterNoteLines` removes EVERY leading `[Auto - ...]` from a model line before the floor,
guard and write (apply.ts:224-235, :353). Not in the spec; it prevents a doubled prefix when the
model copies one from the notes. Harmless, and it pairs with PC-1's guard change (it is what lets
a same-day echo be recognized). Failure scenario: none harmful found; a model line that begins
with a bracketed `[Auto - x]` as real content would lose it. Needed: mention it with PC-1's
ruling.

## Checks the brief asked for, answered plainly

- Never-written list in the prompt including "sex (including sexual orientation and gender
  identity)": present, prompt.ts:144-152. CONFORMS.
- No-address bullet deleted; postal filter and address-output rule stay: bullet gone (main
  prompt.ts:132-133), address-output bullet at prompt.ts:188-193, postal filter at apply.ts:336,
  :360, :364. CONFORMS.
- Demoted runs append no Notes lines: apply.ts:368 returns an empty `append` for model and
  system lines alike; the job passes the flag (jobs/extraction.ts:701, apply.ts:971). CONFORMS.
- Confidence floor and default 0.7: config.ts:525-544, applied with `<` so 0.7 is kept
  (apply.ts:356). CONFORMS.
- Notes retry guard: DIFFERS from the spec - see PC-1.
- No write to listing_sends: listingSendsRepo.ts is untouched; the job's dep is
  `Pick<ListingSendsRepo, 'listByContact'>` (jobs/extraction.ts:129); grep finds no other
  reference in the extraction path or the probe. CONFORMS.
- A failed or partial sent-homes read fails the run: jobs/extraction.ts:637-649 with
  `requireComplete: true`, which throws on a failed chunk or unread key (unitsRepo.ts:1317,
  :1323-1325). CONFORMS.
- Probe gate rules: 3 runs per case (GATE_RUNS, extractionProbeNeverWritten.ts:30;
  `--runs` refused, extraction-prompt-probe.ts:1558); one grader call per run with items, none
  without (:1763-1768); the "Lines the grader did not judge" section (:1385-1402); the
  `--baseline` comparison (:1816-1900, see PC-5). CONFORMS apart from PC-4/PC-5.
- No test can reach the network: every never-written CLI test uses `nwHarness` with a stub
  grader and every test injects `createDriver` (app/test/extractionPromptProbe.test.ts:120-160,
  :876-893); the SDK is mocked in structuredOutputClient.test.ts:17 and
  extractionAdapter.test.ts:10. CONFORMS.
