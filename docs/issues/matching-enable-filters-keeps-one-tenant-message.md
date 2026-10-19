---
id: matching-enable-filters-keeps-one-tenant-message
title: A message typed for ONE tenant becomes the filter blast's body after "Add more tenants by filters" when the property had not loaded - no confirm and no reset
type: bug
severity: low
status: open
area: dashboard/broadcasts
created: 2026-10-19
refs: dashboard/src/routes/broadcasts/BroadcastComposer.tsx:489-500, dashboard/src/routes/broadcasts/BroadcastComposer.tsx:435, docs/superpowers/reviews/2026-10-14-matching-blast-rules/code-review/fw2-review.md
---

**Problem.** On a seeded Matching entry (`?contactId=`: seeds-only, the
message in resolved one-tenant mode), "Add more tenants by filters"
(`onEnableFilters`, `dashboard/src/routes/broadcasts/BroadcastComposer.tsx:489-500`)
protects the one-tenant message only when the property has LOADED: its
reset - and the "Switching the audience resets the message to the template.
Discard your edits?" confirm for an edited body - sits behind
`resolvedMode && unit !== null` (`:490`). When `GET /api/units/:id` fails
(the `?unitId=X&contactId=Y` entry, or a property picked on the
`?contactId=` entry), resolved mode cannot auto-fill the body, so staff type
a message for the one tenant (often with their name) and Preview works - a
seeds-only send is never held. Then "Add more tenants by filters": no
confirm and no reset, and the multi-recipient prefill never replaces an
edited body (`:435`). The AR44 hold stops the draft until "Try again" loads
the property; after that the one-tenant text is the FILTER blast's body.

Reproduced by the fix-wave-2 review (interleaving I12, a throwaway test
against the real module): the last draft create was
`{"unitId":"unit-0001","body_template":"Hi Tasha, this one is for you","audience_filter":{"contact_type":"tenant","housing_authorities":["Atlanta Housing Authority"],"bedroomSize":2},"seedContactIds":["c-seed"]}`,
with 0 confirm calls.

Pre-existing on main: the same guard
(`main:dashboard/src/routes/broadcasts/BroadcastComposer.tsx:317-318`).
Fix wave 2 (AR44) did not cause it: before AR44 the same flip sent that
text with no authority filter at all; AR44 only puts a hold in front of
it. LOW because the text is visible in the editor before Preview and Send.

Found by the fix-wave-2 fresh review of `feat/matching-blast-rules` (FW2-3,
`docs/superpowers/reviews/2026-10-14-matching-blast-rules/code-review/fw2-review.md`),
ruled FILE (low) in `code-review/fw2-adjudications.md` (same folder).

**Suggested fix.** In `onEnableFilters`, treat any edited body in resolved
mode as one-tenant text whatever `unit` is: confirm, then reset it to empty
(the multi-recipient prefill refills it once the property loads); a cancel
aborts the flip, as today. Regression test: I12 inverted - with the
property load failed, the flip asks the confirm once; accepted, the body is
reset and no filter draft carries the one-tenant text.
