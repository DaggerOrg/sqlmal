import { ChangeDetectionStrategy, Component, computed, inject, resource, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { NgIcon } from '@ng-icons/core';
import {
  phosphorArrowsLeftRightFill,
  phosphorClockFill,
  phosphorDatabaseFill,
  phosphorGitDiffFill,
  phosphorHouseFill,
  phosphorListChecksFill,
  phosphorTableFill,
} from '@ng-icons/phosphor-icons/fill';
import {
  phosphorArrowsLeftRight,
  phosphorClock,
  phosphorGitDiff,
  phosphorHouse,
  phosphorListChecks,
  phosphorMoon,
  phosphorSun,
  phosphorTable,
} from '@ng-icons/phosphor-icons/regular';
import { filter, map } from 'rxjs';
import { formatServerVersion } from './core/format';
import { SqlmalApiService } from './core/sqlmal-api.service';
import { SqlmalApiError } from './core/sqlmal-api.error';
import { ThemeService } from './core/theme.service';
import { ChipComponent } from './shared/chip/chip.component';
import { ErrorBoxComponent } from './shared/error-box/error-box.component';
import { LoadingSkeletonComponent } from './shared/loading-skeleton/loading-skeleton.component';
import { TokenPromptComponent } from './token-prompt/token-prompt.component';

interface NavigationItem {
  /** The first URL segment, empty for the overview. */
  section: string;
  label: string;
  iconSvg: string;
  activeIconSvg: string;
}

const NAVIGATION_ITEMS: readonly NavigationItem[] = [
  { section: '', label: 'Overview', iconSvg: phosphorHouse, activeIconSvg: phosphorHouseFill },
  { section: 'migrations', label: 'Migrations', iconSvg: phosphorListChecks, activeIconSvg: phosphorListChecksFill },
  { section: 'schema', label: 'Schema', iconSvg: phosphorTable, activeIconSvg: phosphorTableFill },
  { section: 'timeline', label: 'Timeline', iconSvg: phosphorClock, activeIconSvg: phosphorClockFill },
  { section: 'drift', label: 'Drift', iconSvg: phosphorGitDiff, activeIconSvg: phosphorGitDiffFill },
  {
    section: 'history',
    label: 'History',
    iconSvg: phosphorArrowsLeftRight,
    activeIconSvg: phosphorArrowsLeftRightFill,
  },
];

/** The shell: navigation rail, top bar, and the routed page once the data source is connected. */
@Component({
  selector: 'app-root',
  imports: [
    RouterOutlet,
    RouterLink,
    NgIcon,
    ChipComponent,
    ErrorBoxComponent,
    LoadingSkeletonComponent,
    TokenPromptComponent,
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent {
  private readonly api = inject(SqlmalApiService);
  private readonly router = inject(Router);
  private readonly themeService = inject(ThemeService);

  protected readonly navigationItems = NAVIGATION_ITEMS;
  protected readonly icons = { phosphorDatabaseFill, phosphorMoon, phosphorSun };

  private readonly connectionAttempt = signal(0);
  protected readonly connection = resource({
    params: () => ({ attempt: this.connectionAttempt() }),
    loader: () => this.api.connect(),
  });

  protected readonly needsAccessToken = computed(() => {
    const connectionError = this.connection.error();
    return connectionError instanceof SqlmalApiError && connectionError.code === 'unauthorized';
  });
  protected readonly serverInfo = this.api.serverInfo;
  protected readonly databaseName = this.api.databaseName;
  protected readonly serverVersionLabel = computed(() => {
    const serverInfo = this.serverInfo();
    return serverInfo ? formatServerVersion(serverInfo.version) : '';
  });

  protected readonly activeSection = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map((event) => this.findSection(event.urlAfterRedirects)),
    ),
    { initialValue: this.findSection(this.router.url) },
  );

  protected readonly isDarkTheme = computed(() => this.themeService.theme() === 'dark');

  protected toggleTheme(): void {
    this.themeService.toggleTheme();
  }

  protected retryConnection(): void {
    this.connectionAttempt.update((attempt) => attempt + 1);
  }

  /** The skip link moves focus itself: following `#main` would change the hash route. */
  protected skipToContent(event: Event, mainElement: HTMLElement): void {
    event.preventDefault();
    mainElement.focus();
  }

  private findSection(url: string): string {
    return this.router.parseUrl(url).root.children['primary']?.segments[0]?.path ?? '';
  }
}
