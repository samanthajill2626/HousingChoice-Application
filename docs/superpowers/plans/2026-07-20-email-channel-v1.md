# Email Channel v1 (AWS SES) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. This plan is executed by the
> build-orchestrator inside an isolated worktree.

**Goal:** Two-way email (send, receive, view interleaved in the existing
conversation timeline) via AWS SES, for all contact types, with an
unmatched-email side-door surface - per the approved spec at
`docs/superpowers/specs/2026-07-20-email-channel-requirements-design.md`.

**Architecture:** Email is a third message channel on the existing
conversations/messages tables (the voice precedent): `MessageType 'email'`,
provider-id pointer idempotency, S3 MediaStore attachments, SSE inbox
machinery. One channel-agnostic ingestion service consumed by two delivery
mechanisms: production = SES receipt rule -> S3 + SNS -> a NEW dedicated SQS
queue -> a second SqsJobConsumer in the worker; local/e2e = a fake-SES router
inside the fake-twilio host writes MIME to MinIO and POSTs an SNS-shaped
notification to a dev-gated app route. Unknown senders never create contacts;
they land in a new `unmatched_email` store behind a new nav surface.

**Tech Stack:** Existing TS/Express/DynamoDB/React stack. New deps (ALL in
app/package.json, all spike-verified MIT/pure-JS): `mailparser` (parse),
`sanitize-html` (hostile HTML), `email-reply-parser` (quote trimming - NOTE
esModule default export: `require('email-reply-parser').default`),
`nodemailer` (ONLY `nodemailer/lib/mail-composer` for outbound raw MIME),
`@aws-sdk/client-sesv2` (send).

## Global Constraints (every task inherits these)

- Profile rules apply to every touched line: ASCII-only, Edit tool only
  (never PowerShell rewrites), explicit-path staging, bare gates
  (`npm run typecheck`, `npm test`, `timeout 1500 npm run e2e` from the
  worktree only), Co-Authored-By trailer on every commit.
- Runtime deps go in `app/package.json` ONLY (Docker `npm ci --workspace app`).
- NO terraform apply / secrets:push / deploys - Terraform is AUTHORED here,
  applies are owed ops recorded in the handback + RUNBOOK.
- Dashboard never imports from app/ - wire types hand-mirrored in
  `dashboard/src/api/types.ts`.
- New automated user-facing copy only via the message catalog (v1 adds NO
  automated email sends, so no new catalog entries - only the `channel` type
  widens).
- Attachment cap 25 MB total per message, both directions.
- `EMAIL_SENDING_ENABLED` kill-switch defaults OFF on deployed stacks
  (SMS_SENDING_ENABLED pattern) - dormant until SES production access.
- The general inbox and Today must NOT surface unmatched email (spec
  Decision 4). Unmatched email is never a ConversationSummary.
- Seed changes: `full` profile may gain email data; `lean` (byte-stable e2e
  world) may ONLY change alongside the specs that assert it - keep lean
  edits minimal and deliberate.

## INVARIANT RULE enumeration - thread identity (the structural change)

PRECISE MODEL (corrected by plan review): the system keeps one conversation
PER PARTICIPANT KEY (today: per phone; a multi-phone contact already has N
conversations MERGED AT READ TIME by the phone-iterating readers). Email
adds one more participant key (`participant_email` + `email#` claim). The
danger zone is therefore the READ MERGE, not just the write key: every
reader that iterates a contact's PHONES to find conversations will silently
drop email-only conversations unless it also iterates emails. Tasks A4
(inbox + timeline readers) fix the two known ones; builders and reviewers:
treat any OTHER phone-iterating reader you find as a finding.
Every mutation surface AND reader/renderer of thread identity, enumerated:

Writers/mutators:
1. `conversationsRepo.createOrGetByParticipantPhone` (+ `phone#` claim) -
   unchanged behavior, must remain compatible with email-extended items.
2. NEW `conversationsRepo.attachEmailToConversation` + `email#` claim items
   (Task A4) - the ONLY writers of `participant_email`.
3. NEW `createOrGetByParticipantEmail` (email-only contacts, Task A4).
4. `contactCapture` (inbound SMS stub capture) - must NOT be invoked by
   email ingestion (Decision 4); assert by test (Task B2).
5. Relay intercept path (closed-roster -> 1:1) - phone-only, untouched;
   watch: it must never see `type 'email'` messages.
6. Seeds (`app/src/lib/seed/lean.ts`, `matrix.ts`, `app/scripts/db-seed.ts`)
   - any seeded email threads must set BOTH participant keys consistently.
7. Dev seams (`/__dev/reseed`, e2e fixtures) - same rule as seeds.
Readers/renderers:
8. Inbox aggregation (`app/src/routes/inbox.ts` one-row-per-contact rule) -
   must fold email activity into the same contact row, channel 'email'.
9. Contact timeline assembly (`app/src/routes/contactTimeline.ts`).
10. `buildReplyTargets` + composer target resolution (dashboard).
11. Extraction scheduling + `toUtterances` (email branch, Task B2).
12. Today builder (`buildToday.ts`) - closed inputs; test asserts email
    changes nothing (Task B3).
13. Unread/SSE counters (`unread_count`, `conversation.updated`).

---

# PHASE A - foundations + outbound

Phase A ends with: staff can compose (subject/To/CC/plain text/attachments)
and send email from a contact page via SES (or fake-SES locally), see it
interleaved in the timeline with delivery chips, on a branch that is fully
green (typecheck + unit + full e2e) and internally reviewed. HARD GATE
before Phase B starts.

### Task A1: Email addresses on contacts (repo + API + seeds)

**Files:**
- Create: `app/src/lib/email.ts`
- Modify: `app/src/repos/contactsRepo.ts`, `app/src/lib/tables.ts` (byEmail
  GSI on contacts), `app/src/routes/api.ts` (3 email endpoints beside the
  phone ones), `app/src/lib/seed/lean.ts` + `full`/`matrix` seeds (emails on
  a few personas), contact-create route (optional `email` in body)
- Test: `app/test/contactsRepo.email.test.ts`, `app/test/emailLib.test.ts`,
  extend `app/test/adminUsers.test.ts`-style route tests for the endpoints

**Interfaces (produces):**
```ts
// app/src/lib/email.ts
export function normalizeEmailAddress(raw: string): string; // trim+lowercase
export function isValidEmailAddress(raw: string): boolean;  // pragmatic RFC subset: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ after normalize
// contactsRepo.ts
export interface ContactEmail { email: string; label?: string; primary: boolean; firstSeenAt?: string; lastSeenAt?: string }
// ContactItem gains: email?: string (primary, byEmail GSI hash); emails?: ContactEmail[]
findByEmail(email: string): Promise<ContactItem | undefined>   // pointer-aware like findByPhone
addEmail(contactId, email, label?): Promise<ContactItem>       // emailref#<addr> pointer for secondaries, email_in_use conflict
setPrimaryEmail(contactId, email): Promise<ContactItem>
removeEmail(contactId, email): Promise<ContactItem>            // cannot_remove_primary
touchEmailLastSeen(contactId, email): Promise<void>
```

**Steps (TDD; mirror the multi-phone design verbatim - read the phone
primitives first):**
- [ ] Failing tests: normalize/validate; add/find/primary/remove/conflict/
      pointer-follow (`findByEmail` on a secondary address resolves the
      contact); byEmail GSI declared in tables.ts contract test if one exists.
- [ ] Implement lib + repo + tables.ts GSI (run `npm run gen:tables` if that
      script maintains terraform table defs - follow its output convention).
- [ ] Route tests then routes: `POST /api/contacts/:id/emails`,
      `PATCH /api/contacts/:id/emails/:email` ({primary}),
      `DELETE /api/contacts/:id/emails/:email` - mirror phone endpoints'
      envelopes/error codes exactly (`email_in_use`, `cannot_remove_primary`).
- [ ] Seeds: give the seeded landlord persona + one tenant an email; keep
      lean edits minimal (this WILL ripple lean-byte assertions - update them
      deliberately in the same commit).
- [ ] `npm run typecheck` + `npm test` green; commit.

### Task A2: 'partner' ContactType end-to-end

**Files:**
- Modify (app): `app/src/repos/contactsRepo.ts` (ContactType union),
  `app/src/repos/conversationsRepo.ts` + `app/src/repos/messagesRepo.ts`
  (`partner_1to1` ConversationType; MessageAuthor `'partner'`),
  `app/src/routes/webhooks/twilio.ts` `conversationTypeFor` (partner ->
  partner_1to1), `app/src/routes/inbox.ts` (row typing), contactTimeline
  author labels
- Modify (dashboard): `dashboard/src/api/types.ts` (ContactType,
  ConversationType, author unions), `dashboard/src/routes/contact/contactProfile.ts`
  (`partner: 'Partner'` label), `KindPicker.tsx` (new segment 'Partner',
  first-class type per the PM precedent), `ContactDetail.tsx` kind branching
  (partner renders the generic/tenant-shaped pane with the Partner pill; no
  tenant-specific cards), `Timeline.tsx` author label map
- Test: `app/test/` union/exhaustiveness + conversationTypeFor tests;
  dashboard type mirror is compile-checked by `npm run typecheck`

**Scope note (plan review F24/F10):** property-manager shipped as a
CUSTOM-KIND (role on landlord base), NOT a union member - so 'partner' as a
first-class ContactType is deliberately heavier than that precedent (per
spec Decision 8). Budget the fallout: `app/src/services/extraction/apply.ts`
+ `schema.ts` map contact types explicitly; seed coherence tests
(`app/test/seedMatrixCoherence.test.ts`, `seedData.test.ts`,
`seedMatrix.test.ts`) assert type/author matrices and WILL ripple.

**Steps:**
- [ ] Failing test: `conversationTypeFor({type:'partner'})` -> 'partner_1to1'
      (verified location `app/src/routes/webhooks/twilio.ts:124`, 3 call
      sites); author honesty: inbound from partner contact -> author 'partner'.
- [ ] Widen unions everywhere the compiler forces (exhaustive switches are
      the map; do NOT add default-cases to silence them). Include the
      extraction apply/schema type maps and the seed coherence matrices.
- [ ] Extraction eligibility: partner threads EXCLUDED (same as landlord) -
      assert in the extraction scheduling test.
- [ ] KindPicker + labels + pill; typecheck-driven mirror sweep.
- [ ] Gates green; commit.

### Task A3: Email config + adapter + drivers (send pipe)

**Files:**
- Create: `app/src/adapters/email.ts` (the ONLY file importing
  @aws-sdk/client-sesv2 and mail-composer)
- Modify: `app/src/lib/config.ts`, `app/package.json` (deps:
  `@aws-sdk/client-sesv2`, `nodemailer`, and forward-install `mailparser`,
  `sanitize-html`, `email-reply-parser` for Phase B), `.env.example` +
  `.env.dev.example`/`.env.prod.example` (operator flags),
  `app/src/routes/dev.ts` `/__dev/ping` echo `emailDriver`,
  `app/src/messages/catalog.ts` (MessageDef channel union += 'email' ONLY -
  no new catalog entries in v1)
- Test: `app/test/emailAdapter.test.ts`, config tests

**Interfaces (produces):**
```ts
// config additions (AppConfig)
emailDriver: 'ses' | 'console'         // EMAIL_DRIVER; default console local, ses in prod
emailSendingEnabled: boolean           // EMAIL_SENDING_ENABLED; default OFF deployed, ON local
sesApiBaseUrl?: string                 // SES_API_BASE_URL; REJECTED in production (twilioApiBaseUrl pattern)
emailSenderDomain?: string             // EMAIL_SENDER_DOMAIN e.g. mail.housingchoice.org
emailFromAddress?: string              // EMAIL_FROM_ADDRESS e.g. team@mail...
inboundMailBucket?: string             // INBOUND_MAIL_BUCKET (Phase B)
inboundMailQueueUrl?: string           // INBOUND_MAIL_QUEUE_URL (Phase B, worker)
// adapters/email.ts
export interface OutboundEmail { from: {name: string; address: string}; to: string[]; cc?: string[]; replyTo?: string; subject: string; text: string; messageIdHeader: string; inReplyTo?: string; references?: string[]; attachments?: {filename: string; contentType: string; content: Buffer}[] }
export interface EmailAdapter { kind: 'ses'|'console'; send(mail: OutboundEmail): Promise<{ providerMessageId: string }> }
export function createEmailAdapter(deps: {config: AppConfig; logger: Logger}): EmailAdapter
```

**Steps:**
- [ ] Config tests first: driver gate (ses in prod requires
      EMAIL_SENDER_DOMAIN+EMAIL_FROM_ADDRESS present else boot throw),
      kill-switch default matrix, and - SECURITY-CRITICAL (review F15) -
      `SES_API_BASE_URL` set under NODE_ENV=production MUST throw at boot,
      replicating `config.ts:421-427` (twilioApiBaseUrl) verbatim. The B4
      dev inbound route's prod-safety rests ENTIRELY on this throw; it gets
      its own explicit test.
- [ ] Adapter: compose raw MIME with `nodemailer/lib/mail-composer` (set
      Message-ID, In-Reply-To, References, Reply-To headers explicitly),
      send via `SESv2Client` `SendEmailCommand` with `Content: {Raw: {Data}}`;
      `endpoint: config.sesApiBaseUrl` + `forcePathStyle`-equivalent not
      needed (SES is not S3) - just endpoint override. Console driver logs
      a one-line summary (no body/PII).
- [ ] Unit test with injected SES client stub asserting raw MIME contains
      subject/headers/attachment part and returns MessageId.
- [ ] Gates green; commit.

### Task A4: Conversation email participation + email message type (core)

**Files:**
- Modify: `app/src/repos/conversationsRepo.ts`, `app/src/repos/messagesRepo.ts`,
  `app/src/lib/tables.ts` (byParticipantEmail GSI), `app/src/routes/inbox.ts`
  (InboxChannel 'email'), `app/src/routes/contactTimeline.ts`
- Test: `app/test/conversationsRepo.email.test.ts`,
  `app/test/messagesRepo.email.test.ts`

**Interfaces (produces):**
```ts
// conversationsRepo - THE CLAIM ARBITER (review F13): the email#<addr>
// claim item maps address -> conversationId and is the SINGLE arbiter of
// which conversation owns an address. BOTH writers below go through
// claimEmailForConversation; on claim conflict they RESOLVE TO the already-
// claimed conversation instead of erroring or creating an orphan.
claimEmailForConversation(email, conversationId): Promise<{ conversationId }> // conditional put email#<addr>; on conflict returns the existing claim's conversationId
attachEmailToConversation(conversationId, email): Promise<{ conversationId }> // claim first; if claim points elsewhere, return THAT conversation (caller uses it)
createOrGetByParticipantEmail(email, type: ConversationType): Promise<ConversationItem> // claim-put-then-create-row-with-self-heal SEQUENCE (mirror createOrGetByParticipantPhone at conversationsRepo.ts:660-717 - it is two writes with self-heal, NOT one transact)
findByParticipantEmail(email): Promise<ConversationItem | undefined>
getReplyToken(conversationId): Promise<string>                        // mints+persists email_reply_token once; token#<tok> pointer item for reverse lookup
findByReplyToken(token): Promise<ConversationItem | undefined>
// messagesRepo: MessageType adds 'email'; MessageItem email fields:
subject?: string; email_from?: string; email_to?: string[]; email_cc?: string[];
email_message_id?: string;            // RFC Message-ID (ours on outbound, theirs on inbound)
email_html_sanitized?: string         // inbound only (Phase B)
email_raw_ref?: {bucket: string; key: string}  // inbound only
// PROVIDER-ID CONVENTION (review F5/F14, pinned):
//   INBOUND email: providerSid = the RFC Message-ID (or synthesized id).
//     sid#<rfcId> pointer IS the threading lookup - no second pointer.
//   OUTBOUND email: providerSid = SES MessageId (event correlation);
//     email_message_id = our own <hc-<ulid>@domain>. append() gains an
//     optional input `rfcMessageIdPointer?: string` in NewMessage; when set
//     it adds a THIRD item emailmsgid#<rfcId> to the existing 2-item
//     TransactWriteCommand (messagesRepo.ts append :626-742).
getByRfcMessageId(messageId: string): Promise<MessageItem | undefined> // checks emailmsgid# then sid#
```

**Reader fixes (review F2/F3 - BLOCKERS, both in this task):**
- `app/src/routes/inbox.ts`: `rowForConversation` (:360-373) resolves the
  contact ONLY via `findByPhone(participant_phone)` - an email-only
  conversation would surface as a phantom `unknown` needsTriage row,
  violating spec Decision 4. Fix: resolve via participant_phone OR
  participant_email (`contacts.findByEmail`); a conversation with an email
  participant resolving to a known contact renders as that contact's row; a
  phoneless conversation resolving to NO contact must NOT render as an
  unknown-triage row (email unknowns live in the unmatched surface only -
  in practice this cannot occur since ingestion never creates contactless
  conversations, but the reader must be defensive). `deriveLatest`
  (:225-249) gains the 'email' channel.
- `app/src/routes/contactTimeline.ts`: conversation gathering (:752-760)
  iterates contactPhones only - ALSO iterate contact emails via
  `findByParticipantEmail`. `toTimelineMessage` (:342) hard-codes
  `type: mms?'mms':'sms'` - add the email branch emitting `type:'email'` +
  subject/email_* fields; widen the wire TimelineMessage type (:124).

**Steps:**
- [ ] Failing tests: claim arbiter (concurrent attach + create-or-get for
      the SAME address converge on ONE conversation - write the
      interleaving as a test with two racing calls); attach returning the
      elsewhere-claimed conversation; reply-token mint idempotent; append
      `type:'email'` outbound with third pointer / inbound with sid-only;
      dedupe on same providerSid; getByRfcMessageId both pointer kinds.
- [ ] Reader tests: email-only contact (no phones) shows its thread in the
      contact timeline; inbox shows it as a CONTACT row with channel
      'email'; NO unknown-triage row for phoneless conversations; a contact
      with phone+email threads gets ONE inbox row (newest-conversation rule
      unchanged).
- [ ] Implement repo + tables.ts GSI + both readers.
- [ ] Gates green; commit.

### Task A5: SendEmailService + API route

**Files:**
- Create: `app/src/services/sendEmailMessage.ts`,
  `app/src/routes/emailMedia.ts` (DISTINCT presign/confirm pair - review F1:
  the MMS pipeline is NOT reusable: `mmsMedia.ts` presign hard-gates on
  `isInlineMediaType` (images+pdf only) and confirm ALWAYS runs
  `planMmsMedia`, which RASTERIZES PDFs to JPEG page-1 - that would destroy
  document exchange, the core email use case)
- Modify: `app/src/routes/api.ts` (route), `app/src/index.ts` wiring,
  `app/src/lib/mediaTypes.ts` (new `EMAIL_ATTACHMENT_TYPES` allowlist:
  jpeg/png/gif/webp, application/pdf, text/plain, text/csv, docx + xlsx
  OOXML MIME ids)
- Test: `app/test/sendEmailMessage.test.ts`, `app/test/emailMedia.test.ts`,
  route test

**emailMedia contract:** `POST /api/email-media/presign` {contentType,
sizeBytes} -> presigned POST (reject type outside EMAIL_ATTACHMENT_TYPES or
size > 25 MB); `POST /api/email-media/confirm` {key} -> HEAD the object,
verify size/type match the mint, store ORIGINAL VERBATIM (no transcode, no
planMmsMedia), return {s3Key, contentType, size}. Key prefix
`email-media/<userId>/<ulid>` in the existing media bucket.

**Interfaces (produces):**
```ts
export interface SendEmailInput { conversationId: string; contactId: string; to: string; cc?: string[]; subject: string; body: string; attachmentKeys?: string[]; sentByUserId: string; sentByName: string }
// route: POST /api/conversations/:id/email  -> 202 { message } | 409 codes:
//   email_sending_disabled | email_suppressed | email_attachments_too_large | contact_email_missing
```
Behavior (each a unit test):
1. kill-switch OFF -> 409 email_sending_disabled, nothing persisted.
2. `to` must be one of the contact's emails (normalize first) -> else
   contact_email_missing; CC free-form but each validated.
3. suppression: contact flag `email_opt_out` or `email_unreachable` -> 409.
4. attachments: head each key via MediaStore, sum <= 25 MB else 409.
5. happy path: attach email claim to conversation (A4), mint reply token,
   compose From `"<sentByName> at Housing Choice" <emailFromAddress>`,
   Reply-To `relay+<token>@<emailSenderDomain>`, Message-ID
   `<hc-<messageUlid>@<emailSenderDomain>>`; persist message (author
   'teammate', delivery queued) BEFORE adapter send (optimistic parity with
   SMS), then adapter.send -> update status 'sent' + record providerMessageId
   pointer + check the B5 orphan-event parking lot for that sesMessageId and
   apply any parked bounce/complaint immediately; adapter throw -> status
   'failed' + surfaced error.
6. SSE `message.persisted` + conversation touch (reuse SMS emit path).

**Steps:** failing tests -> implement -> gates green -> commit.

### Task A6: Dashboard - EmailComposer + EmailCard + endpoints/types

**Files:**
- Create: `dashboard/src/routes/contact/EmailComposer.tsx`,
  `dashboard/src/routes/contact/contactEmails.ts` (helpers mirroring
  contactPhones.ts), `dashboard/src/routes/contact/EmailManager.tsx`
  (Manage-emails modal cloning PhoneManager.tsx)
- Modify: `dashboard/src/api/types.ts` (banner `// --- Email channel v1 ---`:
  ContactEmail, TimelineMessage.type += 'email' + subject/email fields,
  InboxChannel += 'email', ContactType += 'partner' [from A2]),
  `dashboard/src/api/endpoints.ts` (`sendEmail`, `addContactEmail`,
  `updateContactEmail`, `removeContactEmail`), `Timeline.tsx` (channel
  toggle in composer footer when contact has any email; EmailCard render
  branch inside kind 'message' when `msg.type==='email'`),
  `ContactDetail.tsx` (host EmailComposer state + onSendEmail + EmailManager
  hosting), `InboxRow.tsx` (`email: 'Email'` label),
  `ContactCreateForm.tsx` (optional email input, validated on blur)
- Test: e2e covers behavior (A7); `npm run typecheck` enforces mirrors

**Key UI contracts:**
- Channel toggle: two-segment control [Text | Email]; Email disabled with
  tooltip "No email on file - add one" when contact has no address (button
  opens EmailManager).
- EmailComposer fields: To (select of contact emails, default primary), CC
  (chip input, validated), Subject (required, single line), body textarea
  (reuses auto-grow), attachment picker REUSING the A5 presign with
  purpose 'email' caps, Send button with sending/disabled states, error
  slot mapping the A5 409 codes to friendly copy.
- EmailCard (collapsed): "EMAIL" transport tag, subject (semibold), first
  ~140 chars of body as snippet, delivery chip (reuse presentDeliveryStatus),
  from/to line; `<details>` expands full body text + attachments block
  (reuse MessageBubble attachment rendering); NO dangerouslySetInnerHTML
  anywhere (outbound is plain text; inbound HTML handled in B7 via iframe).
- Optimistic send (review F4/F9): `useContactTimeline.addOptimistic`
  (:178-217) hard-codes `type: hasMedia?'mms':'sms'` and a phone-shaped
  signature - WIDEN it (options-object param carrying `type:'email'` +
  subject/email fields, defaulting to today's behavior) rather than a
  parallel path, and compile-sweep ALL callers: `ConversationDetail.tsx`,
  `useRelayThread.ts`, `TourConversation.tsx`, `PlacementConversation.tsx`.
  `buildTimelineFallback.ts` (the 404-fallback assembler) also needs the
  email branch or email-only contacts render empty on fallback.

**Steps:** implement -> typecheck green (the compiler sweep IS the caller
map) -> visual self-check happens in A7 live QA -> commit.

### Task A7: fake-SES outbound + e2e + PHASE A GATE

**Files:**
- Create: `fake-twilio/src/engine/mailEngine.ts`, `fake-twilio/src/engine/mailStore.ts`,
  `fake-twilio/src/routes/sesRest.ts`, `fake-twilio/src/routes/sesControl.ts`,
  `e2e/fixtures/fakeEmail.ts`, `e2e/tests/flows/email-outbound.spec.ts`
- Modify: `fake-twilio/src/server.ts` (mount routers, share hub, extend
  reset), `scripts/e2e-session.mjs` childEnv (`EMAIL_DRIVER=ses`,
  `EMAIL_SENDING_ENABLED=true`, `SES_API_BASE_URL=fakeUrl`,
  `EMAIL_SENDER_DOMAIN=mail.local.test`, `EMAIL_FROM_ADDRESS=team@mail.local.test`),
  `e2e/support/preflight.ts` EXPECTED += `emailDriver:'ses'`,
  `e2e/scenarios/steps.ts` (verbs `expectEmailSentTo(address, subjectRe)`)
- Test: the spec itself + `fake-twilio` unit tests if that workspace has them

**fake-SES contract:**
- `POST /v2/email/outbound-emails` (SESv2 SendEmail shape): accept
  `{Content:{Raw:{Data: base64}}}`, parse minimal headers (To/Cc/Subject/
  Message-ID) from the MIME text (string scan is fine - do NOT add
  mailparser to the fake), store `{sesMessageId: 'ses-fake-<n>', rawMime,
  to, cc, subject, receivedAt, state:'sent'}`, return `{MessageId}`.
- `GET /control/emails` -> full store list; `POST /control/reset` clears.
- Hub event `mail.outbound` for the fake-phones UI allowlist (UI panel
  itself is OPTIONAL - skip unless trivial).

**e2e spec (accessibility-first selectors):** dev-login -> open seeded
landlord contact (has email from A1 seeds) -> toggle Email -> subject
"Welcome" + body + one image attachment -> Send -> assert EmailCard appears
with Sent chip -> `expectEmailSentTo(landlordEmail, /Welcome/)` via
`/control/emails` -> assert raw MIME contains the attachment content-type.

**PHASE A GATE steps:**
- [ ] `npm run typecheck` bare, exit 0.
- [ ] `npm test` bare, exit 0.
- [ ] `timeout 1500 npm run e2e` from the worktree, exit 0 (known flakes:
      re-run full suite before blaming the change; report both runs).
- [ ] Internal review wave (orchestrator: conformance + plan-blind
      adversarial per its manual) + ONE fix wave + re-verify.
- [ ] Commit boundary noted in ledger: "PHASE A COMPLETE @<sha>".

---

# PHASE B - inbound + surfaces

### Task B1: Terraform (AUTHOR ONLY - no apply) + RUNBOOK

**Files:**
- Create: `infra/modules/inbound_mail/{main,variables,outputs}.tf`
- Modify: `infra/envs/dev/stack.tf` + `infra/envs/prod/stack.tf` (BYTE-
  IDENTICAL - verify with `git diff --no-index` or fc), `infra/envs/dev/main.tf`
  + `infra/envs/prod/main.tf` (locals: `mail_domain` per env - dev
  `mail.dev.<domain>` / prod `mail.<domain>` - and `mail_domain_phase = 0`),
  `infra/modules/ec2/main.tf` + `variables.tf` (IAM: ses:SendEmail/
  SendRawEmail on the identity, sqs Receive/Delete/GetQueueAttributes on the
  inbound queue, s3:GetObject on the inbound bucket), `infra/modules/params/`
  (SSM: EMAIL_SENDER_DOMAIN, EMAIL_FROM_ADDRESS, INBOUND_MAIL_BUCKET,
  INBOUND_MAIL_QUEUE_URL), `scripts/lib/secretsCore.mjs` MANAGED_BY_OTHERS
  += those four (no .d.mts change - array element only), `RUNBOOK.md` new
  "Email (SES)" section
- Test: `npm run typecheck` unaffected; `terraform validate` if runnable
  offline via `npm run plan -- dev` DRY reading only - do NOT apply; at
  minimum `terraform fmt -check`

**Module contents (inbound_mail) - CLASSIC SES resource family throughout
(review F21: receipt rules exist only in classic; keep identity/DKIM/config
set consistent - `aws_ses_domain_identity` + `aws_ses_domain_dkim` +
`aws_ses_configuration_set` + event destination):** per-env domain identity
on `var.mail_domain` + DKIM tokens output; configuration set + event
destination -> SNS topic `mail-events`; S3 write to the new bucket
`${name_prefix}inbound-mail-<account>` with ses.amazonaws.com PutObject
bucket policy (aws:Referer account condition) + SNS notify topic
`mail-inbound`; both topics -> ONE SQS queue `${name_prefix}inbound-mail`
(+DLQ, redrive 5, visibility 120, raw_message_delivery = false); everything
DNS-dependent gated behind `var.mail_domain_phase` (ACM/custom_domain_phase
staircase pattern - phase 0 creates identity + outputs the DKIM
CNAMEs/MX/SPF records for manual Namecheap entry; phase 1 enables any
verification waits). Outputs: queue_url/arn, bucket_name/arn, dkim/mx/spf
record instructions.

**RECEIPT-RULE-SET STRUCTURE (review F20 - this is an account-level
singleton, NOT per-env):** SES allows exactly ONE ACTIVE receipt rule set
per account+region, and dev+prod share the account. A per-env rule set
would mean whichever env activated last silently drops the other env's
inbound mail. Structure: ONE shared rule-set name `hc-inbound-mail`; the
`aws_ses_receipt_rule_set` + `aws_ses_active_receipt_rule_set` resources
are created ONLY by the env whose `local.manage_mail_rule_set = true`
(exactly one env - set dev=true initially, documented flip procedure in
RUNBOOK); EACH env creates its OWN `aws_ses_receipt_rule` (recipients =
that env's `var.mail_domain`) referencing the shared set name. stack.tf
stays byte-identical because the differing values are locals. RUNBOOK must
state: never destroy the managing env without migrating set ownership, and
a dev-only teardown deactivates prod inbound - coordinate.

**RUNBOOK section records the owed ops sequence:** apply -> Namecheap
records (DKIM x3, MX -> inbound-smtp.us-east-1.amazonaws.com, SPF) -> phase
flip -> SES production-access request (links ses-sandbox-exit issue) ->
receipt-rule-set ACTIVATION (aws ses set-active-receipt-rule-set is
account-scoped - ONE active set per account; dev/prod share the account, so
the active set must carry BOTH envs' rules - document this explicitly) ->
flip EMAIL_SENDING_ENABLED.

### Task B2: MIME parse + ingestion service (the heart of inbound)

**Files:**
- Create: `app/src/lib/emailMime.ts`, `app/src/services/inboundEmail.ts`
- Modify: `app/src/adapters/extraction.ts` (TranscriptUtterance channel +=
  'email'), `app/src/jobs/extraction.ts` `toUtterances` email branch,
  `app/src/repos/extractionRepo.ts` channel union
- Test: `app/test/emailMime.test.ts`, `app/test/inboundEmail.test.ts` (the
  biggest test file of the feature - every routing tier + idempotency)

**Interfaces (produces):**
```ts
// lib/emailMime.ts (imports mailparser, sanitize-html, email-reply-parser)
export interface ParsedInboundEmail { rfcMessageId: string; inReplyTo?: string; references: string[]; from: {name?: string; address: string}; to: string[]; cc: string[]; subject: string; text: string; html?: string; attachments: {filename: string; contentType: string; content: Buffer; size: number}[] }
export function parseInboundMime(raw: Buffer): Promise<ParsedInboundEmail>  // mailparser simpleParser; missing Message-ID -> synthesize sha256(raw) id
export function sanitizeEmailHtml(html: string): string  // sanitize-html: defaults+img, allowedSchemes ['data','cid'] (verified spike config - strips script/onerror/javascript:/remote)
export function visibleReplyText(text: string): string   // email-reply-parser (.default!) getVisibleText(); empty -> full text
export function extractReplyToken(addresses: string[]): string | undefined  // relay+<token>@ our sender domain
// services/inboundEmail.ts
export interface InboundEmailNotice { bucket: string; key: string; spamVerdict?: 'PASS'|'FAIL'|'GRAY'; virusVerdict?: 'PASS'|'FAIL' }
export function ingestInboundEmail(notice: InboundEmailNotice, deps): Promise<{ outcome: 'threaded'|'unmatched'|'quarantined'|'duplicate'|'blocked' }>
```

**Routing behavior (each tier a test):**
1. Idempotency FIRST: execution marker keyed on rfcMessageId
   (missedCallAutoText pattern: conditional put, partition `job#email#<id>`);
   duplicate -> outcome 'duplicate', no writes.
2. virusVerdict FAIL -> quarantined (store row, never fetch attachments into
   media bucket).
3. sender blocklist hit -> 'blocked' (row stored with status dismissed).
4. spamVerdict FAIL/GRAY -> 'quarantined' unless tier 5/6 matches (a known
   contact or token beats the spam verdict - real mail must not die).
5. Reply token in To/Cc (extractReplyToken) OR inReplyTo/references matches
   getByRfcMessageId -> conversation; from-address unknown on that contact ->
   append with flag `email_new_address: true` (UI chip "New address").
6. findByEmail(from) -> contact: use existing 1:1 conversation if any
   (resolve via contact primary phone thread; else createOrGetByParticipantEmail),
   attachEmailToConversation, append (author from contact type - honesty
   rule), unread++/touch/SSE, scheduleExtraction(conversationId,'email') for
   tenant/unknown 1:1 only.
7. else -> unmatched store row (B3), SSE `unmatched_email.updated`. NO
   contact, NO conversation, NO Today input (assert: contactCapture NOT
   called - inject a spy).
Message content: body = visibleReplyText(text||html-to-text via mailparser),
email_html_sanitized = sanitizeEmailHtml(html) when html present,
email_raw_ref = {bucket,key}; attachments (threaded mail only) streamed to
MediaStore `media/<conversationId>/<rfcMessageIdSafe>/<i>` with
normalizeStoredMediaType; per-message 25 MB total cap -> oversized
attachments skipped with a stored `attachments_truncated: true` note.

**DoS + hostile-input hardening (review F17 - REQUIRED, each a test):**
1. HEAD the S3 object BEFORE fetching: > 30 MB -> quarantine row with
   `parse_skipped: 'oversize'`, raw never loaded into memory.
2. `simpleParser` invoked with `maxHtmlLengthToParse` bounded (2 MB) and the
   result capped: > 50 attachments -> keep first 50 + truncated note.
3. Parser throw / timeout (wrap in 30s Promise.race) -> quarantine row with
   `parse_skipped: 'parse_failed'` - NEVER a crash, NEVER an SQS retry loop
   (the idempotency marker is claimed before parse, so redelivery no-ops).
4. Parse concurrency: semaphore(2) around ingest in the worker dispatch
   (mirror the transcode semaphore pattern, mmsMedia.ts:45).
**PII (review F18):** raw MIME refs (`email_raw_ref`, unmatched `raw_ref`)
are NEVER presigned and NEVER served unauthed; raw bodies/addresses stay
out of logs (ids only, existing posture).

**Steps:** exhaustive failing tests (all 7 tiers + content rules) ->
implement -> gates -> commit. Then extraction seam: failing test that an
email message maps to utterances channel 'email' with TRIMMED text only ->
implement -> commit.

### Task B3: unmatched_email store + API + blocklist

**Files:**
- Modify: `app/src/lib/tables.ts` (new table `unmatched_email`: PK
  `unmatchedId`; GSI `byStatus` status HASH / received_at RANGE)
- Create: `app/src/repos/unmatchedEmailRepo.ts`,
  `app/src/routes/unmatchedEmail.ts` (mounted under /api)
- Test: `app/test/unmatchedEmailRepo.test.ts`, route tests incl. the Today
  non-regression test

**Interfaces:**
```ts
export type UnmatchedStatus = 'unmatched'|'quarantined'|'linked'|'dismissed'
export interface UnmatchedEmailItem { unmatchedId; status; from: {name?, address}; subject; snippet /*<=180 chars*/; text; html_sanitized?; raw_ref: {bucket,key}; attachments_meta: {filename, contentType, size}[]; spam_verdict?; virus_verdict?; received_at; read: boolean; linked_contact_id? }
// routes:
GET  /api/unmatched-email?filter=unmatched|quarantine&cursor  -> { rows, nextCursor, unreadCount }
POST /api/unmatched-email/:id/read
POST /api/unmatched-email/:id/link { contactId }      // addEmail to contact + re-ingest into thread (calls B2 tier-6 path with the stored raw ref) + status linked
POST /api/unmatched-email/:id/create-contact { name, type } // create contact then same as link
POST /api/unmatched-email/:id/spam                    // status dismissed + blocklist put block#<address>
POST /api/unmatched-email/:id/release                 // quarantined -> unmatched
POST /api/unmatched-email/:id/dismiss
```
Blocklist lives as pointer items `block#<address>` in the same table;
`isBlocked(address)` consumed by B2 tier 3.
Today non-regression: unit test builds Today inputs with unmatched rows
present -> output identical to without.
Retention (review F19): DynamoDB TTL attribute `expires_at` set on
linked/dismissed rows (+90 days) and quarantined rows (+90 days); unmatched
rows never expire (they await action). ADJUDICATION (planner): the
single-partition byStatus GSI is accepted at staff-tool volumes (far below
partition limits) - a `status#yyyymm` shard is deliberate over-engineering
here; revisit only if the unmatched feed ever exceeds ~1k rows/day.
unreadCount = capped first-page count (the inbox-unread 100-cap pattern),
not a table scan.

### Task B4: Delivery mechanisms - worker consumer + dev route + fake inbound

**Files:**
- Create: `app/src/services/sesNotifications.ts` (SNS/SES envelope parser),
  `app/src/routes/webhooks/ses.ts`
- Modify: `app/src/worker.ts` (second SqsJobConsumer on
  `config.inboundMailQueueUrl` with dispatch = parse -> ingest/route),
  `app/src/routes/webhooks/index.ts` (mount `/webhooks/ses/inbound` ONLY
  when `config.sesApiBaseUrl` is set. Review F15 correction: there is NO
  existing conditional-mount precedent - twilio webhooks are always
  mounted; the prod-safety of this route rests ENTIRELY on the A3 boot
  throw rejecting SES_API_BASE_URL in production, plus the x-origin-verify
  middleware. State this in a code comment at the mount site; prod inbound
  is SQS-only),
  `fake-twilio/src/engine/mailEngine.ts` (inbound: write raw MIME to MinIO
  INBOUND_MAIL_BUCKET via an S3 client built from inherited env with FIXED
  local creds - never ambient AWS_*; then POST the SNS-shaped notification
  to `/webhooks/ses/inbound` with x-origin-verify),
  `fake-twilio/src/routes/sesControl.ts` (`POST /control/send-inbound-email`
  {from, to?, subject, text, html?, attachments?[{filename, contentType,
  base64}], spamVerdict?, virusVerdict?} - composes MIME with a minimal
  hand-rolled builder or mail-composer if already in the fake's reach),
  `app/scripts/s3-create.ts` (+ inbound bucket), `scripts/e2e-session.mjs`
  childEnv (`INBOUND_MAIL_BUCKET=hc-local-inbound-mail-<lane>`; lane
  isolation holds because each session launcher spawns ITS OWN fake process
  with lane-scoped env - the fake is per-lane, only MinIO :9000 is shared,
  and the per-lane bucket is the isolation boundary - review F22 verified),
  `app/src/routes/dev.ts` reseed: clear the `unmatched_email` table in
  `/__dev/reseed` (review F23; inbound-bucket keys are run-unique so
  best-effort bucket cleanup is acceptable; `unmatched_email` must never
  enter any byte-asserted seed snapshot)
- Test: `app/test/sesNotifications.test.ts` (SNS envelope + receipt shapes
  incl. bounce/complaint/delivery discrimination), worker consumer test with
  stub SQS

**SNS/SES parsing contract:** SNS envelope `{Type:'Notification',
Message:'<json>'}`; inner receipt notification carries
`{notificationType:'Received', receipt:{action:{bucketName, objectKey},
spamVerdict:{status}, virusVerdict:{status}}}`; event notifications carry
`{eventType:'Bounce'|'Complaint'|'Delivery', mail:{messageId}, bounce:{bounceType}}`.
One parser returns a discriminated union consumed by the worker dispatch and
the dev route alike. NEVER route these through dispatchJob/the jobs queue
(they would be poison-deleted).

### Task B5: Bounce/complaint/delivery -> status + suppression

**Files:**
- Modify: `app/src/services/inboundEmail.ts` or create
  `app/src/services/emailEvents.ts` (applyEmailEvent), `app/src/repos/contactsRepo.ts`
  (flags `email_opt_out`, `email_unreachable` in ContactFlag union),
  `app/src/services/sendEmailMessage.ts` (already gates on flags - A5),
  fake: `POST /control/email-delivery-outcome` {sesMessageId, outcome:
  'delivered'|'bounce'|'complaint'} -> posts event JSON to the dev route
- Test: `app/test/emailEvents.test.ts`

**Behavior:** Delivery -> delivery_status 'delivered' via sid pointer
(forward-only machine reused). Bounce bounceType 'Permanent' -> status
'undelivered' + set `email_unreachable` on the contact owning that address;
'Transient' -> 'undelivered' only. Complaint -> `email_opt_out`. Suppressed
sends then 409 (A5 test extended: end-to-end unit test bounce -> subsequent
send refused).
**Orphan-event parking (review F12 - REQUIRED):** the SES MessageId is only
knowable AFTER send, so a fast bounce (or a crash between send-return and
pointer-write) can arrive before the sid pointer exists. An event whose
sesMessageId resolves to no message is PARKED as an
`emailevent#<sesMessageId>` item (payload + receivedAt, TTL 7d) instead of
ignored; A5's post-send pointer write then CHECKS the parking lot and
applies any parked event immediately. Tests: bounce-before-pointer ->
suppression still lands; parked event applied exactly once.

### Task B6: Unmatched-email UI - nav item, badge, page

**Files:**
- Create: `dashboard/src/routes/email/EmailTriage.tsx` (+ `useUnmatchedEmail.ts`,
  `UnmatchedRow.tsx`, module CSS) cloning the Inbox page family,
  `dashboard/src/app/` badge plumbing
- Modify: `dashboard/src/app/nav.ts` (Communications group: `{to:'/email',
  label:'Email', icon:'email', badge:'unmatched-email-unread'}`; NavIconName
  += 'email'; badge union widened), `dashboard/src/ui/icons.tsx` (EmailIcon
  envelope + NAV_ICONS entry), `dashboard/src/app/NavContents.tsx` (branch
  on the new badge value), `dashboard/src/app/UnreadContext.tsx` (extend to
  `{unread, unmatchedUnread}` - unmatchedUnread from GET /api/unmatched-email
  unreadCount, refetch on SSE `unmatched_email.updated`, null-degrade on
  404), `dashboard/src/App.tsx` (routes `/email` + `/email/quarantine`,
  IMPLEMENTED set), `dashboard/src/api/types.ts` + `endpoints.ts` +
  `EventStreamProvider.tsx` (event `unmatched_email.updated` +
  onUnmatchedEmailUpdated handler)
- Test: e2e in B8; typecheck

**Page contract:** URL-backed tabs (Unmatched | Quarantine) via Links with
aria-current; rows: from address/name, subject (semibold), snippet, relative
time, spam tag on quarantine rows, unread dot; row actions: "Link to
contact" (modal: contact typeahead - reuse the existing committed-state
typeahead component), "New contact" (modal with name + type picker
[tenant/landlord/partner], then links), "Spam" (confirm -> blocklists),
"Dismiss"; quarantine rows: "Release", "Delete". Empty states per tab
("No unmatched email" / "Quarantine is empty"). Badge counts unmatched
unread only (not quarantine).

### Task B7: Inbound rendering - EmailCard inbound + safe HTML + quote collapse

**Files:**
- Modify: `dashboard/src/routes/contact/Timeline.tsx` EmailCard (inbound
  variant), `dashboard/src/api/types.ts` (email_html_sanitized,
  email_new_address on TimelineMessage)
- Create: `dashboard/src/routes/contact/EmailHtmlFrame.tsx`
- Test: e2e assertion in B8 that a script-bearing inbound email renders
  inert

**EmailHtmlFrame contract:** `<iframe sandbox="" srcDoc={framedHtml}
title="Email message">` - sandbox EMPTY (no scripts, no same-origin);
`framedHtml` = a CSP meta PREPENDED to the server-sanitized
`email_html_sanitized`:
`<meta http-equiv="Content-Security-Policy" content="default-src 'none';
img-src data:; style-src 'unsafe-inline'">` - review F16: the sandbox alone
does NOT stop remote image/tracker fetches; the CSP inside the srcDoc is
what enforces the spec's remote-image block (sanitize-html's scheme strip
is defense-in-depth, the CSP is the guarantee). Defense in depth: sanitized
once at ingest, CSP-framed at render; the no-dangerouslySetInnerHTML rule
is honored - srcDoc into a fully sandboxed iframe is the sanctioned
pattern; code comment at the component saying exactly why. Auto-height via
onLoad measurement capped at 480px with inner scroll. Unit-assert the CSP
meta is present in framedHtml; e2e asserts no dialog fires from a
script-bearing email. EmailCard inbound: collapsed = subject + trimmed-
text snippet + "New address" chip when email_new_address; expanded =
trimmed text; "Show quoted text" <details> reveals full text; "View
original formatting" <details> mounts EmailHtmlFrame only when
email_html_sanitized present (lazy - do not mount collapsed).

### Task B8: e2e specs + steps + live self-QA + docs + issues + FINAL GATES

**Files:**
- Create: `e2e/tests/flows/email-inbound.spec.ts`,
  `e2e/tests/flows/email-triage.spec.ts`
- Modify: `e2e/scenarios/steps.ts` (verbs: `partnerEmailsIn(from, subject,
  body)`, `expectEmailInTimeline(subjectRe)`, `expectUnmatchedRow(fromRe)`),
  `e2e/fixtures/fakeEmail.ts` (sendInboundEmail, emailDeliveryOutcome),
  `documentation/GLOSSARY.md` (partner noun + unmatched email +
  quarantine), `docs/issues/` new: `email-identity-collision-followup.md`
  (v1 rule = one contact per address via unique claim, `email_in_use`
  conflict; proper shared-address handling owed) and `email-cc-mirroring.md`
  (CC'd known contact timeline mirroring), memory topic file update happens
  at handback per profile
- ADJUDICATED DEFERRAL (planner, 2026-07-20): spec B10's "ideally ships a
  minimal attach-to-placement/unit action" is DEFERRED - the hard
  requirement (do not preclude: attachments live in MediaStore keyed per
  message, promotable later) IS satisfied, and the existing open issue
  `inbound-media-attach-to-unit` already tracks the promote surface for all
  inbound media incl. email. State this in the handback.
- Spec coverage matrix (each an e2e test):
  1. Known landlord emails in -> appears in their timeline, inbox row
     channel Email, unread badge; reply from staff threads with
     In-Reply-To.
  2. Reply from a NEW address to a relay+token thread -> lands in thread +
     "New address" chip.
  3. Unknown sender -> Email nav badge increments, row in Unmatched, NOT in
     general inbox, NOT in Today; Link-to-contact moves it into the contact
     timeline and adds the address.
  4. spamVerdict FAIL unknown sender -> Quarantine tab only; Release moves
     to Unmatched.
  5. Script-bearing HTML email -> renders inert (no dialog; assert page has
     no alert; assert iframe present + sandbox attr).
  6. Bounce outcome -> chip failed/undelivered + subsequent send 409 with
     friendly error.
  7. Outbound with attachment (from A7, re-verified post-B).
- [ ] FINAL: merge latest main INTO the branch (ONE sync, per memory rule),
      re-run all three gates bare from the worktree, live self-QA via
      e2e:session + Playwright MCP (screenshots to .playwright-mcp/):
      compose+send, triage flow, quarantine, EmailCard rendering; UI
      quality self-audit per profile.

---

## Owed post-merge ops (record in handback + RUNBOOK - NONE run in-mission)

1. `npm run plan/apply -- dev` (byEmail GSI, byParticipantEmail GSI,
   unmatched_email table, inbound_mail module, EC2 IAM, params) - then prod.
2. Namecheap DNS: 3 DKIM CNAMEs, MX -> inbound-smtp.us-east-1.amazonaws.com
   on the mail subdomain, SPF TXT - per terraform outputs; then
   mail_domain_phase flip + re-apply.
3. SES receipt-rule-set ACTIVATION (account-scoped single active set -
   coordinate dev+prod rules in it).
4. SES production-access request (ses-sandbox-exit issue).
5. `npm install` (new deps) on deploy; flip EMAIL_SENDING_ENABLED when 1-4
   done.
6. Dev reseed (seed emails).

## Task-order / dependency notes for the orchestrator

A1 -> A2 -> A3 -> A4 -> A5 -> A6 -> A7 (strictly serial; A3 parallel-safe
with A2 if desired but keep one writer). PHASE GATE. B1 independent
(terraform-only - may run as its own slice any time in Phase B); B2 -> B3 ->
B4 -> B5 -> B6 -> B7 -> B8. Watch items: lean-seed byte assertions (A1);
exhaustive-switch compile errors are the partner-type map (A2); nodemailer
imported ONLY as nodemailer/lib/mail-composer (A3); email-reply-parser
`.default` (B2); never dispatch SES notifications through dispatchJob (B4);
stack.tf byte-identical check (B1); MinIO fixed creds never ambient (B4);
9000 shared across lanes - bucket is the per-lane isolation (B4).
