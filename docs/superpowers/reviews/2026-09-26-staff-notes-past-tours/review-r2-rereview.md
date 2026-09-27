# Review R2 - fresh re-review - feat/staff-notes-past-tours

Date: 2026-09-27

Reviewer: independent round-2 re-reviewer (Claude Opus 5.5, 1M context). Not one
of the R1 reviewers, the builders or the fix-wave implementer.

## Scope

- Branch `feat/staff-notes-past-tours` at HEAD `359e82c8`, base main `0dafe3c1`.
- The whole feature, not only the delta: `.superpowers/review/feature-diff.txt`
  (base..c45e7159) and `.superpowers/review/fix-wave-1-diff.txt`
  (94f89929..359e82c8), both read in full, then every changed source re-read
  at HEAD.
- Records read: `review-r1-spec-conformance.md`, `review-r1-adversarial.md`,
  `review-r1-adjudications.md`, `fix-wave-1-report.md`; the spec's 3.6,
  4.2-4.8 and section 9 for intent; `AGENTS.md`.

## Method

- Consumer / mutator sweep of everything the diff touches: every `setContact`
  and `onContactUpdated` consumer; every render site of TenantFile,
  StaffNotesCard and useContact; every `updateContact` caller; every
  search-param writer and history-replacing navigation in the dashboard; every
  test file that renders ToursPage; the root ESLint config; the API client's
  timeout behavior and the CloudFront origin timeout; the dev-router mount gate.
- F-11 checked mechanically: each cited range was extracted at `0dafe3c1` and
  the refreshed range at HEAD, and the bytes compared.
- Unit run (foreground, single files): dashboard
  `src/routes/tours/ToursPage.test.tsx`, `src/routes/tours/useTours.test.ts`,
  `src/routes/contact/StaffNotesCard.test.tsx`,
  `src/routes/contact/TenantFile.test.tsx`,
  `src/routes/contact/useContact.test.tsx` - exit 0, "Test Files 5 passed (5)",
  "Tests 84 passed (84)", 0 "not wrapped in act" lines.
- Two throwaway layout probes in the plugin Playwright MCP browser: the shipped
  Past-row CSS with tokens resolved, injected into `about:blank`, rows measured
  at content-pane widths 361-1000px under (a) HEAD CSS, (b) the pre-wave CSS at
  `94f89929`, (c) a candidate fix. See "Probe disclosure".
- Nothing else was run: no `npm test`, smoke, lint, e2e, session or server; no
  port or `e2e/.artifacts` path touched; no source file modified; nothing
  committed.

## Verdict

NO BLOCKING defect. The fix wave's mechanisms hold, with one exception: F-2's
reserved-slot layout (OD-7) was verified at 1280px and 360px only, and in the
band between them it crushes the tenant name on every Past row (R2-1,
SHOULD-FIX). Four new NOTEs. Contested: X-1's premise, C-7's "superseded",
OD-7's scope, and A-2's "filed".

Counts (new findings): BLOCKING 0, SHOULD-FIX 1, NOTE 4.

Fix wave: 9 correct (F-1, F-3, F-4, F-5, F-6, F-7, F-8, F-10, F-11),
2 plausible-but (F-2, F-9), 0 wrong.

## New findings

### R2-1 - SHOULD-FIX - Past rows crush the tenant name to 1-6 characters in 561-760px panes; F-2 spread it to every row

Where:

- `dashboard/src/routes/tours/ToursPage.module.css:273-278` - `.lead` is a
  fixed 1.1rem slot on EVERY row.
- `:290-296` - `.rowActions` is a fixed 8.5rem slot on EVERY row.
- `:267-270` - the card (link) takes what is left.
- `ToursPage.tsx:218-229` and `:245-268` render both slots on every row.
- The only stacking rules are keyed to the PAGE container at 560px: `:200-220`
  (identity over meta inside the card) and `:374-385` (row wrap).

Mechanism:

- A Past card is always about 170px narrower than the pane: 17.6px lead,
  136px action slot, two 8px gaps.
- The card's identity-over-meta stacking is keyed to the PANE at 560px. That
  threshold was sized for the Active row, whose card is the full pane width.
- Above 560px the Past card stays side by side:
  - `.meta` (date-time plus state chip, about 253px) is `flex: 0 0 auto`;
  - the identity block gets the remainder;
  - `.tenant` and `.property` shrink with an ellipsis.
- Before the wave only rows with an action paid part of this. A No show or
  Needs placement card was the full pane width. F-2 makes every row pay the
  full 170px.

Proof (probe, Chromium, system-ui = Segoe UI):

- Tenant "Tasha Nguyen" needs 95px. The property "1450 Joseph E. Boone Blvd
  NW, Atlanta, GA, 30314" needs 290px.
- Cells are the tenant box's visible width in px ("full" = not truncated).
- Row order within a cell: Not marked / Needs outcome / No show / Needs
  placement.

| pane px | HEAD | pre-wave (94f89929) | Active row |
|---|---|---|---|
| 561 | 27 / 22 / 31 / 19 | 36 / 38 / 73 / 61 | 69 |
| 600 | 36 / 31 / 41 / 29 | 45 / 47 / 82 / 71 | 78 |
| 672 | 54 / 49 / 58 / 47 | 63 / 65 / full / 89 | full |
| 736 | 70 / 65 / 74 / 63 | 79 / 81 / full / full | full |
| 800 | 86 / 81 / 90 / 78 | full / full / full / full | full |
| 1000 | full x4 | full x4 | full |

- Measured in the same font, the visible text at each width is:
  - "T..." 19px, "Ta..." 27px, "Tas..." 33px;
  - "Tash..." 42px, "Tasha..." 50px, "Tasha N..." 66px.
- So every Past row reads "T..." to "Tas..." at 561-600px, and "Tash..." or
  "Tasha..." at 672px.
- The property is cut to 59-190px across the same band.
- No overflow anywhere, so neither e2e overflow check can see this.

Where the band is:

- The pane is the viewport minus 288px with the default expanded sidebar
  (`--nav-width: 240px`, `dashboard/src/ui/tokens.css:145`, plus
  `AppFrame.module.css:386` padding 24px x2). That puts windows of about
  849-1048px in the band: a 960px half-screen window gives a 672px pane, a
  1024px window a 736px pane.
- Below the 768px breakpoint the pane is the viewport minus 48px, so about
  609-767px windows (tablets in portrait, phones in landscape).
- The wave's self-QA measured 1280px and 360px, both outside the band.

Smallest correct fix:

- Copy the four 560px stacking declarations for `.row`, `.main`, `.property`
  and `.meta` (`ToursPage.module.css:200-220`) into a Past-only
  `@container (max-width: 760px)` block.
- Scope the selectors to `.pastRow > .row` and its descendants. Leave the lead
  and action slots beside the card.
- Probe with that block:
  - every row shows the full name and address at 561-760px;
  - no overflow;
  - the checkbox stays inside its card's vertical span (the F-1 pin still
    holds);
  - above 760px the side-by-side tenant box is 69-86px - the same truncation
    an Active row already has just above 560px (69px).
- Pin it in `tours-past.spec.ts` at a viewport inside the band (for example
  960px wide): on every Past row the tenant text is not truncated
  (scrollWidth <= clientWidth).

### R2-2 - NOTE - A-2's "RECORD + FILE" was recorded but never filed

Where: `review-r1-adjudications.md:31` says the conditional-PATCH design "is
filed as `tours-patch-status-precondition`". `:105` lists it as "issue to file".

Evidence:

- There is no `docs/issues/tours-patch-status-precondition.md` at HEAD.
- The slug occurs only in the adjudications record.
- `git log --all -S` finds only the records commit `94f89929`.

Why it matters: the adversarial's P2 facts exist only in a review record:

- canceled -> toured and no_show -> toured each return 200 and write a "Tour
  took place" milestone;
- a rebooked tour's fresh ladder is swept.

The same holds for the ConditionExpression design. A handback that cites the
issue would point outside the registry.

Smallest fix: before handback, file it from `docs/issues/_TEMPLATE.md`
(improvement, low), carrying `review-r1-adversarial.md:89-122`.

### R2-3 - NOTE - X-1 cannot happen on the shipping page; the comment F-9 added states a false mechanism

Where:

- `dashboard/src/routes/contact/TenantFile.tsx:266-272` says "the file pane
  re-renders (never remounts) on a contact-to-contact navigation".
- The same claim appears in `TenantFile.test.tsx:25-26` and `:90`.

Mechanism:

- On the first render after /contacts/A -> /contacts/B, `useContact` derives
  'loading' (`useContact.ts:74-76`, forId A !== B).
- ContactDetail then returns its spinner early (`ContactDetail.tsx:530-536`).
  That unmounts the whole body, TenantFile and StaffNotesCard included.
- Every other `setContact` caller passes a contact returned for the SAME
  contactId: `ContactDetail.tsx:618, 633, 645, 706, 742, 776, 1102, 1115` and
  `ContactCommsPane.tsx:312-315`. So `contact.contactId` never changes under a
  mounted TenantFile. TenantFile has one render site (`ContactDetail.tsx:1058`).
- The fix-wave report says the same: "The real page also unmounts the file
  pane while useContact derives loading".
- A-3 was real because the HOOK's setter outlives the card. X-1 needed the
  CARD to outlive its contact, and it does not.

Effect: none at runtime; the key is harmless and defensive. The cost is a
comment and a test that teach a wrong model of ContactDetail, which the next
reader will act on.

Smallest fix: reword the three comments. The key is defensive: ContactDetail
unmounts the pane while useContact derives loading, so the key matters only if
a future caller swaps the contact in place.

### R2-4 - NOTE - the module flag has one release point; a stuck batch now disables Past tab-wide, silently

Where: `ToursPage.tsx:429` sets the flag. `:459` is the only clear. The loop is
`:433-451`.

Mechanism: `setBatchRunning(false)` runs only when the loop finishes.

- (a) A GET or PATCH that never settles. The client adds no timeout
  (`dashboard/src/api/client.ts:98-113` forwards only a caller signal).
  - In hosted envs CloudFront's `origin_read_timeout = 30`
    (`infra/modules/cloudfront/main.tf:114`) turns a hang into a 504 and "The
    update failed" within about 30s, so the pin is bounded there.
  - On a local stack or a stalled connection it is unbounded.
- (b) Any throw outside the two try blocks. The read of `current.status` at
  `:441` on a malformed getTour result rejects the voided promise and never
  clears the flag. (Not reachable with the current API contract.)

Before F-7, either case pinned one page instance, and a route change cleared
it. Now it pins every Past view in the tab until a full reload. A remounted
view shows every mark control disabled, with no line saying a batch is still
running.

Not observed. This is the implementer's own "least sure" item, checked and
bounded above.

Smallest fix:

- Wrap the loop and its tail in try/finally so the flag always clears.
- Optionally, show a muted status line while `bulkBusy` is true in a view
  that did not start the batch.

### R2-5 - NOTE (pre-existing class) - a background refetch that started before a Staff notes save can land after it

Where: the `suggestion.updated` refetch at `useContact.ts:60-71` commits
whatever it read, whenever it resolves. It is not sequenced against
`setContact` (`:51-53`).

Interleaving:

1. Staff press Save; the PATCH is in flight.
2. An extraction run for this tenant completes and emits `suggestion.updated`.
3. The refetch GET is served from the pre-write item.
4. The PATCH resolves, and the card shows the new note.
5. The GET resolves and commits the old item. The card shows the OLD note and
   the old "Last edited" date, although the save succeeded.

Not data loss: the server holds the new text, and the next load shows it. The
same race exists for every in-place `setContact` caller; the card is the newest
writer.

Fix if wanted (its own change): a monotonic write token in useContact, so that
a background refetch whose request began before the latest `setContact` is
dropped.

## Fix-wave cold review, per F-id

- F-7 (A-1, C-7(i)): CORRECT.
  - Wiring:
    - the flag is read through `useSyncExternalStore` (`ToursPage.tsx:348`);
    - it is written only on the runner's path (`:429`, `:459`) and by the
      test reset;
    - the guard reads the module boolean (`:425`);
    - the slot is registered in an effect whose cleanup checks identity
      (`:354-359`). That survives StrictMode's mount/unmount/mount
      (`dashboard/src/main.tsx:15`) and a remount, whose passive cleanup runs
      before the new mount.
  - Traced paths: a tab switch; a route change and back; a remount whose first
    load is still idle when the batch ends (the reload's epoch bump aborts it
    and refetches); a remount whose first load failed (the reload recovers
    it); leaving /tours entirely (null slot, no-op).
  - Test isolation holds:
    - Vitest isolates modules per file, and only `ToursPage.test.tsx` renders
      ToursPage.
    - `beforeEach` resets the store (`:299`).
    - No test leaves a resolvable promise behind.
  - The route-change test is red on the page-owned code (implementer's RED).
    It proves the disabled controls and that the refresh reaches the mounted
    view.
  - The guard itself sits behind disabled controls. A click cannot land
    between `setBatchRunning(true)` and the synchronous re-render, so it is
    belt-and-braces.
  - Residual: R2-4. C-7(ii) is not addressed, and F-7 does not claim it (see
    the contested adjudications).
- F-1 (C-1): CORRECT.
  - The zero basis lets line 1 hold the lead slot and the card at <= 560px.
  - The pin at `e2e/tests/dashboard-next/tours-past.spec.ts:138-146` cannot
    pass vacuously: a null box fails its not-null expect. It was shown red
    with the CSS reverted.
  - The probe puts the checkbox inside the card's span at 361px.
- F-2 (C-9, OD-7): PLAUSIBLE-BUT.
  - Right at the two widths it was checked at:
    - at 1280px, one left and one right card edge;
    - at 360px, the empty action slot collapses through `:empty`, with no
      blank line.
  - Wrong for 561-760px panes (R2-1).
  - The `:empty` rule depends on the JSX emitting no whitespace nodes; that is
    true today and disclosed.
- F-3 (C-2a): CORRECT.
  - Both ids re-read as scheduled at the same time.
  - With PATCH 1 held and a 50ms settle: one PATCH and one GET.
  - The order is ['p1', 'p4'], and the `void patchTour` control went red.
- F-4 (C-2b): CORRECT.
  - The failed reload follows a real batch.
  - Both result lines survive, with exactly one refresh alert.
  - Document order is asserted.
- F-5 (C-3): CORRECT.
  - `renderAt('')` passes `state: undefined` (`TourDetail.test.tsx:1824-1826`),
    so the no-state case really is exercised.
  - `/tours/closed` is honored.
- F-6 (C-4): CORRECT.
  - The tab order is checked by textContent.
  - The Record-outcome name is checked exactly, by role name and by
    aria-label.
  - Indeterminate is set through a callback ref that re-runs on every commit;
    its control went red.
  - The card's in-flight state has a red control too.
- F-8 (A-3): CORRECT.
  - The guard blocks only a setter whose bound id differs from the committed
    `forId`. A setter bound to the on-screen id always applies (the second
    test pins that).
  - Every consumer passes a contact returned for the same contactId (sweep in
    R2-3).
  - The only window where a current-id setter meets another `forId` is a
    navigation's loading window, and the incoming GET supersedes it anyway.
  - A -> B -> A with A's PATCH resolving late: a no-op while B is committed;
    it applies once A's GET has committed. Correct both ways.
- F-9 (X-1): PLAUSIBLE-BUT. Harmless, but it answers a mechanism the page
  cannot produce (R2-3).
- F-10 (A-4): CORRECT.
  - `baseline` is set only in `startEdit` (`StaffNotesCard.tsx:65-70`):
    - Cancel leaves it stale, and the next Edit resets it.
    - A failed save keeps it, so a retry that reverts the draft is a no-op.
    - A prop move mid-edit leaves both draft and baseline at the opening
      text.
  - So an untouched Save sends nothing and read mode shows the newer value.
    An edited Save is last-write-wins (spec 3.6, Q12).
  - Both new tests discriminate (RED shown).
- F-11 (C-6): CORRECT.
  - All six range rewrites are byte-identical to their base ranges:
    `useTours.ts` 37-123/46-132, 37-72/46-81, 37-42/46-51, 112-141/121-150;
    `ToursPage.tsx` 181-185/618-622, 181-198/618-635.
  - `ToursPage.tsx:695` and `:793` are the same anchors: the h1 and the Closed
    list.
  - `TourDetail.tsx:630` is the "Back to tours" link, which is what
    `TOUR_DETAIL_TERMINAL` locates (`e2e/performance/routes.ts:471`).
  - `618-622` faithfully inherits the base range's omission of
    `useListings(true)` (`:623`).
  - Two older stale citations remain, as the implementer disclosed:
    `routes.ts:126`/`:765` (App.tsx) and `:757` (TenantFile.tsx:152).

## Contested adjudications

- X-1: CONTESTED. The premise is false on the shipping page (R2-3). Keep the
  key; correct the comments.
- C-7 "superseded by A-1": CONTESTED for part (ii).
  - F-7 moved the flag and the reload slot, not the results.
  - A batch that straddles a view or route change still writes its results
    into the unmounted instance (`ToursPage.tsx:452-457`). Its failure lines,
    and its above-toolbar lines for rows the reload drops, are never shown.
  - That matches spec 4.5 ("until the next batch, a view change or a
    navigation away"), so it is a NOTE, not a defect.
  - The record should say "(ii) accepted as specified", not "superseded".
  - With the module slot in place, routing the final results to the mounted
    view is now a few lines, if wanted.
- OD-7: CONTESTED for scope (R2-1). It was adopted on two measured widths; the
  reserved slots need a matching stacking threshold.
- A-2: RECORD conceded (spec Q14); the FILE half is not done (R2-2).
- C-5: conceded. Per-block roles are equivalent for assistive technology, and
  the plan prescribed them.
- C-8 / OD-5: conceded as repo-wide house style.
  - The branch adds two more specs whose `beforeAll` reseed would reach a live
    :5174 stack wherever the dev router is mounted
    (`app/src/lib/devRoutes.ts:19`).
- A-5: conceded. `docs/issues/tours-scheduled-range-query-unpaginated.md:3`
  and `:16` name the newest-first cut.
- A-6: conceded. Spec Q1 has no cap, and the handback names the 413 behavior.
- O-3: conceded. The RemindersPanel copy is pre-existing.
- OD-1 to OD-4, OD-6: not contested; R1's judgments hold.

## Checked and holding

- The ?outcome=1 deep link:
  - the dialog opens only from the state initializer
    (`TourDetail.tsx:266-268`);
  - the strip is a replace that carries `location.state` (`:273`), guarded by
    `wantsOutcome` (`:270`);
  - the mobile pane toggle is local state (`:241`), not the URL.
  - Dashboard-wide, the only other search-param writers
    (`ContactsList.tsx:214`, `FlyerPage.tsx:147`, `AiRunsSection.tsx:29`) are
    outside the tour page. The image viewer spreads prior state.
- The back arrow's allowlist is an exact Set (`TourDetail.tsx:103-110`).
- usePastTours:
  - reload is an epoch bump whose effect cleanup aborts the previous request
    (`useTours.ts:244-275`), so reloads cannot land out of order;
  - a failed reload keeps the rows (`:268-270`).
- Past window and selection (`useTours.ts:178-209`):
  - calendar arithmetic;
  - ISO string compares against server-canonical `scheduledAt`;
  - today's scheduled rows dropped, decided rows dropped unless Needs
    placement;
  - `outcome` absence is `undefined` everywhere (no null writer in app/src).
- The runner:
  - list order (`selected` is built in `notMarkedIds` order);
  - re-read, then PATCH;
  - a status-only body;
  - reload, then clear busy (spec 4.5 step 4).
- The refresh alert and both vanished blocks precede the toolbar
  (`ToursPage.tsx:482-513`).
- Staff notes server path:
  - string-only parse (`app/src/routes/contacts.ts:574-583`) and the server
    stamp (`:1521-1523`);
  - the audit carries field names only;
  - no other writer: ContactEditForm builds a field diff
    (`ContactEditForm.tsx:233-347`), and no `updateContact` caller spreads a
    contact.
  - No LLM path serializes a whole contact (adapters, services and jobs
    grepped).
- One render site each for TenantFile (`ContactDetail.tsx:1058`),
  StaffNotesCard (`TenantFile.tsx:260`) and useContact
  (`ContactDetail.tsx:253`).
- Lint:
  - the root config registers no react-refresh rule
    (`eslint.config.mjs:48-52`), so the test-only export trips nothing there;
  - react-hooks v7 recommended-latest still applies to the effect's module
    write. Not run here; gate 5 owns it.
- The production bundle drops the unused test export (App imports only
  ToursPage).
- e2e:
  - one worker, `fullyParallel: false` (`e2e/playwright.config.ts:140-141`);
  - both new specs reseed in `beforeAll`;
  - `contact-detail.spec.ts`'s two Notes locators are dialog-scoped, and its
    `:126` heading check runs on the landlord page.
- The perf route pin excludes `/tours/past` (`e2e/performance/routes.test.ts`),
  and the Active and Closed views never call usePastTours.

## Probe disclosure

- Two about:blank probes in the plugin Playwright MCP browser (the markup and
  CSS were injected and measured with evaluate); the browser was closed after
  each.
- Each navigate wrote one 0-byte snapshot into the MAIN checkout's gitignored
  `.playwright-mcp/`:
  - `page-2026-09-27T09-39-14-485Z.yml`
  - `page-2026-09-27T09-44-28-964Z.yml`
- Both were removed. The directory listing is back to its pre-probe count
  (2483 entries), and `git status` in the main checkout is clean.
- No probe file was written in the worktree; `git status` there is clean apart
  from this record.
