---
id: broadcast-mms
title: Per-recipient media on broadcasts (MMS broadcast) -- deferred
type: improvement
severity: med
status: open
area: app+dashboard
created: 2026-07-08
refs: docs/superpowers/specs/2026-07-08-outbound-mms-design.md
---

**Problem.** The outbound-mms feature adds attach-and-send media to every 1:1 and relay
conversation composer, but deliberately does NOT cover broadcasts. A broadcast still sends
text only. Staff will want to broadcast media (a flyer image, a program update PDF) to a
recipient list.

**Why it is deferred.**
1. Scope collision: the broadcasts area has in-flight work by another agent; the outbound-mms
   feature was scoped to not touch any broadcast file.
2. Broadcast MMS is materially more than the 1:1 case: it needs the broadcast job to
   presign per recipient (presign-per-attempt still applies -- a long fan-out cannot reuse
   one URL), a template/attachment model in the broadcast composer + Review Recipients
   preview, and it carries real cost/throughput implications (carrier MMS pricing and
   pacing differ from SMS).

**Suggested fix (when picked up).** Reuse the outbound-mms primitives: the uploads/ endpoint,
MediaStore.presign, media_attachments persistence, and the presign-per-attempt rule (each
recipient leg presigns fresh at send time -- mirror relayFanOut's per-leg presign). Add an
attach control to the broadcast composer, a per-recipient media_attachments plumb on the
broadcast job, cost/throughput guards, and a media preview in Review Recipients. Coordinate
with whoever owns the broadcasts area to avoid a merge collision.
