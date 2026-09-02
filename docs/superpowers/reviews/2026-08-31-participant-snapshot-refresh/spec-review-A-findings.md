# Adversarial spec review A - participant name snapshots: resolve on read

Spec under review: `docs/superpowers/specs/2026-08-31-participant-snapshot-refresh-design.md`
Tree: `W:\tmp\participant-snapshot-refresh` @ working tree, read-only.
Reviewer input: spec + repo only. No brainstorm, no rationale.

Every claim below cites code I opened. Claims I could not check from the tree
are marked UNVERIFIED and are not counted as findings.

UNVERIFIED (stated so it is not mistaken for agreement):

- Section 1's dev/prod measurement table. It is script OUTPUT against live
  tables; nothing in the tree can confirm or refute it.
- Section 2's attribution of the decision to a person on a date.

---

## 1. BLOCKING - S2's contactId-keyed hydration cannot fix the native group_text case the spec names as the founder bug

Section 5 S2 says `routes/api.ts` conversation detail "is the surface the
founder actually reported ... hydrating that passthrough is what makes
'renaming shows in group conversations' true". Section 4.1 resolves each member
as `contactDisplayName(contactsById.get(p.contactId)) ?? p.name`, and a member
whose `contactId` is absent or `''` "keeps its stored name".

That mechanism does not reach the members it needs to reach on a `group_text`
roster:

- `app/src/services/groupConvert.ts:189-200` (`backfillRoster`) fills a missing
  `contactId` with `contactIdForPhone(member.phone)` - a DERIVED id. The
  conversion path's own comment at `app/src/services/groupConvert.ts:573-576`
  says the converge step can "have CORRECTED a slot that pointed at a derived
  id with no row". So group_text roster rows routinely carry a non-empty
  `contactId` that resolves to NOTHING.
- The shipped fix for exactly this staleness resolves by PHONE, not by id:
  `app/src/routes/api.ts:2058` reads `contacts.findByPhone(m.phone)`, and
  `app/src/routes/api.ts:2089` then prefers `contact?.contactId ?? m.contactId`
   - i.e. it treats the stored `contactId` as the less trustworthy of the two.
  The route comment at `app/src/routes/api.ts:2029-2041` states the motivating
  scenario verbatim: detection mints "every unseen member as a NAMELESS stub,
  so the moment staff triage that stub into a real contact the snapshot goes
  stale".

`withLiveNames` keyed on `p.contactId` will produce a Map miss for every such
member and fall back to the stored name - i.e. no change. Section 6.4 fences
`participants[].contactId` ownership to bundle M8, so the spec cannot close the
gap inside this branch either.

IMPLIES: either S2 resolves by phone as well as by contactId (which changes the
batch primitive - `BatchGetItem` cannot read the `byPhone` GSI, see
`app/src/repos/contactsRepo.ts:806-808`), or the spec must stop claiming S2
fixes the group_text surface and say which threads it actually fixes
(relay_group rosters written through `resolveMemberName`, whose ids are real).

## 2. BLOCKING - a refresh-on-write for `participants[].name` already ships; the spec says the strategy "was NOT chosen" and enumerates no writer of that field

Section 2: "Refresh-on-write (extending the fan-out to group rosters) was
considered and NOT chosen." Section 3.2 ("There is a second writer") enumerates
three writers of `participant_display_name` and stops. Section 6.1: "Nothing in
this spec removes or changes a writer of `participant_display_name` or
`participants[].name`."

There is a shipped, running refresh-on-write for `participants[].name`:

- `app/src/routes/api.ts:2042` sets `rosterNamesAreStale`, `:2087` decides it
  from the live contact vs the stored roster name, and `:2099-2113` writes the
  refreshed roster back through
  `conversations.backfillGroupTextRoster` (`app/src/repos/conversationsRepo.ts:1055`,
  impl `:2585`). It fires on every `GET /api/conversations/:id/group-members`.
- `app/src/services/groupConvert.ts:428` and `:504` are two more writers of the
  same field, both name-refreshing (`backfillRosterNames`,
  `app/src/services/groupConvert.ts:210-229`).
- `app/src/services/relayMembers.ts:47-49` (`resolveMemberName`) writes the
  live contact name into the roster at add time; called from
  `app/src/routes/relayGroups.ts:409` and `app/src/routes/tours.ts:1352`.

So the tree already contains the strategy the spec rejects, on the exact field
the spec is about, and the spec's writer enumeration does not name any of them.
A builder following section 6.1 will leave a converging WRITER racing a
converging READER on one attribute with no stated precedence.

IMPLIES: section 3.2 needs a `participants[].name` writer table; section 2 needs
to say why a second, read-side mechanism is being added on top of an existing
write-side one rather than reconciling them; and the dashboard-side convergence
at `dashboard/src/routes/conversation/GroupTextView.tsx:212-221` needs a stated
outcome (once the header is hydrated its `changed` flag goes permanently false,
which is fine, but the invariant its comment at `:195` asserts stops holding).

## 3. HIGH - unenumerated readers of `participants[].name` that reach a phone's lock screen

Section 3.1 builds a reader table for `participant_display_name` and uses "two
of which reach a phone's lock screen" as the argument for urgency. There is no
equivalent table for `participants[].name`, and S2's "five read boundaries, all
server-side" misses these:

- `app/src/routes/webhooks/twilio.ts:1810` - the inbound-message push TITLE for
  a native group thread is `groupThreadLabel(thread.participants)`: stale roster
  names, straight to a device.
- `app/src/routes/webhooks/twilio.ts:1815` - the push SENDER label is
  `(thread.participants ?? []).find(p => p.phone === senderE164)?.name`.
- `app/src/routes/webhooks/voice.ts:112-117` (`maskedPartyLabel`) - the relay
  call party label returns `member.name` first; its own docblock at
  `app/src/routes/webhooks/voice.ts:113` says "`name` is the roster-cached
  display name (resolved at member-add time)". This is caller identity on a
  ringing phone.

These are the same class of surface the spec used to justify the work, and the
spec's own risk row ("Hidden reader we did not sweep") points at the section 3.1
table and the S2 table as "the enumeration". Neither contains them.

## 4. HIGH - `routes/relayGroups.ts` already resolves relay roster names live and DELIBERATELY DROPS the stored name; that is the opposite of the spec's fallback rule, and the spec never enumerates it

Section 2: "Keep the stored copy as a last-resort fallback." Section 4.2: "a
missing key falls back to the stored name". Section 3.1: "live contact first,
stored copy as fallback. That precedence is already this repo's blessed
pattern."

`app/src/routes/relayGroups.ts:456-492` (`GET /api/conversations/:id/members`,
the relay thread's roster) does live-contact-first with NO fallback: it builds
`memberWithoutStoredName` by deleting `name` (`:474-476`), and on a contact
read failure returns that nameless member (`:483-491`, log text: "returning
roster phone without stored name"). The comment at `:471-473` states the rule
as policy: "Once a member has a contactId, never let that snapshot outrank
current contact state".

So the "blessed pattern" claim is false for the single largest reader of
`participants[].name`, and after this change the relay thread HEADER (hydrated,
falls back to the stored name) and the relay MEMBER PANEL (drops it) will
disagree on exactly the read-failure case section 4.2 spends a whole section
ruling on. The spec must either adopt one rule or state the divergence.

## 5. HIGH - section 9's deliverable is unexecutable as written

Section 9: "run `npm run perf:pages` against the hermetic lane and record N, the
number of DISTINCT contacts one `GET /api/today` resolves."

`perf:pages` is `tsx e2e/performance/cli.ts` (`package.json:47`). It is a
Playwright BROWSER-side network profiler: `e2e/performance/collect.ts:1-27`
imports `@playwright/test` devices and classifies observed HTTP request shapes;
`e2e/performance/routes.ts:240-320` is a catalog of endpoint + query-key tuples;
`e2e/performance/report.ts` aggregates those samples. Nothing in it instruments
`contactsRepo.getById`. It can tell you that the dashboard issued one
`GET /api/today`; it cannot tell you how many contact reads the server issued
inside it.

IMPLIES: section 9 needs a different instrument (a repo-call counter in a test,
or the existing audit script), or the "measure, then resolve" task cannot be
executed and `today-contact-hydration-fan-out` will be closed on a number nobody
produced.

## 6. HIGH - section 8's re-point of `routes/inbox.ts` is a regression, and the trim/no-trim framing hides it

Section 8 frames the thirteen private helpers as differing only in whether they
trim before joining, and scopes the branch to re-pointing four of them onto
`contactDisplayName`, "each ... with a test asserting the trimmed result".

`app/src/routes/inbox.ts:533-543` is not a trim variant. It has an EXTRA
FALLBACK RUNG the canonical helper does not: after the first/last join fails it
reads `contact.name` (`app/src/routes/inbox.ts:541-542`, "A name may also live
in a single denormalized field on some records").
`app/src/lib/contactName.ts:67-73` has no such rung.

Re-pointing `inbox.ts` onto `contactDisplayName` therefore silently drops the
name of every contact whose name lives only in `.name`, and those rows fall
through to the phone - which is the exact bug this branch exists to fix, newly
introduced on a different surface. A test "asserting the trimmed result" will
not catch it.

## 7. MEDIUM - `routes/poolNumbersAdmin.ts` falsifies section 4's central mechanism claim

Section 4: "Every downstream label function - `groupThreadLabel`,
`relayThreadLabel`, `relayMemberLabels`, `describeRoster`, `composeIntroBody` -
keeps its exact signature and its exact tests. They simply receive correct
data."

`app/src/routes/poolNumbersAdmin.ts:109` calls
`relayMemberLabels(conv.participants)` on a raw conversation, at a boundary that
appears in no section of the spec. It will keep receiving STALE data. The
sentence is true only of the boundaries the spec chose to hydrate, which is a
much weaker claim than the one made.

`app/src/lib/rosterResolution.ts:216-228` (`resolveRoster`, source
`participants`) is a second such site: it copies `p.name` verbatim into every
`ResolvedMember`, and it has callers beyond `describeRoster`.

## 8. MEDIUM - the spec mandates the wrong batch primitive, against the repo's own written guidance

Section 2 and section 4.1 mandate `contactsRepo.getManyByIds`.
`app/src/repos/contactsRepo.ts:600-605` says, in the interface docblock:
"Prefer `getDisplaysByIds` when only a label is needed: same round trips, far
less data." Name resolution is the label case exactly.

Every existing read-time label hydration in the tree uses the projection:
`app/src/routes/api.ts:2152`, `app/src/routes/units.ts:970`, `:1167`, `:1262`,
`app/src/routes/broadcasts.ts:231`, `app/src/routes/aiRuns.ts:190`. The two
`getManyByIds` callers are the ones that need fields OUTSIDE the projection
(`app/src/routes/units.ts:354` reads `company`;
`app/src/routes/broadcasts.ts:654` re-fences on
`type`/`sms_opt_out`/`sms_unreachable`).

`DISPLAY_PROJECTION` (`app/src/repos/contactsRepo.ts:856-865`) carries
`firstName`, `lastName`, `phone`, `deleted_at` - everything section 4.1 needs.
`app/src/routes/units.ts:113-129` already demonstrates a name helper typed to
accept BOTH shapes, so the "contactDisplayName takes a ContactItem" objection
has a worked precedent in-tree.

## 9. MEDIUM - "ONE `getManyByIds` per page" is not one round trip, and the pinned test measures the wrong quantity

Section 11's mitigation for inbox read amplification is "ONE `getManyByIds` per
page, pinned by a call-count test", and section 10 pins "ONE `getManyByIds` per
page regardless of member count (assert the call count)".

`app/src/repos/contactsRepo.ts:823` chunks at 100 unique ids per
`BatchGetCommand`, sequentially, and each chunk runs up to 4 attempts with
backoff (`:825-840`). One repo-method call over a 100-row inbox page of
multi-member groups is up to 20 sequential DynamoDB round trips. The
call-count assertion will be green while the amplification the risk row names
is unbounded in the dimension that matters.

IMPLIES: the risk row should state a key-count bound (or a page-level cap on
collected ids), and the test should assert unique-id count, not method-call
count.

## 10. MEDIUM - hydrating `GET /api/conversations/:conversationId` adds a batch read to an SSE-driven hot path, and section 11 does not name it

`app/src/routes/api.ts:1993-2001` is today a pure passthrough
(`res.json({ conversation })`) with ZERO contact reads, for EVERY thread header
including 1:1s. Section 5 S2 puts it in scope.

That route is refetched on a debounce per SSE tick:
`dashboard/src/routes/conversation/useGroupThread.ts:16` and
`dashboard/src/routes/conversation/useRelayThread.ts:437`. The tree already
records a production symptom from latency on a sibling per-tick read:
`dashboard/src/routes/conversation/GroupTextView.tsx:200-206` describes an alert
that "stopped rendering at all once latency exceeded the inter-tick gap".

Section 11 lists inbox amplification and relay hot path; it does not list the
thread-header route. It should.

## 11. MEDIUM - two of S4's three sites buy almost nothing, because the roster they read was written from the live contact moments earlier

S4 hydrates `app/src/jobs/relayFanOut.ts:634` (intro body, "once per group
creation") and `:685` (member-added body, "once per add").

Both compose from a roster whose names were written by `resolveMemberName`
(`app/src/services/relayMembers.ts:47-49`) on the add/create path itself -
`app/src/routes/relayGroups.ts:409`, `app/src/routes/tours.ts:1352`. The stored
name at intro time is at most seconds old and came from the same contact record
the hydration would re-read.

Only the sender prefix (`app/src/jobs/relayFanOut.ts:405`) is genuinely stale,
because it is read for the LIFE of the group. That is also the one site that
adds a per-message read.

IMPLIES: S4's cost/benefit is inverted relative to how it is presented. If the
intro/member-added hydration stays, the spec should say what drift it is
catching (a rename between provisioning and the intro job firing) rather than
implying the general staleness case.

## 12. MEDIUM - section 5 S1's client note contradicts section 4, and its stated contingency is impossible

Section 4: "**No client change is needed anywhere**".
Section 5 S1: "the build must CONFIRM that with a test rather than assume it,
and if it is live, the client falls back to the server `who`."

Both cannot hold, and the contingency is incoherent on the facts:
`dashboard/src/routes/today/buildToday.ts:1-2` and `:22-25` state it is the
CLIENT-SIDE FALLBACK, "used only when GET /api/today 404s".
`dashboard/src/routes/today/useToday.ts:54-75` confirms: the server response is
used when it succeeds, and `buildTodayFromSources` runs only in the catch. On
the only path where `conversationWho` (`buildToday.ts:103-107`) executes there
IS no server `who` to fall back to.

Separately, section 4 names `dashboard/src/lib/groupThread.ts` among mirrors
that "read server-computed values"; it does not - it computes the title
client-side from `header.participants`, which section 5 S2 itself says. The fix
reaches it because the DATA is hydrated, not because the value is
server-computed.

## 13. MEDIUM - section 4.2 is a slogan: the ruling is inherited, not argued

The heading is "THE ABSENCE-AMBIGUITY RULING (argued, not inherited)".

`app/src/repos/contactsRepo.ts:790-804` already makes this exact ruling, in
these terms: default best-effort drops unread keys and returns a short map -
"Right for display enrichment - a row renders without a name"; `requireComplete`
is "For callers where an absent key changes an outcome rather than a label - the
broadcast send path". `app/src/repos/contactsRepo.ts:543-550` says the same
about `IncompleteBatchReadError`.

The spec's ruling is the documented default, reached by the documented
reasoning. Calling it "argued, not inherited" misrepresents where the decision
lives and invites a reviewer to re-litigate settled repo policy.

Related: section 4.1 says `hydrateConversationRosters` "Never throws: a failed
batch yields the input unchanged". Without `requireComplete`,
`app/src/repos/contactsRepo.ts:841-844` swallows a chunk throw and returns a
SHORT map - it does not throw and does not yield the input unchanged. The
section 10 test "a throwing batch yields input unchanged" therefore exercises a
path only a stub can produce, and no test covers the real degradation (a short
map).

## 14. MEDIUM - section 8's count is wrong, its table is incomplete, and one entry is not a copy at all

"The issue says six private copies. There are thirteen".

The table lists twelve sites: `routes/contacts.ts:480`,
`lib/rosterResolution.ts:145`, `routes/units.ts:125`,
`services/groupMembers.ts:93`, `services/relayMembers.ts:41`,
`routes/api.ts:2158`, `services/groupConvert.ts:226`, `lib/voiceMasking.ts:47`,
`routes/inbox.ts:536`, `routes/today.ts:224`, `jobs/placementNudges.ts:147`,
`routes/api.ts:2081`.

It omits `app/src/services/inboundEmail.ts:400-405` - which the canonical
helper's own scope guard names explicitly at
`app/src/lib/contactName.ts:52-60`.

And `app/src/lib/voiceMasking.ts:46-53` (`contactShortName`) is NOT this
derivation: it returns "First L." (surname abbreviated to an initial) and
returns the surname alone when there is no given name. It is a deliberately
different masking rule, not a consolidation candidate. Counting it inflates the
number the spec is about to write into the issue file.

## 15. MEDIUM - the section 8 re-points reach beyond the surfaces this spec scopes

Section 8 re-points `routes/today.ts:224`. That helper is `nameFromContact`
(`app/src/routes/today.ts:221-228`), and it is consumed by `resolveContactLabel`
(`app/src/routes/today.ts:370-373`), which produces `who` for placement rows
(`:448`, `:497`, `:522`), tour rows (`:554`) and AI-suggestion rows (`:961`) -
none of which this spec touches. Changing the join rule there is a behavior
change on four Today surfaces outside S1's scope. The spec presents the
re-points as confined to "files this spec already edits", which is true of the
FILE and false of the SURFACES.

## 16. LOW - two miscitations in load-bearing paragraphs

- Section 3.2: "The fan-out also finds threads by the contact's CURRENT phone
  (`routes/contacts.ts:1741`)". `app/src/routes/contacts.ts:1741` is
  `findByParticipantEmail`. The phone lookup is
  `app/src/routes/contacts.ts:1738`.
- Section 6.2: "`routes/contacts.ts:1170` documents that there is NO
  member->conversation index". `:1170` is `const contactId = String(...)`. The
  documenting comment is `app/src/routes/contacts.ts:1158-1168`, and it says the
  route reads TWO relay status partitions, not three.

Both claims are substantively correct; the line numbers are not. In a spec whose
authority rests on "verified against main @5ce9912f" that matters.

## 17. LOW - section 11's blast-radius row contradicts S4 and ignores the pushes

Row: "S4 fixes the intro + member-added bodies, the two paths that carry names
into delivered messages."

S4 itself lists THREE sites, the third being the per-message sender prefix
(`app/src/jobs/relayFanOut.ts:405`), which carries a name into every relayed
message via `composeRelayBody` and into `relay.media_only` via `senderLabel`
(`:412-417`). And the push titles at `app/src/routes/webhooks/twilio.ts:1810`
and `:1815` carry names to a lock screen and are not fixed at all (finding 3).

## 18. LOW - S4 does not gate the new sender read on the override

Section 5 S4 says the sender prefix becomes "A single
`contacts.getById(senderMember.contactId)`, falling back to
`senderMember?.name`", and separately that "`payload.senderNameOverride`
continues to win outright".

`app/src/jobs/relayFanOut.ts:405` shows the override is checked FIRST today and
a team message has no `senderMember` at all (`:401-404`, "senderKey matches
nobody"). A literal build of S4 adds a contact read on the hot path whose result
is discarded for every team message. Say "read only when the override is absent
and `senderMember.contactId` is non-empty".

## 19. LOW - seed surfaces the spec does not enumerate

`app/src/lib/seed/performance.ts:842` stores
`participant_display_name: 'Synthetic participant NNNN'` on 1:1 rows whose
`participants[0].contactId` (`:843`) points at a real seeded contact with an
ordinary first/last name. `:857-858` store roster names `'Synthetic tenant'` /
`'Synthetic landlord'` against real contact ids.

Under S1 and S2 every one of those labels changes in the performance lane - the
same lane section 9 tells the builder to drive. The spec's test section names no
seed or fixture work.

(`app/src/lib/seed/lean.ts:249-269` and `app/src/lib/seed/cast.ts:479-487`,
`:729-737` are consistent with their contacts, so lean/full are unaffected; the
`matrix` profile derives roster names from the contact at seed time,
`app/src/lib/seed/matrix.ts:1109-1111`.)

## 20. LOW - the spec lifts an explicit in-code scope guard without saying so

`app/src/lib/contactName.ts:50-60` states that `contactDisplayName` "is consumed
by PUSH-COPY sites only" and, verbatim, "do not re-point them here as a
drive-by", naming `docs/issues/consolidate-contact-display-name-helpers.md` as
the tracking issue.

Sections 5 S1 and 8 do exactly that re-pointing. That may well be the right
call, but the spec neither quotes the guard nor says it is being retired, so the
first builder to open `contactName.ts` will find the spec and the code giving
opposite instructions. The guard comment needs to change in the same branch.

---

## Verified-correct claims (so a later reader does not re-check them)

- Section 3.1's reader table: `app/src/routes/today.ts:1076`,
  `app/src/routes/webhooks/twilio.ts:1043` and `:2285`,
  `app/src/routes/webhooks/voice.ts:159`, `app/src/routes/api.ts:457`,
  `app/src/lib/events.ts:103`, `dashboard/src/routes/today/buildToday.ts:106`.
  All present as described.
- The push precedence claim: `app/src/routes/webhooks/voice.ts:154-168` and
  `app/src/routes/webhooks/twilio.ts:1042-1049` are
  `contactDisplayName(contact) ?? non-empty snapshot ?? formatted phone`.
- Section 3.2's `participant_display_name` writers:
  `app/src/routes/contacts.ts:1753`, `app/src/jobs/placementNudges.ts:554`,
  `app/src/routes/contacts.ts:1871`.
- Section 3.3's zero-new-reads premise for S1: `app/src/routes/today.ts:743`
  gates on `isDeletedContact(ownerId)` -> `getContact`
  (`app/src/routes/today.ts:377-380`, `:356-369`), the memo caches `undefined`
  too (`:358`, `:367`), and the emit loop at `:777-778` runs over rows that all
  passed that gate. A contact fetched there is a cache hit at `who` time.
- Section 3.3's People-card claim: `app/src/lib/rosterResolution.ts:511` reads
  the contact and `:544-545` has the precedence backwards exactly as described.
  The `removed` guard at `:522` is as the spec says.
- Section 5 S2's boundary line numbers: `app/src/routes/inbox.ts:1237`, `:2358`,
  `:1154`, `:2293`, `:1418`; `groupRowFor` at `:1190` is synchronous.
- Section 5 S4's line numbers: `app/src/jobs/relayFanOut.ts:405`, `:634`,
  `:685`.
- Section 5 S5: `app/scripts/measure-unread-contact-coverage.ts:510` does skip
  `relay_group` / `group_text` outright.
- Section 6.3: no dashboard consumer patches names from the SSE payload's
  `members`; `dashboard/src/api/EventStreamProvider.tsx:176-178` dispatches and
  the thread hooks debounce-refetch. `app/src/lib/events.ts:110` and `:117` do
  carry the raw roster, so the payload IS stale - the spec's reason for leaving
  it is sound.
- Section 6.4's tourReminders claim: `app/src/jobs/tourReminders.ts:1152-1162`
  reads `members.length` and `pool_number` only; no `.name` read anywhere in
  the file.
- Section 7's phone rationale: `app/src/lib/rosterResolution.ts:222-224` returns
  the STORED phone verbatim with that reasoning in the comment.
