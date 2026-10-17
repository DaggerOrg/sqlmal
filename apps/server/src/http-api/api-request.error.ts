import type { ApiErrorCode } from '@sqlmal/contracts';

/** A request the HTTP layer refuses before it reaches the domain. */
export class ApiRequestError extends Error {
  override readonly name = 'ApiRequestError';

  constructor(
    readonly statusCode: number,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
  }
}
