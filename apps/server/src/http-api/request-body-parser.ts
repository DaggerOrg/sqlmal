import express, { type RequestHandler } from 'express';

import { ApiRequestError } from './api-request.error';

const MAX_BODY_SIZE = '1mb';

/** Body problems are reported after the token and write checks, as the Go server did. */
const bodyErrorsByRequest = new WeakMap<object, ApiRequestError>();

function describeBodyError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.too.large') {
    return 'request body too large';
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Parses any request body as JSON, up to 1 MB. A body that cannot be parsed is remembered,
 * not rejected, so authorisation still decides first.
 */
export function createJsonBodyParser(): RequestHandler {
  const parseJson = express.json({ limit: MAX_BODY_SIZE, type: () => true, strict: false });
  return (request, response, next) => {
    parseJson(request, response, (error?: unknown) => {
      const body: unknown = request.body;
      if (error !== undefined && error !== null) {
        bodyErrorsByRequest.set(
          request,
          new ApiRequestError(400, 'bad_request', `The request body is not valid: ${describeBodyError(error)}`),
        );
        request.body = undefined;
      } else if (body !== undefined && (typeof body !== 'object' || body === null || Array.isArray(body))) {
        bodyErrorsByRequest.set(
          request,
          new ApiRequestError(400, 'bad_request', 'The request body is not valid: expected a JSON object'),
        );
        request.body = undefined;
      }
      next();
    });
  };
}

export function findBodyError(request: object): ApiRequestError | undefined {
  return bodyErrorsByRequest.get(request);
}
