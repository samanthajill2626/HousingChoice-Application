# Design review R1 - reviewer B (adversarial)

Spec: `docs/superpowers/specs/2026-10-27-permanent-flyer-links-design.md` (rev 1).
Repo read at `W:\tmp\permanent-flyer-links` (main @d0e2c2d8). Read-only review.

The spec's section 2 ("Today") checks out against the code I read: SHAREABLE at
`app/src/lib/statusModel.ts:289`, the re-export at `app/src/repos/unitsRepo.ts:64`,
the flyer gate at `app/src/routes/public.ts:845`, `sendNotFound` at
`public.ts:453-455`, `viaFlyer` at `public.ts:507-518`, the pin label at
`public.ts:197-211`, the repeat-check source at `public.ts:690`, the ledger branch
at `public.ts:762-777`, the broadcast guard at `app/src/routes/broadcasts.ts:1187-1193`,
the property page at `dashboard/src/routes/listing/ListingDetail.tsx:418` and
`:937-958`, the composer filter at `BroadcastComposer.tsx:376`, and the unguarded
`/unit-media` route (`app/src/routes/unitMediaServe.ts:39-70`, no status read).
CloudFront does not cache `/public/*` (`infra/modules/cloudfront/main.tf:157-168`,
caching_disabled), so no edge-cached 404 outlives the deploy.

The problems are in what the spec does NOT enumerate.

---

## 1. [HIGH] Broadcast copy and the send guard's stated reason become false; D8 says "unchanged"

**What is wrong.** Every broadcast surface tells staff that a non-Available
property's flyer link is DEAD. After D1/D2 that is false for five of the six
non-Available statuses. D8 lists "the make-available dialog" as unchanged, and
the intent record says "Do not change the broadcast send guard or composer", so
a builder following the spec will ship staff-facing copy that says the opposite
of what the system now does.

**Evidence.**
- `dashboard/src/routes/broadcasts/BroadcastComposer.tsx:540-549`: comment "a
  non-Available property's flyer link is dead (public.ts serves only
  'available')" and the banner "This property is <status>, so its flyer link
  won't work. You'll be asked to make it Available when you send."
- `dashboard/src/routes/broadcasts/RecipientPreview.tsx:757-760`: the Make
  Available dialog body "The flyer link in this send only works while the
  property is Available."
- `RecipientPreview.tsx:419`: the `unit_not_available` error "This property
  isn't Available, so its flyer link won't work."
- `RecipientPreview.tsx:87-89`, `:375-377`: props/pre-flight comments with the
  same reason.
- `app/src/routes/broadcasts.ts:1181-1186`: the guard's own justification: "the
  flyer link stamped into every recipient's message only resolves while the
  unit is SHAREABLE (only 'available' - the same gate public.ts serves) ...
  (the link is equally dead)".
- Tests pinned to the copy/reason: `BroadcastComposer.test.tsx:576-592`,
  `:1764`; `e2e/tests/dashboard-next/broadcasts.spec.ts:278-283`;
  `app/test/broadcastApi.test.ts:2162` ("flyer link would be dead").

**What it implies.** The spec rewords the SHAREABLE doc comment (D1) but gives
the guard no new REASON and leaves the user-visible copy untouched. Either the
spec decides the copy changes (and states the new reason the guard exists, e.g.
"broadcasts only advertise homes that are Available"), which touches the
composer that the intent says not to change - a conflict for Cameron to rule
on - or it consciously ships copy that is wrong. It cannot silently be both
"unchanged" and true. Setup is the only status for which the existing copy
stays accurate.

---

## 2. [MEDIUM] The spec widens the open public-signup abuse surface and says "follows unchanged"

**What is wrong.** D5 says everything `viaFlyer` drives "follows unchanged".
The mechanism is unchanged; its REACH is not. The open issue
`docs/issues/public-signup-abuse-hardening.md` bounds an anonymous caller's
power by the set of SHAREABLE unitIds. D1 replaces that set with every
non-setup unit, and every historical flyer link becomes permanently live.

**Evidence.**
- Pin source: `public.ts:690` `sourceRefId = viaFlyer ? unitId : undefined`.
  Today every non-shareable id collapses into ONE shared "no property" source
  (`public.ts:676-681` comment). After D5 each under_application / finalizing /
  occupied / on_hold / off_market unitId is its own 24-hour pin-and-bump source.
- Ledger rewrite: `public.ts:760-777` and the issue's item (c)
  (`public-signup-abuse-hardening.md:126-131`): each sign-up moves the pair's
  `sentAt`, flips Replied / No reply yet to Signed up and files it under
  Interested; "No writer removes a share entry".
- The issue's multiplier (d) (`:132-134`): "multiply (a) and (b) by every
  shareable unitId it knows - ... unitIds ride every Matching text's flyer
  link". Old Matching/broadcast texts carry the unitIds of homes that have since
  been placed; today those links are dead, after this change they are live
  attribution targets forever.
- The roster job's 250-event removal-scan cap (`:205-213`, "It needs many
  shareable unitIds") gets easier to hit for the same reason.

**What it implies.** Not a reason to drop the feature, but the spec must say it
widens the issue's surface and the issue file must be updated in the same change
(AGENTS.md: issues live in-repo; the issue's numbers become wrong on merge).

---

## 3. [MEDIUM] Goal 2 is not delivered: the flyer still links to the external listing

**What is wrong.** Goal 2: "No public page says a home is 'no longer
available', taken or removed." D2: "Nothing else in the payload changes." The
payload carries `listing_link` (`app/src/lib/unitFields.ts:500`), and the flyer
renders it as "Listing - See the full listing" (`FlyerPage.tsx:398-406`). For a
placed or off-market home that external listing (affordablehousing.com, a
rental site) is exactly the page most likely to say "no longer available" or
"off market" - the wording Sam asked visitors not to see, one tap from our
flyer.

**What it implies.** The guarantee is a slogan for our own pages only. The spec
should either scope Goal 2 to "no page we serve" and accept the external link,
or decide to omit `listing_link` (and possibly `video_url`) when the status is
not `available`. Either is a product call; the spec currently claims a result
its mechanism does not produce.

---

## 4. [MEDIUM] Off market is made public forever with no rationale and no off switch

**What is wrong.** The spec's provenance (header, lines 12-14) is Cameron
accepting that an OCCUPIED home stays public. D1 makes `off_market` public too
- the terminal status for a property that has left the book
(`documentation/STATUS-MODEL.md:303-313`, "terminal: Off market") - with no
sentence on why. And the spec leaves exactly two ways to turn a flyer off:
Setup and soft-delete.

**Evidence.**
- D1 excludes only setup; its only stated rationale is about setup.
- Moving a live property back to Setup to kill its flyer misuses a baseline
  status: baseline progression states stay derivation-eligible
  (`statusModel.ts:321-331` comment), so a later derived write can move it out
  of Setup and re-publish the flyer. Off market, by contrast, is an override
  state that pins (`LISTING_OVERRIDE_STATES`, `statusModel.ts:334-337`).
- Soft-delete removes the property from the dashboard to stop an
  advertisement.

**What it implies.** A landlord who withdraws a home (off_market) keeps having
its address and photos advertised with a "Same-day tours available" line
(`FlyerPage.tsx:336`) and a sign-up form, and staff have no clean way to stop
it. The spec should either state that this was decided (with the
landlord-withdrawal case named) or exclude `off_market` from FLYER_PUBLIC. As
written, a builder cannot tell whether off_market was a deliberate choice or an
"all minus setup" shortcut.

---

## 5. [MEDIUM] e2e/tests/dashboard-next/environment-identity.spec.ts is a broken reader the spec never names

**What is wrong.** Section 5 lists the e2e specs to change (public-pages,
listing-photos). It misses a third that asserts the removed heading.

**Evidence.** `e2e/tests/dashboard-next/environment-identity.spec.ts:26,40-45`
visits `/p/missing-unit` and asserts
`getByRole('heading', { name: /no longer available/i })`. D4 removes that
heading. Dashboard unit tests pinned to it too: `FlyerPage.test.tsx:330`,
`:347` (the UNAVAILABLE_PREFILL string), `:664`.

**What it implies.** Gate 4 fails on a spec the plan never scheduled. Name it
in section 5 (assert the new fallback heading instead).

---

## 6. [MEDIUM] The new Properties-sent rows on placed homes show no status and offer "Interested", which books a tour on an occupied home

**What is wrong.** Goal 3 says staff "can see the home's status in the lead's
pin". The pin is one reader. D5 also writes a properties-sent `flyer` entry,
and that entry has more prominent readers that show NO status and carry
actions.

**Evidence.**
- Contact card row: `dashboard/src/routes/contact/Card.tsx:351-357` - a
  `signed_up` row reads "Signed up from the flyer <date>", chip "Signed up"
  (`:274-276`), and is `actionable`, offering Interested / Request a tour / Not
  interested. No property status is rendered.
- The Interested action: `app/src/routes/units.ts:1574-1664` checks only
  missing/deleted, then `tours.create({ ..., status: 'requested' })` - no
  listing-status check.
- Property page: `dashboard/src/routes/listing/listingFormat.ts:353` files an
  eligible `signed_up` row under Interested, so an Occupied property's Sent to
  card gains "interested" leads.

**What it implies.** Before this change a `signed_up` row could only be born on
an Available home. After it, the spec manufactures rows on placed homes whose
primary action requests a tour of an occupied home. The spec should say whether
that is acceptable or whether the row/action needs the status (a non-goal entry
would do if it is accepted). It is not covered by "credited exactly like an
Available flyer" - the Available case never put this action on an occupied home.

---

## 7. [MEDIUM] The e2e sign-up test is unspecified and the obvious fixture is shared seed state

**What is wrong.** Section 5: "One e2e sign-up from a non-available flyer
asserts the '(...)' pin label". It does not say which property. The two
obvious candidates are the seeded lean units, which section 5 itself reuses.

**Evidence.**
- Lean world: `unit-0001` under_application, `unit-0002` occupied
  (`e2e/tests/dashboard-next/flyer-leads.spec.ts:30-34`, which explains specs
  must not sign up against seeded records because a pin, a sent-list row and an
  unread thread leak to other specs).
- `e2e/tests/dashboard-next/listing-activity.spec.ts:9-15` targets
  `unit-0002` directly.
- After this change a sign-up on unit-0001/0002 writes a ledger row
  (`public.ts:770`) that lands on the property's Sent to card.

**What it implies.** The spec should require a run-unique property flipped off
Available through `PATCH /api/units/:id/listing-status` and a run-unique phone,
as `flyer-leads.spec.ts` does. The read-only assertion that unit-0001 serves
the full flyer is fine.

---

## 8. [MEDIUM] The docs/comment enumeration (section 4) is incomplete; GLOSSARY is mandatory

**What is wrong.** AGENTS.md: "Update [GLOSSARY.md] in the same change
whenever you ... fix drift." Section 4 does not list it, and it states the old
rule twice. Several other readers of the rule are also missing.

**Evidence (old rule, not in section 4).**
- `documentation/GLOSSARY.md:657-665` ("written only for a shareable
  property"), `:668-673` (the pin forms, "the property is not shareable"),
  `:73` ("The shareable flyer").
- `e2e/support/selectors.md:54` - the canonical pin-label selector doc;
  it needs the "(<Status>)" form and "not shareable" reworded.
- `app/src/repos/unitsRepo.ts:55-63` ("also gates the public flyer", "only
  publicly shareable status", "Statuses whose unit may be exposed by the public
  flyer endpoint (only available)") - D1 rewords only the statusModel comment.
- `app/src/repos/activityEventsRepo.ts:74`; `dashboard/src/api/types.ts:3048-3049`.
- `dashboard/src/routes/public/publicApi.ts:6` ("maps that to a friendly 'no
  longer available'"), `:66`.
- `dashboard/src/routes/listing/ListingDetail.tsx:82-83`, `:416-417`, `:937-938`;
  `dashboard/src/ui/StatusBadge.tsx:46`.
- `app/src/routes/units.ts:982-983`; `app/src/lib/import/apply.ts:1622`.
- `app/src/routes/public.ts:31`, `:38-39`, `:150`, `:218`, `:278`, `:306`,
  `:450-452` (the 404 comment says the body exists so "the public page's
  'unavailable' state" can offer text-us).
- `e2e/scenarios/steps.ts:1033`.
- `docs/issues/public-signup-abuse-hardening.md` (see finding 2).
- The broadcast comments in finding 1.

**What it implies.** Each is a reader that will state the old rule after merge.
GLOSSARY and selectors.md are the two a later agent will trust; they must be in
the change list.

---

## 9. [LOW] Existing app tests prove "not public" with a status that does not exist

**What is wrong.** Many current tests model "not shareable" with
`status: 'placed'`, which is not a listing status (`statusModel.ts:261-269`).
Against an explicit FLYER_PUBLIC list they keep passing unchanged, so they give
false assurance that the setup boundary is tested.

**Evidence.** `app/test/publicIntake.test.ts:503-518`, `:571-590`, `:1184-1190`;
`app/test/publicSignupLeads.test.ts:282-287`, `:855-858`, `:1040`. By contrast
`publicIntake.test.ts:650-675` (`on_hold` must 404) WILL fail, as intended.

**What it implies.** Section 5 should say to convert the `placed` fixtures to
`setup` (the real boundary) so the no-property path is pinned by a value the
system can hold.

---

## 10. [LOW] D4's justification does not cover the "any other fetch failure" case

**What is wrong.** D4 sends the route's unitId from the fallback form "the
server already treats a non-public unit as a flyer sign-up with no property".
But the fallback also renders on a 5xx, a network error or a 429
(`FlyerPage.tsx:239-244` catches everything). For a PUBLIC unit whose fetch
failed transiently, the server credits the sign-up in full (`viaFlyer` true,
pin names the address, ledger entry written) even though the visitor never
saw the home and was told "We'll text you about homes that fit your voucher".

**What it implies.** Probably acceptable, but the spec should say so; as written
its stated reasoning is wrong for that path.

---

## 11. [LOW] Under-specified copy and precedence

- D4 text variant without `contact_number`: "the existing 'Reply to the text we
  sent you' line with 'homes' wording". The existing line is "Interested in
  similar homes? Reply to the text we sent you ..." (`FlyerPage.tsx:277-280`);
  "similar" implies the original is gone. Give the exact string.
- D7: no precedence when a property is BOTH deleted and in Setup. Also note
  `deleted` is computed at `ListingDetail.tsx:435`, after `flyerShareable`
  (`:418`); the builder must reorder.

---

## 12. [LOW] The dashboard FLYER_PUBLIC mirror has no parity guard

D7 adds a hand-copied mirror in `dashboard/src/api/types.ts` beside SHAREABLE
(`:935-936`). Nothing tests that the dashboard and server sets agree (grep finds
no test referencing SHAREABLE in either workspace). A future status added on one
side only makes the property page offer "View flyer" for a link that 404s, or
hide it for a live one. A one-line parity test closes it.

---

## 13. [LOW] Address-derived unitIds turn the flyer into an address test for occupied homes (UNVERIFIED exposure)

Imported properties get `unitId = uuidv5('unit:' + normalizedAddress)` under a
constant namespace in source (`app/src/lib/import/ids.ts:24`, `:84-86`;
`app/src/lib/import/apply.ts:1483`). Anyone holding the namespace can compute a
candidate unitId for any address and learn from a 200 whether it is in the book.
Today that answers only for Available homes; after D1 it also answers for
occupied homes, i.e. addresses where a voucher household lives now. UNVERIFIED:
whether the repository (and so the namespace) is ever exposed. If it is not,
this is moot; the spec's "no existence oracle" claim should still be scoped to
"no oracle beyond knowing the id".
