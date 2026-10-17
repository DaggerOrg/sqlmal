/** One database entry in sqlmal.json. */
export interface DatabaseConfig {
  name: string;
  /** Names the environment variable holding the connection URL. */
  dsnEnvironmentVariable?: string;
  /** A literal URL. Fine for a local demo; avoid it for real passwords. */
  dsn?: string;
  /** The migrations directory, absolute or relative to the working directory. */
  migrationsDirectory: string;
}

export interface ProjectConfig {
  databases: DatabaseConfig[];
  /**
   * Optionally names a variable with the URL of a server where scratch databases may be
   * created. Defaults to the target's server.
   */
  shadowAdminDsnEnvironmentVariable?: string;
}
