---
id: phone-in-url-paths-structural
title: Six route paths still address a resource by a raw E.164 in the URL - masking closes the sinks we own, not the class
type: security
severity: low
status: open
area: app/routes
created: 2026-08-25
refs: app/src/routes/contacts.ts:2317, app/src/routes/contacts.ts:2376, app/src/routes/relayGroups.ts:467, app/src/routes/placements.ts:1084, app/src/routes/placements.ts:1218, app/src/routes/tours.ts:670, app/src/routes/tours.ts:801
---

**Problem.** This is the STRUCTURAL half of
[telemetry-phone-in-url-pii](./telemetry-phone-in-url-pii.md), split out when
that issue's telemetry half was resolved on `feat/log-hygiene` (2026-08-25). That
branch masks E.164 runs at all 14 logger-payload `path:` fields and on both OTel
span directions, which closes every sink this repo owns. It does not remove the
phone from the request line, so anything that reads a raw path BEFORE our sinks
still sees the whole number.

THE CORRECT SURFACE, verified against the code on 2026-08-25 - six route paths
across seven handlers, not the two the parent issue names (it was written from
the two routes the OTLP review happened to hit):

| handler | route | phone-bearing |
|---|---|---|
| `app/src/routes/contacts.ts:2317` | PATCH `/api/contacts/:contactId/phones/:phone` | always |
| `app/src/routes/contacts.ts:2376` | DELETE `/api/contacts/:contactId/phones/:phone` | always |
| `app/src/routes/relayGroups.ts:467` | DELETE `/api/conversations/:conversationId/members/:phone` | always |
| `app/src/routes/placements.ts:1084` | DELETE `/api/placements/:placementId/roster/members/:memberKey` | when contact-less |
| `app/src/routes/placements.ts:1218` | DELETE `/api/placements/:placementId/roster/live-members/:memberKey` | when contact-less |
| `app/src/routes/tours.ts:670` | DELETE `/api/tours/:tourId/roster/members/:memberKey` | when contact-less |
| `app/src/routes/tours.ts:801` | DELETE `/api/tours/:tourId/roster/live-members/:memberKey` | when contact-less |

The two contacts handlers share one path with different methods, which is why the
count is six paths and seven handlers. The three `:phone` handlers ALWAYS carry a
URL-encoded E.164. The four `:memberKey` handlers carry one CONDITIONALLY: a
roster member's key is its `contactId` when it has one, and `phone:<E164>`
otherwise (`app/src/lib/rosterResolution.ts`,
`app/src/services/rosterEdits.ts`), so a bare-phone member - which by design has
no other identity - puts the number in the path.

**Why the masking is not a close.** Masking is a sink-side defense applied inside
this app. Still exposed, by construction:

- The CDN / load-balancer access-log layer, which logs the request line before
  any application middleware runs.
- Any middleware or instrumentation mounted upstream of the masked sinks, and any
  future sink whose author does not know to call `maskPhonesInText`.
- An exception whose own message or stack quotes the URL - `message` and `stack`
  ride the log serializer's allowlist deliberately, and their contents are not
  scanned.
- Browser history, the Referer header, and anything a proxy retains.

**Suggested fix.** Stop putting phones in URLs, on the seven handlers above.
Realistically one of:

1. Move the phone into the request BODY. Straightforward for the PATCH; a DELETE
   with a body is awkward enough that these would likely become
   `POST /.../phones/remove` (and roster equivalents), which is a route-contract
   change.
2. Address by an opaque id - give a contact's phone entry and a bare-phone roster
   member stable ids, and take the id in the path. Eliminates the class outright
   and is the larger change: both an id-minting story for existing rows and a
   dashboard migration.
3. Accept it, and treat the sink masking as the standing posture. Then this issue
   becomes a `wontfix` with the reasoning recorded, rather than an open backlog
   item nobody plans to take.

Whichever is chosen, the dashboard callers move in the same change and the
affected e2e specs move with them; splitting them leaves a half-migrated
contract.

**Scope note.** `app/src/routes/contacts.ts` was excluded from `feat/log-hygiene`
by a concurrent-work agreement (another mission owned that file), so nothing here
was edited in it and its two anchors were read, not written. Re-verify those two
line numbers after that mission lands. The masking helper itself is
`maskPhonesInText` in `app/src/lib/phone.ts` - server-only, deliberately NOT
mirrored into the dashboard copy.
