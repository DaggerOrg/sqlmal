import type { Config } from 'jest';

const config: Config = {
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: '.*\\.(spec|e2e-spec)\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'mjs', 'cjs', 'json'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
    // NestJS 12 and some of its dependencies are ES modules only.
    '^.+\\.m?js$': '<rootDir>/test/esm-to-commonjs.transformer.cjs',
  },
  transformIgnorePatterns: ['/node_modules/(?!(@nestjs|uid|file-type|load-esm|strtok3|token-types|@tokenizer|@borewit|uint8array-extras|peek-readable)/)'],
  testTimeout: 60_000,
};

export { config as default };
