---
id: relay-direct-sends-unknown-sid-callbacks
title: Unpersisted relay direct sends (intros, group reminders) log error-level unknown-SID status callbacks
type: debt
severity: low
status: resolved
area: app
created: 2026-07-02
resolved: 2026-08-25
refs: app/src/jobs/relayFanOut.ts, app/src/jobs/tourReminders.ts, app/src/routes/webhooks/twilio.ts
---

**Problem.** The relay `[AUTO]` intro messages and (since the tours build) group-routed
tour reminders are sent **directly via the messaging adapter** from the pool number and
are deliberately NOT persisted as app messages (system-announcement precedent — there is
no source message row). Their provider delivery **status callbacks** therefore find no
`sid#` pointer and log `status callback for unknown provider SID` at error level — once
per member per send.

**Impact.** Benign but noisy: every tours e2e run and every real group send emits
error-level lines that (a) pollute the error-log alarm signal and (b) read as failures to
anyone triaging logs. The class predates tours (relay intros always did this); group
reminders multiply it.

**Suggested fix (either).**
1. Teach the status-callback handler to recognize-and-downgrade: when the SID is unknown
   AND the `From` is a pool number, log at debug ("unpersisted relay system send —
   expected") instead of error.
2. Or persist a minimal system-message row for direct relay sends so callbacks resolve
   (heavier; changes the "announcements aren't messages" decision).

Until then: treat these lines as known noise in e2e logs, not a failure signal (documented
in the playbook's tours section).

**STALE PRODUCTION HALF (re-verified 2026-08-24).** The problem statement above
is history. Both named producers now persist delivery bookkeeping: relay `[AUTO]`
intros AND group-routed tour reminders go through
`services/relayAnnouncements.ts`, which writes a delivery slot and a
`putRelaySidPointer` whenever `persist !== false`, so their callbacks resolve
through the pointer instead of falling to the unknown-SID ERROR. A fresh sweep of
every `adapter.sendMessage` call site found exactly four, all resolvable on the
classic `/webhooks/twilio/status` webhook: the `relayFanOut` fan-out leg (slot +
pointer), `relayAnnouncements` (slot + pointer when persisting), `routes/
voiceApi.ts` cell verification (a `putSystemSidMarker` the webhook already
resolves to an INFO ack), and `services/sendMessage.ts` (a persisted message);
every bare `sendMessage(` caller routes through the last of those. The "once per
member per send" volume this issue describes is therefore not current production
behavior, and the e2e-log advice above is obsolete.

**Resolution (2026-08-25).** Closed on `feat/log-hygiene` together with its
sibling [relay-intro-dlr-unknown-sid-noise](./relay-intro-dlr-unknown-sid-noise.md),
which carries the same mechanism in full.

The one remaining producer was the `persist: false` announcement leg - the dev
intro-replay seam `POST /__dev/relay/replay-intros`, which skips slot and
pointer. Each successfully sent leg in that mode now writes
`putSystemSidMarker(result.providerSid, kind)` in its own try/catch, degrading
to WARN with a log-safe member key, and structurally unable to fall into the
per-member send catch (which would have traded one benign ERROR for a worse
one). `putSystemSidMarker` gained a 30-day `expires_at` in EPOCH SECONDS for both
its callers, with NO backfill for pre-2026-08 rows, and `lib/tables.ts` records
`syssid#` as the one TTL-bearing family with no consume step - TTL is
deliberately its only reaper. The per-row marker INFO dropped to `debug` so N
ERRORs did not become N INFOs.

This closes on the issue's option 2 (make the callbacks RESOLVE), not option 1
(recognize-and-downgrade in the status handler). The `From`-is-a-pool-number
downgrade was deliberately rejected: it would suppress a genuine crash-orphan on
the same pool number, and the terminal unknown-SID ERROR is the "closing the
loop" backstop that must keep feeding `hc-<env>-error-logs`. The
"announcements aren't messages" decision the issue worried about is intact -
a `syssid#` marker is a read-only ack, not a message row.

OUT OF SCOPE, deliberately: the native Conversations group rail
(`adapters/groupConversations.ts` `postGroupMessage` from
`services/groupSend.ts`) posts to a different webhook
(`routes/webhooks/twilioConversations.ts`) whose `syssid#` markers were
deliberately dropped (`groupReceipts.ts:5-9`). That latent class and its remedy
are documented in `RUNBOOK.md` and were not touched.
