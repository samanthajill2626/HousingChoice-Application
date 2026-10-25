# Spec-conformance review - feat/today-checklist (planner review)

- Reviewer: independent spec-conformance reviewer (Claude Opus 5.5), no build briefing.
- Authority: `docs/superpowers/specs/2026-10-23-today-checklist-design.md` r8.
- Code under review: `main...4508f61f` (base main @970a29b9), worktree `W:\tmp\today-checklist`.
- Method: read-only. Read the spec section by section, then traced each normative point
  to the code (route/job entry point down to the stamp for every writer) and to the
  tests named in spec section 9. Plans and other review records were NOT read.
  No command was run beyond read-only `git diff` / `grep` / file reads.
- Line numbers are at `4508f61f`.

## Summary

| Verdict | Count |
|---|---|
| CONFORMS | 131 |
| PARTIAL | 3 |
| MISSING | 0 |
| DEVIATES | 0 |

| Severity | Count |
|---|---|
| blocking | 0 |
| high | 0 |
| medium | 0 |
| low | 2 |
| info | 4 |

No blocking, high or medium finding. Every writer row W1-W8, every no-stamp row, the
system_copy marker chain, the quiet-share clock and drop-offs, the bare headings, the
All caught up rules and the backfill's counting and forward-only rules are implemented and
pinned by tests. The three PARTIAL rows map to two findings: the known, filed
settle-window flash on a past-tours reload (rows 23 and 66, SC-1) and the backfill's
Send-now rule shape and its "could not tell apart" reporting (row 120, SC-2).

## 1. Spec point table

### 1 / 2. Goal and page layout

| # | Spec point | Verdict | Evidence |
|---|---|---|---|
| 1 | Checklist order: Needs you now, Identify, Past tours, Tours to book, Quiet shares, Relay groups to close, Placements | CONFORMS | dashboard/src/routes/today/Today.tsx:577-612 |
| 2 | Dashed divider then "At a glance" (Tours today, AI suggestions) | CONFORMS | Today.tsx:396-454, 614; Today.module.css:514-520 (`border-top: 2px dashed`) |
| 3 | Unreplied removed (server + dashboard) | CONFORMS | app/src/routes/today.ts:108-114, 924; dashboard/src/api/types.ts TodayGroup; buildToday.ts:305-306 |
| 4 | Unmatched email not added | CONFORMS | no Today source reads unmatched email (today.ts whole route) |
| 5 | Page subtitle copy exact | CONFORMS | Today.tsx:545 |
| 6 | No jump row; no per-person chips in quiet shares | CONFORMS | Today.tsx (no link bar); QuietShares.tsx:69-94 (one state tag per row, as 6.2 asks) |
| 7 | Each section a `<section>` + `<h2>`; list named by heading text | CONFORMS | TodaySection.tsx:35-44, 86-90 (`aria-label={label}`) |
| 8 | Heading of follow_ups renamed "Placements" | CONFORMS | Today.tsx:61, 612 |

### 2.1 Five rows

| # | Spec point | Verdict | Evidence |
|---|---|---|---|
| 9 | Each section shows first 5 rows | CONFORMS | TodaySection.tsx:24, 82-83 |
| 10 | Heading carries NO count | CONFORMS | TodaySection.tsx:40 (bare label); UnavailableSection Today.tsx:170-178; QuietShares.tsx:172, 189; AtAGlance h2 Today.tsx:416 |
| 11 | "Show all N" under the list; then "Show fewer"; per-viewer page state | CONFORMS | TodaySection.tsx:84-104; Today.tsx:479-498 (state in component only) |
| 12 | Past tours keeps "See all N on the Past tab" / "Open the Past tab" beside Show all | CONFORMS | Today.tsx:345-350 (footer) |
| 13 | Quiet shares limit counts PROPERTY lines | CONFORMS | QuietShares.tsx:190-204 (`noun="properties"`, items = properties) |
| 14 | Empty section not rendered | CONFORMS | Today.tsx:146 (ItemsSection), 333, 600; QuietShares.tsx:177 |
| 15 | Server-capped sections count what the server returns | CONFORMS | rows come straight from the response (Today.tsx:500-506) |

### 2.2 Help lines

| # | Spec point | Verdict | Evidence |
|---|---|---|---|
| 16 | Identify help line exact | CONFORMS | Today.tsx:66-67 |
| 17 | Tours to book help line exact | CONFORMS | Today.tsx:68 |
| 18 | Quiet shares help line exact | CONFORMS | QuietShares.tsx:31-33 |
| 19 | No help line on Needs you now, Past tours, Relay, Placements | CONFORMS | Today.tsx:577, 585, 600, 612 (no `help`) |

### 2.3 All caught up

| # | Spec point | Verdict | Evidence |
|---|---|---|---|
| 20 | Shows when every checklist section 1-7 is empty and settled | CONFORMS | Today.tsx:511-536 (queueEmpty incl. quiet properties + relay nags; past.rows) |
| 21 | At a glance still renders below; never blocks done | CONFORMS | Today.tsx:568-573, 614 (AtAGlance outside the allCaughtUp gate; glance not in queueEmpty) |
| 22 | A failed section withholds All caught up | CONFORMS | Today.tsx:521-522 (`anyUnavailable`) |
| 23 | Settle rule: waits for past tours to settle so it never flashes above rows about to appear | PARTIAL | first load: Today.tsx:535 + useTodayPastTours.ts:198 (`idle` until labeled). Reloads: see SC-1 |

### 2.4 At a glance

| # | Spec point | Verdict | Evidence |
|---|---|---|---|
| 24 | Tours today compact rows: local time from `at`, tenant, property `unitLabel` | CONFORMS | Today.tsx:371-391; tourTime.ts timeLabel |
| 25 | Tours today ordered by time, tenant name, tourId | CONFORMS | app/src/routes/today.ts:1302-1306 |
| 26 | Tours today same source/status rule, 5-row limit | CONFORMS | today.ts:686-710; Today.tsx:418-426 |
| 27 | AI suggestions ONE line "AI suggestions for N contacts", button with aria-expanded, collapsed by default | CONFORMS | Today.tsx:405, 412, 428-441 (singular "1 contact" refinement, see 3.) |
| 28 | Opened AI list has 5-row limit + Show all; not in a11y tree until opened | CONFORMS | Today.tsx:442-452 (rendered only when `aiOpen`) |
| 29 | N = server contact-row count (capped 20) | CONFORMS | Today.tsx:412 (`aiSuggestions.length`); today.ts:1179-1189 |
| 30 | Both empty: At a glance not rendered | CONFORMS | Today.tsx:411 |

### 2.5 Section failures

| # | Spec point | Verdict | Evidence |
|---|---|---|---|
| 31 | Route answers 200 when core reads succeed | CONFORMS | today.ts:1341-1348 |
| 32 | Quiet shares in its own try/catch; any throw -> unavailable, WARN ids/counts | CONFORMS | today.ts:1271-1286; tests todayApi.test.ts:2905-2926 (walk, listing sends, tours, contacts batch) |
| 33 | Tours to book in its own try/catch; any throw -> unavailable | CONFORMS | today.ts:728-758; todayApi.test.ts:2694, 2928 |
| 34 | Failed unit LABEL is not a failure (unitId shown) | CONFORMS | today.ts:520-537; todayApi.test.ts:2368-2398 |
| 35 | Dashboard "We couldn't load <section>." in place; withholds All caught up | CONFORMS | Today.tsx:170-178, 586-587; QuietShares.tsx:169-176 |
| 36 | Fallback: one line "Some sections can't load right now." not an error per section | CONFORMS | Today.tsx:566, 586 (`&& !fallback`); QuietShares.tsx:168 (`hidden`) |

### 3. Wire contract

| # | Spec point | Verdict | Evidence |
|---|---|---|---|
| 37 | TodayGroup = needs_you_now, identify, tours_to_book, tours_today, follow_ups, ai_suggestions | CONFORMS | today.ts:108-114; dashboard/src/api/types.ts TodayGroup |
| 38 | TodayItem `at?` (tours_today = scheduledAt; tours_to_book = createdAt), `unitLabel?`, tour rows only | CONFORMS | today.ts:125-131, 703-704, 746-747 |
| 39 | unitLabel = formatAddress(unit.address) or unitId; units repo dep; point reads memoized | CONFORMS | today.ts:520-537; api.ts:1303-1305 |
| 40 | Failed unit lookup degrades to unitId, never 500, never makes Tours to book unavailable | CONFORMS | today.ts:532-536 (caught inside unitLabelOf) |
| 41 | `quietShares` ok/unavailable shape incl. `truncated` | CONFORMS | today.ts:179-186, 1278-1285 |
| 42 | `toursToBook: 'ok' | 'unavailable'` | CONFORMS | today.ts:198, 729, 755, 1345 |
| 43 | QuietShareProperty / QuietSharePerson fields | CONFORMS | today.ts:157-176; services/quietShares.ts:83-93 |
| 44 | No distinct-people count (r8) | CONFORMS | quietShares.ts:56-60, 105-111 |
| 45 | `truncated` = Follow up builder's flag; dashboard "Showing the first 100 properties" | CONFORMS | today.ts:1281; QuietShares.tsx:206 |

### 3.1 Fallback

| # | Spec point | Verdict | Evidence |
|---|---|---|---|
| 46 | Fallback runs only on 404 | CONFORMS | useToday.ts:94-97 |
| 47 | Stops emitting unreplied | CONFORMS | buildToday.ts:305-306 |
| 48 | unknown_1to1 rows emitted in `identify`, fallback copy/unread rule kept | CONFORMS | buildToday.ts:279-304 (copy "New inbound - untriaged"; see 3. for the per-contact collapse) |
| 49 | No tours_to_book, no quiet shares; useToday marks both UNAVAILABLE | CONFORMS | useToday.ts:108-120 |
| 50 | Fallback never shows All caught up | CONFORMS | Today.tsx:521-522 (`fallback ||`) |

### 4. Unreplied removal and the unread pass

| # | Spec point | Verdict | Evidence |
|---|---|---|---|
| 51 | Known contacts' unread threads only in Inbox | CONFORMS | today.ts:924; todayApi.test.ts:289, 719, 2602 |
| 52 | Type filter FIRST: before deleted-contact skip and before the cap | CONFORMS | today.ts:924 (then 958-962 deleted, 994 cap); todayApi.test.ts:2505 |
| 53 | Owner test after deleted skip, replacing #30 Inactive skip | CONFORMS | today.ts:984-989 |
| 54 | "feed Unreplied" comment updated | CONFORMS | removed from today.ts (diff); no remaining "feed Unreplied" text in app/src |
| 55 | Header comment points to the new spec | CONFORMS | today.ts:9-14 |

### 5. Sections

| # | Spec point | Verdict | Evidence |
|---|---|---|---|
| 56 | 5.1 Needs you now keeps hard clocks, escalations, relay opt-out rows; unknown rows leave | CONFORMS | today.ts:576-676, 790-861 (see 3. for the one-row-per-member de-dupe) |
| 57 | 5.2 Identify unread source: row only when owner is type unknown and not inactive | CONFORMS | today.ts:984-989; todayApi.test.ts:1206-1368, 2553-2561 |
| 58 | 5.2 Unresolved owner keeps today's behavior (linked roster -> row, else defer) | CONFORMS | today.ts:984-989, 1030-1031; todayApi.test.ts:2574 |
| 59 | 5.2 Triage partition with stub exclusion + phone de-dupe | CONFORMS | today.ts:1081-1168 |
| 60 | 5.2 Row text who + "New unknown contact", links to contact page | CONFORMS | today.ts:1037-1045, 1157-1165 |
| 61 | 5.2 Order oldest created_at first, none last, ties by refId | CONFORMS | today.ts:316-320, 1298 |
| 62 | 5.2 Imported-unknown issue updated | CONFORMS | docs/issues/imported-unknown-threads-surface-as-unknown-on-today.md:39+ |
| 63 | 5.3 Past tours source = Past tab loader, deleted tenants skipped | CONFORMS | useTodayPastTours.ts:118-138, 159 |
| 64 | 5.3 In-range oldest scheduledAt first (ties tourId), off-range last in loader order | CONFORMS | useTodayPastTours.ts:146-155; useTours.ts isOffRangePastTour |
| 65 | 5.3 Labels EVERY Past row; Show all counts qualified rows; link keeps Past tab count | CONFORMS | useTodayPastTours.ts:118-138, 172; Today.tsx:333-350 |
| 66 | 5.3 Settle wait covers the labeling | PARTIAL | first load yes; reload no - SC-1 |
| 67 | 5.4 Tours to book rows: every `requested` tour via listByStatus, deleted tenants skipped, no age/status filter | CONFORMS | today.ts:730-752 |
| 68 | 5.4 Row: who tenant, why unitLabel, urgency "Requested today"/"Requested N days ago", tour link | CONFORMS | today.ts:738-748, 346-352; Today.tsx:85-87 |
| 69 | 5.4 Order oldest createdAt, ties tourId | CONFORMS | today.ts:750, 1300 |
| 70 | 5.5 Relay groups to close at position 6 with 5-row limit | CONFORMS | Today.tsx:599-611 |
| 71 | 5.6 Placements = follow_ups unchanged | CONFORMS | today.ts:576-676; Today.tsx:612 |

### 6. Quiet shares

| # | Spec point | Verdict | Evidence |
|---|---|---|---|
| 72 | Candidates = Follow up core rows (lookback, outcomes, eligibility, every type) | CONFORMS | services/followUps.ts:139-243; quietShares.ts:65-68 |
| 73 | quietSince = max(sentAt, heard if later, reached if later) | CONFORMS | quietShares.ts:69-73 |
| 74 | Thresholds 48h replied / 120h no_reply, fixed durations; shown when >= | CONFORMS | quietShares.ts:26-28, 74-75; quietShares.test.ts:72-94 |
| 75 | state = outcome; outreach restarts clock, never changes state | CONFORMS | quietShares.ts:65, 88; quietShares.test.ts:116 |
| 76 | Each share its own clock; second share does not restart first | CONFORMS | per-row sentAt; shares never stamp (no stamp in broadcastFanOut); todayApi.test.ts:2841 |
| 77 | Core split; Follow up route byte-identical; one contacts read | CONFORMS | followUps.ts:139-261; followUps.test.ts / followUpsApi.test.ts PIN WI1 |
| 78 | Today passes consistentRead to the contacts batch; tab keeps default | CONFORMS | today.ts:1273-1276; followUps.ts:195-198; contactsRepo.ts:787, 1397-1400 (mechanism: SC-5) |
| 79 | Drop-offs: Interested/Not interested/tour created; heard; reached; 14 days; opted out, unreachable, Inactive, placed, deleted, no phone; property unavailable | CONFORMS | core rules; todayApi.test.ts:2854-2883 (12 cases) |
| 80 | 6.2 Person row: name, caseworker role tag, quiet text, state tag copy exact | CONFORMS | QuietShares.tsx:61-94 |
| 81 | 6.2 N = whole days since quietSince, floored | CONFORMS | QuietShares.tsx:52-57 (against server generatedAt) |
| 82 | 6.2 Row opens contact page; NO Interested/Not interested buttons | CONFORMS | QuietShares.tsx:74-77 |
| 83 | 6.2 People order: replied first, then oldest quietSince, ties contactId | CONFORMS | quietShares.ts:96-103 |
| 84 | 6.3 Property line summary copy, zero part left out, "1 person" | CONFORMS | QuietShares.tsx:40-49 |
| 85 | 6.3 Properties ordered by longest-quiet person, ties unitId | CONFORMS | quietShares.ts:104-106 |
| 86 | 6.3 First property open on first render with properties; choices kept by unitId; later property folded | CONFORMS | QuietShares.tsx:160-167, 179-185, 200; QuietShares.test.ts:106, 159, 172 |
| 87 | 6.3 "Show all N properties"; open property shows all people | CONFORMS | QuietShares.tsx:131-133, 195 |
| 88 | 6.3 Property line = button with aria-expanded; people list named for the property | CONFORMS | QuietShares.tsx:112-128 |
| 89 | 6.4 Follow up tab unchanged (24h, inbound-only clock, wire) | CONFORMS | followUps.ts:245-261; followUpsApi.test.ts PIN |
| 90 | 6.5 No cache; docs/issues entry for read cost | CONFORMS | docs/issues/today-quiet-shares-read-cost.md |

### 7. The signal

| # | Spec point | Verdict | Evidence |
|---|---|---|---|
| 91 | 7.1/7.3 touchLastReachedOut copies touchLastHeardFrom exactly (pointer guard, normalize, conditional forward-only, result, never throws) | CONFORMS | app/src/repos/contactsRepo.ts:2073-2109 vs 2035-2071 |
| 92 | 7.3 recordStaffOutreach: awaited, try/catch, ERROR ids only on failed, best-effort, returns written, doc comment rule | CONFORMS | app/src/services/staffOutreach.ts:1-70 (returns the written ids rather than a boolean - same information) |
| 93 | 7.3 Field in ContactItem, RecipientDisplay, recipient projection, SERVER_OWNED_CONTACT_FIELDS | CONFORMS | contactsRepo.ts:235-240, 413-414, 1124-1137; routes/contacts.ts:315-320; contactsCrud.test.ts:556 |
| 94 | 7.3 system_copy marker: written by tour reminder / nudge Send now | CONFORMS | jobs/tourReminders.ts:2008; jobs/placementNudges.ts:864; services/sendMessage.ts:708; repos/messagesRepo.ts:2655 |
| 95 | 7.3 system_copy written by staff Retry of automated or system_copy row; no gating change | CONFORMS | routes/api.ts:1907-1913 (row stays `automated: false`, api.ts:1895) |
| 96 | Marker chain: automatic 30003 retry carries system_copy | CONFORMS | jobs/retrySend.ts:567 (and `automated` carried, 556); retrySendAttempt.test.ts PR107 cases |
| 97 | Marker chain: reconcile retry adoption carries system_copy | CONFORMS | jobs/sendReconcile.ts:947; sendReconcile.test.ts PR107 |
| 98 | W1 stamps inside sendMessage after persist, judged recipient (heldRecipient ?? phoneContact), only with the option; first batch only | CONFORMS | sendMessage.ts:532, 770-778; api.ts:1589 |
| 99 | W2 stamps EXCEPT broadcast_id, automated, system_copy | CONFORMS | api.ts:1914-1920 (see SC-3 on rows with no `automated` field) |
| 100 | W3 email stamps after SES accepts, addressed contact, row instant; one contact.updated last | CONFORMS | sendEmailMessage.ts:476-489, 552 |
| 101 | W4 relay team post: in the fan-out loop (not sendOneRelayLeg), sent / sent_unrecorded / stranded+afterSend, leg instant, contactId only; one after-loop fresh consistent conversation.updated; event bus via appEvents + worker bridge | CONFORMS | relayFanOut.ts:1553, 1589-1599, 1691-1702, 2306, 2368-2370; relayAnnouncements.ts:194-226; conversationsRepo.ts:1139-1144; worker.ts:46-48 |
| 102 | W5 group text: after the row, every resolved member except seeded `excluded`; before the existing emit | CONFORMS | groupSend.ts:614-631, 718-731, 749 |
| 103 | W6 outbound call: whisper-gate outbound=1, after DNC re-check, only on `<Dial>`, AFTER TwiML sent; target carries contactId; not at originate | CONFORMS | voice.ts:1339-1355, 1366-1385, 1686-1730 (opt-out branch returns first), 1737, 1798-1799; voiceOutbound.test.ts W6 cases |
| 104 | W7 staff-edited intro: in sendRelayAnnouncement loop, gated on edited intro_body; other announcements never stamp; after-loop fresh event | CONFORMS | relayFanOut.ts:1106-1116, 1161; relayAnnouncements.ts:332, 391-393, 454-463 |
| 105 | W8 dev seams stamp outbound fixture rows as their inbound twin does | CONFORMS | routes/dev.ts:856-878, 950, 1182, 1213 |
| 106 | No-stamp: shares/broadcasts (+reconcile adoption), automatic retry + reconcile retry adoption, relay 30003 rung, Send now, missed-call/welcome/reminder poll/nudge poll, system announcements, importer, seeds | CONFORMS | only stamp sites: grep recordStaffOutreach/stampRelayOutreach (sendMessage, sendEmailMessage, voice, dev, groupSend, relayFanOut, relayAnnouncements); `staffOutreach: true` only api.ts:1589, 1920; tests broadcastFanOut, retrySendAttempt, sendReconcile, relayRetryLeg, tourRemindersApi, placementNudgesApi, missedCallAutoText, publicIntake, importApply, seedProfile, performanceSeed |
| 107 | Edge: failed send / no leg -> no stamp; no contactId -> skipped | CONFORMS | sendMessage.ts stamp after append; relayFanOut.ts:1589-1592; staffOutreach.ts:52 |
| 108 | One event per send; ContactUpdatedEvent doc names the new emitters | CONFORMS | lib/events.ts:314-337 |
| 109 | 7.4 field shown nowhere | CONFORMS | no dashboard reader (grep) |

### 7.5 Backfill

| # | Spec point | Verdict | Evidence |
|---|---|---|---|
| 110 | Script path/shape: --env local|dev|prod via stageClient, dry run default, --apply, ids/counts logs, abort exit 1 on failed | CONFORMS | app/scripts/backfill-last-reached-out.ts:686-725, 668-677, 550-558 |
| 111 | Window = 14 days; key-condition Query `tsMsgId >= floor` with margin; normalizeInstant re-check; no last_activity prefilter | CONFORMS | backfill:88-90, 223-229, 623-636, 309-314 |
| 112 | Latest instant per contact across threads; ONE touch each; forward-only; no events | CONFORMS | backfill:301-304, 668-677 |
| 113 | All categories: outbound, author teammate, no imported_from | CONFORMS | backfill:307-317 (intros: author 'system' as the spec says) |
| 114 | 1:1 text/email: not automated, no broadcast_id, no retry_attempt/retry_window_start, email left for SES, no system_copy | CONFORMS | backfill:403-408, 429-434 |
| 115 | r8 manual retry excluded when retried row or chain root in window is automated/system copy/Send-now; outside window counts and is reported | CONFORMS | backfill:283-295, 414-422, 458 |
| 116 | Relay posts: team key, not relay_retry_of, slot sid/sent instant; reconcile-adopted legs count | CONFORMS | backfill:315, 318-320, 343-357; sendReconcile.ts:1039-1044 writes sid + sentAt |
| 117 | Group text: per slot, phone -> contact, excluded skipped | CONFORMS | backfill:361-394 |
| 118 | Calls: answered_at or call_outcome | CONFORMS | backfill:425-428 (outbound call_outcome is only written on a Dial summary, voice.ts:2009-2032) |
| 119 | Edited intros: plan picks one rule; dry run reports which | CONFORMS | backfill:94, 326-338, 533 |
| 120 | Send now rows: plan picks one rule; dry run reports how many it could not tell apart | PARTIAL | backfill:95, 435-448 - SC-2 |
| 121 | Recipient: recipient_contact_id else the 1:1 thread contact | CONFORMS | backfill:453-455, 470-472 |
| 122 | Agent only on hermetic lane; RUNBOOK entry; handback obligation | CONFORMS | backfill:58-63; RUNBOOK.md:555-582 |
| 123 | Tests: per-category, window, latest across threads, forward-only re-run, abort | CONFORMS | app/test/backfillLastReachedOut.test.ts:175-995 |

### 8. Live updates

| # | Spec point | Verdict | Evidence |
|---|---|---|---|
| 124 | Today refetches on placement/conversation/suggestion/tour/contact events, debounced 300ms | CONFORMS | useToday.ts:177-214 |
| 125 | Inbound paths checked; post-touch contact.updated where order is wrong (inbound email, founder-triage call, masked relay calls) | CONFORMS | inboundEmail.ts:840; voice.ts:863, 1154, 1255. Inbound SMS/MMS/relay already touch before their emit (webhooks/twilio.ts:961/1076, 1388/1421, 2192/2225, 2695/2768) |
| 126 | tour.updated on both create paths | CONFORMS | routes/tours.ts:421; routes/units.ts:1669; only two `tours.create` call sites exist |
| 127 | Not interested: no event added | CONFORMS | units.ts diff adds only the Interested emit |

### 9 / 10. Tests and docs

| # | Spec point | Verdict | Evidence |
|---|---|---|---|
| 128 | Server route tests listed in 9 | CONFORMS | todayApi.test.ts:2317-2941, 2416-2625; quietShares.test.ts (both boundaries) |
| 129 | Follow up tab regression with last_reached_out_at set | CONFORMS | followUps.test.ts / followUpsApi.test.ts "(PIN, WI1)" |
| 130 | Writer tests W1-W8 + exactly one post-stamp event; no-stamp tests incl. Retry of share, relay rung, non-intro announcements; W6 awaited seam; parsers refuse | CONFORMS | see row 106 test list; voiceOutbound.test.ts "PR87"; contactsCrud.test.ts:556 |
| 131 | Dashboard tests listed in 9 | CONFORMS | Today.test.tsx:311-560; QuietShares.test.tsx; TodaySection.test.tsx; Today.refetch.test.tsx |
| 132 | e2e: section order, quiet share drop after staff message, Tours to book | CONFORMS | e2e/tests/dashboard-next/today-checklist.spec.ts:322, 483, 533 |
| 133 | Existing pins updated deliberately (incl. #30 inversion) | CONFORMS | todayApi.test.ts:1227; unknown-caller-triage.spec.ts; participant-names.spec.ts (moved to a Tours to book row, still a falsifiable check) |
| 134 | Docs: GLOSSARY, 2026-06-16 supersede note, imported-unknown issue, read-cost issue, RUNBOOK | CONFORMS | GLOSSARY.md:739-782; 2026-06-16-new-dashboard-design.md:58-59; RUNBOOK.md:555 |

(134 rows: 131 CONFORMS, 3 PARTIAL - rows 23, 66, 120.)

## 2. Findings

### SC-1 (low) - "All caught up" can flash during a past-tours reload's labeling

- Spec: 2.3 "the message waits for the past-tours section to settle so it never flashes
  above rows about to appear"; 5.3 "The 'All caught up' settle wait covers this labeling".
- Code: dashboard/src/routes/today/useTodayPastTours.ts:162-172, 198-199 return the
  PREVIOUS labeled rows with status 'ready' while a newer `past` array is being labeled;
  dashboard/src/routes/today/Today.tsx:529-536 reads those rows.
- Scenario: Today is empty and reads "All caught up". A tour is marked toured in another
  tab; tour.updated reloads the Past loader, which returns one row. Until the tenant and
  property point reads land (one round trip), `past.rows` is still `[]`, so "All caught
  up" stays up (or, after a failed reload that just recovered, re-appears because
  `reloadFailed` is cleared by the raw load) and then the row appears under it.
- Status: already filed by the build as
  `docs/issues/today-past-tours-labeling-settle-window.md` (severity low, open). Visual
  and transient; nothing is lost. Acceptable to ship with the issue open.

### SC-2 (low) - Backfill Send-now rule is an exclude-by-body rule, and the "could not tell apart" count is incomplete for nudges

- Spec: 7.5 "tour reminder and placement nudge 'Send now' rows carry no marker. The plan
  picks one rule - an approximate join of each reminder or nudge's sent instant to the
  thread's row, or count them - and the dry run reports how many it could not tell apart."
- Code: app/scripts/backfill-last-reached-out.ts:95, 231-256, 283-287, 435-448.
  Any outbound 1:1 sms/mms whose body equals one of the four `nudge.*` catalog defaults,
  or equals the `sentBody` of any tour reminder sent in the window, is skipped; the time
  join is computed only to REPORT (`reminderBodyTimeMatched`), and for nudges there is no
  time join at all.
- Scenario A (over-exclusion): a staff member types or pastes the nudge text "Checking in
  - any decision yet on the application we sent over?" as their own follow-up on Oct 20.
  The backfill skips it (`excluded_nudge_body`), so that person has no
  `last_reached_out_at` and can show in Quiet shares up to 5 days early after deploy.
  Self-healing within the 14-day window; rare.
- Scenario B (reporting): the dry run reports `excluded_nudge_body` as a flat count;
  nothing says how many of those were genuine Send-now rows vs staff texts that merely
  match, which is the "could not tell apart" number the spec asks to see. For reminders
  the gap is derivable (`excluded_reminder_body - reminderBodyTimeMatched`) but not
  printed as such.
- This is a defensible approximate join (by body) and the plan may have ruled it
  (PR38 is cited in the code; the plan was out of scope for this review). Flag for the
  planner to confirm the rule was the one the plan picked; no code change required if so.

### SC-3 (info) - W2 treats a row with NO `automated` field as a person's send; the rest of the system treats it as automated

- Spec: 7.3 W2 "it does not stamp when the retried row is ... automated (`automated: true`)".
- Code: app/src/routes/api.ts:1914-1920 tests `original.automated !== true`; elsewhere a
  missing flag means automated (jobs/retrySend.ts:556 `retried.automated ?? true`,
  jobs/sendReconcile.ts:912, services/oneToOneRetryDecision.ts:119). The backfill mirrors
  the route (backfill:403).
- Scenario: a pre-retry-send-window automated row (no `automated` attribute) that failed is
  Retried by staff -> it stamps `last_reached_out_at`. Conforms to the letter of the spec;
  such rows predate the 14-day window, so practical impact is nil. Recorded so nobody
  "fixes" one side without the other.

### SC-4 (info) - Live W1/W2 and the backfill can name different contacts for the same 1:1 row

- Spec: 7.3 W1 stamps "the judged recipient (`heldRecipient ?? phoneContact`)"; 7.5
  "Recipient: the row's `recipient_contact_id` when present, else the one-to-one thread's
  contact".
- Code: services/sendMessage.ts:514-532 (live: phone-matched contact); backfill:453-455,
  470-472 (roster participant first, then phone, then email).
- Scenario: a thread whose roster contact is not the current holder of its phone number
  (a number moved between contacts). The live send stamps the new holder; the backfill
  stamps the roster contact. Both follow their own spec sentence; the divergence is only
  visible on such moved numbers. Info.

### SC-5 (info) - `consistentRead` reaches the core as an argument, not through FollowUpsDeps

- Spec: 6.1 "the option is added there ... passed through `FollowUpsDeps`".
- Code: services/followUps.ts:139-142 `collectWaitingFollowUps(deps, opts)`;
  routes/today.ts:1273-1276.
- Behavior is exactly what the spec wants (Today consistent, the tab unchanged); only the
  plumbing differs. No action.

### SC-6 (info) - A staff Retry of an AI-authored row stamps live but would not count in the backfill

- Spec: 7.3 W2 "as W1"; 7.5 "Every category requires ... `author` 'teammate'".
- Code: api.ts:1897 keeps `author: 'ai'` on a Retry of an AI row and still passes
  `staffOutreach`; backfill:317 skips `author !== 'teammate'`.
- Scenario: a Retry of a failed AI-drafted text before the deploy is not backfilled; the
  same Retry after the deploy stamps. Self-heals in 14 days. Info.

## 3. Behavior the spec does not ask for

None of these contradicts a spec rule; each changes observable behavior and should be
known at the merge decision.

1. Failed live refetch keeps the last good load (FW1-1): useToday.ts:156-169 sets
   `refreshFailed` instead of flipping to the error state; Today.tsx:557-565 shows new copy
   "We couldn't refresh Today. Reload the page to see the latest." and withholds All
   caught up (Today.tsx:531). Spec only defines a per-section failure and the fallback line.
2. Past tours: a failed reload after an empty load shows the section heading with the
   reload note and withholds All caught up (Today.tsx:329-357, 532). Extends 2.3.
3. Relay opt-out rows are de-duplicated to one row per member across groups
   (today.ts:791-817, 845). Spec 5.1 says these rows are "unchanged"; a member opted out of
   two groups used to produce two rows.
4. Identify merge: when both the unread pass and the triage pass see one contact, the
   triage read fills `who` and the rank into the unread row (today.ts:1144-1148,
   1390-1399). Spec 5.2 asks only for a phone de-dupe; this adds a contactId de-dupe.
5. Fallback Identify rows collapse to one per real contact id (buildToday.ts:255-304).
   Spec 3.1 says the fallback's "copy and unread rule stay the fallback's own"; the row
   set now differs from main's fallback for a contact with two unknown threads.
6. Closing the AI suggestions line drops its Show all expansion (Today.tsx:434-436,
   485-491).
7. Every Today list keys repeated `refType:refId` rows with `#2`, `#3` suffixes
   (Today.tsx:96-115) - key only, no visible change.
8. Copy refinements: singular "AI suggestions for 1 contact" (Today.tsx:412),
   "Requested 1 day ago" (today.ts:350), "1 day" in quiet text (QuietShares.tsx:63).
9. Tours to book's age renders as plain text, not the red urgency chip (Today.tsx:120-122).
10. Tour rows opened from Today (Tours to book, Tours today) carry router state so the tour
    page's back arrow returns to Today (Today.tsx:132-134, 382).
11. The 1:1 send service now uses the API router's contacts repo instead of
    default-constructing its own (routes/api.ts:694-709). Production-equivalent; changes
    what an injected `contactsRepo` fake reaches in tests.
12. A soft-deleted unit still labels a tour row with its address (today.ts:513-531).
13. W4 also stamps on a reconcile RE-DRIVE pass that sends a team leg for the first time
    (relayFanOut.ts:1691-1702, test "WI6"). Consistent with spec r7 "one per fan-out pass"
    but not named by the spec.
