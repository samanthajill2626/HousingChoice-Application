# WP1 B1 Ranking inputs - design review round 1, reviewer A

Spec: docs/superpowers/specs/2026-10-26-wp1-b1-ranking-inputs-design.md (rev 1)
Charter checked: docs/superpowers/specs/2026-10-24-wp1-matching-charter-design.md
Repo state: W:\tmp\wp1-b1-ranking-inputs @1d86f59f. Read-only review.

Citations the spec makes that I checked and found ACCURATE (so they are not
re-litigated below): contactsRepo.ts:286-287; contacts.ts:1939-1947 (provenance
clear); contacts.ts parseTriageBody pets/tenure store '' and
voucher_expiration_date maps ''/null to REMOVE; schema.ts:8-13 (zero optional
parameters); prompt.ts:107-109; apply.ts:666, 713-751, 731-740;
journalSweep.ts:84-86; AiRunDetail.tsx:40-44; jobs/extraction.ts:635-636;
routes/aiRuns.ts:257-259; shareLedger.ts:205-224 (MAX_REAPPLY = 3);
unitFields.ts:116 and :359; adapters/extraction.ts:184; RUNBOOK.md:1465;
requirementsMirror.test.ts precedent; steps.ts:930; lib/caseworkers.ts:42-82;
listing_sends GSIs project ALL (lib/tables.ts:14), so reactions are readable
from byContact with no infra change; priority has no production writer other
than the generic unit PATCH (only airtableSource.ts:58,156 parses it).

---

## 1. [HIGH] Message and property handles have no owner: apply cannot map a handle back to a message or a unit

What is wrong. D5 says message handles `m1..mN` are "added at prompt
assembly". Prompt assembly happens INSIDE the driver:
`AnthropicExtractionDriver.extract` calls `buildExtractionUserContent(input)`
(adapters/extraction.ts:265; prompt.ts:183-196). The job never sees the
assembled prompt, and `applyExtraction` receives only `{ contact,
conversationId, cursorTsMsgId, result, hasInferredRoleContent, runId,
orgEntries }` (apply.ts:151-170). Yet D5's apply must "drop an item whose
property or message handle is unknown, whose message is not a client
utterance", and must stamp `at` and `sourceMsgId` from the message. Nothing in
the spec says where the handle -> tsMsgId map and the handle -> unitId map are
built, who owns the numbering, or how they reach apply.

Evidence. prompt.ts:189 sorts the transcript globally by `at` inside the
builder; numbering "per message" must be computed after that sort. The fake
driver (extractionFake.ts:63-110) bypasses the builder entirely, and D7's
script runs "the production extraction driver, prompt, schema and apply-side
filters" outside the job (processRow, jobs/extraction.ts:392-641), so each of
the three callers would have to re-derive the numbering independently.

Also unstated: the system prompt fixes the line format as
`"<timestamp> [<speaker>/<channel>] <text>"` (prompt.ts:23-24); the new format
with the handle is not written down.

Implies. Three places reproducing one numbering is exactly the divergence the
codebase's single-renderer rule exists to prevent (prompt.ts:170-178). A
mismatch silently attaches a reaction to the wrong message or drops every
reaction. Fix in the spec: the JOB assigns both handle maps (on
`ExtractionInput`, e.g. a handle per utterance and the rendered PROPERTIES SENT
block plus its map), the builder only renders what it is given, and the same
maps are passed in apply's ctx. State the new transcript line format verbatim.

## 2. [HIGH] Reaction dedupe contradicts "one item per message per property", and a wrong reaction can never be corrected

What is wrong. The prompt rule is "one item per message per property" (D5
Prompt rules), but the dedupe key is `(sourceMsgId, kind)` (D5 Apply). Every
run re-sends already-extracted ("seen") messages for up to 30 days, and up to
200 messages with no age floor on a manual run (jobs/extraction.ts:493-498,
533-537). The PROPERTIES SENT block shows recorded reactions as "kind and
short text" only - not which message each came from - so the model cannot
reconcile per message. A later run that re-reads the same tenant message and
classifies it `maybe` instead of `interested` passes dedupe and appends a
second, contradictory reaction for the same message. The 50-per-row cap that
drops the oldest also drops their dedupe keys, so a still-in-window message can
be re-added.

There is no correction path. Notes lines are fixable because staff can edit
the Notes box (charter 6.4: "Sam fixes or removes a wrong line by editing the
Notes box"). Reactions are not exposed by `toListingSendRow`, shown nowhere
(D5 Read surface, Q3), not editable, and never removed except by the cap. A
misread `hard_no` sits on the pair invisibly and B2's ranker reads "every
extracted reaction" (charter 6.3).

Implies. Pair history the ranker scores from accumulates duplicates and
self-contradictions with no human able to see or fix them. Fix: make the
dedupe key `sourceMsgId` alone (one reading per message per row; a
re-classification either is skipped or replaces in place, decide which), and/or
accept reactions only from messages NEW to this run (`tsMsgId > cursor`); show
the source message handle next to each recorded reaction in the block; and
either answer Q3 with a read surface or state explicitly that wrong reactions
are uncorrectable until B3.

## 3. [HIGH] The never-written merge gate can pass while the protected fact is recorded

What is wrong. D3's guidance for `preferences_constraints` is "anything else
the tenant states they want or cannot accept in a home (... school, ...)", and
D3 states the never-written list does not govern the four fields. D7's case
"I love it, it's close to my mosque" will most naturally land as a stated
preference in `preferences_constraints` (or "near my kids' school" for the
familial case). D7's detection checks "any appended line or reaction text"
only, and "The record lists EVERY line and reaction written" - field writes are
not recorded. So the gate passes precisely when the model moves the banned
fact one key over, into a free-text field B2's card reads (charter 6.2 lists
the B1 fields on the tenant card).

Separately, the pass criterion is a case-insensitive banned-term match. A
paraphrase ("near a place of worship", "expecting in March") evades it, and
"a person can read them" is not part of the pass rule, so a term-clean but
fact-bearing run is a pass.

Charter 20.2 keeps the fields outside the list and outside the test, so this
finding does not ask to fail on fields. It asks that the gate MEASURE what it
certifies: the record must list every field value written in every
excluded-kind case and flag banned terms found there (reported, not failing,
per charter), and the pass rule must include a human sign-off on the record.
If that reporting shows displacement, that is a decision for Cameron (charter
15.4 protects 6.4), not something B1 should ship silently.

## 4. [MEDIUM] "One list, a move is a change in one place" is a slogan the mechanism does not deliver

What is wrong. D1 claims every B1 reader is "driven by the list rather than by
the four names" and that moving a fact later is "change its entry, delete its
form input (the mirror entry)". The mechanism contradicts this:

- D3's prompt guidance is hand-written prose per field; it is not in the list
  entry, so a move needs a prompt edit too.
- D2 gives the fields different controls (two single-line inputs, a textarea,
  a number with `$`); `kind: text | dollars` cannot express input vs textarea,
  so the form is keyed by name, not by the list.
- The list's labels are Title case ("Area preference"); SUGGESTION_TARGET_LABEL
  is lowercase ("time at current address", suggestionTargets.ts:9-22) and forms
  the chip's accessible name, so "from the mirror" cannot be literal.
- runTypes.ts is documented "Leaf module by design: this file imports nothing"
  (runTypes.ts:2); deriving DECISION_TARGETS / TENANT_ONLY_TARGETS from the list
  makes it import tenantMatchingInputs.ts.
- A real move strands existing state the spec never mentions: stored attribute
  values on contacts, pending suggestions for a target no longer in
  EXTRACTABLE_FIELDS (accept throws 400 `unknown_target`,
  suggestionResolution.ts:380-413), resolution journals keyed by
  DECISION_TARGETS (suggestionResolutionRepo.ts:651), dismissal tombstones, and
  historic run-log decisions keyed by the target.

Implies. Charter 6.4/15.1 bind "a change in ONE place". Either put
`promptGuidance`, `control` and the chip label on the entry, and add a short
section saying what a source move does to existing values, suggestions and
journals; or state honestly that the move is several edits plus a data step.

## 5. [MEDIUM] A run whose only output is reactions reports "nothing new" everywhere

What is wrong. The job's outcome is `applied` only when
`wrote + suggested + notedLines > 0` (jobs/extraction.ts:639-640); the
`ai_run.completed` event carries only those three counts
(jobs/extraction.ts:791-802); apply emits `suggestion.updated` on the same three
(apply.ts:754). The manual-run banner says "Ran - nothing new to extract."
when wrote + suggested is 0 and noted is 0 (ContactDetail.tsx:1597-1604) - and
that comment records the SAME bug being fixed for notes ("reporting it as
nothing new would contradict the run log"). D5 adds `reactionsWritten` to the
run record but changes none of these readers.

Implies. A reaction-only run is outcome `no_op` in the run log filter
(AiRunList.tsx:10) and "nothing new" on the banner, while Q3 leaves reactions
shown nowhere else. Count `reactionsWritten` toward `touched`, add it to the
completion event and the banner copy.

## 6. [MEDIUM] The PROPERTIES SENT block has no size budget

What is wrong. D5 renders up to 20 rows, each with "the reactions already
recorded on the row", and a row may hold up to 50 reactions of up to 200
characters. That is up to ~200,000 characters re-sent on EVERY run of that
tenant's conversations. The block it is modeled on carries an explicit
16,000-character budget with priority drops (orgListBlock.ts:19, :98-136) and
the job warns when it drops (jobs/extraction.ts:570-579); the spec copies the
TRANSCRIPT rule but not the budget. The window's own input caps exist for
cost (jobs/extraction.ts:71-83: "worst-case run input ~15k tokens").

Also undefined: what happens to a property line whose address or reaction text
contains the word TRANSCRIPT (the org block drops such entries as
`unrenderable`); dropping a line renumbers `p` handles unless the map is built
after the drop.

Implies. Unbounded per-run token spend and a new truncation source on a
driver capped at 4096 output tokens. Add a character budget and a per-row
reaction limit for the block, with drop rules and a warn, and fix the handle
map after drops.

## 7. [MEDIUM] Unenumerated dependency: the block needs unit addresses the job has no repo for

What is wrong. A listing_sends row carries no address
(ListingSendItem, listingSendsRepo.ts:84-127); D5's block line needs "the
address line and city". The job therefore needs a units read (unitsRepo has a
BatchGet projecting `unitId, address`, unitsRepo.ts:1293). D5's
Dependencies line names only `listingSends` for worker.ts, routes/dev.ts and
the harnesses. Behavior for a listed row whose unit no longer resolves is not
stated (skip the line? render a placeholder? does it keep a handle?).

Implies. A construction-site miss in one of the four deps sites (the
codebase's pattern is REQUIRED deps so a miss is a typecheck failure,
jobs/extraction.ts:101-123). Name the units dependency and the missing-unit rule.

## 8. [MEDIUM] The floor and the five-line cap are applied in the wrong order, and notesBelowFloor cannot be counted

What is wrong. `parseExtractionText` already keeps only the first 5 noteLines
(schema.ts:268-274) before apply ever sees them; apply then caps at 5 again
after appending system lines (apply.ts:720-723). With the floor in apply, a
response whose first five lines are below 0.7 loses passing lines 6+. The
widened instruction makes longer lists likelier. D4 also says the floor is
enforced in apply "not only in the parser": if the parser drops sub-floor lines
it needs a config value it has no access to (it is called inside the driver,
adapters/extraction.ts:360), and apply's `notesBelowFloor` then reads 0 for
every anthropic run.

Implies. Specify: the parser keeps every structurally valid item (or a larger
bound), apply filters by the floor FIRST, then applies the five-line cap, and
counts below-floor drops there. Same ordering for reactions (floor, then the
5-per-run cap).

## 9. [MEDIUM] Handles outside the renderer break a documented invariant the spec calls "unchanged"

What is wrong. renderUtteranceLine is documented as "THE single renderer: the
extraction request is built from it and the run log hashes its output, so the
recorded hash and the sent bytes can never diverge" (prompt.ts:170-178);
hashRenderedMessage hashes "the exact rendered lines sent for one message"
(runWindow.ts:50-56); and the builder states "every line after that header must
be a rendered transcript line" (prompt.ts:191-193). D5 prepends handles outside
the renderer and asserts nothing changes. Historic runs do still verify, but
every new run's hash no longer covers the bytes sent, and the run record stores
no handle -> message mapping, so the `message` handle in a run's raw output
cannot be audited against the window (AiRunDetail's window table has no handle
column, AiRunDetail.tsx:51-54).

Implies. The spec must either amend those invariants and their docblocks
explicitly, or render the handle in the renderer and version the window hash.
Either way, record the handle per window message so a reaction is auditable.

## 10. [MEDIUM] Unenumerated writer of `notes`: the importer overwrites the whole Notes box

What is wrong. Section 4 lists the tenant `notes` writers as "staff PATCH,
extraction append (D4)". `upsertContact` in the importer does
`SET notes = :notes` on an EXISTING contact whenever the workbook row has notes
(lib/import/apply.ts:1106-1198, the SET at :1196-1198) - a wholesale replace,
not an append. B1 makes the Notes box the store for matching facts the ranker
reads (charter 6.1, 6.4) and the destination for the fields later
(extraction-fields-to-notes). A re-import erases every accumulated
`[Auto - <date>]` line, including the caseworker signal lines.

Implies. Pre-existing behavior, but B1 raises its cost. Name it in section 4 as
a watch item and file a docs/issues entry (the fix itself may be out of
scope).

## 11. [MEDIUM] The gate record cannot prove it ran on the final prompt

What is wrong. D7: "B1 is not handed back merge-ready until a gate run passes
on the final prompt" and "a prompt change after a passing run requires a new
run". The record's contents are "per-case results, token usage, truncations
and the run's dollar cost" - no prompt fingerprint, no commit. The fingerprint
covers only the system prompt and the schema (prompt.ts:137-154); the new
PROPERTIES SENT block format and the transcript handles live in the user
content, which no fingerprint covers, so a change there changes model behavior
with no recorded trigger for a re-run. "Dollar cost" needs a price table; the
charter's price table is B2 config (charter 14).

Implies. A reviewer cannot check the gate. Record the extraction prompt
fingerprint, the commit, and a hash of the user-content builder output for each
case; define "prompt change" as any change to those; define where prices come
from (or drop the dollar figure).

## 12. [MEDIUM] The e2e reaction assertion does not prove the writer

What is wrong. Section 5 asserts "a reaction lands on a sent pair (asserted
through a dev read or the AI run detail)". The run detail shows the model's raw
response and parsed result (AiRunDetail.tsx:87-88) - what the MODEL said, not
what `appendReactions` stored. "A dev read" is a new dev seam that section 4's
surface list does not include.

Implies. The one end-to-end test of the new writer can pass with the writer
broken. Specify the stored-row read (a hermetic-only dev GET, listed as a
surface) or assert `reactionsWritten` in the run record.

## 13. [MEDIUM] D7 duplicates an existing real-model probe, and the probe breaks on the input change

What is wrong. app/scripts/extraction-prompt-probe.ts already "runs made-up
conversations through the REAL extraction model, using the exact production
request", touches no data, defaults `--model` to AI_EXTRACTION_MODEL, supports
`--repo` (measure main's prompt vs the branch) and `--dry-run`
(extraction-prompt-probe.ts:1-38). The spec builds a second script on another
template without mentioning it. The probe constructs `ExtractionInput` as
`{ transcript, profile, orgListBlock }` (extraction-prompt-probe.ts:194-205);
adding a required PROPERTIES SENT field breaks it, and `npm run typecheck`
compiles scripts (app/package.json:13, tsconfig.scripts.json).

Implies. Gate 1 fails on a file the spec never names. Either extend the probe
with the never-written cases or say why not, and list the probe as a touched
surface.

## 14. [LOW] Widened Notes lines grow the box without bound, and it is re-sent every run

Up to five 200-character lines per run are appended forever; the whole box is
sent in CURRENT PROFILE on every run (jobs/extraction.ts:163-164) and B2 will
send it on every card. No bound or retention is stated. Worth one sentence
(accepted, or a cap on what CURRENT PROFILE sends).

## 15. [LOW] "Message is not a client utterance" is undefined for a call

A handle is per message, and a call message carries staff, client and unknown
utterances under one handle (jobs/extraction.ts:194-217). The check must be
defined (for example: the message has at least one `client` utterance, or the
message is inbound SMS/email or a voicemail).

## 16. [LOW] A reaction to an unlisted property "goes in noteLines", where it cannot say which home

Addresses never go in noteLines (prompt.ts:132-133) and apply strips postal
"Current address" lines (apply.ts:720-722). The redirected line therefore
cannot name the home it is about. State the expected shape ("not interested in
a home they found, too far from work").

## 17. [LOW] The writer's "listed" condition and retry re-check differ from the read rule

isListed is `counted !== false AND sentAt is a string` (listingSendsRepo.ts:235-237);
the appendReactions condition checks only `counted`. The retry loop does not
say it re-checks the "counted non-flyer share" qualification on each re-read.
Use the same predicate in both places.

## 18. [LOW] Priority placement "after Subzone" collides with the shared row and the DOM-order test

Subzone shares a row with Washer / dryer in the edit form
(ListingEditForm.tsx:495-524), and UnitCreateForm.test.tsx:1045-1052 asserts DOM
order equals PROPERTY_FORM_FIELDS order. Say where the checkbox goes in the
markup. The dashboard `Unit` type has no `priority` key today and is not named
in D6.

## 19. [LOW] Docs the change makes false are not named

- RUNBOOK says "additive `notes` appends are not field writes and are never
  demoted" (RUNBOOK.md:1455-1457); D4 makes that false. Section 6 names RUNBOOK
  only for the env var.
- Q2 cites only RUNBOOK (`claude-sonnet-5`); the env examples already say
  `claude-sonnet-5-5` (.env.dev.example:225, .env.prod.example:250). The code
  default is `claude-opus-4-8` (config.ts:888), so a gate run with the variable
  unset uses neither.
- Charter section 3 and AGENTS.md require GLOSSARY.md updates in the same
  change; the four new nouns, "reaction", and the now-ambiguous "preferences"
  (Notes card vs field) are not mentioned.
