# Planner handback review - adjudications (2026-10-23)

Reviewed commit: 798de475 (gated code), HEAD 12db6876 (records only after it).
Reviewers (opus, dispatched by the planner, read-only, no suites run):
- spec-conformance: `planner-spec-conformance.md` - 82 rows, 79 CONFORMS,
  2 DEVIATES (both recorded builder deviations, accepted), 1 PARTIAL (D6.5),
  0 MISSING; findings F1-F5 low, F6 info.
- plan-blind adversarial: `planner-adversarial.md` - 0 blocking, 0 high,
  1 medium, 7 low.

Rulings use the conversation as well as the spec: some findings ask for
behavior Cameron explicitly declined on 2026-10-23.

## Adversarial

| ID | Sev | Ruling | Reason |
|---|---|---|---|
| ADV F1 missed-call auto-text texts Inactive contacts | medium | REJECT (decided) | Cameron 2026-10-23 15:54, on exactly this list (tour reminders, group rosters, missed-call auto-text, placement nudges, hand-picked shares): "let's allow it the way that it's already been and not file an issue." STATUS-MODEL.md 5b already says so. The real defect was the glossary's wording; fixed (below). Surfaced in the verdict so Cameron can reverse it knowing the spam/wrong-number case. |
| ADV F2 refetch over eventually consistent reads | low | RECORD | Same as builder R2-2 / plan W8. Live QA measured the drop at +416 ms; a stale answer self-corrects on the next event or reload. No mechanism change (W8 ruling stands). |
| ADV F3 useContact latest-wins skips local setContact | low | RECORD | Display-only, narrow race (same family as builder ADV-6/R4-2). |
| ADV F4 PATCH 409 contact_changed shows the generic save error | low | RECORD | Rare (a colleague's concurrent write); nothing illegal is stored; reopen recovers. |
| ADV F5 type-change first-status defaults in four places | low | RECORD | Drift risk only; the server is authoritative and the mirror test pins the lists. |
| ADV F6 glossary says "not a listing-send recipient" | low | ACCEPT (doc) | GLOSSARY "Inactive" now says follow-up eligibility only, and that automatic texts and hand-picked shares still reach it by decision. |
| ADV F7 /tenant-status on a phone-pointer id -> 500 | low | RECORD | API-only (no UI path sends a pointer id). Before this branch the same call could write a status onto the pointer record, so the 500 is no worse. Not worth a code wave and a re-gate. |
| ADV F8 AI extraction keeps running for Inactive | low | REJECT (decided) | Cameron approved spec call 4 on 2026-10-23 16:20 ("AI keeps running for Inactive contacts"). |

## Spec-conformance

| ID | Sev | Ruling | Reason |
|---|---|---|---|
| SPEC F1 imported unknown thread of an Inactive tenant/caseworker still on Today | low | RECORD | Pre-existing and filed (imported-unknown-threads-surface-as-unknown-on-today). |
| SPEC F2 Contacts > Unknown sorts Inactive last (builder OR-1) | low | TO CAMERON | Taste call; planner recommends keep (matches his inbox Unknown-tab rule). |
| SPEC F3 porting re-type adds one audit row | low | ACCEPT as built | Builder deviation 4; pinned by FW1-5. Spec D3 wording not amended (the spec is a dated record). |
| SPEC F4 importer preserveStatus can store (unknown, active) | low | ACCEPT (doc) | Dated update appended to docs/issues/import-bypasses-contact-type-rules.md. |
| SPEC F5 vendor SDK import in services/statusTransition.ts | low | REJECT | `ConditionalCheckFailedException` is imported directly across ~40 app/src files (routes, services, repos); established repo practice, not new debt. |
| SPEC F6 inbox tag refresh on first-page rows only | info | RECORD | Existing list behavior. |

## Builder's open calls (handback section 5)

1. OR-1 Contacts > Unknown order - to Cameron (see SPEC F2).
2. R2-2 / W8 second refetch - RECORD, no change (see ADV F2).
3. SPEC-F3 / ADV-7 no contact.updated when the audit throws after a committed
   write - RECORD. The call returns an error, the acting page re-reads; only
   other open pages miss one refresh, on an audit-write failure.
4. SPEC-F4 importer note - DONE (doc).
5. SPEC-F2 porting wording - accepted as built, spec left as dated record.
6. R3-2 / R4-1 contacts PATCH re-type not fenced on the form's base type -
   RECORD as pre-existing; the server-side fence is its own change.
7. W2 / 8. unknown-queue issue triggers - re-measure beside the W7 re-count
   before deploy.

Code fix wave: NONE. Doc edits by the planner: GLOSSARY.md "Inactive"
wording; import-bypasses-contact-type-rules.md dated update.
