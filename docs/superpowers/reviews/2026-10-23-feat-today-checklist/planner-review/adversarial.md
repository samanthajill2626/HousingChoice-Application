# Planner review - adversarial (plan-blind), feat/today-checklist

Reviewer: independent adversarial code review, diff + repo only (no spec, plan or
review records read). Base main @970a29b9, review tip 4508f61f. Read-only: no
test, build or npm command was run; every finding below is from code reading.

Scope read: every non-test source file the branch touches under app/src,
app/scripts, dashboard/src, plus RUNBOOK.md and the new
docs/issues/today-quiet-shares-read-cost.md (to avoid re-reporting a filed
cost); then the other consumers of the state the branch reads or writes
(contact.updated and tour.updated listeners in the dashboard, every
sendMessage caller, every tours.create / requested-tour reader, every
last_heard_from_at writer, contactsRepo whole-item writes, the voice status
callback's call_outcome writers for the backfill's call rule).

## Counts

- blocking: 0
- high: 0
- medium: 0
- low: 3
- info: 4

## Findings

### ADV-1 - low - Quiet shares: a truncated walk can read "All caught up", and the truncation note describes the wrong thing

- dashboard/src/routes/today/Today.tsx:509, :516, :521-536;
  dashboard/src/routes/today/QuietShares.tsx:179, :206;
  app/src/services/followUps.ts:155 (the cap); app/src/routes/today.ts:1281.
- What: `truncated` means "more than 100 AVAILABLE properties exist, so only
  the first 100 (in byStatus GSI order, which is arbitrary) were walked". Two
  consequences:
  1. When the walk truncates and none of the first 100 walked properties has a
     quiet person, `properties` is empty, QuietSharesSection returns null at
     :179 BEFORE the truncation note at :206 can render, `quietProperties` is 0,
     and `anyUnavailable` does not consider `truncated` - so `allCaughtUp` can be
     true while properties 101+ were never read.
  2. When it renders, "Showing the first 100 properties" sits under a section
     that lists only the quiet property LINES (often a handful), so it reads as
     if up to 100 lines are on screen. The Follow up tab says the accurate thing
     ("Showing follow-ups for the first 100 available properties.",
     FollowUpView.tsx:232).
- Scenario: 120 available properties; the 40 with quiet people all fall past
  the walk's first 100 -> Today shows no Quiet shares section, no note, and
  "All caught up" with 40 properties of quiet people unseen.
- Confidence: CONFIRMED by code trace (needs >100 available properties; prod
  holds tens today, so low).
- Suggested fix: treat `truncated` as "not settled" for All caught up (or
  render the note even with zero lines), and reuse the Follow up tab's wording.

### ADV-2 - low - the staff-outreach stamp keys on provider ACCEPTANCE, so an undelivered staff text or bounced email still restarts the quiet clock

- app/src/services/sendMessage.ts:770-779 (stamp at `result.providerTs` right
  after append); app/src/services/sendEmailMessage.ts:489 (stamp right after SES
  accepts); jobs/relayFanOut.ts stamps per accepted leg.
- What: the stamp is written when Twilio/SES accepts the message; nothing
  revisits it when the message later fails (30003 / 30005 / 30007 carrier
  filtering, an SES bounce). `quietSince` takes that stamp
  (services/quietShares.ts), so the person leaves Quiet shares for 2 days
  (replied) or 5 days (no reply) although the follow-up never arrived.
- Scenario: a share recipient goes quiet; staff texts from the Follow up tab;
  the carrier filters it (30007, not an `sms_unreachable` code, so
  isEligibleRecipient still keeps the contact). The row leaves Quiet shares on
  the refetch and does not come back for 2-5 days; the only trace is the failed
  bubble on the thread.
- Confidence: PLAUSIBLE as a product gap (it may be the intended rule - the
  spec was not read); the code path is CONFIRMED.
- Suggested handling: if intended, say so in the Quiet shares help line or the
  issue registry; otherwise exclude rows whose delivery ends failed/undelivered
  (would need a reader that ignores the stamp when the stamping row failed - a
  larger change, so file it rather than fix it here).

### ADV-3 - low - an unresolvable owner read turns a KNOWN contact's imported unknown_1to1 thread into an Identify "New unknown contact" row

- app/src/routes/today.ts:984-990 (owner test skipped when `getContact` returns
  undefined), with getContact (today.ts, the request cache) degrading any read
  error to undefined.
- What: the owner test keeps a thread when its owner "cannot be resolved (no
  contact item, or a failed read)". A throttled or failed `contacts.getById`
  for a TENANT whose imported thread is still typed unknown_1to1 therefore
  emits an Identify row for that tenant, under the help line "Call each one;
  after about a week with no contact, mark them Inactive." The triage-pass
  merge cannot correct it (a tenant is not in the needs_review partition).
- Scenario: one transient ProvisionedThroughputExceeded on the getById for a
  tenant with an unread imported thread -> that tenant appears in Identify
  until the next refetch. The VA following the help line may act on a known
  tenant (the link opens the tenant's page, which makes the mistake visible,
  hence low).
- Confidence: CONFIRMED by code trace; the fail-open choice is documented in
  the comment, so this is a judgment call, reported because the downstream copy
  now invites an action (Inactive) the old "Needs you now" row did not.

### ADV-4 - info - the email stamp sits between SES acceptance and the SES-id alias write

- app/src/services/sendEmailMessage.ts:489 (stamp) before the alias write
  (step (a), recordProviderSidAlias).
- What: one extra awaited UpdateItem now runs before the alias that lets SES
  delivery/bounce/complaint events find this row. The B5 parking path
  (step (c)) covers bounces and complaints that arrive early, and SES events
  normally arrive seconds later, so no loss was traced - but nothing requires
  the stamp to come first; it only widens the pre-alias window.
- Suggested fix (trivial): move the `recordStaffOutreach` call down beside step
  (d) (it is already best-effort and its event is emitted last anyway).
- Confidence: PLAUSIBLE, negligible in practice.

### ADV-5 - info - new contact.updated triggers widen the known pane-override race on the contact page

- dashboard/src/routes/contact/useContact.ts:75 (consistent re-read on every
  contact.updated naming the open contact);
  dashboard/src/routes/contact/ContactCommsPane.tsx:109 (`setOverride(null)` on
  any new `contact` identity); docs/issues/pane-override-stale-refetch-race.md.
- What: every staff text, email or outbound call from the contact page now
  emits contact.updated (W1/W3/W6), so the page now re-reads the contact after
  each of its own sends. A re-read still in flight when the operator then adds
  an email address in EmailManager can land with the pre-change contact and
  clear the pane's override, reverting the email channel gate until the next
  refetch. Display-only and self-healing (every send is re-checked server
  side), the same class the filed issue already accepts - noted so the issue
  can list the new trigger.
- Confidence: PLAUSIBLE (narrow window, ~one consistent GET).

### ADV-6 - info - "AI suggestions for N contacts" states a count the server caps at 20

- dashboard/src/routes/today/Today.tsx:412; app/src/routes/today.ts:1179
  (AI_SUGGESTIONS_ITEM_CAP = 20) plus listPending's limit of 100 suggestions.
- What: with more than 20 contacts holding pending suggestions the line reads
  "AI suggestions for 20 contacts". The cap predates the branch; the new copy
  just states the number as a fact.
- Confidence: CONFIRMED; pre-existing cap.

### ADV-7 - info - Today's read cost and event fan-out

- Already filed in full by the branch (docs/issues/today-quiet-shares-read-cost.md:
  the Follow up core on every load, the consistent BatchGet, the uncapped
  requested-tours walk, the 2000-item unread walk, the Past-row re-labels on
  every tour.updated, the new contact.updated / tour.updated emitters). One
  detail the issue does not name: useToday aborts the in-flight request on each
  new debounced refetch (useToday.ts fetchNow), but the server keeps computing
  an aborted request, so under a steady event stream the server pays for loads
  no client reads, and a slower Today (now several hundred ms of sequential
  reads: tours_to_book's per-row getById + unit label point reads are awaited
  one at a time, today.ts tours_to_book loop) widens that window. No change
  requested beyond adding this to the issue.

## Areas checked and found clean

- Messaging safety of the stamp: every live stamp runs AFTER the provider
  accepted and (1:1) after the row was appended; recordStaffOutreach catches a
  throwing touch and never rethrows; stampRelayOutreach catches its consistent
  read; voice W6 runs after `sendTwiml` via `afterResponse` with a catch; no new
  await sits between press-1 and the `<Dial>`. No path can turn a sent message
  into a reported failure, and no gate (opt-out, deleted, consent, breaker,
  manual mode) or retry/reconcile decision reads `staffOutreach`.
- `system_copy` propagation: written true-only; carried by the manual Retry
  route (automated or system_copy original), retrySend and sendReconcile
  adoptRetry exactly like `automated`; it changes no gating. The W2 Retry gate
  (no broadcast_id, not automated, not system copy) matches the backfill's
  one-to-one rule.
- touchLastReachedOut: pointer-row guard, normalized ISO, forward-only
  `attribute_exists(contactId) AND (attribute_not_exists OR <)` condition -
  cannot create an item or move backward; contactsRepo has no whole-item Put
  on an existing contact that could drop the attribute; both contact writers
  refuse it as server-owned.
- Backfill script: dry run by default, `--apply` explicit, target via the
  shared stageClient (refusal before any read), key-condition floor with a
  per-row normalized re-check, latest-instant fold per contact, conditional
  forward-only writes (idempotent; a live stamp is never overwritten), abort on
  'failed' with a partial report. The call rule (answered_at or call_outcome)
  is sound: outbound call_outcome is only written by a Dial summary, i.e. after
  press-1 dialed the contact (webhooks/voice.ts status callback). The relay /
  group / edited-intro rules mirror the live writers; intro_body is never
  cleared after creation, so the body match stays valid.
- attributeInbound refactor (lib/heardFrom.ts): byte-equivalent for inbound
  attribution; the extracted helper is used only by the dev fixtures.
- Follow up tab: buildFollowUps still calls the contacts batch with exactly
  `{ requireComplete: true }`; only the projection gained one attribute.
- New tour.updated emits on create: every dashboard consumer except Today and
  its past-tours hook filters by tourId; no consumer mis-handles a create.
- Identify de-dupe and merge (unread pass + triage pass), Tours to book, Tours
  today ordering, the client fallback's one-row-per-contact rule, rowKeysOf,
  the lifted Show all state, Quiet shares seeding (setState during render,
  guarded) - no React key, stale closure or state-reset defect found.
- Security: no new route; the new response fields (quiet shares names, unit
  labels, tour createdAt) go to the same authed staff as the Follow up tab;
  SSE payloads stay id-only.
