import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { catchError, throwError, timeout, TimeoutError, type Observable } from 'rxjs';

import { ApiRequestError } from './api-request.error';

export const REQUEST_TIMEOUT_MS = 2 * 60 * 1000;

/** Gives up on a request after two minutes. */
@Injectable()
export class RequestTimeoutInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      timeout(REQUEST_TIMEOUT_MS),
      catchError((error: unknown) =>
        throwError(() =>
          error instanceof TimeoutError ? new ApiRequestError(504, 'timeout', 'That took too long.') : error,
        ),
      ),
    );
  }
}
