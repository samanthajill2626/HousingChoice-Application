# Adversarial review - Staff notes stale-save guard (commit ec45bc83)

- Branch: feat/staff-notes-past-tours, worktree W:\tmp\staff-notes-past-tours
- Change under review: ec45bc83 (parent 7c166b06), spec amendment 3.9
  (docs/superpowers/specs/2026-09-26-staff-notes-past-tours-design.md:328-369)
- Reviewer: adversarial, read-only. No test suite, e2e lane or server was run
  (a gate run is live on this worktree). Every "fails"/"passes" claim below is
  from reading source, including the installed vitest / React / Playwright
  sources under W:\tmp\staff-notes-past-tours\node_modules, and is marked as
  such.

## Findings

### 1. [BLOCKING] useContact.test.tsx still asserts the pre-guard PATCH body; gate 2 (`npm test`) is red at ec45bc83

- `dashboard/src/routes/contact/useContact.test.tsx:71`:
  `await waitFor(() => expect(updateContact).toHaveBeenCalledWith('A', { staff_notes: 'note A - updated' }));`
- The test renders the REAL StaffNotesCard (`useContact.test.tsx:23`, `:38-43`)
  for contact A, which has no `staff_notes_updated_at`
  (`useContact.test.tsx:26`). The card now always sends the guard key:
  `StaffNotesCard.tsx:110-113` -> `updateContact('A', { staff_notes: 'note A - updated', staff_notes_expected_updated_at: null })`
  (baselineStamp is `updatedAt ?? null` = null, `StaffNotesCard.tsx:71`, `:88`).
- vitest 3.2.6 `toHaveBeenCalledWith` -> `equalsArgumentArray` ->
  `equals(actual, expected)` with `hasDefinedKey`
  (`node_modules/@vitest/expect/dist/index.js:1340-1341`, `:154-156`,
  `:291-297`, `:338-340`). `hasDefinedKey` only drops `undefined`; a key whose
  value is `null` counts. Actual has 2 defined keys, expected 1 ->
  `keys(b, hasKey).length !== size` -> not equal. No call matches, `waitFor`
  times out, the first test in the file fails.
- The file is in the dashboard vitest include set
  (`dashboard/vite.config.ts:121` `src/**/*.test.{ts,tsx}`), which root
  `npm test` runs (`package.json:39`). The commit message's green claim covers
  "dashboard 118 across 3" files; this fourth file that drives the card was not
  in that set.
- Input -> wrong output: `npm test` at ec45bc83 -> dashboard workspace ->
  `useContact - setContact is bound to its contact > a STALE setContact ...`
  fails on line 71. (By reading; not executed.)
- Fix shape: add `staff_notes_expected_updated_at: null` to the expected body
  (or `expect.objectContaining`). The second test in that file asserts no
  call args and is unaffected.
- Status at the end of this review: `git status` shows an UNCOMMITTED edit to
  `useContact.test.tsx` in the worktree (not made by this reviewer) that adds
  exactly `staff_notes_expected_updated_at: null` to the expectation. The
  finding stands against ec45bc83 until that edit is committed, and any gate
  result must say which tree it ran on.

### 2. [MEDIUM] The two-page e2e never waits for the colleague's save to land; its "it lands" assertion is vacuous, so the stale ordering it depends on is not established

- `e2e/tests/dashboard-next/tenant-staff-notes.spec.ts:131-132`: theirs clicks
  Save, then `await expect(theirs.getByText('E2E theirs - saved first')).toBeVisible();`
  is the only barrier before mine clicks Save (`:135`).
- That locator already matches while theirs is STILL EDITING: React 19 mirrors
  a controlled textarea's value into `defaultValue`, i.e. its text content
  (`node_modules/react-dom/cjs/react-dom-client.development.js:1842-1850`,
  react-dom 19.2.7; the card itself documents this at
  `StaffNotesCard.tsx:160-164`), and Playwright's text engine counts a
  textarea's child text nodes (`node_modules/playwright-core/lib/coreBundle.js`,
  `elementText` / `shouldSkipForTextMatching` skip only SCRIPT, NOSCRIPT, STYLE
  and head). So the assertion passes on its first poll, whether or not theirs'
  PATCH has committed.
- Consequence: the two PATCHes are ordered only by wall-clock head start (the
  CDP round trips and actionability checks of mine's click, tens of ms) against
  each request's server-side chain (session, `getById`, `getSuggestion`,
  `update` - `contacts.ts:1455`, `:1583-1593`, `:1605`). Under DynamoDB Local
  load, if mine's `UpdateItem` commits first, mine lands (expected stamp still
  current), theirs is the one refused, and the test fails at `:136-138` (no
  alert on mine). Low probability, but AGENTS.md treats any named-spec failure
  as a regression with no re-run list, so a timing-dependent spec is a defect.
- The same vacuity exists at `:150` (mine's second Save) but there `:151`
  (`getByRole('alert')` count 0 - the panel persists until success,
  `StaffNotesCard.tsx:116`) is a real barrier, so only `:132` matters.
- Fix shape: after theirs' Save, wait for read mode on theirs, e.g.
  `expect(theirs.getByLabel('Staff notes', { exact: true })).toHaveCount(0)`
  or `theirs.getByText(/Last edited/)` visible (test 1 does this at `:64-65`).
- The stale condition itself is genuine when ordering holds: mine's editor
  captures its stamp at edit start (`StaffNotesCard.tsx:88`) before theirs'
  save, and nothing refreshes staff notes on an open page (`useContact.ts:60-71`
  refetches only on `suggestion.updated`, which a staff_notes PATCH does not
  emit - it has no suggestion for `staff_notes`, so `suggestionStateChanged` stays false, `contacts.ts:1583-1593`, `:1747-1749`).
- Secondary: cleanup is inline (`:157-161`), not in a `finally`/afterEach; a
  mid-test failure leaves 'E2E theirs - saved first' on contact-tenant-0001.
  Same pattern as the pre-existing test 1 (`:94-102`); noted, not scored.

### 3. [LOW] The conflict copy misattributes in reachable same-user cases, and "while you were editing" is wrong for the main case the guard exists for (spec-level copy)

- Copy: `StaffNotesCard.tsx:167-170` (verbatim from spec 3.9).
- Same-user paths that produce it, each with the user's OWN text shown as
  "Their version":
  - two tabs of one user (the e2e itself uses one session for both pages,
    `tenant-staff-notes.spec.ts:113`);
  - a save that COMMITTED but whose 200 was lost (proxy/timeout): the card
    shows SAVE_FAILED (`StaffNotesCard.tsx:119-120`) with `baselineStamp`
    unchanged, the retry sends the old stamp and is refused;
  - GET /api/contacts/:id is an eventually-consistent read
    (`contacts.ts:1135` -> `getById` without `consistentRead`,
    `contactsRepo.ts:816-822`): a reload or a `suggestion.updated` refetch just
    after one's own save can hand the card the pre-save stamp.
  All are safe (the guard refuses, nothing is lost); only the words are wrong.
- "while you were editing": the issue this amends
  (`staff-notes-stale-page-overwrite`) is a page loaded BEFORE a colleague's
  save with the editor opened AFTER it. In that case the colleague did not save
  while the user was editing.
- Suggested: "These notes were changed since this page loaded." Needs
  Cameron's call since the spec fixes the text.

### 4. [LOW] Conflict panel accessibility: no focus placement, no association with the box, and the "cleared" line is styled as note content

- The panel is `role="alert"` (`StaffNotesCard.tsx:166`), so it is announced
  once on mount (lead + the whole colleague note, assertively). Nothing moves
  focus to it or back to the textarea after the 409; focus was on the Save
  button, which is `disabled` while saving (`StaffNotesCard.tsx:198`). Whether
  Chromium then drops focus to body is UNVERIFIED; either way a keyboard/SR user
  who missed the announcement and tabs into the box hears only
  "Staff notes, edit text, <draft>" - the panel is not linked to the textarea
  (no `aria-describedby`, `StaffNotesCard.tsx:182-190`).
- A second 409 whose colleague text is identical changes nothing in the live
  region, so it is not re-announced (minor).
- "They cleared the notes." renders in the same `conflictText` style as a real
  note body (`StaffNotesCard.tsx:171-175`, `StaffNotesCard.module.css:86-92`),
  so visually it reads as a note that says those words. Italic/muted or placing
  it in the lead sentence would disambiguate.
- Same shape as the pre-existing SAVE_FAILED alert, which is why this is LOW.

### 5. [LOW] Repo contract hole: `update` with `expect` and an empty patch skips the guard and returns success; the harness fake does the opposite

- `contactsRepo.ts:1341-1349`: when `sets` and `removes` are both empty, the
  method returns the current item without evaluating `opts.expect`. The new
  doc (`contactsRepo.ts:616-627`) says the write lands only while the attribute
  matches and "A mismatch throws ConditionalCheckFailedException" - not true
  for `update(id, {}, { expect: { attr, value: 'stale' } })`, which resolves.
- The harness fake evaluates the guard FIRST, before any field handling
  (`twilioWebhookHarness.ts:2057-2063`), so it throws for the same call, and it
  also reports a stale guard ahead of `EmptyIndexKeyError` /
  `RequiredIndexKeyRemovalError` whereas the real repo throws those before any
  network call (`contactsRepo.ts:1311`, `:1320`). Fake/real divergence on the exact
  seam the fake claims to mirror.
- Unreachable from the PATCH route today: a staff_notes write always SETs the
  stamp (`contacts.ts:1544-1546`), so the patch is never empty. Latent for the
  next caller of the now-generic option.

### 6. [LOW] `staff_notes_expected_updated_at: ''` is accepted as a valid expectation that can never match

- `contacts.ts:595-601` accepts any string, including ''. The route stamps only
  `new Date().toISOString()` (`contacts.ts:1545`), so `#expectAttr = :expectValue`
  with '' never matches: every such save is refused 409 (the caller can
  recover from the returned contact). If the DynamoDB service rejects an empty
  string in `ExpressionAttributeValues` the result is instead a
  ValidationException -> 500 - UNVERIFIED either way (not exercised by
  `contactsRepo.integration.test.ts:457-509`).
- The card never sends '' (`StaffNotesCard.tsx:71`, `:88`, `:127` only produce
  a string stamp or null). A raw-API caller writing `updatedAt ?? ''` would hit
  it. 400 on '' (or treating '' as null) would make the contract explicit.

### 7. [LOW] Two card tests overclaim; the untested branch would strand the user

- `StaffNotesCard.test.tsx` "a 409 that is NOT staff_notes_stale (or carries no
  contact) is the plain failure alert" exercises only the code-mismatch branch
  (`ApiError(409, 'something_else', ...)`); the `staff_notes_stale`-without-a-
  contact branch of `staleContact` (`StaffNotesCard.tsx:44-47`) is never run.
  If it ever happened, the card shows SAVE_FAILED, keeps the stale
  `baselineStamp`, every retry is refused again, and Cancel + Edit re-reads the
  same stale prop (`StaffNotesCard.tsx:88`) - stuck until a page reload. The
  server always includes the contact on 409 (`contacts.ts:1617-1620`), so this
  is unreachable today.
- "after a 409, Cancel keeps THEIR note" passes a no-op `onContactUpdated`
  and `value="Mine"`, and never asserts what read mode shows; it pins "no
  request, panel gone", not "keeps theirs" (that is the parent's job, proven
  only by the e2e).

## Checked and found sound

- Condition composition (`contactsRepo.ts:1358-1377`):
  `attribute_exists(contactId) AND attribute_not_exists(#expectAttr)` or
  `... AND #expectAttr = :expectValue`. New aliases `#expectAttr` /
  `:expectValue` cannot collide with `#k<i>` / `:v<i>` (numbered) or
  `#classificationRevision` / `:classificationRevisionZero|One`
  (`contactsRepo.ts:1322-1339`, classification aliases at `:1334-1338`). Two placeholders for the same attribute name
  (`#k<n>` SET target and `#expectAttr` in the condition) is exercised against
  DynamoDB Local by the new integration test (`contactsRepo.integration.test.ts:463-467`,
  `:491-496`).
- REMOVE-only + null guard: the null branch adds no value placeholder, so an
  empty `values` map is still omitted (`contactsRepo.ts:1375-1377`); a string
  guard always contributes `:expectValue`. Correct by construction; the route
  never produces a REMOVE-only guarded write (stamp is always SET).
- The condition is evaluated against the pre-update item in the same
  UpdateItem, so there is no read-then-write window; DynamoDB serializes
  conditional writes per item. Two saves with the same expected stamp: exactly
  one lands, the other is refused. A save racing a clear is the same case (a
  clear is a save of '' that re-stamps, `contacts.ts:1544-1546`; route test
  "a cleared box keeps its stamp").
- Stamp vs compared value: the stamp is an ISO string produced server-side,
  stored as S, returned verbatim by GET (`contacts.ts:1150-1152`) and PATCH
  (`contacts.ts:1913`), and echoed verbatim by the card; `JSON.stringify` keeps
  `null` (`client.ts` body serialization), so null reaches the parser and maps
  to `attribute_not_exists`. Equality on a millisecond wall-clock token could
  only be defeated by two writes producing an identical stamp where the second
  was issued by a client that had already read the first - not a human-scale
  interleaving.
- null vs absent: absent key -> no guard, last-write-wins unchanged
  (`contacts.ts:1598-1601`, route test "without the expectation"); null ->
  never-saved box; the parser rejects non-string/non-null with 400
  (`contacts.ts:597-599`); the key alone is not a changed field and does not
  satisfy "no updatable fields" (`contacts.ts:741-743`).
- Gone vs stale: the re-read is consistent (`contacts.ts:1616`); a present
  contact can only fail the condition via the guard clause, and the re-read
  then necessarily shows a different stamp. Absent -> 404 as before. A
  soft-deleted contact is present for both the write
  (`attribute_exists(contactId)`) and `getById` (no `deleted_at` filter,
  `contactsRepo.ts:816-822`), so it is consistently "stale" or "written", never
  confused with "gone" - identical to the unguarded path's treatment.
- Refused write has no side effects: every step before `contacts.update` in the
  PATCH handler is a read (`contacts.ts:1455`, `:1551-1554`, `:1569-1593`); the
  409 returns before suggestion deletes, verdicts, voucher sync, conversation
  fan-out, audit (`contacts.ts:1864`) and vocabulary (`contacts.ts:1629-1913`). Route test asserts
  no `contact_updated` audit.
- 409 body vs card: `{ error: 'staff_notes_stale', contact: current }`
  (`contacts.ts:1619`); `errorFrom` maps `error` to `ApiError.code` and keeps
  the parsed body (`dashboard/src/api/client.ts` errorFrom / ApiError ctor);
  `staleContact` reads exactly those (`StaffNotesCard.tsx:42-48`). The contact
  shape matches the 200 path (both raw items without GET's derived
  `phones`/`emails`), as spec 3.9 requires.
- Other callers of `contactsRepo.update` (`public.ts:306`, `twilio.ts:1164`,
  `:1205`, `voice.ts:626`, `extraction/apply.ts:459`, `:704`,
  `statusTransition.ts:342`, `:597`) pass two args; the third is optional, so
  behavior and types are unchanged. No production wrapper/proxy of
  ContactsRepo exists (the contacts router takes the repo directly,
  `contacts.ts:953`). Test fakes that implement `update` with fewer params
  (`audienceResolution.test.ts:90`, `contactCapture.test.ts:113`, vi.fn fakes)
  are not wired to the PATCH route; `aiRunVerdicts.test.ts` wrappers drop the
  third arg but only for unguarded type PATCHes.
- Single writer: `staff_notes` / `staff_notes_updated_at` are written only by
  the PATCH route (`git grep` over app/src, scripts, e2e); the parser is an
  allowlist, so a client-sent `staff_notes_updated_at` is ignored; the edit
  dialog builds a diff patch without staff notes (`ContactEditForm.tsx:233-347`);
  `parseTriageBody` has one caller (`contacts.ts:1444`).
- Card state across the 409: the card is keyed by `contactId`
  (`TenantFile.tsx:263-268`), so the parent's `setContact(theirs)` re-renders
  without remounting; `draft` is untouched, `baseline` / `baselineStamp` /
  `conflict` are internal state set from the 409 body
  (`StaffNotesCard.tsx:124-128`) and are not overwritten by later prop moves (a
  late or eventually-consistent refetch cannot regress them). Second Save sends
  their stamp; a second 409 re-bases again; Cancel clears the panel and the
  parent already holds theirs; a draft equal (trimmed) to theirs is a no-op
  close, which is correct because theirs is stored. Without a parent handler
  the card is read-only, so the 409 path is unreachable there.
- Real DynamoDB condition is exercised: the new case sits inside
  `describe.skipIf(!reachable)` (`contactsRepo.integration.test.ts:54`), and
  `npm test` now fails rather than skips without DynamoDB Local (AGENTS.md).
  It covers null-on-absent lands, null-on-present refused, stale refused with
  the item unchanged, current lands, unknown contact refused.
- Route tests pin the contract through the fake; atomicity is not provable
  through the fake (a read-then-compare route would also pass them), but the
  route demonstrably hands the guard to the repo (`contacts.ts:1605-1609`) and
  the repo condition is proven against DynamoDB Local.
- e2e end state on success: `staff_notes: ''` plus a stamp, identical to test 1's
  pre-existing end state (spec 3.1 keeps the stamp); the file reseeds in
  `beforeAll` and runs serially (`playwright.config.ts:140-141`).
- Existing dashboard tests that assert `updateContact` args for OTHER patches
  (`ContactEditForm.test.tsx`, `ContactDetail.test.tsx:517`) are unaffected;
  `StaffNotesCard.test.tsx` expectations were all updated for the new key.
- CSS tokens used by the panel exist (`dashboard/src/ui/tokens.css`); added
  lines are ASCII-only.
