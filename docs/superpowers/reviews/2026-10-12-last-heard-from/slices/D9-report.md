# D9 - S6 Tasks 6.1-6.5: decisions record

Dispatch D9 of the feat/last-heard-from build (implementer, 2026-10-13).
Scope: Matching's Review recipients step - the resolver and seeds carry the
tenant status and last heard from; the preview response gains the
not-interested labels and the degraded flag; the C6 patch, verbatim; the
`ContactSearchField` `annotate` prop; the RecipientPreview columns, order and
declined rows. Plan: `docs/superpowers/plans/2026-10-12-last-heard-from.md`
(S6 Tasks 6.1-6.5, the W3 contract notes, sections 3.4 #5/#7/#10/#11 and 11).
Binding corrections applied: matching F3 (6.3), F5 (6.5), F6 (6.2), F7 (no
e2e edit), outcome F3 (6.5 title).

## Commits

- d89bbd9d Task 6.1 - `app/src/services/audienceResolution.ts` (`status?`
  :55, `lastHeardFromAt?` :58, resolver projection :180);
  `app/src/routes/broadcasts.ts` (resolveSeeds tenant-only status :526,
  preview projection :794); tests `app/test/audienceResolution.test.ts`
  (knowing D1 update, new case), `app/test/broadcastApi.test.ts` (knowing D2
  update, audience case, partner-seed negative, markSending PIN).
- b9effffd Task 6.2 - `app/src/routes/broadcasts.ts` (deps :127/:129, locals
  :443-444, `effectiveDeclines` :460, degraded catch :777,
  `declinedThisProperty` :815, `declinedContactIds` :836);
  `app/src/routes/api.ts` (:1111-1112); `dashboard/src/api/types.ts`
  (:3408, :3432, :3435); fixtures in `RecipientPreview.test.tsx` (typed) and
  `BroadcastComposer.test.tsx` (untyped, for fidelity); 9 new app cases.
- 3509ad35 Task 6.3 - C6 patch applied VERBATIM
  (`docs/superpowers/reviews/2026-10-07-caseworkers/C6-proposed-fix.patch`);
  only `ContactSearchField.tsx` and its test changed.
- 740ea936 Task 6.4 - `dashboard/src/routes/contact/ContactSearchField.tsx`
  (prop :68, destructure :94, note :292/:319),
  `ContactSearchField.module.css` (`.optionNote` :101), two new test cases.
- cb7a07d1 Task 6.5 - `dashboard/src/routes/broadcasts/RecipientPreview.tsx`
  (`now?` :88, `NO_CONSENT_TAG_TEXT` :94, `defaultChecked` :99,
  `checkboxName` :105, `initialRows` :115, `orderedRows` :194, scroll effect
  :212, search over `orderedRows` :223-224, Select all :244, add-scroll
  :289, `annotateCandidate` :437, degraded line :491, header :508, list
  :518, title spread :572, declined tag :582); `RecipientPreview.module.css`
  (container :7, gutters :78/:192, queries :232/:264); test file (knowing
  em-dash rewrite :437, new describe :818).

`npm run typecheck` exited 0 after each commit; `npx eslint` on every
touched .ts/.tsx file exited 0.

## RED / GREEN evidence

- 6.1 RED 5 (fields absent), markSending PIN green before and after;
  GREEN 112/112 (two app files).
- 6.2 RED 10 (fields absent) + dashboard typecheck RED on the typed
  fixtures; GREEN app 121/121, dashboard broadcasts 224/224.
- 6.3 test hunk alone: 2 RED (`opens above a low input ...` and `caps the
  list ... short viewport ...`, both on the listbox's style.bottom) + 1 PIN
  (`keeps a short list below the input when it fits there`), as ruled in
  adjudication F3; GREEN 21/21 after the source hunk.
- 6.4 RED 1 + typecheck RED; GREEN 23/23.
- 6.5 RED 10 (incl. the knowing em-dash rewrite); GREEN 99/99
  (RecipientPreview + BroadcastComposer); broadcasts + contact dirs
  1869/1869.

## Decisions and divergences (all contract-preserving)

1. 6.3 commit message amended once, immediately and message-only, to
   correct the second RED case's detail (style.bottom, not maxHeight).
   Nothing referenced the first hash; S9 cites 3509ad35.
2. 6.3 verbatim proof: the working-tree diff matched the patch hunk for hunk
   and the patch reverse-applied cleanly before the commit.
3. 6.2 `effectiveDeclines` sits after the existing NOTE comment about the
   `events` dep (broadcasts.ts:446-448) so that comment, which carries a
   pre-existing em dash, is untouched; the two repo locals stay at the
   plan's anchor after `orgNames`.
4. 6.2 the api.ts edit is anchored on the unique org-names comment inside
   `createBroadcastsRouter({` (F6); its comment says "the instances built
   above" rather than citing line numbers.
5. 6.5 `cellHeard` spreads `title` only when non-empty (outcome F3 /
   contract N1); F5 applied (both the unsearched return and the filter read
   `orderedRows`).
6. 6.5 the old `.rowBody` comment (pre-existing em dash, described the old
   one-line layout) is replaced together with the rule.
7. Line citations in new comments were dropped where the plan had them
   (they rot): audienceResolution `(:149)`, ContactSearchField `:8-16`,
   the Timeline / 420px note in the scroll effect.
8. No e2e edit (F7): `e2e/scenarios/steps.ts` selects a review checkbox by
   a first-name PREFIX; no e2e spec reads a checkbox name suffix; the
   visible no-consent tag text is unchanged (built from the code point).
9. Not touched by design: `docs/issues/contact-search-popover-below-viewport.md`
   (S9), whole-suite gates and Playwright (orchestrator).
