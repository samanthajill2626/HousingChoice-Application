---
id: relay-preview-lists-members-provisioning-drops
title: Tour and placement previews list members provisioning will drop, unannotated
type: bug
severity: med
status: open
area: app/relay
created: 2026-08-17
refs: app/src/services/rosterEdits.ts, app/src/services/rosterProvision.ts:106-121
---

**Problem.** On the tour and placement paths, `buildOpenPreview` builds
`recipients` from `describeRoster`'s FULL roster view while
`provisionMembersOf` (`services/rosterProvision.ts:106-121`) excludes
phone-less members and keeps one slot per phone number. The confirm dialog
therefore names people who will not be on the thread and will not be texted,
with no annotation saying so (`toRecipient` carries only name and
reachability; the view's `sharesPhoneWithName` never reaches the dialog).
Pre-existing imprecision on both shipped surfaces, surfaced by the
contact-create-relay-group review. The standalone path deliberately declines
to reproduce it: it de-duplicates exactly as create does, so its dialog lists
only people who will really be on the thread.

**Suggested fix.** Either annotate dropped rows (shares a number / no number)
in the owner-path preview, or build the owner-path `recipients` from the same
provisioning-shaped list the standalone path uses. Either way the tour and
placement preview tests must change deliberately, not incidentally.
