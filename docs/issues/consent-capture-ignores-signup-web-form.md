---
id: consent-capture-ignores-signup-web-form
title: Recording consent for a contact who signed up on the public form offers only staff-held methods, not the sign-up's web-form evidence
type: improvement
severity: low
status: open
area: dashboard
created: 2026-10-21
refs: dashboard/src/routes/contact/ConsentCaptureModal.tsx:28-109, dashboard/src/routes/contact/ContactCommsPane.tsx:369-371, dashboard/src/routes/contact/ConsentFields.tsx:57-62, dashboard/src/lib/consentCopy.ts:46-52, app/src/routes/contacts.ts:325-371, app/src/routes/public.ts:205, app/src/routes/public.ts:718-731, app/src/lib/smsCompliance.ts:66-91, app/src/lib/smsCompliance.ts:101, app/src/services/sendMessage.ts:551, app/src/jobs/broadcastFanOut.ts:276-283, app/src/services/groupMembers.ts:100-125
---

**Problem.** Since `feat/flyer-leads` (spec
`docs/superpowers/specs/2026-10-21-flyer-leads-design.md` D4), a public
sign-up - the flyer's "Sign up" box or /join - never changes an EXISTING
contact, consent included. The form requires the CTIA consent box (the server
refuses a body without `smsConsent: true`, `app/src/routes/public.ts:205`), but
an existing contact with no `consent_method` keeps none. So:
- every blast skips them (`no_consent`,
  `app/src/jobs/broadcastFanOut.ts:276-283`, on the one predicate
  `hasSmsConsent`, `app/src/lib/smsCompliance.ts:101`), as do tour reminders
  and placement nudges;
- staff's first hand-written text hits the consent gate
  (`contact_no_consent`, `app/src/services/sendMessage.ts:551`), and the
  dashboard opens `ConsentCaptureModal`
  (`dashboard/src/routes/contact/ConsentCaptureModal.tsx:28-109`, mounted at
  `dashboard/src/routes/contact/ContactCommsPane.tsx:369-371`).

The modal offers only the staff-held methods: `ConsentFields` lists
`HUMAN_CONSENT_METHODS` (`dashboard/src/routes/contact/ConsentFields.tsx:57-62`,
`dashboard/src/lib/consentCopy.ts:46-52`), and the server refuses any other
method from a staff path (`applyConsentFields`,
`app/src/routes/contacts.ts:325-371`). Staff must pick something like
"Verbal (phone)" for a person whose actual opt-in is the web form, while the
evidence of that opt-in sits unused on the contact's `housing_fair_signup`
audit event (`contacts#<id>`, `app/src/routes/public.ts:718-731`): its
`consentVersion` (the disclosure version in force, `CONSENT_VERSION`,
`app/src/lib/smsCompliance.ts:91`) and its instant. The basis staff record can
then differ from the form evidence the audit keeps - spec D4 states exactly
this as a residual (design.md:241-246).

Who it reaches: an existing contact with no recorded consent - mostly
staff-added contacts whose optional consent field was left blank (inbound,
imported and web-form contacts already carry consent), plus group-detection
stubs, which are minted with no consent on purpose
(`app/src/services/groupMembers.ts:100-125`).

Traced from code review round 1 (`R1-adversarial.md` finding 3, adjudication
row A3: ACCEPT, D4's decided design) and round 2 (`R2-review.md`, the A3
challenge: file the follow-up so it reaches the registry), both in
`docs/superpowers/reviews/2026-10-21-flyer-leads/code-review/`.

**Suggested fix.**
- When the contact's audit trail holds a `housing_fair_signup` (and no
  opt-out came after it), the modal offers - and preselects - a "Signed up on
  the web form (<date>)" choice beside the staff-held methods.
- The SERVER stamps it from the audit row it reads itself: `consent_method`
  `web_form`, `consent_at` the sign-up instant, `consent_version` the audit's
  `consentVersion`, `consent_captured_by` the confirming staff member. A client
  must still never send `web_form` (the A2P design keeps system-stamped and
  staff-attested consent apart, `app/src/lib/smsCompliance.ts:66-87`,
  `app/src/routes/contacts.ts:325-335`), so this is a new staff action (for
  example `POST /api/contacts/:id/consent/from-signup`), not a wider PATCH.
- `housing_fair_signup` rows written before flyer-leads carry no
  `consentVersion` (main never stamped consent on an existing contact either);
  decide whether those qualify, and with which version.
- A compliance call comes first (Cameron): the repo's A2P design pairs every
  new consent stamp with the welcome text (spec D4: "Rev 2's consent stamp was
  reverted"), and D5 withholds the welcome from existing contacts. Decide
  whether a staff-confirmed web-form stamp sends the filed welcome before this
  is built.
