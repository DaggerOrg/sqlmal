import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { splitTokensIntoLines, tokenizeSql } from './sql-tokenizer';

/** Highlighted SQL with line numbers. Lines listed in `highlightedLineNumbers` get a marker. */
@Component({
  selector: 'app-sql-code-view',
  templateUrl: './sql-code-view.component.html',
  styleUrl: './sql-code-view.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SqlCodeViewComponent {
  readonly sql = input.required<string>();
  /** 1-based line numbers to mark, for example where lint findings are. */
  readonly highlightedLineNumbers = input<readonly number[]>([]);
  readonly label = input.required<string>();

  protected readonly lines = computed(() => {
    const highlighted = new Set(this.highlightedLineNumbers());
    return splitTokensIntoLines(tokenizeSql(this.sql().replace(/\n$/, ''))).map((tokens, lineIndex) => ({
      lineNumber: lineIndex + 1,
      isHighlighted: highlighted.has(lineIndex + 1),
      tokens,
    }));
  });
}
