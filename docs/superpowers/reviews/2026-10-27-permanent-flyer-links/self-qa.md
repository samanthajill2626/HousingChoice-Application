# Live self-QA - permanent flyer links

Orchestrator, 2026-10-28 03:10-03:13Z, hermetic `npm run e2e:session` lane 11
(dashboard http://127.0.0.1:10111, lean seed) at branch commit 9accca8a (code
= 49d9fd24, main 71fb9b45 merged). Driven with the project Playwright MCP
(`browser_run_code_unsafe`), measured with DOM reads, not eyeballed. Public
pages were opened in FRESH browser contexts (no session cookie). Screenshots:
`W:\tmp\permanent-flyer-links\.playwright-mcp\qa-*.png` (gitignored). Lane
stopped afterwards (`npm run e2e:stop` exit 0; no listener on 10101/10111/
10121/10131).

Fixtures (staff API, run stamp 016834): A available; B available -> photo
uploaded through the property page -> Occupied; C setup; D available ->
deleted; E available -> Under application with a worst-case long address
("016834 Northwest Martin Luther King Junior Drive Southwest Building C,
Unincorporated South Fulton").

## Results

| # | Scenario | Measured | Verdict |
|---|---|---|---|
| 1 | Occupied flyer B, form variant, 375 and 1280 | h1 = street line; `Home photo 1` loaded (naturalWidth > 0); h2 `Sign up for home alerts`; detail terms exactly Application fee / Tenant pays / Washer / dryer / Same-day RTA / Video tour (no Listing); no "See the full listing" link; retired words 0; horizontal overflow 0 at both widths | PASS (D2, D3, D3a) |
| 2 | Occupied flyer B, ?cta=text, 375 and 1280 | h2 `Interested in this home?`; sms href `sms:+15550009999?&body=I'm%20interested%20in%20<line1>%2C%20Atlanta`; overflow 0 | PASS (D3: the variant's CTA unchanged) |
| 3 | Flyer API A vs B | A `listing_link` = stored URL; B `listing_link` null; IDENTICAL key sets (no `status` key) | PASS (D2, D3a) |
| 4 | Available flyer A | "See the full listing" present (positive control) | PASS |
| 5 | Fallback: bogus id (both variants, 375 + 1280), Setup C and deleted D (form 375 + 1280, text 1280) | h1 `Find a home that fits your voucher`; form: the D4 line + IntakeForm + `Sign up`; text: `I'm looking for a home - text us` -> `sms:+15550009999?&body=I'm%20looking%20for%20a%20home%20that%20fits%20my%20voucher.`; no "no longer available" / taken / removed; no status or "setup"/"deleted" word; overflow 0; API body byte-identical for all three (`{"error":"not_found","contact_number":"+15550009999"}`) | PASS (D2, D4) |
| 6 | Sign-up FROM the fallback (bogus id, 375) | POST carries `unitId: <route id>`; h2 `Thanks - you're all set!` gets focus, h1 stays, `We'll text you about homes that fit your voucher.`; contact = tenant, `needs_review`, `capture_source: housing_fair`, no unit_of_interest, no housing authority | PASS (D4/D5); see note N2 |
| 7 | Sign-up from Occupied B and Under application E (new contacts) | both `capture_source: flyer`, `unit_of_interest` = the unit | PASS (D5) |
| 8 | Contact-page pins at 375 / 1024 / 1280 / 1440 | labels `Signed up from the flyer for 016834 Selfqa Occupied Way, Atlanta, GA 30314 (Occupied) as Occupiedqa Lead` and the worst case `... South Fulton, GA 30314 (Under application) as Maximiliana-Josephine Featherstonehaugh-Worthington`; the pin wraps (up to 114 px tall at 375) inside the timeline region; region and document overflow 0; Send stays in view at every width | PASS (D6; flyer-leads wrap fix holds) |
| 9 | Property page flyer line | A, B (Occupied), E (Under application): View flyer + Copy public link; C: `The public flyer goes live once this property leaves Setup.`; D: `The public flyer is off while this property is deleted.` | PASS (D7) |
| 10 | Occupied B's Sent to card and the contact's Properties sent row | row "Signed up from the flyer Today 11:11 PM - Last heard from Never", chip Signed up, buttons Interested / Not interested (qa-07, qa-08) | AS SPECIFIED (D9) - see N3 |
| 11 | Composer for Occupied B (/broadcasts/new?unitId=) | `This property is Occupied. Only Available properties can be sent - you'll be asked to make it Available when you send.` | PASS (D8) |
| 12 | A 500 on the flyer API (page.route), ?cta=text | the fallback with the no-number line `Looking for a home? Reply to the text we sent you and we'll help you find one.` | PASS (D4: any failure, same page) |
| 13 | Seeded unit-0001 flyer | served; h1 `Home for rent` (the lean seed stores a string address, which the projection drops), h2 `Sign up for home alerts` | PASS (served); see N1 |

## Notes (no defect found; for the handback)

- N1 (A-1 context): a served non-Available flyer is word-for-word the
  Available flyer minus the Listing row, as spec D3 decided - "Same-day tours
  available", the Same-day RTA row reading "Available", "We'll text you about
  this home and others". "Home for rent" appears only for an addressless unit;
  imported units store a parsed address, so in prod it is rare.
- N2 (A-4 context): fallback leads carry no housing authority and start in
  Needs review (the spec's recorded assumption: the fallback sends the route
  unitId rather than becoming a /join-style sign-up).
- N3 (R4-10): on an Occupied property the sign-up row offers Interested /
  Not interested exactly as on an Available one; nothing is created by the
  sign-up itself (no tour, no follow-up).
- N4: after a fallback sign-up the h1 and the thank-you h2 render at the same
  size (both `styles.title`, the class every flyer heading but the address
  uses) - consistent with the served flyer; no change.
