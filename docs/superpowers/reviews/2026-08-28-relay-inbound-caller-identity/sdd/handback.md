# Relay inbound caller identity handback

## Work map

- S1 shipped: `messagesRepo` now permits exactly the durable non-member relay
  facts (`relay_refusal_reason`, normalized caller phone, optional stored contact
  ID) only on a valid inbound masked call with unknown author and no sender key.
  The production shape guard and strict test fake reject every other writer
  shape before persistence.
- S2 shipped: the existing voice webhook enriches only after its established
  `reason === 'non_member'` decision. It does one deletion-fenced, best-effort
  phone lookup, does not create contacts or alter rosters, and leaves the
  refusal `Say`/`Hangup`, Dial, routing, and recording behavior unchanged.
- S3 shipped: the authenticated messages read path resolves stored contact IDs
  in one deduplicated, deletion-fenced batch and copies a current display name
  into the response. It never resolves a name by phone at read time.
- S4 shipped: dashboard wire types, mapper, and pure presenters produce the
  approved name, phone, then unknown precedence; exact non-member rows state
  `Not connected`.
- S5 shipped: the call card displays `<identity> tried to call this relay
  number`, has collapsed per-card Details, and reveals phone or unavailable,
  the non-member explanation, named-live-contact-only View contact or No linked
  contact, and a local seconds-precise timestamp.
- E1 shipped: the committed hermetic Playwright flow makes a real fake inbound
  non-member call, asserts zero Dial legs/no contact creation, persistence, and
  the staff dashboard card and details.
- E2 shipped with full gates, independent review, main sync, and hermetic live
  self-QA complete. The touched-file lint findings are baseline-identical.

## Final evidence

Code gates ran after the one `main` sync at `a3ae21bb`. Root review found that
the new E2E spec's formatter import pulled a dashboard `.tsx` graph into the
E2E TypeScript project; final commit `1ddea1e6` narrows that pure import and
corrects the issue record to describe the resolved branch regression.

- `npm run typecheck`: exit 0 across app, dashboard, E2E, fake Twilio, and fake
  Twilio web. The E2E workspace also exits 0 independently after the import fix.
- `npm test`: exit 0. App: `344 passed | 1 skipped` files and
  `6208 passed | 9 skipped` tests. Dashboard: `183 passed`, `2844 passed`.
  E2E workspace unit suite: `19 passed`, `492 passed`. Fake Twilio:
  `34 passed`, `240 passed`. Fake Twilio web: `13 passed`, `111 passed`.
- `npm run smoke`: exit 0. `smoke-dist: OK - 1347 import specifier(s) across
  238 emitted file(s) resolve under plain Node.`
- `npm run e2e`: exit 0. `260 passed (17.7m)`, including
  `relay-inbound-caller-identity.spec.ts`.
- Post-review focused proof: the five affected dashboard files passed `249/249`,
  and the final-state relay E2E spec passed `1/1` in its hermetic lane.
- Touched-file ESLint: exit 1 with `2 errors, 3 warnings`. All are unchanged
  from `main`: unused `contactShortName` in `voice.ts`, Timeline's existing
  `setNow(fresh)` effect, and three stale `useRelayThread` disable warnings.
  No new lint finding is attributable to this branch.
- Final integrity: `git diff --check main...HEAD` exit 0; clean worktree;
  no `MERGE_HEAD`; branch is 0 behind and 11 ahead of `main`.

## Review and adjudication

- Spec-conformance review: S1-S5 and E1 conform. Its then-pending E2 was
  completed by the later sync, final-gate, and QA work above.
- Adversarial review found an active matched contact with no name would show
  the stored phone and `No linked contact`. Finding rejected: approved plan
  lines 64-68 expressly make View contact conditional on a non-deleted named
  contact. The phone fallback/no-link result is intentional, not a defect
  correction or an unapproved contract expansion. The attempted fix-wave test
  edit was removed before commit.
- Reviewer attacks that did not break the feature: alternate writers, other
  refusal branches, redelivery, deleted contacts, contact projection consumers,
  participant-facing leak boundaries, no contact creation, and no roster
  mutation.
- Root review did break the initial typecheck attribution: `main` passed the E2E
  workspace typecheck while the pre-fix branch failed. That finding was fixed,
  re-gated, and returned to both independent reviewers for final confirmation.

## Live self-QA

`.superpowers/sdd/self-qa.md` records a dedicated hermetic lane 4 session.
An unmatched caller produced the formatted phone face, `Not connected`, zero
Dial legs, no contact ID, and collapsed details with `No linked contact`. A
named, non-member contact produced the current name face and one matching View
contact link. Desktop and 360 px visual checks showed the card face and details
without horizontal overflow. The lane was stopped, its tables dropped, and its
lease released. No production or participant-facing endpoint was exercised.

Process note: the first focused E2E attempt used the wrong fake-call wire field
(`call_sid` rather than `provider_sid`); it was corrected before the committed
test passed. The initial failure artifacts were not preserved.

## Branch record

- Feature commits: `b9c28a41`, `e6c92101`, `c337bcc2`, `ec5409fc`,
  `334b9f2f`, `06065e04`, `b526819d`, `1065acce`.
- One required main sync: `a3ae21bb` (main's docs-only relay retry issue).
- Initial issue record: `e8b1e634 docs: record e2e typecheck baseline`.
- Final corrections: `1ddea1e6 fix: keep relay E2E formatter import type-safe`
  and `834f8a52 docs: resolve relay E2E typecheck issue`.
- Net vs synced main: 24 files, `2486 insertions(+), 12 deletions(-)`.
- Known flakes: none. `npm run issues` succeeded, with one unrelated existing
  warning for `perf-selfqa-route-contract-drift.md` using severity `medium`.
- No infrastructure, deployment, or post-merge operation is owed.

MERGE-READY @834f8a52 on
`feat/relay-inbound-caller-identity` (`W:\tmp\relay-inbound-caller-identity`),
0 behind `main`, UNMERGED (human gate). The feature is merge-ready with the
explicit unchanged-main lint baseline exception recorded above.
