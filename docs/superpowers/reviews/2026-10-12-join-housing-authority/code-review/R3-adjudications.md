# Code review round 3 (terminal, micro wave only) - adjudications (orchestrator)

Scope: the micro wave after round 2 (c8ec57c2 `visibleName` escapes every Unicode Cc/Cf/Zl/Zp
character in operator-report names + test; e05dab52 one RUNBOOK sentence). Report:
`R3-micro-review.md` (fresh reviewer). Result: 0 MEDIUM+, so the review loop CLOSES under the
stated rule (LOW/INFO is filed or noted; only a MEDIUM+ defect from this wave reopens).

Verified by R3: an exhaustive sweep of every code point 0..0x10FFFF through the script's own
functions (Node 24, Unicode 17): 237 Cc/Cf/Zl/Zp points escaped, all to printable ASCII; no
bidi control or line terminator left raw; ordinary names print unchanged; the new test fails
on the pre-fix script (scratch copy via alias config: 1 failed / 75 passed, only the new case)
and passes on the current one (76/76); no literal backslash-u, no `u{`, no non-ASCII byte in
either changed file; the RUNBOOK sentence matches `extraction/prompt.ts:33-40` and
`extraction/apply.ts:299-316`.

| Id | Sev | Disposition |
|---|---|---|
| R3-1 | INFO | NOTED. The doc comment's "emoji prints as it is" is not true of ZWJ sequences or tag flags (their ZWJ/tag characters are Cf and now print escaped). Errs safe; wording only; not worth a code commit and a full gate re-run. |
| R3-2 | INFO | NOTED. Right-to-left LETTERS (not controls) still print raw and can reorder text in a bidi-applying viewer, but cannot reverse or forge the contactId (it is ASCII and separated). Accepted. |
| R3-3 | INFO (pre-existing) | NOTED. Typed text can imitate report fields on the same line (a typed backslash is not escaped); it cannot start a new line. The names are a recognition aid, and the operator copies the trailing contactId. Accepted. |
| R3-4 | INFO | NOTED. Invisible but harmless characters stay raw. Accepted. |
| R3-5 | INFO | NOTED. For an authority NOT on the list the code itself turns a write into a suggestion (stronger than the RUNBOOK's "instructed"); for an on-list conflicting authority the prompt rule is what applies, which is the case the sentence describes. Accepted as worded. |

Review loop: R1 (conformance + plan-blind adversarial) -> fix wave 1 (6) -> R2 (fresh) ->
micro wave (2) -> R3 (fresh, terminal). CLOSED.
