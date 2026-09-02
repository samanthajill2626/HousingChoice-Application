# Task 9: transparent authenticated projection and dashboard type mapping

Read the profile, AGENTS, approved spec, Task 9 plan, and projection/mapping worklist. Own only the Task 9 files listed in the plan. Do not modify presentation/chip rendering, writers, seeds, or e2e flows.

Server JSON must transparently copy optional message `transport_schema_version`, `requested_transport`, `actual_transport` and recipient requested/actual/aggregation facts; omit absent values and never infer from type. Calls/email stay unchanged. Preserve raw conversation passthrough if current main is raw.

Dashboard types must exactly mirror the literal union locally, without app import. All contact, relay, group, newest/older merge and SSE refetch mappers preserve facts. Local optimistic timeline items carry only `optimistic:true` and no transport; resolve keeps optimistic until server refetch.

Write failing focused app/dashboard tests then run all exact Task 9 focused tests and app/dashboard typechecks. No broad gates/e2e. Explicit stage only; commit `feat: project message transport to the dashboard` with Codex trailer and report `.superpowers/sdd/task-9-report.md`.
