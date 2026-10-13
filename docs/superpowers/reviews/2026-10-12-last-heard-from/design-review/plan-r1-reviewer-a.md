# Plan review round 1 - reviewer A (adversarial)

- Plan: `docs/superpowers/plans/2026-10-12-last-heard-from.md` (PLAN v1, commit 0779fbe0)
- Spec: `docs/superpowers/specs/2026-10-12-last-heard-from-follow-up-status-design.md` (rev 6, section 14 wins)
- Tree read: `W:\tmp\last-heard-from` at 0779fbe0 (source identical to cad93026). Nothing was run.
- Question asked: if a builder with no context executes the plan literally, do they produce the spec?

Short answer: almost. Coverage of the spec's decisions is close to complete
and most citations hold up against the tree. Three cross-writer
contradictions remain where a literal build fails. Each one is caught only
late: at typecheck, or in the S8 e2e run after S5-S7 are committed. The
other findings are edge cases the plan never names, plus two small
deviations from the spec.

Severity reflects what happens if the finding ships unfixed.

---

## 1. HIGH - The property card's Interested in 'form' mode opens the form from local state, but the markup contract and e2e (4) need the URL

What is wrong. There are two incompatible definitions of what clicking
Interested does on a property with no `tour_type`:

- Plan 3.4 ruling 10, R4 (which "wins" over slice text): "`interestedMode:
  'form'` on the property page navigates to `?tour=new&tenantId=<id>`, opens
  the `Schedule a tour` dialog with the tenant LOCKED ..., creates nothing,
  and Cancel clears both params". N2 R4 says the same.
- Task 5.3 GREEN wires the row as
  `onOpenTourForm={() => setTourForm({ tenantId: row.contactId })}`. That is
  local React state. The URL is never written. The 5.3 unit test for this
  case ("Interested in 'form' mode opens Schedule a tour with the row's
  tenant LOCKED ...") checks only the dialog and the locked tenant group, so
  it passes on the local-state code.
- Task 8.4 test 4 then asserts, after the same click,
  `toHaveURL(/[?&]tour=new(&|$)/)` and `toHaveURL(... tenantId=<id> ...)`,
  and after Cancel `not.toHaveURL(/[?&]tour=new/)`.

Evidence. Plan 5.3 (the Sent to row block and `openTourForm`) versus plan
3.4 item 10 R4 and plan 8.4 step 3, test 4. The FollowUpView (7.3) does
navigate to the URL, so the two hosts also disagree with each other.

Implication. A literal build of S5 passes every S5 unit test and then fails
e2e (4) in S8. S8 is the slice that must not edit dashboard source while the
lane runs (plan S8 preamble), so the fix lands as a late source change and a
re-run. Pick one behavior and make both the 5.3 code and its unit test say
it. The URL form is what R4, the FollowUpView and spec 5.4's
`?tour=new&tenantId=` entry already use.

## 2. HIGH - The R1 list markup is required by 3.4 but delivered by no task: S5 renders every SendRosterRow as a div with no ul

What is wrong. Plan 3.4 item 10 R1 says: "every `SendRosterRow` root is an
`<li>` inside a `<ul>` (one per group is fine) and nothing else in the card
is a listitem." S8 depends on it everywhere: 8.4's
`rowFor = card.getByRole('listitem').filter(...)`, the `listing-activity`
rewrite, and the selectors.md row it adds. But:

- Task 5.1 GREEN returns `<div className={styles.sendRow}>` as the root.
- Tasks 5.1, 5.3 and 5.4 map rows straight into the Card body with no
  `<ul>` (ListingDetail, TenantFile and PartnerFile all keep the bare `.map`).
- No S5 unit test asserts a listitem. Task 5.1 keeps a rewrite that resolves
  the row with `closest('div')`, at `ListingDetail.test.tsx:553-554`.

Evidence. Today the root is a `div` at `dashboard/src/routes/contact/Card.tsx:233`.
None of the three hosts wraps it in a list: `ListingDetail.tsx:1140-1153`,
`TenantFile.tsx:311-318`, `PartnerFile.tsx:173-179`. Plan 8.4 step 1 even
predicts the failure ("if S5's row markup nests divs, `:226` `rowFor(t1Name)`
fails first on strict mode").

Implication. The rule that "3.4 wins" leaves the builder to invent markup
and tests that no task specifies. A literal builder produces divs, and every
S8 roster-card locator finds zero rows. Add the ul/li to the 5.1 component
or to the three hosts, plus one unit assertion per card (for example
`within(card).getAllByRole('listitem')` count equals the row count).

## 3. HIGH - `setListingSendOutcome` has two return shapes: S3.8 and S5 unwrap the row, while 3.4 and S7 destructure `{ row }`

What is wrong. The writers contradict each other on a shared signature:

- Plan 3.4 item 4 (the ruling): `setListingSendOutcome(unitId, contactId,
  outcome): Promise<{ row: ListingSendRow }>`. W3 note 1 says the same.
- Task 3.8 GREEN implements `Promise<ListingSendRow>` (it `return res.row`),
  and its test asserts `expect(row).toEqual({ contactId: 'c 1', ... })`, the
  unwrapped row.
- Tasks 5.3 and 5.4 consume it unwrapped:
  `const next = await setListingSendOutcome(...); setRecipientRow(..., next)`.
  Their tests mock `mockResolvedValue(returned)` with a bare row.
- Task 7.3 consumes it wrapped: `const { row } = await setListingSendOutcome(...)`.
  The FollowUpView tests mock `mockResolvedValue({ row: {} })` and
  `{ row: { tour: ... } }`.

Implication. Whichever shape the builder chooses, the other side breaks at
`npm run typecheck`, and one side's tests have to be rewritten. If the
builder follows 3.4 (it "wins"), Task 3.8's test and both S5 hosts are wrong
as written. If the builder follows 3.8, 7.3 does not compile. Fix the plan
to one shape before the build.

## 4. MEDIUM - A non-member calling a CLOSED relay group writes a call row that the rule cannot attribute; the plan never names this case

What is wrong. Spec G1 counts "an inbound call (any outcome, including a
refused masked call)". Spec 5.1 table row 6 lists "Masked relay call,
refused (closed thread, non-member, or any other refusal reason)" and says
it touches "a non-member's `relayExternalCallerContactId`, or `findByPhone`".
14.2 narrows G1 to "any outcome that produced a call row". In the tree,
`reason` is computed with `isClosed` first
(`app/src/routes/webhooks/voice.ts:1006-1013`). So a non-member who calls a
closed group gets `reason = 'closed_thread'`. The external-caller fields are
filled only when `reason === 'non_member'` (`voice.ts:1019-1033`,
`:1051-1055`). The persisted row therefore has no `relay_sender_key` and no
external-caller fields. Under rule step 2 (plan 3.1) a keyless group row
with no external fields is unattributed, so neither the live touch (Task
1.8) nor the backfill moves that caller's value.

Evidence. Task 1.8's `closed_thread` case (test 1) uses a MEMBER (Alice on
the roster). No case covers a non-member on a closed thread, and the plan
never mentions it.

Implication. A contact who rings a closed group they were never part of
reads "Never" or a stale value, even though a call row exists. That
contradicts G1 as worded. Either rule it out in the spec (14.2 already
narrows G1 for founder-path refusals) or persist the external-caller fields
for `closed_thread` too. Either way, add a test that pins the chosen
behavior so it is not discovered later.

## 5. LOW - Two person-made tour writes do not count as "tour activity" under D11, and the plan does not list them

What is wrong. `deriveTourActivityAt` (Task 3.2) reads
`max(createdAt, lastMarkedAt)`. Two person-made tour mutations do not stamp
`lastMarkedAt`:

- The placement conversion. `POST /placements/from-tour` patches the tour to
  `status: 'closed', convertedPlacementId` with no `lastMarkedAt`
  (`app/src/routes/placements.ts:775-779`).
- The outcome-only exit gate on a toured tour. `routes/tours.ts:1333-1338`
  stamps only on a status change or a new `scheduledAt`.

So a decline recorded after the tenant was marked Toured but before staff
convert the tour stays effective after the conversion. A converted tour is
in the qualifying set (`listingSendTour.ts`, Task 3.2's converted case).
D11's text ("created, rescheduled or reopened") does not include
conversion, so the behavior matches the spec. The plan's doc comment on
`deriveTourActivityAt` lists the stamping surfaces and leaves this one out.

Implication. A rare "Not interested" row on a tenant whose placement just
opened. Name the case in the plan (or the spec) as accepted so a reviewer
does not file it as a regression later.

## 6. LOW - Suppressing the `listing_decline_cleared` event on a no-op clear contradicts approved spec 5.4 without a spec amendment

What is wrong. Spec 5.4: "`clear`: `clearDeclined`, then the audit writes.
Idempotent." Plan 3.4 ruling 2 makes the write conditional on a stored
decline, and Task 3.7 pins that with "clear with no stored decline answers
200 and records NOTHING". The ruling is reasonable: it is the same honesty
rule as `listing_interested`. But it changes behavior the spec fixed, and
the spec has no section 14 entry for it.

Implication. The handback's per-section deviation table must carry it, or
the spec should be amended. Otherwise the final reviewer will read it as
spec drift.

## 7. LOW - An email with `email_new_address: true` is never attributed, even after staff link the address

What is wrong. Spec 5.1 says such a row "is not attributed until staff link
the address". The rule keys on the stored row flag (plan 3.1 rule 3; spec
14.2). Two facts make "until" unreachable:

- The live touch runs only with the winner's side effects
  (`inboundEmail.ts:735-742`).
- The backfill (Task 2.1) evaluates the same flag on the stored row, which
  never changes.

The link and re-ingest flow (`routes/unmatchedEmail.ts:27-31`, `:334-341`)
covers unmatched side-door mail, not a tier-5 row that was already threaded.

Implication. Linking the address afterwards never moves the value; only the
contact's next email does. This is a spec-wording issue, and the plan
follows the rule correctly. Worth one sentence in the plan (or the spec) so
nobody expects the backfill to repair it.

## 8. LOW - The dev seam `POST /__dev/listing-send-fixture` overwrites the row's whole `shares` map and can move `sentAt` backward

What is wrong. Task 7.2 writes `shares: { individual: ... }`,
`counted: true` and `sentAt` through `putShareMemory`, which SETs `shares`
and `sentAt` outright (`listingSendsRepo.ts:276-285`). On a pair that
already has real shares, this erases the share history and can set `sentAt`
earlier than the latest counted share. That breaks the invariant D11 relies
on ("sentAt follows the latest counted share"). Task 7.2's second test
deliberately re-plants the same pair.

Implication. This is dev-only and harmless in the specs as written, which
use fresh pairs. State the precondition ("fresh pairs only") in the seam's
header and in the selectors.md row, or refuse a row that already has
counted shares.

## 9. LOW - FollowUpView defines its own outcome-error copy instead of the one module

What is wrong. Plan 3.4 item 4 puts `isOutcomeSaved` and `outcomeErrorCopy`
in `dashboard/src/lib/listingOutcomeErrors.ts` (Task 3.8). Task 7.3's
FollowUpView redefines `SAVE_FAILED`, `SAVED_RELOAD` and an `outcomeError`
function locally. The strings are identical today; the two copies can drift.

Implication. Import the module.

## 10. LOW - The ResolvedContact "not persisted" check is a grep in a commit body, not a test

What is wrong. Spec 5.3 asks the plan to "prove the two new fields are not
persisted onto the broadcast item". Task 6.1 records a grep in the commit
body and adds no test. I re-verified the claim. `ResolvedContact` is
consumed only in `routes/broadcasts.ts`. `markSending` stores
`{ status: 'queued' }` per key (`app/src/repos/broadcastsRepo.ts:767-784`).
The fan-out re-reads each contact (`app/src/jobs/broadcastFanOut.ts:1216`).
So the claim holds today, but nothing fails if a later change snapshots the
candidate.

Implication. Acceptable as a recorded proof. A one-line assertion in the
existing send-path test would make it a guard.

---

## Surfaces I enumerated and found covered (so later reviewers need not redo them)

- **`last_heard_from_at` writers.** Every runtime write to an existing
  contact is a targeted UpdateItem:
  - `contactsRepo.ts`: `update` at :1458, plus `persistPhones` and
    `persistEmails`.
  - `suggestionResolutionRepo.ts:870-879` and `:1036-1044`.
  - `import/apply.ts:1182`, which is SET-only.
  - `caseworkerConversion.ts:527-542`.

  The only Puts are create-only (`contactsRepo.ts:1360-1397`) or the dev
  seeds (`seed/index.ts:153`, which runs after the derivation; `live.ts:460`,
  which seeds no messages; `performanceSeed.ts`, excluded by D13). The
  import retract hard-deletes contacts at `apply.ts:770`. No runtime path
  erases the value, so Task 1.13 part B's audit conclusion holds.
- **The eight live inbound appends.** I listed every `messages.append` in
  `twilio.ts` (:913, :1288, :2026, :2470; :2953 is a relay retry, excluded)
  and `voice.ts` (:779, :1036, :1112). The services are outbound except
  `inboundEmail.ts:734`. The dev seams are at `dev.ts:851`, `:1058` and
  `:1115`. All of them are tasked.
- **`listing_sends` writers.** `putShareMemory` is the only runtime writer,
  and it is a targeted UpdateItem (`listingSendsRepo.ts:276-285`), so
  `declined` survives it. No runtime path deletes rows. Unit and contact
  soft-delete do not cascade (`units.ts:1705`; `contacts.ts:2253`). The
  import retract leaves `listing_sends` alone. Seeds use whole Puts, but the
  lean seed has no `listing_sends`, and cast and matrix rows carry no
  `declined`.
- **`toListingSendRow` callers.** Only `routes/units.ts` and
  `routes/contacts.ts` call it, and Task 3.6 updates both.
- **Typed dashboard `ListingSendRow` literals.** `files.test.tsx` is
  covered by Task 3.8. The rest are untyped `vi.fn` mocks.
- **The Tenants-tab default filter.** No e2e spec asserts the presence or
  order of an inactive or placed tenant. `environment-identity.spec.ts:232-234`
  expects a bare `/contacts/tenants`, which holds because the default writes
  no param. Both lean tenants (`placing`, `searching`) stay visible. The
  perf binder is fixed by Task 4.6.
- **Review-recipients accessible names.** No e2e spec selects a checkbox by
  its em-dash name. The only unit pin is `RecipientPreview.test.tsx:431`,
  which Task 6.5 rewrites.
