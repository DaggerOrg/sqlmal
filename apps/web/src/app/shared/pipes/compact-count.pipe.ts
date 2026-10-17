import { Pipe, type PipeTransform } from '@angular/core';
import { formatCompactCount } from '../../core/format';

@Pipe({ name: 'compactCount' })
export class CompactCountPipe implements PipeTransform {
  transform(count: number): string {
    return formatCompactCount(count);
  }
}
