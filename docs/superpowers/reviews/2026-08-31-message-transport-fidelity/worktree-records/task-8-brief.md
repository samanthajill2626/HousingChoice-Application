# Task 8: explicit non-live transport fixtures

Read the profile, AGENTS, approved spec, and Task 8 plan in full. Own only the files Task 8 lists: import compatibility, `app/src/lib/seed/messageTransport.ts`, affected seed builders/tests, dev fixture/test, fake-twilio signer/types/engine/control/tests, and e2e fake DTO. Do not touch runtime direct/relay/group writers or dashboard projection/UI.

Imports remain schema-absent with no facts. Every new seed carrier row declares, never infers, versioned facts through `withSeedTransport`; that helper cannot inspect type/body/media/conversation. Retain named legacy rows. Dev fixture validates explicit legacy/versioned transport inputs using the same domain rules; default remains versioned inbound SMS with no pointer. Fake Twilio propagates explicit evidence through signed callback paths; never fabricate SMS/MMS ChannelPrefix and serialize metadata once. Standard callbacks use stored E164 endpoints and valid SM/MM SIDs.

Write red tests then run the two focused test commands and all three app/fake/e2e typechecks exactly in Task 8 plan. No broad gates/e2e. Stage explicit paths; commit `test: make transport evidence explicit in fixtures` with Codex trailer. Report `W:\tmp\message-transport-fidelity\.superpowers\sdd\task-8-report.md`.
