---
id: mms-deliver-path-trusts-content-type
title: "MMS flow-through (deliver) path trusts the pinned Content-Type without a byte sniff"
type: improvement
severity: low
status: open
area: app
created: 2026-07-16
refs: app/src/routes/mmsMedia.ts, app/src/lib/mediaTypes.ts
---

**Problem (review, 2026-07-16).** The `deliver` plan (gif at any size; jpeg/png
<= PASSTHROUGH_MAX_BYTES) returns the original object as the deliverable rendition
WITHOUT downloading or inspecting the bytes - that byte-free path is the whole
point of flow-through (decided on HeadObject alone). The presigned POST pins the
Content-Type as an exact-match policy condition, so the STORED type cannot be
spoofed to a non-deliverable value, and the send-route guard re-checks the stored
type against TWILIO_DELIVERABLE_MMS_TYPES - so the 12300 fix and the stored-XSS
defense both hold (verified in review).

The residual gap: a user can presign `image/gif` (or a small `image/png`) and
upload arbitrary BYTES labeled with that type. Confirm forwards it verbatim, and
it reaches Twilio/recipients as a mislabeled/broken image. This is a
self-inflicted deliverability/robustness gap (the user mislabels their OWN
attachment), not a security issue, and it only affects the flow-through path -
the transcode path re-decodes and is immune.

**Decision.** Accepted for now. A fix (a cheap magic-byte sniff on the deliver
path) would require a ranged GET of the first bytes, defeating the deliberate
"no download on deliver" design. If mislabeled-image reports appear in practice,
add a first-bytes magic check (or route small deliverables through a validate-only
sharp metadata read) rather than trusting the declared type.
