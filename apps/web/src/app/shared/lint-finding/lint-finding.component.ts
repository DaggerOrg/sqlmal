import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import { phosphorInfoFill, phosphorWarningFill, phosphorWarningOctagonFill } from '@ng-icons/phosphor-icons/fill';
import type { LintFinding } from '@sqlmal/contracts';

/**
 * One lint finding. Put it inside an `<li class="lint-finding">`: the host uses `display: contents`,
 * so its parts become the list item's grid cells.
 */
@Component({
  selector: 'app-lint-finding',
  imports: [NgIcon],
  template: `
    <ng-icon
      [svg]="severityIcon().svg"
      size="20"
      [color]="severityIcon().color"
      [attr.aria-label]="severityIcon().label"
    />
    <div>
      <p>
        <b class="mono lint-finding-rule">{{ finding().ruleId }}</b> {{ finding().message }}
        <span class="faint mono lint-finding-location"
          >{{ shouldShowFile() ? finding().file + '.sql, ' : '' }}line {{ finding().line }}</span
        >
      </p>
    </div>
    @if (finding().hint) {
      <p class="lint-finding-hint">{{ finding().hint }}</p>
    }
  `,
  styles: `
    :host {
      display: contents;
    }
    .lint-finding-rule {
      font-size: 13px;
    }
    .lint-finding-location {
      font-size: 12px;
    }
    .lint-finding-hint {
      grid-column: 2;
      color: var(--ink-soft);
      font-size: 14px;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LintFindingComponent {
  readonly finding = input.required<LintFinding>();
  readonly shouldShowFile = input(false);

  protected readonly severityIcon = computed(() => {
    switch (this.finding().severity) {
      case 'error':
        return { svg: phosphorWarningOctagonFill, color: 'var(--destructive)', label: 'error' };
      case 'warning':
        return { svg: phosphorWarningFill, color: 'var(--warning)', label: 'warning' };
      default:
        return { svg: phosphorInfoFill, color: 'var(--accent)', label: 'note' };
    }
  });
}
