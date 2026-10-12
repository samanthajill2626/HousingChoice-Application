# /join housing authority dropdown, Onboarding start, and lead backfill - design

Status: DRAFT (revision 2, 2026-10-12 - spec review round 1 folded in; see
`docs/superpowers/reviews/2026-10-12-join-housing-authority/design-review/adjudications.md`)
Branch: `feat/join-housing-authority` (worktree `W:\tmp\join-housing-authority`, cut from main @19607658)
Tracker: Improvements Tracker item #14 "Housing authority form default" (Before WP1, item 3)

## 1. Goal

Staff type the people they meet at housing fairs into the public `/join` form.
Those leads arrive with no housing authority and in status Needs review. A
property blast filtered on a housing authority therefore never reaches them,
and the matching rules decided for tracker #6 (not built yet) will send blasts
only to Onboarding and Searching tenants, which would leave them out again.

This change:

1. adds a "Housing authority" dropdown to `/join`, preselected to Atlanta
   Housing Authority, listing every housing authority on the organization list
   (tracker #2), plus a final "Not sure" that records none;
2. starts every NEW `/join` contact as Onboarding instead of Needs review;
3. adds a "Sign up another person" button to the `/join` thank-you screen that
   keeps the chosen authority;
4. ships a dry-run-first script that gives existing `/join` leads with no
   housing authority Atlanta Housing Authority.

The public flyer page (`/p/:unitId`) does not change (tracker #13 owns it).

## 2. Today (verified 2026-10-12 on main @19607658)

- `/join` (`dashboard/src/routes/public/HousingFairIntake.tsx`) and the flyer's
  sign-up box (`FlyerPage.tsx`) render the SAME form
  (`dashboard/src/routes/public/IntakeForm.tsx`: first name, last name, phone,
  optional voucher size, required texting-consent box) and post to the SAME
  endpoint, `POST /public/housing-fair` (`app/src/routes/public.ts:209`),
  through `submitHousingFair` (`dashboard/src/routes/public/publicApi.ts:86-96`),
  which builds the body field by field. The flyer adds a `unitId`; `/join`
  never sends one.
- `/join` is used by staff at fairs AND by the public: the flyer page's "no
  longer available" state links "See other homes" to `/join`
  (`FlyerPage.tsx:211-219`).
- A NEW phone creates a tenant contact with `status: 'needs_review'`
  (`public.ts:259`), no housing authority, and
  `capture_source: 'flyer'` when the `unitId` names a shareable, not-deleted
  unit, else `'housing_fair'` (`public.ts:268`). No other code path writes
  `capture_source: 'housing_fair'`. A flyer sign-up for a missing or
  unshareable unit stores nothing that tells it apart from a `/join` sign-up
  (no `unit_of_interest`, audit `viaFlyer: false`).
- A phone that is ALREADY a contact (deleted or not) gets no new contact and
  no change to its fields, except that a contact never fair-welcomed is sent
  the welcome text and gets `housing_fair_welcomed: true`
  (`public.ts:245-306`).
- Every JSON body is deep-trimmed before any route sees it (`trimJsonBody`,
  `app/src/app.ts:138-142`).
- The `/join` thank-you screen has no way back to the form; staff reload.
- One fixed-window per-IP limiter fronts every `/public` route
  (`app/src/app.ts:165-181`): `PUBLIC_RATE_LIMIT_MAX` default 5 per
  `PUBLIC_RATE_LIMIT_WINDOW_MS` default 60000. The e2e launcher raises it
  (`scripts/e2e-session.mjs:142`). `app/test/cloudfrontBehaviors.test.ts:136-148`
  requires every `app.use('/<prefix>'` in `app.ts` to be a classified prefix;
  `/public` already is.
- CloudFront's `/public/*` behavior allows every method with caching disabled
  (`infra/modules/cloudfront/main.tf:157-166`), so a new GET under `/public`
  needs no infrastructure change.
- Blast audiences have NO status filter today; the housing authority filter is
  optional (`app/src/services/audienceResolution.ts:116-176`,
  `AudienceFilter` in `app/src/repos/broadcastsRepo.ts:84-90`).
- The organization list is the `org-list` item in the `settings` table
  (`app/src/repos/orgListRepo.ts`): `get()` creates it from the starting list
  on an empty store, `peek()` reads without creating. Atlanta Housing
  Authority is on the starting list (`app/src/lib/orgStartingList.ts:17`). A
  stored `housingAuthority` is on the list exactly when it is
  character-for-character the name of a `housing_authority` entry
  (`isOnListFor`, `app/src/lib/orgNames.ts:72`). A Settings rename changes the
  list first and keeps the old name as a spelling (`app/src/services/orgRewrite.ts`).
- AI extraction writes a housing authority only into an EMPTY field; over a
  held value it can only suggest a change for staff to accept
  (`app/src/services/extraction/prompt.ts:37-39`).

## 3. Decisions

- **D1 Public list read.** `GET /public/housing-authorities` returns
  `200 { names: string[] }`: the exact stored `name` of every entry of kind
  `housing_authority`, sorted case-insensitively (English collation), no
  duplicates. No ids, spellings, notes, audit fields, or agencies. It reads
  the list with `orgListRepo.peek()` and, when no item is stored, uses the
  starting list in memory (`buildStartingEntries`); the public surface never
  writes the list item. Any read failure is the generic 500. The response
  carries `Cache-Control: no-store`.
- **D2 Its own limit and its mount.** The list read has its own fixed-window
  per-IP limit of 60 requests per 60 seconds, hard-coded (the `/unit-media`
  precedent, `app.ts:190-193`), so no new environment variable and nothing
  owed in the env files. Mechanism: a second router mounted with
  `app.use('/public', ...)` immediately BEFORE the existing `/public` mount,
  defining only `GET /housing-authorities` with the 60-per-minute limiter
  applied to that route alone. Every other request falls through to the
  existing mount and its shared 5-per-minute limiter, exactly as today; the
  list read never consumes or is blocked by that shared limit. No new path
  prefix, so the edge guard and CloudFront need no change.
- **D3 Sign-up field.** `POST /public/housing-fair` accepts an optional
  `housingAuthority`. Absent or `null` means none.
  - Shape (checked while parsing, with the other fields): it must be a string
    of 1 to 120 characters (ORG_NAME_MAX) after the existing body trim;
    otherwise the generic `400 { error: 'invalid request' }`.
  - List check (before any write, for a new and an existing phone alike):
    the POST reads the list (D1's source) ONLY when an authority is sent. The
    value must be character-for-character the name of a `housing_authority`
    entry; no case, spelling or agency resolution. Otherwise
    `400 { error: 'housing_authority_not_listed' }` - distinct so the form
    can recover (D8); the list is public, so the code reveals nothing. A
    list read failure is the generic 500, like any storage failure.
- **D4 Flyer refusal.** A request whose body carries a `unitId` (present and
  not null) AND a `housingAuthority` (present and not null) is refused with
  the generic 400, whatever the unit's state. Keying on the presence of
  `unitId` rather than on the unit keeps the endpoint from revealing whether a
  unit exists or is shareable.
- **D5 New /join contacts.** A NEW contact created by a request with NO
  `unitId`:
  - starts in status `onboarding`;
  - holds the given `housingAuthority`, if any;
  - carries `housing_fair_authority_asked: true` whether or not an authority
    was given - the marker that this person was asked the question, so the
    backfill (D10) never treats a "Not sure" answer as an old lead.
  A request WITH a `unitId` behaves exactly as today (status `needs_review`,
  no housing authority, no marker), including when the unit is missing or not
  shareable and the contact is stamped `housing_fair`. `capture_source`, the
  consent fields, and the welcome text are unchanged.
- **D6 Existing contacts.** A sign-up from a phone that is already a contact
  writes neither `housingAuthority`, `status`, nor the marker to it. Today's
  welcome rule for an existing contact is unchanged. A public,
  unauthenticated form must not edit an existing person's record.
- **D7 Audit and log.** The `housing_fair_signup` audit payload gains
  `housingAuthority`: the name written to a newly created contact, else
  `null` (an organization name, not PII). The `housing-fair signup captured`
  log line gains the boolean `withAuthority`. No new PII anywhere.
- **D8 The /join form.**
  - A "Housing authority" select, with the help text "The organization that
    runs your voucher.", placed after "Voucher size" and before the consent
    box. Options: every name from D1 in its order, then "Not sure".
  - Default: "Atlanta Housing Authority" when that exact name is in the list,
    else "Not sure".
  - While the list loads, the select is disabled and shows "Loading..." and
    the submit button is disabled, so a fast tap cannot drop the default.
    The read gives up after 10 seconds.
  - If the read fails or times out (any error, a 429 included), the select
    offers only "Not sure", a short note under it says the list could not be
    loaded, and the sign-up still works with no authority.
  - "Not sure" sends no `housingAuthority`; any other choice sends that exact
    name (`submitHousingFair` and `HousingFairInput` gain the field).
  - On `housing_authority_not_listed` (the list changed after the page loaded
    it), the form reads the list again, keeps every typed field and the
    consent box as they are, re-applies the default rule, and says: "The
    housing authority list was updated. Check the housing authority and send
    again."
  - On a 429 from the sign-up, the form says: "Too many sign-ups from this
    network in the last minute. Wait a minute, then send again." Every other
    failure keeps today's message.
  - The flyer page shows no select, never sends `housingAuthority`, and keeps
    its error messages exactly as today. `IntakeForm` renders the select and
    the new messages only when its parent supplies them.
- **D9 Sign up another person.** The `/join` thank-you screen keeps its
  heading and text and adds a "Sign up another person" button. It returns to
  an empty form - names, phone and voucher blank, the consent box unchecked
  (as on first load) - with the housing authority select still on the value
  chosen for the previous person, and moves focus to "First name". The list
  is not read again unless the last read failed, in which case it is read
  again and the default rule applies.
- **D10 Backfill script.** `app/scripts/backfill-join-housing-authority.ts`,
  following `app/scripts/clean-org-names.ts` and
  `app/scripts/lib/stageClient.ts`:
  - `--env local|dev|prod` (`--lane <L>` with local only), dry run by
    default, `--apply` to write, and `--skip <contactId>[,<contactId>...]` to
    leave named leads out. Unknown or repeated arguments are usage errors
    (exit 2, nothing run).
  - The list: the stored `org-list` item read with `peek()` (never created).
    The run refuses (exit 1, nothing written) when no item is stored, when
    "Atlanta Housing Authority" is not the exact name of a `housing_authority`
    entry on it, or - for `--apply` - while an organization-name rewrite is
    running by the system's own rule (`isOrgRewriteRunning`,
    `app/src/services/orgNames.ts`, which treats a lock with no heartbeat for
    15 minutes as free). It does not take the rewrite lock (see the last
    bullet).
  - Candidates: contacts in the base table (pointer rows skipped, as the
    cleanup script does) with `capture_source === 'housing_fair'`,
    `type === 'tenant'`, not deleted, no `housingAuthority` attribute, and no
    `housing_fair_authority_asked` marker.
  - Left out, and listed separately: a candidate named in `--skip`, and a
    candidate whose audit trail shows `housingAuthority` was ever written
    (a staff edit, an AI write, an accepted suggestion, a Settings or cleanup
    rewrite - the plan enumerates every audit event type that records such a
    write). Its authority was removed on purpose, so it stays empty. A
    `--skip` id that is not a candidate is reported and otherwise ignored.
  - Dry run: writes nothing. Prints each target on its own line - first and
    last name, sign-up date (`captured_at`, else `created_at`, as a date),
    current status, contactId - oldest first, then the count; then the
    left-out leads the same way with the reason. Names go to the operator's
    terminal as the report, never into structured log lines (a deliberate
    departure from the cleanup script's no-names rule, Cameron 2026-10-12).
    Nothing stored tells a flyer sign-up for an unavailable property apart
    from a `/join` lead; the names and dates are only a recognition aid.
  - Apply: for each target, one conditional write that sets
    `housingAuthority` to "Atlanta Housing Authority" only while the contact
    still has no authority, is still a tenant, and is still not deleted;
    plus one `housing_authority_backfill` audit event
    `{ field: 'housingAuthority', from: '', to: 'Atlanta Housing Authority' }`
    with no actor. A lost condition is counted as skipped, not failed. Status
    and every other field are left alone.
  - After an apply, the run reads the list again; if "Atlanta Housing
    Authority" is no longer an exact `housing_authority` name (renamed,
    merged away, deleted or re-kinded during the run), it prints a warning
    that the written records will show under Settings > Housing authorities &
    agencies > "Not on the list". That window - seconds at today's volume -
    is accepted instead of taking the rewrite lock, whose Settings copy names
    the one-time cleanup.
  - Safe to re-run at any time and in either order around the deploy: it
    never touches a contact holding an authority, the marker, or a history of
    one.
  - Exit codes: 0 completed clean; 1 refused, completed with failures, or the
    target could not be resolved; 2 usage.
  - No agent runs it against dev or prod. An agent rehearses it only with
    `--env local --lane <L>` on a hermetic lane it started.
- **D11 RUNBOOK.** A new entry: owed on dev and prod once this branch deploys
  there. Steps: dry run, read the target list (leave out anyone known not to
  hold an Atlanta voucher with `--skip`), apply, dev before prod. No
  Terraform, no secrets, no schema or index change.

## 4. Consequences to know

- Blasts have no status filter yet, so a lead's authority is what matters
  today: new `/join` leads with an authority, and backfilled leads, join
  blasts filtered on that authority at once.
- The Onboarding start pays off when tracker #6 adds the decided status rule.
  Backfilled leads keep their current status (mostly Needs review), so when #6
  ships they drop out of blasts until staff move them; #6 should account for
  them.
- `/join` leads are tenants on tenant threads: their replies go to Unreplied
  on Today before and after this change. What they lose is the Needs review
  status filter, which is where staff find unreviewed leads today.
- `/join` is also the public's page (the flyer's "See other homes"). A member
  of the public who signs up there and leaves the select alone is recorded as
  Atlanta Housing Authority and starts as Onboarding, with no staff review
  first.
- Because AI extraction only suggests over a held value, a wrong default (for
  example a DeKalb voucher holder left on Atlanta) is corrected by staff
  accepting the AI's suggestion, not automatically.
- An Onboarding tenant is eligible for the existing AI suggestion to move to
  Searching (`app/src/services/extraction/apply.ts:533-536`); a Needs review
  one was not.
- The texting-consent record for staff-entered sign-ups is unchanged
  (`web_form`); see `docs/issues/join-staff-entered-consent-method.md`.
- The 5-per-minute sign-up limit is unchanged (Cameron, 2026-10-12). Several
  staff on one venue network share it.

## 5. Out of scope

- The flyer page and its sign-up box (tracker #13).
- A soft-deleted person signing up again
  (`docs/issues/deleted-contact-web-signup-silent.md`).
- Raising or re-keying the shared `/public` limit.
- How staff-entered consent is recorded (the issue above).
- Showing the chosen authority on the thank-you screen.
- Changing an existing contact from a repeat sign-up.

## 6. Testing

- App (`app/test/publicIntake.test.ts` and a new script test beside
  `app/test/cleanOrgNames.test.ts`):
  - a `/join` sign-up with a listed authority creates an `onboarding` tenant
    holding it and the marker; with no authority, an `onboarding` tenant with
    the marker and no authority;
  - padded text is trimmed by the middleware and accepted when the trimmed
    value is a listed name;
  - an unlisted name, a spelling, a different case, and an agency name are
    each `housing_authority_not_listed` and write nothing; a non-string, an
    empty string, and an over-long string are the generic 400;
  - `unitId` plus an authority is the generic 400 for a shareable unit, a
    missing unit, and a non-shareable unit alike;
  - a flyer sign-up without an authority behaves exactly as today (no marker);
  - an existing phone with a valid authority changes no field the change
    adds or touches;
  - the list read returns housing authority names only, sorted, never writes
    the list item, and its limit is independent of the shared `/public`
    limit in both directions; the edge-guard test still passes;
  - the backfill: candidate selection (each condition, the marker included),
    the left-out audit-history rule for each enumerated event type, `--skip`,
    dry run writes nothing, apply writes only where every condition still
    holds with one audit event each, a contact that changed between read and
    write is skipped, each refusal (the stale-lock case included), the
    post-apply rename warning, a re-run writes nothing new.
- Dashboard: `/join` preselects Atlanta Housing Authority; "Not sure" sends no
  authority; loading, timeout and failed-list states; the
  `housing_authority_not_listed` recovery keeps the typed fields; the 429
  message; "Sign up another person" clears the person fields and the consent
  box, keeps the authority, and re-reads a failed list; the flyer form
  renders no select and keeps its messages.
- E2E (`e2e/tests/dashboard-next/public-pages.spec.ts`): on `/join`, the
  select shows Atlanta Housing Authority preselected; sign up two people in a
  row with "Sign up another person"; each new contact holds the authority and
  status Onboarding (read through the authenticated API).

## 7. Places the build must also update

- `dashboard/src/routes/public/publicApi.ts` (`HousingFairInput`,
  `submitHousingFair`, a list-read function).
- Statements that say a new sign-up is `needs_review`: the route header and
  the create comment in `app/src/routes/public.ts`,
  `e2e/scenarios/steps.ts` (the housing-fair step's description),
  `e2e/tests/scenarios/tenant-onboarding.spec.ts` (its note that the POST has
  no housing authority field), `documentation/STATUS-MODEL.md` (the Needs
  review section), and the existing assertion in
  `app/test/publicIntake.test.ts`.
- `e2e/performance/templates.ts`: declare the new GET if a measured page
  requests it (`/join` is classified `public` in `e2e/performance/routes.ts`).
- `RUNBOOK.md`: the D11 entry.
