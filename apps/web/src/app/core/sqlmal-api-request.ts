import { HttpErrorResponse, HttpHeaders, type HttpClient } from '@angular/common/http';
import type { ApiErrorBody } from '@sqlmal/contracts';
import { firstValueFrom } from 'rxjs';
import { readAccessToken } from './access-token-storage';
import { SqlmalApiError, type SqlmalApiErrorCode } from './sqlmal-api.error';

/** Status of a migration run that started and failed: the body still describes what happened. */
const UNPROCESSABLE_CONTENT_STATUS = 422;

export interface SqlmalApiRequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
}

/**
 * Calls the SQLMal API and returns the parsed JSON body. Writes carry `X-SQLMal: 1`, which a cross-site
 * form cannot set. A 422 from a migration run is not an error: its body reports the failure.
 */
export async function requestSqlmalApi<TResponse>(
  httpClient: HttpClient,
  path: string,
  options: SqlmalApiRequestOptions = {},
): Promise<TResponse> {
  const method = options.method ?? 'GET';
  let headers = new HttpHeaders().set('Accept', 'application/json');
  const accessToken = readAccessToken();
  if (accessToken) headers = headers.set('Authorization', `Bearer ${accessToken}`);
  if (method === 'POST') headers = headers.set('Content-Type', 'application/json').set('X-SQLMal', '1');

  let status: number;
  let responseText: string;
  try {
    const response = await firstValueFrom(
      httpClient.request(method, path, {
        headers,
        body: method === 'POST' ? JSON.stringify(options.body ?? {}) : null,
        observe: 'response',
        responseType: 'text',
      }),
    );
    status = response.status;
    responseText = response.body ?? '';
  } catch (caught: unknown) {
    if (!(caught instanceof HttpErrorResponse) || caught.status === 0) {
      throw new SqlmalApiError(0, 'network_unreachable', 'Cannot reach the server.');
    }
    status = caught.status;
    responseText = typeof caught.error === 'string' ? caught.error : '';
  }

  const responseBody = parseJsonOrNull(responseText);
  if (status >= 400 && status !== UNPROCESSABLE_CONTENT_STATUS) {
    const errorDetails = isApiErrorBody(responseBody) ? responseBody.error : undefined;
    throw new SqlmalApiError(
      status,
      errorDetails?.code ?? ('unexpected_response' satisfies SqlmalApiErrorCode),
      errorDetails?.message ?? `Request failed (${status}).`,
    );
  }
  return responseBody as TResponse;
}

function parseJsonOrNull(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const { error } = value;
  return typeof error === 'object' && error !== null && 'code' in error && 'message' in error;
}
