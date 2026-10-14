# Plan review round 3 - reviewer B (adversarial; rulings AR33-AR38 cold)

Plan: `docs/superpowers/plans/2026-10-14-matching-blast-rules.md` @9f0d7520 (section 4.2,
AR33-AR38, supersedes the parts of AR23-AR27 it names). Read-only; no test was run. Each
finding compares a ruling with the real code or the plan test it governs.

## Summary

No BLOCKING or HIGH. Two MEDIUM: AR33 names a mechanism that does not exist for the 422
branch, and AR34 prescribes an assertion that contradicts its own test's fixture. Three LOW.
AR35 is correct as written and agrees with the hook's real states (checked below).

---

## 1. [MEDIUM] AR33: the "existing staleness check" cannot tell a late 422 from a current one; the builder must invent the mechanism

What is wrong. The check the R3-FE-1 test exercises is not in `onPreview`. `onPreview`
stores every 200 unconditionally with the key it was made for
(`BroadcastComposer.tsx:360`, `:365-366`); the comparison happens in RENDER
(`currentPreview`, `:404-410`), and a stored result that is not current shows "The audience
changed - preview again." (`:586-590`, pinned at `BroadcastComposer.test.tsx:964`). The
catch block runs in the closure of the render that clicked Preview, so `previewed.key` and
`draft.key` there are ALWAYS equal. A literal "if (previewed.key === draft.key)" guard in the
catch does nothing.

- For the 503 this is fine: AR36 stores the key and compares in render - the same pattern.
- For the 422 it does not carry over. D3b's removal is a lasting edit, and the edit itself
  changes the filter and therefore the key. So "apply it only while the stored 422 is
  current" cannot be a pure render-time derivation: the moment it applies, it stops being
  current. A builder needs one of three designs AR33 does not name:
  (a) a pending-rejection state applied by a guarded adjust-during-render (the pattern the
      lint issue says lints clean, `docs/issues/lint-backlog-repo-wide.md:13-21`);
  (b) a generation ref bumped in the EVENT handlers that change the audience (refs may be
      written in handlers, not during render);
  (c) a property check inside the `setEdits` updater, with the notice moved into
      `FilterEdits`. This is property-based, not draft-based, so it does not follow
      AR33's "ONLY when the result is for the current draft" literally.

Two more gaps:

- "Discarded exactly as a late 200 is" is ambiguous. A late 200 is not silent: it shows the
  "audience changed" alert. Should a late 422/503 show it too?
- The required test cannot catch the real damage. Task 3.5 step 10's `rejectAuthority`
  rewrites the edits to the OLD property's slot (`own = { unitId: <old> }`). That only
  destroys something if staff have already edited the NEW property's filter when the 422
  lands. The test as specified (Change, pick, land the 422, assert no removal and no notice)
  edits nothing first, so only its notice assertion has any power.

What it implies. A red new test, and then an undirected design choice in the most
race-prone code of the slice. Name the mechanism. The smallest one is (a): store
`{ key: previewed.key, text }` in the catch; in render, when it is current, apply the removal
and clear it. Say whether a late 422/503 shows the "audience changed" alert. Make the test
edit the new property's voucher size before landing the 422, and assert the edit survives.

## 2. [MEDIUM] AR34: the rewritten "Preview waits for the organization list" test asserts an authority its fixture cannot produce

What is wrong. AR34 says that after the list resolves, the one create "carries
`housing_authorities: ['Atlanta Housing Authority']`". The test (plan line 9425-9437) sets
no unit: the file-level `beforeEach` gives `getUnit.mockReset().mockResolvedValue(unit())`
(`BroadcastComposer.test.tsx:85`), and `unit()` has no `accepted_authorities`
(`:45-53`). `authoritiesOf` then returns `[]` (`listingFormat.ts:63-71`). The prefill is
empty, and the one create carries `{ contact_type: 'tenant', bedroomSize: 2 }`. The
describe's `beforeEach` (plan line 9389-9391) sets only the org list.

What it implies. Applied literally, the binding assertion is red. Add
`getUnit.mockResolvedValue(unit({ accepted_authorities: ['Atlanta Housing Authority'] }))`
to that test in AR34's text.

## 3. [LOW] AR36: "the current draft key" names neither of the two keys the composer has

What is wrong. The hook exposes `key` ("the material key of the inputs on screen now") and
`draftKey` ("the material key the current draft was made for")
(`useComposerDraft.ts:70-78`). The existing staleness check uses both (`:404-410`). A
builder who reads "draft key" as `draft.draftKey` gets an alert that:

- outlives a filter change until the recreate lands;
- outlives it forever after a FAILED recreate (`draftKey` does not move);
- fails AR25's "changing the voucher size removes the alert" if asserted synchronously.

What it implies. Write `draft.key`. The value stored in the catch is `previewed.key`.

## 4. [LOW] AR37: setting 'failed' in `.catch` also catches StrictMode's aborted first read; the new states have no required test

What is wrong. The app renders under `<StrictMode>` (`dashboard/src/main.tsx:14-15`), and
the units effect aborts on cleanup (`BroadcastComposer.tsx:198`). The client rethrows an
AbortError (`api/client.ts:124-125`) into the read's `.catch`. Read literally, AR37 sets
'failed' there. Every dev and e2e bare entry (Vite dev serves StrictMode) then shows
"Couldn't load the properties." until the second read lands. Task 3.5 step 12 already
ignores aborts for the property load; AR37 does not say to. AR37 also adds the failed copy
and the silent loading state without requiring a test for either.

What it implies. Add "an aborted read records nothing (`controller.signal.aborted`)", plus
a test each for the failed read (its sentence) and the in-flight read (no sentence).

## 5. [LOW] AR38 follows half of the issue file's convention

What is wrong. The convention AR38 cites (commit 3454a0ee) changed three things: the
frontmatter `title` (23/18 -> 22/17), a new `updated:` line, and a dated status paragraph as
the first body paragraph. AR38 asks only for the paragraph. That leaves the title saying
"22 ... across 17 files" above a body saying 20. "At the top" should read "the first body
paragraph, after the frontmatter": above the `---` block would break the registry
(`npm run issues` reads the frontmatter).

What it implies. Add the title and `updated:` edits, and fix the placement wording.

---

## Rulings checked and found correct

- AR35: correct, and it agrees with the hook's real states.
  - The hold returns before the debounce, and its cleanup bumps `genRef`
    (`useComposerDraft.ts:251-257`). So a create scheduled or in flight when the hold
    starts is cancelled or self-deletes.
  - Derived `reachPending = hold || reachPending` never sticks. When the hold releases,
    one of three exits clears the stored flag: the same-key exit (`:180-185`), the
    create's `.then`/`.catch` (`:216`, `:225`), or the no-message reset (`:160-171`, which
    runs because `clearedRef` is false whenever a body existed).
  - The reach line's three renderings (`AudienceFilters.tsx:179-195`) show "Estimating
    reach..." for the whole hold.
  - The existing R3-FE-1 test (`BroadcastComposer.test.tsx:946-970`) still passes under
    the hold: Oak's load resolves, the hold releases, and create #2 is made for `u-2`.
- AR34's second test (the aborted load): correct. The hold keeps the reach pending even
  before the message is typed.
- AR33's choice to keep Change enabled: correct; the R3-FE-1 test stays valid.
- AR37 against existing picker tests: no conflict. No test asserts the old
  "No properties yet" copy (grep of `dashboard/src`, `e2e/tests`). The Task 3.6 tests read
  the empty state only after `getAllUnits` resolves.

## Contested / conceded

- AR33: contested on mechanism (finding 1), not on the decision to keep Change enabled.
- AR34: contested on one assertion (finding 2).
- AR35, AR36 (field name aside), AR37 (abort aside), AR38 (title aside): conceded.

## Correct or merely plausible

- AR35: correct.
- AR36: correct once the key is named.
- AR37: correct once aborts are excluded.
- AR38: correct once the frontmatter is included.
- AR34: correct except one assertion.
- AR33: the decision is correct; the instruction is only plausible. It points at a check
  that does not cover the case it is told to cover.
