import { createHash, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request, Response } from 'express';

import { ApiRequestError } from './api-request.error';
import { HTTP_SERVER_OPTIONS, type HttpServerOptions } from './http-server-options';

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** When the server has a token, every API call must send it as `Authorization: Bearer …`. */
@Injectable()
export class BearerTokenGuard implements CanActivate {
  constructor(@Inject(HTTP_SERVER_OPTIONS) private readonly options: HttpServerOptions) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.options.token === '') {
      return true;
    }
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization ?? '';
    // Both sides are hashed to the same length first, so the comparison time says nothing.
    const hasToken =
      header.startsWith('Bearer ') &&
      timingSafeEqual(hashToken(header.slice('Bearer '.length)), hashToken(this.options.token));
    if (!hasToken) {
      context.switchToHttp().getResponse<Response>().setHeader('WWW-Authenticate', 'Bearer');
      throw new ApiRequestError(401, 'unauthorized', 'A token is required.');
    }
    return true;
  }
}
