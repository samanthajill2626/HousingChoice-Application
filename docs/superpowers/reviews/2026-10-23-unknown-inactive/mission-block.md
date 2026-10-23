# MISSION: Inactive for every contact type (tracker #30)
Worktree: W:\tmp\unknown-inactive  Branch: feat/unknown-inactive  (cut from main @916258ae)
Profile: W:\tmp\unknown-inactive\.claude\feature-mission.profile.md
Spec: docs/superpowers/specs/2026-10-23-unknown-inactive-design.md (rev 3, APPROVED)
Plan: docs/superpowers/plans/2026-10-23-unknown-inactive-plan.md (v4 FINAL @d80ca08c)
Design review: spec R2, plan R3 - adjudications at docs/superpowers/reviews/2026-10-23-unknown-inactive/design-review/adjudications.md
Records: docs/superpowers/reviews/2026-10-23-unknown-inactive/ (slice reports under slices/, committed as produced)
Work map (build in order; plan section 2):
- Setup: `npm ci` at the worktree root (no node_modules yet); DynamoDB Local via `npm run db:start` (never restart it).
- S1 backend status model + contact writers (lists, statusLabelFor, create default, D7 type change + same-type guard, seeds; ALSO the Unknown-tab fixture flips per AR17)
- S2 transition route conditional write (409 contact_type_changed), consistent reads, the contact.updated event end to end, Today/Inbox/contact-page refetch
- S3 backend readers: isEligibleRecipient (D4.1), Today collect-loop skip (D5), inbox needsTriage + inactive wire field, Unknown-tab comments (S3.4 comment-only), inbound no-reset tests
- S4 dashboard contact page: status mirror + cross-workspace drift test, header dropdown for every type, edit form (statusType, BASE snapshot, save paths), labels/tone, "Type unknown" card
- S5 dashboard inbox: Inactive tag, compareUnknownTabRows on the Unknown tab only
- S6 e2e spec (spec test 8) + STATUS-MODEL.md / GLOSSARY.md + W3 record
- S7 one main sync, five bare gates, S7-gates.md
Watch items: plan section 3 W1-W8. In particular W1 (#31 has no branch as of 2026-10-23 - re-check at S3 and S7, read its PLAN not commits), W4 (any inbound writer that touches an existing contact's status is STOP-and-report), W6 (lean seed byte-stable), W8 (eventually consistent refetch - record only). Section 4 rulings AR1-AR24 win over slice text. AR21 (Contacts list non-tenant rows: plain-text status, no new badge) is the default; the planner relays any change from Cameron.
Gates (bare, from the worktree, never piped; AGENTS.md "Required completion gates"):
1. npm run typecheck  2. npm test  3. npm run smoke  4. npm run e2e
5. npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')  (baseline-attribute any errors; skip if the list is empty)
Post-merge obligations already known: none for the build. Rollout (planner + Cameron, not the builder): re-count (unknown, active) on dev and prod just before deploy (profile housingchoice); any found move only on Cameron's go. No Terraform, no deploy, no data writes.
