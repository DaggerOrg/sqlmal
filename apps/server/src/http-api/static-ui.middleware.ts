import { statSync } from 'node:fs';
import { basename, join, normalize, sep } from 'node:path';

import type { NextFunction, Request, Response } from 'express';

const INDEX_FILE = 'index.html';
/** Angular names built files like `main-ABCD1234.js`; the hash makes them safe to cache forever. */
const CONTENT_HASHED_FILE = /[-.][A-Z0-9]{8,}\.[a-z0-9]+$/;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Serves the built web UI. Client-side routes (paths without an extension) fall back to the
 * app shell; a missing file is a 404.
 */
export class StaticUiMiddleware {
  constructor(private readonly uiDirectory: string) {}

  readonly use = (request: Request, response: Response, next: NextFunction): void => {
    if (request.path.startsWith('/api/') || (request.method !== 'GET' && request.method !== 'HEAD')) {
      next();
      return;
    }
    let name: string;
    try {
      name = decodeURIComponent(request.path).replace(/^\/+/, '');
    } catch {
      response.status(404).type('text/plain; charset=utf-8').send('404 page not found\n');
      return;
    }
    name = normalize(name === '' ? INDEX_FILE : name);
    if (name.startsWith('..') || name.split(sep).includes('..')) {
      response.status(404).type('text/plain; charset=utf-8').send('404 page not found\n');
      return;
    }
    if (!isFile(join(this.uiDirectory, name))) {
      if (basename(name).includes('.')) {
        response.status(404).type('text/plain; charset=utf-8').send('404 page not found\n');
        return;
      }
      name = INDEX_FILE;
    }
    if (name === INDEX_FILE && !isFile(join(this.uiDirectory, INDEX_FILE))) {
      response
        .status(404)
        .type('text/plain; charset=utf-8')
        .send('The web UI is not built. Run `npm run build` at the repository root.\n');
      return;
    }
    if (name === INDEX_FILE) {
      response.setHeader('Cache-Control', 'no-cache');
    } else if (name.startsWith(`assets${sep}`) || CONTENT_HASHED_FILE.test(basename(name))) {
      response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
    response.sendFile(name, { root: this.uiDirectory, cacheControl: false, dotfiles: 'allow' }, (error) => {
      if (error !== undefined && !response.headersSent) {
        response.status(404).type('text/plain; charset=utf-8').send('404 page not found\n');
      }
    });
  };
}
