# Review R1 - adjudications and the fix-wave findings list

Date: 2026-09-27
Adjudicator: the build orchestrator (Fable 5.1), overnight unattended rule.
Inputs: `review-r1-spec-conformance.md` (C-1..C-9), `review-r1-adversarial.md`
(A-1..A-6, plan-blind), the S7 slice report's observations (O-1..O-3), gate
results on c45e7159 (typecheck 0, test 0 - app 376 / dashboard 205 / e2e 21 /
fake-twilio 34 / fake-twilio-web 13 files, smoke 0; e2e in progress at
adjudication time).

Both reviewers: NO BLOCKING. Conformance: CONFORMS, 2 SHOULD-FIX, 7 NOTE.
Adversarial: 3 SHOULD-FIX (each reproduced with a probe), 3 NOTE. Every
SHOULD-FIX is accepted. The orchestrator adds one defect (X-1) that A-3's
mechanism implies but neither reviewer named.

## Adjudications

| id | grade | disposition | rationale |
|---|---|---|---|
| C-1 / O-1 | SHOULD-FIX | FIX (F-1) | spec 4.8 intent ("the checkbox stays leading") is a selection affordance attached to its row; the probe-verified one-declaration fix (`flex: 1 1 0` on `.pastRow > .row`) is adopted, plus an e2e pin |
| C-2 (a) | SHOULD-FIX | FIX (F-3) | spec 5 lists "sequential (the second call does not start until the first resolves)"; no test issues a second PATCH |
| C-2 (b) | SHOULD-FIX | FIX (F-4) | spec 5 lists "keeps the rows and results"; the test seeds `reloadFailed` with no batch |
| C-3 | NOTE | FIX (F-5) | one `renderAt('')` case; trivial |
| C-4 | NOTE | FIX (F-6) | four cheap pins (tab order, exact Record-outcome label, indeterminate, the card's in-flight state); "directly above" and "Cancel discards" stay as asserted |
| C-5 | NOTE | RECORD | per-block roles were prescribed by the plan and are equivalent for AT; spec text reads either way |
| C-6 | NOTE | FIX (F-11) | this branch shifted the cited lines, so the stale citations are ours; refresh AFTER every other fix lands (last step of the wave); format-checked only, no behavior |
| C-7 | NOTE | superseded by A-1 | see F-7 |
| C-8 | NOTE | RECORD | repo-wide house style (57 specs); a fail-loud env read is its own change; named in the handback |
| C-9 / O-2 | NOTE | FIX (F-2), decision OD-7 | not a conformance issue; adopted as a product-eye call: a list whose chips do not line up reads as broken next to Active/Closed, and the reserved-slot layout the reviewer described is small (the self-QA screenshots it at desktop and 360px) |
| A-1 | SHOULD-FIX | FIX (F-7) | the page-owned guard (OD-3) holds across a TAB switch only; a route change to /tours/:id and back (the Record-outcome path this tab itself offers) yields a second runner on the same rows (probe: patchTour ['p1','p1']) and loses R1's results; the module-level store the reviewer proposes is the smallest fix that makes "one batch per browser tab" true, and it retires the page-owned refs |
| A-2 | NOTE | RECORD + FILE | the window is what spec 9 Q14 chose (client re-read, no server precondition, residual acknowledged in the runner comment); the conditional-PATCH design is filed as `tours-patch-status-precondition` (improvement, low) for a daytime decision |
| A-3 | SHOULD-FIX | FIX (F-8) | a one-line guard in `useContact.ts` that protects EVERY caller, red-first proven by the reviewer's probe; surgical fix to merged code that this feature is the most exposed caller of - the class Cameron delegates |
| X-1 (orchestrator) | SHOULD-FIX | FIX (F-9) | A-3's mechanism (ContactDetail re-renders, not remounts, on a contact-to-contact navigation) means the StaffNotesCard INSTANCE persists too: an editor open on tenant A stays open with A's draft under tenant B, and Save would PATCH B with A's text (`save()` reads the `contactId` prop at call time). Fix: key the card by `contact.contactId` at the TenantFile render site; pin with a test |
| A-4 | SHOULD-FIX | FIX (F-10) | the no-op compare must use the baseline captured at edit start, not the live prop; an untouched Save must never send; spec 9 Q12's last-write-wins is unchanged for an EDITED draft (no conflict warning is added - that would be optimistic concurrency, a spec non-goal) |
| A-5 | NOTE | RECORD | already filed (`tours-scheduled-range-query-unpaginated` names the newest-first cut) |
| A-6 | NOTE | RECORD | spec 9 Q1 (no cap; the 100 KB body limit is the practical ceiling); named in the handback with the reviewer's observation that a 413 renders the generic alert |
| O-3 (S7) | NOTE | RECORD | pre-existing RemindersPanel copy on a skipped day-before rung of a past-dated tour; not this branch's; named in the handback |

## Fix-wave findings list (complete; ONE wave)

Order matters: F-7 first (it restructures the batch state), then the rest, F-11 last.

- F-7 (A-1): move the batch's busy flag, in-flight guard and mounted-view reload
  slot from the ToursPage instance into a module-scoped store in
  `dashboard/src/routes/tours/ToursPage.tsx` (a boolean plus a listener set
  read through `useSyncExternalStore`; a `let mountedPastReload: (() => void) | null`
  slot the Past view registers in an effect and clears on unmount). The runner
  sets the store only inside `markToured`; the guard is the store boolean; the
  runner ends with the slot call. Remove the page-owned `useState` / `useRef`
  trio and the three props. Correct the comments at the head of the file, on
  `PastToursViewProps` and in the runner's closing note. Tests: the existing
  tab-round-trip test stays; ADD a route-change round trip (leave to
  `/tours/:tourId` mid-batch with the PATCH held, come back to `/tours/past`:
  every mark control disabled, a row click ignored - `patchTour` still once -
  and releasing the held PATCH reloads the MOUNTED view). Provide a clearly
  named test-only reset of the store if the suite needs independence between
  tests (check for a repo precedent first; otherwise every test must release
  its held promises).
- F-1 (C-1): `ToursPage.module.css` `.pastRow > .row` -> `flex: 1 1 0` (keep
  `min-width: 0`); fix the comment above the 560px query. E2E pin in
  `tours-past.spec.ts`'s pre-batch 360px block: the Not-marked row's checkbox
  box lies within its card's vertical span (top >= card top, bottom <= card
  bottom).
- F-2 (C-9, OD-7): every Past row renders a leading slot the checkbox's width
  (the checkbox, or an inert spacer) and a trailing action slot of one fixed
  width (`flex: 0 0 8.5rem`, `justify-content: flex-end`, always rendered,
  content conditional), so cards align on both edges across rows on desktop.
  At <= 560px the action slot keeps wrapping under the link at 100% width, and
  an EMPTY action slot renders nothing (`:empty { display: none }`) so a row
  without an action gains no blank line. Existing unit tests must keep passing
  unchanged (no role is added by an empty span).
- F-3 (C-2a): in the bulk test, the second id re-reads as scheduled at the SAME
  time; hold PATCH 1, assert exactly one `patchTour` call; release; assert the
  call order `['p1', 'p4']` and both rows read "Marked toured".
- F-4 (C-2b): a test whose `reloadPast` mock swaps the rows to the same rows
  with `reloadFailed: true` AFTER a batch: the per-row result line survives,
  exactly one refresh alert exists, and it precedes the toolbar in document
  order.
- F-5 (C-3): `TourDetail.test.tsx`: `renderAt('')` with no state -> the back
  link href is `/tours`; and `{ back: '/tours/closed' }` -> `/tours/closed`.
- F-6 (C-4): pins for the tab ORDER (Active, Past, Closed), the exact
  Record-outcome accessible name (`Record outcome: <who>` with the date-time),
  the select-all INDETERMINATE state after ticking one of two rows, and the
  card's in-flight state (hold `updateContact`: Save and Cancel disabled,
  textarea read-only; release).
- F-8 (A-3): `dashboard/src/routes/contact/useContact.ts` - `setContact`
  commits only when `prev.forId === contactId`
  (`setState((prev) => (prev.forId === contactId ? { status: 'ready', contact, forId: contactId } : prev))`).
  Regression test (in the hook's own test file if one exists, else beside
  ContactDetail's): a stale `setContact` for A after B has loaded leaves B on
  screen; the test must FAIL with the guard reverted (prove it once, quote it).
- F-9 (X-1): `TenantFile.tsx` renders `<StaffNotesCard key={contact.contactId} .../>`.
  Test in `TenantFile.test.tsx`: open the editor on A and type, rerender with B
  -> no textarea is open and B's value shows (the editor state did not carry
  over).
- F-10 (A-4): `StaffNotesCard` captures `baseline` in `startEdit` and compares
  `draft.trim() === baseline.trim()`; the request still sends the raw draft.
  Regression test: value "X", Edit, rerender with value "Y", Save untouched ->
  no request and read mode; and the reverse (edited draft still saves).
- F-11 (C-6): refresh every Tours citation in `e2e/performance/routes.ts`
  (`useTours.ts`, `ToursPage.tsx`, `TourDetail.tsx` ranges) to the lines they
  mean AFTER all of the above; `npx vitest run performance/routes.test.ts`
  green.

Not in the wave (recorded): C-5, C-8, A-2 (issue to file), A-5, A-6, O-3.

## Decisions taken alone in this round

- OD-7: adopt the reserved-slot row layout (C-9) as a product-eye call.
- OD-3 is superseded: the batch state becomes MODULE-owned (F-7), which is a
  strictly stronger version of the same intent (one batch per browser tab).
- A-3's fix touches a merged file outside the spec's list (`useContact.ts`):
  a surgical, red-first-proven guard that protects every caller; taken under
  the delegation for such fixes.
