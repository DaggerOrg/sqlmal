import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** A centred message for when there is nothing to show. */
@Component({
  selector: 'app-empty-state',
  template: `
    <div class="empty-state">
      <b>{{ heading() }}</b>
      @if (hint()) {
        <p>{{ hint() }}</p>
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EmptyStateComponent {
  readonly heading = input.required<string>();
  readonly hint = input<string>();
}
