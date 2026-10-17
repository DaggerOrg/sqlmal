import { Catch, HttpException, NotFoundException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { ApiErrorBody, ApiErrorCode } from '@sqlmal/contracts';
import type { Response } from 'express';

import { MigrationNameError } from '../migration-files/migration-files.error';
import {
  DriftedHistoryError,
  MigrationLockedError,
  MissingDownMigrationError,
  NothingToDoError,
  OutOfOrderMigrationError,
} from '../migration-runner/migration-runner.error';
import { describeError } from '../shared/error-message';
import { UnknownDatabaseError } from '../workspace/workspace.error';
import { ApiRequestError } from './api-request.error';
import { scrubSecrets } from './secret-scrubber';

interface ErrorResponse {
  statusCode: number;
  code: ApiErrorCode;
  message: string;
}

function translateError(error: unknown): ErrorResponse {
  if (error instanceof ApiRequestError) {
    return { statusCode: error.statusCode, code: error.code, message: error.message };
  }
  if (error instanceof UnknownDatabaseError) {
    return { statusCode: 404, code: 'unknown_database', message: error.message };
  }
  if (error instanceof MigrationLockedError) {
    return { statusCode: 409, code: 'locked', message: error.message };
  }
  if (
    error instanceof DriftedHistoryError ||
    error instanceof OutOfOrderMigrationError ||
    error instanceof MissingDownMigrationError ||
    error instanceof NothingToDoError
  ) {
    return { statusCode: 409, code: 'not_allowed', message: error.message };
  }
  if (error instanceof MigrationNameError) {
    return { statusCode: 400, code: 'bad_request', message: error.message };
  }
  if (error instanceof NotFoundException) {
    return { statusCode: 404, code: 'not_found', message: 'No such endpoint.' };
  }
  if (error instanceof HttpException && error.getStatus() === 400) {
    return { statusCode: 400, code: 'bad_request', message: `The request body is not valid: ${error.message}` };
  }
  return { statusCode: 502, code: 'failed', message: describeError(error) };
}

/** Every error becomes an `ApiErrorBody`, with secrets scrubbed. */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { statusCode, code, message } = translateError(error);
    const body: ApiErrorBody = { error: { code, message: scrubSecrets(message) } };
    response.status(statusCode).json(body);
  }
}
