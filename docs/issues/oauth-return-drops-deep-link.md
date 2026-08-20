---
id: oauth-return-drops-deep-link
title: Signing in throws away the deep link you came from - now including a quick reply
type: bug
severity: med
status: open
area: app
created: 2026-08-20
refs: app/src/routes/auth.ts:273, dashboard/src/app/AuthGate.tsx, dashboard/src/routes/quickReply/QuickReply.tsx
---

**Problem.** The Google OAuth callback finishes with a bare `res.redirect('/')`.
Path, query and hash from wherever the user started are all discarded, so any
deep link opened without a live session lands on Today instead.

`AuthGate` renders `<Login />` IN PLACE, so the URL survives an in-place
re-auth. The loss only happens on the real OAuth round trip, which leaves the
origin and comes back through the callback.

Until 2026-08-20 this cost a bit of navigation. It now costs a STATE CHANGE. The
missed-call quick-reply sheet (`/quick-reply/:callId#action=qr-<n>`) sends a text
on arrival, so the sequence is:

  1. Founder's phone has an expired session.
  2. A missed call arrives; they tap a quick-reply action button.
  3. Google sign-in; the callback redirects to `/`.
  4. They are on Today. No reply was sent, and nothing says so.

That is the same silent-failure shape as
[`quick-reply-surface-not-rebuilt`](quick-reply-surface-not-rebuilt.md): the
founder pressed a labelled button and has every reason to believe a text went
out.

**Suggested fix.** Carry the intended path through the OAuth `state` parameter
and redirect to it on return.

The whole reason this was not done inline with the quick-reply rebuild: a
return-path threaded through OAuth state is an open-redirect surface in its own
right, and it has to be defended the same way the service worker's
`assertSameOriginPath` defends the notification-click path - a same-origin,
allow-listed, single-segment check on the way OUT of the callback, never a raw
echo of whatever the state carried. That is a security-shaped change and wants
its own review, not a rider on a UI fix.

Note the narrower alternative if the full fix stays unattractive: have the
quick-reply view detect that it arrived with an action it could not act on
because of a sign-in bounce, and say so. That does not recover the tap, but it
converts a silent miss into a visible one.
