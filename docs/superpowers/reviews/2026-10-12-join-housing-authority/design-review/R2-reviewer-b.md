# Design review R2 - reviewer B (adversarial)

Spec: `docs/superpowers/specs/2026-10-12-join-housing-authority-design.md`, revision 2
(@138bc8ac; diffed against rev 1 @d33dc1e6). Read alongside `adjudications.md` and
`R1-reviewer-a.md`. Read-only: nothing was run. Every claim about existing code cites
the file:line I read.

Order: new defects first (most of them are in the rev-2 fixes themselves), then my
answers to the adjudications, then a check of whether each fix is actually correct.

---

## Part 1 - New findings

### R2-1 [MEDIUM] The D8 recovery's "re-applies the default rule" silently swaps the person's authority, and D9 carries the swap forward

**What is wrong.** On `housing_authority_not_listed`, D8 re-reads the list, keeps the
typed fields and "re-applies the default rule". The default rule is "Atlanta Housing
Authority when that exact name is in the list, else Not sure". The recovery only runs
when the name the person CHOSE has left the list (renamed, merged, deleted or
re-kinded). So:

- Chosen "DeKalb County Housing Authority", since renamed: the select now shows
  **Atlanta Housing Authority**. One more tap on send records a DeKalb voucher holder
  as Atlanta.
- Chosen Atlanta, Atlanta since renamed: the select drops to **Not sure**. The sign-up
  then stores no authority plus the D5 marker, so the backfill will never fill it
  either.

D9 then keeps "the value chosen for the previous person", so the swapped value is
pre-selected for every following person in that session. The message ("Check the
housing authority and send again") is the only defense. A public self-serve user
(section 4) has no way to know what "check" means.

**Evidence.** Spec D8 (recovery bullet and default bullet), D9. A rename keeps the old
name only as a SPELLING (`app/src/services/orgRewrite.ts`, rename at about :374-405).
D1 returns names only, so the client cannot map the old choice to its renamed entry.

**Implies.** The recovery must not pick a value for the person. Leave the select with
NO selection (a "Choose..." placeholder that blocks send until a choice is made), or
select "Not sure" only when the person explicitly picks it. This costs one line of
spec and removes a wrong-data path that the fix itself created.

### R2-2 [MEDIUM] The marker misses a pre-deploy lead who is asked again, so the backfill overrides a fresh answer

**What is wrong.** J1's marker is written only on CREATE (D5). D6 writes nothing to an
existing contact, and D7 audits `housingAuthority: null` for an existing contact
whatever the person chose. Take a pre-deploy /join lead (no authority, no marker) who
signs up again at a later fair after the deploy and answers "Not sure" or "DeKalb
County Housing Authority". The answer is validated against the list (D3), then
discarded (D6/D7), and the next backfill run stamps Atlanta on them. D5's stated
purpose ("so the backfill never treats a 'Not sure' answer as an old lead") does not
hold for this population. The window is from deploy to the backfill run. D11 only
says "owed ... once this branch deploys", so the window is open-ended.

**Evidence.** Spec D5, D6, D7, D10 Candidates. `app/src/routes/public.ts:245-251` (an
existing phone takes the dedupe branch) and `:322-327` (the audit is the only record a
re-sign-up leaves).

**Implies.** Make "was asked" observable for existing contacts without editing the
record. One way: D7 records on every no-unitId sign-up that the question was asked,
including the requested name or "not sure" in the audit payload. D10 then leaves out
any candidate with such a `housing_fair_signup` event (it already reads the audit
trail for J2). Alternatively, D6 could write the marker alone. Either way the spec
must choose; today the guarantee is false.

### R2-3 [LOW] "Safe to re-run at any time" is false for post-deploy flyer sign-ups

**What is wrong.** D5 keeps unitId requests "exactly as today ... no marker", including
a missing or unshareable unit stamped `housing_fair`. Every such sign-up after the
deploy is a permanent backfill candidate: never asked, `capture_source: 'housing_fair'`,
`type: 'tenant'`, no authority, no marker, no history. Every re-run stamps it Atlanta.
The server knew a unitId was present at create time (`public.ts:231-240`), so this is
not the historical "indistinguishable" problem. It is a new one, created by
deliberately not marking these leads.

**Implies.** Mark them too (any marker the backfill excludes, for example a
`housing_fair_flyer_unit_unavailable` flag, or write the D5 marker for every create
after this change). Otherwise D10 must stop claiming re-runs are safe.

### R2-4 [LOW] The "asked" marker is set server-side whether or not the question was shown

**What is wrong.** D5 sets `housing_fair_authority_asked: true` on every no-unitId
create. The server cannot tell whether the person saw the select. Three cases where
they did not:

- A /join page loaded BEFORE the deploy and still open on a staff tablet (old bundle,
  no select) posts after the deploy.
- The D8 failed or timeout state offers only "Not sure".
- Any direct POST.

These leads are marked "asked" and are permanently outside the backfill. The cost is
small (new Onboarding leads, a short window), but the marker's name and D5's prose
claim something the mechanism does not establish.

**Implies.** Either say the marker means "created by the post-change endpoint", or
have the client send an explicit field when the select was actually offered and set
the marker from that.

### R2-5 [LOW] The audit-history exclusion has two holes the spec should close in its own text

**What is wrong.** D10 leaves out "a candidate whose audit trail shows housingAuthority
was ever written" and delegates the event list to the plan. The spec's illustrative
list omits two events:

- The backfill's OWN `housing_authority_backfill` event. A backfilled Atlanta value
  that staff later clear is removed by a `contact_updated` PATCH, and that event does
  catch it, so this is fine only if the plan includes `contact_updated`. Name it.
- The caseworker conversion's REMOVE. It is audited as `contact_updated` with
  `conversion: 'caseworker'` (`app/src/services/caseworkerConversion.ts:425-436`),
  which matters if the contact is later re-typed back to tenant.

Separately, every one of these audit appends is BEST-EFFORT; a failed append leaves
the write invisible:

- extraction: `app/src/services/extraction/apply.ts:503-511`
- conversion: `caseworkerConversion.ts:425-436`
- org rewrite: `app/src/services/orgRecords.ts:618-627`

**Implies.** State the completeness rule in the spec: every event type that can SET OR
REMOVE `housingAuthority` on a contact. Today those are `contact_updated` (by `fields`),
`ai_extraction_applied` (by `fields[].field`), `ai_suggestion_accepted` (by `target`),
`org_name_rewrite` / `org_name_cleanup` (by `field`) and `housing_authority_backfill`.
Accept the best-effort gap in one sentence.

### R2-6 [LOW] The backfill stamps leads staff already parked (inactive, on hold)

D10's candidates have no status condition, and section 4 says backfilled leads "join
blasts filtered on that authority at once". Blasts have no status filter
(`app/src/services/audienceResolution.ts:116-176`). So the run puts every inactive and
on-hold /join lead into every Atlanta-filtered blast. Section 4 should say so
explicitly, or D10 should leave out `inactive` and `on_hold`. This is a decision, not
a defect; it is currently unstated.

### R2-7 [LOW] Section 7 misses one stale statement

`documentation/sequence-diagram-to-test.md:110` says the housing-fair POST "creates a
`type:tenant, status:needs_review` contact". D5 makes this false. It is not in the
section 7 list (STATUS-MODEL.md, steps.ts, the tenant-onboarding spec and public.ts are).

---

## Part 2 - The adjudications I was asked to contest

- **J5, provenance stamp rejected: CONCEDE.** The only reader of a `<field>_source`
  stamp is the AutoBadge, which fires on `source === 'ai'` alone
  (`dashboard/src/api/types.ts:2066-2067`, `dashboard/src/routes/contact/AutoBadge.tsx`).
  Extraction does not read stamps (`app/src/jobs/extraction.ts`, no `_source` use). A
  form-default stamp would have no consumer.
- **J7, spelling resolution on the public route rejected: CONCEDE as a product ruling.**
  The replacement recovery is where the defect now lives (R2-1).
- **J12, taking the lock rejected: CONCEDE.** Verified `dashboard/src/routes/orgs/orgCopy.ts:581-582`
  ("the one-time cleanup") and `:616` ("Re-run the cleanup script"). It is also
  stronger than the ruling says: `acquireForCleanup` REPLACES `lastRewrite`
  (`app/src/services/orgRewrite.ts:596-611`), so taking the lock would erase the Settings
  record of the last real rename or merge.
- **J11 (names in the dry run) and J13 (consent method): CONCEDE.** Both are Cameron's
  rulings, recorded in the spec.

---

## Part 3 - Are the rev-2 fixes correct, or only plausible?

- **D2 mount: correct.** Express 5 (`app/package.json:36`) routes async rejections to the
  error handler, so D1's "generic 500" holds. A Router mounted at `/public` with only
  `router.get('/housing-authorities', limiter, handler)` calls `next()` on every other
  request into the existing mount (`app/src/app.ts:165-181`). The guard regex
  (`app/test/cloudfrontBehaviors.test.ts:139`) sees only `/public`, which is already
  classified. The Vite dev proxy already covers `/public` (`dashboard/vite.config.ts:109`).
- **D1 peek() plus in-memory starting list: correct and better than rev 1.** It also
  removes a real race: `/__dev/reseed` empties every table before seeding
  (`app/src/lib/seed/orgList.ts` header), and a creating read during that gap would
  have raced the seed put.
- **D3 shape, then list check, distinct code: correct.** `consent_required` still wins
  because it is checked first (`public.ts:100-104`). The distinct code reveals nothing
  because the list is public via D1.
- **D10 write conditions (type, deleted): correct but unseated.** Rev 1 named
  `rewriteOrgFields`, which cannot express them: its conditions are only
  `attribute_exists(contactId)` plus housingAuthority, agency and organization guards
  (`app/src/repos/contactsRepo.ts:1846-1861`). Rev 2 names no seam. `contactsRepo.update`
  with `expect` clauses and `notDeleted` can carry all three conditions and has no side
  effect for a plain housingAuthority SET (`contactsRepo.ts:686-689`, `:1458-1500`,
  `:1544-1562`). Its lost condition throws `ConditionalCheckFailedException`, which the
  script must map to "skipped". Worth one line so the builder does not extend
  `rewriteOrgFields`.
- **D10 `isOrgRewriteRunning`: correct** (`app/src/services/orgNames.ts:152-156`).
- **New audit event `housing_authority_backfill`: no reader breaks.** Event types are
  free strings (`app/src/repos/auditRepo.ts:21,43`), and contacts render no audit
  events. Its inclusion in the history rule is R2-5.
- **D5 marker: correct for what it covers.** Gaps are R2-2, R2-3 and R2-4.
- **D8 recovery: incorrect as written** (R2-1). The timeout, the 429 copy and the
  D9 re-read-on-failure are correct.
- **Section 2 / section 4 corrections (J4, J6, J16): verified accurate.** One nit:
  section 2 says extraction writes "only into an EMPTY field". The prompt also allows a
  write that restates the SAME fact in a better form
  (`app/src/services/extraction/prompt.ts:37-38`). Section 4's consequence (a
  different authority is only suggested) still holds.

---

## Round-1 status (mine)

Closed by rev 2: F1 (except R2-2/R2-3/R2-4), F2, F4, F5, F7, F8 (except R2-5), F12,
F13, F14, F15, F16, F17. Conceded: F3's provenance remedy, F9's names, F10's lock,
F11. Facts accepted into the spec: F3, F9.
