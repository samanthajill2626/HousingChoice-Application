---
id: deleted-contact-web-signup-silent
title: A soft-deleted person who re-signs-up on the public web form gets total silence
type: bug
severity: med
status: open
area: app
created: 2026-08-03
updated: 2026-10-21
refs: app/src/routes/public.ts:489-528, app/src/repos/contactsRepo.ts:666-693, app/src/services/sendMessage.ts:268-275, app/src/routes/inbox.ts:437-448
---

**Problem.** POST /public/housing-fair (app/src/routes/public.ts:425) is the one
public contact-creating flow - it backs both the /join intake page and the flyer
"I'm interested" CTA (dashboard/src/routes/public/publicApi.ts:92). Traced
against the live code, a person whose contact was soft-deleted and who then
re-signs-up with the same phone gets nothing at all, and no one is told:

1. public.ts:489 dedupes with contacts.findByPhone, which does NOT filter
   soft-deleted records (contactsRepo.ts:666-693 - the deleted scope only exists
   on the list queries, ListContactsOpts.deleted). So the deleted contact IS
   found: no duplicate contact is created, and nothing un-deletes it. There is no
   restore anywhere on this path.
2. Because the create branch is skipped, the fresh A2P/CTIA consent the form just
   collected is NOT recorded - consent_method: 'web_form', consent_at and
   consent_version are only stamped on CREATE (public.ts:572-574), as are
   capture_source / unit_of_interest. The signup and its flyer attribution leave
   no mark on the contact record.
3. The welcome text goes through the gated sendMessage (public.ts:599-603,
   automated: true), so as of the deleted-contact resurfacing feature
   (2026-08-03) it is refused with contact_deleted (sendMessage.ts:268-275). The
   route catches SendRefusedError, warn-logs it and still returns { ok: true }
   (public.ts:609-619, :752) - the browser shows the normal thank-you. Before
   that gate this person received the welcome text.
4. Nothing resurfaces them in the dashboard. The inbox exception needs the NEWEST
   message on the thread to be an INBOUND stamped after deleted_at
   (inbox.ts:437-448); a web signup writes no inbound message, so there is no
   inbox row and no Deleted chip. They remain excluded from the contact lists and
   from Today.

Net: the person filled in a consent-bearing public form, saw a thank-you, and is
now waiting for a text that will never arrive; staff have no signal anywhere in
the product. The only trace is the audit entry (public.ts:496) and a warn log.
This is a real, silent behavior change on a consent/spend path introduced by the
send gate - the gate itself is correct, the public flow's handling of it is not.

**Update (2026-10-21, `feat/flyer-leads`): the deleted path is now explicit,
and quieter.** Point 3 and the middle sentence of the "Net" paragraph ("The
only trace is the audit entry ... and a warn log.") no longer hold; that
paragraph's other two sentences still stand. (The public.ts line refs in
this file were refreshed to the flyer-leads tree on 2026-10-21; the refs
into other files are as filed.)
POST /public/housing-fair still resolves the phone with
contacts.findByPhone (point 1), and a SOFT-DELETED holder is still neither
restored nor given the form's consent (point 2). But since flyer-leads
(spec docs/superpowers/specs/2026-10-21-flyer-leads-design.md D4, D5) the
route stops at that holder: it writes no conversation, attempts no send -
so there is no contact_deleted refusal and no welcome-refused WARN line any
more; only a contact the request CREATED is ever welcomed - and records no
sign-up pin, unread mark or properties-sent entry. It still answers
{ ok: true } (the visitor sees the normal thank-you; the flyer's button
reads "Sign up" now) and still writes the housing_fair_signup audit event
on that contact's entity (contacts#<id>), now with deletedContact: true,
recorded: false, sentRecorded: false and sentSkipped: 'deleted', and it logs
the INFO line "housing-fair signup captured" with deletedContact: true.
That audit row and that log line are the only traces - nothing reaches the
dashboard; point 4 stands (no inbox row, no Deleted chip). On a
legacy phone shared with a live contact, a deleted FIRST holder takes this
path too (spec D4 residual). A LIVE contact's sign-up, by contrast, now pins
"Signed up ..." in their thread and marks it unread (GLOSSARY "signed up"),
so option (b) below has a ready mechanism; flyer-leads deliberately left the
deleted case to this issue.

**Suggested fix.** Product call first - the plausible options are (a) treat a
fresh web-form signup as an implicit restore (un-delete, stamp the new consent,
send the welcome), (b) leave the contact deleted but surface the signup
somewhere staff actually look (the unmatched/triage queue, or an inbox row),
or (c) keep the silence but make it honest by returning a distinct response the
public page can render. In all three cases the freshly-collected consent fields
should probably be recorded on the existing contact rather than dropped.
