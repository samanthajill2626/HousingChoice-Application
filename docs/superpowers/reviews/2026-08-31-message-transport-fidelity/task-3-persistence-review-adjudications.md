# Task 3 persistence review adjudications

Reviewed commit: `52a924d7 feat: persist versioned message transport facts`

| Finding | Decision | Rationale |
| --- | --- | --- |
| P1 terminal error cleanup | Accepted | The plan limits cleanup to successful results and protects terminal delivery diagnostics. A duplicate failed callback without a code must not remove a retained provider error. |
| P2 final conditional reclassification | Accepted | Spec section 8.6 and plan Task 3 require a conditional race to be consistently re-read and classified, including the final race. |
| P2 stale RCS observability | Accepted | Spec section 8.5 requires the expected RCS-after-fallback ordering to be a safe info/debug event, not a silent outcome or a warning. |

All three findings are in scope for one focused Task 3 fix wave. The two test fake
stub updates remain justified by app typecheck and require no separate correction.
