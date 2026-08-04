---
id: deleted-contact-web-signup-silent
title: A soft-deleted person who re-signs-up on the public web form gets total silence
type: bug
severity: med
status: open
area: app
created: 2026-08-03
refs: app/src/routes/public.ts:245-318, app/src/repos/contactsRepo.ts:666-693, app/src/services/sendMessage.ts:268-275, app/src/routes/inbox.ts:437-448
---

**Problem.** POST /public/housing-fair (app/src/routes/public.ts:209) is the one
public contact-creating flow - it backs both the /join intake page and the flyer
"I'm interested" CTA (dashboard/src/routes/public/publicApi.ts:92). Traced
against the live code, a person whose contact was soft-deleted and who then
re-signs-up with the same phone gets nothing at all, and no one is told:

1. public.ts:245 dedupes with contacts.findByPhone, which does NOT filter
   soft-deleted records (contactsRepo.ts:666-693 - the deleted scope only exists
   on the list queries, ListContactsOpts.deleted). So the deleted contact IS
   found: no duplicate contact is created, and nothing un-deletes it. There is no
   restore anywhere on this path.
2. Because the create branch is skipped, the fresh A2P/CTIA consent the form just
   collected is NOT recorded - consent_method: 'web_form', consent_at and
   consent_version are only stamped on CREATE (public.ts:272-277), as are
   capture_source / unit_of_interest. The signup and its flyer attribution leave
   no mark on the contact record.
3. The welcome text goes through the gated sendMessage (public.ts:297-301,
   automated: true), so as of the deleted-contact resurfacing feature
   (2026-08-03) it is refused with contact_deleted (sendMessage.ts:268-275). The
   route catches SendRefusedError, warn-logs it and still returns { ok: true }
   (public.ts:307-317, :336) - the browser shows the normal thank-you. Before
   that gate this person received the welcome text.
4. Nothing resurfaces them in the dashboard. The inbox exception needs the NEWEST
   message on the thread to be an INBOUND stamped after deleted_at
   (inbox.ts:437-448); a web signup writes no inbound message, so there is no
   inbox row and no Deleted chip. They remain excluded from the contact lists and
   from Today.

Net: the person filled in a consent-bearing public form, saw a thank-you, and is
now waiting for a text that will never arrive; staff have no signal anywhere in
the product. The only trace is the audit entry (public.ts:322) and a warn log.
This is a real, silent behavior change on a consent/spend path introduced by the
send gate - the gate itself is correct, the public flow's handling of it is not.

**Suggested fix.** Product call first - the plausible options are (a) treat a
fresh web-form signup as an implicit restore (un-delete, stamp the new consent,
send the welcome), (b) leave the contact deleted but surface the signup
somewhere staff actually look (the unmatched/triage queue, or an inbox row),
or (c) keep the silence but make it honest by returning a distinct response the
public page can render. In all three cases the freshly-collected consent fields
should probably be recorded on the existing contact rather than dropped.
