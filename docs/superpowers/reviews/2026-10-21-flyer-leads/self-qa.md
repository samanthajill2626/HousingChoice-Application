# Self-QA - feat/flyer-leads (orchestrator, live lane)

Run 1: 2026-10-21 21:13-21:27 EDT on HEAD b7b47ff2 (after code review round 1
and fix wave 1). Hermetic `npm run e2e:session` lane 12 (dashboard :10211,
app :10201, fake-twilio :10221), child logs captured, driven with the project
Playwright MCP and API fixtures through the dashboard origin. Never the live
stack. Fixtures (run-unique, real routes): landlord L1 (no thread); property U1
AVAILABLE with a worst-case address (line1 "4821 Martin Luther King Jr Drive
Southwest Building C <stamp>", line2 "Apartment 1204"), an area, application fee
0, every public detail and every Staff only field (rent 1725-1800, deposit,
pets, pet fee, accessibility, lease terms), subzone `se11`; property U2
AVAILABLE, subzone typed " SE 11 "; tenant T1 with an inbound text; tenant T2
sent U1 two days earlier; an UNKNOWN contact K auto-captured by an inbound.
Screenshots: `W:\tmp\flyer-leads\.playwright-mcp\qa-*.png` (gitignored run
state).

## Verified (measured, not eyeballed)

- Flyer page U1 at 1280: h1 = street line "line1, line2" (24px/700) inside a
  Maps link (`target=_blank`, `rel=noreferrer`, href = all parts ", "-joined),
  city line "Atlanta, GA 30314" at 15px, sr-only " - open in Google Maps"
  (clipped, absolute), area line under it; "Same-day tours available" (600,
  tinted); facts "3 beds", "2 baths", "Fits a 3-bedroom voucher";
  "Accepts: Atlanta Housing Authority" 18px/700 in the body text colour (body
  15px); detail rows exactly Application fee ("No application fee"), Tenant
  pays, Washer / dryer, Same-day RTA, Video tour, Listing; none of "A home for
  you", Rent, Deposit, Pets, Pet fee, Accessibility, Lease or any of the
  staff-only values anywhere in the page text; sign-up box "Sign up for home
  alerts", the D3 text, button "Sign up". No console error.
- 320px and 375px (content width 305 / 360 with a scrollbar): the h1 wraps to
  5 / 4 lines, document and card scrollWidth == clientWidth, no element past
  the card edge. /join at 320: unchanged page, no overflow.
- Existing tenant T1 through the REAL visitor form (fresh context, no session)
  while staff had /inbox open: thank-you "Thanks - you're all set!" + "We'll
  text you about this home and others that fit your voucher."; the open inbox
  row turned "1 unread" LIVE in 782 ms with a window marker intact (no reload),
  on top, preview still T1's own inbound; fake-twilio holds no outbound to T1.
- Today (live `/api/today`): T1 under `unreplied`, "Qaexist... Tenantone -
  Unreplied" (OR-18).
- T1's contact page: a GREEN pin "Signed up from the flyer for <formatAddress>
  as Typed Visitor" linking to `/listings/<U1>`; the Properties sent row reads
  "Signed up from the flyer Today 9:15 PM - Last heard from Today 9:14 PM",
  chip "Signed up", actions Interested / Not interested; wire outcome
  `signed_up`, broadcastId absent.
- Decline holds (spec D7): T2's U1 row declined through the outcome route, then
  T2 signed up from U1's flyer: outcome stays `not_interested`, pin and unread
  recorded, no text, the INFO line "share ledger: flyer entry not written - the
  pair holds a current decline" logged once, audit sentSkipped `declined`.
- Repeat within 24 hours (T1, same property): still one pin, no bump (unread 0
  after a read), sentAt moved, outcome `signed_up`; audit `recorded: false`.
- Unknown contact K on U1's flyer: pin + unread 1, contact unchanged (type
  unknown, no name), no text; on U1's Sent to card it is labelled
  "(555) 621-6904" with kind Unknown (AR13), filed under Interested with Not
  interested only.
- New contact on U1's flyer: tenant, needs_review, capture_source flyer,
  unit_of_interest U1; the welcome text sent; then the pin, unread 1 and outcome
  `signed_up`.
- Existing landlord L1 through the /join visitor form: pin "Signed up on the
  join page as Joiner Landlordtyped" (no ref), inbox row unread with a blank
  preview (a new thread with no message - OR-18), the contact byte-identical
  before and after, no text.
- U1's Sent to card: Interested = the new contact, K and T1 (all Signed up);
  Not interested = T2 ("Sent Oct 19", Undo). The property page still shows
  every Staff only value.
- Edit property: Rent min / max, Accessibility, Lease terms, every Pets and
  Deposit field tagged Staff only; Application fee and No application fee On
  flyer; "Tenants see this on the public flyer." only under Tenant-paid
  utilities.
- Similar properties: U1 (`se11`) lists U2 (stored `SE 11`) as "3 bed - Same
  subzone - Accepts Atlanta Housing Authority" (D9).
- App log: no ERROR line; six "housing-fair signup captured" lines with
  honest flags; no name or phone in any line.

## Findings

### QA-1 (HIGH, fixed in fix wave QA - see below) A long milestone pin widens the contact page's comms pane under the right column and covers the Send button

Measured on T1's contact page (the signed_up pin is 140 characters):

| viewport | pane width | comms width | overflow | Send covered |
|---|---|---|---|---|
| 1024 | 443 | 831 | 387 px | (no Send at this width) |
| 1280 | 593 | 831 | 238 px | yes (`elementFromPoint` hits the Tours card) |
| 1440 | 686 | 831 | 145 px | yes |
| 1920 | 966 | 966 | 0 | no |

Root cause (pre-existing CSS): the comms `<section>` (`.comms`,
`dashboard/src/routes/contact/Timeline.module.css`) is a `flex: 1` item of the
two-pane shell's `.left` ROW flex container with the default `min-width:
auto`, so the nowrap pill's min-content width sets its minimum; the pill
(`.pill`, a flex item of `.evt`) has the same default, so `.pillText`'s
`overflow: hidden; text-overflow: ellipsis` never engages. The pane spills
under `.right`, which paints over it - including the reply box's Send button.
PRE-EXISTING for any long pin: T2's "Not interested in <address>" pin (112
characters) widens the pane to 686 px (pane 593). This branch makes it
routine - every sign-up writes a pin carrying the full address and a typed
name (up to 2 x 100 characters, typed by anyone).

Probe (page-side style only, no source edit): `section[class*=_comms_]{min-width:0}`
plus `.pill{min-width:0;max-width:100%}` -> comms == pane at 1024 / 1280 /
1440, Send uncovered, the pill text ellipsized (client 518 < scroll 756 at
1280), no horizontal scroll in the stream.

## QA-1 follow-through (fix waves FW-QA, FW2, FW3)

- FW-QA (a150db6b) stopped the pane from widening (Send uncovered) by letting
  the pin shrink with an ellipsis; code review round 2 (F1) showed the
  ellipsis cut the END of the label - the typed name - at every common width.
- FW2 (41b6f83a) made pins WRAP inside the pane; FW3 (c0b6b501) contained a
  pin's ink (`overflow: hidden`, no height cap) and made its radius scale
  with its font; FW3 (88a686f5) hardened the checks (three CSS mutants RED).
- Orchestrator review of the final rendering
  (`.playwright-mcp\fw2-pins-final-1280.png`, `fw2-pins-final-375.png`,
  `fw3-pins-1280.png`, `fw3-pins-360.png`): the long sign-up pin wraps to 2
  lines at 1280 and 4 at 360 inside the pane with the typed name visible; a
  short pin stays one line with round ends; Send is visible at both widths.
- Pinned in e2e (flyer-leads.spec.ts, existing-tenant test): the comms
  region stays inside its column, Send is not covered, and the label's box
  lies inside the pin on all four sides with no sideways scroll - green in
  the final gate battery (371 passed) on 692c44a4. QA-1 CLOSED.
