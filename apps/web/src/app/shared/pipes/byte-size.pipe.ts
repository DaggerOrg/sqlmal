import { Pipe, type PipeTransform } from '@angular/core';
import { formatByteSize } from '../../core/format';

@Pipe({ name: 'byteSize' })
export class ByteSizePipe implements PipeTransform {
  transform(sizeBytes: number): string {
    return formatByteSize(sizeBytes);
  }
}
