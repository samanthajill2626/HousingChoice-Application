---
id: declarable-office-doc-types-double-click
title: Declarable text/csv, .docx and .xlsx now download double-clickable from an untrusted sender
type: security
severity: low
status: open
area: app/media
created: 2026-08-26
refs: app/src/lib/mediaTypes.ts:65-87, app/src/lib/mediaFilename.ts:1-13, docs/superpowers/specs/2026-08-26-media-content-type-fidelity-design.md
---

**Problem.** The media-content-type-fidelity feature (2026-08-26) added a
DECLARABLE tier and typed download filenames. Together those two changes make
three sender-chosen types land on an operator's disk as a file the operating
system will OPEN on a double-click:

- `text/csv` -> `Payroll Q3.csv`
- `application/vnd.openxmlformats-officedocument.wordprocessingml.document` -> `.docx`
- `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` -> `.xlsx`

Before the feature, the same inbound attachment was stored as
`application/octet-stream` and served as
`Content-Disposition: attachment; filename="attachment-0"` - extensionless, and
therefore inert on a double-click. The sender picks the declared Content-Type
(an MMS `MediaContentType{i}` parameter, or an inbound email part's own header)
and the stored filename, so both halves of that name are attacker-influenced.
The classic follow-ons are CSV formula / DDE injection when the file is opened
in Excel, and the remote-template class for `.docx`.

The two documented threat models each cover their own half and neither covers
this overlap. `mediaTypes.ts` scopes the declarable tier's entry criterion to
the BROWSER ORIGIN ("a browser handed one of these cannot execute anything in
the dashboard origin"), which remains true. `mediaFilename.ts` states the
opposite intent for the name ("a name the operating system ACTS ON, which is
precisely why the sender must not choose it") and enforces it by taking the
EXTENSION from our own closed set - but for these three types our own closed set
is exactly the OS-actionable one.

**Exposure is bounded, and was accepted by design.** The operator must both
download and open the file; Office opens a downloaded document in Protected
View; the operator population is small, authed and staff-only; and the same
bytes were already downloadable before the feature, just harder to open. This is
the same class of exposure as any email-attachment workflow. Design decision D1
of the spec locked the declarable list naming these exact three types, so the
residual is a recorded acceptance, not an oversight - filed here so it is
written down rather than implied. Raised as finding P2 of the branch's
adversarial review.

**Suggested fix.** Only if this is ever revisited; no change is proposed today:

- Drop `text/csv`, `.docx` and `.xlsx` back to the OPAQUE tier. They keep their
  stored extension there anyway (`extFor` honours a recognised stored
  extension on the opaque tier), so the cost is the Content-Type header and the
  timeline kind word, not the filename.
- Or keep them and record the acceptance in the spec itself, so the next reader
  of `mediaFilename.ts` finds the reasoning next to the rule it qualifies.
