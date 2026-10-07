# R3 findings - AI fact extraction and the suggestion accept path

Plan research, area R3 (the AI extraction path and the suggestion accept
path). Spec: `docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md`
(revision 5). Code read at `feat/clean-org-names` HEAD `93c3c65b`. Byte-exact
quotes for every anchor below are in the gitignored reference
`.superpowers/sdd/plan-research/R3-ai-suggestions-reference.md`.

Six findings: two material (F1, F3), two that add work the spec does not
state (F2, F4), and two precision notes (F5, F6).

---

## F1 (material) - "a different value answers 409" has nothing to compare against

**Spec says.** D8: "A second accept of an already-resolved suggestion with a
different `value` answers 409 `suggestion_already_resolved`, as an action
mismatch does today."

**Code does.** The action-mismatch 409 works only because `action` survives on
the completed journal row. The service compares it at
`app/src/services/suggestionResolution.ts:658-661`, and again in the
claim-race branch at `:708-717`. Nothing value-shaped survives:

- Completed rows are PII-free by design
  (`app/src/repos/suggestionResolutionRepo.ts:6-7`). `makeCompletedResolution`
  (`:276-291`) keeps only itemId, state, contactId, target, identityKey,
  action, completedAt and disposition, and `complete()` writes exactly that
  (`:1147-1158`).
- The claim deletes the `sugg#` row in the same transaction (`:656-664`), so
  after completion the suggestion text is gone too.

A retry with a different value therefore reads as an identical-action replay
and answers 200 (`suggestionResolution.ts:672`).

**Plan must.** Add a PII-free value key to the completed row (for example a
hash of the requested value), carried from the active journal (its plan, or an
attribute written at claim) through `makeCompletedResolution`. Compare it in
BOTH completed branches. Define what an absent `value` compares equal to; the
legacy body-less accept (`app/src/routes/suggestions.ts:118-138`) can never
send one. Keep the key conditional (absent when no value was sent), or update
the four exact-shape pins of the completed row:
`app/test/suggestionResolutionRepo.test.ts:70-85` and `:89-104`,
`app/test/suggestionResolutionRepo.integration.test.ts:314-323`, and
`app/test/aiRunVerdicts.test.ts:973-982`. The test fake follows
automatically (`app/test/helpers/suggestionResolutionFake.ts:466` calls
`makeCompletedResolution`).

---

## F2 - the "Agency, not a housing authority" label has no home, and the Reason cell would hide it

**Spec says.** D8: the new drop reason `agency_not_authority` gets the
dashboard label "Agency, not a housing authority". Section 9 lists "the new
drop reason and its label" among the readers.

**Code does.** The dashboard has no drop-reason label map. The run detail
renders the Reason cell as the model's reason when present, and otherwise as
the drop reason passed through `humanizeEnum`, which only swaps underscores
for spaces (`dashboard/src/routes/settings/aiRuns/AiRunDetail.tsx:76`,
`:12-14`). The wire type is a plain string (`dashboard/src/api/types.ts:286`).
Apply records the model's reason on its drop decisions whenever the model gave
one (`app/src/services/extraction/apply.ts:215-221`, `:228-234`), and the
prompt requires a reason on every write or suggest
(`app/src/services/extraction/prompt.ts:39-40`). An agency drop built on the
house shape would therefore show the model's reason and never the label.

**Plan must.** Add a label map and render the label even when a model reason
is present (for example the label plus the reason). Precedent for a label map
with a parity test: `REMINDER_SKIP_REASON_LABELS`
(`dashboard/src/api/types.ts:1435-1457`) and its test
(`dashboard/src/api/types.test.ts:160-178`). Pins:
`dashboard/src/routes/settings/aiRuns/AiRunsSection.test.tsx:122-131` (drop
reasons rendered without underscores) and
`app/test/extractionRunTypes.test.ts:16-31` (exactly twelve drop reasons).

---

## F3 (material) - missed test: an off-list housingAuthority accept that must reach the claim

**Spec says.** D5 and D8: the accept path applies the one check, so an
off-list text without a qualifying `value` is refused with 422 before the
suggestion is claimed.

**Code does.** `app/test/aiRunVerdicts.test.ts:546-587` ("caps how many
abandoned journals one read recovers") seeds three suggestions, including
housingAuthority 'Metro HA' (`:560`), and requires each accept to CLAIM and
then crash (`.expect(500)` at `:566`) so that three abandoned journals exist.
It then asserts two and then three recovered (`:573-574`, `:586`). Under D5
and D8 the third accept answers 422 before the claim, so the test fails at
`:566`.

**Plan must.** Put 'Metro HA' on the harness's list, or switch the third
target to a non-authority field. The harness itself needs an org-list fake
wired into `createSuggestionsRouter` (`app/src/routes/api.ts:1156-1178`; the
harness builds the app from world fakes,
`app/test/helpers/twilioWebhookHarness.ts:4922-4923` and `:5163`). D1 puts the
list in a new sibling repo, so it cannot ride on the hand-enumerated
SettingsRepo fake (`twilioWebhookHarness.ts:2571-2620`). Also pinned and not
named by the spec: `dashboard/src/api/types.test.ts:51-71` - SERVER_CODES must
list every code the accept route can return, so add
`value_not_from_suggestion` (and `org_not_on_list` if the accept route can
answer it); that copy may not contain an underscore (`:84-90`).

---

## F4 - list-block placement and content are constrained by existing tests

**Spec says.** D8: the list "rides in the USER content as a block"; its
position and character rules are unstated. D13 limits names and spellings by
length only.

**Code does.** Three tests fix the block's position and text:

- `app/test/extractionRunWindow.test.ts:63-83` asserts that every line after
  the first `TRANSCRIPT` header line is a rendered transcript line, so a block
  placed after the header fails it.
- `app/test/extractionSchema.test.ts:404-422` asserts that the user content
  ENDS with the last transcript line.
- `app/test/extractionSchema.test.ts:487-513` slices the transcript at the
  first occurrence of the word `TRANSCRIPT`, so a block that contains that
  word ahead of the header breaks the slice.

Names are staff-entered (D10: everyone can add a name; rename and spellings
are admin-only), and the user content is newline-structured. The existing
forged-line defense, `toSingleLine`
(`app/src/services/extraction/prompt.ts:143-154`), covers message bodies only.

**Plan must.** Render the block BEFORE the TRANSCRIPT header and keep that
word out of it. Then either single-line every rendered name and spelling, or
have the D13 validation refuse control characters (newlines) in names and
spellings. The second option also protects the Settings page and the D4
module.

---

## F5 (precision) - System Status cannot carry orgListFingerprint

**Spec says.** Section 9 readers: "the AI run log and System Status (prompt
fingerprint plus `orgListFingerprint`, the new drop reason and its label)".

**Code does.** `getFlags()` is synchronous and does no I/O by contract
(`app/src/services/systemStatus.ts:4`, `:159-161`). That contract is pinned by
`app/test/systemStatus.service.test.ts:125-127` ("getFlags stays AWS-free")
and by the exact flag set at `:70-90`. The list is a DynamoDB item read on
demand with no in-process cache (D1), and `orgListFingerprint` describes the
list one particular run saw.

**Plan must.** Read section 9 the way D8 states it. System Status keeps the
prompt fingerprint, which is unchanged because the system prompt stays static.
`orgListFingerprint` lives in the AI run log only: the run record
(`app/src/repos/aiRunsRepo.ts:40-63`), its dashboard twin
(`dashboard/src/api/types.ts:309-323`), and the run-detail header
(`AiRunDetail.tsx:60`).

---

## F6 (precision) - "write an empty field, suggest a change" misdescribes today

**Spec says.** D8: "a match is handled exactly as a known authority is today
(write an empty field, suggest a change)".

**Code does.** Today the model's op picks write or suggest for a recognised
authority; field emptiness plays no part. Apply writes on op 'write' whatever
the field holds (`app/src/services/extraction/apply.ts:258-275`), and the
prompt lets op "write" replace an occupied value that is "the SAME fact in a
better form" (`app/src/services/extraction/prompt.ts:36-38`). Apply never
checks emptiness for a scalar field. Only inferred-role content
(`apply.ts:258`, `:286`) and an unrecognised authority (`:250-258`) demote a
write.

**Plan must.** Pin the op-driven behavior ("exactly as today") for a D4 match
and add no emptiness rule. Read literally, the parenthetical would turn every
write to an occupied field into a suggestion, including the model correcting
an old spelling to the list name.
