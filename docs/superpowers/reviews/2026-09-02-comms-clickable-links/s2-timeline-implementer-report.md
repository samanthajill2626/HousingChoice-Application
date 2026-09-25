# S2 Timeline implementer report

## Scope and commit intent

- Owned tracked paths: `dashboard/src/routes/contact/Timeline.tsx` and
  `dashboard/src/routes/contact/Timeline.linkified.test.tsx`.
- The Timeline imports `LinkifiedText` solely from `../../ui/index.js` and uses
  it at the existing MessageBubble body, EmailCard snippet, and EmailCard full
  plain-text body sites. No caller, attachment, composer, scheduled card,
  transcript, metadata, or original HTML-email code changed.

## TDD evidence

- RED: `npm test --workspace @housingchoice/dashboard -- src/routes/contact/Timeline.linkified.test.tsx`
  initially exited 1 with 7 failed / 1 passed tests because Timeline still
  rendered communication and email body text as raw text; the expected anchor
  roles were absent. The first sandboxed attempt could not create Vite's
  `.vite-temp` config file (`EPERM`), then the same command was run with the
  required worktree write permission.
- GREEN: the focused S2 file exited 0 with 8 passed tests.

## Final focused verification

- `npm test --workspace @housingchoice/dashboard -- src/ui/LinkifiedText.test.tsx src/routes/contact/Timeline.linkified.test.tsx src/routes/contact/Timeline.test.tsx src/routes/contact/Timeline.email.test.tsx src/routes/contact/Timeline.mms.test.tsx src/routes/contact/Timeline.delivery.test.tsx`
  exited 0: 6 files, 227 tests passed.
- `npm run typecheck --workspace @housingchoice/dashboard` exited 0.
- `npm run build --workspace @housingchoice/dashboard` exited 0; Vite transformed
  377 modules and emitted its pre-existing chunk-size advisory only.
- `git diff --check` exited 0.

## Coverage delivered

- Inbound and outbound SMS/MMS find explicit and bare-domain anchors with exact
  normalized destinations, safe attributes, and sentence punctuation excluded.
- MMS attachment rendering remains independent of the linkified body.
- Relay `Team` and native-group `Lars Landlord` sender labels remain beside the
  shared linkified body.
- A link click does not reveal per-recipient metadata, while a body click does.
- Collapsed and expanded Timeline email linkify plain text; a crossing URL keeps
  the complete href while the collapsed label is clipped. Whitespace-only and
  trailing-whitespace truncation still display the required ASCII suffix.

## Plan-fixture drift adjudication

The plan's literal crossing fixture used 126 contiguous `x` characters directly
before `example.com`. Live Autolinker behavior correctly recognizes that entire
run as one bare-domain match, so the stated URL start offset was not a parser
boundary. The S2 test uses 125 `x` characters plus one ASCII space, retaining the
required offset 126 while testing a standalone URL. The orchestrator approved this
delimiter-preserving correction; no broader design change is required.

## Downstream interface consequences

- S3: `UnmatchedRow` continues to import only `LinkifiedText` from the shared UI
  barrel. Its scope remains its opened full plain-text body; do not put anchors
  into the row-toggle preview.
- E1: the hermetic browser proof can assert Timeline anchors by accessible name,
  exact `href`, `_blank`, `noopener noreferrer`, punctuation exclusion, and no
  bubble metadata reveal. All direct, placement, tour, Relay, and native-group
  callers receive this integration through the unchanged shared Timeline.
