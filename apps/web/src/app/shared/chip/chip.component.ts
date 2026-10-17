import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type ChipTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'brand';

/** A small rounded label. Put an icon before the text as content if it needs one. */
@Component({
  selector: 'app-chip',
  template: '<ng-content />',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'chip', '[class]': 'tone()' },
})
export class ChipComponent {
  readonly tone = input<ChipTone>('neutral');
}
