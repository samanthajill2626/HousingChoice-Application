# R2 findings - blasts and their housing authority filter

Plan research, area R2 (blasts / property sends and the housing authority
filter). Spec: `docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md`
(revision 5). Code read at `feat/clean-org-names` HEAD `93c3c65b`. Byte-exact
quotes for every anchor below are in the gitignored reference
`.superpowers/sdd/plan-research/R2-broadcasts-reference.md`.

Five findings: one material (F1), one implementation trap the spec does not
state (F2), two precision notes on where D7's re-check applies (F3, F4), and one
branch B note (F5).

---

## F1 (material) - the dashboard cannot reach "a resumed draft with an off-list filter"

**Spec says.** Section 7: "a resumed draft with an off-list filter asks for a new
pick". Section 1.2: "a draft can be resumed, and its preview re-resolves the
stored filter".

**Code does.** That is true of the API but not of the dashboard. The composer
never reads a stored draft:

- The filter state starts as `{ contact_type: 'tenant' }` and is never loaded
  from the server (`dashboard/src/routes/broadcasts/BroadcastComposer.tsx:70`).
  On resume (`?draftId=`) the composer only adopts the id
  (`BroadcastComposer.tsx:129-136`, `useComposerDraft.ts:105-108`).
- On resume the message body starts empty and the property prefill is skipped
  (`BroadcastComposer.tsx:71-82`, `:208`). A test pins this
  (`BroadcastComposer.test.tsx:264-273`).
- Preview needs a non-empty body (`BroadcastComposer.tsx:332-333`). The first
  typed character recreates a new draft from the on-screen filter (no housing
  authority, no unitId) and deletes the resumed one (`useComposerDraft.ts:155-185`).
- The code already says so: "the composer can't rehydrate one yet"
  (`BroadcastsList.tsx:5-6`), and `docs/issues/broadcast-draft-curation-persistence.md`
  is open for it.

So the stored-filter re-check at preview fires only for API callers. The
dashboard can hit a 422 only in two ways:

- **At create.** The picked entry was deleted, or changed kind, after the picker
  loaded its list. A rename or merge does not cause a 422 here: the old name
  stays as a spelling (D11), and D5 resolves it to the new name.
- **At preview.** Any rename, merge, delete or kind change happens between the
  draft's create and the Preview click. The stored name is then no longer an
  exact name (D3).

Today both of these screens show a 422 badly:

- `useComposerDraft.ts:194-199` passes through only a 400's message. A 422 shows
  the generic "Couldn't estimate the audience" text.
- `BroadcastComposer.tsx:318-320` renders `err.message`, which is the server's
  error code (`dashboard/src/api/client.ts:78-80`). The user would see the literal
  text `org_not_on_list`.

**For the plan.** Build D7's "asks for a new pick" on the create path
(`useComposerDraft` catch) and the preview path (`BroadcastComposer.onPreview`),
not on a resume path. Do not add draft rehydration. The spec does not ask for it,
and it belongs to the open issue above. If the plan leaves resume alone, the
section 7 sentence describes a state the dashboard cannot reach. The spec could
note that, but no design change is needed.

---

## F2 (implementation trap the spec does not state) - the picker must commit only on a pick

**Spec says.** D7: the composer gets "the picker without the add step".

**Code does.** The composer acts as a WRITER on every edit:

- The current input commits each keystroke's raw text to
  `filter.housing_authority` (`AudienceFilters.tsx:55-60`, `:109-117`).
- Every change of that value is a material change
  (`useComposerDraft.ts:73-86`, key `h` at `:81`).
- Each material change POSTs a new draft 600 ms later
  (`useComposerDraft.ts:28`, `:155-166`).

Under D5, each partial word ("Atl") would be POSTed and refused 422. The draft
would go stale and Preview would stay disabled (`useComposerDraft.ts:193`).

**For the plan.**

- Keep the picker's typed query as local state. Change `filter.housing_authority`
  only on a pick or a clear. A test should pin this: typing alone produces no
  `onChange` with a new value. Today's `AudienceFilters.test.tsx:74-80` asserts
  the opposite and must be rewritten.
- Keep the accessible name "Housing authority". It is pinned by
  `AudienceFilters.test.tsx:78`, `BroadcastComposer.test.tsx:99,123,326,328,393,415`
  and `e2e/tests/dashboard-next/matching-entry-points.spec.ts:287,322`.

---

## F3 (precision) - the send re-check belongs in branch (c), not before the branch split

**Spec says.** D7: the filter is re-checked "on a send that re-resolves the
filter (a send without `recipientContactIds`)".

**Code does.** The send route has three branches, not two
(`app/src/routes/broadcasts.ts:698-708`):

- (a) explicit `recipientContactIds` (`:720-771`);
- (b) a seeds_only draft sent with no body (`:772-784`). It resolves the seed
  contacts only and never reads the filter;
- (c) the filter re-resolve (`:785-822`).

A no-body send of a seeds_only draft matches the spec's parenthetical but does
not re-resolve the filter.

**For the plan.** Put the check immediately before `resolveAudience` in branch
(c) (`:790`). If it sat before the split, a seeds_only row carrying an old filter
would be refused for a filter it never uses. A route-created seeds_only draft
never has a housing authority (`:498-501` parse `{}`), but rows written by seeds
or by hand can.

---

## F4 (precision) - preview has no status guard

**Spec says.** D7: "A stored draft filter is re-checked at preview". Also: "Sent
blasts keep their historical filter".

**Code does.** `POST /api/broadcasts/:id/preview` previews a broadcast of ANY
status (`app/src/routes/broadcasts.ts:563-570`). The only check there is the
404. The literal re-check would therefore also refuse an API preview of a SENT
share whose historical filter is an old spelling. Examples: any prod share sent
before the deploy, or the full-profile seeded `broadcast-mx-sent-01`
(`app/src/lib/seed/matrix.ts:1211-1217`) until its seed is updated. No dashboard
caller previews a non-draft (`BroadcastComposer.tsx:311-316` previews only the
composer's own draft id).

**For the plan.** Decide explicitly between two options:

- re-check only when `status === 'draft'`; or
- accept the 422 for non-drafts and say so in the route's header comment
  (`broadcasts.ts:6-11`).

---

## F5 (branch B note, D20) - the "Sent to" list's role label needs data the route does not read

**Spec says.** D20 and section 10: the property's "Sent to" list labels partner
rows "by their role". The composer preview and results wording becomes not
tenant-only.

**Code does.**

- `GET /api/units/:unitId/recipients` hydrates names through the contact DISPLAY
  projection (`app/src/routes/units.ts:977-985`). That projection holds contactId,
  firstName, lastName, phone and deleted_at only
  (`app/src/repos/contactsRepo.ts:311-317`, `:894-896`): no `type`, no `role`.
  Labelling partner rows needs a wider read or projection.
- Two tenant-worded sites sit outside "composer preview and results":
  - The compose step's reach line, `AudienceFilters.tsx:140`. The filter-mode
    estimate is the union of the audience and the seeds
    (`broadcasts.ts:512-516`), so a partner seed is counted as a "tenant".
  - The Matching list row label, `BroadcastsList.tsx:37-41`, through
    `sendReachLabel` (`broadcastFormat.ts:69-72`).
- No server change is needed for the partner page's "Properties sent" card:
  `GET /api/contacts/:id/listings-sent` has no type guard
  (`app/src/routes/contacts.ts:1154-1168`).

Branch A is unaffected. This is for B's plan.
