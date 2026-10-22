# flyer-leads - planner review P1: plan-blind adversarial

Reviewed: `feat/flyer-leads` at `c860883b` (`git diff main...HEAD`), code only.
Plan-blind: nothing under `docs/superpowers/` was opened. No test, build or
script was run (`planner.end` did not exist during the review), so every
proof below is a code path; anything not provable that way is marked
PLAUSIBLE. Byte-exact backing quotes:
`.superpowers/sdd/planner-review-adversarial-reference.md`.

Already filed by the branch and NOT repeated here (read in `docs/issues/`):
public-signup-abuse-hardening (non-atomic 24h cap, typed-name spoofing, bump /
reopen of any contact's thread, ledger rewrite on every sign-up, made-up
unitIds, new-phone noise, roster-scan flood, latency oracle, blast ledger
contention), flyer-signup-decline-click-race, consent-capture-ignores-signup-
web-form, deleted-contact-web-signup-silent, public-welcome-text-global-cap.

Counts: BLOCKING 0, HIGH 0, MEDIUM 2, LOW 4, INFO 4, PLAUSIBLE 0 (one LOW
carries a PLAUSIBLE sub-claim, marked inline).

---

## M1 - MEDIUM - Rent min / Rent max now say "Staff only - never leaves the dashboard", but the Matching blast's default text sends the rent to every recipient

- Where: `app/src/lib/requirements.ts:540-541`,
  `dashboard/src/routes/listing/requirements.ts:264-265` (flipped to
  `staff_only` by this branch); the tag and legend copy
  `dashboard/src/routes/listing/FlyerTag.tsx:22,36` rendered on both forms
  (`ListingEditForm.tsx:305` legend, `:387`/`:400` Rent tags;
  `UnitCreateForm.tsx:416` legend, `:522`/`:535` Rent tags); the blast
  default `dashboard/src/routes/broadcasts/resolveTemplate.ts:30-31`
  ("... is available for [Rent]/mo ...") and the server render
  `app/src/lib/mergeFields.ts:97`.
- Scenario: staff open New property / Edit property. The legend under the
  title says "Staff only - never leaves the dashboard." and the Rent min /
  Rent max fields carry the "Staff only" tag. A navigator then opens a
  Matching blast for that property: the composer PRE-FILLS the default text,
  which carries `[Rent]`, so every recipient is texted the rent range. Before
  this branch the tag read "On flyer" (true-ish: rent was public). Now the one
  UI signal whose whole job is to tell staff what tenants see is false for
  exactly the field the default outbound text publishes. A staff member who
  trusts the tag (for example records the landlord's floor as Rent min, or
  assumes Sam's "talk rent through in person" rule now holds) has it texted to
  every Matching recipient. Who notices: tenants (and Sam, whose stated reason
  for removing rent from the flyer is defeated by the default blast).
- Proof: `formFieldVisibility('Rent min')` -> `staff_only` ->
  `flyerTagText` returns "Staff only"; `LEGEND.property[1]` is the "never
  leaves the dashboard" line; `DEFAULT_SEND_TEMPLATE` contains `[Rent]` and
  `renderMessage` substitutes `unitContext.rent`
  (`mergeFields.ts:36-37,97`). The branch's own GLOSSARY entry
  (`documentation/GLOSSARY.md:202-205`) records that rent "still reaches
  tenants ... the [Rent] merge field, which the Matching blast's default text
  carries" - the docs know, the form copy does not. No other Staff-only field
  is reachable by a merge field (`mergeFields.ts` tokens are TenantName, Beds,
  Address, Rent, FlyerLink), so Rent is the only lying tag.
- Smallest fix: give the two Rent fields an honest tag/note ("Not on the
  flyer - sent in Matching texts via [Rent]"), or narrow the legend line to
  "never on the public flyer". Whether `[Rent]` should stay in
  `DEFAULT_SEND_TEMPLATE` is a product call for Cameron/Sam, but the tag must
  not say "never leaves" while it does.

## M2 - MEDIUM - One IP can push every real unread conversation off Today in about 20 minutes: each made-up-phone sign-up now creates an UNREAD thread, and Today keeps only the newest 100

- Where: `app/src/routes/public.ts:659-673` (pin + `markSignupUnread` for
  every live contact, a NEW one included, after its welcome);
  `app/src/routes/today.ts:182` (`TODAY_UNREAD_CAP = 100`) and the collect
  loop `today.ts:704-752` (newest-activity-first over byUnread, break at 100
  KEPT 1:1 rows).
- Scenario: an anonymous caller posts `/public/housing-fair` with a fresh,
  well-formed but made-up phone each time (every request is a NEW contact, so
  the 24h repeat check never even runs - `public.ts:641`). At the default
  per-IP limit (5 per 60 s, `app/src/lib/config.ts:1008,1014`) one IP produces 100 new tenant contacts in about
  20 minutes, each with an open 1:1 thread whose `last_activity_at` is "now"
  and `unread_count` 1. Today's unread pass walks byUnread newest-first and
  stops after 100 kept 1:1 rows, so all 100 slots are junk and every REAL
  tenant/landlord/partner thread that is waiting on a reply drops out of
  Today's Unreplied block (and unknown inbound out of Needs you now) until
  staff open or mark-read 100 junk threads. Before the branch the same request
  left a READ thread (only the outbound welcome), which never entered byUnread
  and could not consume a slot. Who notices: nobody, at first - Today simply
  looks full; the real unreplied tenants are silently missing from the work
  queue (the inbox still lists them below the junk).
- Proof: code path above; the cap comment itself names the hazard ("pushing
  real work off the queue the cap exists to protect", `today.ts:684-685`). The
  filed issue's "New phones" point lists "a Today row under Unreplied" as noise
  but not this starvation of the capped block, nor that one IP suffices.
  Related, PLAUSIBLE (not reproduced): the same junk also grows two unpaginated
  `requireComplete` reads without bound - the property Sent to card
  (`units.ts:1498-1507`, every row of the unit) and Follow up
  (`followUps.ts:146-161`, every row within 14 days of every available unit),
  where one unprocessed BatchGet key 503s the whole card or tab.
- Smallest fix: the global new-contacts ceiling the filed issue already
  proposes, applied to the unread mark too (over the ceiling, create the
  contact but skip the bump); or do not mark a brand-new contact's thread
  unread (the pin alone records the lead). Record the starvation consequence
  in `public-signup-abuse-hardening.md` either way.

## L1 - LOW - A sign-up that 500s after creating the contact is never welcomed on the visitor's retry (main re-welcomed it), so a web_form-consented contact never gets the CTIA confirmation text

- Where: `app/src/routes/public.ts:544-573` (create, stamping
  `consent_method: 'web_form'`), `:584-585` (thread get/create and
  participants link - several DynamoDB writes, unguarded), `:593` (welcome
  only when `isNew`); main gated on the flag instead
  (`git show main:app/src/routes/public.ts`, lines 329 and 384).
- Scenario: `contacts.create` succeeds, then `createOrGetByParticipantPhone`
  or `setParticipantsIfAbsent` throws (throttle, transient fault). The route
  answers 500; the flyer/join form shows its error and stays put
  (`FlyerPage.tsx:251`: "A throw propagates to the IntakeForm so it shows its
  error and stays put"), so the visitor submits again. The retry finds the
  contact (`findByPhone`), takes the EXISTING path, and sends nothing. The
  contact keeps its web_form consent and will receive Matching blasts, but
  never received `WELCOME_SMS` (`app/src/lib/smsCompliance.ts:133`, the
  STOP/HELP opt-in confirmation). On main the retry read
  `housing_fair_welcomed !== true` and sent it.
- Proof: code path above. The comment at `public.ts:589-590` accepts "a new
  contact whose welcome FAILS is not re-welcomed"; this is a different case -
  the welcome was never attempted and the client was told the request failed.
- Smallest fix: on the existing-contact path, send the welcome when the
  contact carries `consent_method: 'web_form'` and no `housing_fair_welcomed`
  (that pair exists only on a contact this endpoint created and never
  welcomed), or move the welcome before the thread step's failure point.

## L2 - LOW - The property Activity card shows a raw contactId for the nameless unknown contacts this branch puts on the Sent to card

- Where: `app/src/routes/units.ts:2268` (Activity `contactName` =
  `displayNameOfContact`, name only); `dashboard/src/routes/listing/listingFormat.ts:226,250`
  (`who = e.contactName ?? e.contactId` -> "<id> not interested");
  contrast `units.ts:207` `recipientLabelOf` and `followUps.ts:92` `nameOf`
  (name, else formatted phone - AR13 / R2 N1).
- Scenario: an auto-captured `unknown` contact (no name) signs up on a flyer;
  the D7 entry puts them on the property's Sent to card, labelled by phone.
  Staff click Not interested (or Interested / Undo) on that row; the outcome
  route appends `listing_declined` to `units#<unitId>`
  (`lib/listingOutcomeEvents.ts:42`). The property's Activity card then reads
  "contact-3f2a... not interested". The branch fixed the label on two of the
  three surfaces that show this contact.
- Proof: code path above.
- Smallest fix: use `recipientLabelOf` (or a shared "name else formatted
  phone" helper) for the Activity `contactName`, so the three surfaces cannot
  drift again.

## L3 - LOW - The new flyer success copy promises texts that will not come for an existing opted-out contact, whose web-form re-opt-in is discarded

- Where: `dashboard/src/routes/public/FlyerPage.tsx:431,440` ("We'll text you
  about this home and others that fit your voucher."); existing contacts are
  never changed (`public.ts:484-488`, D4) and still get the pin and bump
  (`public.ts:659-673`); sends refuse `sms_opt_out`
  (`app/src/services/sendMessage.ts:123,513`).
- Scenario: a tenant who once replied STOP later fills the flyer's sign-up
  box, ticking the CTIA consent box. The page says they will be texted; the
  contact keeps `sms_opt_out: true`, so no blast, reminder or staff reply ever
  reaches them, and the staff reply the new pin invites is refused
  (`contact_opted_out`). Main said "a team member will be in touch", which
  staff could keep by calling. The filed consent issue covers contacts with
  NO consent, not opted-out ones (its "Who it reaches" paragraph).
- Proof: code path above. The answer is a constant `{ ok: true }`, so the page
  cannot tailor the copy per contact.
- Smallest fix: copy that does not promise texts, or add the opted-out case
  to `consent-capture-ignores-signup-web-form.md` so the compliance call
  (does a web-form opt-in clear a STOP?) covers it.

## L4 - LOW - A flyer entry flips a legacy "Property sent" pin from "Property text failed" back to "Property sent"

- Where: `app/src/routes/contactTimeline.ts:732` (a pin with no share id, or
  no entry for its share, reads the PAIR: `row.counted === false ? failed :
  sent`); `app/src/services/shareLedger.ts` applyFlyerShareEntry makes the
  pair counted.
- Scenario: a pre-share-sent-outcome `listing_sent` pin (no `broadcastId`)
  whose pair the repair script uncounted (`repair-share-outcomes.ts`
  pairsToUncount) correctly reads "Property text failed". The tenant then
  signs up on that property's flyer: the pair is counted by the flyer entry,
  and the old pin now reads "Property sent" - the timeline claims a text
  succeeded that failed. Rare (legacy pin + uncounted pair + sign-up).
- Proof: code path above; current pins always carry `broadcastId`
  (`jobs/broadcastFanOut.ts:1249-1257`), so only legacy pins are exposed.
- Smallest fix: in `propertySentWords`, judge the pair by its non-flyer
  entries (ignore `shares.flyer`) when the pin carries no share id.

## I1 - INFO - The flyer veto is judged at write time, so a decline that a later share only TEMPORARILY superseded becomes permanently superseded

`shareLedger.ts` applyFlyerShareEntry vetoes only a CURRENT decline. Sequence:
staff decline at T1; staff re-share at T2 > T1 (decline superseded); tenant
signs up at T3 (no current decline, entry written); T2's delivery then fails
(`mayReplace` lets counted-by-acceptance move to failed). Without the
sign-up the pair falls back to the older share and reads Not interested
again; with it, the flyer entry (T3 > T1) keeps the decline superseded and the
pair reads Signed up. Arguably right (the person signed up after staff re-sent
it), but it is one more order in which a public request outlives a staff
decline; worth a line in flyer-signup-decline-click-race.md.

## I2 - INFO - FlyerPage comment says the hidden suffix announces a new tab; it does not

`dashboard/src/routes/public/FlyerPage.tsx:318` says the suffix "also says the
link leaves for Maps in a new tab"; the suffix at `:325` is " - open in Google
Maps" on a `target="_blank"` link. Either add "(opens in a new tab)" or fix
the comment.

## I3 - INFO - A sign-up reorders the tenant's Properties sent list, which sets the Schedule tour form's default property

`ContactDetail.tsx:1436` defaults ScheduleTourForm to `listingsSent.rows[0]`
(newest sentAt). Every sign-up moves that pair's sentAt to now, so any caller
who knows the phone and a shareable unitId chooses the default property staff
see when they schedule from the contact page. Harmless for a genuine
sign-up; mention it beside point 2 (c) of public-signup-abuse-hardening.md.

## I4 - INFO - "Same-day tours available" is printed on every flyer, whatever the property's tour arrangement

`FlyerPage.tsx:336` (the static `.highlight` line) shows it on properties with no
`tour_type` or landlord-led touring too. Sam asked for it (tracker #13, per the
code comment); flagging only so the promise is a conscious product call, since
tenants will read it as a fact about THIS home.
