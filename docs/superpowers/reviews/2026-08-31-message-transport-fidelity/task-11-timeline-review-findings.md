# Task 11 Timeline review findings

## Reviewed commit

`edc9865c feat: show requested and actual message transports` against `6f2f38b6`.

## P2: Legacy recipient disclosure falsely claimed Unknown transport

Timeline unconditionally appended the recipient presenter result to every included
row. Because schema-absent historical recipient slots contain neither transport fact,
the shared presenter returned `Unknown` when a legacy Relay disclosure was opened.
The parent message correctly retained its legacy `SMS` chip, but its `Delivered` or
`Sent - not confirmed` recipient text and accessible name gained an unsupported
`Unknown` claim. The schema version at the parent-message boundary must suppress
recipient transport only for legacy rows while preserving version-1 unresolved
`Unknown` semantics.
