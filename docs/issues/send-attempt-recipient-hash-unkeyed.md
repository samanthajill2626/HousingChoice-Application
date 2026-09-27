---
id: send-attempt-recipient-hash-unkeyed
title: The send-attempt recipient hashes are unkeyed sha256 over a phone number, so a hash in a send.reconcile queue payload is effectively the phone
type: security
severity: low
status: open
area: app/messaging
created: 2026-09-27
refs: app/src/lib/sendFingerprint.ts:31, app/src/lib/sendFingerprint.ts:43, app/src/lib/sendFingerprint.ts:48, app/src/jobs/sendReconcile.ts:126, app/src/jobs/sendReconcile.ts:363, app/src/repos/sendAttemptsRepo.ts:176, app/src/repos/sendAttemptsRepo.ts:183
---

**Problem.** `feat/send-outcome-reconcile` hashes the recipient wherever it
wants to avoid carrying a phone number, but both hashes are plain sha256 with
no secret:

- `hashRecipientKey` (`app/src/lib/sendFingerprint.ts:47-51`) turns a
  contact-less recipient key `phone#<E164>` into
  `phonehash#<first 32 hex of sha256(key)>`;
- `recipientDigest` (`:43-45`) is the first 32 hex of
  sha256(`<sender>|<E164>`) - salted with the sender number, which is not a
  secret.

The NANP number space is small (on the order of ten billion numbers), so
either value can be turned back into the phone by brute force; code review
round 1 (ADV-9) estimated seconds.

**Where the hashes travel.**

- The `send.reconcile` payload's `owner.recipientKeyHash` (`toOwnerRef`,
  `app/src/jobs/sendReconcile.ts:126-145`): every reconcile check's SQS
  message body, and the DLQ after five failures. This is the real exposure:
  the payload is meant to carry identifiers only, never a phone (spec D12,
  D18).
- The attempt record's sort key (`app/src/repos/sendAttemptsRepo.ts:176-181`),
  the recipient index's partition `sendattemptix#<sender>#<digest>`
  (`:183-185`) and the record's `recipient_digest`. These add little: the
  record's `owner` map, and the index item's, keep the RAW recipient key
  anyway - which is how a reconcile addresses the slot (the comment at
  `sendFingerprint.ts:31-42` now says so).

**Already done on the branch** (FW1-10, commit `6763d51b`): the "owner
recipient not found" INFO no longer logs the payload owner - it logs the
owner kind and its ids only (`ownerRefLog`, `sendReconcile.ts:362-372`, used
at `:392-395`); and the `sendFingerprint.ts` comment that claimed the record
never holds a phone was corrected. Every reconcile and fan-out log line
carries a recipient key only through `safeRecipientKey` (a phone key logs as
`phone#redacted`, `sendFingerprint.ts:53-56`), and the job framework logs no
payloads (its dispatch lines carry the job name and id only,
`app/src/jobs/jobs.ts:323-340`).

**User-visible.** None. Anyone who can read the jobs queue or its DLQ can
recover the phone numbers of contact-less share recipients and phone-only
relay members from reconcile payloads (a contact id key is carried as is -
`hashRecipientKey` hashes only `phone#` keys).

**Suggested fix.** Key both hashes with an HMAC over a server-side secret,
and keep the comment in step. Keying changes every stored value, so records
and index items written before the change stop matching; the items expire in
30 days (the record's TTL), so a cutover can dual-read or wait out that
window.

**Why it was not fixed on the branch.** Keying needs a new secret provisioned
per environment - infrastructure, which this branch does not touch (spec Sec
10) and which no agent pushes without an explicit request. Ruled RESIDUE in
code review round 1
(`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/code-review/r1-adjudications.md`,
sections 1 and 4); the log-line and comment halves were fixed there (FW1-10).

**Related.** [send-attempt-sweeper](./send-attempt-sweeper.md) (the record
shape these keys belong to).
