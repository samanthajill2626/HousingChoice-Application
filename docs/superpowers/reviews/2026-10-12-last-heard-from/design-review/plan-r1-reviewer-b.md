# Plan review round 1 - reviewer B (adversarial)

- Plan: `docs/superpowers/plans/2026-10-12-last-heard-from.md` (PLAN v1, commit 0779fbe0)
- Spec: `docs/superpowers/specs/2026-10-12-last-heard-from-follow-up-status-design.md` (rev 6, section 14 wins)
- Tree read: `W:\tmp\last-heard-from` at cad93026 (source byte-identical for every file cited below). Nothing was run.
- Question asked: if a builder with no context executes the plan literally, does the spec come out?

Short answer: the app half (S1-S3, S6.1-S6.2, S7.1-S7.2) is close to executable as written, and its
surface enumeration holds up against a whole-app grep (details under "Checked and clean"). The dashboard and
e2e halves are not: the reconciliation section 3.4 states markup and signature contracts that the
slice bodies written after it do not implement, and the S8 specs assert those contracts. A literal build goes
green through S7 and then goes deterministically red in S8. In four places the e2e asserts behavior that the
slice code it verifies contradicts.

Severity scale: BLOCKING = the build cannot proceed correctly; HIGH = a deterministic gate failure or wrong
behavior that a literal build produces; MEDIUM = likely failure or wrong behavior that a reviewer may not
catch; LOW = worth a sentence.

---

## F1 [HIGH] `setListingSendOutcome` has two incompatible return shapes, and the precedence rule picks the one the slice tests contradict

What is wrong. Section 3.4 ruling 4 (plan :325-329) fixes the dashboard endpoint as
`setListingSendOutcome(unitId, contactId, outcome): Promise<{ row: ListingSendRow }>`. The W3 notes repeat it
(:7527-7532). S7.3 consumes that shape: `const { row } = await setListingSendOutcome(...)` (:10044), and its
tests mock `mockResolvedValue({ row: {} })` (:9676) and `{ row: { tour: ... } }` (slice line ~180).

Task 3.8, which CREATES the function, implements the other shape: it unwraps `res.row` and returns
`Promise<ListingSendRow>` (:4753-4763). Its RED test pins that unwrapped value:
`const row = await setListingSendOutcome(...); expect(row).toEqual({ contactId: 'c 1', unitId: 'u1', outcome: 'not_interested' })`
(:4673-4681). S5 consumes it unwrapped too: `const next = await setListingSendOutcome(...); setRecipientRow(..., next)`
(:7094), `const row = await setListingSendOutcome(...); file.setListingSentRow(..., row)` (:7394). The S5
tests mock the bare row (:6922, :7276).

Implication. Section 3.4 says it WINS over slice text (:309-311). A builder who follows that rule cannot turn
3.8's own RED green, because the test expects the bare row. One who follows 3.8 as written breaks S7.3 at
typecheck: destructuring `row` from a `ListingSendRow` is an error. Either way, one writer's code and tests
must be rewritten. The plan never names which, so the builder has to guess. Pick one shape, and fix 3.4 #4,
the W3 note, 3.8 (code and test), S5 (two call sites and their mocks) and S7.3 (code and mocks) together.

## F2 [HIGH] MARKUP CONTRACT R1 (`<li>` rows in a `<ul>`) is not implemented by any S5 task, and S8 depends on it

What is wrong. Ruling 10 R1 (:359-363) and W4 N2 R1 (:4845) require that every `SendRosterRow` root is an
`<li>` inside a `<ul>`, and that nothing else in the card is a listitem. S5 never builds that:

- Task 5.1's new `SendRosterRow` root is `<div className={styles.sendRow}>` (:6430-6431), the same element
  type as today (`dashboard/src/routes/contact/Card.tsx:233`, `<div className={styles.li}>`);
- none of the three hosts wraps the rows in a `<ul>`: ListingDetail (:7101-7124), TenantFile (:7337-7358),
  PartnerFile ("the same shape", :7362-7372). Today's host renders a bare `.map` of rows too
  (`dashboard/src/routes/listing/ListingDetail.tsx:1140-1152`);
- no S5 unit test checks list semantics. ListingDetail.test's `rowOf` resolves `closest('div')` (:6684-6685), so
  it passes with or without an `<li>`. A grep of S5 (plan :6133-7520) for `<ul`, `<li` or `listitem` returns
  nothing.

S8 selects rows only through listitems: the knowing `listing-activity.spec.ts` rewrite
`card.getByRole('listitem').filter(...)` (:11217-11218) and the new spec's `rowFor` (:11263-11266) used by every
8.4 test.

Implication. A literal S5 build passes every S5 unit test. Then 8.4 and the listing-activity rewrite find zero
rows. 3.4 "wins" only in the abstract: no task carries the change, and no test fails until the slowest gate.
Add the `<li>`/`<ul>` markup to 5.1 and 5.3/5.4 explicitly, with a unit assertion
(`within(card).getAllByRole('listitem')` count = row count).

## F3 [HIGH] R4 says form-mode Interested on the property page NAVIGATES to `?tour=new&tenantId=`; Task 5.3 opens the form from local state, so 8.4 test 4 fails

What is wrong. Ruling 10 R4 (:367-369) and N2 R4 (:4848) require: "`interestedMode: 'form'` on the property page
navigates to `?tour=new&tenantId=<id>`, opens the `Schedule a tour` dialog ... and Cancel clears both params".
Task 5.3 wires the row as `onOpenTourForm={() => setTourForm({ tenantId: row.contactId })}` (:7120). That is
React state and the URL never changes. Task 5.3's unit test for this path asserts only the dialog and the locked
tenant, never the location (:6938-6946). S8.4 test 4 asserts the URL right after the click:
`toHaveURL(/[?&]tour=new(&|$)/)` and `toHaveURL(new RegExp(`[?&]tenantId=${t.contactId}(&|$)`))` (:11365-11368).

Implication. The e2e is deterministically red against the code the plan tells the builder to write. Choose
one behavior. The spec (5.4, the property host "gains a per-click `tenantId` from the clicked row") allows
either. Then align R4, 5.3 and 8.4 test 4, and add the URL assertion to the 5.3 unit test if navigation wins.

## F4 [HIGH] The Follow up tab keeps a resolved row on screen; S8.6 test 2 asserts it disappears and the empty state shows

What is wrong. S7.3 resolves row actions LOCALLY, by design. `useFollowUps`: "Row actions resolve rows LOCALLY
- no refetch: `resolve` marks a row interested / not interested so the counts drop at once" (:9873-9877).
`FollowUpView`: "Resolving a row keeps it on screen with its new chip and drops it from the counts" (:9968-9969).
A resolved row renders a `Not interested` chip and Undo (:10127-10139), and the empty state renders only when
`followUps.items.length === 0` (:10176-10182). That length counts served items, not unresolved ones.

S8.6 test 2 clicks Not interested on the only waiting row and then, with no reload, asserts
`groupFor(page, line1)` count 0 and `Nothing waiting on a reply.` visible (:11471-11476). Spec E2E (6) says
"Not interested removes it" (spec section 8).

Implication. Deterministic e2e failure. Either the e2e reloads (and then proves the server drops the row,
which is what the spec sentence means), or S7.3 removes resolved rows. That second option loses the in-session
Undo the S7.3 design and W3 note 7 (:7563-7566) rely on. Today the two halves are inconsistent and the plan
does not notice.

## F5 [HIGH] S8.3 asserts "Last heard from" never appears inside the candidate list, but S6.5 renders it in every row

What is wrong. S8.3 step 3 requires, for EACH header label including `Last heard from`, both
`page.getByText(label, { exact: true }).first()` visible AND `list.getByText(label, { exact: true })` count 0
(:11146-11149, the N2 P1 contract at :4849). S6.5 puts a
`<span className={styles.narrowOnly}>Last heard from </span>` inside every row's `.cellHeard` (:8596-8599).
CSS hides it at a 768px+ container (:8742-8744), but the span stays in the DOM. S6.5's own unit test counts it:
"The header plus each row's narrow-pane prefix. expect(screen.getAllByText('Last heard from')).toHaveLength(3)"
(:8185-8186). A Playwright locator count includes non-visible elements, and exact matching normalizes the
trailing space away.

Implication. Step 3 fails for `Last heard from` on every run. The P1 contract and the S6.5 markup contradict
each other. Either scope the e2e count check to the three labels that do not repeat, or render the narrow
prefix in a way the e2e excludes (for example, assert visibility instead of count).

## F6 [MEDIUM] S8.3's `getByText(/^Today .../)` probably cannot match the S6.5 cell (UNVERIFIED: Playwright text-engine internals)

What is wrong. In S6.5 the last-heard label is a bare text node inside `.cellHeard`, after the `narrowOnly`
span (:8596-8599). So the smallest element that contains it has the full text "Last heard from Today 2:14 PM".
S8.3 step 3 asserts `recentRow ... getByText(/^Today \d{1,2}:\d{2} [AP]M$/)` (:11151-11152). As far as I know,
Playwright's regex text matcher tests the element's full text. Unlike exact string matching, it does not test
individual immediate text nodes. If so, `^Today` matches nothing.

I could not verify this here: no node_modules, and I ran nothing. The same step's `getByText('Never', { exact: true })`
is probably fine through immediate-text matching.

Implication. Likely a red step at gate 4. Cheap to remove: wrap the label in its own `<span>` in S6.5, or
assert `toContainText` on the cell.

## F7 [MEDIUM] Gate 4 runs under a 1500 s hard timeout, while the plan's own C6 run allows 3000 s

What is wrong. Task 8.5 runs the full suite as `timeout 3000 npm run e2e` (:11511). Task 10.2 gate 4 runs
`timeout 1500 npm run e2e` (:11646). AGENTS.md records a 17.9 min full-suite baseline. This branch adds five
new specs, several marked `test.slow()`, plus a reseed per Follow up test. 25 minutes is thin. AGENTS.md also
warns that killing a suite orphans its stack, and that `reuseExistingServer` then adopts the orphan on a commit
match alone.

Implication. A false red gate, plus a contaminated lane for the re-run. Use one timeout, sized from the 8.5
measurement, and repeat the AGENTS.md "confirm no listener survives" step after any timeout.

## F8 [LOW] "Request a tour" is keyed on `!interestedSupported`, so every non-tenant row gets it, not only partner rows

What is wrong. Spec D7 and 5.4 define the link as the PARTNER-row substitute for Interested ("a caseworker's
yes is always a yes for a specific client"). `SendRosterRow` renders it whenever
`waiting && !row.interestedSupported && requestTourTo !== undefined` (:6460), and every host always passes
`requestTourTo` (:7119, :7353). The plan's own ListingDetail fixtures carry a LANDLORD recipient row with
`interestedSupported: false` (:6667-6670), so that row now shows "Request a tour for <landlord>". FollowUpRow
does the same for any non-tenant (:10102-10110).

Implication. The UI offers a meaningless tour request on landlord or unknown recipient rows. Gate the link on
`row.type === 'partner'`, or say in the plan that this is intended.

## F9 [LOW] The follow-up row duplicates the outcome error copy instead of using `lib/listingOutcomeErrors.ts`

What is wrong. Ruling 3.4 #4 makes `dashboard/src/lib/listingOutcomeErrors.ts` the home of `isOutcomeSaved`
and `outcomeErrorCopy` (:328-329; built in 3.8, :4766-4789). FollowUpView re-implements both, with its own
`SAVE_FAILED` / `SAVED_RELOAD` constants and `outcomeError()` (:9985-9995). In the same vein,
`services/followUps.ts` gets its own `nameOf` (:9186-9192) instead of the `displayNameOfContact` the units
projection uses. So the same person can be named differently on the card and on the Follow up row (for example
a phone-only contact).

Implication. Copy and naming drift. That is minor today, but G7 ("every derivation ... one home") is the
spec's stated intent.

## F10 [LOW] The I1 writer audit says "re-run at the final gate step", but S10 does not carry it

What is wrong. Task 1.13 Part B: "Run this audit again at the final gate step and update the file if new reads
appeared" (:1828-1830). S10 (:11628-11696) has no such step. Tasks 3.4, 6.1 and 7.1 all add new readers of
`last_heard_from_at` after S1.

Implication. The committed audit record goes stale. Add a line to 10.2 or 10.4.

## F11 [LOW] Spec 5.3's "prove the two new fields are not persisted" is delivered as a grep in a commit body, with no regression pin

What is wrong. Task 6.1 (:7702-7706): "No test - the grep is the proof; record it in the commit body". My own grep
confirms it today: `ResolvedContact` is consumed only by `app/src/routes/broadcasts.ts:67`, and
`audienceResolution` is imported nowhere else except `api.ts` wiring. Nothing stops a future
`buildRecipientsFrom` change from snapshotting the candidate.

Implication. Acceptable under the spec's wording ("the plan greps ... and proves"). A one-line broadcast-item
assertion in `broadcastApi.test.ts` after a send would make it durable.

---

## Checked and clean (so later reviewers need not redo it)

- I1 mutation surfaces. Every contacts-table writer: contactsRepo
  (`:1047, :1084, :1120, :1157, :1369, :1382, :1401-1445, :1566, :1818, :1897`), suggestionResolutionRepo
  (`:871, :1036`; its contacts-table Puts at `:1047`/`:1101` region write only `phoneref#` pointer rows),
  extractionRepo `:792` (ConditionCheck only), import apply (`:686, :771, :799`). None SETs or REMOVEs
  `last_heard_from_at`. `create`/`createIfAbsent` are conditional on `attribute_not_exists`. POST/PATCH gain the
  server-owned refusal (Task 1.13B). There is no contact-merge feature (`routes/contacts.ts` has none).
- Inbound append sites. Every `direction: 'inbound'` append in `webhooks/twilio.ts` (`:918, :1293, :2031,
  :2475`), `webhooks/voice.ts` (`:784, :1041, :1117`), `services/inboundEmail.ts` (`:716`) and `routes/dev.ts`
  maps to one of Tasks 1.3-1.11. The other matches are SSE emits and logs (`:1044, :1108, :1363, :2134, :2213,
  :2241, :2640, :2689, :3032, :3310`). The unmatched-email link and create-contact flows re-ingest through the
  same `thread()` pipeline (`routes/unmatchedEmail.ts:311-368`), so Task 1.10 covers them.
- Seeds. `seedLive` writes contacts after the Put loop, outside the derivation (`lib/seed/live.ts:454-460`), but
  it writes no messages, so its contacts correctly get no value. `/__dev/reseed` goes through
  `devReset -> seedAll` (`lib/devReset.ts:11`). GSIs project ALL (`lib/tables.ts:60`), so list reads return the
  new attribute.
- `declined` surfaces. `listing_sends` has exactly one table writer, `putShareMemory`
  (`listingSendsRepo.ts:277`, UpdateItem). The performance seed writes its own rows and is excluded by D13.
  `contactTimeline.ts:726, :1400` reads ledger fields only. `toListingSendRow`'s only callers are
  `units.ts:1122` and `contacts.ts:1248`, and both are rewritten. `getRecipientDisplaysByIds` has one caller
  (`units.ts:1110`), so widening the projection leaks into no other endpoint.
- `POST /api/tours` timeless create is a bare `toursRepo.create` with no other side effects
  (`routes/tours.ts:371-381, :420-422`), so the Interested route's direct create matches it.
  `requireTenantContact` reads with `consistentRead: true` (`services/contactTypeGuards.ts:66-76`).
- `GET /api/units` excludes soft-deleted units by default (`routes/units.ts:499-507`), so the contact page's
  "unit absent from file.units = deleted property" rule (Task 5.4) holds.
- The facet engine is consumed only by ContactsList (the other importers use `NONE_KEY` / `FacetOption` only).
  No in-app link targets `/contacts/tenants?status=`.
