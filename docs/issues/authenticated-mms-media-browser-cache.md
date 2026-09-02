---
id: authenticated-mms-media-browser-cache
title: Authenticated MMS media can survive a browser session change in cache (accepted risk)
type: security
severity: low
status: wontfix
area: app
created: 2026-08-27
resolved: 2026-09-02
refs: app/src/routes/api.ts:2387, app/src/routes/api.ts:2292, app/src/routes/unitMediaServe.ts:31
---

**Problem.** The authenticated `GET /api/messages/:providerSid/media/:idx`
route returns `Cache-Control: private, max-age=3600`. Private prevents shared
proxy caching but does not key a browser cache entry by the session cookie. A
browser that displays the same URL after logout, a role change, or a different
login can reuse fresh bytes without making an authorization request.

This predates the in-app image viewer. Existing inline Timeline thumbnails
already request the same authenticated URL, so it is not introduced by that
feature.

**Why accepted (Cameron, 2026-09-02).** Caching on a local machine is fine and
useful here. The reuse window is one hour, on one browser profile, on a machine
where someone was already signed in - so realizing it requires local access to
that machine, which is the same access that already yields the session itself.
Nothing crosses a network boundary and no unauthenticated party anywhere can
reach these bytes: the route stays behind `requireAuth`, and `private` keeps
CloudFront and any corporate proxy from holding a copy. Against that, `no-store`
would cost a network round trip and a fresh S3 read for every thumbnail render
in the Timeline and every open of the image viewer - a real, permanent, everyday
cost paid to close a local-access-only window. Severity was downgraded from high
to low with this entry; it was not silently minimized.

**Residual risk, stated plainly.** For up to one hour after viewing, a person
with physical or remote-desktop access to a machine that was already signed in
can re-display an already-viewed attachment by revisiting its URL, after logout
or under a different login, with no fresh authorization check. Shared front-desk
and kiosk machines are where this would bite. The mitigation is operational (do
not leave a signed-in session on a shared machine), not code.

**Sibling sweep (2026-09-02).** Every route in the app that streams stored bytes
was checked:

- `GET /api/calls/:callId/recording` (authenticated, PII audio) declared NO
  `Cache-Control` at all, leaving an authenticated PII response to browser
  heuristics. FIXED in this same change (Cameron, 2026-09-02): it now declares
  `private, max-age=3600`, identical to the MMS media route. An authenticated
  response should never have an UNSTATED caching policy, and `private` is the
  load-bearing half - no shared proxy or CDN may hold these bytes. The two
  routes are now deliberately in LOCKSTEP, each with a paired test asserting
  the header (`app/test/mmsMedia.test.ts`, `app/test/voiceRecording.test.ts`);
  change both or neither.
- `GET /unit-media/:unitId/:object` is `public, max-age=604800` and
  unauthenticated BY DESIGN (spec D5) - public flyer photos on unguessable
  server-minted uuid keys, shape-scoped to exactly two safe segments so the PII
  namespaces (`media/`, `recordings/`, `uploads/`) cannot be addressed through
  it. Not the same defect, and out of scope by design.
- No other route streams bytes. The `/api/media/presign` + `/confirm` pair mints
  and transcodes but serves nothing.

Two genuinely unauthenticated media exposures found during the same sweep were
filed separately, since both involve URLs fetchable with no session at all - a
materially different risk from a local browser cache:
[`outbound-mms-presign-ttl-one-hour`](outbound-mms-presign-ttl-one-hour.md)
(which turned out to be a latent DELIVERY bug as well: our 1h presign TTL is
shorter than Twilio's 10h queue window) and
[`twilio-hosted-inbound-media-retained`](twilio-hosted-inbound-media-retained.md)
(deferred for review at higher volume).

**Revisit only if** the dashboard is ever used on genuinely shared or public
terminals as a normal pattern, or if a role/permission model arrives where one
signed-in user must be prevented from seeing what a previous signed-in user on
the same machine already viewed. The fix at that point is
`Cache-Control: private, no-store` on the media response plus a hermetic browser
regression that loads a media URL as one principal, changes session in the SAME
browser context, re-requests the identical URL, and proves a fresh authorization
request reaches the server.
