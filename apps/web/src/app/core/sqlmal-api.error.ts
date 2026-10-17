import type { ApiErrorCode } from '@sqlmal/contracts';

/** Codes the UI adds to the server's own, for failures that never reached the server. */
export type ClientErrorCode = 'network_unreachable' | 'no_backend' | 'unexpected_response';

export type SqlmalApiErrorCode = ApiErrorCode | ClientErrorCode;

/** A failed API call. `status` is the HTTP status, or 0 when there was no response. */
export class SqlmalApiError extends Error {
  override readonly name = 'SqlmalApiError';

  constructor(
    readonly status: number,
    readonly code: SqlmalApiErrorCode,
    message: string,
  ) {
    super(message);
  }
}
