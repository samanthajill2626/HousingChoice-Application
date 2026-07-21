---
id: email-outbound-stuck-queued-on-crash
title: Outbound email stranded 'queued' if the process crashes between persist and send
type: bug
severity: low
status: open
area: app
created: 2026-07-21
refs: app/src/services/sendEmailMessage.ts:357, app/src/services/sendEmailMessage.ts:410
---

**Problem.** The outbound send service persists the message as `queued` BEFORE calling
`adapter.send`, then advances it to `sent` (or `failed` on an adapter throw) - the
deliberate ADJ-6 optimistic-parity ordering that makes a failed SES send visible. But
if the PROCESS CRASHES (or is killed) in the window between the `queued` persist and
the post-send status update, the message is stranded `queued` forever: the timeline
shows a perpetual "Sending..." chip. Nothing sweeps stale `queued` email messages, and
- unlike SMS - there is no provider webhook that would later resolve it, because the
SES MessageId alias (`sid#<sesId>`) is only written AFTER send returns. So a crash in
that window leaves a message that can neither advance nor be correlated by a later
event.

Accepted for v1 (Phase A adversarial review, finding m3): the crash window is tiny and
the failure mode is a cosmetic stuck chip, NOT a double-send or data loss (the send
either did not reach SES, or did but we lost the ack - a manual re-send is safe because
SES dedupes on nothing here, so a duplicate is the worst case and is rare).

**Suggested fix.** Add a periodic reconciler (or a bounded startup sweep) that finds
outbound email messages left `queued` past a threshold with no `ses_message_id` alias
and marks them `failed` - surfacing a re-send affordance - mirroring how stuck jobs are
reaped elsewhere. Alternatively, record a pre-send intent marker and reconcile it
against the SES/fake store on recovery so a truly-sent-but-unacked message can be
promoted to `sent` instead of `failed`.
