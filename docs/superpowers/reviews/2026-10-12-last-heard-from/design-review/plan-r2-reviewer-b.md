# Plan review round 2 - reviewer B (adversarial)

- Plan: `docs/superpowers/plans/2026-10-12-last-heard-from.md` v2 @3cffb801. Delta reviewed:
  `git diff 0779fbe0 3cffb801 -- docs/superpowers/plans/`.
- Spec: rev 6 plus section 14.6 (@b258944b).
- Inputs: adjudications.md "Plan review / Round 1"; reviewer A round-1 report.
- Tree: `W:\tmp\last-heard-from` source at cad93026. Read only; nothing was run.

Short answer: the v2 changes do close the three cross-writer seams (`{ row }`, R1, R4) and the two
e2e/markup contradictions (the in-place rule, the `::before` prefix), and they do it consistently. I re-grepped
every `setListingSendOutcome` call site and mock in the plan (:4763, :7122, :7131, :7332, :7556, :7716,
:10112-10144, :10560); all of them use `{ row }`. Nothing I found blocks the build. What remains:

- one ruling (B8) is only half-applied;
- one fix (A4, voice path 6) changes code on a path the router cannot reach, while the reachable form of the same
  case is left unpinned;
- one fix (B9/A9 name reuse) is implemented by importing a route module into a service;
- some housekeeping gaps.

All are LOW or MEDIUM.

---

## F1 [MEDIUM] B8 is applied to the roster cards but not to the Follow up rows: a non-partner, non-tenant recipient there still gets "Request a tour"

What is wrong. Adjudication 14 rules that the link "renders only when the row's recipient type is `partner`".
v2 applies that in S5:

- `SendRosterRow` gets `requestTourTo` only from the host;
- ListingDetail passes it only when `row.type === 'partner'` (:7298-7300 region, "B8: only a PARTNER recipient");
- PartnerFile keys on `contact.type === 'partner'`;
- TenantFile passes none.

S7.3's `FollowUpRow` is unchanged. It renders the link whenever `!item.interestedSupported` (plan :10605-10625:
`item.interestedSupported ? <button ...Interested> : <Link ...Request a tour>`). `interestedSupported` is
`contact.type === 'tenant'` (builder, plan ~:9670). `isEligibleRecipient` keeps EVERY non-tenant with a phone
(plan 3.1), so a converted landlord or team-member recipient (a tenant-era row whose contact type changed later)
is listed with "Request a tour for <landlord> at <address>". Spec 7 explicitly anticipates type changes (a
tenant converted to a caseworker keeps tenant-era rows).

Evidence. `FollowUpItem.type` is already on the wire (plan 7.1 `type: contact.type`). No 7.3 test covers a
non-partner, non-tenant row: the only case is "a partner row offers Request a tour" (:10163).

Fix. In FollowUpRow, render the link only when `item.type === 'partner'`, plus one negative test. Optionally,
note in 5.6 or 14.6 whether such recipients belong on the list at all; the spec's eligibility rule keeps them,
which is fine.

## F2 [LOW] Voice path 6's `caller === undefined` change edits a state the router cannot produce, while the reachable case is left unpinned (contests adjudication 7)

What is wrong. Plan v2 itself records it (:1146-1151) and the tree confirms it. `resolveRelayInbound` returns
`closed_member` only for a roster member (`app/src/services/relayInboundResolution.ts:89-91`). It sends a
non-member to an OPEN group (`:93-94`) or returns `all_closed_non_member`. In that last case `voice.ts:596-617`
falls through to FOUNDER TRIAGE, not `handleMaskedInbound`. Both `handleMaskedInbound` and the resolver read the
same in-memory `resolution.group` (`voice.ts:612`), so its `status` cannot change in between. The resolver
handles `closed_member` and `non_member_open` before the masked handler. So in the refusal branch,
`caller === undefined` is equivalent to `reason === 'non_member'` (`voice.ts:1006-1013`) on every reachable
input. GREEN part 1 is a behavioral no-op today.

RED case 9 can reach the state only through a property-getter seam that flips `status` when `pool_number` is read
(:1191-1198). That seam pins the side-order of two property reads inside `handleMaskedInbound`
(`voice.ts:995` before `:999`), and it breaks on any harmless reorder of those lines.

Meanwhile A4's real concern, "a non-member who rings a closed group is never attributed", is FALSE for the
reachable flow. That caller lands in founder triage, path 5, and is touched there through the captured caller
(Task 1.7). No test pins it: every 1.7 case posts `bizVoiceParams()`, whose To is the business number, never a
pool number.

Implication. The change ships code no production input reaches, plus a fragile test of a synthetic state. The
behavior that actually matters (pool number, all groups closed, non-member caller: a founder-triage call row
plus a touch) has no test.

Suggested resolution. Keep or drop the defensive edit; it is harmless because the append validator
(`messagesRepo.ts:943-962`) accepts the shape. Either way, ADD a Task 1.7 case in which To = a pool number whose
only group is closed and From = a non-member. It should assert that the founder-triage call row is written and
that `heardFromTouches` names the captured caller. Then amend 14.6's first bullet to say the closed-thread
non-member case is unreachable and is attributed by path 5.

## F3 [LOW] Reusing `displayNameOfContact` makes a service import a route module, which pulls sharp and pdfium into the "pure" follow-ups builder

What is wrong. Adjudication 12's implementation (GREEN 1b, :9686-9692) exports `displayNameOfContact` from
`app/src/routes/units.ts:165` and imports it into `app/src/services/followUps.ts`. `routes/units.ts` imports
`../adapters/mediaTranscode.js` (`units.ts:27`), and that adapter imports `sharp` and `@hyzyla/pdfium`
(`adapters/mediaTranscode.ts:7-8`). So:

- the service layer now depends on a route module (AGENTS.md: services depend on interfaces; vendor SDKs stay in
  adapters);
- `app/test/followUps.test.ts`, described as a "Pure - every repo is a fake" builder test, now loads two native
  modules transitively.

The function body is the same 6 lines the v1 `nameOf` already had (`units.ts:165-176`), so the "drift" being
fixed was zero lines.

Fix. Move `displayNameOfContact` into a lib module (for example `app/src/lib/contactName.ts`) that both import.
Or keep v1's local copy with a comment naming `units.ts` as the twin. Do not import a route module from a
service.

## F4 [LOW] S10's I1 re-audit writes to a gitignored path, so the committed audit record still goes stale (B10 half-closed)

What is wrong. Task 1.13B commits the audit to
`docs/superpowers/reviews/2026-10-12-last-heard-from/I1-last-heard-from-writers.md`. S10.2's new step writes the
final re-run to `.superpowers/sdd/gates/i1-audit.txt` (:12183-12186 region). AGENTS.md says findings go to the
records path, committed as produced, and `.superpowers/` holds only the ledger, logs and run state. As written,
the committed record still reflects the S1 tree, and the final-tree result is invisible to git. The new step is
also numbered "6." and sits between gates 4 and 5.

Fix. Update the committed I1 file in S10 (or commit a dated addendum to the records folder), and renumber.

## F5 [LOW] R4's push-open plus replace-close leaves a duplicate history entry, so Back after Cancel appears to do nothing

What is wrong. Task 5.3 opens the form with `setSearchParams(...)` (a PUSH, :7303-7310: "a history entry - Back
closes it") and closes it with `{ replace: true }` (:7312-7321). After a Cancel, the stack is `[L, L]`: the
`?tour=new` entry is replaced in place by bare `L`. The user's next Back lands on an identical URL, and nothing
visibly happens. The create path ends `[L, L, /tours/t]`, which is the same duplicate one step later. The
dashboard uses a declarative `<BrowserRouter>` (`dashboard/src/main.tsx:16`), so the replace-then-push ordering
itself is safe. No unit test checks history length.

Fix. Closing a push-opened form should go back (`navigate(-1)`) when the current entry was pushed by
`openTourForm`. Keep the replace only for the deep-link entry (`?tour=new` arriving from another page, as in the
Follow up deep link). Or accept this explicitly in the plan.

## F6 [LOW] The plan-head dev-seam row still promises an unconditional 201

What is wrong. Section 1's `dev seam` row (:82) still reads "-> 201 `{ row }` ... writes a COUNTED, listed row".
The 409 `send_exists` create-only rule appears only in the W3 note (:7888-7890) and Task 7.2. The W3 note itself
calls it "an addition to the plan-head dev-seam row", but the row was not edited. selectors.md's new dev-seam
row (S8.6) also omits the 409.

Fix. One clause in each place: "409 `send_exists` when the pair already has a row (create only)".

---

## The v2 changes, reviewed cold (no finding unless listed above)

- `{ row }` (3.8 / 5.3 / 5.4 / 7.3). Consistent across code, tests and mocks; the 3.8 test now asserts the
  wrapped body.
- `SendRosterList` + `<li>` root (5.1) and the grouped lists (5.3 / 5.4). Unit tests pin the listitem counts on
  the component, on the property card (5 rows, 5 listitems, named lists in order) and on the contact card.
  `groupSendRows` returns all four groups and the host filters out the empty ones. The R1 audit claim holds:
  `EmptyRow` / `PendingPanel` are `<p>`, and the card aside is a button. I found no existing unit test or e2e
  spec that counts unscoped listitems on the property or contact page. `deleted-contact-resurfacing.spec.ts:50`
  is on the Inbox page; the caseworkers and contact-create listitem reads are scoped.
- URL-only tour form (5.3). `tourFormOpen` derives from the URL. "+ Tour", form-mode Interested and the partner
  link all navigate there. The deleted-property guard is kept. Both params are cleared. The form-mode unit test
  now asserts the URL, the locked tenant, that no tour is created, and the Cancel path. See F5 for history.
- `::before` prefix (6.5). The generated content sits under `@container (max-width: 767.98px)` on `.cellHeard`,
  inside the `.preview` container. The cell's DOM text is the bare label, so 8.3's regex and its count-0 check
  hold. The unit test now asserts exactly one "Last heard from" (the aria-hidden header). jsdom runs
  `css: false`, so nothing in unit tests can see the prefix. That is fine because the wide layout is what the
  e2e drives (1440px).
- 409 `send_exists` (7.2). The pre-read is `getByKeyConsistent`. `putShareMemory` with `token: undefined`
  conditions on `attribute_not_exists(#op)` (`listingSendsRepo.ts:270-274`), so only a concurrent create can
  lose, and it maps to the same 409. Every S8 use plants a fresh pair.
- In-place rule (7.3) and `useFollowUps.test.tsx`. The hook clears `resolutions` on every completed load; the
  tests cover resolve, unresolve and a retry that replaces state. 8.6 now reloads before asserting a row is gone
  and asserts the in-place state first.
- Voice path 6 (1.8). The seam works mechanically:
  - the echo guard uses `getByPoolNumber`, not the overridden `getAllByPoolNumber` (`services/ourNumberKind.ts:35`);
  - the resolver reads only `status` and `participants`;
  - `handleMaskedInbound` reads `pool_number` (`voice.ts:995`) before `isClosed` (`:999`).

  Validity is covered in F2.
- `markSending` pin (6.1). It is real: path (b) builds `{ status: 'queued' }` through `buildRecipientsFrom`
  (`broadcasts.ts:358-367`), path (c) builds it in the loop (`:933-936`), and the one write is `markSending`
  (`:942`). Exact `toEqual` on the map catches a leaked field. UNVERIFIED: the two sends answering 200 in the
  harness with consent-less seeded tenants. Existing send tests assert 200 (`broadcastApi.test.ts:318`).
- Timeout 2400 plus the orphan check (8.5 / S10). The ports cited (app `9001+L*100`, dashboard +10, fake +20,
  public +30) match `e2e/support/lane.mjs:8-13, :31-39`.

## Adjudications

- 1-3, 5, 6, 8-11, 13: concede; the fixes are correct as written.
- 4 (in-place rule): concede. The ruling is sound and 8.6 now matches it.
- 7 (A4): CONTESTED. See F2: the patched state is unreachable, and the reachable case is unpinned.
- 12 (name reuse): the ruling stands; its implementation is CONTESTED. See F3: a service must not import a route.
- 14 (B8): the ruling stands; it was not applied to S7.3. See F1.
- 15 (I1 re-audit): half-applied. See F4.
