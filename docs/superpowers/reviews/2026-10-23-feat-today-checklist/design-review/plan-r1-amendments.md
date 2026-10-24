# Plan v2 - rulings PR41-PR93 applied into the slice text (PR83)

Plan: `docs/superpowers/plans/2026-10-24-today-checklist.md`. Every changed
step carries the ruling id in brackets. Sections 0-4 unchanged except WI7
(one phrase, PR92), WI8 (replaced, PR90) and the preamble status line
(PR83). 53 rulings: 23 applied, 30 already matched, 0 not applied; three
items for the planner at the end.

## Applied (slice text changed)

- PR54 - S3 C1: resolution marked RULED; the "explicit events in registerHandlers.ts" alternative struck.
- PR60 - S4 intro, S4 C4, S4.1 Step 0: element shape `{ contactIds, opts? }` binds; assertions read `call.opts?.*`.
- PR62 - S4.7 header and WI7 note tagged; S4.8 report WI7 line records both numbers for a changed pre-existing count.
- PR66 - S5 C4: "flagged for the planner" replaced by the ruling (now from nowIso).
- PR67 - S5 C5: the "planner may change one line" option struck; rule kept.
- PR70 - S6 C1 (with PR93): only reconcile relay-leg adoptions counted; no one-to-one adoption.
- PR76 - S7 C4, S7.8 GREEN, S7.17 report: constant fixed at "Open the Past tab"; a differing page is an S5 deviation to report, not a constant edit.
- PR77 - S5 cross-slice note: TODAY_TERMINAL is the seven checklist lists (not Tours today), All caught up, load-error alert; S7 C5 marked ruled.
- PR78 - S7 C6 marked APPROVED; S7.15 step 1 helper asserts endpoint host localhost/127.0.0.1 and prefix hc-local-<L>- (and the table name) before any command; struck-helper path removed.
- PR80 - S5 C7 marked ruled.
- PR81 - S2.6: founder-triage post-touch `contact.updated` (new 1c test in founderTriage.test.ts, new 3d edit, RED/GREEN/ASCII/commit); S2.8 inbound table row now "fixed"; WI4 row and coverage row added.
- PR82 - S4.1 1d: WI1 pin loops `call.opts?.requireComplete === true` and `call.opts?.consistentRead` undefined; S4.1 Step 4 mutation check proves it can go red; S4.8 report records the red run.
- PR83 - preamble status line; S2, S6 scope lines name the applied rulings.
- PR84 - S2.2: harness comment rewrite (new 3d), verified suite list (new 3e: apiRoutes R6 case + 1f, tourRemindersApi 1k, placementNudgesApi 1m; others shown not on the path), red-case rule, Files/GREEN/ASCII/commit; S1 and S2 cross-slice notes; S2.8 Step 3 diff check, WI2 and deliberate-changes lines; coverage.
- PR85 - S8.4 step 2: the two handback lines verbatim; S8 coverage line; S7 cross-slice note points at it.
- PR86 - S4.3: unitLabelOf uses the address for any present unit, WARN only on throw/absent; the deleted-unit case split into "soft-deleted shows its address, no WARN" and "absent shows unitId, one WARN"; RED list, commit message, S4 C2, coverage, S4 report line.
- PR87 - S2.4: gateApp takes a ResponseProbe (outer express app records the response); new case asserts the hand-off and the touch both saw a finished response; express import; RED and WI3 record.
- PR88 - S3.4 report: WI5 line records the ruling (one event per pass accepted).
- PR89 - S7.11: TODAY_TERMINAL error group adds "We couldn't load " (contains) and "Some sections can't load right now."; routes.test pin and source check, re-cite grep, comment, commit message; S7 C5 and S5 note.
- PR90 - section 3 WI8 replaced; S4.7 code comment; S4.8 report WI8 line; S7.14 cost issue paragraph and Step 0.
- PR91 - S2.2: W2 gate `original.automated !== true` (3c), spy case and harness case gain automated-row no-stamp halves, RED, commit, S2.8 report section and WI4 row, coverage. S6.1/S6.2: planner indexes in-window one-to-one rows per page first, skip kind `retry_of_system_copy`, counter `retryOriginOutsideWindow` (plan, result, syncCounts, runner test), two new cases (25 total), existing case pins the residue; S6.3 RUNBOOK counts and rows text; S6.4 report line; coverage row.
- PR92 - section 3 WI7 (one phrase); S4.7 WI7 note; S4.8 report unread-walk line; S7.14 Step 0 and cost issue paragraph; S7 cross-slice note.
- PR93 - S3.4 report stranded-arm line; S6 C1; S6.3 RUNBOOK paragraph (adopted relay legs counted, stranded legs invisible); S6.4 report line.

## Already matched (no slice change needed)

- PR41 - S1 C1 / S1.2 already name exactly the five full ContactsRepo literals; dev rigs in S2.5.
- PR42 - S1.5 already stubs the three ConversationsRepo literals.
- PR43 - S1.7 already updates the two contactTriage pins and both comments.
- PR44 - S1.6 already uses PR5's signature.
- PR45 - S1.5 getByIdConsistent already filters nothing and says so.
- PR46 - S2.5 already gates W8 on direction outbound only (PR14's author test absent).
- PR47 - S2.5 helper already returns undefined for relay_group / group_text.
- PR48 - S2.4 already builds a second app with buildApp; harness untouched for it.
- PR49 - S2.7 already updates toursApi ~585, ~1402-1412 and toursReopenApi ~492.
- PR50 - S2.2 1a-1c already add staffOutreach to the three call-shape pins.
- PR51 - S2.1 already stamps at result.providerTs.
- PR52 - S2.7 already names the router local eventBus.
- PR53 - S2.2 1l/1m already assert no staffOutreach on the poll inputs.
- PR55 - S3.1 already sets sentAt in exactly the three return literals; loop needs kind and sentAt.
- PR56 - S3 notes and S3.4 report already keep the member-added bus and record skipped_terminal.
- PR57 - S4.6/S4.7 already inject the prefixed units/listing-sends repos and assert ok.
- PR58 - S4 C2 and the failure tests already log err plus section/counts and assert no names.
- PR59 - S4.5 already re-expresses the ~13 cases and S4.8 names them.
- PR61 - S4.5 and S4.8 sweep already drop isOneToOneBucket from today.ts.
- PR63 - S5.2/S5.3 already export and use isOffRangePastTour (PR35's selectPastTours text absent).
- PR64 - S5 C2 already follows spec 2.1 and inverts the pins; raising it with Cameron is a planner act.
- PR65 - S5 C3 / S5.1 already take a level prop; At a glance h2, Tours today h3.
- PR68 - S5 C6 already uses the spec copy.
- PR69 - S5 intermediate-states note already keeps 'unreplied' from S5.4 to S5.6.
- PR71 - S6 C2 already follows PR38 and records the approximation.
- PR72 - S6 C3 / planRow already route author system before the teammate test.
- PR73 - S7.10 already scopes the absence to Tours today and adds the Tours to book check.
- PR74 - S7.7 already reuses the scenario's requested tour, asserted by tour link.
- PR75 - S7.2 already adds expectNoAiSuggestionFor, used by caseworkers and conversation-fact-extraction.
- PR79 - S7.13/S7.14 already fix the GLOSSARY, STATUS-MODEL and public-signup drift; resolved issues untouched.

## For the planner (not ruling changes)

- S2.2 draft defect, outside every ruling: the harness cases 1f (three), 1k and 1m (Send now) assert `world.sent` / `world.sentDetails`, but api.ts builds its default `createSendMessageService` with no `adapter` (api.ts:694-703; S2.2 3a keeps that), so the service builds its own driver from config (sendMessage.ts:424) - the console driver under the harness (`MESSAGING_DRIVER: 'console'`, twilioWebhookHarness.ts:5631). World.sent stays empty and those cases fail at GREEN. Needs a ruling (for example pass the router's `adapter` into the service in 3a, which in production is the same config-built adapter) before S2.2 can be built. Not changed.
- PR89 placement: the ruling names the two locators but not the terminal group. Applied in the ERROR group, following `e2e/performance/routes.ts:506` (a plain "Couldn't load our number." text is an error terminal there); populated would mislabel and empty would make a fallback page with rows contradictory_terminal. Confirm or re-rule.
- PR86 vs PR24: with no deletion test left in `unitLabelOf`, nothing in today.ts uses the units repo's `isDeleted`, so S4.3 no longer imports it (an unused alias would fail gate 5). PR24's alias rule is moot, not reversed.

## Launch-gate write-through (PR102-PR105)

Plan v4 @74a7a886 -> this commit. Spec r8. Every changed step is marked with its ruling id.

Sections 0-4:
- PR102 - section 1 "Every section shows 5 rows" bullet: headings carry no count; PR33 rewritten to a bare `<h2>` with the count in "Show all N"; PR35's "section's count" names Show all; PR64 marked "(superseded by PR102)".
- PR103 - PR23's builder signature returns `{ properties }` and its "Order and `people`" sentence; PR30's response drops `people`.
- PR104/PR105 - PR91 marked "(gate and backfill rule superseded by PR104 / PR105)"; PR100 marked "(superseded by PR104, PR105)".

S2 (PR104):
- S2 scope line names PR104 and the new task (and the round-1 rulings the earlier scope edit missed).
- NEW Task S2.1a - `NewMessage.systemCopy` / `MessageItem.system_copy` with doc comments; true-only append mapping beside `automated` (the `received_on_closed_thread` pattern); `SendMessageInput.systemCopy` destructured and persisted; DynamoDB Local round-trip case and two sendMessage.test.ts cases; RED/GREEN/ASCII/commit. The harness messages fake is NOT edited (PR37).
- S2.2 header and Files - the PR104 gate, the marker writers, the two job files.
- S2.2 1b/1c - comments: a plain Retry stamps and carries no marker (the exact toEqual pins it).
- S2.2 1e - PR91's case replaced: share (no stamp, no marker), automated (no stamp, systemCopy), Send-now row (no stamp, systemCopy), Retry of a manual retry of an automated text (no stamp, systemCopy; stored retry_root so no parent walk), plain x2 (stamps, no marker).
- S2.2 1f - the harness Retry case adds a failed Send-now row (system_copy seeded on the world row) that does not stamp.
- S2.2 1l/1m - the poll cases assert no systemCopy marker.
- S2.2 new 1n - both Send now spy cases assert `systemCopy: true` and no staffOutreach.
- S2.2 RED list, 3c (Retry: systemCopy when automated or system_copy; the new W2 gate replacing PR91's), new 3c2 (forceSendReminder / forceSendNudge pass `systemCopy: true`), GREEN adds the two jobs suites, ASCII/add/commit file lists and message.
- S2.8 report - "W2 Retry gate" section rewritten to PR104 (PR91's and PR100's residues "closed by PR104"; the harness-fake note); WI4 row adds the system-copy Retry.
- S2 coverage - three rows (S2.1a marker; W2 gate; Send now marker and poll no-marker).
- S7.12 - the ContactUpdatedEvent doc text: Retry of a row "neither a share, automated nor system copy".

S4 (PR103):
- S4 cross-slice wire note - `TodayQuietShares` without `people`.
- S4.2 - description, test header, the two `out.people` asserts removed, the distinct test renamed to "a row under each; properties only", empty results `{ properties: [] }`, wire-row toEqual without `people`, builder doc/signature/`distinct` set removed, commit message.
- S4.7 - header note; `{ status, properties, truncated }` everywhere (EMPTY and three toEquals); the two full toEquals drop `people`; the three `people: 1` matches become a one-person `properties` match; "counts once" title; RED text; `TodayQuietShares` type, route body and the `quiet_share_people` log field removed.
- S4 coverage row - PR103.

S5 (PR102, PR103):
- S5 C2 - ruled by PR102 (no `.count`, pins stay); C6 "not its count chip"; S7 cross-slice notes - bare headings, exact names.
- S5.1 - description and Files; tests: bare-label heading (`toHaveTextContent(/^Tours to book$/)`), failed-section case renamed, h3 name bare; component: no `count` prop or element; 3b struck (`.groupHeading` untouched); 3c drops `.count`; GREEN notes the untouched 08-03 pins; commit message.
- S5.3 - two comments: Show all N counts the rows, no heading count.
- S5.4 - probe string `ok:<properties>:<truncated>` and expectation `ok:1:false`; QUIET fixture drops `people`; `TodayQuietShares` mirror drops `people`.
- S5.5 - description; `ok()` helper drops `people`; heading test asserts the bare "Quiet shares"; component comment; `TodaySection` without count.
- S5.6 - fate table rows (bare labels kept; nag case and past-tours-alone case unchanged); a note that the 2026-08-03 pin lines ~166-169 are copied byte-for-byte (line ~167's em dash as `[U+2014]`); every counted heading name made bare; `quietOk` drops `people`; the Quiet shares page case; RED bullet; Today.tsx's four `TodaySection` calls drop `count` and the header comment; ASCII step checks Today.test.tsx on added lines plus a grep that the pin line survived; commit message.
- S5.7 report C2 line and risks; S5 coverage row.

S6 (PR105):
- S6 scope line - PR105 replaces PR91's rule; depends on S2.1a.
- S6.1 tests - the PR91 case replaced by the PR105 case (a marked row skipped; retried row OR chain root judged; root-only exclusion; retried-row-seen-root-absent counts without residue; both-absent residue); page case retitled; existing case's residue comment.
- S6.1 code - header comment; SKIP_KINDS gains `system_copy`; `retryOriginOutsideWindow` and `windowOneToOne` docs; `isSystemCopy` reads `system_copy`; planOneToOneRow skips a marked row and checks `retry_root` beside `retry_of`; planThreadPage doc; result-field doc; GREEN count note.
- S6.3 RUNBOOK - the rows-count sentence, the `retry_of_system_copy` / `system_copy` counter text, the `retryOriginOutsideWindow` text.
- S6.4 report line and S6 coverage row - PR105 replaces PR91's rule and PR100's residue.

S7 (PR102, PR103):
- Cross-slice note (heading accessible name is the heading text), relay-lifecycle note, `todayList` doc comment, selectors.md row text.
- S7.2 - the wire type drops `people`; both `wire.quietShares?.people` asserts become `not.toHaveProperty('people')`; the two Quiet shares heading `toContainText` count checks become exact-name visibility.
- S7.8 - the Past tours heading `toContainText('7')` becomes an exact-name check (the count is in "Show all 7").
- S7.13 GLOSSARY text - no heading count; S7.16 live QA - the heading reads exactly "Quiet shares".

Not applied / for the planner:
- None of PR102-PR105 left unapplied. Two choices to confirm: (1) PR104 does not name the harness messages fake; it is left as is (PR37), so it drops `systemCopy` and the harness case sets `system_copy` on the world row directly. A planner may prefer mapping it there too. (2) PR102 "pins stay exactly as they are" inside a whole-file rewrite: the pin comment line ~167 holds an em dash, so S5.6 tells the builder to copy that one line from the current file, and the Today.test.tsx ASCII check moves to added lines.
- PR106 - section 4 gains PR106 and the header range reads PR1-PR106; S2.1a: the harness fake `append` maps `systemCopy` true-only (new step 3c2, Files list, a twilioWebhookHarnessRetryFields.test.ts case, RED/GREEN/ASCII/commit); S2.2 1f seeds the Send-now row through the fake's append and asserts `system_copy` on the rows the Retry route wrote (automated and Send-now retries marked, plain unmarked); 1k / 1m assert the marker on the row Send now wrote (no longer PINs; RED text updated); S2.8 step 3 allows the PR106 harness hunk; S2 report line and coverage row. Choice 2 (em-dash pin line copied verbatim, ASCII on added lines) confirmed as written.
- PR107 - section 4 gains PR107 and the header range reads PR1-PR107; section 2's work map: S6 depends on S1 and S2 (R3-2); S2 scope line names PR106 and PR107; NEW Task S2.2a after S2.2: `retrySend.ts` passes `systemCopy` when the retried row is system copy and `adoptRetry` writes it on the adopted row (beside `automated`), with three RED-first tests (automatic retry of a system-copy row marks the new row; reconcile adoption marks the adopted row; end to end Send-now row -> automatic retry -> staff Retry of the newest row never stamps and stays marked) plus a stricter case-10 absence; S2.8 report line and S2 coverage row.
