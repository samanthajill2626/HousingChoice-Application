---
id: sms-copy-non-gsm7-characters
title: Outbound SMS copy must be GSM-7; three nudges use an em dash and bill double
type: bug
severity: low
status: open
area: app/messages
created: 2026-08-05
refs: app/src/messages/catalog.ts:139, app/src/messages/catalog.ts:156, app/src/messages/catalog.ts:164
---

**Problem.** A single character outside the GSM-7 alphabet flips an ENTIRE SMS to
UCS-2 encoding, which collapses the per-message budget from 160 characters to 70
(and from 153 to 67 per part once it splits). Three placement-nudge defaults in
the catalog contain a U+2014 EM DASH, and two of them are consequently billed as
two segments for what is otherwise a short one-segment message:

```
nudge.receipt_check       UCS-2   95u  2 seg   <-- doubled by one em dash
nudge.rta_window_closing  UCS-2   87u  2 seg   <-- doubled by one em dash
nudge.approval_check      UCS-2   63u  1 seg   (7 characters from tipping over)
```

Every other `channel: 'sms'` entry is GSM-7 today, so this is a small, contained
defect. The durable problem is that NOTHING enforces it: the next person to type
an em dash, a curly apostrophe, an ellipsis, or an emoji into a catalog default
silently doubles the send cost of that message, and nothing in typecheck, the
unit suite, or review catches it. The repo already keeps specs/prompts/logs plain
ASCII by convention; outbound copy has no equivalent guard.

Note the criterion is GSM-7, not ASCII, and the two differ in both directions:
GSM-7 additionally admits accented characters (pound, yen, e-grave, n-tilde,
u-umlaut, ...), while the ASCII characters `^ { } \ [ ~ ] |` live in the GSM-7
EXTENSION table and cost 2 septets each rather than 1. An ASCII-only rule is a
safe approximation but will mis-price those eight.

**Scope.** Catalog DEFAULTS are the enforceable surface. Two other sources can
introduce UCS-2 at runtime and are NOT in scope for a hard gate:

- Operator overrides (`welcomeText`, `missedCallAutoText` on OrgSettings, and any
  future generic override map). These are user input; the right treatment is an
  advisory warning in the Settings UI showing encoding + segment count, not a
  rejection.
- Interpolated values. A contact named Jose or Renee, or a street name with an
  accent, legitimately flips a message to UCS-2 at send time. That is correct
  behavior and must not be stripped or transliterated: mangling a person's name
  to save a segment is the wrong trade.

**Suggested fix.**

1. Add a pure `lib/smsEncoding.ts` exposing `analyzeSms(body)` -> `{ encoding,
   units, segments, nonGsm7Chars }` using the GSM-7 basic + extension tables.
2. Add a unit test over `MESSAGE_CATALOG` asserting every `channel: 'sms'` entry's
   `default` is GSM-7 encodable, and reporting its segment count. This is the
   guard that keeps the next em dash out.
3. Replace the em dash with a hyphen in the three nudge defaults above. Copy
   reads the same; all three become single-segment GSM-7.
4. Consider reusing `analyzeSms` for the `maxChars` field the catalog already
   declares but does not currently validate.
