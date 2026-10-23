# S3 slice report - backend readers (tracker #30)

Branch feat/unknown-inactive. Commits: c6ec169b (S3.2), bc0df182 (S3.3),
bd732fba (S3.4 Steps 6-9, comment-only), 9cd80cae (S3.5), c3044ed1 (S3.6).
Every task with a test went RED for the plan's stated reason, then GREEN
(S3.4 is comment-only, AR17; S3.6 is records plus comment/doc edits).
`npm run typecheck` exit 0 after S3.5, the only S3 task that changed a type
(`InboxRow.inactive`). eslint on the 13 S3-touched .ts files: exit 0.
Slice-wide `git diff -U0 916258ae -- app dashboard docs/issues` added lines:
0 non-ASCII bytes; `grep -c 'u2192' app/src/services/statusTransition.ts`: 2.

## Required records (plan S3.7)

W1 (S3.1 Step 1, run by the orchestrator): "W1: no #31 branch or worktree at
S3 start (orchestrator check 2026-10-23 15:39 EDT; branches feat/flyer-leads,
feat/property-requirements, feat/unknown-inactive, main + remotes; worktrees:
main checkout, W:/tmp/flyer-leads, W:/tmp/property-requirements,
W:/tmp/unknown-inactive)". An incidental read-only listing at S3 start showed
the same set.

S3.1 Step 2: S1.1 landed (e7724e4e). app/src/lib/unknownQueue.ts:81 imports
UNKNOWN_STATUSES, :163 types UnknownQueueStatus from it, :179-182 holds
`needs_review: 0, inactive: 1`.

W2 (S3.6 Steps 1-2, OR-14 wording): reopen trigger NOT met on the recorded
counts (16 dev / 7 prod 2026-08-25, 0 lean 2026-09-02); not re-measured. The
change adds no rows by itself, but Inactive is now the one-click set-aside
and it does NOT drain the partition (only a re-type or a delete does,
app/src/lib/unknownQueue.ts:67-68), so the partition only grows and a status
write between Load-more clicks is now routine. The trigger is NOT met on the
recorded counts; nobody re-measured. Re-measure beside the W7 re-count.
Issue body updated (AR14): docs/issues/unknown-queue-status-flip-duplicates-across-pages.md
`updated: 2026-10-23` and the "Re-read 2026-10-23" paragraph at :31-46.

W4 (S3.5): no inbound writer touches an EXISTING contact's `status` - no
STOP. Pinned by app/test/twilioSmsWebhook.test.ts (inbound text) and
app/test/founderTriage.test.ts (inbound call), both green on unchanged code.
Writer by writer (current tree):
- services/contactCapture.ts:108-111 - `getById`, return an existing contact
  as-is, else `createIfAbsent` (repos/contactsRepo.ts:1476
  `attribute_not_exists(contactId)`); header :22-25 says so.
- services/groupMembers.ts:112, :155 - (unknown, needs_review) stub via
  createIfAbsent; :165 stampGroupParticipation (contactsRepo.ts:1912
  `SET group_participation_at` only).
- services/groupConvert.ts:319, :351, :471 stampGroupParticipation; :340 stub
  needs_review, :347 createIfAbsent.
- routes/public.ts:528-532 (an existing holder is never changed), :594 create
  a NEW tenant, :661 `housing_fair_welcomed` inside `if (isNew)` (:646).
- routes/webhooks/twilio.ts:1210, :1251 and routes/webhooks/voice.ts:727 -
  `contacts.update` with consent_method/consent_at only, only when absent.
- touchPhoneLastSeen twilio.ts:2161, :2661 (contactsRepo.ts:1162 SET #phones);
  setFlag twilio.ts:3925, :3984 and services/numberSuppression.ts:172-173
  setFlag/clearFlag (contactsRepo.ts:1495, :1509 SET #flag); touchLastHeardFrom
  twilio.ts:961, :1388, :2192, :2695, voice.ts:834, :1122, :1220,
  services/inboundEmail.ts:833 (contactsRepo.ts:2025 SET #lhf);
  touchEmailLastSeen inboundEmail.ts:806 (contactsRepo.ts:1235 SET #emails).
- routes/unmatchedEmail.ts:323 addEmail (staff link, emails only), :465
  create (a new contact only).
- jobs/extraction.ts:436-443 reads only; its writes go through
  services/extraction/apply.ts:500, whose patch keys are EXTRACTABLE_FIELDS
  (:206 loop; services/extraction/schema.ts:24-33) plus address (:415-416) -
  no `status` - and :745 (notes).

W5 (S3.6 Step 3): unchanged in behavior.
- services/audienceResolution.ts walks only BLAST_TENANT_STATUSES
  (lib/blastAudienceRules.ts:22, searching/onboarding) tenant partitions
  (:168-194). OR-12 changed only the comment at :84-85 to name the partner's
  `needs_review | active | inactive`; W5 "unchanged" still holds.
- jobs/extraction.ts: toProfile passes the stored status (:147-148);
  landlord/partner/team_member are skipped (:457). The AI cannot land
  `active` on an unknown contact. First line of defense (WORKLIST D):
  services/extraction/apply.ts:534-540 files a `status` suggestion ONLY for a
  (tenant, onboarding) contact, `suggestedValue` hard-coded 'searching'
  (:540); anything else is dropped `status_not_onboarding_tenant` (:571).
  Backstop: `status` is a TENANT_ONLY_TARGETS target
  (services/extraction/runTypes.ts:28-30), refused 409
  suggestion_contact_not_tenant before the claim
  (services/suggestionResolution.ts:820-826), and behind it the allowlist
  (:298-299) refuses `active` for `unknown` (400 invalid_suggestion_value).
- app/scripts/measure-unread-contact-coverage.ts: `--no-status-narrow` (:669)
  reads the whole type=unknown partition, so it counts Inactive rows for the
  W2 trigger. Its create-default comment (:661-664, "USED TO default") was
  rewritten by S1.2; not edited here.

Pre-deploy cursor (S3.4 Step 3 Edit F, run in S1.1 per AR17):
app/test/inboxUnknownTab.test.ts:351-366 pins a cursor inside the removed
`active` block (`{q:1,b:1,k:{status:'active'}}`) -> InboxBadRequestError
(400, once), and a block-1 start cursor (`{q:1,b:1}`) -> resolves. The check
is app/src/routes/inbox.ts:501; no decoder change.

S3.2 followUps case: `l-parked` was present in the RED output and is KEPT
(expected `['l-parked', 'p-active']`).

## What the tree held that the plan got wrong / divergences

- S3.4 Step 6 check grep (WORKLIST D record, s3-readers 2): it does NOT print
  Edit C's new lines - both contain the substring `inactive`, which the
  `grep -v` drops. Actual output: :16 (pre-rework) and Edit A lines :59, :61,
  :62, :66, :69, :76; :62 and :66 print only because they say "Inactive"
  (`grep -v` is case-sensitive). No `active: 1,`.
- OR-14 cites `unknownQueue.ts:64-65` (base lines). S3.4 Edit A moved that
  sentence to :67-68, so the issue paragraph cites :67-68; the rest of the
  OR-14 text is verbatim.
- The plan's S3.6 Step 3 W5 citation `extraction/apply.ts` is now :534-540
  (s3-readers said :535-540; :534 is the `suggest === true` test).
- Left as is (not in scope): app/src/routes/inbox.ts:1093-1094 still opens
  "A type='unknown' contact IS an untriaged inbound ... so it needs triage";
  the new comment at :1122-1126 states the Inactive exception.

## WORKLIST items

- OR-6: S3.3 gained "RED: an unread unknown_1to1 thread from an INACTIVE
  team member is NOT in needs_you_now" (app/test/todayApi.test.ts:1045-1055).
  RED on old code received `['c-team-off']`. Step 2's RED list had three
  entries (Inactive unknown, Inactive team member, the cap case), each for
  the stated reason; the three PINs passed.
- OR-12: applied (comment only, above).
- OR-13: the "IT IS NOT THE ORDER THE OPERATOR SEES" paragraph cites
  `(dashboard/src/routes/inbox/useInbox.ts, sortForFilter)`
  (app/src/routes/inbox.ts:2307-2310); the SUPERSEDED paragraph cites
  `compareUnknownTabRows`. `grep sortByActivity app/src/routes/inbox.ts`
  prints nothing.
- OR-14: applied in the issue body and above (W2).
- OR-20: every committed file's added lines are 0 non-ASCII bytes against
  916258ae; the new app/test/inboxInactive.test.ts is 0.
- OR-22: a bare `git status` before every `git add`; nothing was ever staged
  that I had not staged.
- OR-7 (cross-slice, for S5): buildContactRow also builds resurfaced
  soft-deleted rows (app/src/routes/inbox.ts:1046-1084), so a deleted
  Inactive contact's row carries `deleted: true` AND `inactive: true`
  (:1128-1129). AR5 kept literal; S5.1 pins the rendering.

## Cross-slice notes

- S5 adds `inactive?: boolean` to the dashboard InboxRow mirror with AR5's
  meaning (wire field: app/src/routes/inbox.ts:133-138) and names the
  comparator `compareUnknownTabRows` and the sort `sortForFilter` - the server
  comment cites both.
- The passesFilter `'unknown'` arm (`return row.needsTriage;`, inbox.ts:1000)
  is unreachable (the unknown branch returns first) and unchanged; the
  filter=unknown RED case proves an Inactive unknown is served there.
