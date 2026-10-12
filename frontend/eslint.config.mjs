import js from '@eslint/js';
import a11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      'eslint.config.mjs',
      // Generated from the backend's OpenAPI document; not hand-edited, not linted.
      'src/lib/api/generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  a11y.flatConfigs.recommended,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],

      /**
       * Enforces decision D-001.
       *
       * The plan requires the control panel and external integrators to invoke the same
       * application services, and forbids a second matching engine in the browser. Across two
       * repositories that is no longer enforced by a shared build, so it is enforced here.
       *
       * Banding, identity resolution, stage logic and clustering live in the backend's
       * packages/domain and reach the panel only as API responses.
       */
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@adverse-search/domain',
                '@adverse-search/domain/*',
                '@adverse-search/evaluation',
                '@adverse-search/evaluation/*',
              ],
              message:
                'The control panel must not import the domain packages (decision D-001). Banding, identity resolution and stage logic reach the panel only as API responses. There is no second matching engine in the browser.',
            },
            {
              group: ['**/domain/**', '**/evaluation/**'],
              message:
                'Do not reach into backend domain code. Use the generated API client in src/lib/api (decision D-001).',
            },
          ],
        },
      ],

      // Evidence text is untrusted publisher content (SEC-04). It is never rendered as HTML.
      'react/no-danger': 'off',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'JSXAttribute[name.name="dangerouslySetInnerHTML"]',
          message:
            'Never render fetched evidence as HTML. Publisher content and model output are untrusted (SEC-04); render them as text.',
        },
        {
          selector:
            "CallExpression[callee.object.name='localStorage'], CallExpression[callee.object.name='sessionStorage']",
          message:
            'No sensitive browser storage (FR-14). Session state lives in the backend-for-frontend session cookie, not in the browser.',
        },
      ],
      'no-eval': 'error',
      'no-new-func': 'error',
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'src/test-setup.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      parserOptions: { projectService: false, project: false },
      globals: { console: 'readonly', process: 'readonly' },
    },
  },
  prettier,
);
