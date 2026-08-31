---
id: outbound-email-attachment-filename-unsanitized
title: Outbound email attachment filenames are CR/LF-sanitized only, so .exe reaches a recipient's disk
type: security
severity: med
status: open
area: app/email
created: 2026-08-27
refs: app/src/services/sendEmailMessage.ts:333-345, app/src/lib/mediaFilename.ts
---

**Problem.** The INBOUND serve path now treats a stored filename as untrusted:
the extension is always chosen from our own closed sets, the stem is stripped of
path separators, traversal, control characters, Windows-reserved characters,
reserved device names and BiDi controls, and the whole thing is capped
(`app/src/lib/mediaFilename.ts`). The reasoning is that a filename the OS acts
on must not be chosen by whoever sent us the file.

The OUTBOUND email path applies none of that. `sendEmailMessage` takes the
client-supplied filename, strips CR and LF, trims, and uses it as the MIME
part's filename:

```
const cleanName = filename?.replace(/[\r\n]+/g, ' ').trim();
```

(`app/src/services/sendEmailMessage.ts:333-345`.) So `invoice.exe`,
`report.pdf.js`, a name with a BiDi override that displays as `fdp.exe`, or a
200-character name all pass through onto a THIRD PARTY's disk - a tenant's or a
landlord's, not staff's.

`app/src/lib/mediaTypes.ts` currently records that the duplicated extension map
"does not feed a security decision". That is true of the map, but it sits
directly above this asymmetry and reads as though the outbound side were
equally guarded. It is not.

**Scope note.** This is PRE-EXISTING and was explicitly a non-goal of
`feat/media-content-type-fidelity`, which was scoped to the inbound read path.
It is filed because that work built exactly the sanitizer this path wants, so
the fix is now cheap rather than speculative.

**Suggested fix.** Reuse `buildMediaFilenameParts`'s stem sanitization for the
outbound MIME filename. The EXTENSION rule should differ: outbound attachments
are staff-chosen from a known allowlist (`EMAIL_ATTACHMENT_TYPES`), so the
extension can come from the confirmed content type rather than being refused.
Decide deliberately whether a staff member may send an arbitrary extension at
all - the current behavior permits it, and nobody has ruled on that.

Found by the planner's plan-blind adversarial review, run retroactively after
`feat/media-content-type-fidelity` had already merged.
