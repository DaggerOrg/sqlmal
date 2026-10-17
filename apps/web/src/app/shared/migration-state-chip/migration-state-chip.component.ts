import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import { phosphorCheckCircleFill, phosphorInfoFill, phosphorXCircleFill } from '@ng-icons/phosphor-icons/fill';
import type { MigrationState } from '@sqlmal/contracts';
import { ChipComponent, type ChipTone } from '../chip/chip.component';

const STATE_LABELS: Record<MigrationState, string> = {
  applied: 'Applied',
  pending: 'Pending',
  modified: 'Edited after applying',
  missing: 'File missing',
};

/** A migration's state as a coloured chip. */
@Component({
  selector: 'app-migration-state-chip',
  imports: [ChipComponent, NgIcon],
  template: `
    <app-chip [tone]="tone()">
      <ng-icon [svg]="iconSvg()" size="14" aria-hidden="true" />
      {{ label() }}
    </app-chip>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MigrationStateChipComponent {
  readonly state = input.required<MigrationState>();

  protected readonly label = computed(() => STATE_LABELS[this.state()]);
  protected readonly tone = computed<ChipTone>(() => {
    const state = this.state();
    if (state === 'applied') return 'success';
    return state === 'pending' ? 'warning' : 'danger';
  });
  protected readonly iconSvg = computed(() => {
    const state = this.state();
    if (state === 'applied') return phosphorCheckCircleFill;
    return state === 'pending' ? phosphorInfoFill : phosphorXCircleFill;
  });
}
