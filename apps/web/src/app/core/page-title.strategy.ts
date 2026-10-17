import { Injectable, inject } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { TitleStrategy, type RouterStateSnapshot } from '@angular/router';

/** Sets the document title to `<Page> · SQLMal` from each route's `title`. */
@Injectable()
export class PageTitleStrategy extends TitleStrategy {
  private readonly title = inject(Title);

  override updateTitle(routerState: RouterStateSnapshot): void {
    const pageTitle = this.buildTitle(routerState) ?? 'Not found';
    this.title.setTitle(`${pageTitle} · SQLMal`);
  }
}
