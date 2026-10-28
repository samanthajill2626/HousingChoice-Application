---
id: broadcast-send-refusal-deleted-unit-copy
title: A soft-deleted property's send refusal tells staff to "make it Available" while its status reads Available
type: bug
severity: low
status: open
area: dashboard
created: 2026-10-28
refs: dashboard/src/routes/broadcasts/RecipientPreview.tsx:374-397, dashboard/src/routes/broadcasts/RecipientPreview.tsx:417-420, app/src/routes/broadcasts.ts:1187-1193, app/src/routes/units.ts:1025-1038
---

**Problem.** The broadcast send guard refuses a soft-deleted property with
the same 400 `unit_not_available` it gives a property that is not Available
(`app/src/routes/broadcasts.ts:1187-1193`: missing, `isDeleted(unit)` and a
status outside `SHAREABLE_STATUSES` share the one code). The composer's
pre-flight (`RecipientPreview.tsx` `onSend`, :374-397) reads only the
property's status, from `GET /api/units/:unitId`, which returns a deleted
property with its stored status (`app/src/routes/units.ts:1025-1038`). So
for a property deleted while its status is Available, the pre-flight passes,
the server answers 400 `unit_not_available`, and staff read
(`RecipientPreview.tsx:420`): "This property isn't Available. Only Available
properties can be sent - make it Available, then send." The property reads
Available, and no status change can help: the send stays refused until the
property is restored.

Reaching it takes a property deleted after the composer opened it - a draft
resumed later, or a send started from a property page in another tab. The
composer's own property list never offers a deleted property (the unit list
excludes deleted ones by default).

PRE-EXISTING, not caused by permanent-flyer-links: main's copy had the same
shape ("This property isn't Available, so its flyer link won't work. Make it
Available, then send."); that branch's D8
(`docs/superpowers/specs/2026-10-27-permanent-flyer-links-design.md`)
changed only the reason. Found by its code review round 1
(`docs/superpowers/reviews/2026-10-27-permanent-flyer-links/code-review/R1-adversarial.md`
A-5, filed per `R1-adjudications.md`), which reproduced the server half with
a throwaway app test: a draft for an Available unit, `DELETE /api/units/<id>`,
then the unit read still says `status: available` with `deleted_at` set and
the send answers 400 `unit_not_available`.

Not checked: a property deleted while NOT Available gets the pre-flight's
"Make Available & send" dialog instead; what that status move does on a
deleted property was not traced.

**Suggested fix.** Either a distinct refusal code for a missing or deleted
property (for example `unit_deleted`) with its own copy, or a `deleted_at`
check in the pre-flight - with copy such as "This property was deleted -
restore it to send."
