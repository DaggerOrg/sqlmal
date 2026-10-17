// One ESLint config for the whole repository. The naming rules here are the
// enforced part of docs/CONVENTIONS.md.
import eslint from '@eslint/js';
import angular from 'angular-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const BOOLEAN_PREFIXES = ['is', 'has', 'should', 'can', 'was', 'did', 'allow', 'include', 'needs'];

const namingConvention = [
  'error',
  { selector: 'default', format: ['camelCase'], leadingUnderscore: 'forbid', trailingUnderscore: 'forbid' },
  { selector: 'import', format: ['camelCase', 'PascalCase'] },
  { selector: 'typeLike', format: ['PascalCase'] },
  { selector: 'interface', format: ['PascalCase'], custom: { regex: '^I[A-Z]', match: false } },
  { selector: 'class', format: ['PascalCase'], custom: { regex: 'Impl$', match: false } },
  { selector: 'enumMember', format: ['PascalCase'] },
  {
    selector: 'typeParameter',
    format: ['PascalCase'],
    custom: { regex: '^(T|T[A-Z][A-Za-z]+)$', match: true },
  },
  { selector: 'variable', modifiers: ['const', 'global'], format: ['camelCase', 'UPPER_CASE', 'PascalCase'] },
  { selector: 'variable', types: ['boolean'], format: ['PascalCase'], prefix: BOOLEAN_PREFIXES },
  { selector: 'parameter', types: ['boolean'], format: ['PascalCase'], prefix: BOOLEAN_PREFIXES },
  {
    selector: ['classProperty', 'typeProperty'],
    types: ['boolean'],
    format: ['PascalCase'],
    prefix: BOOLEAN_PREFIXES,
  },
  { selector: 'classProperty', modifiers: ['static', 'readonly'], format: ['camelCase', 'UPPER_CASE'] },
  { selector: 'parameter', modifiers: ['unused'], format: ['camelCase'], leadingUnderscore: 'allow' },
  // Keys that mirror something outside our control: HTTP headers, SQL, environment variables, JSON test fixtures.
  { selector: ['objectLiteralProperty', 'typeProperty'], modifiers: ['requiresQuotes'], format: null },
  { selector: 'objectLiteralProperty', format: null, filter: { regex: '^[A-Z0-9_]+$', match: true } },
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/.angular/**',
      '**/node_modules/**',
      'apps/server/ui/**',
      'apps/web/public/**',
      '**/*.mjs',
      '**/*.cjs',
      '**/jest.config.ts',
    ],
  },

  // Every TypeScript file.
  {
    files: ['**/*.ts'],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/naming-convention': namingConvention,
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/explicit-member-accessibility': ['error', { accessibility: 'no-public' }],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
      'no-restricted-syntax': [
        'error',
        { selector: 'ExportDefaultDeclaration', message: 'Use named exports.' },
        { selector: 'TSEnumDeclaration', message: 'Use a string literal union instead of an enum.' },
      ],
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
    },
  },

  // Server: Node globals; the CLI and its output writer may print.
  {
    files: ['apps/server/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['apps/server/src/cli/**/*.ts', 'apps/server/src/main.ts'],
    rules: { 'no-console': 'off' },
  },

  // Web: Angular rules.
  {
    files: ['apps/web/**/*.ts'],
    extends: [...angular.configs.tsRecommended],
    processor: angular.processInlineTemplates,
    languageOptions: { globals: globals.browser },
    rules: {
      '@angular-eslint/component-selector': [
        'error',
        { type: 'element', prefix: 'app', style: 'kebab-case' },
      ],
      '@angular-eslint/directive-selector': [
        'error',
        { type: 'attribute', prefix: 'app', style: 'camelCase' },
      ],
      '@angular-eslint/prefer-on-push-component-change-detection': 'error',
      '@angular-eslint/prefer-signals': 'error',
      '@angular-eslint/prefer-standalone': 'error',
      '@angular-eslint/no-output-native': 'error',
    },
  },
  {
    files: ['apps/web/**/*.html'],
    extends: [...angular.configs.templateRecommended, ...angular.configs.templateAccessibility],
    rules: {
      '@angular-eslint/template/prefer-control-flow': 'error',
      '@angular-eslint/template/prefer-self-closing-tags': 'error',
    },
  },

  // Tests may use non-null assertions on fixtures they just built.
  {
    files: ['**/*.spec.ts', '**/*.e2e-spec.ts', '**/testing/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },

  prettier,
);
