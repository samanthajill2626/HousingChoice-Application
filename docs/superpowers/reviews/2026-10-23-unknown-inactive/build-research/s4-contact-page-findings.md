# S4 dashboard contact page - build-research findings (reader s4-contact-page)

Scope: plan section 8 (S4, plan lines 5679-7953) read against the tree at
916258ae (worktree W:\tmp\unknown-inactive), with plan sections 0-4 and the
S2 dashboard tasks (S2.6, S2.9) it builds on.

Result: 0 BLOCKER, 0 MAJOR, 5 MINOR. Every quoted S4 anchor exists byte-exact
and exactly once (ContactDetail.tsx, ContactEditForm.tsx including all 30
one-line 3j edits, api/types.ts, api/endpoints.ts, format.ts, StatusBadge.tsx,
ContactsList.tsx, UnknownFile.tsx and the seven edited test files). The cross-workspace
import, the stated RED/PIN outcomes (except item 3), the GREEN behavior of
every new and pre-existing test case, and the typecheck shape of the planned
code all hold.

1. MINOR - S4.6 Step 3 (gate 5 lint), touching S4.2's file list.
   Tree: dashboard/src/routes/contacts/ContactsList.tsx:207-209 holds the
   phoneParam effect; its setQuery call at :208 is a PRE-EXISTING
   react-hooks/set-state-in-effect error (recorded at :208 in
   docs/superpowers/reviews/2026-10-12-last-heard-from/handback.md:25; at :184
   earlier in docs/superpowers/reviews/2026-10-07-caseworkers/planner-final-review.md:109).
   S4.2 edits this file, and its statusLabel rewrite (ContactsList.tsx:97-102,
   6 lines become 7) moves the error to :209. The plan instead says
   ContactDetail.tsx and ContactEditForm.tsx "may carry" pre-existing errors;
   both were lint-clean at 1bf50472
   (docs/superpowers/reviews/2026-10-20-property-requirements/build/U12-S6b.md:127),
   with ContactDetail.tsx:326 keeping its existing disable comment.
   Correction: expect Step 3 to exit 1 on exactly that one pre-existing
   error (ContactsList.tsx:209 after S4.2), prove it by the baseline run,
   and name it in the S4 report. No planned S4 code adds a hook, effect or
   dependency array, so any OTHER error is S4's and blocking.

2. MINOR - S4.6 Step 4 (ASCII loop).
   Plan: `git diff -U0 main -- "$f"` compares against the moving local
   `main`; S2.10 Step 1 uses the fixed base 916258ae. If main advances
   before S7's single sync, lines main changed come out as `+` lines, and
   the touched files that already carry non-ASCII (api/types.ts:795,
   format.ts:1, ContactDetail.tsx, ContactEditForm.tsx, StatusBadge.tsx,
   ContactsList.tsx) print a false non-zero.
   Correction: diff against 916258ae (or `$(git merge-base main HEAD)`),
   as S2.10 does.

3. MINOR - S4.4 Step 2 (stated RED reason for "a change-and-back (tenant to
   landlord to tenant)").
   Tree: the current handleKindChange (ContactEditForm.tsx:290-291) resets
   'searching' to 'needs_review' when Landlord is picked, so the case fails
   at its FIRST assertion with `expected 'needs_review' to be 'interested'`
   - not "after coming back", and no setTenantStatus is reached. Still RED
   for a valid reason.
   Correction: the builder should expect that message for this case.

4. MINOR - S4.4 Step 3j (post-edit grep check).
   Plan says `grep -n "contact[.[(]\|(contact)"` prints
   `let updated: Contact = contact;`; that line (ContactEditForm.tsx:532)
   does not match the pattern. Expected output after 3j: the useState seeds
   (191-280, including requirementFormValuesFromLandlord(contact) at 244),
   the new `useState(contact)`, the two contact.contactId calls (534, 543)
   and the base-comment line naming contact.updated. The edit list itself
   is complete: every non-seed read of the live prop (205, 291, 308, 310,
   334-455, 519-521, 576-579, 639) is covered by 3d-3j.
   Correction: drop `let updated...` from the expected grep output.

5. MINOR - S4.6 Step 5 (report list): one risk to record, no code change.
   S4.4 sends a partner / team member / unknown no-type-change status change
   through setTenantStatus, which validates toStatus against the type the
   ROUTE reads; AR4's 409 guards only that route-read-to-write window
   (services/statusTransition.ts conditional write, S2.3). The form diffs
   against `base` (the contact as opened) and S2.9's re-read refreshes the
   page, not the frozen form, so after a concurrent re-type a status picked
   from the opened type's list lands on the new type whenever it is legal
   there (e.g. Inactive onto a contact re-typed to tenant), or 400s to the
   generic "Couldn't save - please try again." The header pill has the same
   window only until S2.9's re-read lands. Same class as today's PATCH path
   (ContactEditForm.tsx:345), so not a regression.
   Correction: add this item to the S4 report list in S4.6 Step 5 beside the
   existing 409-copy item.
