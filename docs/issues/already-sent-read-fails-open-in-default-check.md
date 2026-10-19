---
id: already-sent-read-fails-open-in-default-check
title: A blast's already-sent read fails OPEN with no notice, while the tour and Not interested reads of the same default-check rule fail CLOSED - a throttled read can re-text a tenant who already got the property
type: decision
severity: low
status: open
area: app/broadcasts
created: 2026-10-19
refs: app/src/services/shareRecipientState.ts:249-269, app/src/services/shareRecipientState.ts:264-266, app/src/routes/broadcasts.ts:786-801, app/src/routes/broadcasts.ts:741-743, app/src/routes/broadcasts.ts:1032-1035, docs/superpowers/specs/2026-10-14-matching-blast-rules-design.md:391-395
---

**Problem.** A blast's review rows start checked by ONE rule (matching-blast-rules
D5): `checkedByDefault = hasConsent && (seeded || (!alreadySent && !declined
&& !held))`, and "Reaches N recipients" counts those rows (D8). Two of its
three inputs fail CLOSED: a thrown tours or Not interested read answers a
filter preview 503 `audience_rules_unavailable` with Try again, and the draft
create omits its estimate (`app/src/routes/broadcasts.ts:786-801`), because a
list served without them "would check people the rules leave out"
(`:1032-1035`). The third, already-sent, fails OPEN with no notice:
`priorRecipientKeys` (`app/src/services/shareRecipientState.ts:249-269`)
never throws - a failed `listByUnit` page logs a WARN and returns what it
had resolved (`:264-266`).

Trigger: one throttled `broadcasts.listByUnit` page while previewing a
property that was shared before. The tenants who already received it come
back `alreadySentThisProperty: false`, so they count in "Reaches N", start
checked on Review recipients, and Send texts them the property again -
nothing on screen says the already-sent labels are incomplete (the preview
response has no flag for it). The same partial read of tours or declines
would have stopped the preview with Try again.

Pre-existing, and documented as a soft hint by design
(`app/src/routes/broadcasts.ts:741-743`); spec D5 kept it on purpose
(`docs/superpowers/specs/2026-10-14-matching-blast-rules-design.md:391-395`:
"a throttled already-sent read can leave an already-sent tenant checked.
Only the tours and decline reads fail closed."). `feat/matching-blast-rules`
did not create the gap; it put already-sent inside the one default-check
rule whose other inputs fail closed, so the asymmetry now sits inside a
single rule. Severity: a repeated text is not critical (high at most by the
team's severity rule) and needs a throttled read at the wrong moment, so
low. Found by the planner's plan-blind adversarial review (PA-3,
`docs/superpowers/reviews/2026-10-14-matching-blast-rules/planner-review/adversarial.md`),
ruled FILE (low) in `planner-review/adjudications.md` (same folder).

**Suggested fix (Cameron decides).** Have `priorRecipientKeys` report
completeness (for example `{ keys, complete }`), then either:

1. Fail closed like the other two inputs: an incomplete read is a 503
   `audience_rules_unavailable` for a filter preview and no estimate at
   create; or
2. Keep the list but say so: a preview flag the review shows ("Already sent
   labels could not be fully loaded"), as the seeds-only degrade does for
   tours and Not interested.

Either is a spec D5 amendment and touches the prior-recipient walk (every
share of the unit, with send-attempt record reads).
