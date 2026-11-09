module.exports = {
  root: true,
  env: {
    browser: true,
    commonjs: true,
    es6: true,
    es2022: true,
    node: true,
    jest: true
  },
  extends: [
    'eslint:recommended'
  ],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module'
  },
  globals: {
    BigInt: 'readonly'
  },
  rules: {
    'no-loss-of-precision': 'warn'
  },
  ignorePatterns: [
    'static/assets/js/**/*.js',
    'node_modules/',
    'dist/',
    'build/',
    'coverage/',
    '*.min.js',
    // vendored libraries
    'static/js/jquery*.js',
    // the ESLint configs themselves (outside the TypeScript project the type-aware rules use)
    '.eslintrc*.js'
  ],
  // Type-aware rules to catch a forgotten `await`. They need TypeScript type info, so
  // they run via @typescript-eslint with parserOptions.project, scoped to the source
  // files in tsconfig.eslint.json. Test files and other excluded paths keep the plain
  // parser so linting never errors on a file outside the TS program.
  overrides: [
    {
      // Tests don't print: a test that needs to say something says it with an assertion. The few
      // that print on purpose (why a suite is skipped, output another test reads) are marked
      // with an eslint-disable comment giving the reason
      files: ['tests/**/*.js'],
      rules: {
        'no-console': ['error', { allow: ['warn', 'error'] }]
      }
    },
    {
      files: ['**/*.js'],
      excludedFiles: ['**/*.test.js', 'tests/**', 'static/**', 'coverage/**'],
      parser: '@typescript-eslint/parser',
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        project: './tsconfig.eslint.json'
      },
      plugins: ['@typescript-eslint'],
      rules: {
        // A promise-returning call left unhandled is almost always a forgotten await.
        '@typescript-eslint/no-floating-promises': 'error',
        // A promise used where a sync value is expected (e.g. `if (asyncThing())`).
        // Warn, not error: there are intentional fire-and-forget callbacks.
        '@typescript-eslint/no-misused-promises': 'warn'
      }
    }
  ]
};
