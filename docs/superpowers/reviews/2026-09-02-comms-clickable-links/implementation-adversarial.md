# Adversarial implementation review: communications-body link rendering

## Verdict

NEEDS FIX. Two findings require disposition before the final handback. This was
a plan-blind review of the implementation diff and live consumers only.

## Findings

### P1 - The new browser spec leaves a planted message in the shared hermetic seed state

`e2e/tests/dashboard-next/comms-clickable-links.spec.ts:35-41` reseeds the
one-worker e2e lane and then persists a new message through
`/__dev/extraction/message-fixture`. The spec has no `afterEach` or `afterAll`
cleanup. The Playwright configuration deliberately runs the whole suite with
one worker (`e2e/playwright.config.ts:140-141`), so every dashboard-next spec
that follows this file receives this extra, current-timestamp communication.
That is a real cross-test state dependency, not merely an unclaimed fixture.

The repository's nearby mutating browser coverage demonstrates the required
boundary: `e2e/tests/dashboard-next/message-transport-fidelity.spec.ts:103-109`
reseeds before its mutations and reseeds again in `afterAll`. The new test only
does the first half. A later test that expects lean transcript contents, a
timeline count, or a fixed newest communication can now fail depending on file
order, and a focused run leaves the lane dirty for the next focused run.

Resolution: use the existing reseed fixture/helper and add an unconditional
cleanup hook that restores lean state after this spec (including when an
assertion fails). Keep the cleanup scoped to the hermetic lane; do not touch any
human dashboard port. Re-run this spec and a representative later dashboard
spec, then the final full e2e gate.

### P2 - Malformed scheme matches are silently converted to a different HTTP(S) destination

`dashboard/src/ui/LinkifiedText.tsx:30-36` sends every non-TLD
`scheme` match's exact source string to `safeHttpUrl`. That helper accepts a
string whenever `new URL()` produces an HTTP(S) protocol
(`dashboard/src/lib/safeUrl.ts:9-16`). For WHATWG special schemes, that parser
repairs malformed source forms by adding an authority separator. Consequently,
the linkifier can make a malformed sender string actionable and navigate to a
different textual URL:

```
source:    http:example.com/a
match:     http:example.com/a (Autolinker scheme match)
candidate: http:example.com/a
href:      http://example.com/a
```

I reproduced the same result directly with the installed Autolinker 4.1.5 and
the native URL parser; `https:example.com/a` and `http:///example.com/a` behave
the same way. The component preserves the malformed label while the anchor
navigates to a silently repaired hostname, unlike the intentional normalization
for public bare domains and protocol-relative URLs. This violates the component
security boundary's stated absolute-HTTP(S) input model and creates a
sender-text/destination integrity surprise.

Resolution: retain the parser's source range, but require a scheme match to be
an explicit absolute `http://` or `https://` source before forwarding it to
`safeHttpUrl`; leave malformed scheme forms as literal text. Keep the existing
TLD and protocol-relative normalization path unchanged. Add regression cases
for the three forms above, checking both no anchor and byte-for-byte retained
text.

## Sweep notes

- All current `LinkifiedText` consumers are `Timeline` message bodies,
  collapsed and expanded plain-text email bodies, and expanded unmatched-email
  details (`dashboard/src/routes/contact/Timeline.tsx:1035-1038,1506-1518` and
  `dashboard/src/routes/email/UnmatchedRow.tsx:182-184`). The unmatched row
  preview remains a plain button child and is not linkified
  (`UnmatchedRow.tsx:122-138`).
- Each generated anchor uses source text as its label, a `safeHttpUrl` result as
  `href`, `target="_blank"`, `rel="noopener noreferrer"`, and stops bubbling
  to the Timeline bubble click handler (`LinkifiedText.tsx:75-88`). I found no
  direct HTML injection or nested-interactive-element regression in those paths.
- The parser masks only literal angle brackets in a same-code-unit parser copy
  and slices display text from the original source (`LinkifiedText.tsx:23-25,
  44-60`). A direct installed-package probe confirmed URL offsets remain correct
  after an astral Unicode character and after raw script/comment-shaped text.
- The new runtime dependency is locked exactly at Autolinker 4.1.5 with its
  pure-JavaScript `tslib` dependency (`dashboard/package.json:10` and
  `package-lock.json:4682-4692,8266-8269`).

No source, test, manifest, lockfile, or git-state changes were made by this
review.
