---
id: relay-intro-dlr-unknown-sid-noise
title: Relay intro sends have no relaysid pointer, so their DLRs log unknown-SID ERRORs (alarm noise)
type: bug
severity: low
status: resolved
area: app
created: 2026-07-08
resolved: 2026-08-25
refs: app/src/jobs/relayFanOut.ts:504, app/src/routes/webhooks/twilio.ts:845
---

**Problem.** Relay-group INTRO sends go straight to the adapter with no delivery
bookkeeping. In `app/src/jobs/relayFanOut.ts` (~:504) the intro handler calls
`adapter.sendMessage({ to, from, body })` per member but, unlike the fan-out leg
(~:399-410), it does NOT persist a message, does NOT write a delivery_recipients
slot, and does NOT call `putRelaySidPointer`. So when Twilio posts status
callbacks (queued/sent/delivered/...) for those intro provider SIDs, POST
`/webhooks/twilio/status` (`app/src/routes/webhooks/twilio.ts`) finds nothing:
`getByProviderSid` misses, `getRelaySidPointer` misses (both on the first lookup
and after the retry), and every intro callback terminates in the level-50
"status callback for unknown provider SID after retry - delivery outcome dropped"
ERROR (~:845 region). That ERROR line feeds the `hc-<env>-error-logs` alarm, so
every relay intro (N members x several DLRs each) manufactures benign alarm
noise and buries genuine dropped-outcome ERRORs. Functionally harmless today
(intros carry no per-recipient delivery UI), but it is real alarm pollution.

**Suggested fix.** Options, roughly increasing in cost:
- Write a relaysid pointer for each intro leg that targets a no-op/tracked slot,
  so the DLR resolves and is recorded (or knowingly ignored) instead of ERRORing.
  Mirrors the fan-out leg's `putRelaySidPointer` + `markRecipient`.
- Give the intro its own tracked delivery slot on a persisted intro message so
  intro deliverability becomes observable (larger change; may be desirable for
  first-contact confidence).
- Cheapest: classify intro-origin SIDs (e.g. a pointer with an `intro: true` /
  no-op kind) and DOWNGRADE the terminal unknown-SID log from ERROR to INFO/WARN
  for those, keeping the alarm signal for genuinely-lost 1:1/fan-out outcomes.

Note the sibling race fix (fix/relay-dlr-pointer-retry) makes the /status retry
re-check the relaysid pointer for BOTH lookups; it does not create intro
pointers, so this noise is unaffected by that change.

**STALE PRODUCTION HALF (re-verified 2026-08-24).** Read the problem statement
above as history, not as current behavior. Relay intros stopped going straight to
the adapter when they moved onto `services/relayAnnouncements.ts`, which writes a
delivery slot AND a `putRelaySidPointer` whenever `persist !== false` - and
intros, member-added, group_closed and group-routed tour reminders all route
through it. A fresh sweep of every `adapter.sendMessage` call site found four,
all of which now resolve their receipts on the classic `/webhooks/twilio/status`
webhook: the `relayFanOut` fan-out leg (slot + pointer), `relayAnnouncements`
(slot + pointer when persisting), `routes/voiceApi.ts` cell verification
(`putSystemSidMarker`, which the webhook already resolves to an INFO ack), and
`services/sendMessage.ts` (a persisted message). Every bare `sendMessage(`
caller - broadcastFanOut, missedCallAutoText, retrySend, api.ts, public.ts -
routes through that last one. So the production noise this issue describes was
already gone; what remained was one seam.

**Resolution (2026-08-25).** Closed on `feat/log-hygiene`, by removing the last
producer of unknown SIDs rather than by silencing the log.

The one surviving ERROR producer was the `persist: false` announcement leg - the
dev intro-replay seam `POST /__dev/relay/replay-intros`, its only originator,
which skips both slot and pointer. `relayAnnouncements.ts` now writes
`putSystemSidMarker(result.providerSid, kind)` per successfully-sent leg when
`persist === false`, in its OWN try/catch degrading to WARN. The nested catch
deliberately cannot fall into the per-member send catch, so a marker failure
never manufactures a spurious alarm-feeding send-failure ERROR, and the WARN
logs a log-safe member key rather than a raw phone. `kind` is the free string
the announcement already carries.

`putSystemSidMarker` also now writes `expires_at` = now + 30 days in EPOCH
SECONDS - DynamoDB TTL silently ignores a non-numeric attribute, so an ISO string
would have looked right and reaped nothing - applied to BOTH callers. There is NO
backfill: markers written before 2026-08 carry no `expires_at` and persist
deliberately; the count is a handful of cell-verification rows. `lib/tables.ts`'s
TTL-family enumeration gains `syssid#` as a fourth family with an explicit
exception note, because that comment asserted every listed family has "its own
authoritative consume step - TTL is only the backstop", and `syssid#` rows have
none: `getSystemSidMarker` reads and never deletes, so TTL is deliberately their
ONLY reaper. The marker write's per-row INFO in `messagesRepo` is downgraded to
`debug` so the fix does not trade N ERRORs for N INFOs; the webhook's per-DLR
INFO ack stays, and nothing in `app/`, `test/` or `e2e/` asserted the marker
line's level.

KEPT DELIBERATELY: the terminal unknown-SID ERROR itself, and its alarm. The
issue's third suggested option (classify intro SIDs and DOWNGRADE the terminal
log) was NOT taken - a genuine crash-orphan or lost outcome must still reach
`hc-<env>-error-logs`. The fix is to stop manufacturing unknown SIDs, not to
stop reporting them. The second option (a tracked delivery slot on a persisted
intro message) is what production already does for persisting announcements.

BOUNDARY, out of scope and named so nobody rediscovers it: the native
Conversations group rail (`adapters/groupConversations.ts` `postGroupMessage`,
from `services/groupSend.ts`) posts to a DIFFERENT webhook
(`routes/webhooks/twilioConversations.ts`), its `syssid#` markers were
deliberately dropped (`groupReceipts.ts:5-9`), and `RUNBOOK.md` documents that
latent flood scenario with its own remedy. Untouched here.
