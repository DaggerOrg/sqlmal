import { Pipe, type PipeTransform } from '@angular/core';
import { formatTimestamp } from '../../core/format';

@Pipe({ name: 'timestamp' })
export class TimestampPipe implements PipeTransform {
  transform(isoTimestamp?: string): string {
    return formatTimestamp(isoTimestamp);
  }
}
