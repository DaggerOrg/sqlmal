export const HTTP_SERVER_OPTIONS = Symbol('HTTP_SERVER_OPTIONS');

export interface HttpServerOptions {
  /** The listen address, `host:port`. It decides which Host headers are accepted. */
  listenAddress: string;
  /** Lets the API run migrations and write files. */
  allowWrite: boolean;
  /** When not empty, every API call must send it as a Bearer token. */
  token: string;
  version: string;
  /** Where the built web UI lives. */
  uiDirectory: string;
}
