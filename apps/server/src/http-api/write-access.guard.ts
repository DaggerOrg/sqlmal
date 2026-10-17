import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import { ApiRequestError } from './api-request.error';
import { HTTP_SERVER_OPTIONS, type HttpServerOptions } from './http-server-options';
import { findBodyError } from './request-body-parser';

function isSameOrigin(origin: string, hostHeader: string): boolean {
  try {
    return new URL(origin).host.toLowerCase() === hostHeader.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Requests that change things also need --allow-write, a same-origin request, and the custom
 * header a forged form cannot send. Runs after the token check.
 */
@Injectable()
export class WriteAccessGuard implements CanActivate {
  constructor(@Inject(HTTP_SERVER_OPTIONS) private readonly options: HttpServerOptions) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (!this.options.allowWrite) {
      throw new ApiRequestError(
        403,
        'read_only',
        'This server is read-only. Start it with --allow-write to run migrations from the UI.',
      );
    }
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== '' && !isSameOrigin(origin, request.headers.host ?? '')) {
      throw new ApiRequestError(403, 'bad_origin', 'Cross-site requests are not allowed.');
    }
    if (request.headers['x-sqlmal'] !== '1') {
      throw new ApiRequestError(403, 'missing_header', 'Missing X-SQLMal header.');
    }
    const bodyError = findBodyError(request);
    if (bodyError !== undefined) {
      throw bodyError;
    }
    return true;
  }
}
