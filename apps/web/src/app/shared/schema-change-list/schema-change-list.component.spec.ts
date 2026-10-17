import { TestBed } from '@angular/core/testing';
import type { SchemaChange } from '@sqlmal/contracts';
import { describe, expect, it } from 'vitest';
import { SchemaChangeListComponent } from './schema-change-list.component';

function renderChangeList(changes: SchemaChange[], emptyMessage?: string): HTMLElement {
  const fixture = TestBed.createComponent(SchemaChangeListComponent);
  fixture.componentRef.setInput('changes', changes);
  if (emptyMessage !== undefined) fixture.componentRef.setInput('emptyMessage', emptyMessage);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('SchemaChangeListComponent', () => {
  it('marks each change as added, removed or changed and names what it touches', () => {
    const element = renderChangeList([
      { kind: 'table_added', tableName: 'orders', isDestructive: false },
      { kind: 'column_removed', tableName: 'users', objectName: 'name', isDestructive: true },
      { kind: 'column_changed', tableName: 'users', objectName: 'email', detail: 'text to varchar', isDestructive: false },
    ]);
    const items = [...element.querySelectorAll('li')];
    expect(items.map((item) => item.querySelector('.change-mark')?.className)).toEqual([
      'change-mark added',
      'change-mark removed',
      'change-mark changed',
    ]);
    expect(items[0]?.textContent).toContain('Table added: orders');
    expect(items[1]?.textContent).toContain('Column removed: users.name');
    expect(items[1]?.querySelector('.destroys-data')?.textContent).toBe('destroys data');
    expect(items[2]?.querySelector('.change-detail')?.textContent).toBe('text to varchar');
  });

  it('shows the empty message when there are no changes', () => {
    expect(renderChangeList([]).textContent.trim()).toBe('No schema changes.');
    expect(renderChangeList([], 'Nothing left behind.').textContent.trim()).toBe('Nothing left behind.');
  });
});
