# Spec round 1 - reviewer A

## 1. BLOCKING - The stated localhost exclusion is not implemented by the specified mechanism

### What is wrong

The spec promises that `localhost` never linkifies, but its only proposed filters are
the `linkify-it` configuration and `safeHttpUrl`. Neither enforces that rule for
explicit HTTP(S) or protocol-relative input. The required localhost unit test will
therefore fail unless the builder adds a host rejection rule that the recognition
contract does not specify.

### Evidence

- Spec section 3, decision 5 says not to linkify `localhost`; section 6 only disables
  fuzzy email/IP plus `ftp:` and `mailto:` before passing matches to `safeHttpUrl`.
- The installed `linkify-it` parser accepts `http://localhost:3000/a`,
  `https://localhost/a`, and `//localhost/a` under exactly that configuration. Its
  HTTP host rule accepts a single domain label at
  `node_modules/linkify-it/lib/re.mjs:125-156`; its protocol-relative rule explicitly
  accepts `localhost` at `node_modules/linkify-it/index.mjs:65-91`.
- `safeHttpUrl` checks only `parsed.protocol` at
  `dashboard/src/lib/safeUrl.ts:9-17`, so all three strings remain accepted HTTP(S)
  destinations.

### What it implies

Specify the authoritative localhost rejection and where it runs before
`safeHttpUrl`, or remove localhost from the locked exclusion and its required test.
As written, the proposed parser/safety boundary cannot satisfy the product contract.

## 2. HIGH - A real inbound plain-text email reader is omitted without an explicit scope decision

### What is wrong

The design asserts coverage for plain-text inbound email and says `Timeline.tsx` is
the shared reader seam, but the dashboard also renders received email outside the
Timeline: unmatched-email triage. This is not an inbox preview, composer, metadata
field, or HTML-email frame. It is the received message's plain-text body. The spec
does not state that this reader is excluded, nor does its rendering plan or test plan
cover it.

### Evidence

- The outcome promises plain-text inbound and outbound email coverage (spec section
  1, lines 11-14), while sections 2 and 4 name only Timeline/EmailCard as the email
  reader seam and scope.
- `dashboard/src/routes/email/UnmatchedRow.tsx:105-113` fetches the full unmatched
  email detail when the operator opens the received message.
- `dashboard/src/routes/email/UnmatchedRow.tsx:136` renders its received-mail
  snippet and `dashboard/src/routes/email/UnmatchedRow.tsx:177-193` renders
  `detail.text` as the full plain-text body, independently of `Timeline`.
- The existing `EmailHtmlFrame` remains a separate, sandboxed HTML path at
  `dashboard/src/routes/email/UnmatchedRow.tsx:183-193`, so preserving that
  non-goal does not exclude the plain-text reader.

### What it implies

Choose and record the boundary. If plain-text inbound email means every reader as
the outcome says, `UnmatchedRow` needs the same safe linkification contract and
focused coverage. If triage is intentionally out of scope, add it explicitly to the
non-goals and narrow the outcome/acceptance language to Timeline email cards; a
builder otherwise has no defensible interpretation.
