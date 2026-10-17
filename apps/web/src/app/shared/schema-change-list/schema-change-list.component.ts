import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { SchemaChange } from '@sqlmal/contracts';
import { CHANGE_EFFECT_SIGNS, describeSchemaChange, findChangeEffect } from './schema-change-description';

/** A list of schema differences, each marked as added, removed or changed. */
@Component({
  selector: 'app-schema-change-list',
  template: `
    @if (describedChanges().length === 0) {
      <p class="muted">{{ emptyMessage() }}</p>
    } @else {
      <ul class="schema-change-list">
        @for (describedChange of describedChanges(); track $index) {
          <li class="schema-change">
            <span class="change-mark" [class]="describedChange.effect" aria-hidden="true">{{
              describedChange.sign
            }}</span>
            <span>
              {{ describedChange.description }}
              @if (describedChange.change.isDestructive) {
                <b class="destroys-data">destroys data</b>
              }
              @if (describedChange.change.detail) {
                <span class="faint mono change-detail">{{ describedChange.change.detail }}</span>
              }
            </span>
          </li>
        }
      </ul>
    }
  `,
  styleUrl: './schema-change-list.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SchemaChangeListComponent {
  readonly changes = input.required<readonly SchemaChange[]>();
  readonly emptyMessage = input('No schema changes.');

  protected readonly describedChanges = computed(() =>
    this.changes().map((change) => {
      const effect = findChangeEffect(change);
      return { change, effect, sign: CHANGE_EFFECT_SIGNS[effect], description: describeSchemaChange(change) };
    }),
  );
}
