import { Pipe, type PipeTransform } from '@angular/core';
import { humanizeMigrationName } from '../../core/format';

@Pipe({ name: 'migrationName' })
export class MigrationNamePipe implements PipeTransform {
  transform(migrationName: string): string {
    return humanizeMigrationName(migrationName);
  }
}
