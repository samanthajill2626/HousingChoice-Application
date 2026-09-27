# Review R1 - adversarial (feat/staff-notes-past-tours)

Date: 2026-09-27

Scope: base 0dafe3c1..HEAD c45e7159, code and tests only, from
`.superpowers/review/feature-diff.txt` (22 files: contacts PATCH allowlist and
stamp, StaffNotesCard + TenantFile wiring, Tours page Past view + usePastTours,
TourDetail `?outcome=1` deep link + back pointer, e2e specs, perf-registry
exclusion). Intended behavior derived from the code and its tests only; no
spec, plan, review record or 2026-09-26/27 issue body was read.

Method: read the whole diff package, then followed every piece of state it
touches through app/, dashboard/, e2e/, fake-twilio/, scripts/ (grep sweep
below). Claims were proven with throwaway probes written after the unit gate
had finished (`p3-test.exit` present), each run alone and then DELETED
(`git status` clean apart from another reviewer's untracked record):

- P1 dashboard RTL, ToursPage with routes /tours/past + a stub /tours/:tourId,
  per-mount reload spies (finding A-1).
- P2 app supertest on makeWebhookHarness: what PATCH /api/tours/:id
  { status: 'toured' } accepts (finding A-2).
- P3 dashboard RTL, a ContactDetail-shaped harness (useContact -> spinner while
  loading -> StaffNotesCard with onContactUpdated={setContact}), plus a control
  with the proposed one-line fix (finding A-3).
- P4 dashboard RTL, StaffNotesCard alone (finding A-4).

No source file was modified; no e2e lane, port or artifact was touched.

Verdict: NO BLOCKING defect found. 3 SHOULD-FIX, 3 NOTE. The two feature
halves do what their tests say; the defects are concurrency edges (a
navigation or a contact switch while a request is in flight) and one
comment-stated invariant that does not hold.

## Findings

### A-1 SHOULD-FIX - the Past batch guard, busy flag and refresh pointer do not survive a route change; the comments say they do

Where: dashboard/src/routes/tours/ToursPage.tsx:579-581 (page-owned
`bulkBusy` / `bulkBusyRef` / `pastReloadRef`), :383 (the guard), :417 (the
refresh), and the comments that claim more than that at :18-21, :285-288 and
:424-426.

Mechanism: the flag, guard and pointer live in the ToursPage INSTANCE. That
instance survives a tab switch only because AppFrame's `<Outlet />` is unkeyed
(dashboard/src/app/AppFrame.tsx:195) and /tours, /tours/past, /tours/closed are
sibling routes rendering the same component. Any navigation to /tours/:tourId
replaces it with TourDetail, and the Past rows keep their row link and their
"Record outcome" link ENABLED during a batch (ToursPage.tsx:220-225, :250-257),
so leaving mid-batch is a designed-in path. The runner closure keeps going; the
page that comes back (the tour page's back arrow honors state.back) is a new
instance with every control enabled and a null pointer.

Interleaving:
1. Staff selects 20 "Not marked" rows, presses "Mark toured (20)"; runner R1
   starts on page instance P1.
2. While R1 is on row 3, staff clicks "Record outcome" on a Needs-outcome row;
   P1 unmounts.
3. Staff presses the back arrow; P2 mounts: bulkBusy false, guard false,
   pointer null, fresh fetch (rows 1-3 toured, 4-20 still scheduled).
4. Staff presses select-all + "Mark toured (17)"; R2 starts at row 4 while R1
   is at row 4 or 5. Both GET the row (scheduled) and both PATCH it. The
   server answers the second with a same-status 200 when its legality read
   sees the first write; when that read is stale (tours.ts:1057 is an
   eventually consistent GetItem, toursRepo.ts:325-334) it takes the terminal
   branch again (tours.ts:1221-1227, :1424-1426): a second rotation and sweep
   and a second "Tour took place" milestone and audit pair. (The duplicate is
   NOT reproduced in the in-memory harness, which serializes two requests; I
   do not claim it as observed.)
5. R1 ends: `pastReloadRef.current` is P1's ref, nulled by the old view's
   cleanup, so P2 is not refreshed by R1, and R1's per-row failure lines
   ("Changed since the list loaded", "The update failed") land on the
   unmounted view and are never shown.

Proof (P1, passed = defect reproduced): per-row "Mark toured" on p1 with its
PATCH held; click the row link (enabled) to the stub tour page; click back to
/tours/past. The row button and "Select all not marked" were ENABLED while
R1's PATCH was still pending; clicking the row button again produced
patchTour calls ['p1', 'p1'] and getTour x2; releasing R1's PATCH did not call
the mounted view's reload; only R2's end did.

Smallest correct fix: hoist the three pieces out of the component into a
module-scoped store in ToursPage.tsx (a boolean + listeners read through
useSyncExternalStore for the disabled state, plus a module-level "mounted
Past view reload" slot the view registers/clears), so every ToursPage
instance in the tab sees the same batch. At minimum, correct the three
comments to say the guard holds across a TAB switch only, and name the
route-change gap.

### A-2 NOTE - the re-read -> PATCH window: what the server accepts, proven

Where: ToursPage.tsx:390-409 (GET then PATCH per id); app/src/routes/tours.ts:432-439
(GET /:tourId reads with toursRepo.get, no ConsistentRead), :1057 (the PATCH's
own legality read, also eventually consistent), :1073-1116 (the transition
guard), :1221-1235 (terminal rotation).

This residual is acknowledged in the runner comment (ToursPage.tsx:370-377),
so it is graded NOTE; the value here is the empirical confirmation and the
atomic fix.

Proof (P2, all passed): on makeWebhookHarness,
- canceled -> { status: 'toured' } is 200 and writes one tour_took_place;
- no_show -> { status: 'toured' } is 200 and writes one tour_took_place;
- a tour rebooked to 2026-08-02 (fresh ladder armed, pending rungs > 0) ->
  { status: 'toured' } is 200 and its pending rungs drop to 0 (the fresh
  ladder is swept).

Interleaving: the runner GETs p1 (scheduled) -> a colleague cancels p1 (200)
-> the runner PATCHes { status: 'toured' } -> the guard accepts from canceled
(or from a stale scheduled read) -> p1 reads Toured with a false "Tour took
place"; the colleague's cancel is silently overwritten. Because BOTH reads are
eventually consistent, the window is the GET-to-PATCH round trip PLUS
replication lag at two layers; the client re-read cannot close it and the
server cannot refuse it.

Smallest correct fix (if a bulk writer should be atomic): let PATCH
/api/tours/:id take an optional precondition (expected status and
scheduledAt) that toursRepo.patch turns into a ConditionExpression, 409
`tour_changed` on failure; the runner then sends ONE conditional PATCH per id
with the snapshot's values and maps 409 to "Changed since the list loaded",
dropping the GET. The repo already has CAS precedents (setLadderIdIf,
rosterVersion). Note the pre-existing single-tour TourDetail actions carry the
same class of window.

### A-3 SHOULD-FIX - an in-flight staff-notes save pins the NEXT contact's page on a permanent spinner

Where: dashboard/src/routes/contact/useContact.ts:47-49 (`setContact` commits
with the id captured at render time, unconditionally), :70 (`forId !==
contactId` -> derived loading); caller StaffNotesCard.tsx:84 via
ContactDetail.tsx:1080. Pre-existing hazard class (every setContact caller in
ContactDetail.tsx:613-781 has it); the card is a new, most-exposed caller: an
in-place editor whose Save users follow with a click, against the heaviest
contact endpoint (the PATCH handler awaits getById, a suggestion read per
field, the update, linked-thread lookups and applyTriage per thread, audit,
vocabulary - contacts.ts:1432-1866).

Mechanism: ContactDetail is re-rendered, not remounted, on a contact-to-contact
navigation (ContactDetail.tsx:257-260). Reachable in-page: RelationshipsCard
links (RelationshipsCard.tsx:40, rendered under TenantFile at
ContactDetail.tsx:1089), the timeline's "View contact" (Timeline.tsx:1670),
browser back/forward between two /contacts/:id entries.

Interleaving: Save on tenant A (PATCH in flight) -> click a relationship link
to B -> B's GET (one GetItem) lands first and B renders -> A's PATCH resolves
-> the card's closure calls A's setContact -> state becomes { contact: A,
forId: A } -> useContact derives 'loading' for B forever: nothing refetches B
(the effect keys on contactId, and the suggestion.updated refetch is guarded
on prev.forId === contactId).

Proof (P3, passed = defect reproduced): harness renders A, Save with the PATCH
held, rerender with B (B shown), resolve A's PATCH -> "page loading" appears
and is still there 200 ms later; getContact called exactly twice. Control: the
same harness with the fix below keeps B rendered (passed).

Smallest correct fix (one line, protects every caller): useContact.ts:48
becomes `setState((prev) => (prev.forId === contactId ? { status: 'ready',
contact, forId: contactId } : prev))`.

### A-4 SHOULD-FIX - "An unchanged draft is a no-op" compares against the LIVE prop, so an untouched Save can revert a colleague's note

Where: dashboard/src/routes/contact/StaffNotesCard.tsx:74-76 (compares `draft`
with the current `stored` prop), :64-68 (startEdit does not keep the baseline).

Mechanism: `stored` is re-derived from props every render, and the page swaps
the contact in the background while the editor is open: useContact.ts:57
refetches on `suggestion.updated` (any extraction run touching this contact,
e.g. an inbound text from the tenant).

Interleaving: staff A opens the editor on "X" -> staff B saves "Y" -> an
inbound text runs extraction, A's page refetches, the prop becomes "Y" -> A
changes nothing and presses Save -> "X" !== "Y" -> PATCH { staff_notes: 'X' }
-> B's note is silently reverted by a user who made no edit (worse than the
documented last-write-wins, which assumes the last writer edited).

Proof (P4, passed = defect reproduced): value "X", Edit, rerender with value
"Y", Save untouched -> updateContact('A', { staff_notes: 'X' }).

Smallest correct fix: capture the baseline in startEdit (a `baseline` state set
to `stored`) and compare `draft.trim() === baseline.trim()`. Optionally, when
`stored !== baseline` at Save time, say so instead of overwriting.

### A-5 NOTE - the Past view rides an unpaged range Query that truncates NEWEST-first

Where: app/src/repos/toursRepo.ts:347-364 (one QueryCommand, no
ExclusiveStartKey loop - contrast listByStatus at :366-385); GSI projection ALL
(app/src/lib/dynamoAdmin.ts:57); usePastTours sends one 90-day range
(dashboard/src/routes/tours/useTours.ts pastToursDateRange/usePastTours).

Mechanism: the byScheduledAt GSI sorts ascending, so a result over 1 MB keeps
the OLDEST rows and silently drops the most recent ones - the rows Past exists
to show - with no truncation signal (the route returns `{ tours }` only,
tours.ts:413-428). Past is the first caller whose window reaches back 90 days
over every status (closed and canceled included). An issue with the slug
`tours-scheduled-range-query-unpaginated` exists (filed on this branch; its
body was not read per the review instructions) - confirm it names the
direction of the cut.

### A-6 NOTE - what bounds staff_notes, and what the bound does to the user

Where: app/src/app.ts:136 (`express.json` with the default 100 kb limit - the
ONLY bound: no textarea maxLength at StaffNotesCard.tsx:127, no server cap in
the parser at contacts.ts:578-583); contacts.ts:1018-1020 (list responses
return whole items).

Mechanism: a body over ~100 kb gets a 413 from the parser; the card shows its
fixed "Could not save staff notes. Try again." (StaffNotesCard.tsx:33), and a
retry can never succeed - nothing tells the user the text is too long. Below
the bound the whole text rides on EVERY contact list response (useContacts
'all' / 'deleted' pages every contact - the Tours page loads both), a cost paid
by views that never render it. Rendering is safe: NotesText puts the text in a
React text node (Card.tsx:281-283). The 400 KB item cap is shared with the
AI-appended `notes` but is not realistically reachable. Fix if wanted: a
client maxLength plus a server length check with its own copy.

## Consumer / mutator sweep

- `staff_notes` / `staff_notes_updated_at` across app/ dashboard/ e2e/
  fake-twilio/ scripts/: only the diff's own files reference them.
- Contact serializers on the wire: GET /:id (contacts.ts:1125-1127), the list
  (:1018-1023), the POST 409 body (:1043, :1053), the suggestions route
  (suggestions.ts:45), the phones/emails routes (contacts.ts:2368, :2560) all
  send whole items -> authenticated staff only. public.ts returns
  `{ ok: true }` / flyer data, never a contact item. No exports exist.
- LLM paths: extraction only (adapters/extraction, jobs/extraction,
  services/extraction); toProfile names its fields (tested in the diff).
- Writers of contact items: every contactsRepo Put is a conditional create
  (attribute_not_exists, contactsRepo.ts:913-921, :986-994, :1188-1215); the
  import uses UpdateCommand with explicit fields (lib/import/apply.ts:1011-1013,
  :1360-1362); extraction apply and suggestion resolution write fixed field
  sets (apply.ts, suggestionResolution.ts:169-182). Nothing else can write,
  drop or backdate either key.
- No code enumerates contact keys generically (grep Object.entries/keys of a
  contact: none).
- Side effects a staff-notes-only PATCH now also runs (pre-existing for every
  PATCH, harmless): one GetItem for `sugg#<id>#staff_notes`
  (contacts.ts:1560-1569), a same-value participant_display_name SET and a
  conversation.updated emit per linked thread (contacts.ts:1779-1792;
  applyTriage, conversationsRepo.ts:1516-1560, touches no sort key), a
  contact_updated audit row with field NAMES only (contacts.ts:1817-1821; no
  dashboard renderer).
- Tours range endpoint callers: useTours (Active), usePastTours (Past),
  today.ts:550. Tour status writers: the PATCH route and the conversion
  finalize (placements.ts:771-775, sets closed). No background job writes
  tour status.
- react-router location state: read by TourDetail.backHref and
  ImageViewerProvider, which SPREADS the prior state on open and restores it
  on close (ui/imageViewer/history.ts:85-99, :112-126) -> `back` survives an
  image-viewer round trip. No other reader.
- ToursPage props: App.tsx:240-242 and ToursPage.test only. Only
  ToursPage.test mocks ./useTours.js (spread form, keeps pastState real). No
  test mocks StaffNotesCard, TenantFile or TourDetail. TenantFile has one
  render site (ContactDetail.tsx:1058).
- Hooks that could unmount the new UI on a refetch: useContactFile keeps
  committed state on refetch; useContacts / useListings fetch once per filter;
  useContact's background refetch has no status flip -> no spurious unmount
  of the editor or of the Past view.
- e2e name collisions (Playwright substring match): grepped getByLabel
  'Notes' / /notes/, button names 'Edit', '+ Add', /add/, non-exact 'Save' and
  'Cancel', heading 'Notes' / 'Tours', link 'Past', 'Mark toured', 'Record
  outcome'. Hits: contact-detail.spec Notes locators (fixed in the diff by
  scoping to the dialog - correct); its heading 'Notes' test is on the
  LANDLORD page (no card there); tours-page.spec heading 'Tours' runs on
  /tours (no Past DOM); relay-number-lifecycle 'Record outcome' is TourDetail's
  existing CTA. No other collision.
- e2e data coupling: tours-past.spec creates 3 past tours for
  contact-tenant-0001; no spec after it in run order touches that tenant's
  tours; tour-roster.spec mints its own data. The perf registry excludes
  '/tours/past' (e2e/performance/routes.test.ts).

## Checked and holding

- staff_notes_updated_at: the server stamp is the only writer
  (contacts.ts:1521-1523); a client value is never copied (parser
  contacts.ts:578-583); a stamp-only PATCH is 400. '' clears and is stored as
  '' by the real repo (contactsRepo.ts:1297 rejects '' only on index keys),
  matching the in-memory fake the tests use.
- Trimming: trimJsonBody (app.ts:142) trims every string, so the card's
  trimmed comparison mirrors what the server stores.
- AI isolation holds: toProfile and applyExtraction never carry the field
  (tested), and no other LLM input builds from the contact item.
- Tenants only: TenantFile gates on `contact.type === 'tenant'`; the card is
  read-only without a handler. (A landlord/partner/unknown can still carry an
  invisible value via the API - filed on this branch as
  staff-notes-on-landlord-partner-files.)
- Deep link: the dialog opens only from the state initializer on a toured tour
  with no outcome (TourDetail.tsx:266-268); TourDetailLoaded is keyed by
  tourId; the strip is a replace that carries location.state (:273), so
  reload, back and forward never reopen it and the back pointer survives. A
  link opened in a NEW TAB has no router state, so its back arrow goes to
  /tours - harmless and inherent to router state.
- backHref allowlist (TourDetail.tsx:103-110): router state cannot come from
  an external URL, and a foreign value falls back to /tours; `?outcome=1`
  from a crafted link only opens a dialog that submits nothing by itself.
- String compares on scheduledAt (selectPastTours, the runner's reschedule
  check) are sound: the server canonicalizes with toISOString at create and
  PATCH (tours.ts:330-341, :1152-1159).
- needsPlacement reads `convertible`, a STORED attribute returned identically
  by the list and single-tour reads (no derived-field divergence).
- The busy flag and guard DO hold across a tab switch (the unkeyed Outlet
  preserves the instance; P1 and the diff's own test) - A-1 is only the
  route-change case.
- State setters on an unmounted view are no-ops; the runner always resets
  the guard (no throw path between set and reset).
