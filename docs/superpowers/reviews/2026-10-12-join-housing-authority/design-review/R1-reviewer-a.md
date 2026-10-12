# R1 adversarial design review (reviewer A) - /join housing authority dropdown

Spec: `docs/superpowers/specs/2026-10-12-join-housing-authority-design.md`
(revision 1, DRAFT). Repository read at `feat/join-housing-authority`
@d33dc1e6 (main @19607658 plus the spec commit). Read-only review: no tests,
scripts, or network were run. Every claim about current behavior cites the
file:line actually read; anything not verifiable in the repo is marked
UNVERIFIED.

Verified as stated in spec section 2: public.ts:259 (`needs_review`),
public.ts:268 (`capture_source`), public.ts:245-281 (existing-phone path,
with the caveat in F12), app.ts:165 limiter, config.ts:1008-1019 defaults
(5 / 60000), scripts/e2e-session.mjs:142, cloudfront main.tf:157-168,
orgStartingList.ts:17, orgNames.ts:72, app.ts:190-193, apply.ts:533-536.
No seed or other app path writes `capture_source: 'housing_fair'` (grep of
app/src, app/scripts, e2e, dashboard: only public.ts:268).

---

## F1 [HIGH] D8's "a sign-up never blocks on this optional field" is not delivered by the mechanism

What is wrong. D8 promises the optional authority can never block a sign-up.
Three mechanisms in the same spec make it block:

1. Stale list, permanent 400. D3 accepts only a name that is
   character-for-character on the list "at request time", with no spelling
   resolution, and refuses anything else with the generic 400. D9 says the
   list "is not read again" for the whole Sign-up-another-person session.
   A Settings rename changes the list FIRST and rewrites records afterwards
   (services/orgRewrite.ts:5-12; rename at orgRewrite.ts:374-405). So once
   staff rename, merge, delete, or re-kind the chosen entry (for example
   "Atlanta Housing Authority" renamed during a fair day), every tablet still
   holding the old list posts a name that is no longer exact, gets the
   generic 400, and IntakeForm shows "Sorry, we couldn't send that. Please
   try again." (dashboard/src/routes/public/IntakeForm.tsx:100-103). Retrying
   sends the same stale value, so it fails forever until someone reloads -
   which nothing tells them to do, because the 400 is deliberately generic
   (public.ts:211-219). Each failed retry also burns one of the 5-per-minute
   shared POST slots. Note the rename KEEPS the old name as a spelling
   (orgRewrite.ts:390-399), so the authenticated write rule
   (`checkScalarWrite`, lib/orgNames.ts:275-289, which maps a unique spelling
   or a case variant to the entry's exact name) would have accepted it; D3
   chose the strict rule and pays this cost.
2. POST-time list read failure is unspecified. D1 says a failed list read on
   the GET is a 500. D3 adds a list read to the POST but never says what a
   read failure does there. The natural build (let it throw) turns a
   DynamoDB blip on an optional field into a failed sign-up.
3. Unbounded loading state. D8 disables the submit button while the list
   loads. The shared `request()` client has no timeout
   (dashboard/src/api/client.ts:103-122 - only an optional caller signal). A
   GET that stalls on venue Wi-Fi leaves the submit button disabled
   indefinitely.

What it implies. The guarantee the spec leads its UI section with is false
under the spec's own mechanism, in exactly the long-lived-page scenario D9
creates. The spec must pick a rule that degrades instead of refusing: for
example resolve via spellings as the authenticated path does, or degrade an
unlisted/unreadable authority to "none" and still create the contact (with
the log/audit recording that it was dropped), plus a client-side load timeout
that falls into the D8 failed state.

## F2 [HIGH] D3 "no trimming" and the "padded text is a 400" test contradict the global JSON trim

What is wrong. D3 says the value must match "no trimming", and section 6
requires a test that padded text is a generic 400. The app deep-trims EVERY
string value of EVERY JSON body before any route runs: `app.use(trimJsonBody())`
at app/src/app.ts:142, implemented in app/src/middleware/trimStrings.ts
(`deepTrimStrings`, founder decision 2026-07-14, "new routes and new fields
inherit the guarantee automatically"). A POST with
`housingAuthority: "  Atlanta Housing Authority  "` reaches the handler
already trimmed, matches exactly, and is ACCEPTED.

What it implies. The specified test cannot pass against the real app. A
builder following the spec either ships a red test, or "fixes" it by reading
`req.rawBody` or exempting this field from the trim seam - a regression of a
deliberate global guarantee to satisfy a line that misdescribes current
behavior. The spec should say the value arrives trimmed (as every public
field does) and drop the padded-text case, or state explicitly that it
overrides the trim seam and why.

## F3 [HIGH] The motivating premise misdescribes blasts: there is no status filter, and the backfill contradicts the premise

What is wrong. Section 1 says property blasts "filter on housing authority
and go only to Onboarding and Searching tenants, tracker #6" and that /join
leads therefore "never reach" blasts. In the code:

- Filter-resolved audiences have NO status filter at all. `AudienceFilter`
  is `{ contact_type, housing_authority?, bedroomSize?, excludeOptedOut,
  excludeUnreachable }` (app/src/repos/broadcastsRepo.ts:84-90).
  `createAudienceResolutionService` keeps every `type === 'tenant'` row
  whatever its status - needs_review, placed, inactive included
  (app/src/services/audienceResolution.ts:113-178; the only per-row gates
  are type, opt-out, unreachable, phone, bedroom size, lines 149-158).
  The dashboard composer has no status control either
  (dashboard/src/routes/broadcasts/AudienceFilters.tsx: no status field).
- The housing authority filter is optional (audienceResolution.ts:117-118);
  an unfiltered blast ALREADY reaches every Needs-review /join lead today.
- Tracker #6 is not built. The tour auto-close spec calls it "improvement
  #6 (built later)" (docs/superpowers/specs/2026-10-01-tour-auto-close-reopen-design.md:23)
  and the clean-org-names spec defers "Audience rules ... to tracker #6"
  (2026-10-06-clean-org-names-and-caseworkers-design.md:214-216).

So D5's status change has no blast effect today, and section 2 ("Today,
verified") does not mention this. Worse, the spec contradicts itself:
section 4 says backfilled leads "keep their current status (mostly Needs
review)". Under the status gate section 1 asserts, those backfilled leads
would STILL never reach a blast, so D10 achieves nothing; under the code as
it actually is, D10 puts every backfilled lead (any status, including stale
and inactive ones) into Atlanta-filtered blasts the moment it runs.

What it implies. The human signs off on D5 (removing the Needs-review step
for every /join lead) and D10 on a false account of what each does. The spec
must state the real current audience rule, say what D5 buys today (only
extraction eligibility, the contacts-list filter, and the badge - see F6),
and say which of the two worlds D10 is designed for. If #6 will gate on
Onboarding/Searching, D10 must either move status too or admit it is inert
for blasts until staff move each lead.

## F4 [HIGH] The backfill target overwrites explicit "Not sure" answers and human clears

What is wrong. D8 makes "Not sure" an explicit answer that is stored as the
ABSENCE of `housingAuthority`. D10 targets exactly "no housingAuthority
attribute" on `housing_fair` tenants, with no date cutoff, and D11 schedules
the run "after this branch deploys". So every /join sign-up between the
deploy and the backfill run whose person chose "Not sure" is stamped Atlanta
Housing Authority anyway - and any later re-run (the spec calls it
idempotent, which only covers records it wrote) sweeps up every future "Not
sure" lead too.

Absence is also how a HUMAN clear is stored: a contact PATCH clear REMOVEs
the attribute (contactsRepo.ts:522 comment; rewriteOrgFields null -> REMOVE,
contactsRepo.ts:1862-1870), and the Settings rewrite has a `clear` action
(OrgRewriteAction, orgListRepo.ts:36-38) that does the same. A /join lead
whose wrong authority staff deliberately cleared is re-targeted and
re-stamped.

What it implies. The backfill writes a guess over an explicit answer and over
a human decision, and the result immediately drives blasts (F3). The target
needs a discriminator: `captured_at` (else `created_at`) before the deploy
instant passed as an argument, and/or exclusion of contacts with any
housingAuthority-touching audit event (contact update / `org_name_rewrite` /
`org_name_cleanup`), and/or keying on the D7 audit payload (a
`housing_fair_signup` event that carries a `housingAuthority` key was asked
the new question).

## F5 [HIGH] /join is also the public self-serve fallback, not only a staff tool

What is wrong. The spec's premise (section 1) is "staff type them in on the
public /join form", and the Atlanta default and the Onboarding start are
justified by that. But /join is also where the PUBLIC lands: the flyer's
"no longer available" state links "See other homes" to `/join`
(dashboard/src/routes/public/FlyerPage.tsx:213-219; pinned by
e2e/tests/dashboard-next/public-pages.spec.ts:368). A person who is not
already a contact (a forwarded or publicly posted flyer) signs up there
themselves, with Atlanta Housing Authority preselected. Anyone who does not
touch the select is recorded as Atlanta, enters Atlanta-filtered blasts, and
drops out of the blasts for their real authority. Existing contacts are
unaffected (D6), so the size of this population is UNVERIFIED from the repo.

D5 compounds it: the needs_review start was a recorded review decision so
that "the team confirms before treating them as fully active"
(public.ts:252-256). The spec removes that gate for every /join sign-up,
including unattended public ones and abuse traffic on an unauthenticated
endpoint, without acknowledging that it is reversing a decision. The values
also carry no provenance: `housingAuthority_source` exists to mark machine
values (contactsRepo.ts:901-904; suggestionResolution.ts:336), but neither a
form default nor the backfill stamps anything, so staff cannot tell an
untouched default from a confirmed authority.

What it implies. The default and the status change need a scope that matches
who actually uses the page (for example: default Atlanta only on a
staff-entry URL or after a previous choice in the session, "Not sure"
otherwise), or the spec must state that public self-serve sign-ups are
knowingly defaulted to Atlanta and skip review. The backfill (F7) sweeps the
same public population.

## F6 [MEDIUM] The Today consequence in section 4 is false: /join leads were never in "needs you now"

What is wrong. Section 4 says Today's "needs you now" treats needs_review
contacts as untriaged (today.ts:167) and that a new /join lead's reply
"therefore no longer appears there". The triage pass reads ONLY the
`type = 'unknown'` partition: `contacts.listByType('unknown', { status:
'needs_review', ... })` (app/src/routes/today.ts:845-877); the
`UNTRIAGED_CONTACT_STATUSES` check at today.ts:902 runs inside that unknown-only
loop. A /join lead is `type: 'tenant'` (public.ts:258), and its thread is a
`tenant_1to1` (public.ts:285), whose unread reply goes to the Unreplied group
regardless of contact status (today.ts:815-840). The inbox Unknown tab also
excludes tenants (app/src/lib/unknownQueue.ts:140-146). So nothing on Today or
the inbox changes; the public.ts:252-256 comment calling tenant needs_review
"the human triage queue" is itself stale.

What it implies. The only real reader changes of D5 are the contacts-list
status filter, the `needs_review` warn tone in StatusBadge
(dashboard/src/ui/StatusBadge.tsx:24,120), and extraction statusAdvance
eligibility (apply.ts:533-536). The human is signing off on a consequence
that does not exist while the real ones are partly unlisted (the badge). A
builder may also write a test asserting a Today change that cannot happen.

## F7 [MEDIUM] The RUNBOOK's "spot the flyer leads and --skip them" step cannot be performed

What is wrong. D10/D11 rely on the operator recognizing, in the dry-run
list, leads "whose sign-up came from a flyer for a property that was off the
market" and passing them to `--skip`. Nothing stored distinguishes them:
`unit_of_interest` is written only when the unit was shareable
(public.ts:268-269); the `housing_fair_signup` audit carries `viaFlyer:
false` for a non-shareable unit and no unitId (public.ts:322-327); the log
line is the same. The "See other homes" -> /join path (F5) leaves no trace at
all. The dry-run line the spec prints (name, date, status, contactId) carries
no signal either.

The spec's only reason to print person names is this unperformable step, and
it departs from the precedent it claims to follow: clean-org-names prints
organization values and "Never a person's name, phone or email"
(app/scripts/clean-org-names.ts:56-57).

What it implies. Either drop the --skip-by-eyeball step (and the names), or
find a real signal before promising one. As written the RUNBOOK asks
Cameron to do something the data cannot support, and the run will stamp
those leads Atlanta regardless.

## F8 [MEDIUM] D10's lock rule disagrees with the system's lock rule and with the precedent it cites

What is wrong. D10 refuses `--apply` while `lastRewrite.status ===
'running'`. The app's definition of a held lock includes a 15-minute lapse:
`isOrgRewriteRunning` returns false once the heartbeat is older than
ORG_REWRITE_STALE_MS (app/src/services/orgNames.ts:152-156,
orgListRepo.ts:79). A rewrite that crashed leaves `status: 'running'`
forever until another rewrite overwrites it, so the backfill refuses
indefinitely while the app itself considers the lock free - a reader that
disagrees with the rule. Separately, the cited precedent TAKES the lock for
its whole apply and heartbeats it (clean-org-names.ts:36-46); D10 only checks
once at start, so a Settings rename started mid-run is not refused and is
only reported after the fact by the post-apply re-read.

What it implies. Use `isOrgRewriteRunning` (not a bare status compare), and
either take the cleanup lock as clean-org-names does or state why a one-shot
check plus the warning is acceptable.

## F9 [MEDIUM] Consent: "each person gives their own consent" contradicts "staff type them in"

What is wrong. Section 1 says staff type fair leads into /join; D9's rule
for the consent box is justified by "each person gives their own consent".
Both cannot describe the same interaction unless the tablet is handed to each
person. The form records `consent_method: 'web_form'` with no
`consent_captured_by` (public.ts:275-277), which is the AUTOMATIC,
consumer-submitted basis (lib/smsCompliance.ts:66-73); staff-attested
in-person consent has its own method, `verbal_in_person`
(smsCompliance.ts:81-87). The spec now designs the staff batch-entry flow
(D9) on top of this without saying who ticks the box.

What it implies. On an A2P-filed opt-in, a staff-ticked web_form box is a
misstatement of the consent basis. The spec should state the intended
interaction; if staff tick it, the consent record is wrong for every
Sign-up-another-person entry. (Out-of-scope fixes are not proposed here; the
finding is that the spec's two statements are irreconcilable.)

## F10 [LOW] D2 leaves the mount unspecified, and the obvious mount trips the edge-classification guard

What is wrong. D2 says only that the read is "mounted so that" it bypasses
the shared limiter. The obvious way - `app.use('/public/housing-authorities',
...)` ahead of the `/public` mount - is a new `app.use('<path>'` that
app/test/cloudfrontBehaviors.test.ts:137-147 requires to be classified in
EDGE_MUTATING_PREFIXES (which then demands a Terraform behavior, test lines
113-116) or EDGE_EXEMPT_PREFIXES (app.ts:85-90). Also, the "/unit-media
precedent" for a generous hard-coded limit is a route CloudFront absorbs in
deployed envs (app.ts:183-189); the new GET is the first public route served
by the app itself on every page load with no cache in front. The per-IP key
is the FIRST X-Forwarded-For entry (middleware/rateLimit.ts:67-74); that CloudFront
appends the viewer IP after any client-supplied value (making the first
entry spoofable) is AWS behavior, UNVERIFIED in this repo, and pre-existing
for the shared limiter too.

What it implies. Name the mechanism (an exempt-prefix entry with its reason,
or a path skip in the shared limiter) so the builder does not discover the
guard by failure, and do not call the limit a fence if the key is spoofable.

## F11 [LOW] The public GET uses the CREATING read

What is wrong. D1 mandates `orgListRepo.get()`, which writes the starting
list when no item exists (app/src/repos/orgListRepo.ts:166-195). That makes
an unauthenticated public GET a potential settings-table writer. In deployed
envs the item already exists, and seeds put it (lib/seed/orgList.ts), so the
practical exposure is small.

What it implies. `peek()` with the in-memory starting list as fallback (the
pattern the scripts use) keeps the public surface read-only. Worth a
sentence either way.

## F12 [LOW] Section 2 misstates the existing-phone path

What is wrong. Section 2 says an existing contact "changes nothing" and the
request only skips "a repeat welcome text". For an existing contact that was
never fair-welcomed (an inbound-SMS stub, a manually created tenant),
`alreadyWelcomed` is false (public.ts:248-251), so the request SENDS a welcome
and WRITES `housing_fair_welcomed: true` on that contact (public.ts:291-306).
D6's "a public form must not edit an existing person's record" is therefore
already not literally true today.

What it implies. Minor, but D6 is phrased as preserving a property the code
does not have; correct the description so nobody "fixes" the welcome stamp.

## F13 [LOW] Failed-list state never self-heals across "Sign up another person"

What is wrong. D8's failed state offers only "Not sure"; D9 never re-reads
the list. One transient failure at page load therefore drops the authority
for every person signed up in that session, with only a small note asking
for a reload.

What it implies. Re-reading on "Sign up another person" ONLY when the list
is in the failed state keeps D9's no-reread intent for the success case and
removes a silent, session-long data gap.

## F14 [LOW] Unenumerated surfaces and stale statements the build must touch

- dashboard/src/routes/public/publicApi.ts:59-96: `HousingFairInput` and
  `submitHousingFair`, which builds an explicit body and silently drops any
  key it does not name - the field is lost unless this file changes.
- The stage client lives at `app/scripts/lib/stageClient.ts`, not
  `scripts/lib/stageClient.ts` as D10 says; `parseStageArgs` already refuses
  unknown and repeated args (stageClient.ts:186-212).
- Statements that become false under D5: public.ts:252-256 (comment),
  public.ts:13-17 (route header), e2e/scenarios/steps.ts:969-972 ("makes a
  `type:tenant, status:needs_review` contact"),
  e2e/tests/scenarios/tenant-onboarding.spec.ts:182-183 ("no housing-authority
  field on POST /public/housing-fair"), documentation/STATUS-MODEL.md:161
  ("Every new contact lands here"), app/test/publicIntake.test.ts:29,42
  (asserts needs_review).
- e2e/performance/templates.ts:162-163 lists the public endpoint templates;
  the new GET is not declared (only matters if a measured page requests it;
  /join is classified `public` in e2e/performance/routes.ts:118).
- D10 reuses `org_name_cleanup` for a guessed assignment; the property
  Activity renders that type as "Housing authority cleaned up"
  (dashboard/src/routes/listing/listingFormat.ts:217-225). Contacts do not
  render it today, but any audit consumer can no longer tell a mechanical
  name cleanup from a bulk default.
