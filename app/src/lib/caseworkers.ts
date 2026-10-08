// The caseworker matching rules (spec
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
// D16, D22 "Matching"; plan 3.2). PURE - no I/O. Task 1.2 adds the helpers.

/**
 * The caseworker preset role (spec 2026-10-06 D16), byte-exact like
 * PROPERTY_MANAGER_ROLE. A caseworker is `type: 'partner'` with a role that
 * satisfies isCaseworkerRole; this exact text is the role the KindPicker
 * preset and the caseworker conversion write. DEFINED here, in a leaf
 * module, and re-exported by services/extraction/contactKinds.ts (never the
 * reverse: contactKinds.ts type-imports the AWS and Anthropic graph, and the
 * dashboard mirror test imports THIS file). The dashboard copy lives in
 * dashboard/src/routes/contact/caseworkerRole.ts (caseworkerRoleMirror.test.ts
 * pins the two together).
 */
export const CASEWORKER_ROLE = 'Caseworker';
