---
id: regular-group-texting-for-imported-groups
title: Build regular (native) group texting so the founder's 132 imported group chats continue
type: improvement
severity: high
status: open
area: app/messaging
created: 2026-08-09
refs: app/src/lib/import/apply.ts, app/src/repos/conversationsRepo.ts, docs/superpowers/specs/2026-08-05-quo-airtable-import-design.md
---

**Problem.** The founder runs 132 multi-party group texts from her phone today -
carrier group MMS, where every member sees every reply on her real number. The
import brings all 132 across with full history, but the app's only multi-party
primitive is the RELAY group: a pool number fronts the thread and members see
that pool number, not hers. That is a different product than what she and her
landlords/tenants are used to, and the decision (Cameron, 2026-08-09) is that
the existing groups must CONTINUE as regular group texts - all of them, not a
picked subset.

**Decision context.** The earlier plan asked her to choose which groups to
"connect" as relay groups on day one. That question is retired: the workbook's
groups tab now defaults every group to continuing and offers only an exclusion
column (`drop`). Import-side, the threads still land as `relay_group` /
`connecting` items (the only storage shape that exists today); this feature
decides what they become.

**Split (2026-08-09):** inbound DETECTION is carved out as its own issue,
`inbound-group-mms-detection`, per Cameron: it must exist regardless of outbound
("we need to see if someone adds us to a group text... I didn't realize that was
a blind spot"). This issue is now the OUTBOUND half - sending to the group so
every member sees one thread.

**What building it means (sketch, not a spec).**

- On mechanism, Cameron's expectation (2026-08-09): plain group MMS, "like it is
  with regular group texts (pre-RCS)" - no special product. That is right about
  the WIRE (carrier group texts are MMS with a multi-recipient envelope), but the
  open question is the API: Twilio's standard send takes one recipient per
  message, and same-body-to-N-numbers is N separate 1:1s, NOT a group (members
  do not see each other - that is today's behaviour, and the exact thing this
  feature exists to avoid). Emitting a true multi-recipient MMS envelope is what
  Twilio's Group Texting capability provides. VERIFY FIRST: its GA/beta status,
  pricing, participant cap, and campaign/A2P interaction - her groups are 2-4
  outside members plus her, which should fit. If the capability cannot carry
  this, the feature needs a different design entirely.
- A new conversation shape or a variant of `relay_group` (`group_native`?) so
  the inbound webhook, fan-out, dashboard threads, unread counts and consent
  gates all know the difference between "masked relay" and "native group".
- A migration/upgrade path for the 132 imported `connecting` threads.
- The relay product remains for its own use case (masked placement coordination);
  this does not replace it.

**This is a full feature** - brainstorm/spec/plan pipeline, not a fix. Filed so
the import work can land without blocking on it, and because the cutover moved
to **2026-08-17**, which is the date this needs to be working (or have an agreed
interim behaviour for group inbound on the ported number).

**Interim risk moved:** the inbound-side risk (group MMS arriving before any of
this exists, forking on reply) now lives with `inbound-group-mms-detection`,
which is the piece that must land first.
