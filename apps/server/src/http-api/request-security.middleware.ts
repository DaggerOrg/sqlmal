import type { NextFunction, Request, Response } from 'express';

import { isAllowedHostHeader } from './network-address';

const CONTENT_SECURITY_POLICY =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";

/**
 * Runs before everything, static files included: security headers, the Host allowlist that
 * stops DNS rebinding, and `no-store` on the API.
 */
export class RequestSecurityMiddleware {
  constructor(private readonly listenAddress: string) {}

  readonly use = (request: Request, response: Response, next: NextFunction): void => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    if (!isAllowedHostHeader(request.headers.host ?? '', this.listenAddress)) {
      response.status(403).type('text/plain; charset=utf-8').send('unexpected Host header\n');
      return;
    }
    if (request.path.startsWith('/api/')) {
      response.setHeader('Cache-Control', 'no-store');
    }
    next();
  };
}
