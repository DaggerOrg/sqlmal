import { Pipe, type PipeTransform } from '@angular/core';
import { pluralize } from '../../core/format';

@Pipe({ name: 'pluralize' })
export class PluralizePipe implements PipeTransform {
  transform(count: number, singular: string, plural?: string): string {
    return pluralize(count, singular, plural);
  }
}
