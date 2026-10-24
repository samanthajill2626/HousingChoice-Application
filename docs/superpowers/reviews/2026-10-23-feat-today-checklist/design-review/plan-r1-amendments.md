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
