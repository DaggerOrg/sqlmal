import { DOCUMENT, Injectable, inject, signal } from '@angular/core';

export type ColorTheme = 'dark' | 'light';

/** Read by `public/theme-init.js` before the app starts. */
const THEME_STORAGE_KEY = 'ms-theme';

/** The colour theme lives in `data-theme` on `<html>`, so CSS and the start-up script agree. */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly documentElement = inject(DOCUMENT).documentElement;
  readonly theme = signal<ColorTheme>(this.documentElement.dataset['theme'] === 'light' ? 'light' : 'dark');

  toggleTheme(): void {
    const nextTheme: ColorTheme = this.theme() === 'dark' ? 'light' : 'dark';
    this.documentElement.dataset['theme'] = nextTheme;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    } catch {
      /* remembering the theme is optional */
    }
    this.theme.set(nextTheme);
  }
}
