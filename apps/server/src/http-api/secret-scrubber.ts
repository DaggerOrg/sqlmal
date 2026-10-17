const SECRET_PATTERN = /(password|passwd|pwd)=\S+|:\/\/[^:@/\s]+:[^@/\s]+@/gi;

/** Removes passwords and credentials in URLs from a message. */
export function scrubSecrets(message: string): string {
  return message.replace(SECRET_PATTERN, '://***@');
}
