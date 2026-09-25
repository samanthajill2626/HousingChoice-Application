---
id: broadcast-fanout-logs-phone-keyed-contactkey
title: The broadcast fan-out logs contactKey, which is a phone number for a phone#-keyed recipient
type: debt
severity: low
status: open
area: app/broadcasts
created: 2026-09-25
refs: app/src/jobs/broadcastFanOut.ts:388, app/src/jobs/broadcastFanOut.ts:429, app/src/jobs/broadcastFanOut.ts:446, app/src/jobs/broadcastFanOut.ts:558
---

**Problem.** The fan-out's header says never to log bodies, phones or names -
"broadcastId / contactKeys / counts / SIDs only". But a recipient with no
contact record is keyed `phone#<E164>`, so every log line that prints
`contactKey` prints that recipient's phone number. Four sites do: the no-contact
warn, the soft-deleted skip (added by share-skip-fix, following the existing
pattern), the no-consent skip and the refusal warn. Found by the share-skip-fix
planner adversarial review (2026-09-25, finding 12); the branch added one site
in the existing style rather than widen its diff into the other three.

**Fix.** One helper (`logKey(contactKey)`) that returns the key for a contactId
key and a redacted form (`phone#<redacted>`) for a phone key, used at all four
sites; a unit test that a phone#-keyed recipient's skip line carries no digits.
Phone-keyed recipients are rare (the explicit-selection send path keys by
contactId), so this is hygiene, not an active leak.
