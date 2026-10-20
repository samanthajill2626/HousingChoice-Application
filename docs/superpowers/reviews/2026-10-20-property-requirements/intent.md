# Intent record - landlord requirements and property fields (tracker #11 + #12)

## STATE (replace on every move)

- Phase: SPEC DESIGN REVIEW, round 1 (two opus reviewers, background, writing
  `design-review/R1-reviewer-a.md` and `R1-reviewer-b.md`).
- Spec: `docs/superpowers/specs/2026-10-20-property-requirements-design.md`
  revision 1, commit 53757846 on `feat/property-requirements`
  (worktree `W:\tmp\property-requirements`, cut from main @1d7a4667).
- Launch mode: not chosen yet (launch gate comes after the plan).
- In flight: the two R1 spec reviewers. No orchestrator, watchdog or mirror.
- Side artifacts: Sam's preview of the property edit form,
  https://claude.ai/artifact/5R3RhAD2BbALdMH2qc7ZTZ (shared with anyone with
  the link by Cameron; a sticky note carries 5 questions for Sam, incl. where
  subzone codes come from). Brainstorm mockups (local, ignored):
  `W:\AI Projects\Housing Choice\HC Application\.superpowers\brainstorm\626-1792507721\`.
- NEXT STEP: adjudicate both R1 reports into
  `design-review/adjudications.md`, revise the spec, run round 2 with the
  reviewer that landed more accepted findings (SendMessage, RE-REVIEW CHARGE),
  stop when a round changes no decision (cap 4), then the human spec gate
  (show counts + every REJECT with its reason).

## What Cameron asked for (2026-10-20, quoted where wording matters)

Intake: build tracker #12 (Property page fields) and #11 (Landlord
requirements and qualifications) together; every "Decided" line and dated
note in the tracker is a requirement; carry the voucher-size multi-select
through #1 (Properties filter), #28 / the Oct 12 note (flyer + Matching
pre-fill) and #6 (matching blast rules). "The checkbox label stays 'No
evictions while on the program'; a tenant's eviction history is free text and
the AI ranking weighs the two."

Decisions in the conversation:

- Blast any-of: "For Blast, yes. If there are multiple allowed options on a
  property, it should be looking for anyone that read that matches any of
  those voucher sizes." (He allowed deferring it to WP1 if it were a lot of
  work; it is not, so it is in.)
- Flyer wording: "Fits a 2- or 3-bedroom voucher" approved; "Instead of saying
  'fits a 0-bedroom voucher,' 'fits a studio voucher' is probably better."
- Public flyer data: agreed with the proposal (public: washer/dryer, deposit
  checkboxes, No application fee, pets + pet fee; internal: evictions, credit,
  income, qualifications, deposit notes). Later: subzone STAFF ONLY.
- Apply to all: "should give you an option to override properties with
  deliberate exceptions. Let's give an option to select which properties want
  to be copied over. I think that that's the easiest way to do this, to make
  sure it's actually usable."
- Copy at create: "Yes, copy at create. The create form will fill in info
  from the landlord so they can see that. It just becomes the default when
  creating a property and can be edited before it gets saved."
- "I think a blank landlord value does count as differing."
- Existing pets values: agreed (stored "not allowed" -> No pets ticked, text
  -> details, no backfill). $0 application fee = "No application fee": yes.
  Tour: "let's copy both" (tour process AND tour type).
- Voucher sizes: "whatever data does exist knowingly on both the property as
  well as the tenant. The landlord doesn't have an accepted voucher size
  because that should really only live on the property. Filters can show up
  to 4+ or whatever we decide, but if somebody has a 6-bedroom voucher, that 6
  needs to live on the tenant." Then: "through 12 needs to be able to be
  represented on a property as well." Property range = Studio..12 (the tenant
  range).
- "we do need to fix the matching 4+ bedroom chip because 4+ should be
  anything greater than 4" (read as 4 or more; stated back, not objected).
- Requirements get their own section on the landlord page.
- Copy only: "For property values, I think copy only is the right way to go.
  ... If you clear something on the landlord that says, 'Hey, I don't really
  know what their stance is on pets,' then it should clear the property value
  too, if you want it to." -> Apply can copy a BLANK item when staff check it.
- Big-size prefill: a 5-only property pre-filling 4+ is fine ("There's no
  real data for those sizes").
- Apply dialog: layout B (one screen, fields left, properties right).
- Remember where values came from: "Yes, let's remember."
- Property page: layout A (tag + small landlord line).
- Tag naming: purple "Set on this property"; orange renamed - "what we need
  to see is that it's an out-of-date value because it wasn't set on this
  property, and the landlord version was updated" -> "Landlord updated".
- "set on this property is what we should do for values that exist today."
- Cameron caught a flaw: a COPIED blank (unchecked No pets) that the landlord
  later changes must show "Landlord updated", not the blank/no-tag case.
  Copying records blanks too; only never-touched blanks are "not set yet".
- Voucher picker: B (Studio..4 + "More sizes (5-12)"), not A.
- Area: "where does area fit? I don't think that that was part of our
  requirements" -> not added to forms (a per-property free-text area would
  need renaming property by property).
- Wanted a shareable artifact for Sam with the edit page and the picker, to
  get her feedback (built; Cameron shared it).
- Flyer clarity on the edit page: "I want to make it clear on the edit page
  which pieces of information actually show on the flyer ... I'm worried
  about admins accidentally putting information that is not private from a
  legal standpoint, but damaging ... in that text field." -> On flyer / Staff
  only tags on every field, a legend, and a warning line under public
  free-text boxes.
- Subzone: "subzone should be staff only. Add that as a question in the
  artifact notes ... about where those subzones came from." (Done.)

## Why

These records feed Work Package 1's AI ranking (decided Oct 18: AI ranking
only), and they are what Sam checks by hand today. Exceptions on a property
are usually discovered only after a denial (tracker #11, Sep 30), so Apply
must protect them by default.

## Preferences and taste calls

- One screen, nothing hidden (Apply dialog B), see the landlord's value
  without hovering (layout A).
- Usability over cleverness: "make sure it's actually usable".
- Legal/reputational caution on anything tenant-facing.
- American English; plain staff-facing copy.

## Rejected options (do not re-propose)

- Fall back to the landlord's value at read time (rejected for copy only).
- Apply copying only filled-in fields (rejected: a blank can be applied).
- Apply dialogs A (two steps) and C (grid); property-page layouts B (side by
  side) and C (hover dot); voucher pickers A (all 13 chips) and C (dropdown).
- "Differs from landlord" as the orange label.
- Existing values counted as out of date (rejected: they are set on this
  property).
- Studio..6 limit on property sizes; Area on the forms; subzone on the flyer.

## Explicit NOs

- No rule-based matching on requirements; no blast filtering on No pets /
  No evictions (WP1 is AI ranking only).
- Credit and income are notes only (fair-housing question open).
- No backfill.

## Open questions / assumptions made on Cameron's behalf

- Planner calls marked in the spec as mine: server classifies copied vs set
  here by comparing with the landlord at write time; landlord change on a
  property empties the source records; Apply route with an `expected`
  compare-and-set and per-unit conditional writes; "Has its own value" row
  label; Select all; tag wording "On property flyers" on the landlord form;
  "One month's rent" disables the fixed amount; legacy `pets: true` reads as
  details "Allowed"; flyer three-size wording with a serial comma.
- Sam's feedback on the preview may change form layout; the subzone code
  source is a question for Sam.
