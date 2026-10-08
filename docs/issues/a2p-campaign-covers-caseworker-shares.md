---
id: a2p-campaign-covers-caseworker-shares
title: Confirm the registered A2P campaign covers property shares to a voucher holder's caseworker
type: decision
severity: med
status: open
area: compliance
created: 2026-10-08
refs: app/src/routes/broadcasts.ts, app/src/jobs/broadcastFanOut.ts, docs/issues/a2p-compliance-hardening.md
---

**Problem.** `feat/caseworkers` (spec D20) lets staff send a property share
(the address and flyer link) to a partner - in practice a voucher holder's
caseworker - from the partner's page, into the partner's own conversation.
The registered A2P campaign describes listing texts to voucher holders. The
design treats a share to the holder's caseworker as covered (the same
listing content, about a home for that caseworker's client, behind every
existing consent gate: the per-number opt-out, unreachable, deleted, the
kill switch and the just-in-time consent check), but coverage is NOT
confirmed. Cameron, 2026-10-07: branch B ships partner shares anyway; the
campaign question is Sam's.

**Suggested fix.** Sam confirms with the campaign's registration (or
Twilio/TCR support) that texts to a voucher holder's caseworker fall inside
the registered use case. If they do not, amend the campaign description, or
turn partner shares off (the seed and explicit-recipient predicate in
`app/src/routes/broadcasts.ts` goes back to tenants only) until it is.
