---
id: twilio-hosted-inbound-media-retained
title: Inbound MMS media is mirrored but never deleted provider-side, and the provider URL is persisted
type: security
severity: med
status: deferred
area: app
created: 2026-09-02
refs: app/src/services/mediaMirror.ts, app/src/routes/webhooks/twilio.ts:649, app/src/adapters/messaging.ts:1079
---

**Problem.** Every inbound MMS attachment is mirrored into our own S3 and served
from there behind the session gate - the right posture. But the provider-side
copy is never deleted after a successful mirror, and the provider's media URL is
persisted verbatim on the message record. So each attachment a tenant texts us
(ID photos, pay stubs, documents, photos of children) exists in TWO places
indefinitely: ours, behind auth, and the provider's, at a URL we have written
down.

Whether that second copy is reachable without credentials depends on an ACCOUNT
SETTING that cannot be determined from this repo. Our own mirror fetch always
sends HTTP Basic auth, so it succeeds whether or not the account requires
authentication for media - which means the code proves nothing either way. If
media-URL authentication is not enabled on the account, those URLs are fetchable
by anyone who has the string, forever, with no session.

The persisted URL is not rendered anywhere in the dashboard (the UI renders the
authenticated `/api/messages/:providerSid/media/:idx` route), so this is about
data at rest and provider-side retention, not a UI leak.

**What to do.** In order:

1. VERIFY the account setting (does the provider require authentication to fetch
   media URLs?). This is a console check, not a code change, and it decides
   whether the rest is urgent or merely tidy.
2. Decide provider-side retention: delete the provider's copy after a confirmed
   successful mirror, or accept it with a stated reason. Deleting is the
   posture that matches "the bytes stay behind the session gate" everywhere
   else in this codebase.
3. If the copy is kept, consider whether the raw provider URL still needs to be
   persisted once `media_attachments` holds the durable key.

Sequencing note: the mirror deliberately tolerates a provider-side race (media
can appear a beat AFTER the message webhook, with a retry tail into the
`media.mirror` job), so any delete must key off a CONFIRMED mirror, never off
the webhook returning.

**Deferred (Cameron, 2026-09-02).** Fine to leave as-is for now; revisit when
volume goes up. The exposure scales with the number of attachments we have ever
received, so the argument for acting gets stronger over time, not weaker - which
is why this is deferred rather than accepted. Step 1 (the console check) is
cheap and can be done at any point without touching code; do that first when
this is picked back up, because it decides whether steps 2 and 3 are urgent or
merely tidy.

Found during the sibling sweep for
[`authenticated-mms-media-browser-cache`](authenticated-mms-media-browser-cache.md).
