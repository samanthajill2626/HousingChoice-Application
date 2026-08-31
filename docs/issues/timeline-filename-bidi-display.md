---
id: timeline-filename-bidi-display
title: A BiDi override in a stored attachment filename spoofs the extension in the timeline label
type: security
severity: low
status: open
area: dashboard
created: 2026-08-26
refs: dashboard/src/routes/contact/Timeline.tsx:610-625, app/src/services/inboundEmail.ts:681-686, app/src/lib/mediaFilename.ts:57-66
---

**Problem.** A stored attachment filename from an inbound EMAIL renders verbatim
as the dashboard's link text, so a Unicode direction-control character inside
that name visually reverses everything after it and can make one extension look
like another.

The path is three hops, none of which sanitizes:

1. `app/src/services/inboundEmail.ts:681-686` persists the sender-supplied MIME
   part `filename` onto `media_attachments` VERBATIM. It is byte-capped
   (`truncateToBytes`) against a hostile long name, never character-filtered.
2. `dashboard/src/api/types.ts:2116` surfaces that string raw on the
   attachment.
3. `dashboard/src/routes/contact/Timeline.tsx:610-625` `attachmentLabel` returns
   it unchanged as the visible text of the file link (and as the `<img alt>` on
   the inline branch).

An attacker emails the intake address a part declared `text/csv` with
`filename="invoice<U+202E>fdp.csv"`. The operator sees `invoicevsc.pdf` in the
timeline, which is where they decide whether to click.

**Pre-existing, and NOT widened by the media-content-type-fidelity branch
(2026-08-26).** Inbound MMS attachments carry no filename at all
(`media_attachments.filename` is documented as absent on MMS/inbound/legacy -
`app/src/repos/messagesRepo.ts:808-814`), so the only source of a stored name is
the email channel, which predates that branch. What the branch DID change is the
other half: `sanitizeName` now REMOVES the direction-control class
(`app/src/lib/mediaFilename.ts:57-66`), so the served
`Content-Disposition` - and therefore the name the file lands on disk under - is
clean.

That leaves the two surfaces DISAGREEING, which is arguably worse than both
being wrong: the timeline says `invoicevsc.pdf`, the download says
`invoice_fdp.csv`. The display label is now the whole of the remaining exposure.

Exposure is bounded the same way the rest of this class is: the operator
population is small, authed and staff-only; the file still downloads rather than
opens; and the served headers are hardened (`nosniff`, a sandboxing CSP, and an
`attachment` disposition). It is a deception surface, not an execution one.

**Suggested fix.** Either is a small change; the second is the more complete:

- Strip the same character class in `attachmentLabel` before rendering, reusing
  the list already written down in `app/src/lib/mediaFilename.ts:57-66` rather
  than a second copy of it.
- Or sanitize ONCE at persist time in `inboundEmail.ts`, so every reader of the
  stored name - this label, any future export, any future email reply - sees the
  clean value and the two surfaces cannot drift again.

Raised as finding NF7 of the media-content-type-fidelity branch's second review.
