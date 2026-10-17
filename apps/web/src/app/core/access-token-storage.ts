// The access token lives in sessionStorage, so it is kept for this tab only.

const ACCESS_TOKEN_STORAGE_KEY = 'ms-token';

export function readAccessToken(): string {
  try {
    return sessionStorage.getItem(ACCESS_TOKEN_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveAccessToken(accessToken: string): void {
  try {
    sessionStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, accessToken);
  } catch {
    /* private mode: the token just will not be remembered */
  }
}
