import { Pipe, type PipeTransform } from '@angular/core';
import { formatVersion } from '../../core/format';

@Pipe({ name: 'versionLabel' })
export class VersionLabelPipe implements PipeTransform {
  transform(version: number): string {
    return formatVersion(version);
  }
}
