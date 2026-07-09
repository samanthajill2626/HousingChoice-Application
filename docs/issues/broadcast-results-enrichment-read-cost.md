---
id: broadcast-results-enrichment-read-cost
title: "Broadcast results enrichment re-resolves every contact on every GET (uncached) - large read volume under live polling"
type: improvement
severity: low
status: open
area: app
created: 2026-07-09
refs: app/src/routes/broadcasts.ts:206, dashboard/src/routes/broadcasts/useBroadcastResults.ts:46
---

**Problem (review note, 2026-07-09 - spec-accepted cost, tracked so it is not
folklore).** GET /api/broadcasts/:id/results enriches every contactId-keyed
recipient via contacts.getById (chunked at 50) on EVERY call, uncached. The
detail page polls this endpoint every ~2s while a broadcast is 'sending' AND
fires an SSE-debounced refetch per fan-out emit. Worst case at the recipient
cap (1500 recipients, ~1/s A2P pacing means a ~25 minute send): roughly 750
polls x 1500 getById plus a comparable volume from the ~1500 debounced SSE
refetches - a few million single-item reads for one broadcast. Bounded,
single-operator, on-demand billing absorbs it; but it is not free.

Related display nit (same code): the phone shown for a contactId recipient is
the contact's CURRENT phone (fresh getById), not the number the message was
actually sent to. If a contact's number changes after the send, the results
row shows the new number though delivery went to the old one. phone#<E164>
keys are unaffected (the phone IS the key).

**Suggested fix.** A per-request memo is already implicit (one resolve per GET);
add a short-TTL (say 30s) in-process cache keyed by contactId, or resolve the
identities ONCE per broadcast into a session-scoped cache the poll reuses -
either cuts the read volume by the poll count. If sent-to-number fidelity ever
matters, snapshot the phone into the recipient slot at send time instead of
resolving it fresh.
