---
id: email-route-500-on-contactless-conversation
title: POST /api/conversations/:id/email 500s (Dynamo empty-key) when the conversation has no contactId
type: bug
severity: low
status: open
area: app
created: 2026-08-03
refs: app/src/services/sendEmailMessage.ts, app/src/routes/api.ts
---

**Problem.** Found probing the deleted-contact send guards (2026-08-03
self-QA, pre-existing at base 8527f91d): POST /api/conversations/:id/email
against a conversation that has NO contactId attribute (e.g. the lean seed's
phone-keyed conv-0001) reaches the email send service with an empty
contactId, and contacts.getById('') throws DynamoDBServiceException ("The
AttributeValue for a key attribute cannot contain an empty string value.
Key: contactId") -> unhandled -> 500 internal server error. Expected: a 4xx
(400/404/409) refusal for "this conversation cannot take email" before any
repo call. The deleted-contact-resurfacing branch did not touch the contact
resolution - its gate sits after the load and never runs on this path.

**Suggested fix.** Validate the conversation's contactId (present, non-empty)
in the email route/service before the contact load and refuse with a typed
4xx; add a route test alongside the EMAIL_REFUSAL_STATUS table cases.
