---
id: join-staff-entered-consent-method
title: Staff-entered /join sign-ups record consent as the person's own web-form opt-in
type: decision
severity: low
status: open
area: app
created: 2026-10-12
refs: app/src/routes/public.ts:272-277, docs/superpowers/specs/2026-06-30-a2p-sms-compliance-design.md:45-56, dashboard/src/routes/public/IntakeForm.tsx:229-247
---

**Problem.** At housing fairs staff type people into the public `/join` form
on their own device and tick the texting-consent box for them. Every such
contact is stamped `consent_method: 'web_form'` with no `consent_captured_by`
(public.ts:272-277), which reads as the person's own web opt-in. The A2P
design models staff-captured consent separately: `verbal_in_person`, with
`consent_captured_by` naming the staff member (a2p spec, consent fields
table). The record cannot show who ticked the box. Tracker #14's
"Sign up another person" button (feat/join-housing-authority) makes the
one-device, person-after-person flow easier but does not change what is
recorded. Raised by both spec reviewers of that branch (2026-10-12, R1 A-F9
and B-F11) and deferred as out of its scope.

**Suggested fix.** A product and compliance call first: is a staff-ticked
web-form box an acceptable opt-in record for the filed A2P campaign, or should
staff entry be a distinct, authenticated path that records `verbal_in_person`
plus `consent_captured_by`? The public form has no session, so it cannot
record a staff identity as it stands.
