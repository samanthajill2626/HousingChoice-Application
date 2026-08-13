---
id: group-outbound-media
title: Outbound media (MMS) into a native group text is refused in v1 - lift the limitation
type: improvement
severity: med
status: open
area: app
created: 2026-08-11
refs: app/src/routes/api.ts:1194, dashboard/src/routes/contact/Timeline.tsx:74, dashboard/src/routes/contact/Timeline.tsx:244, e2e/support/selectors.md:27, docs/superpowers/specs/2026-08-10-group-texting-design.md
---

**Problem.** Native group texting v1 ships TEXT-ONLY outbound: staff cannot send
a photo, a flyer image, or any other attachment into a group thread. The
limitation is deliberate and it is enforced in three places, consistently:

- the API refuses a group send carrying media with
  `group_text_media_not_supported` (`app/src/routes/api.ts:1194-1202`);
- the group composer hides the attach control entirely
  (`dashboard/src/routes/contact/Timeline.tsx:74`, `:244`) - it is not a disabled
  button, it is structurally absent;
- `e2e/support/selectors.md:27` pins that absence ("There is NO attach control:
  outbound group media is not supported in v1") so a later change cannot restore
  the control without noticing this contract.

This issue exists because that shipped, deliberate limitation had no tracking
entry. The group-texting spec's own section 14 follow-up list names an
outbound-group-media follow-up as one of five issues it files; the other four all
exist. This is the fifth.

**Why it matters.** Staff DO send media on the 1:1 path (outbound MMS is a
shipped capability with its own transcode pipeline), and a group thread is
exactly the surface where a unit photo or a flyer is most useful - a tour
coordination thread with the tenant and the landlord in it. The workaround today
is to leave the group and send the same image 1:1 to each member, which loses the
shared context that made the group worth having.

**Sibling issues filed by the same spec sentence** (read together - they overlap
in scope and a group-media implementation touches several of them):

- [twilio-standard-optout-double-reply](./twilio-standard-optout-double-reply.md)
- [group-mms-including-pool-numbers](./group-mms-including-pool-numbers.md)
- [group-text-tour-placement-attachment](./group-text-tour-placement-attachment.md)
- [exactly-once-send-intent](./exactly-once-send-intent.md)

**Suggested fix.** Lifting the limitation is not just deleting the refusal:

1. **The A2P gate comes first.** Group outbound rides the Messaging Service whose
   A2P campaign must be approved AND MMS-enabled (see the cutover checklist in
   `RUNBOOK.md`). Media into a group cannot be switched on ahead of that
   approval, independent of any code being ready.
2. **The transport is different from the 1:1 path.** A group send leaves through
   the Conversations adapter, not the classic Messages API the existing outbound
   MMS pipeline targets. The media attach, the transcode step, and the per-leg
   delivery receipts all need to be re-checked against Conversations' own media
   semantics rather than assumed from the 1:1 path.
3. **Per-member delivery for a media leg.** Group delivery state comes from
   `onDeliveryUpdated`; confirm a media leg reports the same way before the UI
   promises per-member chips for it.
4. **Then, and only then, the three enforcement points above** - the API refusal,
   the hidden composer control, and the e2e selector pin - come down together, in
   one change. Leaving any one of them behind produces a composer that offers
   something the API refuses.
