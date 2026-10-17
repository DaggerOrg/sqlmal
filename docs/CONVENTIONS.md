# Engineering conventions

These rules apply to every package in this repository. Most of them are enforced by `npm run lint` (ESLint with `@typescript-eslint/naming-convention`, `angular-eslint`) and `npm run format:check` (Prettier). The rest are checked in review.

## Repository layout

```
packages/contracts   @sqlmal/contracts  JSON shapes shared by server and UI (types only)
apps/server          sqlmal             NestJS: the CLI, the HTTP API, and serving the built UI
apps/web             @sqlmal/web        Angular: the web UI
examples/shop        a 14-migration demo project
```

The server and the UI never redefine an API shape. Both import it with `import type { … } from '@sqlmal/contracts'`.

## Naming

### Files and folders

- `kebab-case` everywhere, with a suffix naming what the file holds:

  | Suffix                                        | Holds                                  | Example                            |
  | --------------------------------------------- | -------------------------------------- | ---------------------------------- |
  | `.module.ts`                                  | a NestJS module                        | `schema.module.ts`                 |
  | `.service.ts`                                 | an injectable service                  | `schema-introspector.service.ts`   |
  | `.controller.ts`                              | a NestJS controller                    | `database-api.controller.ts`       |
  | `.command.ts`                                 | a CLI command                          | `migrate-up.command.ts`            |
  | `.guard.ts` / `.filter.ts` / `.middleware.ts` | NestJS request pipeline pieces         | `bearer-token.guard.ts`            |
  | `.dto.ts`                                     | a validated request body class         | `run-migrations-request.dto.ts`    |
  | `.error.ts`                                   | error classes                          | `migration-runner.error.ts`        |
  | `.component.ts` / `.html` / `.css`            | an Angular component                   | `schema-diagram.component.ts`      |
  | `.page.ts`                                    | an Angular routed component            | `timeline.page.ts`                 |
  | `.pipe.ts`                                    | an Angular pipe                        | `version-label.pipe.ts`            |
  | `.contract.ts`                                | shared API types                       | `migration.contract.ts`            |
  | `.spec.ts`                                    | unit tests, next to the file they test | `sql-splitter.spec.ts`             |
  | `.e2e-spec.ts`                                | tests that need PostgreSQL             | `migration-runner.e2e-spec.ts`     |
  | none                                          | pure functions or constants            | `sql-splitter.ts`, `lint-rules.ts` |

- One exported class per file. The file name is the class name in kebab-case: `SchemaIntrospectorService` lives in `schema-introspector.service.ts`.

### Identifiers

| Kind                                      | Style               | Example                                      |
| ----------------------------------------- | ------------------- | -------------------------------------------- |
| Classes, interfaces, type aliases, enums  | `PascalCase`        | `MigrationRunner`, `DriftReport`             |
| Functions, methods, variables, properties | `camelCase`         | `splitSqlStatements`, `appliedAt`            |
| Module-level constants that never change  | `UPPER_SNAKE_CASE`  | `DEFAULT_LOCK_TIMEOUT_MS`, `LINT_RULES`      |
| Angular component selectors               | `app-` + kebab-case | `app-schema-diagram`                         |
| Generic type parameters                   | `T` + `PascalCase`  | `TValue`, `TResult` (bare `T` is fine alone) |

- **No `I` prefix** on interfaces and **no `Impl` suffix** on classes.
- **Booleans read as a yes/no question:** `isReadOnly`, `hasDown`, `shouldRetry`, `canWrite`, `allowOutOfOrder`, `wasSkipped`. Never `readOnly`, `down`, `flag`.
- **Functions start with a verb:** `loadMigrations`, `compareSchemas`, `quoteIdentifier`, `formatByteSize`. A function returning a boolean reads as a question: `isLoopbackHost`.
- **Units go in the name** when a number has one: `durationMs`, `lockTimeoutMs`, `totalSizeBytes`.
- **No unexplained abbreviations.** Write `migration`, `statement`, `foreignKey`, `connection`, `error`, `index`, not `m`, `st`, `fk`, `conn`, `err`, `i` (except as a loop counter). Accepted abbreviations: `sql`, `dsn`, `id`, `url`, `api`, `ui`, `json`, `html`. Prefer `databaseName` to `dbName`.
- **Collections are plural** (`migrations`, `lintFindings`); maps say what they map: `tablesByName`, `appliedByVersion`.
- **JSON on the wire is `camelCase`.** Enum-like string values stay `snake_case` (`'table_added'`, `'read_only'`), because they are stable identifiers.

## TypeScript

- `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`. No `any`; use `unknown` and narrow.
- `import type` for anything that is only a type. `@sqlmal/contracts` is always imported this way.
- Prefer `readonly` for injected dependencies and for data that should not be mutated.
- Errors are classes that extend `Error` with a `name`, never thrown strings. Domain errors carry the information the HTTP layer needs to pick a status code; the domain never knows about HTTP.
- No default exports, except where a framework requires one.

## Server (NestJS)

- Feature modules, each owning one concern: `project-config`, `migration-files`, `sql`, `lint`, `schema`, `migration-runner`, `scratch-database`, `workspace`, `http-api`, `cli`.
- Pure logic (SQL splitting, linting, schema comparison, SQL generation, layout) is written as plain functions or framework-free classes, so it is unit-tested without Nest.
- Anything that talks to PostgreSQL is behind a service that receives its connection, so tests can point it at a throwaway database.
- Request bodies are DTO classes validated by a global `ValidationPipe` with `whitelist` and `forbidNonWhitelisted`.
- Domain errors are translated to HTTP responses in one exception filter. Every error response is `ApiErrorBody`, with secrets scrubbed.
- Configuration and secrets come from environment variables or the CLI, never from source.

## Web (Angular)

- Standalone components, `ChangeDetectionStrategy.OnPush`, signals for state, the new control flow (`@if`, `@for`).
- `inject()` instead of constructor parameters.
- Routed components are pages under `src/app/pages/`; reusable pieces under `src/app/shared/`; data access under `src/app/core/`.
- Components never call `fetch` or `HttpClient` directly. They go through `SqlmalApiService`, which hides whether the data comes from a live server or a saved snapshot.

## Tests

- Server: Jest. Unit tests run without a database. Tests that need PostgreSQL are `*.e2e-spec.ts`; they create a throwaway database each, skip locally when no server is reachable, and fail in CI.
- Web: the Angular unit-test builder (Vitest).
- A test name says what behaviour it checks: `it('reports a NOT NULL column added without a default')`.

## Commits

- One logical change per commit, written in the imperative: `Add the drift page`, `Fix line numbers for errors after a dollar-quoted body`.
