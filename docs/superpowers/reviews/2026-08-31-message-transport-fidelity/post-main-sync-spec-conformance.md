# Post-main-sync spec-conformance review

Date: 2026-09-02

Reviewed state: staged merge index while `MERGE_HEAD` is active. The index was
reviewed against both the pre-merge feature `HEAD` and incoming `main`; no
working-tree-only content was treated as authoritative. No source was edited
and no test suite was run.

## Verdict

PASS - 0 P1, 0 P2, 0 P3 findings.

## Merge-sensitive checks

1. Relay fan-out preserves both main's durable continuation budget and the
   transport feature's hard legacy branch. The handler chooses the
   schema-absent path before versioned preflight or transport writes
   (`app/src/jobs/relayFanOut.ts:791`). The merged execution claims the durable
   source-message pass before sends for either path (`app/src/jobs/relayFanOut.ts:1091`),
   while only the versioned path initializes and updates aggregation state
   (`app/src/jobs/relayFanOut.ts:1020`, `app/src/jobs/relayFanOut.ts:1179`).
   Thus the new fanout-attempt scalar is not a transport migration and cannot
   turn an in-flight schema-absent source into a versioned preflight failure.

2. The durable claim implementation is top-level and independent of whole-slot
   recipient writes (`app/src/repos/messagesRepo.ts:1443`,
   `app/src/repos/messagesRepo.ts:3373`). This preserves main's continuation
   cap while leaving the feature's version-gated actual and recipient transport
   writes intact (`app/src/repos/messagesRepo.ts:2986`,
   `app/src/repos/messagesRepo.ts:3162`, `app/src/repos/messagesRepo.ts:3237`).
   In particular, a schema-absent source still gets `legacy_noop` from every
   transport-only repository operation rather than aborting the send.

3. The merged Relay close path uses `persistRelayRecipientResult`, so a
   versioned close preserves requested and actual subfields through the
   child-field result operation, while a legacy close uses the established
   legacy delivery update (`app/src/jobs/relayFanOut.ts:1060`,
   `app/src/jobs/relayFanOut.ts:1283`). No full recipient-slot replacement was
   introduced on the versioned path.

4. Message transport projection survived main's contact-timeline reminder work.
   The staged mapper still passes each optional version, requested, and actual
   value through without defaults or inference (`app/src/routes/contactTimeline.ts:423`).
   Dashboard API types still expose both message and recipient transport facts
   (`dashboard/src/api/types.ts:1694`, `dashboard/src/api/types.ts:1769`).

5. Main's Timeline changes retain the pure transport presenter and legacy
   discriminator. The merged bubble delegates the main chip to
   `presentMessageTransport` with the raw projected fields
   (`dashboard/src/routes/contact/Timeline.tsx:839`), and supplies recipient
   transport only on version-1 parents (`dashboard/src/routes/contact/Timeline.tsx:1116`).
   Main's new relay error presentation is scoped to delivery reason copy and
   does not alter transport selection; it uses the same filtered recipient
   collection for counts, rows, and staleness (`dashboard/src/routes/contact/Timeline.tsx:902`,
   `dashboard/src/routes/contact/deliveryStatus.ts:407`).

6. Reminder supersession survived without touching carrier transport behavior.
   The merged reminder worker creates generation-tagged rows and keeps the
   pre-migration exemption in the shared pointer check
   (`app/src/jobs/tourReminders.ts:455`, `app/src/jobs/tourReminders.ts:1184`).
   Contact and Relay upcoming projections add only reminder suppression states;
   they retain message transport projection independently
   (`app/src/routes/contactTimeline.ts:1040`, `app/src/routes/relayGroups.ts:342`).

7. Main's seed and durability changes do not reclassify legacy carrier history.
   The staged transport fields remain optional on stored messages
   (`app/src/repos/messagesRepo.ts:949`), and the merge introduces no transport
   backfill or migration. The feature's explicit fixture/seeding contract is
   therefore unchanged.

## Result

The resolved index preserves the approved requested/actual transport contract,
the keep-legacy discriminator, Group MMS/relay presentation behavior, and the
new main-side fanout, reminder-supersession, and relay-error functionality. No
source change is requested from this review.
