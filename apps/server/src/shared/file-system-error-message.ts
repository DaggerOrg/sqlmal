const MESSAGES_BY_CODE: Record<string, string> = {
  ENOENT: 'no such file or directory',
  EACCES: 'permission denied',
  ENOTDIR: 'not a directory',
  EISDIR: 'is a directory',
  EEXIST: 'file exists',
};

/** Words a Node file-system error the way the Go version did: `open <path>: no such file or directory`. */
export function describeFileSystemError(error: unknown, operation: string, path: string): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason = code === undefined ? undefined : MESSAGES_BY_CODE[code];
    if (reason !== undefined) {
      return `${operation} ${path}: ${reason}`;
    }
    return error.message;
  }
  return String(error);
}
