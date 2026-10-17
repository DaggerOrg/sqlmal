import type { ValidationError } from 'class-validator';

import { ApiRequestError } from './api-request.error';

/**
 * Turns ValidationPipe errors into one `bad_request`. Rule messages written for this API are
 * passed as they are; anything else (an unknown or mistyped field) is prefixed the way a
 * JSON decoding error was.
 */
export function createValidationError(errors: ValidationError[]): ApiRequestError {
  const messages: string[] = [];
  let isDecodingError = false;
  for (const error of errors) {
    for (const [constraint, message] of Object.entries(error.constraints ?? {})) {
      if (constraint === 'whitelistValidation' || constraint === 'isBoolean' || constraint === 'isString' || constraint === 'maxLength') {
        isDecodingError = true;
      }
      messages.push(message);
    }
  }
  const unique = [...new Set(messages)];
  const text = unique.join('; ');
  return new ApiRequestError(400, 'bad_request', isDecodingError ? `The request body is not valid: ${text}` : text);
}
