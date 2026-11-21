module.exports = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/ocl/ocl-test-setup.js'],
  setupFilesAfterEnv: [
    '<rootDir>/tests/setup.js',
    '<rootDir>/tests/ocl/ocl-test-teardown.js'
  ],
  testMatch: [
    '<rootDir>/tests/**/*.test.js',
    '<rootDir>/tests/**/*.spec.js'
  ],
  collectCoverageFrom: [
    '*.js',
    '**/*.js',
    '!node_modules/**',
    '!tests/**',
    '!coverage/**'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  testTimeout: 600000,
  maxWorkers: 1,
  // Transform fast-xml-parser for Jest compatibility if needed
  transform: {
    "node_modules/fast-xml-parser/.*\\.js$": "babel-jest"
  },
  // Make sure Jest can resolve the fast-xml-parser module
  moduleNameMapper: {
    "^fast-xml-parser$": "<rootDir>/node_modules/fast-xml-parser"
  }
};
