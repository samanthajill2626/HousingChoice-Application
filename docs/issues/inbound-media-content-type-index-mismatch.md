---
id: inbound-media-content-type-index-mismatch
title: Inbound mirror reads MediaContentType at the COMPACTED index, so a gap pairs the wrong type
type: bug
severity: med
status: open
area: app/webhooks
created: 2026-08-27
refs: app/src/routes/webhooks/twilio.ts:440-448, app/src/routes/webhooks/twilio.ts:486-490
---

**Problem.** `parseInboundMediaUrls` builds its list by SKIPPING absent or empty
entries:

```
for (let i = 0; i < numMedia; i++) {
  const url = params[`MediaUrl${i}`];
  if (typeof url === 'string' && url.length > 0) urls.push(url);
}
```

(`app/src/routes/webhooks/twilio.ts:440-448`.) The result is COMPACTED - its
positions are not Twilio's `MediaUrl{i}` numbering once anything is skipped.

The mirror then pairs each URL with a content type by the COMPACTED position:

```
const targets = mediaUrls.map((url, index) => ({
  index,
  url,
  contentType: params[`MediaContentType${index}`],
}));
```

(`:486-490`.) So if `MediaUrl0` is absent and `MediaUrl1` is present, the
surviving URL sits at compacted index 0 and is stamped with
`MediaContentType0` - a different attachment's type, or undefined.

The consequence is now larger than it was. Before the declarable tier existed,
a wrong type usually collapsed to `application/octet-stream` and the damage was
invisible. Now a mismatched type is STORED TRUTHFULLY and SERVED, so an
attachment can be served and named as something it is not - a video labelled
`.pdf`, say. The write-side allowlist still prevents anything script-capable
from being served inline, so this is a correctness bug rather than an XSS one.

**UNVERIFIED:** whether Twilio ever actually sends a gapped `MediaUrl{i}`
sequence. `NumMedia` is documented as a count, and the skip-empty guard in
`parseInboundMediaUrls` suggests somebody once saw a reason for it, but no
observed gap is recorded anywhere in this repo. If Twilio never gaps, this is
latent.

**Scope note.** PRE-EXISTING. `feat/media-content-type-fidelity` inherited it
and did not introduce it; its backfill documents the very same compaction one
line away from where it derives its own index from the s3Key, which is what
made the mismatch visible.

**Suggested fix.** Keep the provider index alongside the URL instead of
recompacting: have `parseInboundMediaUrls` return `{ index, url }` pairs
carrying the ORIGINAL `i`, and read `MediaContentType{originalIndex}`. Note the
s3Key would then encode the provider index rather than the compacted one, so
this must NOT be applied without checking the backfill's key parser and the
`/media/:idx` addressing, which both assume today's compacted numbering.

Found by the planner's plan-blind adversarial review, run retroactively after
`feat/media-content-type-fidelity` had already merged.
