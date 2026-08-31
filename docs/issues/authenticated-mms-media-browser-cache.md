---
id: authenticated-mms-media-browser-cache
title: Authenticated MMS media can survive a browser session change in cache
type: security
severity: high
status: open
area: app
created: 2026-08-27
refs: app/src/routes/api.ts:2308
---

**Problem.** The authenticated `GET /api/messages/:providerSid/media/:idx`
route returns `Cache-Control: private, max-age=3600`. Private prevents shared
proxy caching but does not key a browser cache entry by the session cookie. A
browser that displays the same URL after logout, a role change, or a different
login can reuse fresh bytes without making an authorization request.

This predates the in-app image viewer. Existing inline Timeline thumbnails
already request the same authenticated URL, so it is not introduced by this
feature. The viewer's provider is separately scoped to authenticated UI in this
branch to avoid retaining a descriptor across logout.

**Suggested fix.** Change the authenticated media response to `Cache-Control:
private, no-store` (or prove an equally strong session-bound cache-key design),
then add a hermetic browser regression that loads a media URL as one principal,
changes session, requests the identical URL, and proves a new authorization
check occurs before no old bytes can render.
