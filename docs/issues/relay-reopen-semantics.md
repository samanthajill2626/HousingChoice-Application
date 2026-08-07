---
id: relay-reopen-semantics
title: Reopening a closed group is a bare status flip - define reopen semantics (incl. the never-introduced member)
type: decision
severity: med
status: open
area: app
created: 2026-08-05
refs:
---

**Problem.** Reopening a closed relay group today is a pure status flip: no
confirm, no preview, no notice to the members. The contact-rosters feature
makes this sharper in two ways. First, the card now EDITS closed threads'
participants (roster edits on a closed thread are legal and silent). Second,
the spec's section 7 carve-out makes an add to a CLOSED thread
silent-and-immediate - so a later reopen yields a member the group was never
told about: nobody was announced, and the first thing that person sees is a
live group they were never introduced to (and the group sees an uninvited
stranger). The scope of this issue is reopen SEMANTICS - who gets told what
when a closed group comes back - not merely whether a confirm dialog exists.
Filed per the contact-rosters spec (section 12).

**Suggested fix.** Give reopen the same server-composed preview treatment as
open/add: a confirm showing the CURRENT participant set, with an
intro/reintroduction body for members added while closed (the
never-introduced set is computable: participants with no relay.intro or
relay.member_added milestone on this thread). Decide whether reopen
announces to everyone or only to never-introduced members.

**Update (2026-08-05, fix-wave adjudication).** One more asymmetry belongs to
this decision: a placement whose `group_thread` points at a CLOSED relay can
be re-opened by a FORCED open (201) while the deferred form of the identical
click is retired by the poller as a `group_closed` skip - route and poller
disagree about whether "open" may mean "reopen". The fix wave pinned the
actual behavior in a test rather than inventing parity; resolve it here when
reopen semantics are decided.
