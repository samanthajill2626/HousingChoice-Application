# Self-QA (live, hermetic lane) - feat/last-heard-from

Date: 2026-10-13. Driven by the build orchestrator with the project Playwright MCP
(bundled Chromium, isolated profile) against `npm run e2e:session` lane 10 from
the worktree: `GET /__dev/ping` -> `{"dev":true, ..., "tablePrefix":"hc-local-10-",
"lane":10, "appCommit":"72c522f0"}` (fix wave 1 tip), `POST /auth/dev-login` 200.
Lean seed + run-unique fixtures created through the API (prefix `Q84105`):
tenants Alpha, Bravo, Charlie (consented, 2 BR) and Placed (`PATCH
/tenant-status` placed); property "Q84105 Typed Ave" (tour_type self_guided) and
"Q84105 Untyped St" (no tour type), both Available; listed sends planted through
`POST /__dev/listing-send-fixture` (Typed: Alpha -2d, Bravo -3h, Charlie -5d;
Untyped: Alpha -2d, Charlie -4d). Bravo then texted the business line through the
fake carrier.

Screenshots (this folder): `last-heard-from-<n>-<what>.png`.

## 1. Tenants tab (spec 5.7) - PASS
- Bravo's inbound text stamped `last_heard_from_at` live (GET contact read it back).
- Default (no `status` param): Placed and Inactive chips unpressed, the placed
  tenant hidden; `Sort by` = Last heard from. Order: Bravo "Today 5:58 PM", the
  lean tenant "Jun 1", then the never-heard tenants by last name (Reyes, then the
  Selfqa rows). (1-tenants.png)
- Search for the placed tenant -> "No matches for "Q84105Placed" among the
  statuses shown. Show all statuses"; the button lit all seven and showed the row.
- `Sort by` Name wrote `?sort=name`; a reload kept it; order Nguyen, Reyes, then
  Selfqa by first name.

## 2. Contact header (5.7, review A-1) - PASS (measured)
- Desktop 1440: "Voucher 2BR - Atlanta Housing Authority - Last heard from Jun 1".
- 360px: the "Last heard from Jun 1" span is whole - scrollWidth 114 = clientWidth
  114, its right edge (320) = the facts line's right edge; the facts text gives way
  ("Voucher 2BR - Atlanta Hou..."). (2-header-360.png)

## 3. Property "Sent to" card (5.4, 5.5, D14, R4) - PASS
- Typed property: Waiting group newest sent first (Bravo Replied, Alpha No reply
  yet, Charlie No reply yet). Charlie Not interested -> moved to the Not interested
  group with Undo; Alpha Interested (route mode) -> "Tour requested" link in the
  Interested group, in place. Aria names `Mark <name> interested in <short
  address>` etc. (3-sent-to-card.png)
- Tours page: Needs booking shows Alpha's new requested tour.
- Untyped property: Alpha Interested (form mode) navigated to
  `?tour=new&tenantId=<id>`; the Schedule a tour dialog opened with the tenant
  locked (the label resolves from the id to "Q84105Alpha Selfqa" a moment after
  open), the unit pre-committed, "Default - no tour info on the property" caption,
  no time; Cancel stripped both params and created nothing (listings-sent still
  `no_reply` for that pair). (4-form-mode.png)

## 4. Matching > Follow up + Properties pill (5.6) - PASS
- `/broadcasts?tab=follow-up`: tab "Follow up 2" aria-selected; ONE group
  "Q84105 Untyped St, Atlanta, GA 30314 - 2 waiting" (the Typed property has no
  waiting row: Bravo replied < 24h ago, Alpha Interested, Charlie Not interested);
  rows longest-waiting first: Charlie "No reply yet, 4 days", Alpha "No reply yet,
  2 days". (5-follow-up.png)
- Properties list: "2 waiting" pill inside the Untyped row link only.
  (6-properties-pill.png)
- `Text Q84105Charlie Selfqa` opened `/conversations/<id>`.
- Charlie replied through the fake carrier; on reload the group read "1 waiting"
  (Alpha only) and the tab "Follow up 1".
- 360px: the six tabs wrap to two lines (All..Sent / Failed, Follow up 1), no
  horizontal page overflow; rows stack. (7-follow-up-360.png)

## 5. Matching Review recipients (5.3, 5.8 C6) - PASS
- Desktop: header Name / Status / Housing authority / Last heard from above the
  list; rows ordered by last heard from (Charlie Today 5:59 PM, Bravo 5:58 PM,
  Tasha Jun 1, Alpha Never, Placed Never); Charlie (declined on this property)
  UNCHECKED with "Not interested", aria name "Q84105Charlie Selfqa - not
  interested"; "Send to 4 recipients". (8-review-desktop.png)
- Observed, by design (spec non-goal #6): the placed tenant is in the filter
  audience and checked; the new Status column now shows "Placed".
- Add a tenant: options carry the annotate suffix ("Q84105Charlie Selfqa Tenant
  Not interested"). (9-add-tenant-annotate.png)
- 420px: header hidden, each row stacks (name+phone / status + last heard / tag),
  no horizontal overflow. (10-review-420.png)
- C6 at a 560px-tall viewport with the input near the bottom: the list opened
  ABOVE the input (list 334-486, input top 490) and inside the viewport.
  (11-c6-opens-above.png)

## 6. Activity and timelines (5.4 audit) - PASS
- Property Activity: "Q84105Alpha Selfqa interested - tour requested",
  "Q84105Charlie Selfqa not interested". (12-property-activity.png)
- Alpha's Properties sent card mirrors the property card (Typed: Tour requested;
  Untyped: No reply yet + actions, aria names with the property's address).
  (13-tenant-properties-sent.png)
- Timelines: Alpha "Interested in Q84105 Typed Ave, Atlanta, GA 30314 - tour
  requested"; Charlie "Not interested in Q84105 Typed Ave, Atlanta, GA 30314";
  Charlie's header "Last heard from Today 5:59 PM".

Console: one 404 for /favicon.ico (pre-existing, unrelated); no app errors.
Note: fixture tenants were created with a housingAuthority body field the create
route does not persist (setup detail, not a defect of this feature).

## Re-QA on the final code (after review fix waves 2 and 3) - PASS

Lane 10 restarted from the worktree; `GET /__dev/ping` appCommit `d902b515`
(code identical to the final tip). Fresh fixtures (prefix `R80422`): tenants
Dana, Eli, Fay; property "R80422 Review Rd" (tour_type landlord_led); planted
sends (Dana -3d, Eli -2d, Fay -2d).

- Undo: Dana Not interested -> Undo (UI) -> GET recipients `no_reply`.
- Durable supersession (spec 14.7) through the TOURS-PAGE path: Dana Not
  interested (`not_interested`) -> `POST /api/tours` 201 (`interested`) ->
  `PATCH /api/tours/:id {status:'canceled'}` 200 -> `no_reply` (the decline
  stays superseded; before 14.7 this path read `not_interested`).
- Stale route mode (review B R2-5): property page loaded in route mode, then the
  unit's tour_type cleared through the API; Eli Interested -> the 409
  `tour_type_required` fell through to the form: URL
  `?tour=new&tenantId=<Eli>`, the Schedule a tour dialog open, no error alert.
- Follow up actions resolve from the RETURNED row (review B R2-4): Fay Not
  interested -> chip "Not interested" + Undo in place; Eli Interested (route
  mode) -> the "Tour requested" link in place; group "R80422 Review Rd, Atlanta,
  GA 30314 - 1 waiting", tab "Follow up 1"; Dana (whose superseding tour was
  canceled) is back on the list, "No reply yet, 3 days".
  (14-reqa-follow-up-actions.png)

Console: only SSE `/api/events` reconnect errors from a page left open across
the earlier lane stop (environmental).
