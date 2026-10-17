import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/** An error message with a retry button. */
@Component({
  selector: 'app-error-box',
  template: `
    <div class="error-box" role="alert">
      <p>
        <b>{{ error().message }}</b>
      </p>
      <button type="button" class="button button-small error-box-retry" (click)="retry.emit()">Try again</button>
    </div>
  `,
  styles: '.error-box-retry { margin-top: 0.6rem; }',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ErrorBoxComponent {
  readonly error = input.required<Error>();
  readonly retry = output();
}
