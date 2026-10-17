import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** The page heading, an optional line under it, and room on the right for page controls. */
@Component({
  selector: 'app-page-header',
  template: `
    <div class="page-header">
      <div>
        <h1>{{ heading() }}</h1>
        @if (description()) {
          <p>{{ description() }}</p>
        }
      </div>
      <ng-content />
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PageHeaderComponent {
  readonly heading = input.required<string>();
  readonly description = input<string>();
}
