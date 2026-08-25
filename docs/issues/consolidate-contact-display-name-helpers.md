---
id: consolidate-contact-display-name-helpers
title: Six private copies of the contact firstName/lastName join - consolidate onto lib/contactName.ts
type: debt
severity: low
status: open
area: app
created: 2026-08-16
refs: app/src/lib/contactName.ts, app/src/routes/contacts.ts, app/src/routes/units.ts, app/src/lib/rosterResolution.ts, app/src/services/groupMembers.ts, app/src/services/inboundEmail.ts
---

**Problem.** "Trim firstName, trim lastName, join with a space, treat empty as
no name" is now implemented SIX times in `app/src`:

- `app/src/routes/contacts.ts`
- `app/src/routes/units.ts`
- `app/src/lib/rosterResolution.ts`
- `app/src/services/groupMembers.ts`
- `app/src/services/inboundEmail.ts`
- `app/src/lib/contactName.ts` `contactDisplayName` - the new canonical export,
  added by inbound-message-push for push copy.

Update (2026-08-25, `feat/log-hygiene`): the VOICE pushes are now a second
push-copy consumer of `contactDisplayName` - `pushCallerIdentity` in
`app/src/routes/webhooks/voice.ts` imports it rather than adding a seventh copy -
so the canonical export has two consumers and the five private copies below still
stand.

`firstName`/`lastName` are not declared fields on `ContactItem`; they ride its
index signature, so every copy has to be defensive about non-string values in
the same way, and each one gets to be defensive slightly differently. That is
the drift risk: a contact renders one way in a push, another way on the unit
page, and a third way in an email thread header, with no single place to fix
it. The sixth copy was added deliberately rather than re-pointing the five
existing call sites, because re-pointing five surfaces mid-feature would have
widened a push feature into a cross-cutting refactor with five suites to
re-verify (see the scope-guard comment in `app/src/lib/contactName.ts`).

**Suggested fix.** A dedicated sweep: delete the five private helpers, import
`contactDisplayName` from `app/src/lib/contactName.js` at each call site, and
move any behavior each copy has that the canonical one lacks (fallback labels,
email-local-part derivation, roster-specific shaping) into either the caller or
a named variant rather than silently into the shared helper. Update the
affected suites in the same change and keep the existing per-surface
assertions, so any behavior difference surfaces as a test failure rather than a
copy-paste conclusion.
