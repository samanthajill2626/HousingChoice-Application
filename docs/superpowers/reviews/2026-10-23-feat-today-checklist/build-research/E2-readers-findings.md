E2 readers sweep (read/consume side), tracker #31, branch feat/today-checklist (source = main @970a29b9): every reader of the Today wire, page, copy and fallback (app, dashboard, e2e incl. performance and scenarios, fake-twilio, app/scripts, scripts, docs a test reads); every dashboard SSE consumer of contact.updated, conversation.updated and tour.updated plus the server SSE fan-out and the worker bridge; every caller of buildFollowUps / services/followUps.ts and every consumer of the Follow up route output; every caller of tours.listByStatus and the byStatus GSI; every caller of getRecipientDisplaysByIds; every generic renderer or echo of contact fields. Compared against spec r8 and plan v4 sections 0-4 plus the S4, S5 and S7 slice text.

Verdict: no BLOCKER, no MAJOR. 8 MINOR. The contact-page state (edit form, composer draft, staff-notes draft, dialogs, scroll, call menu) survives a contact.updated that lands right after the user's own send; the after-loop conversation.updated has the API-side shape by construction; no tour.updated consumer assumes the tour existed or reads its status; the new consistentRead option changes no existing caller; no generic renderer can display last_reached_out_at.

## Findings

### E2-1 MINOR - page-wide DOM absence checks on Today are no longer evidence under the 5-row slice

- Reader: `e2e/scenarios/steps.ts:3103-3114` (`expectPlacementGoneFromBoard`: waits for the /api/today response, then `page.locator('a[href="/placements/<id>"]')` toHaveCount(0) page-wide), called by `e2e/tests/scenarios/post-tour-application.spec.ts:246` (a spec with NO per-test reseed, `:24`, on the shared lane where Placements holds more than 5 rows - the plan's own reason for `showAllIn` in S7.9). Secondary: `e2e/tests/flows/email-triage.spec.ts:64-66` ("(b) Nothing shows up in Today either": `getByText(/stranger\.caller/)` toHaveCount(0) right after `expectTodayReady`, no wait for the Today fetch; it reseeds per test, so the slice matters less there, but it is the spec-2 check "Not added: unmatched email" and it is DOM-only).
- Behavior change: S5's `LimitedList` (plan ~14683-14760) renders `items.slice(0, 5)`; a row past the fifth of its section (and every AI row while the line is collapsed) is not in the DOM. A placement that wrongly lingers in Placements as row 6+ passes the "gone" check.
- Plan coverage: S7.1's table (plan 21448) marks `steps.ts:3100` "stays"; `email-triage.spec.ts` is not in the table (the S7.1 re-grep patterns cannot match it). The plan's own selector rule (plan 22393: "assert an absence on server truth (`GET /api/today` `items[].group`), never on a missing list alone") is not applied to either.
- Correction: S7 adds both to its disposition table; `expectPlacementGoneFromBoard` first asserts on server truth that no `items[]` row has `refId === placementId` (a non-200 throws, the `identifyIds` pattern in S7.4), keeping the DOM count as a second line; email-triage (b) asserts no `items[]` row's `who` matches the stranger address, after the Today fetch.

### E2-2 MINOR - S5 and S7 disagree on `e2e/support/selectors.md:18`; two harness docs keep "Tours today ... <h2>"

- Reader: `e2e/support/selectors.md:18` ("the queue's own `Tours today` group `<h2>`") and `e2e/support/today.ts:11` ("`Tours today` group heading (an <h2>)"); comments at `e2e/tests/dashboard-next/tours-page.spec.ts:46,259`.
- Behavior change: PR65 makes "At a glance" the h2 and "Tours today" an h3 inside it (S5 TodaySection `level={3}`). The substring trap the docs warn about still holds (an h3 named "Tours today" still matches a non-exact 'Today'), but the element they name is wrong.
- Plan coverage: contradictory. S5's cross-slice note (plan 14521-14524) says line 18 must be updated ("Tours today is now an `<h3>`"); S7.1's disposition (plan 21450) says "`:18` stays true (Tours today is still an `<h2>`)", and S7.2 edits only `:65`. `support/today.ts:11` is listed as "stays (true)" (plan 21451).
- Correction: S7.2 edits selectors.md:18 and support/today.ts:11 to "the `Tours today` heading (an h3 under At a glance since tracker #31)"; the S7 report records the S5/S7 disagreement as resolved in S5's favor.

### E2-3 MINOR - the perf ledger's `background.today` citation goes stale and nothing re-cites it

- Reader: `e2e/performance/routes.ts:872` (`today: 'dashboard/src/routes/today/useToday.ts:39,126-153'`), pinned verbatim in `e2e/performance/collect.test.ts:371`, consumed by `e2e/performance/collect.ts:69`.
- Behavior change: S5 edits `useToday.ts` above and inside those lines (new state fields, the `loadToday` return, the two subscription comments, plan ~16190-16235), so the citation points at the wrong code. The citation check is format-only (`routes.test.ts:451-484`), so no test fails.
- Plan coverage: S7.11 step 4 (plan 23634-23655) re-cites only the `'/'` terminal and the `'/'` endpoint base.
- Correction: S7.11 also re-cites `background.today` to the as-built `REFETCH_DEBOUNCE_MS` line and the `useEventStream` block, and updates the `collect.test.ts:371` pin in the same commit.

### E2-4 MINOR - two app comments still put unknown contacts on "Today's Needs you now"

- Reader: `app/src/lib/statusModel.ts:207-208` ("`needs_review`: the triage queue and Today's Needs you now") and `app/src/lib/unknownQueue.ts:63-65` ("The contact leaves Today's Needs you now (the triage pass reads only needs_review, and the unread pass skips an Inactive contact's unknown_1to1 thread)").
- Behavior change: after S4.5 those rows are the `identify` group ("Identify these contacts"), and the unread pass no longer has an Inactive skip (PR26 replaces it with the owner rule).
- Plan coverage: none. S4 rewrites the comments inside `today.ts`, S5 the one in `useToday.ts` (plan 16220-16230); S7.1's app/src re-grep (plan 21430) omits "Needs you now", so these two are never seen.
- Correction: S4.5 (or S7.13 with the GLOSSARY drift) rewrites both to "Today's Identify these contacts" and the owner rule; add "Needs you now" to the S7.1 app/src grep.

### E2-5 MINOR - Tours to book is an uncapped read, but the planned today.ts header calls it bounded

- Reader: the new Tours to book pass reading `toursRepo.listByStatus('requested')` (`app/src/repos/toursRepo.ts:442-465`: pages the whole byStatus partition, no Limit, no page cap, no WARN).
- Behavior change: the `requested` partition is never auto-closed (`app/src/lib/toursModel.ts:166` AUTO_CLOSE_STATUSES excludes it) and grows with every undecided request - `app/src/routes/broadcasts.ts:707-725` bounds the same partition with `createdAtFrom` for exactly that reason. Today now reads it whole on every load, and every open dashboard refetches Today on each SSE event. Prod holds 13, so nothing breaks today; the route's stated invariant is the issue.
- Plan coverage: the S4 header replacement (plan 14152-14164) lists "tours listByStatus('requested') (Tours to book)" under "Every list read is a bounded Query", and PR28 adds no cap WARN. Spec 5.4 rules out an AGE limit, not visibility of size.
- Correction: word the header honestly ("pages the whole requested partition - uncapped by design, spec 5.4") and WARN when it returns more than GROUP_FETCH_LIMIT rows (the `warnIfCapped` convention), so growth is visible in the logs. No row is dropped.

### E2-6 MINOR - "listing sends is a base-table Query" is offered as consistent; it is not

- Reader: the Follow up core's per-unit `listingSends.listByUnit` (`app/src/repos/listingSendsRepo.ts:473-483`: a base-table Query with no `ConsistentRead`), read by Quiet shares through `collectWaitingFollowUps`.
- Behavior change: the Not interested drop-off reads `row.declined` (`app/src/lib/listingSendOutcome.ts:83`). Not interested emits no event (spec 8), so Today learns it only on the remount when staff navigate back, typically well under a second after the decline write; an eventually consistent Query can still return the pre-decline row, leaving the person in Quiet shares until the next unrelated refetch or a reload.
- Plan coverage: PR90/WI8 (plan 711), the S4 route comment (plan 14050) and the S7 cost issue (plan 24189-24191) all name listing sends as "a base-table Query" in contrast to the GSIs, i.e. outside the eventual-consistency residue.
- Correction: either record listing sends in the WI8 residue (S4 report, S7 cost issue, the route comment), or pass `ConsistentRead: true` on the Today path's listing-sends Query (base-table Queries support it; the Follow up route keeps its current read, so WI1 holds). Recording is enough for this mission.

### E2-7 MINOR - deploy skew: an open pre-deploy Today tab silently drops Identify and Tours to book

- Reader: the OLD `dashboard/src/routes/today/Today.tsx:38-44` GROUP_META and `:311-333` (renders only the five known groups, filtering `items` by group) running in a tab loaded before the deploy.
- Behavior change: against the new server that tab shows no unknown-contact rows (they moved to `identify`), no requested tours, no Unreplied, and - when only those groups hold rows - neither rows nor "All caught up" (`items.length > 0`). The dashboard has no stale-build reload. Sam keeps Today open all day, so a mid-day deploy hides unknown contacts from her until she reloads.
- Plan coverage: PR31 covers the reverse skew (new dashboard, old API); this direction is not mentioned.
- Correction: add to the S8 handback / RUNBOOK deploy note: "after the deploy, reload every open dashboard tab (Sam, the VA)". No code change.

### E2-8 MINOR - the worker's after-loop conversation.updated can still be overtaken on delivery

- Reader: `dashboard/src/routes/conversation/ThreadUnreadToggle.tsx:63-72` (setCount from `event.unread_count`) and `dashboard/src/routes/contact/ContactDetail.tsx:422-431` (setHasUnread from it) - the only two consumers that set state from the payload.
- Behavior change: PR17/PR20 fix the start-of-run snapshot with a fresh consistent read, but the payload still travels the fire-and-forget bridge (`app/src/lib/eventBridge.ts:45-70`, one detached POST per emit) while API-side events (an inbound's increment, a page auto-read's reset) go straight to SSE. A read taken before an API-side write but delivered after that write's event restores the older count until the next event. Rare (bridge latency is milliseconds); the same residue already exists for the worker-side emits at `app/src/jobs/broadcastFanOut.ts:1498`, `app/src/jobs/sendReconcile.ts:985` and `app/src/services/relayAnnouncements.ts:253`.
- Plan coverage: none; spec 7.3 presents the fresh read as closing the stale-payload hazard.
- Correction: no code; the S3 report records it as accepted residue (the fresh read narrows, not closes, the window).

## Consumer table (the record that the sweep was complete)

### Item 1 - Today wire, page, copy, fallback, TODAY_PAST_TOURS_CAP (34)

| Reader (file:line) | What it reads / does | Plan |
|---|---|---|
| app/src/routes/api.ts:1282-1301 | mounts createTodayRouter, passes repos | S4 PR24 |
| app/scripts/seed-smoke.mjs:28-30,297-316 | GET /api/today; asserts tours_today >= 1 and needs_you_now >= 1 (PLACEMENT-A overdue RTA, app/src/lib/seed/live.ts:396), comment lists groups | S4.5 (comment; asserts unaffected - verified) |
| dashboard/src/api/types.ts:484-526 | TodayGroup / TodayItem / TodayResponse mirror | S5 PR31 |
| dashboard/src/api/types.ts:2180 | comment names "AI suggestions to review" | S5.6 |
| dashboard/src/api/endpoints.ts:140-166 | getToday (day, toursFrom, toursTo) | unchanged |
| dashboard/src/routes/today/useToday.ts:41-74,126-157 | load, 404 fallback, SSE refetch (placement, conversation, suggestion, tour, contact) | S5 PR32 |
| dashboard/src/routes/today/buildToday.ts:13,38-46,198,288-333 | fallback groups, GROUP_ORDER, unreplied, unknown_1to1 rows | S5 PR36 |
| dashboard/src/routes/today/Today.tsx:38-50,58-79,266-337 | GROUP_META, hrefFor (tour -> /tours/:id with BACK_TO_TODAY, so Tours to book rows get the back pointer), subtitle :279, All caught up :289-294 | S5.6 |
| dashboard/src/routes/today/useTodayPastTours.ts:33,103-128,175-183 | TODAY_PAST_TOURS_CAP labeling; tour.updated reload | S5 PR35, WI10 |
| dashboard/src/routes/tours/useTours.ts:200-260 | selectPastTours / selectOffRangeTours / TODAY_PAST_TOURS_CAP export | S5 PR35/PR63 |
| dashboard/src/routes/placements/placementsFormat.ts:46 | mirrors today.ts urgencyOf | unaffected |
| e2e/performance/routes.ts:268-282 | TODAY_GETS (shapes unchanged) | S7.11 (kept) |
| e2e/performance/routes.ts:396-403 | TODAY_TERMINAL | S7.11 |
| e2e/performance/routes.ts:764,818 | '/' endpoint base and terminal citations | S7.11 |
| e2e/performance/routes.ts:872; collect.test.ts:371 | background.today citation + pin | MISSED (E2-3) |
| e2e/performance/collect.ts:69-79 | /api/today background shape; tour.updated note (still true: creates are browser writes, blocked in samples) | unchanged |
| e2e/performance/templates.ts:30; routes.test.ts:73,451-484 | template list; citation format check | unchanged / S7.11 |
| e2e/support/today.ts:11; e2e/support/selectors.md:18,65 | Tours today heading level; AI list selector | S7.2 (:65); :18 and today.ts:11 E2-2 |
| e2e/scenarios/steps.ts:3076-3093,3142-3160 | RTA / voucher rows in 'Needs you now' list | stay (rows still needs_you_now; oldest deadline first) |
| e2e/scenarios/steps.ts:3103-3114 | expectPlacementGoneFromBoard DOM absence | MISSED (E2-1) |
| e2e/scenarios/steps.ts:3178-3196 | stuck row in 'Follow-ups due' | S7.9 |
| e2e/tests/scenarios/post-tour-application.spec.ts:238-316 | calls the steps above | via S7.9 |
| e2e/tests/flows/email-triage.spec.ts:64-66 | Today DOM absence of unmatched sender | MISSED (E2-1) |
| e2e/tests/dashboard-next/unknown-caller-triage.spec.ts:7,66-90 | server truth + 'Needs you now' list | S7.3 (reseeds per test; lean has 0 unknowns, so oldest-first Identify cannot hide the row) |
| e2e/tests/dashboard-next/unknown-inactive.spec.ts:5-20,51,129-164,189,321 | server truth + DOM | S7.4 (same reseed note) |
| e2e/tests/flows/conversation-fact-extraction.spec.ts:19,354-430 | 'AI suggestions to review' list | S7.5 |
| e2e/tests/dashboard-next/caseworkers.spec.ts:88,547-553 | AI list | S7.6 |
| e2e/tests/scenarios/participant-names.spec.ts:46-56 | Unreplied vehicle | S7.7 |
| e2e/tests/dashboard-next/today-past-tours.spec.ts | past tours section | S7.8 |
| e2e/tests/dashboard-next/tours-page.spec.ts:178-191,255-273 | Tours today list; page-wide requested-tour absence | S7.10 (beforeAll reseed, lean has no today tours, so :188 is safe under the 5-row limit) |
| e2e/tests/dashboard-next/relay-number-lifecycle.spec.ts:367-393 | 'Relay groups to close' | stays (pin S7.17) |
| app/test/todayApi.test.ts; todayUnmatchedNonRegression.test.ts | server tests | S4 PR40/PR57/PR59 |
| app/test/contactSoftDelete.test.ts:150-165; aiRunVerdicts.test.ts:2076-2219 | GET /api/today refIds / ai_suggestions absence (group-agnostic, unaffected) | S4 run lists |
| app/src/lib/statusModel.ts:207-208; app/src/lib/unknownQueue.ts:63-65; documentation/GLOSSARY.md:700-728; documentation/STATUS-MODEL.md:232,283-292; docs/issues/public-signup-abuse-hardening.md; docs/issues/imported-unknown-threads-surface-as-unknown-on-today.md | prose naming Needs you now / Unreplied | docs: S7.13/S7.14; the two app comments MISSED (E2-4) |

No nav badge, count, push, digest, email or toast reads Today: the nav badges are inbox-unread and unmatched-email-unread only (dashboard/src/app/nav.ts:36-39,83-84); web push is call-only (app/src/services/pushService.ts); fake-twilio and the app scripts other than seed-smoke do not read /api/today; no test reads a docs page that names a Today section (e2e/performance/config.test.ts:349 reads only the profiler CLI part of e2e/README.md).

### Item 2a - contact.updated (6)

| Consumer (file:line) | On the event | State kept or lost |
|---|---|---|
| dashboard/src/api/EventStreamProvider.tsx:222-225 | parses and dispatches to every subscriber | - |
| dashboard/src/routes/today/useToday.ts:156 | 300 ms debounced GET /api/today (whole page; coalesces with the send's conversation.updated) | expansion state is component state, kept |
| dashboard/src/routes/inbox/useInbox.ts:591 | 300 ms debounced head read GET /api/inbox?filter&limit | tail pages and scroll kept (head/tail model, :130-216); NEW load only for outbound calls (W6 emits no conversation.updated) |
| dashboard/src/routes/contact/useContact.ts:88-91 | only for the open contactId: GET /api/contacts/:id?consistent=1, latest-wins sequence, no status flip | new contact identity: ContactCommsPane.tsx:107-110 drops its `override` (safe - every override is mirrored up first, :312-315); composer draft kept (pane keyed on contactId, ContactDetail.tsx:1220-1233); ContactEditForm.tsx:183 freezes `base`, draft kept; StaffNotesCard.tsx:99-106 seeds only at startEdit; dialogs reset only on contactId (ContactDetail.tsx:331-378); CallMenu.tsx:54-79 local; scroll resets only on resetScrollKey=contactId |
| dashboard/src/routes/contact/useContactTimeline.ts:548-550 | for its contactId: 300 ms debounced GET /api/contacts/:id/timeline (merge by id) | mounted by ContactDetail.tsx:382 AND ContactCommsTab.tsx:64 (tour/placement person tabs) - the spec 7.3 list omits the latter; harmless |
| app/src/routes/api.ts:2708-2799 (GET /api/events) | no per-user or per-contact filter: every open stream (cap SSE_MAX_CONNECTIONS, default 50) gets every contact.updated; worker emits arrive via lib/eventBridge.ts -> routes/internal.ts | - |

### Item 2b - conversation.updated (13)

Payload-driven (set state from unread_count): dashboard/src/routes/conversation/ThreadUnreadToggle.tsx:63-72; dashboard/src/routes/contact/ContactDetail.tsx:422-431 (E2-8). Refetch-only: dashboard/src/app/UnreadContext.tsx:287 (badge); dashboard/src/routes/inbox/useInbox.ts:591; dashboard/src/routes/today/useToday.ts:144; dashboard/src/routes/contact/useContactTimeline.ts:541; dashboard/src/routes/contact/useContactMedia.ts:141; dashboard/src/routes/conversation/useRelayThread.ts:494 (unfiltered); dashboard/src/routes/conversation/useGroupThread.ts:326-337 (filtered); dashboard/src/routes/shared/useRoster.ts:113-118 (filtered by threadId); dashboard/src/routes/tours/useTourChannels.ts:256-262 (unfiltered); dashboard/src/routes/placements/usePlacementChannels.ts:264-270 (unfiltered). Server: only the SSE route listens (api.ts:2761). Shape: toConversationUpdatedEvent (app/src/lib/events.ts:89-120) is the single builder; conversationsRepo getById returns the raw item (app/src/repos/conversationsRepo.ts:1124-1127), the same type the API emit sites pass (touchLastActivity ALL_NEW, relayGroups.ts:740, relayMembers.ts:272/380), so a getByIdConsistent twin yields the identical shape (relay status, pool_number, members). No consumer reads `members` or names from the payload.

### Item 2c - tour.updated (6)

dashboard/src/routes/today/useToday.ts:152 (refetch); dashboard/src/routes/today/useTodayPastTours.ts:175-183 (unfiltered reload + relabel, spec 5.3 cost); dashboard/src/routes/tours/useTour.ts:116-122, useTourActivity.ts:85-91, RemindersPanel.tsx:319-325, dashboard/src/routes/shared/useRoster.ts:119-124 (all filtered by tourId, so a create is a no-op unless that tour page is already open). None reads `status`; none assumes prior existence; no dashboard cache holds tours. The Tours page (useTours.ts:56-106) and the contact Tours card do not subscribe (no live update on create - pre-existing, not a regression). Server: only the SSE route listens.

### Item 3 - buildFollowUps / services/followUps.ts (7)

app/src/routes/broadcasts.ts:110,1410 (the only production caller; GET /api/broadcasts/follow-ups). Output consumers: dashboard/src/routes/broadcasts/useFollowUps.ts:52 (items), FollowUpView.tsx:39-56 (groups by first appearance, so it depends on the server sort), dashboard/src/routes/listings/useFollowUpCounts.ts:16-18 (byUnit pill), e2e/tests/dashboard-next/follow-up-tab.spec.ts:103. Exports used elsewhere: FOLLOW_UPS_UNIT_CAP, FollowUpsDeps (app/test/followUps.test.ts). isWaiting / waitingSince / FOLLOW_UP_LOOKBACK_MS (app/src/lib/listingSendOutcome.ts:28,130-157) are read only by followUps.ts and tests. The core keeps isWaiting (the 24 h rule) inside it, which is what makes Today a subset of the tab (spec 6.1). No other code depends on the internals.

### Item 4 - tours.listByStatus and the byStatus GSI (5)

app/src/jobs/tourAutoClose.ts:77 (scheduled, toured, no_show every sweep); app/src/routes/broadcasts.ts:719-725 (same three unbounded; requested bounded by createdAtFrom 14 days); app/src/routes/tours.ts:452 (GET /api/tours?status=: the Tours page Needs booking, useTours.ts:72, and the Closed view); the new Today Tours to book read (unbounded, E2-5). Repo app/src/repos/toursRepo.ts:442-465 pages to exhaustion with no Limit, page cap or WARN; GSI app/src/lib/tables.ts:543-549 (hash status, range createdAt). `requested` is never auto-closed (app/src/lib/toursModel.ts:166); prod 13.

### Item 5 - getRecipientDisplaysByIds (3)

app/src/routes/units.ts:1511 (recipients card) and :1592 (outcome route), app/src/services/followUps.ts:161 - all `{ requireComplete: true }`. The repo adds ConsistentRead only when `opts.consistentRead === true` (app/src/repos/contactsRepo.ts:1055), so none of them changes. units.ts maps projection fields by name (recipientFactsOf :224-230, projectRecipientRow :259-300), so the projection's new attribute never reaches that wire.

### Item 6 - display of last_reached_out_at / meaning of last_heard_from_at

No generic renderer: no Object.keys/entries over a contact in dashboard/src/routes/contact, contacts or inbox; the PATCH `changedFields` audit is an explicit list (app/src/routes/contacts.ts:579-760); no CSV or export of contacts; the importer writes named fields (UpdateCommand, app/src/lib/import/apply.ts). GET /api/contacts/:id, the list and the PATCH echo return the raw item, so the field is on the wire but never rendered. No dashboard write echoes a whole contact back (every updateContact call sends named fields), so SERVER_OWNED refusal cannot start failing a dashboard save. Every last_heard_from_at reader reads it by name (listingSendOutcome.ts:76-153, followUps.ts:173-197, broadcasts.ts:615,662,1090, units.ts:266-297, audienceResolution.ts:233, contacts.ts:1341-1349, dashboard ContactDetail.tsx:1082, ContactsList.tsx:160,287, RecipientPreview.tsx:68-563, FollowUpView.tsx:69, Card.tsx:352); none takes a max over *_at fields.
