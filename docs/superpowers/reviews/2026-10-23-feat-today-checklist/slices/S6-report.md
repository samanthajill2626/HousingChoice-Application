# S6 report - the last_reached_out_at backfill (script, tests, RUNBOOK)

S6 base: 97f849f1. Commits, in order: 6ca988a2 (S6.1), 24a3ccd3 (S6.2),
c49a51b5 (S6.3), then this report. Line numbers below are at c49a51b5;
"main" marks a line at main @970a29b9.

## What the tree held that the plan got wrong, and every divergence taken

- No anchor drift and no code divergence. Both new files are byte-identical
  to the plan's text: the S6.1 blocks plus the S6.2 import-block edits and
  appends were reassembled from the plan and diffed against
  `app/scripts/backfill-last-reached-out.ts` and
  `app/test/backfillLastReachedOut.test.ts` (no difference). Every import
  the plan names exists with the type it assumes; no row shape in the tree
  contradicts a filter (spot-checked at c49a51b5 below, beyond D6's main
  read).
- Test runs: bare, with DynamoDB Local up (container hc-dynamodb-local),
  never with `ALLOW_SKIP_DYNAMO_TESTS` (the orchestrator's brief forbids it;
  the plan only allowed it). The file touches no database.
- RUNBOOK entry (WL-18, the worklist wins over PR38's "same six steps"): a
  new step 2, "Reload the open dashboards", BEFORE the dry run, carrying
  WL-18's sentence verbatim; the later steps renumber 3-7
  (RUNBOOK.md:568, steps at :567-583).
- RUNBOOK entry (brief item 5, the S3 W7 finding): the plan's "Two more
  differences from the live stamps, both accepted" paragraph reads "Three
  more differences ..., all accepted" and gains the staff-edited intro
  slot-write sentence beside the PR93 stranded-leg note (RUNBOOK.md:563).
  Apart from that and the renumbering, the entry is the plan's text
  (diffed).
- S6.3 commit message: one body line added (names WL-18 and the W7 note).
- Not taken (optional per the plan's cross-slice note): swapping in S2's
  `oneToOneThreadContactId` (`app/src/lib/heardFrom.ts:103-119`).
  `oneToOneContactOf` (`app/scripts/backfill-last-reached-out.ts:470-472`)
  asks `attributeInbound` about a synthetic inbound sms, and
  `attributeInbound` delegates to that helper for every non-group thread
  (`heardFrom.ts:94`), so the rule is the same one.
- WL-17's voice.ts lines, re-checked in this tree (S2 shifted the file): the
  outbound press-1 `answeredAt: dialAt` write is `voice.ts:1743` (main
  :1676); the /status Dial in-progress summary fallback writes
  `answeredAt: now` at `voice.ts:2033` under `stampAnsweredAt` (`:1976`;
  main :1961 / :1904). The plan's second citation (main :1747, now
  `voice.ts:1819`) is the inbound accept branch and is dropped.

## Contradictions as ruled

- C1 (PR70 as amended by PR93): the backfill COUNTS a relay leg the send
  reconcile adopted, though the live writer skips it (S3 PIN
  `sendReconcile.test.ts:2209`). The adoption writes the slot as
  `sid: m.providerSid, sentAt: m.sentAt ?? m.createdAt`
  (`app/src/jobs/sendReconcile.ts:1039-1042`, `adoptRelay` at :1026), the
  exact shape `planSentSlots` counts (`backfill-last-reached-out.ts:343-357`).
  There is no one-to-one reconcile adoption: the owner kinds are
  `broadcast`, `relay_leg`, `relay_rung`, `retry_send`
  (`sendReconcile.ts:145-154`, `:186-203`), and `adoptRetry` (:891) appends
  `retryAttempt` / `retryWindowStart` (`:940-941`), so its rows skip as
  `machine_retry` (`backfill-last-reached-out.ts:405`). In the RUNBOOK
  entry (RUNBOOK.md:563).
- C2 (PR71) extended per WL-17: email rows (`services/sendEmailMessage.ts:396-412`)
  and call rows (`services/originateCall.ts:171-191`) carry no
  `recipient_contact_id`, so the backfill names the thread's contact; live
  W3 names the ADDRESSED contact - they differ on a shared address (email
  only). More broadly, the backfill names the thread's write-once
  participants contactId first (`heardFrom.ts:108-109`; participants are
  set once, `conversationsRepo.ts:1729` `setParticipantsIfAbsent`, never
  refreshed), then findByPhone, then findByEmail, and the group-text rule
  takes the roster before findByPhone (`backfill-last-reached-out.ts:386-394`).
  The live writers judge the phone's CURRENT holder: W1
  `sendMessage.ts:514` / `:532` (`heldRecipient ?? phoneContact`), W5
  `groupSend.ts:327` (findByPhone per member), W6 `voice.ts:1347`
  (`resolveOutboundTarget`, :1337). So with stale participants (a number
  later held by another contact, or duplicate contacts on one phone) a staff
  text with no `recipient_contact_id`, a group-text member or a call can be
  stamped on a different contact than live. Accepted approximation (PR38
  order); no code change.
- C3 (PR72): `planRow` routes `author === 'system'` to the edited-intro rule
  (`backfill-last-reached-out.ts:316`) before the teammate test (`:317`);
  the announcement row is `author: 'system'`,
  `relaySenderKey: SYSTEM_SENDER_KEY` (`services/relayAnnouncements.ts:300`,
  `:304`). Every other non-teammate author skips as `not_teammate`.

## PR38 rule picks as built

- `introRule: 'body_match'` (`backfill-last-reached-out.ts:94`): a system
  row on a relay_group whose body IS `thread.intro_body` (`:327-338`). The
  edited intro goes out verbatim (`jobs/relayFanOut.ts:1106-1115`,
  `body = edited`), so the match is exact.
- `sendNowRule: 'exclude_by_body'` (`:95`): the four `nudge.*` catalog
  defaults (`nudgeBodySet`, resolved at run start) and the `sentBody` of
  every tour reminder sent in the window (one Scan, `:564-586`); the
  time match is `REMINDER_TIME_MATCH_MS` = 10 minutes AFTER the reminder's
  `sentAt` (`:92`, `:441-446`), reported as `reminderBodyTimeMatched`.
- Email: `failed` is tested FIRST (`:430`), then counted when
  `ses_message_id` is present or the status is sent / delivered /
  undelivered (`:114`, `:431-433`); queued (or queued_pending) without an
  SES id skips as `email_queued`.
- Calls: counted on `answered_at` or `call_outcome`; the instant is
  `answered_at` when present, else the row providerTs (`:426-428`).
- Relay team posts and edited intros: contact-keyed slots with a `sid` and a
  `sentAt`, at `slot.sentAt` (`:343-357`); `phone#` slots skip as
  `relay_phone_slot`.
- Group texts: every slot not `excluded`, at the row providerTs
  (`:361-383`).
- Window: `WINDOW_MS` = FOLLOW_UP_LOOKBACK_MS (14 days, `:88`), key floor =
  window start - 1 hour (`:90`); every row re-checked on its normalized
  providerTs. Query: `conversationId = :c AND tsMsgId >= :floor`, filter
  `#dir = :outbound` (`:626-627`).

## Checked, not contradictions (evidence at c49a51b5)

- Email failed vs bounce: a bounce sets `undelivered`
  (`app/src/services/emailEvents.ts:10`); `failed` is written only when
  `adapter.send` threw (`sendEmailMessage.ts:478`), before any SES id.
- No persisted auto-replies or opt-in / opt-out confirmations: "NO REPLY IS
  COMPOSED HERE" (`routes/webhooks/twilio.ts:1256`).
- Automated sends pass `automated: true`: missed-call text
  (`jobs/missedCallAutoText.ts:256`), welcome text (`routes/public.ts:655`),
  tour reminder poll (`jobs/tourReminders.ts:1440`), nudge poll
  (`jobs/placementNudges.ts:676`). The two Send now paths pass
  `automated: false` and, since S2, `systemCopy: true`
  (`tourReminders.ts:2004`, `:2008`; `placementNudges.ts:860`, `:864`).
- The nudge Send now body is `resolveMessage` of the id `nudge.<kind>` with no
  override map (`placementNudges.ts:856`); the four entries are
  `editable: true` with `vars: []` (`app/src/messages/catalog.ts:206-238`),
  so the default is always what went out. If an org override is ever wired
  into that call, the body exclusion misses it.
- The tour reminder Send now snapshots `body` as `sentBody` in the same
  claim (`tourReminders.ts:1968`; `repos/tourRemindersRepo.ts:348-386`), so
  the body match is exact. A group-route reminder is a relay announcement
  (`author: 'system'`) and lands in `system_other`.
- Quo rows: `author: 'staff'` (`lib/import/apply.ts:473`, outside
  `MessageAuthor`, `repos/messagesRepo.ts:111`) and
  `imported_from: 'quo-airtable-import'` (`apply.ts:60`, `:482`, `:518`);
  `imported_from` is tested before the author
  (`backfill-last-reached-out.ts:308`).
- A relay 30003 retry row mirrors the original's direction and author and
  sets `relay_retry_of` (`routes/webhooks/twilio.ts:3087-3088`, `:3108`);
  it skips as `relay_retry` (`backfill-last-reached-out.ts:315`) before the
  team-post rule.
- A staff Retry carries `retry_of` and `retry_root` only
  (`routes/api.ts:1899`, `:1903`); the automatic retry also carries
  `retry_attempt` / `retry_window_start` (`services/sendMessage.ts:697-701`),
  so a staff Retry is never mistaken for `machine_retry`.
- Instants match the live writers: W1 / W3 the row providerTs (W3 appends at
  `providerTs: nowIso`, `sendEmailMessage.ts:399`); W4 the slot `sentAt` is
  `result.providerTs` (`jobs/relayFanOut.ts:2279`); W7 likewise
  (`services/relayAnnouncements.ts:418`); W5 `posted.dateCreated`, the row
  providerTs (`services/groupSend.ts:662`, stamped normalized at `:718`);
  W6 the press-1 instant = `answered_at` (`voice.ts:1743`), with the Dial
  in-progress summary (`voice.ts:2033`) as the fallback writer - a LATER
  instant (bridge connect) when the best-effort press-1 write failed.
- Outbound email has one writer (`sendEmailMessage.ts:400`); no automated
  email row exists to filter.

## Known gaps (all recorded in the RUNBOOK entry)

- Queued relay post (RUNBOOK.md:561): a team post queued on a connecting
  group MORE than 14 days ago keeps its queue time as its key
  (`routes/api.ts:1984-1985`, `providerTs: queuedTs`), so legs that went out
  inside the window sit below the key floor and are not read.
- [PR93] Stranded-after-send relay leg (RUNBOOK.md:563): stamped live (S3,
  the `{ kind: 'stranded', afterSend: true, sentAt }` arm,
  `jobs/relayFanOut.ts:2370`, a deliberate widening of spec 7.3 W4) but its
  slot may carry no `sid`, so the backfill cannot see it.
- Staff-edited intro slot write (brief item 5, S3 report finding; RUNBOOK.md:563):
  W7 collects the stamp right after the provider accepts the leg
  (`relayAnnouncements.ts:391-393`), before the slot write (`:415`) and the
  relaysid pointer (`:425`); when the slot write throws, the catch marks the
  slot failed with an errorCode and no sid (`:436-437`). The live stamp
  (written after the loop) stands; the backfill reads that slot as
  `slot_not_sent`. Same class as PR93.

## [PR105] the system-copy and manual-retry rules as built

- `system_copy`: a row marked `system_copy: true` never counts
  (`backfill-last-reached-out.ts:408`; the marker is S2's,
  `messagesRepo.ts:1090`, written true-only).
- `retry_of_system_copy`: a staff Retry (`retry_of`) is excluded when its
  retried row OR its chain root (`retry_root`) is among the thread's window
  rows and is automated, system copy or a Send-now body (`:283-287`,
  `:409-421`). The page is indexed first (`indexOneToOneRow`, `:290-295`), so
  a retried row later in the same page or on an earlier page is judged.
- `retryOriginOutsideWindow`: a staff Retry whose retried row and root are
  both absent from the window counts and is reported as residue (`:421`,
  `:458`).
- Cases: "PR105: system_copy rows never count; a staff Retry is excluded
  when its retried row or chain root in the window is system copy; otherwise
  it counts" and "PR91 / PR105: the retried row is judged whether it sits on
  an earlier page or later in the same page"
  (`app/test/backfillLastReachedOut.test.ts:237`, `:282`).
- The live residues PR91 and PR100 recorded are closed by PR104 (S2); PR108
  (pre-deploy rows carry no marker) is covered here by the root and body
  rules.

## WI12

- The agent did NOT run the CLI in S6, against anything (no lane, no
  `--env` of any kind). The RUNBOOK entry (RUNBOOK.md:553-587) says Cameron
  runs it, dev then prod, after the deploy, dry run first; the lane
  rehearsal is S7.15's.

## Tests

- `app/test/backfillLastReachedOut.test.ts`, 31 cases: the window and the
  plan shape 2; one-to-one texts 6; emails and calls 2; relay team posts 2;
  group-text posts 1; staff-edited relay intros 2; tour reminder and nudge
  Send now 4; what never counts, and the window 6 (planner 25); the runner 6.
- The PII case ("logs counts and ids only - never a body, a phone, an
  address or a name", `:966`) captures both a successful apply and an
  aborted one and asserts none of `SECRET`, `Secret`, `+1555`, `x.test`,
  `ses-1` reaches any log line.
- RED seen: S6.1 the file failed to load ("Cannot find module
  '../scripts/backfill-last-reached-out.js'", no tests, exit 1); S6.2 the six
  runner cases failed with "TypeError: (0 , backfillLastReachedOut) is not a
  function", 25 planner cases green (6 failed | 25 passed). GREEN: S6.1 25
  passed; S6.2 31 passed plus the twin's 16 (2 files, 47 passed).

## Gates (fast gates only, as briefed)

- `npm run typecheck` (bare, root): exit 0 after S6.1, S6.2 and at S6.4.
- `npx vitest run test/backfillLastReachedOut.test.ts test/backfillLastHeardFrom.test.ts`
  (bare, app/): exit 0; Test Files 2 passed (2); Tests 47 passed (47). No
  `[dynamoAdmin]` line.
- `npx eslint app/scripts/backfill-last-reached-out.ts app/test/backfillLastReachedOut.test.ts`:
  exit 0, no output (both are .ts, so the config really lints them). No red
  file, no lint error.
- ASCII: both new files 0; the RUNBOOK.md added lines of c49a51b5 0. No
  `\u` escape in either new file.
- Not run (brief): root `npm test`, `npm run e2e`, `npm run smoke`.

## The CLI, for the S7.15 rehearsal

- `npx tsx app/scripts/backfill-last-reached-out.ts --env local|dev|prod [--lane <L>] [--apply]`
  (`backfill-last-reached-out.ts:686-725`); no package.json script.
  DRY RUN by default; `--apply` writes. `--lane` only with `--env local`
  (positive integer; database `hclane<L>`, prefix `hc-local-<L>-`). An
  unknown, repeated or malformed argument prints the usage and exits 2.
- Exit codes: 0 the run completed (dry run or apply); 1 a failed touch or a
  mid-run read error (a `PARTIAL result` ERROR line first), or the target
  could not be resolved (nothing read); 2 usage.
- Log lines: `backfill-last-reached-out - starting` (target, endpoint,
  prefix, apply), `... - planned`, then `... - done (DRY RUN - nothing
  written)` or `... - done`. Counters: windowStart, keyFloor, introRule,
  sendNowRule, conversationsWalked, pointerRows, messagesRead,
  remindersInWindow, counted {text, email, call, relay_team_slot,
  group_text_slot, edited_intro_slot}, rowsSkipped {inbound, imported,
  outside_window, relay_retry, system_other, not_teammate, group_other,
  automated, share, machine_retry, retry_of_system_copy, system_copy,
  call_not_dialed, email_failed, email_queued, excluded_nudge_body,
  excluded_reminder_body, other_type, no_recipient, relay_phone_slot,
  slot_not_sent, group_excluded_slot, group_unresolved_slot},
  reminderBodyTimeMatched, retryOriginOutsideWindow, unparseableInstants,
  planned, written, skipped, failed, apply.

## Risks and notes for later slices

- The script imports `isPointerConversation` from
  `app/scripts/backfill-last-heard-from.ts` (`:79`); that twin must not be
  renamed or deleted while this script lives.
- The run reads the `tourReminders` table (`tableName('tourReminders')`,
  the repo's own name, `repos/tourRemindersRepo.ts:264`); a lane missing it
  aborts with a PARTIAL report.
- Spec 7.4 holds: the field is shown nowhere, but GET
  /api/contacts/:contactId returns the full item
  (`app/src/routes/contacts.ts:1277-1299`), so the RUNBOOK's step 6 console
  check reads it.
