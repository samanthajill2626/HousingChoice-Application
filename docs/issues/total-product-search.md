---
id: total-product-search
title: Total product search - one search across contacts, messages, units, placements, tours
type: improvement
severity: med
status: open
area: app
created: 2026-07-20
refs: docs/superpowers/specs/2026-07-20-email-channel-requirements-design.md
---

**Problem.** There is no cross-record search anywhere in the product. The inbox
is filter-tabs over a single byLastActivity query; contacts/units/placements
have typeaheads scoped to their own pickers; message bodies, call transcripts,
subjects, and attachment filenames are not searchable at all. As channels
accumulate (SMS, voice transcripts, and the planned email channel - see the
2026-07-20 email requirements spec, which explicitly moved search OUT of email
v1 and into this issue), staff increasingly need one search box that answers
"where did I see that?" across the whole product.

Scope when picked up: a product-wide search over contacts, conversations and
message content (SMS/MMS bodies, voice transcripts, email subjects + bodies +
attachment filenames), units, placements, and tours - with results deep-linking
to the owning record/thread. Indexing approach (DynamoDB-side denormalized
index vs an external search engine) is an open design decision.

**Suggested fix.** None committed yet. Interim obligation on other features
(email v1 especially): store content search-ready - extracted plain-text
bodies, subjects, and attachment filenames persisted as queryable attributes -
so indexing later is a backfill, not a re-parse.
