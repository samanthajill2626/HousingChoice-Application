---
id: extraction-conversation-contact-divergence
title: A conversation's participant contactId can diverge from the phone roster, sending extraction facts to a contact nobody aimed at
type: bug
severity: med
status: open
area: app/extraction
created: 2026-08-16
refs: app/src/repos/conversationsRepo.ts:1460, app/src/routes/contacts.ts:2085, app/src/jobs/extraction.ts:412, app/src/lib/contactThreads.ts:43
---

**Pre-existing.** The automatic extraction path has carried this since
conversations gained participant contactIds; the manual trigger is only the
first surface where a human aims a run at a NAMED contact, which is what makes
the divergence visible. Found by the manual-extraction-trigger handback review
(adversarial R2, finding 2), which proved reachability.

**Problem.** A 1:1 conversation's `participants[0].contactId` is written once,
at creation (`setParticipantsIfAbsent`, conversationsRepo.ts:1460), and no
route ever rewrites it. Phone curation (`POST /api/contacts/:id/phones`, and
its removal counterpart) moves a number between contacts WITHOUT touching any
conversation record. After staff curate phone P from stub contact Y onto real
tenant X:

- `conversationsForContact(X)` resolves P's thread for X (phone-roster match,
  contactThreads.ts:43) - so X's page lists it, and a manual press on X arms it.
- The extraction job resolves the SAME thread's contact from
  `participants[0].contactId` = Y (jobs/extraction.ts:412) - so the run writes
  its facts to Y.

**Effect.** Extraction output (voucher size, authority, address, notes) lands
on a record nobody is looking at; the run log shows an `applied` run against Y
that nobody requested. On the manual path the mismatch is now REPORTED (the
banner says the thread is filed under a different contact, since 30023f32's
follow-up); on the automatic path it stays silent.

**Fix directions (either):** rewrite `participants[0].contactId` as part of
phone curation, or have the job prefer the roster-resolved contact when the
pointer disagrees. Both need care with the point-in-time resolution rules the
comms history depends on (contact-comms-pane design).

**Not fixed here** because the correct write-time ownership rules are a design
question touching triage, curation and history rendering, not an extraction
patch.
