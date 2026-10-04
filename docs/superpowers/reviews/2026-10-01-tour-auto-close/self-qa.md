# Live self-QA - tour auto-close and reopen (feat/tour-auto-close)

- Date: 2026-10-04 16:13-16:30 local. Driver: the build orchestrator, by hand,
  on a hermetic `npm run e2e:session` lane (lane 7, dashboard
  http://127.0.0.1:9711, lean seed, REAL worker beside the app) through the
  project Playwright MCP (bundled Chromium). HEAD c084f943 (pre-sync).
- Method: fixtures through the API (`.superpowers/sdd/qa-setup.mjs`, run log
  `qa-setup.log`), every check MEASURED from the DOM through
  `browser_run_code_unsafe` (accessible names, hrefs, counts, innerText) -
  not eyeballed; screenshots are evidence of layout only, saved under
  `W:\tmp\tour-auto-close\.playwright-mcp\qa-01..qa-16*.png` (gitignored).
- Every dev tick passed `tourIds`. Nothing was sent all session: the fake
  Twilio thread store read `{"threads":[]}` at the end (`GET
  <fake>/control/threads`), which is stronger than the per-party read the e2e
  makes - the lane recorded no outbound message at all.

## 1. Fixtures (tenant contact-tenant-0001 Tasha Nguyen; units unit-0001 / unit-0002, both landlord contact-landlord-0001)

| tour | setup | after the scoped ticks |
|---|---|---|
| T1 | unit-0001, dated 20 days ago | tick at the REAL now: `scanned 1, due 0, closed 0` (created today - the clock starts at creation); tick at now+15d: closed, `no_outcome`, `autoClosedFrom scheduled`, `autoClosedAt 2026-10-04T20:15:29.472Z` |
| T2 | unit-0002, 20 days ago, PATCH toured | closed from `toured`, `lastMarkedAt` = the PATCH instant |
| T3 | unit-0001, 19 days ago, PATCH no_show | closed from `no_show` |
| T4 | unit-0002, 3 days ago, toured, `{ outcome not_a_fit, moveForward false, status closed }` | a person's not-a-fit close |
| T5 | unit-0001, 4 days ago, toured, `{ outcome move_forward, moveForward true }`, `{ status closed }` | closed + convertible + move_forward (API-only state; spec 9.2's kebab case) |
| T6 | unit-0002, 5 days ago, toured | the stale-dialog 409 case (ticked later) |
| T7 | unit-0001, 18 days ago | the live-update case (ticked later) |
| T8 | unit-0002, 2 days ago, PATCH no_show | Today's no-show row |

The +15d tick summary: `{"scanned":3,"due":3,"closed":3,"lost":0,"failed":0}`;
the app log carries one `tour closed automatically (no outcome after two
weeks)` line per tour with `tourId` and `from`, then one `tour auto-close
run` line (`.superpowers/sdd/child-logs/app.log`).

## 2. Checks (spec clause -> measured)

| # | spec | measured | screenshot |
|---|---|---|---|
| 1 | 9.4 Today lists no-shows; link rule | list "Past tours needing an outcome" = 3 links, most recent first: T8 `..., No show` -> `/tours/<T8>` (no `?outcome=1`), T6 `..., Needs outcome` -> `/tours/<T6>?outcome=1`, T7 `..., Not marked`; footer "Open the Past tab" (3 of 3); "all caught up" count 0 | qa-01 |
| 2 | 9.3 Closed tab badge + intro | intro byte-exact "Tours that ended - converted into a placement, closed as not a fit, closed automatically with no outcome, or canceled."; 5 rows newest first: T3, T2, T1 each `Closed No outcome recorded Self-guided`, T5 `Closed Move forward`, T4 `Closed Not a fit` | qa-02 |
| 3 | 9.2 Outcome card for `no_outcome`; one Reopen control | T1 page: Outcome card "Outcome No outcome recorded Closed automatically on Oct 4"; "Moving forward" count 0; `button` "Reopen tour" count 1; `button` "More actions" count 0; Activity card "Closed automatically: no outcome recorded after two weeks" | qa-03 |
| 4 | 9.2 reopen into scheduled | dialog "Reopen tour" text: "This tour goes back to Not marked so you can mark it toured or a no-show, or reschedule it. Nothing is sent." buttons [Close, Cancel, Yes, reopen]; after Yes: badge "Scheduled", CTA "Mark toured", Reopen buttons 0, dialogs 0, Activity "Tour reopened Oct 4, 4:18 PM / Closed automatically ... 4:15 PM / Tour scheduled 4:15 PM"; API: `status scheduled`, `lastMarkedAt 2026-10-04T20:18:53.654Z`, no outcome / autoClosedAt / autoClosedFrom, `currentLadderId` kept | qa-04, qa-05 |
| 5 | 9.2 reopen into toured hands off to Record outcome (guarded close) | T2: dialog text "This tour goes back to Toured so you can record a different outcome. Nothing is sent."; after Yes: dialog "Record outcome" visible and STILL visible 1.5 s later, Reopen dialog gone; its controls: radios "Yes - move forward" / "No - not a fit", buttons Cancel / "Save decision"; Cancel -> CTA "Record outcome", badge "Toured"; API `status toured` | qa-06 |
| 6 | 9.2 / 7.5 reopen into no_show | T3: dialog text "This tour goes back to No show so you can reschedule it. Nothing is sent."; after Yes: badge "No show", Reopen buttons 0, kebab items [Reschedule, Send no-show check-in, Open relay group]; API `status no_show` | qa-07 |
| 7 | 9.2 convertible closed tour: Start placement primary, Reopen in the kebab only | T5: `button` "Start placement" count 2 (header + Outcome card), `button` "Reopen tour" count 0, kebab items exactly ["Reopen tour"]; the item opens the toured-copy dialog; Cancel leaves the tour closed; Outcome card "Move forward / Moving forward Yes / Start placement" | qa-08 |
| 8 | 7.2 a person's not-a-fit reopens into Record outcome; the normal flow works after | T4: Outcome "Not a fit / Moving forward No", kebab 0, Reopen CTA; Yes, reopen -> Record outcome dialog; "No - not a fit" + "Save decision" -> dialog closes, header "Closed", Outcome "Not a fit / Moving forward No", Reopen CTA back | qa-11 |
| 9 | 9.2 / D14 a stale writing dialog meets a 409 | T6: Record outcome dialog opened with "No - not a fit" checked; the scoped tick closed T6 (`closed 1`); "Save decision" -> `role=alert` inside the dialog: "This tour changed since the page loaded - reload and try again."; dialog stays open; after reload: "No outcome recorded / Closed automatically on Oct 4" | qa-12 |
| 10 | 10.2 live update, no reload | T7 page open (badge "Scheduled", CTA "Mark toured"), `window.__qaMarker` set; scoped tick (`closed 1`); "Closed automatically on" visible within 2 ms of the check (already painted), marker survived (no reload), header "Closed", Reopen buttons 1, "Mark toured" 0 | qa-13 |
| 11 | 9.4 Today after the reopens; cap + link rule | 5 links: T8 No show, T6 Needs outcome, T7 Not marked, T3 No show (reopened), T1 Not marked (reopened); footer "See all 6 on the Past tab" (T2 Needs outcome is the sixth) | qa-09 |
| 12 | 9.3 Past tab lists reopened tours; intro | 6 rows incl. T1 "Not marked / Mark toured", T3 "No show", T2 "Needs outcome / Record outcome"; intro ends "Tours with no outcome close on their own two weeks after their date or their last update." | qa-10 |
| 13 | 10.1 tenant AND landlord timelines | contact-tenant-0001: "Tour closed automatically: no outcome recorded after two weeks" x5 (T1, T2, T3, T6, T7), "Tour reopened" x4 (T1, T2, T3, T4), each linking `/tours/<id>`; contact-landlord-0001: the same 5 + 4 | qa-14, qa-15 |
| 14 | 9.5 property activity keeps the /tours link | listings/unit-0001: "Tour closed automatically ..." x3 (T7, T3, T1) and "Tour reopened" x2 (T3, T1), every one linking `/tours/<id>` | qa-16 |
| 15 | 6.5 nothing sent | fake store `{"threads":[]}` after every tick and reopen; the app log has no send line | - |
| 16 | 6.4 the log shape | per close: info with `tourId` + `from`; per run: `scanned/due/closed/lost/failed`; per reopen: `tour reopened via api` with `tourId` + `to`; no `relay close-nag` line (these tours have no group) | - |
| 17 | F12 the real worker's 15-minute poll | worker.log (`.superpowers/sdd/child-logs/worker.log`) - see section 3 | - |

Not exercised live (covered by unit/integration tests, named so the handback
is honest): the relay close-nag arm/clear on a tour that owns an open relay
group (`tourAutoClose.test.ts`, `toursReopenApi.test.ts`,
`relayCloseNagClear.test.ts`); a converted tour's "View placement" with no
Reopen (`TourDetail.test.tsx`); the reminder-row sweep on close
(`tourAutoClose.test.ts` case 8).

## 3. The worker's own poll

The lane's worker booted 2026-10-04T20:13:03Z with the event bridge attached;
its first `tour auto-close` tick is due 15 minutes later. `jobs/pollLoop.ts`
logs nothing on a quiet tick and the job logs only when it closes or fails,
so the only observable is an absent `tour auto-close poll error` line - see
the handback for the final read of worker.log at session end.

## 4. Observations (none blocking)

- The tour page's "Communications and activity" pane is the TENANT's
  timeline, so on T1's page the auto-close label appears once per auto-closed
  tour of that tenant (3) plus once in the tour's own Activity card -
  pre-existing design, not a duplication.
- Today's cap and ordering held with two tours sharing a date (T1 and T2,
  both Sep 14 10:00): T1 made the list, T2 did not; the footer named 6.
- A stale browser tab from an earlier lane-7 session (Chrome, user-0002)
  kept polling the dashboard port throughout; it produced two "session
  revoked" WARN lines in C7's runs and nothing here. Harmless; not mine to
  close.
