# flyer-leads - planner review P2: plan-blind adversarial re-review

Reviewed: `feat/flyer-leads` at `33e392aa`. The fix wave is
`git diff c860883b..33e392aa -- . ':!docs/superpowers'` (public.ts, units.ts,
FlyerPage.tsx, their tests, two docs/issues files). I re-swept the whole
branch, not only the wave. The only file opened under `docs/superpowers/` was
`planner-review/adjudications.md`. No test, build or script was run
(`planner.end` was absent throughout), so every proof is a code path; anything
not provable that way is marked PLAUSIBLE. Byte-exact backing quotes are in
`.superpowers/sdd/planner-review-adversarial-reference.md` (section P2).

Counts:
- New this round: BLOCKING 0, HIGH 0, MEDIUM 0, LOW 1 (N1), INFO 2 (N2, N3).
- Contested adjudication: LOW 1 (A-L1, defended).
- Carried open, not re-litigated: MEDIUM 1 (A-M1, CAMERON), with one note on
  the options.
- Conceded: A-M2, A-L3, A-L4, A-I1, A-I3, A-I4.
- Fix verification: A-L2, C-F1 and A-I2 are correct as written (V1-V3). The
  two issue-file additions are accurate, but the wave left older line refs
  stale in the same files (N2).

---

## 1. New findings

### N1 - LOW - Every non-signed_up row whose latest counted entry is the flyer reads "Sent <sign-up date>", so Follow up chases a property that was never sent

- Where:
  - `dashboard/src/routes/contact/Card.tsx:351` - the words are keyed on the
    OUTCOME: `sentWords = row.outcome === 'signed_up' ? 'Signed up from the
    flyer' : 'Sent'`. Rendered at `:371` (property Sent to card, tenant and
    partner Properties sent cards).
  - `dashboard/src/routes/broadcasts/FollowUpView.tsx:117-119` - always
    "Sent <date>".
  - Server side: the row's `sentAt` is the flyer instant whenever the flyer
    entry is the latest counted one (`app/src/services/shareLedger.ts:135`
    summarize). The precedence is Replied > Signed up
    (`app/src/lib/listingSendOutcome.ts:87-88`), and `isWaiting` keeps Replied
    pairs (`app/src/services/followUps.ts:183`).
- Scenario A (never sent): a tenant or unknown contact signs up on a flyer for
  property P, which staff never sent them. The pair is created by the flyer
  entry alone. The person then texts in ("is it still available?"), so
  `last_heard_from_at` moves past `sentAt` and the pair reads Replied. After 24
  quiet hours it is listed on Matching's Follow up tab as "Sent Oct 22 - Last
  heard from Oct 23", waiting on a reply to a property send that never
  happened. The same pair's row on P's Sent to card and on the contact page
  reads "Sent Oct 22 ... Replied". A staff member following up the usual way
  ("did you get a chance to look at the home we sent?") asks about a text the
  person never received.
- Scenario B (wrong date): P was blasted to the tenant on Oct 1. They signed up
  on Oct 20 and then replied, or staff clicked Interested (a tour), or staff
  clicked Not interested. The row now reads "Sent Oct 20", the sign-up
  instant, not the Oct 1 send.
- Who notices: staff, on Follow up first. The GLOSSARY's "signed up" entry
  already says such a pair "then reads Replied and is back on Follow up once
  quiet (unknown contacts included)". Only the signed_up row got its own
  words; the other outcomes of the same flyer-latest row did not.
- Proof: the code path above. `replied` is decided before the flyer check, and
  the label never consults the share key.
- Smallest fix: put the latest counted share key on the wire. The server
  already computes it (`latestCountedShareKey`), for example as `sentVia:
  'flyer'` on `ListingSendRow` and `FollowUpItem`. Key "Signed up from the
  flyer" / "Sent" on that instead of the outcome, in Card.tsx and
  FollowUpView.tsx.

### N2 - INFO - The fix wave shifted public.ts by about 20 lines and left the older line refs in the same issue files pointing at the previous tree

The wave added lines to `app/src/routes/public.ts`: the deleted-path try at
:510-528 and the comments at :40-46, :135-142 and :602-604. In this tree, the
deleted path is :509-545, the clock is :658, `hasEventSince` is :664, the
ledger call is :717 and the main audit is :744. The new paragraphs cite this
tree, but the older paragraphs in the same files still cite the old one:
- `public-signup-abuse-hardening.md` mixes both trees in one file: :637-652,
  :637-673, :658-673, :686-703, :495-528 and :584, beside the new :562, :662
  and :675-694. Its frontmatter `refs` carries the old ones.
- `flyer-signup-decline-click-race.md`: :637, :643, :661-672, :696.
- `consent-capture-ignores-signup-web-form.md`: :718-731 is the audit row,
  now :744-757, in the same frontmatter that gained the new refs.
- `deleted-contact-web-signup-silent.md` was "refreshed to the flyer-leads
  tree on 2026-10-21": :489-528 and :496.

A reader following ":637-652 (the repeat check)" now lands on the clock
comment. Refresh the public.ts refs in all four files once, on the final tree.

### N3 - INFO - The best-effort audit (C-F1) quietly weakens the two readers that treat `housing_fair_signup` as evidence

C-F1 is right for the visitor: no 500 after the writes landed. But the audit
row is not only a trace:
- the join-housing-authority backfill leaves a lead out on a v2 sign-up event
  (`leftOutReasonFromAudit`, pinned in
  `app/test/backfillJoinHousingAuthority.test.ts`), so a re-run would no longer
  skip a lead whose post-change sign-up audit failed;
- the consent issue's own suggested fix stamps `web_form` consent FROM that
  audit row (`docs/issues/consent-capture-ignores-signup-web-form.md`,
  "Suggested fix").

Both need a DynamoDB fault on that one write, and the backfill has already
run. One line in the consent issue ("the audit is best-effort since C-F1; a
missing row is not proof of no sign-up") keeps the future fix from relying on
it as complete.

## 2. Contested adjudication

### A-L1 - LOW, defended - "a crash before the send is the same class" as a failed welcome; it is not, and it has a hazard-free fix

The ruling treats a throw between `contacts.create` (`public.ts:562-593`) and
the welcome (`:614-620`) as spec D5's "a welcome that failed is not retried". It
differs in three ways:
1. The welcome was never attempted.
2. The visitor was told the request FAILED and the form invites a retry
   (`FlyerPage.tsx:251`). D5's case answers `{ ok: true }`.
3. The double-text hazard in the ruling is a property of the flag-based
   CANDIDATE rule (welcome on `web_form` without `housing_fair_welcomed`), not
   of every fix.

A reorder closes most of the window without ever re-texting anyone:
- For a new phone, run `createOrGetByParticipantPhone(phone, 'tenant_1to1')`
  BEFORE `contacts.create`. A new contact is always a tenant, so the type is
  known.
- A throw in the multi-write get-or-create (GSI query, claim put, get, row
  put - `conversationsRepo.ts` createOrGetByParticipantPhone) then happens
  before any contact exists. The retry is still a create, and it is welcomed.
- Only `setParticipantsIfAbsent` (one conditional write) and an ambiguous
  create are left after the create. An ambiguous create is a PutItem that
  committed but whose response was lost; the SDK retry then fails its
  `attribute_not_exists(contactId)` condition and throws.

The flag rule, with its hazard, is a real Cameron call. The reorder is not:
it changes no decision and no copy. Smallest fix: the reorder, RED-proven by
a get-or-create spy that throws once and then a resubmit that sends exactly
one welcome. Severity stays LOW (it needs a DynamoDB fault), but it is a
regression this branch introduced: main's flag gate re-welcomed this case.

## 3. Carried open

### A-M1 - MEDIUM, CAMERON (not contested) - a note on option (a)

Option (a), "reword the legend line", rewords ONE shared string
(`FlyerTag.tsx:36`, rendered on both property forms). It would also stop
promising "never leaves the dashboard" for the Staff-only fields that truly
never do: Payment standard, Subzone, the screening and qualifications items,
the deposit notes, Pets and Deposit. No merge field reads any of those
(`mergeFields.ts:94-98`: TenantName, Beds, Address, Rent, FlyerLink). The
honest narrow fix under (a) is a per-field note on Rent min / Rent max ("not
on the flyer; the Matching text's [Rent] sends it"). That keeps the legend's
guarantee true for everything else.

## 4. Conceded

- A-M2 (FILE): conceded. The unread mark on a new sign-up is Cameron's
  explicit call, and the ceiling is the right home. The filed text matches
  the code (V4).
- A-L3 (FILE): conceded. It is a compliance rule, not a fix-wave change, and
  the Twilio Advanced Opt-Out note is a useful addition.
- A-L4 (ACCEPT): conceded. Spec D7 residual, and C-F3 records that the code is
  narrower.
- A-I1, A-I3, A-I4 (ACCEPT): conceded.

## 5. Are the fixes correct?

- V1, A-L2 (`app/src/routes/units.ts:2276`): correct. `getDisplaysByIds` uses
  `DISPLAY_PROJECTION`, which carries `#phone`
  (`app/src/repos/contactsRepo.ts:1078-1079`), so the formatted-phone branch is
  reachable on the real repo, not only in the harness fake. Widening
  `recipientLabelOf` to `ContactDisplayItem` is sound, because
  `RecipientDisplay` is `ContactDisplayItem & {...}` (`contactsRepo.ts:397`).
  The three surfaces now share one rule. The RED test exercises the fake; the
  real projection is proven by the line above.
- V2, C-F1 (`app/src/routes/public.ts:510-528`, `:743-760`): correct. Both
  appends are guarded, log `{ marker, step: 'audit', err }` at ERROR with no
  name or phone (the payload holds only the hashed marker and an org name),
  and still answer `{ ok: true }`. The new header lists what stays
  unguarded: the reads, the create, and the thread get-or-create and link.
  That list is accurate in substance. The one other post-create throw is a
  synchronous SSE listener throw out of `events.emit` inside
  `markSignupUnread` (`public.ts:413`), which is theoretical; every emit site
  shares that posture.
- V3, A-I2 (`FlyerPage.tsx:318`): correct. The comment now names the suffix
  at `:325`.
- V4, docs: the new text in both issue files is accurate against this tree.
  Checked: `public.ts:551`, :562-593, :605-606, :629, :662, :675-694;
  `today.ts:182`, :752, :754; `config.ts:1008`, :1014; `units.ts:1495-1520`;
  `followUps.ts:141-161`; `smsCompliance.ts:133`, :239-245, :262-266;
  `HousingFairIntake.tsx:163`; `app/scripts/backfillConsentMethod.ts` stamps
  `web_form` for `housing_fair` / `flyer`. Only the older refs around them are
  stale (N2).
