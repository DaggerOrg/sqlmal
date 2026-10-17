import { provideHttpClient } from '@angular/common/http';
import { type ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { TitleStrategy, provideRouter, withComponentInputBinding, withHashLocation } from '@angular/router';
import { APP_ROUTES } from './app.routes';
import { PageTitleStrategy } from './core/page-title.strategy';

export const APP_CONFIG: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(),
    // Hash routing, so the same build works from the SQLMal server and from GitHub Pages.
    provideRouter(APP_ROUTES, withHashLocation(), withComponentInputBinding()),
    { provide: TitleStrategy, useClass: PageTitleStrategy },
  ],
};
