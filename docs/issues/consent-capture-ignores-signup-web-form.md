---
id: consent-capture-ignores-signup-web-form
title: Recording consent for a contact who signed up on the public form offers only staff-held methods, not the sign-up's web-form evidence
type: improvement
severity: low
status: open
area: dashboard
created: 2026-10-21
refs: dashboard/src/routes/contact/ConsentCaptureModal.tsx:28-109, dashboard/src/routes/contact/ContactCommsPane.tsx:369-371, dashboard/src/routes/contact/ConsentFields.tsx:57-62, dashboard/src/lib/consentCopy.ts:46-52, app/src/routes/contacts.ts:325-371, app/src/routes/public.ts:217, app/src/routes/public.ts:744-757, app/src/lib/smsCompliance.ts:66-91, app/src/lib/smsCompliance.ts:101, app/src/services/sendMessage.ts:551, app/src/jobs/broadcastFanOut.ts:276-283, app/src/services/groupMembers.ts:100-125, dashboard/src/routes/public/FlyerPage.tsx:251, dashboard/src/routes/public/FlyerPage.tsx:431-440, dashboard/src/routes/public/HousingFairIntake.tsx:163, app/src/services/sendMessage.ts:123, app/src/services/sendMessage.ts:513, app/src/lib/smsCompliance.ts:133, app/src/lib/smsCompliance.ts:239-245, app/src/lib/smsCompliance.ts:262-266, app/src/routes/public.ts:551, app/src/routes/public.ts:562-593, app/src/routes/public.ts:605-606, app/src/routes/public.ts:629, app/scripts/backfillConsentMethod.ts
---

**Problem.** A public sign-up - the flyer's "Sign up" box or /join - never
stamps consent on an EXISTING contact. That predates `feat/flyer-leads`: main
never did either (the #14 rule, D6 of
`2026-10-12-join-housing-authority-design.md`; main `0f6f29f9`'s
existing-contact path read only `housing_fair_welcomed`,
`app/src/routes/public.ts:324-329` there, and its only write to the contact
was that flag, `:399`), and flyer-leads keeps the rule (spec
`docs/superpowers/specs/2026-10-21-flyer-leads-design.md` D4: an existing
contact is never changed, consent included). What the branch adds is
visibility: the pin and the unread mark now bring such a sign-up to staff,
who then reply. The form requires the CTIA consent box (the server refuses a
body without `smsConsent: true`, `app/src/routes/public.ts:217`), but an
existing contact with no `consent_method` keeps none. So:
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
audit event (`contacts#<id>`, `app/src/routes/public.ts:744-757`): its
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
row A3: ACCEPT, D4's decided design), round 2 (`R2-review.md`, the A3
challenge: file the follow-up so it reaches the registry) and round 3
(`R3-review.md` finding 4: the gap predates the branch), all in
`docs/superpowers/reviews/2026-10-21-flyer-leads/code-review/`.

**Also: an opted-out contact who signs up again keeps the opt-out** (planner
review P1, `P1-adversarial.md` L3, in
`docs/superpowers/reviews/2026-10-21-flyer-leads/planner-review/`). A tenant
who once replied STOP and later fills the flyer's sign-up box, ticking the
consent box, is an existing contact: nothing is written to it (spec D4,
`app/src/routes/public.ts:551`), so it keeps `sms_opt_out: true`, and it still
gets the pin and the unread mark. The flyer's thank-you says "We'll text you
about this home and others that fit your voucher."
(`dashboard/src/routes/public/FlyerPage.tsx:431`, `:440`), but every send
refuses an opted-out contact (`contact_opted_out`,
`app/src/services/sendMessage.ts:123`, `:513`): no blast, no reminder, and not
the staff reply the pin invites. The answer is a constant `{ ok: true }`, so
the page cannot tailor its copy per contact. The kept opt-out is pre-existing
(main kept it too, and refused that contact's welcome); the flyer's promise is
new copy - main's said "a team member will be in touch" - while /join's
"A team member will text you"
(`dashboard/src/routes/public/HousingFairIntake.tsx:163`) is unchanged from
main. Re-subscribing a STOPped number from a web form needs a compliance rule:
the keyword way back is START (`OPT_IN_KEYWORDS`,
`app/src/lib/smsCompliance.ts:239-245`), and Twilio Advanced Opt-Out is on, so
Twilio holds the STOP too and refuses sends after it (21610, the live test
noted at `smsCompliance.ts:262-266`) - clearing the app's flag alone would not
reach the person. Whether a web-form opt-in may clear a STOP, and how, is a
decision for Cameron before anything is built.

**Also: a sign-up that fails before its welcome is never welcomed** (planner
review P1, `P1-adversarial.md` L1). Spec D5 welcomes only a contact the
request CREATED, and accepts that "a new contact whose welcome failed (refused
or errored) does not get one from a later sign-up". The same consequence
reaches a request that fails AFTER the create (`public.ts:562-593`, which
stamps `consent_method: 'web_form'`) and BEFORE the send: the thread
get-or-create and link (`public.ts:605-606`) is unguarded, so a throw there
answers 500 - since planner review C-F1 made the audit best-effort, the only
step after the create that still can. The flyer form shows its error and
stays put (`FlyerPage.tsx:251`), the visitor submits again, `findByPhone`
finds the new contact, and the retry takes the existing path: no welcome. The
contact keeps its web-form consent, so Matching blasts reach it, but it never
got `WELCOME_SMS`, the opt-in confirmation that carries STOP and HELP
(`app/src/lib/smsCompliance.ts:133`). Main re-welcomed it, gating on the flag
(main `0f6f29f9`, `public.ts:329` and `:384`).

The candidate rule: on the existing path, welcome a contact that carries
`consent_method: 'web_form'` and no `housing_fair_welcomed: true`. Its hazard
is a double text: when the welcome succeeded but the flag write after it
failed (`contacts.update`, `public.ts:629`, whose throw lands in the welcome's
catch and "costs only the flag"), the next sign-up texts the welcome again.
The pair is not unique to the crash either: a refused or failed welcome leaves
it (the D5 consequence above, which the rule would reverse), and so does a
legacy `housing_fair` / `flyer` contact whose welcome never succeeded, once
`app/scripts/backfillConsentMethod.ts` stamped it `web_form`. So the rule is a
decision for Cameron, not a fix-wave change.

A safer direction (planner review P2, `P2-adversarial.md`, A-L1 defended):
create or get the thread BEFORE the contact on the new-contact path, so a
thread-step throw leaves no contact behind and the visitor's retry is still a
create that gets the welcome. It re-texts no one. Its own cost: if the
contact create then fails, an empty thread with no participant link is left
for that phone (the next sign-up or inbound text reuses it while it is open).
It narrows the window rather than closing it (`setParticipantsIfAbsent` still
runs after the create).

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
