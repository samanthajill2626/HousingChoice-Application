# Task 4 direct and webhook review adjudication

Reviewed commit: `eea8a4fe feat: record transport on direct message flows`

| Finding | Decision | Rationale |
| --- | --- | --- |
| P1 native-group generic literal MMS | Accepted | The current literal is factually correct but violates the approved ownership boundary. The route must consume an adapter-owned group-rail fact so future provider changes cannot turn generic webhook code into an unreviewed transport authority. |

The correction is in scope because Task 4 explicitly owns native-group inbound
branches. It must not expand into Task 7 native-group outbound or receipt behavior.
