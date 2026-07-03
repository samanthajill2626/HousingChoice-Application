---
id: placement-nudge-needs-landlord-1to1
title: Landlord placement nudges silently skip when the landlord has no 1:1 conversation
type: limitation
severity: low
status: resolved
area: app
created: 2026-07-03
refs: app/src/jobs/placementNudges.ts, app/src/jobs/tourReminders.ts, e2e/tests/scenarios/post-tour-application.spec.ts
---

**Problem.** The landlord-facing placement nudges (`approval_check`, `rta_window_closing`)
resolve their send target via `conversationsRepo.findByParticipantPhone(landlord.phone)`
looking for a `landlord_1to1` / `unknown_1to1` thread. A landlord contact that has never
texted (and never been texted 1:1) has NO such conversation, so the nudge row is skipped
with a warn log — no text goes out and nothing surfaces to the team beyond the log line.
(The tenant rungs share the shape but are unaffected in practice: a tenant always has a
1:1 by the time a placement exists.) Same behavior as the tour-reminder poller — inherited
pattern, not a regression. Operationally rare: by `Awaiting approval` the landlord has
almost always been texting; the e2e suite models this with one inbound landlord text.

**Resolved 2026-07-03 (option a):** the poller now creates the landlord 1:1 on demand.
When `findByParticipantPhone` yields no usable 1:1, `runDuePlacementNudges` mints it via
`conversationsRepo.createOrGetByParticipantPhone(phone, conversationTypeFor(contact))` — the
same one-active-conversation-per-phone claim every inbound path uses (a racing inbound never
duplicates) — denormalizes the contact's display name onto the new thread (best-effort), then
claims + sends as normal. Tenant rungs share the code path for free; the existing-thread path
is byte-identical. Thread existence was never consent: every gate (`sms_sending_disabled`,
opt-out, JIT consent, breaker, manual mode) is still enforced by `sendMessageService` at send
time. Mirrors the contacts "text a brand-new contact" fix (9a45085). Unit tests + the BLOWN
deviation e2e now exercise create-on-demand end-to-end.

**Suggested fix (pick one when it matters).** (a) Create the 1:1 conversation on demand
when a nudge targets a phone with none (mirrors how outbound-first sends bootstrap threads
elsewhere — see how the contacts "text a brand-new contact" fix on main created the thread
on first send, 9a45085); or (b) escalate the skip to the Today board instead of a warn log
so the team sees the chase never went out.
