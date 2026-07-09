---
id: mms-forward-received-media
title: Forward media already received in a contact's gallery to another conversation
type: improvement
severity: low
status: open
area: app+dashboard
created: 2026-07-08
refs: docs/superpowers/specs/2026-07-08-outbound-mms-design.md, app/src/routes/mediaUploads.ts, dashboard/src/routes/contact/Timeline.tsx
---

**Problem.** Outbound MMS v1 (see the outbound-mms feature) only sources media from a
device upload (POST /api/media/uploads, the uploads/ namespace). Staff often want to
re-send media the contact ALREADY sent us -- a photo or document sitting in the contact's
"Media from comms" gallery (the inbound mirror at media/<conversationId>/<sid>/<i>). There
is no affordance to pick an existing gallery item and forward it to another conversation.

**Why it is deferred / needs design.** This is not just a UI pick. Received media is
sensitive: the gallery can hold ID photos, benefit letters, and other PII a contact texted
in. Forwarding it elsewhere (to a landlord, say) needs a deliberate privacy story --
which items are forward-eligible, an explicit confirm, an audit trail, and a rule that we
never silently relay a contact's private document to a third party. The send path itself
is easy (the attachmentKeys contract could accept a media/ key with a widened, tightly
scoped regex, or a copy-into-uploads/ step), but the privacy design gates it.

**Suggested fix.** Design the forward-eligibility + confirm + audit model first, then add a
"forward" affordance on gallery items that either (a) copies the chosen media/ object into
a fresh uploads/<uuid> and sends via the existing attachmentKeys path, or (b) widens the
send contract to accept a narrowly-validated existing key with an explicit staff confirm.
Prefer (a) so the send contract stays confined to server-minted uploads/ keys.
