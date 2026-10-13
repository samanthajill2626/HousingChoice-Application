# Design review R1 - reviewer B (adversarial)

Spec: `docs/superpowers/specs/2026-10-12-join-housing-authority-design.md` (rev 1, @d33dc1e6)
Repo read at: `W:\tmp\join-housing-authority` (main @19607658 + the spec commit)
Method: every claim about existing behavior below was read in the code at the cited
file:line. Nothing was run.

---

## F1 [BLOCKING] The backfill overwrites explicit "Not sure" answers: its target set has no time bound

**What is wrong.** D8 makes "Not sure" a real answer that "records none", and D8's
failed-list state also creates sign-ups with no authority. D5 creates those contacts
as `type: 'tenant'`, `capture_source: 'housing_fair'`, no `housingAuthority`. D10's
target set is exactly `capture_source === 'housing_fair'`, `type === 'tenant'`, not
deleted, no `housingAuthority` attribute. Nothing in D10 separates a pre-change lead
from a post-change "Not sure" lead. D11 says the backfill is "owed on dev and prod
AFTER this branch deploys there", so every "Not sure" (and every failed-list) sign-up
between the deploy and the run is stamped Atlanta Housing Authority. Any later re-run
does it again.

**Evidence.** Spec D5, D8 ("'Not sure' sends no `housingAuthority`"), D10 Targets,
D11 ordering; `app/src/routes/public.ts:257-278` (the create shape D5 extends).

**Slogan.** "Idempotent: a re-run finds no targets for the records it wrote" is true
only for the records it wrote. A re-run is not a no-op: it finds every "Not sure"
lead created since the last run.

**Implies.** The documented procedure corrupts a tenant-given answer with a guess,
and afterwards the two are indistinguishable (see F13). The target set needs a
bound the mechanism can enforce (for example `captured_at` before a cutoff the
operator passes, or before the deploy instant), or the backfill must run before the
form ships. Pick one in the spec; the builder cannot infer it.

---

## F2 [HIGH] D3 "no trimming" contradicts the app-wide JSON trim; the padded-text test cannot pass

**What is wrong.** D3 says the value must match "character-for-character ... no
trimming", and section 6 lists "padded text" among inputs that must be a generic 400
and write nothing. Every JSON body is deep-trimmed before any route sees it, so
`" Atlanta Housing Authority "` reaches the handler as the exact name and is
ACCEPTED and written.

**Evidence.** `app/src/app.ts:138-142` mounts `trimJsonBody()` in the locked chain
ahead of all routes; `app/src/middleware/trimStrings.ts` (deepTrimStrings: every
string value, "new routes and new fields inherit the guarantee automatically").
The test harness the spec names goes through `buildApp`
(`app/test/publicIntake.test.ts` uses `makeWebhookHarness`;
`app/test/helpers/twilioWebhookHarness.ts` calls `buildApp`), so the trim applies in
the test too.

**Implies.** The builder either drops a spec'd test case or works around a locked
founder decision (reading `rawBody`, or exempting `/public`). The second is a
regression. The spec should say padded text is trimmed by the middleware and then
validated, and remove "padded text" from the 400 list.

---

## F3 [HIGH] A preselected answer on a PUBLIC self-serve form is recorded as the tenant's fact

**What is wrong.** Section 1 frames `/join` as a form "staff type ... in". It is also
the public self-serve page: the flyer's "no longer available" state sends the public
to `/join` ("See other homes"), and the tenant-onboarding writeup describes the same
form as the tenant's own self-serve portal. D8 preselects Atlanta Housing Authority
for everyone. A DeKalb, Fulton or DCA voucher holder who does not touch the field is
stored as AHA, with nothing recording that the value was a default.

**Evidence.** `dashboard/src/routes/public/FlyerPage.tsx:211-219` (`href="/join"`);
`documentation/tenant-onboarding-sequence-writeup.md:32` ("the tenant fills in their
own details through a self-serve portal"); spec D7 audits only the name, not whether
it was the default; spec section 2 never mentions the flyer link.

**A reader the spec did not enumerate.** AI extraction treats any held value as a
known fact: the prompt writes only when the field is empty and SUGGESTS when new
information conflicts (`app/src/services/extraction/prompt.ts:37-39`), and the
held value is fed into the prompt profile (`app/src/jobs/extraction.ts:154-155`).
Today a /join lead who later texts "I'm with DeKalb" gets that written automatically
(field empty). After D8 (and after the D10 backfill) the same text only produces a
staff-review suggestion against a default the person never chose. The repo's own
operator mandate against recording a guess as fact is stated at
`app/src/services/contactCapture.ts:74-78`.

**Implies.** The spec must either justify the default for the public path (and say
the extraction downgrade is accepted), or restrict the preselect to staff use, or
record provenance (for example a `housingAuthority_source` stamp or an audit flag
for "default untouched"). As written, the consequence is invisible in section 4.

---

## F4 [MEDIUM] The Goal misdescribes how blasts select tenants; tracker #6 is not built

**What is wrong.** Section 1 says property blasts "filter on housing authority and go
only to Onboarding and Searching tenants, tracker #6". No status filter exists in the
code on main or on any local branch. An authority-filtered blast reaches tenants of
every status, Needs review included; an unfiltered blast walks every tenant.

**Evidence.** `app/src/services/audienceResolution.ts:116-176` (queries
`listByHousingAuthority` or `listByType('tenant')`; the only per-contact fences are
type, opt-out, unreachable, phone, bedroom size); `app/src/repos/broadcastsRepo.ts:84-90`
(`AudienceFilter` has no status); `dashboard/src/routes/broadcasts/AudienceFilters.tsx`
(no status control).

**Implies.** (a) "never reach them until someone edits each record by hand" is false
for unfiltered blasts today. (b) D5 has no blast effect until #6 ships; the spec should
say D5 anticipates #6. (c) Internal contradiction: under the spec's own model the
backfill alone achieves nothing for blasts (backfilled leads "keep their current
status (mostly Needs review)", section 4); under the real code it works now and
then silently stops working for every lead nobody moved, the day #6 ships.

---

## F5 [MEDIUM] Section 4's Today consequence is false - Today never showed /join leads as untriaged

**What is wrong.** Section 4 says a new /join lead's reply "no longer appears" in
Today's "needs you now" because only `needs_review` contacts are untriaged. Today's
untriaged block reads only `type = 'unknown'` contacts, and the unread pass sends
only `unknown_1to1` threads to needs_you_now. A /join lead is a `tenant` on a
`tenant_1to1` thread; its reply goes to Unreplied before and after this change.

**Evidence.** `app/src/routes/public.ts:285` (`'tenant_1to1'`);
`app/src/routes/today.ts:870-874` (`listByType('unknown', { status: 'needs_review' })`),
`:902` (the status set applied only to that read), `:784` (only `unknown_1to1` to
needs_you_now), `:815-831` (`tenant_1to1` to unreplied), `:1121`.

**Implies.** A cost was presented for a decision that does not exist (and a builder
could write a vacuous test for it). The real triage loss is the one the section also
names: new /join leads leave the Needs review status filter, which is their only
triage surface.

---

## F6 [MEDIUM] A list change during an open /join session makes every later sign-up fail, contradicting "never blocks"

**What is wrong.** D9 keeps the chosen name and never re-reads the list; D3 validates
the exact name against the list AT REQUEST TIME and refuses anything else with the
generic 400. If the chosen entry is renamed, merged, deleted or re-kinded in Settings
while staff keep the page open through a fair, every subsequent sign-up with that
value fails. The form shows "Sorry, we couldn't send that. Please try again."
(`dashboard/src/routes/public/IntakeForm.tsx:100-102`), and retrying can never
succeed. D8's promise "A sign-up never blocks on this optional field" does not hold.
The same is true when the POST's own list read fails (D3 needs a read; a read error
is a 500) after the page loaded the list fine.

**Evidence.** Spec D3, D8, D9; list mutations live in
`app/src/services/orgRewrite.ts` (rename/merge) and `app/src/services/orgNames.ts`
(remove, changeKind). The list is actively curated now (Settings > Housing authorities
& agencies).

**Implies.** The spec needs a defined behavior: for example, a stale name degrades to
"no authority" with the sign-up still captured, or the 400 carries a distinct code the
form maps to "reload the list". Pick one; both are small.

---

## F7 [MEDIUM] D2's separate mount trips the edge-classification guard, whose fix contradicts "no infrastructure change"

**What is wrong.** D2 requires the list read to sit outside the shared limiter but
does not say how. The natural mount, `app.use('/public/housing-authorities', limiter,
router)` ahead of the `/public` mount (the `/unit-media` shape D2 cites), fails
`app/test/cloudfrontBehaviors.test.ts:136-148`: every `app.use('/<literal>'` in
app.ts must be in `RESERVED_PREFIXES`. The failure message tells the builder to add
it to `EDGE_MUTATING_PREFIXES` (which then demands a Terraform behavior,
`unguardedPrefixes`, `:85-87`) or to `EDGE_EXEMPT_PREFIXES` with a reason.

**Evidence.** `app/src/app.ts:76-100`, `:165-181`, `:190-194`; section 2's claim that a
new GET under `/public` needs no infrastructure change.

**Implies.** Name the mechanism in the spec: a router mounted under the SAME `/public`
prefix ahead of the limiter (for example `app.use('/public', listRouter)` before the
existing mount, or the list router placed before `createRateLimit` in one
`app.use('/public', ...)` call). Otherwise the first fix a builder reaches for edits
infra or misclassifies a sub-path.

---

## F8 [MEDIUM] "No housingAuthority attribute" cannot tell never-set from deliberately removed

**What is wrong.** D10 targets every housing_fair tenant without the attribute.
Several existing paths REMOVE it on purpose: staff clearing the field in the contact
edit form, and the org-name cleanup moving an agency name out of `housingAuthority`
into `agency`. A lead a human cleared (for example because the person is not AHA) or
whose value was moved to agency is re-stamped AHA.

**Evidence.** `app/src/routes/contacts.ts:653-657` ('' becomes null, a REMOVE; see the
`contactsRepo.ts:522` note); `app/scripts/clean-org-names.ts:6-9` (agency move REMOVES
the housing authority); `app/src/repos/contactsRepo.ts:1859` (the backfill's
`attribute_not_exists` guard sees only absence).

**Implies.** At minimum the dry run should flag targets whose audit history shows a
prior housingAuthority value; better, exclude them. The spec should state which.

---

## F9 [MEDIUM] The `--skip` step for flyer leads cannot be carried out - nothing identifies them

**What is wrong.** D10/D11 ask the operator to read the dry run "for flyer leads" and
skip them. A sign-up from a non-shareable flyer stores no unit (unit_of_interest is
written only when `viaFlyer`), gets `capture_source: 'housing_fair'` like a /join
lead, and its audit row says `viaFlyer: false` like a /join lead. The dry-run line
(name, date, status, contactId) carries no signal either.

**Evidence.** `app/src/routes/public.ts:231-240`, `:268-269`, `:322-327`; spec D10 Dry run.

**Implies.** Either print a signal that exists (there is none today, so the spec would
have to say what to look up and where) or drop the flyer-lead step and say flyer leads
are accepted as targets. Printing first and last names to the terminal is also a
departure from the precedent script's rule ("Never a person's name, phone or email",
`app/scripts/clean-org-names.ts:56-57`), justified only by this step, which the names
do not enable.

---

## F10 [MEDIUM] Backfill lock handling diverges from the precedent it claims to follow

**What is wrong.** D10 says it follows `clean-org-names.ts` but (a) refuses on raw
`lastRewrite.status === 'running'`, while the canonical rule is "running AND a
heartbeat under 15 minutes old"; a rewrite whose process died stays `running` in the
item, so the backfill refuses indefinitely while the app treats the lock as free;
(b) it does not TAKE the lock, so the refusal is a point-in-time check: a rename,
merge, delete or kind change of Atlanta Housing Authority started mid-apply is not
refused (delete and kind change wait only for a held lock), and the post-apply
re-read only reports the damage after the records are written.

**Evidence.** `app/src/services/orgNames.ts:152-156` (`isOrgRewriteRunning`),
`:181-185` (delete/kind change refuse only while a rewrite holds the lock);
`app/src/services/orgRewrite.ts:14-15`, `:596-611` (`acquireForCleanup`);
`app/scripts/clean-org-names.ts:586-606` (the precedent takes the lock).

**Implies.** Use `isOrgRewriteRunning`, and either take the cleanup lock for the apply
(the precedent) or state why not and accept the window explicitly.

---

## F11 [MEDIUM] D9 formalizes staff-entered consent recorded as the subscriber's own web-form opt-in

**What is wrong.** Section 1 says staff type fair leads into the public form, and D9
adds a flow built for one device signing up person after person. Every one of those
contacts is stamped `consent_method: 'web_form'` with no `consent_captured_by`
(`app/src/routes/public.ts:275-277`). The A2P design models staff-captured consent
separately: `verbal_in_person`, with `consent_captured_by` "when staff-entered"
(`docs/superpowers/specs/2026-06-30-a2p-sms-compliance-design.md:49-53`). D9's
"(each person gives their own consent)" is a slogan: the mechanism is a checkbox
ticked by whoever holds the device, and the record cannot show who that was.

**Implies.** At least state the consent basis the staff flow relies on and that the
record will say `web_form`; this is the A2P "do-not-remove" surface and should not
change by implication.

---

## F12 [LOW] The backfill write does not enforce the target's type or deleted rule

**What is wrong.** The target filter says `type === 'tenant'` and not deleted, but the
write condition checks only that `housingAuthority` is absent. A lead deleted,
re-typed, or converted to a caseworker between the scan and the write is still
written. The caseworker conversion REMOVES `housingAuthority`, so a converted lead
passes the condition and receives a tenant-only field - the R2-ADV-1 class the
concurrent `fix/caseworker-integrity` branch exists to close (its I1).

**Evidence.** `app/src/repos/contactsRepo.ts:1838-1914` (conditions: `attribute_exists(contactId)`
plus the per-field guards only); spec D10 Apply.

**Implies.** Small window, but the stated target rule is not what the mechanism
guarantees. Note it, or add a type/deleted condition.

---

## F13 [LOW] The backfill's audit event misnames a default as a name cleanup

**What is wrong.** D10 writes `org_name_cleanup { from: '', to: 'Atlanta Housing
Authority' }`. That event type means "a stored name was normalized". Here a value was
assigned by assumption. With no provenance stamp on the record, the value reads as a
staff-entered fact everywhere (and see F3 on extraction). The only way to find the
backfilled set later is the incidental fact that the cleanup never wrote
`housingAuthority` from ''.

**Evidence.** `app/scripts/clean-org-names.ts:22-28`, `:728-734`; spec D10 Apply.

**Implies.** Use a distinct event type, or say explicitly that `from: ''` on
`housingAuthority` is the backfill's signature.

---

## F14 [LOW] Section 2 misstates the existing-phone path

**What is wrong.** "A phone that is ALREADY a contact ... changes nothing on that
contact; the request only re-links the thread and skips a repeat welcome text."
An existing contact that was never welcomed (for example auto-captured from an
inbound text, or imported) IS sent the welcome and gets `housing_fair_welcomed: true`
written.

**Evidence.** `app/src/routes/public.ts:248-250` (alreadyWelcomed from the flag),
`:291-306` (send, then `contacts.update`).

**Implies.** D6 is unaffected (it restricts only status and housingAuthority), but the
"Today" section should be accurate.

---

## F15 [LOW] Wrong path for the stage client

`scripts/lib/stageClient.ts` does not exist. The helper the precedent imports is
`app/scripts/lib/stageClient.ts` (`parseStageArgs` at `:186`;
`app/scripts/clean-org-names.ts:79`).

---

## F16 [LOW] D1 lets an unauthenticated GET create the list and pay a consistent read per request

`orgListRepo.get()` writes the starting list on an empty store
(`app/src/repos/orgListRepo.ts:166-192`) and is always a strongly consistent GetItem
of an item capped at 300 KB (`:78`). D2 permits 60 of these per minute per IP on an
anonymous route. Harmless at today's list size; worth one sentence acknowledging the
anonymous write and the per-request cost.

---

## F17 [LOW] The rapid-entry flow leaves its most likely failure undefined

D9 is built for consecutive sign-ups and section 4 accepts that staff on one venue
network share 5 POSTs per minute. A 429 from the POST renders the generic "Sorry, we
couldn't send that. Please try again." (`dashboard/src/routes/public/IntakeForm.tsx:100-102`),
which does not say to wait. Not a request to change the limit (a stated non-goal);
the spec should define what the form says on 429.
