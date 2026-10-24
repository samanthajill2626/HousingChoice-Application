---
id: landlord-conversation-extraction-to-property
title: Facts learned in landlord conversations have no path onto the property record
type: improvement
severity: med
status: deferred
area: app
created: 2026-10-24
refs: app/src/services/extraction/schema.ts:23, app/src/services/extraction/runTypes.ts:5, app/src/lib/requirements.ts:201
---

**Problem.** Conversation fact extraction reads a conversation and writes only
contact-level targets: the eight tenant profile fields plus address, status,
type and phone. Nothing it produces lands on a unit. A landlord's recorded
requirements reach a property only when staff press "Apply to properties"
(the copy-only rule, GLOSSARY). So when a landlord or property manager tells
staff a unit has a ramp, washer/dryer hookups, or which utilities the tenant
pays, the only path onto the property record is staff typing it. The WP1
matching ranker reads the property record, so the property card is only as
rich as manual entry makes it. Named by Cameron during the WP1 charter
brainstorm (2026-10-24): "the information actually comes from the landlord."

**Suggested fix.** Run extraction on landlord and property-manager
conversations with PROPERTY targets: structured unit fields where they exist
(accessibility, pets, utilities, rent, payment standard, voucher sizes) plus
the open-ended matching-facts list the WP1 charter adds for tenants. Proposed
facts land as suggestions staff accept, like tenant suggestions today. The
address named in the conversation picks the property when the landlord has
several; with none named the fact parks on the landlord record and reaches
properties through "Apply to properties". Cameron's placement: part of
landlord/property onboarding and possibly the sharing step - Work Package 3
or 4, not WP1. Until then the WP1 charter keeps a switch to include the
landlord-of-record's recorded facts in the property card.
