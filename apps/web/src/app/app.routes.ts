import type { Route, UrlMatcher, UrlSegment } from '@angular/router';

/**
 * Matches `section` and `section/:parameterName` with one route, so moving between them keeps the page
 * (and its loaded data) instead of building a new one.
 */
function matchSectionWithOptionalParameter(section: string, parameterName: string): UrlMatcher {
  return (segments: UrlSegment[]) => {
    const [sectionSegment, parameterSegment, ...extraSegments] = segments;
    if (sectionSegment?.path !== section || extraSegments.length > 0) return null;
    return {
      consumed: segments,
      posParams: parameterSegment ? { [parameterName]: parameterSegment } : {},
    };
  };
}

export const APP_ROUTES: Route[] = [
  {
    path: '',
    pathMatch: 'full',
    title: 'Overview',
    loadComponent: () => import('./pages/overview/overview.page').then((module) => module.OverviewPage),
  },
  {
    matcher: matchSectionWithOptionalParameter('migrations', 'version'),
    title: 'Migrations',
    loadComponent: () => import('./pages/migrations/migrations.page').then((module) => module.MigrationsPage),
  },
  {
    matcher: matchSectionWithOptionalParameter('schema', 'tableName'),
    title: 'Schema',
    loadComponent: () => import('./pages/schema/schema.page').then((module) => module.SchemaPage),
  },
  {
    matcher: matchSectionWithOptionalParameter('timeline', 'version'),
    title: 'Timeline',
    loadComponent: () => import('./pages/timeline/timeline.page').then((module) => module.TimelinePage),
  },
  {
    path: 'drift',
    title: 'Drift',
    loadComponent: () => import('./pages/drift/drift.page').then((module) => module.DriftPage),
  },
  {
    path: 'history',
    title: 'History',
    loadComponent: () => import('./pages/history/history.page').then((module) => module.HistoryPage),
  },
  {
    path: '**',
    title: 'Not found',
    loadComponent: () => import('./pages/not-found/not-found.page').then((module) => module.NotFoundPage),
  },
];
