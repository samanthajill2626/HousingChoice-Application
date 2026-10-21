# Intent record - flyer-leads (Sam's flyer trim + tracker #13 "Flyers and leads")

Planner session 9be85e76-82e9-4d98-a7ac-709a778803fe. Worktree `W:\tmp\flyer-leads`,
branch `feat/flyer-leads`, cut from main @b7959e2a (2026-10-21). Main already holds
the #11 + #12 property-requirements merge (e46cc770), which is merged but NOT
deployed.

## STATE (replace each time)

- Phase: PLAN DRAFTING (compaction gate A done 2026-10-21 17:22, 595k -> 28k).
  Spec rev 6 @5944de7e is approved.
- Plan v1 committed @d5684bbe: sections 0-4 binding (AR1-AR10), six slice
  drafts assembled as sections 5-10 (S1 2 tasks, S2 6, S3 4, S4 5, S5 3, S6 5).
- Plan review round 1 done and committed @ebc7a5bd: 15 distinct findings
  (2 medium, 13 low), 14 accepted, 1 rejected; 3 change a decision (AR11
  deleted-path audit, AR12 consistent read, AR13 phone label for a nameless
  contact on the Sent to card). The spec got a section 7 "Plan-time
  amendments" note.
- Plan v2 committed @444e0f86 (round 1 folded into the slices; S3 gained
  Task 3.5 for AR13). AR16 WITHDREW the AR5 whitespace question: app.ts:146
  trimJsonBody deep-trims every JSON body, so no HTTP save stores those unit
  fields untrimmed. Nothing is owed to Cameron on it; tell him it was moot.
- In flight: plan review round 2, reviewer B continued with the RE-REVIEW
  CHARGE, writing `plan-review/R2-reviewer-b.md` (diff v1->v2 at
  `.superpowers/sdd/plan-v1-to-v2.diff`; agent ids in `.superpowers/sdd/agents.md`).
- NEXT STEP: adjudicate R2 (append to `plan-review/adjudications.md`); if it
  changes no decision, fold the precision edits and STOP the review;
  otherwise send fixes to the drafters, re-assemble, commit, and run R3
  (cap 4). Then write the mission block, ask the launch gate (AUTO / MANUAL /
  Revise), and run compaction gate B on a Go.
- Gate answers in rev 6:
  - O1 closed: the decline writers stamp `shares_op`;
  - the repeat limit is per contact per PROPERTY per 24 hours, with /join and
    unavailable flyers sharing one "no property" source;
  - new sign-ups are marked unread too, after the welcome;
  - the flyer calls and the name in the note are accepted.
- Also done 2026-10-21 at Cameron's request: tracker #11 and #12 set to Done in
  both the summary table and the item tables. The Order of work line and
  dated "Oct 21, 2026: Done (merged Oct 21; goes live with the next release)"
  notes were added; verified via read_doc.
  - Cameron confirmed #11 and #12 asked for nothing on the TENANT record.
  - A separate subzone session (started by Cameron) added tracker #33 "Fill
    in the subzone from the address". Never edit #33 from here.
- Subzone auto-fill is NOT this mission. Its research is at
  `W:\tmp\subzone-autofill-research\research-report.md`. Cameron starts that session
  himself from the prompt given 2026-10-21; he rejected the start_session card.
- Planner calls inside the spec that Cameron saw and accepted at the gate:
  - the heading fallback "Home for rent";
  - the thank-you text;
  - the typed name in the milestone label;
  - the 24-hour repeat dedupe;
  - the milestone for new contacts too;
  - a sent-list row for tenant contacts only;
  - a failed milestone/unread write not failing the request;
  - D5's consequence (a failed welcome is never retried by a re-sign-up).

## What Cameron asked for (verbatim, 2026-10-21)

Sam's feedback, relayed by Cameron at 15:05 UTC:

> "Can we remove some fields from displaying on the flyer? Rental max and min, lease
> terms can be removed entirely since it is always 1 year, accessibility, pets (may be
> flexible), also deposit information is often better to talk through with the
> tenant. This is information I will want but does not need to be on the flyer. "

> "Subzones have to be manually looked up by me via this link
> https://www.atlantahousing.org/wp-content/uploads/2023/03/AHs-Payment-Standards-and-How-We-Determine-Rent.pdf"

Cameron's answers to the planner's scope questions:

> "Since we're making flyer trim information here, I think that we should just do
> number 13 while we're at it. Lease terms should be kept in the system because I think
> that they'll be useful for market rent, and she's not really thinking about that. We
> do need to keep them in the system and just make them staff-only and pull them off
> the flyer. Accessibility comes off. Application fee stays. Yes, leave the rent merge
> field alone. We can still add it if we need to."

> "For the heading, I think A is probably the best. Yeah, I like your answer for number
> two as well. Let's do number 3 for the signup wording, and then we can see if she
> agrees after we've built it. That's not a big issue. For your number 4, let's talk
> about. I agree with what you've got here, except for the /join page. I want that to
> sort of function similarly: if the join page gets a signup from someone who's already
> a contact, the same thing occurs. They signed up from the join list, but obviously
> there's no property added to their properties sent list. That would still mark the
> conversation unread and standing out in the inbox, but they wouldn't get a welcome
> text because they're already part of it. Does that make sense?"

> "I do want to ignore case and spacing for the subzone specifically. We do need to
> make sure that we're doing things like trimming, so front or back spaces, white
> spaces, are not treated differently or saved as actual data. That's a big pet peeve
> of mine [...] Use that thought process as we're updating this flyer."

The options he picked refer to the planner's 2026-10-21 messages:
- heading (a): the address becomes the heading, linked to the map, and the separate
  Address row goes;
- (2): a highlighted "Same-day tours available" line near the top of EVERY flyer;
- (3): sign-up box copy - heading "Sign up for home alerts", text "We'll text you
  about this home and others that fit your voucher. Signing up does not book a tour.",
  button "Sign up". Sam reviews it after the build;
- (4): an existing contact signing up from a flyer gets no welcome text, a note in
  their conversation ("Signed up from the flyer for <address>"), the conversation
  marked unread, and the property added to their properties-sent list. A NEW contact
  from a flyer also gets the property on their sent list. /join behaves the same for an
  existing contact (no welcome, a note, unread), minus the property.

## Settled scope

1. Off the public flyer, and out of the public projection (not merely hidden):
   - rent min/max (the rent line);
   - lease terms;
   - accessibility;
   - the whole Pets item (No pets, Pets details, Pet fee);
   - the whole Deposit item (One month's rent, Fixed amount, Flexible).

   Every field stays in the system, on the forms and on the property page, re-tagged
   "Staff only". The application fee STAYS on the flyer.
2. Tracker #13 flyer changes:
   - "A home for you" heading gone - the address is the heading (map link);
   - rent removed;
   - "Same-day tours available" on every flyer;
   - the housing authority line bolder;
   - the sign-up box kept and reworded.
3. Tracker #13 lead handling, for an existing contact on both the flyer and /join: no
   welcome text, a sign-up note in the 1:1 conversation, and the conversation marked
   unread. A flyer sign-up (new or existing contact) adds the property to the contact's
   properties-sent list.
4. Similar properties: the subzone match ignores case and spacing. Exact codes only -
   no fuzzy matching on codes ("SE1" vs "SE11").
5. Whitespace hygiene on anything touched: trim before store/compare (memory
   `trim-input-whitespace`).

Already done elsewhere: #13's "AHA Housing Fair link: leads should default to AHA"
shipped with #14 (/join housing-authority dropdown, default rule).

## Why

- Sam would rather discuss rent, deposit, pets, lease and accessibility with each
  tenant than publish them; she still needs the data.
- #13: flyers now travel through caseworkers. Tenants filled in the sign-up box as if it
  booked a tour, and existing tenants got the welcome text in the middle of an ongoing
  conversation.
- Lease terms stay because Cameron expects them to matter for market rent later.

## Preferences and taste calls

- The sign-up copy is the planner's draft, accepted to build; Sam may revise it later.
- Cameron wants untrimmed whitespace never stored or compared as data ("a big pet
  peeve").
- Future similar-properties matching (fuzzy matching on free text) waits for the new
  matching engine (Work Package 1).

## Rejected options

- A subzone DROPDOWN of AH's 24 codes: rejected (Cameron 2026-10-21). It would lock the
  app to Atlanta Housing when other authorities may have their own zones.
- Fuzzy matching on subzone codes: rejected - codes are exact.
- Removing lease terms from the system: rejected - staff only instead.
- Folding subzone AUTO-FILL from the address into this mission: rejected - it is a
  separate feature for a new session.
- Fuzzy matching on other similar-properties fields now: deferred to the new matching
  engine.

## Explicit NOs

- No change to the [Rent] broadcast merge field.
- No deletion or backfill of any stored field.
- No subzone dropdown.

## Open questions / assumptions made on Cameron's behalf

- Pets and Deposit coming off WHOLE was asked as "Is that right?". Cameron answered the
  surrounding parts (accessibility off, application fee stays) without objecting;
  recorded as accepted.
- The spec will mark as planner calls: the heading fallback when a property has no
  address, the thank-you copy, the note wording, and repeat-sign-up dedupe.

## Gate A additions (2026-10-21)

Cameron's spec-gate answers, verbatim:

> "For O1, let's close it. For the flyer calls that you made, those are fine. For
> existing contacts who sign up, the note doesn't matter. To include the name,
> let's just leave it there. We don't need to rename the contact. That's fine. On
> the limit, I don't know if one note and one inbox bump per contact per 24 hours
> is right, because if you are sharing flyers here, it could be multiple different
> flyers. They use the same process every time to re-sign up, which is not what
> they're supposed to do, but if they do, we still want to track that.
>
> Really, it's one note and one inbox bump per contact per property. I don't know
> if we need a limit on time, because if they've already signed up once, we don't
> need to do it again. However, maybe we want to record that they did something,
> so maybe it should be a 24-hour check. When you say new contacts get the same
> note without the unread mark, does that mean that they won't show up in the
> inbox as unread? We definitely want that to happen."

> "Yes, I do" (approving rev 6), then: "You're right. 11 is landlord requirements,
> and 12 is property page fields. [...] let's update the tracker and make sure
> that we've noted that those are finished as well."

Cameron questioned two rev 2 reversals. He believed the app blocks shared
phones (true for NEW ones: 409 on create and on add-number) and that every
existing contact already has consent (true for inbound, web forms and imports;
not for hand-added contacts, whose consent field is optional). The planner
explained both; rev 6 D4 states the duplicate-phone block.
