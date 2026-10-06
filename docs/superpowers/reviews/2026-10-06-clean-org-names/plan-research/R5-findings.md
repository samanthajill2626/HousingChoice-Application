# R5 findings - dashboard surfaces

Plan research, area R5 (the dashboard surfaces branch A changes or adds: the
tenant edit form, the property forms, the blast composer filter, the AI
suggestion accept, the new Settings tab, shared UI and the API layer). Spec:
`docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md`
(revision 5). Code read at `feat/clean-org-names` HEAD `93c3c65b`. Byte-exact
quotes for every anchor below are in the gitignored reference
`.superpowers/sdd/plan-research/R5-dashboard-reference.md`.

Three findings: one contract gap the dashboard dialogs cannot be planned
without (F1) and two low-severity precision notes (F2, F3).

Found independently and NOT repeated here: the composer cannot reach "a
resumed draft with an off-list filter", and its picker must commit only on a
pick - both already filed as `R2-findings.md` F1 and F2, with the same
evidence.

---

## F1 (medium, contract gap) - section 6 defines no code or body for the D13 refusals and no pre-submit D12 answer the dialogs must render

**Spec says.** D13: a COMPOUND text "is refused as a new name too - in 'Is
this really new?', Add as new and rename - with a message naming the entries
it contains and pointing to Split"; names are at most 120 characters, notes at
most 500. D10: the "Use <name>" dialog shows "Remember this spelling" (on by
default), and "D12's automatic rules can turn it off and say why".

**Code / contract does.** Section 6 names only 409 `org_name_taken` (with the
entry) for `POST /api/organizations`. `POST /api/organizations/check`
returns `{ match?, candidates[], close[], otherKind? }`: no compound flag and
no contained entries. The resolve endpoint names skipped spellings only in its
RESPONSE, after the action ran. The dashboard reads refusals only through
`ApiError.code` and the parsed `body` (`dashboard/src/api/client.ts:74-83`),
and today's dialogs map known codes to copy (the precedent is
`dashboard/src/routes/settings/useTeam.ts:59-73` with
`ConfirmRemoveDialog.tsx:27-38`).

**Why it matters.** Without a defined code and body (for example the
contained entries), or a compound field on the `/check` result, "Is this
really new?" cannot disable "Yes, add it" up front nor render D13's message
after a refusal; the same holds for rename (`PATCH { name }`), Add as new
(resolve `action: 'add'`) and the two length limits. The "Remember this
spelling" checkbox cannot be turned off before submit "and say why" without a
pre-submit source for D12's skip rules.

**For the plan.** Define, before the dashboard dialog tasks: the refusal
code(s) and body for a compound name and for the length limits, and either a
`compound` / D12 preview on `/check` (or a dry-run on resolve) or the
explicit reading that the dialog reports D12 skips only after the action.

---

## F2 (low, precision) - the property edit form trims every member it sends; D5's "exact text" reads as a pre-trim comparison

**Spec says.** D5: "members the unit already holds (exact text), or equal to
the unit's legacy `jurisdiction`, pass unchanged; only new members must
resolve. Members are trimmed and de-duplicated." D6: "saving never fails
because of an unchanged value".

**Code does.** `dashboard/src/routes/listing/ListingEditForm.tsx:160-166`
trims every member, drops empties, and sends the WHOLE list whenever the
trimmed list differs from the trimmed baseline (`:164`);
`UnitCreateForm.tsx:179-183` trims likewise. The server does not trim
`string[]` unit fields today (`app/src/lib/unitFields.ts:172-174` only checks
the type), so a stored member, or a legacy `jurisdiction` synthesized by
`authoritiesOf` (`dashboard/src/routes/listing/listingFormat.ts:61-69`), can
carry stray whitespace.

**Why it matters.** If the server compares the incoming (trimmed) member with
the stored member before trimming the stored side, an untouched padded member
becomes a "new" member on any unrelated edit: it is silently rewritten to its
resolution, or the save is refused 422 - against D6.

**For the plan.** Pin the D5 comparison as trim-insensitive on both sides
(with a route test using a padded stored member), or have the multi-picker
send untouched members byte-exact. Related: R1-F1 on the scope of the
`jurisdiction` pass.

---

## F3 (low, ambiguity) - section 9's "System Status (prompt fingerprint plus `orgListFingerprint`)" has no surface to land on

**Spec says.** Section 9 readers: "the AI run log and System Status (prompt
fingerprint plus `orgListFingerprint`, the new drop reason and its label)".
D8: each RUN records `orgListFingerprint`.

**Code does.** System Status (`dashboard/src/routes/settings/FlagPills.tsx:107-109`)
and the AI run log's config strip
(`dashboard/src/routes/settings/aiRuns/AiRunsSection.tsx:31-34`) show only the
static flag `aiExtractionPromptFingerprint` from `GET /api/system/flags`; they
carry no per-run data. The per-run "Prompt fingerprint" renders in the run
detail header (`dashboard/src/routes/settings/aiRuns/AiRunDetail.tsx:60`)
from `AiRunRecordView` (`dashboard/src/api/types.ts:308-324`), which has no
`orgListFingerprint` field yet.

**Why it matters.** A System Status value would be a new "current list
fingerprint" flag the spec does not define; a planner could add one, or skip
the run detail, depending on the reading.

**For the plan.** State the target. The reading consistent with D8 is the run
detail header beside "Prompt fingerprint" (plus the type field); System Status
keeps working unchanged. Separately, no drop-reason label map exists today
(`AiRunDetail.tsx:12-14`, `:76` humanize the raw enum), so D8's label
"Agency, not a housing authority" is the first entry of a new map, and
`e2e/support/selectors.md:72` ("every enum is humanized") needs the exception.
