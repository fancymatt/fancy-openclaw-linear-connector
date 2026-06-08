/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.test.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // Stub out the CLI package which is not installed in the test environment.
    '^fancy-openclaw-linear-skill-cli$': '<rootDir>/src/__mocks__/fancy-openclaw-linear-skill-cli.ts',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      useESM: true,
      // isolatedModules skips cross-file type checking during tests.
      // This avoids TS2307 errors from external packages (e.g. fancy-openclaw-linear-skill-cli)
      // that are unavailable in the test environment but mocked at runtime.
      // Runtime correctness is still enforced; the build (tsc) provides full type checking.
      isolatedModules: true,
    }],
  },
};
