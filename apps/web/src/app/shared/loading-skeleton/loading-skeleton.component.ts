import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** Grey placeholder lines while something loads. */
@Component({
  selector: 'app-loading-skeleton',
  template: `
    <div class="stack" role="status" aria-label="Loading">
      @for (widthPercent of lineWidthsPercent(); track $index) {
        <div class="skeleton" [style.width.%]="widthPercent"></div>
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoadingSkeletonComponent {
  readonly lineCount = input(3);
  /** Uneven widths so the placeholder looks like text. */
  protected readonly lineWidthsPercent = computed(() =>
    Array.from({ length: this.lineCount() }, (_, lineIndex) => 95 - ((lineIndex * 17) % 40)),
  );
}
