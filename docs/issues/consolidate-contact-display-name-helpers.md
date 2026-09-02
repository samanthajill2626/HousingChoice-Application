---
id: consolidate-contact-display-name-helpers
title: Thirteen private copies of the contact firstName/lastName join - consolidate onto lib/contactName.ts
type: debt
severity: low
status: open
area: app
created: 2026-08-16
updated: 2026-09-01
refs: app/src/lib/contactName.ts:72, app/src/routes/contacts.ts:481, app/src/routes/units.ts:125, app/src/lib/rosterResolution.ts:164, app/src/services/groupMembers.ts:93, app/src/services/inboundEmail.ts:401, app/src/services/relayMembers.ts:41, app/src/services/groupConvert.ts:226, app/src/routes/api.ts:2085, app/src/routes/api.ts:2162, app/src/routes/inbox.ts:538, app/src/routes/today.ts:225, app/src/jobs/placementNudges.ts:147, app/src/routes/placements.ts:167
---

**Problem.** "Trim firstName, trim lastName, join with a space, treat empty as
no name" is implemented THIRTEEN times in `app/src`, privately, beside the
canonical `contactDisplayName` in `app/src/lib/contactName.ts:72`.

Corrected census (2026-09-01, swept by `feat/participant-snapshot-refresh`; the
count in this file's first two revisions said SIX and was wrong, not stale - it
listed the five copies that one push feature happened to walk past):

- `app/src/routes/contacts.ts:481` (`displayNameOf`)
- `app/src/routes/units.ts:125` (`displayNameOfContact`)
- `app/src/lib/rosterResolution.ts:164` (`displayName`)
- `app/src/services/groupMembers.ts:93` (`displayName`)
- `app/src/services/inboundEmail.ts:401` (`displayNameOf`)
- `app/src/services/relayMembers.ts:41` (`resolveMemberName`)
- `app/src/services/groupConvert.ts:226` (inline, in the member loop)
- `app/src/routes/api.ts:2085` (inline, `GET /group-members`)
- `app/src/routes/api.ts:2162` (inline, the relay external-caller hydration)
- `app/src/routes/inbox.ts:538` (`nameFromContact`)
- `app/src/routes/today.ts:225` (`nameFromContact`)
- `app/src/jobs/placementNudges.ts:147` (a LOCAL function also named
  `contactDisplayName` - it shadows the canonical name and returns `null`, not
  `undefined`)
- `app/src/routes/placements.ts:167` (`nameFromContact`)

Two of them are NOT mechanically re-pointable and a sweep must treat them as
behavior changes, not import swaps:

- `routes/inbox.ts:536-545` has an extra rung the canonical helper does not: a
  single denormalized `contact.name` field, consulted when the first/last join
  is empty.
- `routes/today.ts:223-229` trims the OUTER join only (`` `${first} ${last}`.trim() ``),
  where the canonical helper trims each PART before joining. A contact with a
  padded `firstName` renders an interior gap on Today and does not elsewhere.

`app/src/lib/voiceMasking.ts:46` `contactShortName` is NOT a copy - it is a
different rule ("First L.", the masked voice label) and must not be folded in.

The canonical export has grown consumers rather than a fourteenth copy:
`contactDisplayName` now accepts the MINIMAL shape (`{ contactId, firstName?,
lastName? }`), so it takes both a whole `ContactItem` and the
`ContactDisplayItem` projection from `getDisplayById` / `getDisplaysByIds`. Its
consumers are the inbound-message and voice pushes
(`routes/webhooks/twilio.ts`, `routes/webhooks/voice.ts`),
`app/src/lib/participantNames.ts` (the read-time roster name resolver), and
`app/src/lib/rosterDriftTally.ts` (the drift audit).

`firstName`/`lastName` are not declared fields on `ContactItem`; they ride its
index signature, so every copy has to be defensive about non-string values in
the same way, and each one gets to be defensive slightly differently. That is
the drift risk: a contact renders one way in a push, another way on the unit
page, and a third way in an email thread header, with no single place to fix
it. The canonical export was added deliberately rather than re-pointing the
existing call sites, because re-pointing them mid-feature would have widened a
push feature into a cross-cutting refactor with a suite per surface to
re-verify (see the scope-guard comment in `app/src/lib/contactName.ts`).

**Suggested fix.** A dedicated sweep: delete the thirteen private helpers, import
`contactDisplayName` from `app/src/lib/contactName.js` at each call site, and
move any behavior each copy has that the canonical one lacks (fallback labels,
email-local-part derivation, roster-specific shaping) into either the caller or
a named variant rather than silently into the shared helper. Update the
affected suites in the same change and keep the existing per-surface
assertions, so any behavior difference surfaces as a test failure rather than a
copy-paste conclusion.
