# Issue bundles - a mission-sized work queue

Hand-maintained triage companion to the generated `INDEX.md`. The underscore
prefix keeps `npm run issues` from treating it as an issue file.

**Re-derived 2026-08-31** against 266 open issues (264 `open`, 2
`in-progress`) at main `ec32170a`. Supersedes the 2026-08-21 ten-cluster
edition; the old cluster names survive only as a lineage column at the bottom.

## Why this edition is shaped differently

The 08-21 edition grouped ~276 issues into 10 clusters of 10-30 issues each.
Working C1 took a full mission and twelve re-adjudication agents, because a
cluster that size carries an unmade design decision in the middle and a dozen
remedies that decay while it waits. So this edition applies three rules:

1. **One bundle = one `/abt:feature-mission` branch.** A bundle is one
   coherent edit to one file/function seam, 3-8 issues, sized so a single
   mission closes all of them. If a bundle needs two branches, it is two
   bundles.
2. **Decisions are not build work.** An issue whose remedy is an unmade
   PRODUCT ruling (`type: decision`, or a bug whose "Suggested fix" is
   "decide") goes in a **decision bundle** - a brainstorm-only session with
   Cameron whose output is a ruling committed to the issue file, no code.
   The build bundle that needs the ruling is marked `gated-on`. Technical
   approach choices (read-time vs write-fanout) are NOT decisions in this
   sense; the mission's own spec phase settles those.
3. **Lows ride, they do not steer.** A low is in a bundle only because the
   bundle already opens its file. A bundle that is ALL lows is marked
   `opportunistic` and is not on the ordered list.

Membership was derived mechanically from the `refs:` file lists (261 of 266
open issues carry one), then confirmed by reading each candidate bundle's
Problem paragraphs - two issues sharing a file is necessary but not
sufficient. `conflicts` names other bundles that edit the same file, because
two bundles on `twilio.ts` cannot be concurrent missions.

**You do not have to work all of these.** Tier 1 is the ordered list worth
running as missions; ~12 bundles cover every open high plus the two
go-live-adjacent mediums. Tier 2 is the rest of the registry, bundled so it
is schedulable if someone opens those files, and so nothing is orphaned.

Re-derive after any batch of closes. This is a snapshot, not a generated
artifact; Cameron edits issue files on main concurrently.

---

## In flight - not schedulable

| branch / worktree | carries | blocks |
|---|---|---|
| `feat/tour-reminder-ladder-phase-b` (`W:\tmp\tour-reminder-ladder-phase-b`, dirty, 10 commits ahead) | [tour-reminder-ladder-phase-b](./tour-reminder-ladder-phase-b.md), closed [message-interpolate-token-reexpansion](./message-interpolate-token-reexpansion.md) on-branch | every bundle touching `jobs/tourReminders.ts`, `messages/tourCopy.ts`, `routes/tourReminders.ts`, `routes/contactTimeline.ts`: T-TOURS-TZ, T-CATALOG, T-REMINDERS-TAIL, and one member of T-SOFT-DELETED |
| [a2p-compliance-hardening](./a2p-compliance-hardening.md) `in-progress` | P0/P1/P2 scoped inside the file; dev unfenced, prod flags unflipped | M-A2P below is its tail, not a new start |

Merged since the 08-21 edition, worktrees still present but `ahead=0`:
`feat/tour-reminder-ladder`, `feat/inbox-unread-read-path`,
`feat/media-content-type-fidelity`, `feat/relay-inbound-caller-identity`.
Cleanup is separate work.

---

## Tier 1 - the ordered mission queue

Every open high is anchored in exactly one of these. Order below is the
recommended order; the reasoning is in "Suggested order" at the end.

### M1 - Participant name and phone snapshots nothing refreshes

**Highs: 2, both founder-observed.** One mechanism: `participants[].name`,
`participant_display_name` and `participants[].phone` are write-time
snapshots on the conversation row, and the only writer (the contact-update
fan-out in `routes/contacts.ts`) reaches 1:1 threads only. Measured
2026-08-25: ~580 open prod threads carry no name while the contact has one.

**Anchor files:** `routes/today.ts`, `routes/contacts.ts` (the fan-out),
`lib/rosterResolution.ts`, `lib/groupTitle.ts`, `lib/contactName.ts`,
`repos/conversationsRepo.ts`.

| sev | issue | why it ships here |
|---|---|---|
| high | [today-shows-phone-instead-of-name](./today-shows-phone-instead-of-name.md) | anchor - Today reads the snapshot; the inbox hydrates and is correct, which is the tell |
| high | [group-roster-name-snapshot-never-refreshed](./group-roster-name-snapshot-never-refreshed.md) | anchor - same snapshot, group titles and member chips |
| med | [relay-stale-participant-phone](./relay-stale-participant-phone.md) | the PHONE half of the same snapshot; the roster texts the stored row phone forever |
| low | [consolidate-contact-display-name-helpers](./consolidate-contact-display-name-helpers.md) | six private name-join copies in exactly the files this opens |
| low | [today-contact-hydration-fan-out](./today-contact-hydration-fan-out.md) | if Today resolves names live, this is the read it pays for - measure it in the same pass |

**The spec decision the mission must make first:** refresh-on-write
(extend the fan-out to group rosters) vs resolve-on-read (hydrate names the
way the inbox already does). The measurement script
(`app/scripts/measure-unread-contact-coverage.ts --audit-denorm`) exists;
extend it to group rosters, which it currently skips.

**conflicts:** M6, M8 (`routes/contacts.ts`, `conversationsRepo.ts`);
T-DUP-DETECT (`rosterResolution.ts`). **gated-on:** nothing.

### M2 - Media serving privacy: relay fan-out and the authenticated media route

**Highs: 2, one `security`.** Both are "bytes go where they should not":
relay forwards every received attachment to every member with no
content-type gate (a video 12300-fails the whole leg, so the other members
get NOTHING, body text included), and the authenticated media route's
`Cache-Control: private` lets a browser reuse bytes across a logout.

**Anchor files:** `jobs/relayFanOut.ts` (media block), `routes/api.ts`
(media GET), `lib/mediaTypes.ts`, `lib/mmsRenditions.ts`.

| sev | issue | why it ships here |
|---|---|---|
| high | [relay-forwards-undeliverable-media](./relay-forwards-undeliverable-media.md) | anchor - needs a deliverable-type gate AND a privacy ruling on forwarding at all |
| high | [authenticated-mms-media-browser-cache](./authenticated-mms-media-browser-cache.md) | anchor - `no-store` on the authenticated media response |
| low | [mms-forward-received-media](./mms-forward-received-media.md) | the deferred "forward from gallery" feature; the privacy ruling above decides whether it is ever built |
| low | [mms-deliver-path-trusts-content-type](./mms-deliver-path-trusts-content-type.md) | same `mediaTypes` seam - the deliver path trusts the pinned type without a sniff |
| low | [mms-originalkey-unvalidated-pre-rcs](./mms-originalkey-unvalidated-pre-rcs.md) | same `api.ts` media route, existence check before presign |

**conflicts:** M3, M5, T-DELIVERY-CHIPS (`relayFanOut.ts`); T-SEND-IDEMP,
T-SOFT-DELETED (`routes/api.ts`). **gated-on:** nothing, but the forwarding
privacy question is a product ruling the mission should put to Cameron in
its brainstorm, not decide alone.

### M3 - Relay roster change notification texts (GO-LIVE gate)

**High: 1.** Adds the add/remove notification sends. Everything here is
inside `addMember` / `removeMember` / the announce path or the preview that
fronts them, and each one changes WHO gets the new text or WHEN it may go.

**Anchor files:** `routes/relayGroups.ts`, `services/relayMembers.ts`,
`services/relayAnnouncements.ts`, `services/numberSuppression.ts`,
`jobs/relayFanOut.ts`, `jobs/rosterActions.ts`, `messages/catalog.ts`.

| sev | issue | why it ships here |
|---|---|---|
| high | [relay-roster-change-notification-texts](./relay-roster-change-notification-texts.md) | anchor - reuse the throttled `relay.intro` machinery, copy through the catalog |
| med | [relay-member-suppression-diverges-from-number-seam](./relay-member-suppression-diverges-from-number-seam.md) | who the notify must SKIP - and the two seams currently disagree |
| med | [number-suppression-change-emits-no-cross-thread-event](./number-suppression-change-emits-no-cross-thread-event.md) | the suppression list the skip reads; a change is invisible to other threads |
| med | [relay-group-routes-unbounded-members](./relay-group-routes-unbounded-members.md) | same routes, now with a per-member send cost |
| med | [standalone-relay-group-quiet-hours-deferral](./standalone-relay-group-quiet-hours-deferral.md) | when a roster-change send is allowed to go |
| med | [pending-roster-actions-uncapped-walker](./pending-roster-actions-uncapped-walker.md) | the one uncapped `queryAll` left, in the roster-actions repo this job reads |
| low | [relay-add-double-announce-race](./relay-add-double-announce-race.md) | the announce this high turns into a real text |
| low | [member-add-burn-first-residuals](./member-add-burn-first-residuals.md) | the add path's 409 residuals |

**conflicts:** M2, M5, T-DELIVERY-CHIPS (`relayFanOut.ts`); M9
(`rosterEdits.ts`); M4, T-RELAY-REOPEN (`twilio.ts`). **gated-on:** M1's
phone half is a soft dependency - the notify sends to the participant row
phone, which M1 may change the source of. Sequence M1 first or accept the
row phone knowingly.

### M4 - Inbound group MMS detection

**High: 1.** Cameron's ruling stands: detection lands before any outbound
feature. Everything here is the same webhook routing decision or the
group-identity key that detection mints.

**Anchor files:** `routes/webhooks/twilio.ts` (group block, closed-group
intercept), `services/groupIdentity.ts`, `services/groupIdentityFingerprint.ts`,
`services/groupEnvelope.ts`.

| sev | issue | why it ships here |
|---|---|---|
| high | [inbound-group-mms-detection](./inbound-group-mms-detection.md) | anchor - needs the empirical Twilio payload check on Cameron's phone |
| med | [group-mms-including-pool-numbers](./group-mms-including-pool-numbers.md) | the exact routing precedence detection changes |
| med | [group-identity-pool-number-mutability](./group-identity-pool-number-mutability.md) | the identity key detection mints - retiring a pool number re-mints it silently |
| med | [tripwire-extraction-scope](./tripwire-extraction-scope.md) | the missing-envelope heuristic real detection retires |
| low | [group-identity-fingerprint-worker-and-pool-coverage](./group-identity-fingerprint-worker-and-pool-coverage.md) | same fingerprint, pins the wrong list |
| low | [closed-intercept-skips-contact-capture](./closed-intercept-skips-contact-capture.md) | `handleClosedGroupInbound`, same function detection edits |

**conflicts:** M3, M12, T-PUSH, T-RELAY-REOPEN (`twilio.ts`); M11
(`jobs/extraction.ts` via tripwire). **gated-on:** the payload check is an
EVIDENCE gate, not a decision - the mission cannot start until a real group
MMS has been received on the ported number and its webhook body captured.
**Feeds:** F-GROUP-OUTBOUND.

### M5 - Retry counters and the cap-and-close branch

**High: 1.** Retry counts live in the enqueued envelope, so a failing
enqueue freezes the count and the cap is unreachable. The invariant for the
whole bundle: *if the mechanism that advances state fails, does this path
still terminate?*

**Anchor files:** `jobs/retrySend.ts`, `jobs/broadcastFanOut.ts`,
`jobs/relayFanOut.ts`, `jobs/groupRail.ts`, `repos/messagesRepo.ts`.

| sev | issue | why it ships here |
|---|---|---|
| high | [retry-counter-in-envelope-makes-caps-unreachable](./retry-counter-in-envelope-makes-caps-unreachable.md) | anchor - move attempt counts into the durable record |
| med | [relay-30003-retry-lineage](./relay-30003-retry-lineage.md) | the relay retry that does not exist yet, and needs lineage under one visible delivery row - the durable attempt record above is what it hangs off |
| low | [rail-binding-propagation-retry](./rail-binding-propagation-retry.md) | retry ladder in the same job family |

Small on purpose. The high's file also flags an unfiled sweep for other
`!== 'success'` provider-status fallthroughs; do it here or file it.

**conflicts:** M2, M3, T-DELIVERY-CHIPS (`relayFanOut.ts`; the 30003 issue
has a dashboard half in `deliveryStatus.ts` - land the backend lineage here
and let T-DELIVERY-CHIPS render it). **gated-on:** nothing.

### M6 - Inbox Unknown tab walks the open partition

**High: 1, raised on measurement** (693 contact lookups to return 17 rows;
partition exhausted every render; re-issued on every debounced SSE event).
The root is the `conv.type` divergence - ~610 open rows claim `unknown_1to1`
while their contact is typed - so cost INVERTS with triage quality.

**Anchor files:** `routes/inbox.ts` (Unknown tab), `lib/unknownQueue.ts`,
`repos/contactsRepo.ts`, `lib/tables.ts`, `dashboard/routes/inbox/useInbox.ts`.

| sev | issue | why it ships here |
|---|---|---|
| high | [inbox-filter-tabs-full-walk](./inbox-filter-tabs-full-walk.md) | anchor - MEASURE FIRST with `--audit-walk`; the badge's lesson, paid for |
| med | [unknown-queue-status-flip-duplicates-across-pages](./unknown-queue-status-flip-duplicates-across-pages.md) | the same walk's cursor carries a position, not a seen-set |
| med | [unknown-queue-page-head-drop-after-filled-page](./unknown-queue-page-head-drop-after-filled-page.md) | the same walk drops a row with zero retries |
| low | [denormalize-contact-last-activity-for-ordered-paging](./denormalize-contact-last-activity-for-ordered-paging.md) | the candidate remedy shape - a contact-side GSI so the tab pages in activity order without walking |
| low | [inbox-parselimit-empty-one-row](./inbox-parselimit-empty-one-row.md) | same route's limit parsing |

**conflicts:** M1, M8, T-UNREAD-GEN (`routes/inbox.ts`); M1
(`routes/contacts.ts`). **gated-on:** nothing. Part (B) of the anchor -
the `contactId` denormalization - was cut with the badge issue and does
not come back here; the remedy is on the contact side.

### M7 - npm test is not reliably green

**High: 1**, raised since the 08-21 edition. The write-lock cause is fixed
(one database per test file) but an `UpdateTable InternalFailure` tail and
two self-defeating hook budgets remain. These are the unit-test-side gate
soundness items; the e2e-under-load items are T-E2E-LOAD.

**Anchor files:** `app/vitest.config.ts`, `lib/dynamoAdmin.ts`,
`app/test/groupCrossCheck.test.ts`, `app/test/logCallSiteGuard.test.ts`,
`app/test/staticSmoke.test.ts`.

| sev | issue | why it ships here |
|---|---|---|
| high | [npm-test-dynamodb-local-contention](./npm-test-dynamodb-local-contention.md) | anchor - suite A latency-robust assertions, suite B retry `UpdateTable` on `InternalFailure` |
| med | [logcallsiteguard-hook-budget-equals-its-own-cost](./logcallsiteguard-hook-budget-equals-its-own-cost.md) | a `beforeAll` budget smaller than the hook's own cost - fails on load, not on defect |
| med | [static-smoke-fails-on-stale-dashboard-dist](./static-smoke-fails-on-stale-dashboard-dist.md) | skips on ABSENT dist, fails on STALE dist, blames the wrong thing |

**conflicts:** none. **gated-on:** nothing. Run its gates under a clean
access key (`AWS_ACCESS_KEY_ID=hccleanrun001`) or the anchor's own symptom
contaminates the verdict.

### M8 - Who owns the conversation-to-contact link

**No high; four mediums on one seam.** `participants[].contactId` is
written by six paths and trusted by the mark-read fan-out, extraction, and
the importer, and they disagree. The 08-21 C1 re-adjudication found this
while cutting the badge fix: `contactCapture` claims the link before
indexing on only ONE of six `incrementUnread` paths.

**Anchor files:** `lib/contactThreads.ts`, `services/contactCapture.ts`,
`repos/conversationsRepo.ts`, `routes/contacts.ts`, `lib/import/apply.ts`.

| sev | issue | why it ships here |
|---|---|---|
| med | [mark-read-fanout-stale-gsi-skip](./mark-read-fanout-stale-gsi-skip.md) | anchor - conditional write; the skip is sticky. Fixing this is what keeps the deferred badge issue deferred |
| med | [extraction-conversation-contact-divergence](./extraction-conversation-contact-divergence.md) | same link, read by extraction, aimed at the wrong contact |
| med | [import-blanks-conversation-participant-contactid](./import-blanks-conversation-participant-contactid.md) | same link, blanked by a re-import |
| low | [group-roster-contact-id-can-dangle](./group-roster-contact-id-can-dangle.md) | same link on a group roster, never re-minted |

**conflicts:** M1, M6 (`routes/contacts.ts`, `conversationsRepo.ts`);
M11 (`jobs/extraction.ts`); T-IMPORT (`lib/import/apply.ts`).
**gated-on:** nothing.

### M9 - Relay provisioning atomicity and preview truth

**No high; eight mediums-and-lows on `rosterProvision` / `rosterEdits`.**
One shape: a non-atomic claim, a best-effort link, and a preview that
promises members provisioning will drop.

**Anchor files:** `services/rosterProvision.ts`, `services/rosterEdits.ts`,
`services/relayProvisioning.ts`, `routes/relayGroups.ts`,
`dashboard/routes/shared/RosterConfirmDialog.tsx`.

| sev | issue |
|---|---|
| med | [relay-provisioning-sentinel-leak](./relay-provisioning-sentinel-leak.md) |
| med | [placement-relay-no-atomic-claim](./placement-relay-no-atomic-claim.md) |
| med | [relay-preview-lists-members-provisioning-drops](./relay-preview-lists-members-provisioning-drops.md) |
| med | [standalone-relay-group-no-reachable-floor](./standalone-relay-group-no-reachable-floor.md) |
| med | [relay-confirm-dialog-overstates-tier3-send](./relay-confirm-dialog-overstates-tier3-send.md) |
| low | [relay-preview-memberkey-collision-overcount](./relay-preview-memberkey-collision-overcount.md) |
| low | [roster-plan-version-write-unguarded](./roster-plan-version-write-unguarded.md) |
| low | [relay-provisioning-stale-comments](./relay-provisioning-stale-comments.md) |

**conflicts:** M3 (`rosterEdits.ts`, `relayGroups.ts`); T-MODALS
(`RosterConfirmDialog.tsx`). **gated-on:** nothing. Sequence after M3 or
before it, never alongside.

### M10 - Voice webhook terminal state

**No high; the C2 invariant applied to `voice.ts`.** A call row that stays
`ringing`, a recording lost in a claim window, an originate leg with no
durable terminal status - none of these reach a terminal state when the
thing that advances them fails.

**Anchor files:** `routes/webhooks/voice.ts`, `services/originateCall.ts`,
`adapters/messaging.ts`, `repos/messagesRepo.ts`.

| sev | issue |
|---|---|
| med | [voice-caller-abandon-no-dial-summary](./voice-caller-abandon-no-dial-summary.md) |
| med | [recording-claim-redelivery-loss-window](./recording-claim-redelivery-loss-window.md) |
| med | [originate-leg-status-callback](./originate-leg-status-callback.md) |
| med | [voice-business-number-roster](./voice-business-number-roster.md) |
| low | [refusal-stamp-announce-extra-round-trips](./refusal-stamp-announce-extra-round-trips.md) |
| low | [missed-call-push-fans-out-duplicate-replies](./missed-call-push-fans-out-duplicate-replies.md) |

**conflicts:** none with Tier 1. `call-recording-consent` also lives in
`voice.ts` but is a compliance decision - D-A2P. **gated-on:** nothing.

### M11 - Extraction claim lifecycle

**No high; the C2 invariant applied to the extraction job.** A stranded
claim with no reaper, a driver call that holds it ~30 minutes, and the
`claimedAt` a reaper would need, stamped from the wrong clock.

**Anchor files:** `jobs/extraction.ts`, `repos/extractionRepo.ts`,
`adapters/extraction.ts`, `services/extraction/runWindow.ts`.

| sev | issue |
|---|---|
| med | [extraction-stranded-claim-no-reaper](./extraction-stranded-claim-no-reaper.md) |
| med | [extraction-driver-call-unbounded](./extraction-driver-call-unbounded.md) |
| med | [anthropic-extraction-driver-unit-coverage-gaps](./anthropic-extraction-driver-unit-coverage-gaps.md) |
| low | [extraction-claimedat-stamped-from-poll-clock](./extraction-claimedat-stamped-from-poll-clock.md) |
| low | [extraction-runwindow-module-cycle](./extraction-runwindow-module-cycle.md) |

**conflicts:** M4 (tripwire), M8 (`jobs/extraction.ts`); T-EXTRACT-CONTENT
(`services/extraction/*` - different files, same job). **gated-on:** nothing.

### M12 - Media content-type fidelity tail

**No high; two `security` mediums.** The 08-26 fidelity branch has merged
(`ahead=0`) but left a read-modify-write that can revert its own backfill,
an inbound index mismatch, and three filename-sanitization gaps. **The
backfill run itself is still owed** - check the branch's handback before
scoping.

**Anchor files:** `lib/mediaFilename.ts`, `lib/mediaTypes.ts`,
`app/jobs/mediaMirror.ts`, `app/scripts/backfill-media-content-types.ts`,
`routes/webhooks/twilio.ts` (inbound mirror).

| sev | issue |
|---|---|
| med/security | [outbound-email-attachment-filename-unsanitized](./outbound-email-attachment-filename-unsanitized.md) |
| med | [media-mirror-reverts-backfilled-types](./media-mirror-reverts-backfilled-types.md) |
| med | [inbound-media-content-type-index-mismatch](./inbound-media-content-type-index-mismatch.md) |
| low/security | [declarable-office-doc-types-double-click](./declarable-office-doc-types-double-click.md) |
| low/security | [timeline-filename-bidi-display](./timeline-filename-bidi-display.md) |
| low/security | [backfill-scan-pulls-message-bodies](./backfill-scan-pulls-message-bodies.md) |

**conflicts:** M2 (`lib/mediaTypes.ts`); M4 (`twilio.ts`); T-LOAD-OLDER,
T-DELIVERY-CHIPS (`Timeline.tsx`). **gated-on:** nothing.

### M-A2P - A2P compliance tail (in-progress high)

Not a new mission; the tail of the running one. The two catalog
enforcement items ride because the disclosure work edits the same
`sendMessage` floor.

| sev | issue |
|---|---|
| high (in-progress) | [a2p-compliance-hardening](./a2p-compliance-hardening.md) |
| med | [consent-copy-cross-stack-drift](./consent-copy-cross-stack-drift.md) |
| med | [automated-sms-length-guard](./automated-sms-length-guard.md) |
| low | [sms-copy-non-gsm7-characters](./sms-copy-non-gsm7-characters.md) |

**gated-on:** D-A2P for the brand and opt-out precedence rulings, which
the P1 re-file needs before prod.

---

## Feature seeds - own missions, not bundles

Each is a full brainstorm -> spec -> plan feature. They carry riders only
where the rider is the feature's own limitation.

| feature | anchor | riders | gated-on |
|---|---|---|---|
| **F-GROUP-OUTBOUND** native group texting for the 132 imported groups | [regular-group-texting-for-imported-groups](./regular-group-texting-for-imported-groups.md) (high) | [import-group-thread-retraction](./import-group-thread-retraction.md), [group-outbound-media](./group-outbound-media.md), [group-text-tour-placement-attachment](./group-text-tour-placement-attachment.md) | **M4** |
| **F-SEARCH** | [total-product-search](./total-product-search.md), [typeahead-scale-needs-server-side-search](./typeahead-scale-needs-server-side-search.md) | - | - |
| **F-UNIT-INTAKE** | [unit-onboarding-fields](./unit-onboarding-fields.md), [tenant-support-contacts-structured](./tenant-support-contacts-structured.md) | - | - |
| **F-TOURS-OFF-PLACEMENT** | [tour-scheduling-off-placement](./tour-scheduling-off-placement.md) | [today-next-tour-reminder-from-ladder](./today-next-tour-reminder-from-ladder.md) | phase-b merge |
| **F-MMS-FEATURES** | [broadcast-mms](./broadcast-mms.md), [mms-attach-unit-photos](./mms-attach-unit-photos.md), [inbound-media-attach-to-unit](./inbound-media-attach-to-unit.md) | [mms-upload-endpoint-hardening](./mms-upload-endpoint-hardening.md), [mms-uploads-no-lifecycle-orphans](./mms-uploads-no-lifecycle-orphans.md) | M2's forwarding ruling |
| **F-EMAIL-V2** | [email-identity-collision-followup](./email-identity-collision-followup.md), [email-blocklist-management-ui](./email-blocklist-management-ui.md) | [email-cc-mirroring](./email-cc-mirroring.md) | - |

---

## Decision bundles - Cameron rulings, no code

One brainstorm session each. Output: the ruling written into each issue
file, and the build bundle it gates un-gated.

| bundle | decisions | un-gates |
|---|---|---|
| **D-A2P** | [sms-brand-diverges-from-registered-a2p-brand](./sms-brand-diverges-from-registered-a2p-brand.md), [staff-unmute-vs-per-phone-optout](./staff-unmute-vs-per-phone-optout.md), [call-recording-consent](./call-recording-consent.md), [quiet-hours-ungated-automated-paths](./quiet-hours-ungated-automated-paths.md), [dnc-registry-scrubbing](./dnc-registry-scrubbing.md) (deferred - confirm it stays so) | M-A2P prod re-file |
| **D-RELAY-LIFECYCLE** | [relay-reopen-semantics](./relay-reopen-semantics.md), [relay-groups-ignore-member-deletion](./relay-groups-ignore-member-deletion.md), [relay-single-live-conversation-per-pair](./relay-single-live-conversation-per-pair.md), [converted-tour-roster-endpoints-live](./converted-tour-roster-endpoints-live.md) | T-RELAY-REOPEN, T-SOFT-DELETED, T-DUP-DETECT |
| **D-EXTRACTION-TRUST** | [voice-transcribed-names-unreliable](./voice-transcribed-names-unreliable.md), [voice-extraction-window-demotion-persistence](./voice-extraction-window-demotion-persistence.md), [manual-extraction-route-has-no-spend-fence](./manual-extraction-route-has-no-spend-fence.md) | T-EXTRACT-CONTENT |
| **D-PLACEMENT-MODEL** | [approval-move-in-audit](./approval-move-in-audit.md), [stuck-case-thresholds-need-tuning](./stuck-case-thresholds-need-tuning.md), [placement-date-units-compact-vs-spelled](./placement-date-units-compact-vs-spelled.md), [self-guided-group-reminder-gate](./self-guided-group-reminder-gate.md) | T-PLACEMENT-CAPTURES |
| **D-PUSH** | [message-push-no-ttl-doze-flush-renotify](./message-push-no-ttl-doze-flush-renotify.md), [unit-photo-confirm-replay-duplicate-renditions](./unit-photo-confirm-replay-duplicate-renditions.md), [ai-runs-inflight-row-kind-undeclared](./ai-runs-inflight-row-kind-undeclared.md), [inbox-reconcile-failure-blanks-list](./inbox-reconcile-failure-blanks-list.md) | small rulings, batched so they get made |

---

## Tier 2 - the rest, bundled so it is schedulable

Compact form. Same rules apply. `opp` = opportunistic (all lows).

### Inbox and unread

**T-UNREAD-GEN** - the collect generator's flag contract in `lib/unreadFeed.ts`
+ `routes/inbox.ts`. Build as ONE slice with one coherent contract
(`capped`, `scanExhausted`, `truncated`, missing `consumedAll`) - three
08-25 agents proposed edits to the same lines and two found a neighbour's
remedy a no-op because of the coupling.
[unread-fill-loop-query-amplification](./unread-fill-loop-query-amplification.md) (med),
[inbox-truncated-flag-two-meanings](./inbox-truncated-flag-two-meanings.md) (med),
[unread-budget-truncation-has-no-forward-path](./unread-budget-truncation-has-no-forward-path.md),
[unread-load-more-empty-on-exact-multiple](./unread-load-more-empty-on-exact-multiple.md),
[unread-deleted-contact-probed-twice-per-page](./unread-deleted-contact-probed-twice-per-page.md),
[seen-set-max-equals-max-inbox-limit](./seen-set-max-equals-max-inbox-limit.md),
[inbox-read-accounting-gaps](./inbox-read-accounting-gaps.md),
[inbox-group-truncation-notice-not-reset](./inbox-group-truncation-notice-not-reset.md).
conflicts: M6, M8. Deferred at low, not here:
[unread-badge-request-round-trip-cost](./unread-badge-request-round-trip-cost.md).

### Relay

**T-RELAY-REOPEN** - closed/reopen semantics. gated-on D-RELAY-LIFECYCLE.
[inbound-reflags-closed-relay-group](./inbound-reflags-closed-relay-group.md) (med),
[relay-open-no-live-refresh](./relay-open-no-live-refresh.md) (med),
[relay-open-keyword-phantom-1to1](./relay-open-keyword-phantom-1to1.md),
[relay-duplicate-via-reopen](./relay-duplicate-via-reopen.md),
[relay-group-view-stale-open-composer](./relay-group-view-stale-open-composer.md).
conflicts: M3, M4 (`twilio.ts`).

**T-DUP-DETECT** `opp` - `services/relayGroupDuplicates.ts`, five issues,
five defects, deliberately NOT merged (sharing a file is not being a
duplicate).
[relay-duplicate-detection-scan-cost](./relay-duplicate-detection-scan-cost.md),
[relay-duplicate-warning-stale-after-defer](./relay-duplicate-warning-stale-after-defer.md),
[relay-duplicate-across-contact-handsets](./relay-duplicate-across-contact-handsets.md),
[relay-duplicate-via-roster-removal](./relay-duplicate-via-roster-removal.md).
gated-on D-RELAY-LIFECYCLE for the pair ruling. conflicts: M1
(`rosterResolution.ts`).

**T-RELAY-SURFACE** - the dashboard side.
[relay-group-no-dashboard-surface](./relay-group-no-dashboard-surface.md) (med),
[relay-group-composer-footer-copy](./relay-group-composer-footer-copy.md),
[relay-inbound-resolution-residuals](./relay-inbound-resolution-residuals.md),
[relay-warm-ladder-dedup-window](./relay-warm-ladder-dedup-window.md).

### Delivery and sending

**T-DELIVERY-CHIPS** - `dashboard/routes/contact/deliveryStatus.ts` +
`Timeline.tsx` chip logic + `services/groupReceipts.ts`. Renders what M5's
lineage produces.
[one-to-one-delivery-chip-escalates-nondeterministically](./one-to-one-delivery-chip-escalates-nondeterministically.md) (med),
[relay-21610-keeps-raw-code-and-counts-as-failed](./relay-21610-keeps-raw-code-and-counts-as-failed.md) (med),
[inbound-multi-party-bubbles-have-no-per-recipient-delivery](./inbound-multi-party-bubbles-have-no-per-recipient-delivery.md) (med),
[relay-all-opted-out-message-chip-stuck-sending](./relay-all-opted-out-message-chip-stuck-sending.md),
[phone-key-discriminator-defined-in-three-places](./phone-key-discriminator-defined-in-three-places.md),
[optional-call-outcome-breaks-already-loaded-bundles](./optional-call-outcome-breaks-already-loaded-bundles.md) (med),
[inbox-imported-call-outcome-normalization](./inbox-imported-call-outcome-normalization.md) (three call-outcome renderers, one normalizes).
conflicts: M2, M3, M5, M12, T-LOAD-OLDER, T-THREAD-PAGING. Sequence after M5.

**T-SEND-IDEMP** - one idempotency seam in `routes/api.ts` +
`services/sendMessage.ts` + `sendEmailMessage.ts`.
[send-idempotency-key](./send-idempotency-key.md) (med),
[exactly-once-send-intent](./exactly-once-send-intent.md),
[email-route-500-on-contactless-conversation](./email-route-500-on-contactless-conversation.md),
[email-outbound-stuck-queued-on-crash](./email-outbound-stuck-queued-on-crash.md).
conflicts: M2 (`api.ts`).

**T-MMS-CARRIER** - the carrier hunt, evidence-gated:
[mms-silent-drop-dish-textnow](./mms-silent-drop-dish-textnow.md) (med). A
30005 alone identifies no mechanism; check `date_updated - date_sent`.

### Contacts and soft-delete

**T-SOFT-DELETED** - one rule, "a soft-deleted contact is not a send/write
target but stays discoverable", applied at every gate. gated-on
D-RELAY-LIFECYCLE for the relay-membership half.
[deleted-contact-web-signup-silent](./deleted-contact-web-signup-silent.md) (med),
[outbound-voice-ignores-deleted-contacts](./outbound-voice-ignores-deleted-contacts.md) (med),
[scheduled-sends-to-deleted-contacts-silent-burn](./scheduled-sends-to-deleted-contacts-silent-burn.md) (med, **blocked - `tourReminders.ts` is phase-b's**),
[soft-deleted-contact-still-extractable](./soft-deleted-contact-still-extractable.md) (med),
[stale-suggestions-survive-contact-retype](./stale-suggestions-survive-contact-retype.md).
conflicts: M2 (`api.ts`), M11 (`extraction.ts`), M6 (`inbox.ts`).

**T-CONTACT-PAGE** - dashboard state races on the contact/tour/placement
panes, plus the client with no request timeout.
[contact-page-late-async-writes](./contact-page-late-async-writes.md) (med),
[tab-contact-load-failure-no-retry](./tab-contact-load-failure-no-retry.md) (med),
[dashboard-api-client-has-no-request-timeout](./dashboard-api-client-has-no-request-timeout.md) (med),
[oauth-return-drops-deep-link](./oauth-return-drops-deep-link.md) (med),
[pane-override-stale-refetch-race](./pane-override-stale-refetch-race.md),
[usecontactfile-unstable-return-identity](./usecontactfile-unstable-return-identity.md),
[contact-file-dead-media-slice](./contact-file-dead-media-slice.md).

**T-AUTHORITY-VOCAB** - housing authority has two vocabularies and two
field names; every item is that drift or the import that feeds it.
[housing-authority-free-text-drift](./housing-authority-free-text-drift.md) (med),
[retire-humanize-authority](./retire-humanize-authority.md) (med),
[contact-authority-clear-empty-string-500](./contact-authority-clear-empty-string-500.md) (med),
[properties-authority-filter-invisible-lock](./properties-authority-filter-invisible-lock.md) (med),
[unit-accepted-authorities-edge-cases](./unit-accepted-authorities-edge-cases.md),
[similar-units-authority-score-always-on](./similar-units-authority-score-always-on.md),
[import-address-cells-needing-cleanup](./import-address-cells-needing-cleanup.md) (med),
[seed-addresses-unstructured](./seed-addresses-unstructured.md).
conflicts: M8 (`lib/import/apply.ts`).

**T-IMPORT** - fold into whichever of M8 / T-AUTHORITY-VOCAB opens
`lib/import/apply.ts` first:
[contacts-create-does-not-require-status](./contacts-create-does-not-require-status.md).

### Dashboard timeline and threads

**T-THREAD-PAGING** - the stateful half of thread paging is copy-pasted
across three hooks and has drifted; every item is a symptom of that one
duplication. `useContactTimeline`, `useGroupThread`, `useRelayThread`,
`shared/threadPaging.ts`.
[thread-paging-stateful-half-duplicated](./thread-paging-stateful-half-duplicated.md) (med),
[thread-hooks-refetch-whole-page-per-event](./thread-hooks-refetch-whole-page-per-event.md) (med),
[thread-merge-leaves-a-hole-after-an-sse-gap](./thread-merge-leaves-a-hole-after-an-sse-gap.md) (med),
[relay-thread-unfiltered-sse-resorts-paged-history](./relay-thread-unfiltered-sse-resorts-paged-history.md) (med),
[contact-timeline-sse-refetch-unfiltered](./contact-timeline-sse-refetch-unfiltered.md) (med),
[older-page-can-remove-the-default-reply-target](./older-page-can-remove-the-default-reply-target.md) (med).
conflicts: T-LOAD-OLDER, T-DELIVERY-CHIPS.

**T-LOAD-OLDER** - the Load-older control and the prepend anchor in
`Timeline.tsx`, plus its keyboard reachability.
[load-older-control-loses-focus-and-announces-nothing](./load-older-control-loses-focus-and-announces-nothing.md) (med),
[prepend-anchor-misses-height-changes-with-no-render](./prepend-anchor-misses-height-changes-with-no-render.md) (med),
[message-bubble-reveal-not-keyboard-reachable](./message-bubble-reveal-not-keyboard-reachable.md) (med),
[load-older-control-unmount-jumps-the-reader](./load-older-control-unmount-jumps-the-reader.md),
[timeline-load-older-remounts-and-collapses-reveals](./timeline-load-older-remounts-and-collapses-reveals.md).
conflicts: T-THREAD-PAGING, T-DELIVERY-CHIPS, M12.

**T-MODALS** - the shared `Modal` and `RosterConfirmDialog`, plus phone-width
layout and a11y.
[modal-tab-focus-containment](./modal-tab-focus-containment.md) (med),
[modal-footers-do-not-stack-at-phone-width](./modal-footers-do-not-stack-at-phone-width.md) (med),
[roster-confirm-dialog-unclosable-on-hung-confirm](./roster-confirm-dialog-unclosable-on-hung-confirm.md) (med),
[modal-busy-close-affordance](./modal-busy-close-affordance.md),
[kebab-menus-keyboard-navigation](./kebab-menus-keyboard-navigation.md),
[photo-actions-touch-reachability](./photo-actions-touch-reachability.md),
[comms-pane-overflows-on-short-viewports](./comms-pane-overflows-on-short-viewports.md),
[tenant-row-longname-midpane-overflow](./tenant-row-longname-midpane-overflow.md).
conflicts: M9 (`RosterConfirmDialog.tsx`).

### Push

**T-PUSH** - `services/pushService.ts`, `adapters/webPush.ts`, the SW.
gated-on D-PUSH for the TTL ruling.
[inbound-push-fanout-unthrottled](./inbound-push-fanout-unthrottled.md) (med/security),
[push-subscription-change-not-handled](./push-subscription-change-not-handled.md) (med),
[push-subscription-prune-rmw-lost-update](./push-subscription-prune-rmw-lost-update.md),
[push-broadcast-no-send-timeout-or-concurrency-bound](./push-broadcast-no-send-timeout-or-concurrency-bound.md),
[message-push-payload-built-in-two-layers](./message-push-payload-built-in-two-layers.md),
[sw-notificationclick-message-has-no-listener](./sw-notificationclick-message-has-no-listener.md),
[e2e-push-seam-missing](./e2e-push-seam-missing.md).
conflicts: M4, M12 (`twilio.ts`); F-EMAIL-V2 (`inboundEmail.ts`).

### Extraction and suggestions

**T-SUGGESTION-RESOLUTION** - `services/suggestionResolution.ts` +
`repos/suggestionResolutionRepo.ts`.
[suggestion-phone-ownership-pointer-only-arbitration](./suggestion-phone-ownership-pointer-only-arbitration.md) (med),
[suggestion-status-accept-contract-drift](./suggestion-status-accept-contract-drift.md) (med),
[ai-run-log-refused-accept-replay-200](./ai-run-log-refused-accept-replay-200.md),
[ai-run-log-hot-path-round-trips](./ai-run-log-hot-path-round-trips.md),
[journal-sweep-truth-check-lease-collision-false-positive](./journal-sweep-truth-check-lease-collision-false-positive.md),
[resolution-fault-injection-hooks-in-prod-path](./resolution-fault-injection-hooks-in-prod-path.md),
[patch-supersession-no-suggestion-event](./patch-supersession-no-suggestion-event.md),
[ai-run-log-dead-code-cleanup](./ai-run-log-dead-code-cleanup.md).

**T-EXTRACT-CONTENT** - `services/extraction/{apply,prompt,schema}.ts`.
gated-on D-EXTRACTION-TRUST.
[extraction-notes-current-state-summary](./extraction-notes-current-state-summary.md) (med),
[extraction-tour-outcome-and-application-intent](./extraction-tour-outcome-and-application-intent.md),
[voice-transcript-prefix-collision](./voice-transcript-prefix-collision.md).
conflicts: M11.

**T-AI-RUN-LOG-UI** `opp` -
[ai-run-log-ui-polish-batch](./ai-run-log-ui-polish-batch.md),
[ai-run-detail-drops-skip-reason](./ai-run-detail-drops-skip-reason.md),
[ai-run-log-final-review-followups](./ai-run-log-final-review-followups.md).

### Tours, reminders, timezones - ALL blocked behind phase-b

**T-REMINDERS-TAIL** - what phase-b does not close:
[paused-reminder-rows-grow-listdue-without-bound](./paused-reminder-rows-grow-listdue-without-bound.md),
[reminder-state-sent-overstates-delivery](./reminder-state-sent-overstates-delivery.md),
[tour-reminder-zero-primary-e2e-gap](./tour-reminder-zero-primary-e2e-gap.md),
[placement-nudge-overdue-invisible-on-card](./placement-nudge-overdue-invisible-on-card.md) (med),
[placement-nudge-suppression-opt-out-parity](./placement-nudge-suppression-opt-out-parity.md),
[scheduled-send-surface-cues](./scheduled-send-surface-cues.md).
Re-derive against phase-b's handback; some of these may close on-branch.

**T-TOURS-TZ** - org zone vs browser zone vs property zone, decided once.
[tour-times-assume-org-timezone](./tour-times-assume-org-timezone.md) (med),
[tour-page-mixed-timezones](./tour-page-mixed-timezones.md),
[tour-morning-of-today-crosses-local-midnight](./tour-morning-of-today-crosses-local-midnight.md),
[quiet-hours-dst-gap-window-end-clamp](./quiet-hours-dst-gap-window-end-clamp.md).

**T-CATALOG** - `messages/catalog.ts` + `resolve.ts` + `tourCopy.ts`. Its
med anchor was closed on phase-b; what is left:
[founder-message-template-updates-owed](./founder-message-template-updates-owed.md) (med),
[tour-copy-where-token-declared-not-passed](./tour-copy-where-token-declared-not-passed.md),
[message-catalog-legacy-override-migration](./message-catalog-legacy-override-migration.md),
[founder-whisper-copy-unguarded-after-press-0-removal](./founder-whisper-copy-unguarded-after-press-0-removal.md).

**T-TOURS-PAGE** -
[tours-dialog-unit-label-glossary](./tours-dialog-unit-label-glossary.md),
[tour-outcome-close-not-backend-enforced](./tour-outcome-close-not-backend-enforced.md),
[tour-id-gate-tracked-state](./tour-id-gate-tracked-state.md),
[rta-documents-mms-unmodeled](./rta-documents-mms-unmodeled.md) (med).

### Placements

**T-PLACEMENT-CAPTURES** - the Approval & Move-in captures and the gates
the board does not forward. gated-on D-PLACEMENT-MODEL.
[determined-rent-capture](./determined-rent-capture.md) (med),
[inspection-date-capture](./inspection-date-capture.md) (med),
[paperwork-checklist-capture](./paperwork-checklist-capture.md) (med),
[placement-followup-hidden-when-not-soonest](./placement-followup-hidden-when-not-soonest.md) (med),
[move-in-ready-required-items-advisory](./move-in-ready-required-items-advisory.md),
[placements-board-new-gate-deadends](./placements-board-new-gate-deadends.md),
[park-reason-prompt-on-pill](./park-reason-prompt-on-pill.md).

### Units and photos

**T-UNIT-PHOTOS** - `routes/units.ts` photo pipeline, one file.
[unit-photo-bulk-transcode-async-ux](./unit-photo-bulk-transcode-async-ux.md) (med),
[unit-media-dangling-reference-race](./unit-media-dangling-reference-race.md),
[unit-photo-presign-empty-filetype](./unit-photo-presign-empty-filetype.md),
[unit-photo-presign-ttl-size-window](./unit-photo-presign-ttl-size-window.md),
[unit-photo-removal-never-deletes-s3-objects](./unit-photo-removal-never-deletes-s3-objects.md),
[shared-transcode-gate-couples-mms-and-photo-availability](./shared-transcode-gate-couples-mms-and-photo-availability.md),
[buffertostream-helper-duplicated](./buffertostream-helper-duplicated.md),
[property-card-409-settle-dead-code](./property-card-409-settle-dead-code.md).
gated-on D-PUSH for the confirm-replay ruling.

### Broadcasts

**T-BROADCAST-AUDIENCE** - `services/audienceResolution.ts` and the
composer. The truncation item is the GSI-range-key-as-hidden-priority-order
defect, live again.
[broadcast-audience-truncation-drops-searching-tenants](./broadcast-audience-truncation-drops-searching-tenants.md) (med),
[broadcast-4plus-exact-match-underreach](./broadcast-4plus-exact-match-underreach.md) (med),
[broadcast-results-enrichment-read-cost](./broadcast-results-enrichment-read-cost.md),
[broadcasts-list-liveness-worker-seam](./broadcasts-list-liveness-worker-seam.md),
[broadcast-draft-curation-persistence](./broadcast-draft-curation-persistence.md),
[matching-draft-resume-seed-rehydration](./matching-draft-resume-seed-rehydration.md).

### Harness, ops, hygiene

**T-E2E-LOAD** - e2e specs that fail under multi-suite load. RE-MEASURE
FIRST; several were filed as contention symptoms and M7 may retire them.
The anchor is a deliberate soak that ENUMERATES the small budgets.
[concurrent-capacity-budget-tail](./concurrent-capacity-budget-tail.md) (med),
[placement-stage-more-actions-suite-only-flake](./placement-stage-more-actions-suite-only-flake.md) (med),
[placement-detail-bundle-fetch-stall](./placement-detail-bundle-fetch-stall.md) (med - the fix merged; open for the misnamed message),
[e2e-image-viewer-scroll-flake](./e2e-image-viewer-scroll-flake.md) (med),
[relay-late-text-1to1-badge-not-visible](./relay-late-text-1to1-badge-not-visible.md) (med),
[inbox-row-appearance-e2e-flake](./inbox-row-appearance-e2e-flake.md).
NOT a timing-log job: a trace, not `E2E_CHILD_LOG_DIR`.

**T-LINT** - one sweep, its own branch:
[lint-backlog-repo-wide](./lint-backlog-repo-wide.md) (med). When it hits
zero, gate 5 becomes bare `npm run lint`.

**T-AWS-GUARD** - AWS blast radius in one-off scripts.
[one-off-scripts-missing-account-guard](./one-off-scripts-missing-account-guard.md) (med/security),
[pool-audit-reimport-strands-business-number](./pool-audit-reimport-strands-business-number.md) (med),
[aws-cli-identity-can-diverge-from-account-guard](./aws-cli-identity-can-diverge-from-account-guard.md),
[twilio-config-into-terraform](./twilio-config-into-terraform.md),
[sns-prod-alert-confirmation](./sns-prod-alert-confirmation.md).

**T-LOG-HYGIENE-TAIL** - what C3 left.
[messaging-delivery-alarms](./messaging-delivery-alarms.md) (med),
[cloudwatch-log-cp1252-mojibake](./cloudwatch-log-cp1252-mojibake.md),
[err-string-log-sites-remain](./err-string-log-sites-remain.md),
[otlp-telemetry-adoption](./otlp-telemetry-adoption.md),
[phone-in-url-paths-structural](./phone-in-url-paths-structural.md).

**T-POOL-ADMIN** `opp` -
[pool-numbers-admin-unbounded-inventory](./pool-numbers-admin-unbounded-inventory.md),
[poolnumbers-retry-unguarded-permanent-spinner](./poolnumbers-retry-unguarded-permanent-spinner.md).

**T-DEAD-CODE** `opp` - fold into whatever opens the file:
[remove-dead-relay-roster-alias](./remove-dead-relay-roster-alias.md),
[remove-media-s3-keys-legacy](./remove-media-s3-keys-legacy.md),
[event-bridge-hardening-followups](./event-bridge-hardening-followups.md),
[phone-display-formatter-stragglers](./phone-display-formatter-stragglers.md),
[stagemenu-statusmenu-consolidation](./stagemenu-statusmenu-consolidation.md),
[roster-card-shared-edit-pattern](./roster-card-shared-edit-pattern.md),
[change-order-1-still-specifies-press-0](./change-order-1-still-specifies-press-0.md).

---

## Lineage - where the 08-21 clusters went

| 08-21 cluster | now |
|---|---|
| C1 inbox unread read path | M6 (the anchor high), M8 (the fan-out), T-UNREAD-GEN (the `[gen]` tangle); badge deferred at low |
| C2 retry loops / terminal state | M5, M10, M11, and the provisioning half in M9 |
| C3 log hygiene | MERGED 2026-08-25; T-LOG-HYGIENE-TAIL is the residue |
| C4 native group texting | M4 (detection), F-GROUP-OUTBOUND (outbound feature) |
| C5 relay roster mutation | M3 (notify), M9 (provisioning), T-RELAY-REOPEN, T-DUP-DETECT, T-RELAY-SURFACE, D-RELAY-LIFECYCLE |
| C6 harness determinism | wave 1 MERGED; T-E2E-LOAD is wave 2 re-measured |
| C7 A2P / consent | M-A2P, D-A2P, T-CATALOG |
| C8 soft-deleted contacts | T-SOFT-DELETED |
| C9 thread paging + SSE | T-THREAD-PAGING, T-LOAD-OLDER |
| C10 timezone truth | T-TOURS-TZ |
| C11 test-suite soundness | M7; `compiled-dist-boot-unverified` and the sw-mirror pair are RESOLVED (the smoke gate exists) |
| (unclustered, filed after 08-21) | M1, M2, M12, T-DELIVERY-CHIPS, T-CONTACT-PAGE, T-AUTHORITY-VOCAB |

---

## Suggested order

1. **M1** - two founder-observed highs, one mechanism, no gate, and M3
   reads the phone it may change.
2. **M2** - two highs, one is a security cache leak; small, self-contained.
3. **M7** - the gate every later mission's verdict rests on. Cheap.
4. **M3** - the go-live gate. After M1.
5. **M5** - the "stuck forever" class, same as the prod voicemail incident.
6. **M6** - measure first; the last unbounded read on the route.
7. **M4** - as soon as the payload evidence exists. Nothing else can
   proceed on group texting without it.
8. **M8, M9, M10, M11, M12** - no highs; run in any order the file
   conflicts allow. M9 never alongside M3; M8 never alongside M1/M6.
9. **D-A2P**, then **M-A2P** to prod.
10. **D-RELAY-LIFECYCLE** - it un-gates three Tier 2 bundles at once.

Then F-GROUP-OUTBOUND, and Tier 2 as files open. Re-derive this file after
phase-b merges; it will move T-REMINDERS-TAIL and may close part of it.
