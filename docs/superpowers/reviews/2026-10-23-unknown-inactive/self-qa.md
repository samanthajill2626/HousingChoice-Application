# Live self-QA - feat/unknown-inactive (tracker #30)

- Driven by the build orchestrator, 2026-10-23 20:23-20:45 EDT, on a hermetic
  `npm run e2e:session` lane (lane 4: app :9401, dashboard :9411, fake-twilio
  :9421; `GET /__dev/ping` -> `{"dev":true,"lane":4,"appCommit":"e1fe060b"}` -
  code identical to the gated 798de475, the later commit being records only).
  Lean seed; every fixture made through the real inbound webhook (signed) or
  `POST /api/contacts`; the project Playwright MCP (bundled Chromium,
  isolated profile) logged in as the seeded VA. Lane stopped afterwards
  (`npm run e2e:stop`: launcher + children stopped, lane-4 tables dropped);
  no listener left on 9401/9411/9421/9431.
- Fixtures: three unknown contacts from inbound texts (B first, then A, then
  C, so A and C are newer than B; C renamed to a worst-case long name
  "Bartholomew-Alexandria Konstantinopoulos-Wetherington"), a partner P and a
  team member T, and two more unknown contacts D and E for the race checks.
- Screenshots: `W:\tmp\unknown-inactive\.playwright-mcp\qa-01..qa-15-*.png`
  (gitignored run state).

## What was proved, and how

1. Header dropdown, unknown contact (spec D2, D8). A's page: trigger
   "Contact status: Needs review"; menu "Contact status" items exactly
   [Needs review (checked), Inactive]. Picking Inactive sent, at the network
   boundary, `PATCH /api/contacts/<A>/tenant-status`
   `{"toStatus":"inactive","source":"manual","expectedType":"unknown"}` -> 200.
   The card heading went "Needs triage" -> "Type unknown" (Mark as buttons
   kept); the pill carries the muted tone class (`_toneMuted_`, color
   rgb(138,147,163) on rgb(241,243,246)).
2. Live drop on an already-open Today page (D2/D5, AR3 + AR8). A page-side
   sampler on the Today tab counted "New unknown contact" rows: 3 -> 2 at
   +416 ms after the click on the other tab; the window marker set before the
   click survived (no reload).
3. Inbox (D9, AR5-AR7). Unknown tab: B (Needs review, "Needs triage" chip)
   first, then the Inactive rows newest first (C, then A), each with the
   "Inactive" tag and no "Needs triage" chip. Geometry, measured on the
   Unknown and All tabs at 360, 768, 1024, 1280 and 1440 px: document and list
   horizontal overflow 0 at every width; the 59 px tag always inside its row
   and never overlapping the name; the long name truncates with at least
   104 px of it visible (same truncation the existing long group names use).
4. Contacts > Unknown (OR-1): B "Needs review" listed first, then C and A
   "Inactive" (plain-text labels, AR21).
5. Team member T (TenantFile page): header "Contact status: Active", options
   [Needs review, Active, Inactive]. Partner P: options [Needs review, Active,
   Inactive]; Inactive sent `expectedType: "partner"`; muted pill; timeline
   "Status -> Inactive" (partner label map, D4.5).
6. Edit contact details, Inactive partner (D3): Status displays Inactive,
   options exactly the header's; changing only Notes sent
   `PATCH /api/contacts/<P>` `{"notes":"..."}` (no status) and the stored
   status stayed `inactive`. Changing Status to Active in the form sent
   `PATCH .../tenant-status` `{"toStatus":"active","source":"manual",
   "expectedType":"partner"}`; stored `active` / `status_source: manual`; the
   timeline milestone "Status -> Active" appeared without a reload (OR-4).
7. Inbound to an Inactive contact (D9, W4). A second inbound to A with NO
   contact page open: A shows `unread 1` on All, Unread and Unknown (live on
   the open inbox page), Today's Needs you now still holds only B, and A's
   status is still `inactive`. (A first attempt with A's contact page still
   open in another tab came back read: an open contact page auto-reads a live
   inbound - known harness behavior, not a defect.)
8. Header 409 (AR4 + FW1-1), with `/api/events` blocked by a page route so no
   contact.updated could reach the page: D re-typed to partner via the API;
   the stale header still offered [Needs review, Inactive]; picking Inactive
   sent `expectedType: "unknown"` -> `409 {"error":"contact_type_changed"}`;
   the alert read "This contact's type just changed, so its status list did
   too. Pick the status again."; the page re-read (trigger "Contact status:
   Active", partner list); stored `partner/active` - never (partner, inactive).
9. Edit-form 409 (FW1-1, FW2-2, FW3-1), events still blocked: E's form
   opened on [needs_review, inactive]; E re-typed to tenant via the API; the
   form's Inactive save sent `expectedType: "unknown"` -> 409; the form showed
   its copy and turned Save off; the page re-read (header "Contact status:
   Onboarding"); the reopened form offered the tenant list with Onboarding
   selected and Save on; stored `tenant/onboarding` - never (tenant, inactive).
10. Contact page header geometry with the long-named Inactive contact at 360,
    768, 1024, 1280, 1440: no horizontal overflow, the trigger inside the
    viewport and never overlapping the name (the name wraps); at 360 the
    "Type unknown" card (behind the existing "Profile" toggle, as "Needs
    triage" is) is 271 px wide with every Mark as button in bounds.
11. Type change from Inactive (D7): C (Inactive unknown) -> "Mark as Tenant"
    sent `{"type":"tenant","role":""}`; stored `tenant/onboarding`; tenant
    options in the header; C's inbox row lost the Inactive tag; the timeline
    holds "Status -> Onboarding". B -> "Mark as Landlord": Interested, and the
    "Status -> Interested" milestone appeared live 619 ms after the click.
12. Console: only the two pre-login `401 /auth/me` lines and, during checks
    8-9, the deliberately aborted `/api/events` requests and the two expected
    409s. No script error.

## Findings

None. Nothing seen live contradicts the spec, the rulings, or the review
adjudications. The W8 residual (eventually consistent refetch) cannot be seen
on DynamoDB Local and stays a planner call.
