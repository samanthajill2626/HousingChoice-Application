# /join housing authority dropdown, Onboarding start, and lead backfill - design

Status: DRAFT (revision 1, 2026-10-12)
Branch: `feat/join-housing-authority` (worktree `W:\tmp\join-housing-authority`, cut from main @19607658)
Tracker: Improvements Tracker item #14 "Housing authority form default" (Before WP1, item 3)

## 1. Goal

Sam meets tenants at housing fairs and staff type them in on the public `/join`
form. Those leads arrive with no housing authority and in status Needs review,
so property blasts (which filter on housing authority and go only to
Onboarding and Searching tenants, tracker #6) never reach them until someone
edits each record by hand.

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
  endpoint, `POST /public/housing-fair` (`app/src/routes/public.ts:209`). The
  flyer adds a `unitId`; `/join` never sends one.
- A NEW phone creates a tenant contact with `status: 'needs_review'`
  (`public.ts:259`), no housing authority, and
  `capture_source: 'flyer'` when the `unitId` names a shareable, not-deleted
  unit, else `'housing_fair'` (`public.ts:268`). No other code path writes
  `capture_source: 'housing_fair'`.
- A phone that is ALREADY a contact (deleted or not) changes nothing on that
  contact; the request only re-links the thread and skips a repeat welcome
  text (`public.ts:245-281`).
- The `/join` thank-you screen has no way back to the form; staff reload.
- One fixed-window per-IP limiter fronts every `/public` route
  (`app/src/app.ts:165`): `PUBLIC_RATE_LIMIT_MAX` default 5 per
  `PUBLIC_RATE_LIMIT_WINDOW_MS` default 60000. The e2e launcher raises it
  (`scripts/e2e-session.mjs:142`).
- CloudFront's `/public/*` behavior allows every method with caching disabled
  (`infra/modules/cloudfront/main.tf:157-166`), so a new GET under `/public`
  needs no infrastructure change.
- The organization list is the `org-list` item in the `settings` table
  (`app/src/repos/orgListRepo.ts`); `get()` creates it from the starting list
  on an empty store, `peek()` reads without creating. Atlanta Housing Authority
  is on the starting list (`app/src/lib/orgStartingList.ts:17`). A stored
  `housingAuthority` is on the list exactly when it is character-for-character
  the name of a `housing_authority` entry (`isOnListFor`,
  `app/src/lib/orgNames.ts:72`).

## 3. Decisions

- **D1 Public list read.** `GET /public/housing-authorities` returns
  `200 { names: string[] }`: the exact stored `name` of every entry of kind
  `housing_authority`, sorted case-insensitively (English collation), no
  duplicates. No ids, spellings, notes, audit fields, or agencies. It reads the
  list with `orgListRepo.get()` (the same read every other reader uses). Any
  read failure is the generic 500. The response carries
  `Cache-Control: no-store`.
- **D2 Its own limit.** The list read has its own fixed-window per-IP limit of
  60 requests per 60 seconds, hard-coded (the `/unit-media` precedent,
  `app.ts:190-193`), so no new environment variable and nothing owed in the
  env files. It is mounted so that the list read neither consumes nor is
  blocked by the shared 5-per-minute `/public` limit; every other `/public`
  route keeps that limit exactly as today.
- **D3 Sign-up field.** `POST /public/housing-fair` accepts an optional
  `housingAuthority`. Absent or `null` means none. Any other value must be a
  string of at most 120 characters (ORG_NAME_MAX) that is
  character-for-character the name of a `housing_authority` entry on the list
  at request time - no trimming, no spelling or case resolution. Anything else
  is refused with the existing generic `400 { error: 'invalid request' }`. The
  check runs before any write, for a new phone and an existing phone alike.
- **D4 Flyer refusal.** A request whose body carries a `unitId` (present and
  not null) AND a `housingAuthority` (present and not null) is refused with
  the same generic 400, whatever the unit's state. Keying on the presence of
  `unitId` rather than on the unit keeps the endpoint from revealing whether a
  unit exists or is shareable.
- **D5 Starting status.** A NEW contact created by a request with NO `unitId`
  starts in status `onboarding` and holds the given `housingAuthority`, if
  any. A request WITH a `unitId` behaves exactly as today (status
  `needs_review`, no housing authority), including the case where the unit is
  missing or not shareable and the contact is stamped `housing_fair`.
  `capture_source`, the consent fields, and the welcome text are unchanged.
- **D6 Existing contacts.** A sign-up from a phone that is already a contact
  writes neither `housingAuthority` nor `status` to it, as today. A public,
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
  - If the read fails (any error, a 429 included), the select offers only
    "Not sure", a short note under it says the list could not be loaded and
    to reload the page to try again, and the sign-up still works with no
    authority. A sign-up never blocks on this optional field.
  - "Not sure" sends no `housingAuthority`; any other choice sends that exact
    name.
  - The flyer page shows no select and never sends `housingAuthority`.
    `IntakeForm` renders the select only when its parent supplies it.
- **D9 Sign up another person.** The `/join` thank-you screen keeps its
  heading and text and adds a "Sign up another person" button. It returns to
  an empty form - names, phone and voucher blank, the consent box UNCHECKED
  (each person gives their own consent) - with the housing authority select
  still on the value chosen for the previous person, and moves focus to
  "First name". The list is not read again.
- **D10 Backfill script.** `app/scripts/backfill-join-housing-authority.ts`,
  following `app/scripts/clean-org-names.ts` and `scripts/lib/stageClient.ts`:
  - `--env local|dev|prod` (`--lane <L>` with local only), dry run by
    default, `--apply` to write, and `--skip <contactId>[,<contactId>...]` to
    leave named leads out (for flyer leads Cameron spots in the dry run).
    Unknown or repeated arguments are usage errors (exit 2, nothing run).
  - The list: the stored `org-list` item read with `peek()` (never created).
    The run refuses (exit 1, nothing written) when no item is stored, when
    "Atlanta Housing Authority" is not the exact name of a `housing_authority`
    entry on it, or - for `--apply` - while an organization-name rewrite is
    running (`lastRewrite.status === 'running'`).
  - Targets: contacts in the base table (pointer rows skipped, as the cleanup
    script does) with `capture_source === 'housing_fair'`,
    `type === 'tenant'`, not deleted, and no `housingAuthority` attribute,
    minus the `--skip` ids. A `--skip` id that is not a target is reported
    and otherwise ignored.
  - Dry run: writes nothing. Prints each target on its own line - first and
    last name, sign-up date (`captured_at`, else `created_at`, as a date),
    current status, contactId - oldest first, then the count. Names go to the
    operator's terminal as the report, never into structured log lines.
  - Apply: for each target, one conditional write that sets `housingAuthority`
    to "Atlanta Housing Authority" only while the contact still has none
    (`contactsRepo.rewriteOrgFields`), plus one `org_name_cleanup` audit event
    `{ field: 'housingAuthority', from: '', to: 'Atlanta Housing Authority' }`
    with no actor - the event the cleanup script writes. A lost condition is
    counted as skipped, not failed. Status and every other field are left
    alone.
  - After an apply, the run reads the list again; if "Atlanta Housing
    Authority" is no longer an exact `housing_authority` name (renamed
    meanwhile), it prints a warning that the written records will show under
    Settings > Housing authorities & agencies > "Not on the list".
  - Idempotent: a re-run finds no targets for the records it wrote.
  - Exit codes: 0 completed clean; 1 refused, completed with failures, or the
    target could not be resolved; 2 usage.
  - No agent runs it against dev or prod. An agent rehearses it only with
    `--env local --lane <L>` on a hermetic lane it started.
- **D11 RUNBOOK.** A new entry: owed on dev and prod after this branch
  deploys there. Steps: dry run, read the list for flyer leads (a lead whose
  sign-up came from a flyer for a property that was off the market), apply
  with `--skip` for those, dev before prod. No Terraform, no secrets, no
  schema or index change.

## 4. Consequences to know

- New `/join` leads with an authority are in blasts filtered on that
  authority from the moment they sign up (the point of the change).
- Today's "needs you now" group treats only `needs_review` contacts as
  untriaged (`app/src/routes/today.ts:167`). A new `/join` lead's reply to the
  welcome text therefore no longer appears there; it appears in the inbox like
  any tenant's reply. New `/join` leads also no longer appear under the Needs
  review status filter.
- An Onboarding tenant is eligible for the existing AI suggestion to move to
  Searching (`app/src/services/extraction/apply.ts:533-536`); a Needs review
  one was not.
- Backfilled leads keep their current status (mostly Needs review); staff
  move them as today.
- The 5-per-minute sign-up limit is unchanged (Cameron, 2026-10-12). Several
  staff on one venue network share it.

## 5. Out of scope

- The flyer page and its sign-up box (tracker #13).
- A soft-deleted person signing up again
  (`docs/issues/deleted-contact-web-signup-silent.md`).
- Raising or re-keying the shared `/public` limit.
- Showing the chosen authority on the thank-you screen.
- Changing an existing contact from a repeat sign-up.

## 6. Testing

- App (`app/test/publicIntake.test.ts` and a new script test beside
  `app/test/cleanOrgNames.test.ts`):
  - a `/join` sign-up with a listed authority creates an `onboarding` tenant
    holding it; with no authority, an `onboarding` tenant with none;
  - an unlisted name, a spelling, a different case, padded text, an agency
    name, a non-string, and an over-long string are each a generic 400 and
    write nothing;
  - `unitId` plus an authority is a 400 for a shareable unit, a missing unit,
    and a non-shareable unit alike;
  - a flyer sign-up without an authority behaves exactly as today;
  - an existing phone with a valid authority changes neither field;
  - the list read returns housing authority names only, sorted, and its limit
    is independent of the shared `/public` limit in both directions;
  - the backfill: target selection (each condition), `--skip`, dry run writes
    nothing, apply writes only absent authorities with one audit event each,
    a contact that gained an authority between read and write is skipped,
    each refusal, the post-apply rename warning, re-run is a no-op.
- Dashboard: `/join` preselects Atlanta Housing Authority; "Not sure" sends
  no authority; the loading and failed-list states; "Sign up another person"
  clears the person fields and the consent box and keeps the authority; the
  flyer form renders no select.
- E2E (`e2e/tests/dashboard-next/public-pages.spec.ts`): on `/join`, the
  select shows Atlanta Housing Authority preselected; sign up two people in a
  row with "Sign up another person"; each new contact holds the authority and
  status Onboarding (read through the authenticated API).
