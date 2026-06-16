// ESLint flat config (root). Shared by app/ and dashboard/ workspaces.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      'dashboard-legacy/dist',
      'coverage',
      'infra/**/.terraform',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [tseslint.configs.recommended],
  },
  // Binding engineering guideline #1 (Phase 0): all file movement must use
  // stream.pipeline — no whole-file buffers on media paths. fs.readFileSync is
  // therefore banned outright in app/src, both as a member access
  // (fs.readFileSync) and as a named import ({ readFileSync }).
  {
    files: ['app/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[property.name='readFileSync']",
          message:
            'fs.readFileSync is banned in app/src (Phase 0 guideline 1): all file movement must use stream.pipeline — no whole-file buffers on media paths.',
        },
        {
          selector: "ImportSpecifier[imported.name='readFileSync']",
          message:
            'fs.readFileSync is banned in app/src (Phase 0 guideline 1): all file movement must use stream.pipeline — no whole-file buffers on media paths.',
        },
      ],
    },
  },
);
