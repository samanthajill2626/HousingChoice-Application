// ESLint flat config (root). Shared by app/ and dashboard/ workspaces.
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      'coverage',
      'infra/**/.terraform',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [tseslint.configs.recommended],
    rules: {
      // HONOUR THE `_` CONVENTION. This codebase already marks a deliberately
      // unused binding by prefixing it with an underscore - an interface method
      // that must keep its signature while ignoring an argument, a destructure
      // that skips a field, a catch that does not read its error. The rule was
      // running with its defaults, which know nothing about that convention, so
      // 70 of the 126 unused-var errors in the 2026-08-24 backlog count were
      // reporting bindings whose names already SAID "unused on purpose".
      //
      // Turning those into noise is what taught people to ignore lint output,
      // which is how the other 56 - the real ones - accumulated unnoticed. The
      // rule stays an ERROR for every name that does not opt out.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },
  // React hooks linting — dashboard only (the only React workspace). The
  // plugin's presets still ship in legacy (eslintrc) shape, so we register the
  // plugin object ourselves (flat form) and take just the rules map from
  // recommended-latest. v7's set folds the React Compiler correctness rules in
  // on top of the classic rules-of-hooks + exhaustive-deps.
  {
    files: ['dashboard/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs['recommended-latest'].rules,
  },
  // Test files: keep the classic rules (rules-of-hooks + exhaustive-deps) but
  // turn OFF the React Compiler render-purity rules. Test harnesses legitimately
  // do things those rules forbid in shipped components — e.g. a probe component
  // assigns the hook's return value to an outer `let` during render to assert on
  // it (react-hooks/globals). These files are never compiled as app components.
  {
    files: ['dashboard/**/*.test.{ts,tsx}'],
    rules: {
      'react-hooks/globals': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/set-state-in-render': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/static-components': 'off',
    },
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
