/**
 * A versioned migration loaded from `VERSION_name.up.sql` and `VERSION_name.down.sql`.
 * VERSION is a number (0001, or a timestamp like 20261010120000); migrations run in
 * ascending version order.
 */
export interface Migration {
  version: number;
  name: string;
  upSql: string;
  downSql: string;
  upPath: string;
  downPath?: string;
  /**
   * SHA-256 of the normalised up file. Editing an applied migration changes it, which the
   * runner reports as drift.
   */
  checksum: string;
  /** The up file asks, with `-- migrate:no-transaction`, to run outside a transaction. */
  isNonTransactional: boolean;
  isDownNonTransactional: boolean;
  hasDown: boolean;
  /**
   * The down file says, with `-- migrate:irreversible`, that this change cannot or should not
   * be undone. Lint and verify treat it as a decision, not a mistake.
   */
  isIrreversible: boolean;
}
